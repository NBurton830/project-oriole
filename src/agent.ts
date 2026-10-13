import {
  ClientEvent,
  createClient,
  EventType,
  MatrixEventEvent,
  RoomEvent,
  RoomMemberEvent,
  SyncState,
  type MatrixClient,
  type MatrixError,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { EventShieldColour } from 'matrix-js-sdk/lib/crypto-api/index.js';
import { logger as sdkGlobalLogger, type Logger } from 'matrix-js-sdk/lib/logger.js';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import { buildContext, effectiveTimestamp, insertChronologically, systemPrompt, type HistoryEntry } from './context.ts';
import { buildMessageContent } from './egress.ts';
import { deadlockDetected, isSilence, tier1Matches } from './gating.ts';
import { InferenceClient, InferenceUnavailable } from './inference.ts';
import { log } from './log.ts';
import { increment } from './metrics.ts';

// Parts of the SDK log through its global logger rather than the client's.
(sdkGlobalLogger as unknown as { setLevel(level: string): void }).setLevel('warn');

/** spec §3.1: minimum dedup window. */
const DEDUP_WINDOW = 2048;
/** spec §8.1: key-request backoff and give-up deadline. */
const KEY_RETRY_SCHEDULE_MS = [1, 2, 3, 4, 5].map((k) => Math.min(2 ** k * 200, 5000));
const KEY_GIVE_UP_MS = 15_000;
/** spec §6.2: deadlock heuristic window (N >= 4). */
const DEADLOCK_WINDOW = 4;
/** spec §8.2: protected recent messages (K >= 6). */
const PROTECTED_RECENT = 6;
/** Quiet period after the latest human message before running heuristics. */
const HEURISTIC_SETTLE_MS = 1_500;
const MAX_ROOM_HISTORY = 500;

interface RoomState {
  history: HistoryEntry[];
  authored: Set<string>;
  lastIntervention: number;
  heuristicTimer?: NodeJS.Timeout;
  heuristicDeferredForTyping: boolean;
  queue: Promise<void>;
}

type Trigger = { entry: HistoryEntry; mode: 'deterministic' | 'heuristic' };

class DedupWindow {
  private readonly ids = new Set<string>();
  private readonly order: string[] = [];
  /** Returns false if `id` was already seen. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    this.order.push(id);
    if (this.order.length > DEDUP_WINDOW) this.ids.delete(this.order.shift()!);
    return true;
  }
}

function sdkLogger(): Logger {
  const noop = () => {};
  const warn = (...m: unknown[]) => log.debug('[sdk] %s', m.join(' '));
  const logger: Logger = { trace: noop, debug: noop, info: noop, warn, error: warn, getChild: () => logger };
  return logger;
}

function powerLevel(room: Room, userId: string): number {
  const content = room.currentState.getStateEvents(EventType.RoomPowerLevels, '')?.getContent() ?? {};
  return Number(content.users?.[userId] ?? content.users_default ?? 0);
}

export class Agent {
  private readonly cfg: Config;
  private readonly client: MatrixClient;
  private readonly inference: InferenceClient;
  private readonly rooms = new Map<string, RoomState>();
  private readonly dedup = new DedupWindow();
  private readonly startedAt = Date.now();
  private displayName = '';

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.inference = new InferenceClient(cfg.inference);
    this.client = createClient({
      baseUrl: cfg.matrix.homeserver_url,
      userId: cfg.matrix.user_id,
      deviceId: cfg.matrix.device_id,
      accessToken: cfg.matrix.access_token,
      logger: sdkLogger(),
    });
  }

  private get botId() {
    return this.cfg.matrix.user_id;
  }

  async start() {
    // Crypto state lives in process memory only; no plaintext or session key
    // ever reaches disk (spec §3.2 / §8.5).
    await this.client.initRustCrypto({ useIndexedDB: false });

    this.client.on(RoomMemberEvent.Membership, (_ev, member) => {
      if (member.userId === this.botId && member.membership === 'invite') void this.join(member.roomId);
    });
    this.client.on(RoomEvent.Timeline, (event, _room, toStartOfTimeline, _removed, data) => {
      if (toStartOfTimeline || !data?.liveEvent) return;
      void this.onTimelineEvent(event).catch((err) => log.error('event %s: %s', event.getId(), err?.stack ?? err));
    });
    this.client.on(RoomMemberEvent.Typing, (_ev, member) => this.onTyping(member.roomId));
    this.client.on(ClientEvent.Sync, (state, _prev, data) => {
      if (state === SyncState.Error) log.warn('sync error, SDK backing off: %s', data?.error?.message);
    });

    const prepared = new Promise<void>((resolve) => {
      const onSync = (state: SyncState) => {
        if (state === SyncState.Prepared || state === SyncState.Syncing) {
          this.client.off(ClientEvent.Sync, onSync);
          resolve();
        }
      };
      this.client.on(ClientEvent.Sync, onSync);
    });
    await this.client.startClient({ initialSyncLimit: 0, threadSupport: false });
    await prepared;

    this.displayName = (await this.client.getProfileInfo(this.botId).catch(() => ({ displayname: undefined }))).displayname ?? 'Synapse';
    await this.bootstrapCrossSigning();
    for (const room of this.client.getRooms()) {
      if (room.getMyMembership() === 'invite') void this.join(room.roomId);
    }
    log.info('agent %s (%s) ready', this.botId, this.cfg.matrix.device_id);
  }

  stop() {
    this.inference.breaker.stop();
    this.client.stopClient();
  }

  // ------------------------------------------------------------------ setup

  private async bootstrapCrossSigning() {
    const crypto = this.client.getCrypto()!;
    const password = this.cfg.matrix.password;
    await crypto.bootstrapCrossSigning({
      setupNewCrossSigning: !(await crypto.isCrossSigningReady()),
      authUploadDeviceSigningKeys: async (makeRequest) => {
        try {
          await makeRequest(null);
        } catch (err) {
          const session = (err as MatrixError).data?.session as string | undefined;
          if ((err as MatrixError).httpStatus !== 401 || !password) throw err;
          await makeRequest({
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: this.botId },
            password,
            session,
          });
        }
      },
    });
    log.info('cross-signing keys published');
  }

  private async join(roomId: string) {
    try {
      await this.client.joinRoom(roomId);
      log.info('joined %s', roomId);
    } catch (err) {
      log.warn('failed to join %s: %s', roomId, (err as Error).message);
    }
  }

  private state(roomId: string): RoomState {
    let st = this.rooms.get(roomId);
    if (!st) {
      st = { history: [], authored: new Set(), lastIntervention: 0, heuristicDeferredForTyping: false, queue: Promise.resolve() };
      this.rooms.set(roomId, st);
    }
    return st;
  }

  // ------------------------------------------------------------------ ingestion

  private async onTimelineEvent(event: MatrixEvent) {
    const eventId = event.getId();
    if (!eventId || !event.getRoomId() || event.getSender() === this.botId) return;
    if (event.getTs() < this.startedAt - 60_000) return; // backlog from before we started

    if (event.isEncrypted()) await this.client.decryptEventIfNeeded(event);
    if (event.isDecryptionFailure()) return this.awaitRoomKey(event);
    await this.ingest(event);
  }

  /**
   * spec §8.1: request the missing Megolm session from the sender, retry with
   * capped exponential backoff, and drop the event after 15 seconds.
   */
  private async awaitRoomKey(event: MatrixEvent) {
    let settled = false;
    const deadline = Date.now() + KEY_GIVE_UP_MS;
    const onDecrypted = () => {
      if (settled || event.isDecryptionFailure()) return;
      settled = true;
      event.off(MatrixEventEvent.Decrypted, onDecrypted);
      void this.ingest(event).catch((err) => log.error('late event %s: %s', event.getId(), err));
    };
    event.on(MatrixEventEvent.Decrypted, onDecrypted);
    await this.sendRoomKeyRequest(event);

    for (const wait of KEY_RETRY_SCHEDULE_MS) {
      await new Promise((r) => setTimeout(r, Math.min(wait, Math.max(0, deadline - Date.now()))));
      if (settled || Date.now() >= deadline) break;
      // Retry with whatever keys have arrived; success fires MatrixEventEvent.Decrypted.
      await event.attemptDecryption(this.client.getCrypto() as never, { isRetry: true }).catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())));
    if (!settled) {
      settled = true;
      event.off(MatrixEventEvent.Decrypted, onDecrypted);
      this.dedup.add(event.getId()!); // late keys must not resurrect it
      increment('matrix_e2ee_key_timeout_count');
      log.warn('dropping %s: room key not received within %dms', event.getId(), KEY_GIVE_UP_MS);
    }
  }

  private async sendRoomKeyRequest(event: MatrixEvent) {
    const wire = event.getWireContent();
    const sender = event.getSender()!;
    const request = {
      action: 'request',
      request_id: randomUUID(),
      requesting_device_id: this.cfg.matrix.device_id,
      body: { algorithm: wire.algorithm, room_id: event.getRoomId(), sender_key: wire.sender_key, session_id: wire.session_id },
    };
    try {
      await this.client.sendToDevice('m.room_key_request', new Map([[sender, new Map([[wire.device_id ?? '*', request]])]]));
    } catch (err) {
      log.warn('key request for %s failed: %s', event.getId(), (err as Error).message);
    }
  }

  /** Verification policy (spec §3.2). Returns null to drop, or the trust verdict. */
  private async senderTrusted(event: MatrixEvent): Promise<boolean> {
    if (!event.isEncrypted()) return !this.client.getRoom(event.getRoomId()!)?.hasEncryptionStateEvent();
    // Device lists of room members are tracked and refreshed through /sync.
    const info = await this.client.getCrypto()!.getEncryptionInfoForEvent(event);
    return info !== null && info.shieldColour !== EventShieldColour.RED;
  }

  private async ingest(event: MatrixEvent) {
    if (event.getType() !== EventType.RoomMessage) return;
    if (!this.dedup.add(event.getId()!)) return;

    const roomId = event.getRoomId()!;
    const room = this.client.getRoom(roomId);
    if (!room) return;
    const sender = event.getSender()!;

    const trusted = await this.senderTrusted(event);
    if (!trusted && this.cfg.matrix.verification_policy === 'strict') {
      log.info('strict policy: ignoring %s from untrusted device of %s', event.getId(), sender);
      return;
    }

    const content = event.getContent();
    const relation = content['m.relates_to'] as
      | { rel_type?: string; event_id?: string; is_falling_back?: boolean; 'm.in_reply_to'?: { event_id?: string } }
      | undefined;
    const member = room.getMember(sender);
    const entry: HistoryEntry = {
      eventId: event.getId()!,
      sender,
      senderName: member?.rawDisplayName || sender,
      power: trusted ? powerLevel(room, sender) : 0,
      ts: effectiveTimestamp(event.getTs()),
      body: String(content.body ?? ''),
      threadRoot: relation?.rel_type === 'm.thread' ? relation.event_id : undefined,
      fromBot: false,
    };
    const st = this.state(roomId);
    insertChronologically(st.history, entry);
    if (st.history.length > MAX_ROOM_HISTORY) st.history.splice(0, st.history.length - MAX_ROOM_HISTORY);
    void this.client.sendReadReceipt(event).catch(() => undefined);

    const deterministic = tier1Matches(
      {
        body: entry.body,
        mentionedUserIds: (content['m.mentions'] as { user_ids?: string[] } | undefined)?.user_ids ?? [],
        inReplyTo: relation?.['m.in_reply_to']?.event_id,
        isFallbackReply: relation?.rel_type === 'm.thread' && relation.is_falling_back === true,
      },
      { userId: this.botId, displayName: this.botDisplayName(room), authored: st.authored, commandPrefixes: this.cfg.orchestration.turn_gating.command_prefixes },
    );
    if (deterministic) {
      clearTimeout(st.heuristicTimer);
      return this.enqueue(roomId, { entry, mode: 'deterministic' });
    }
    if (!this.cfg.orchestration.turn_gating.deterministic_only) this.scheduleHeuristic(roomId);
  }

  private botDisplayName(room: Room) {
    return room.getMember(this.botId)?.rawDisplayName || this.displayName;
  }

  // ------------------------------------------------------------------ tier 2

  private cooldownActive(st: RoomState) {
    return Date.now() - st.lastIntervention < this.cfg.orchestration.turn_gating.cooldown_seconds * 1000;
  }

  private humansTyping(roomId: string) {
    const room = this.client.getRoom(roomId);
    return !!room?.getJoinedMembers().some((m) => m.userId !== this.botId && m.typing);
  }

  private scheduleHeuristic(roomId: string) {
    const st = this.state(roomId);
    clearTimeout(st.heuristicTimer);
    if (this.cooldownActive(st)) return; // ingested into memory only
    st.heuristicTimer = setTimeout(() => this.evaluateHeuristic(roomId), HEURISTIC_SETTLE_MS);
  }

  private onTyping(roomId: string) {
    const st = this.rooms.get(roomId);
    if (st?.heuristicDeferredForTyping && !this.humansTyping(roomId)) {
      st.heuristicDeferredForTyping = false;
      this.scheduleHeuristic(roomId);
    }
  }

  private evaluateHeuristic(roomId: string) {
    const st = this.state(roomId);
    if (this.cooldownActive(st) || this.inference.breaker.state === 'open') return;
    if (this.humansTyping(roomId)) {
      st.heuristicDeferredForTyping = true;
      return;
    }
    const gating = this.cfg.orchestration.turn_gating;
    if (!deadlockDetected(st.history, DEADLOCK_WINDOW, gating.semantic_deadlock_threshold)) return;
    this.enqueue(roomId, { entry: st.history[st.history.length - 1], mode: 'heuristic' });
  }

  // ------------------------------------------------------------------ response

  private enqueue(roomId: string, trigger: Trigger) {
    const st = this.state(roomId);
    st.queue = st.queue
      .then(() => this.respond(roomId, trigger))
      .catch((err) => {
        log.error('respond in %s failed: %s', roomId, err?.stack ?? err);
      });
  }

  private async respond(roomId: string, { entry, mode }: Trigger) {
    const room = this.client.getRoom(roomId);
    if (!room) return;
    const st = this.state(roomId);
    if (mode === 'heuristic' && this.cooldownActive(st)) return;

    if (this.inference.breaker.state === 'open') {
      if (mode === 'deterministic') {
        // Low-overhead acknowledgement while inference is down (spec §8.3).
        await this.client.sendTyping(roomId, true, 3_000).catch(() => undefined);
      }
      return;
    }

    const gating = this.cfg.orchestration.turn_gating;
    const ctx = this.cfg.orchestration.context;
    const messages = buildContext({
      system: systemPrompt({
        botName: this.botDisplayName(room),
        botId: this.botId,
        roomId,
        roomName: room.name,
        silenceToken: gating.silence_token,
        mode,
      }),
      history: st.history,
      trigger: entry,
      maxEvents: ctx.max_history_events,
      tokenBudget: ctx.token_budget,
      protectedRecent: PROTECTED_RECENT,
    });

    await this.client.sendTyping(roomId, true, (this.cfg.inference.timeout_seconds + 5) * 1000).catch(() => undefined);
    try {
      let output: string;
      try {
        output = await this.inference.complete(messages);
      } catch (err) {
        if (err instanceof InferenceUnavailable) {
          log.warn('inference unavailable for %s: %s', entry.eventId, err.message);
          return;
        }
        throw err;
      }
      if (isSilence(output, gating.silence_token) || !output.trim()) {
        increment('turn_gating_silence_count');
        return;
      }
      await this.send(room, st, output, entry);
    } finally {
      await this.client.sendTyping(roomId, false, 0).catch(() => undefined);
    }
  }

  private async send(room: Room, st: RoomState, output: string, trigger: HistoryEntry) {
    const policy = this.cfg.orchestration.threading.reply_in_thread;
    const threadRoot = trigger.threadRoot ?? (policy === 'always' ? trigger.eventId : undefined);
    const members = room.getJoinedMembers().map((m) => ({ userId: m.userId, displayName: m.rawDisplayName }));
    const content = buildMessageContent({ text: output, members, threadRoot, inReplyTo: threadRoot ? trigger.eventId : undefined });

    const { event_id } = await this.client.sendEvent(room.roomId, threadRoot ?? null, EventType.RoomMessage, content as never);
    st.authored.add(event_id);
    st.lastIntervention = Date.now();
    insertChronologically(st.history, {
      eventId: event_id,
      sender: this.botId,
      senderName: this.botDisplayName(room),
      power: powerLevel(room, this.botId),
      ts: Date.now(),
      body: String(content.body),
      threadRoot,
      fromBot: true,
    });
  }
}
