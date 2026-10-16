import { activity } from './activity-log.ts';
import { ConsensusGate } from './consensus.ts';
import type { ToolCall, ToolSpec } from './inference.ts';
import { log } from './log.ts';
import { detectDelegationClaim, hasVerifiedApproval, provenanceRejection, type Member } from './provenance.ts';
import { idempotencyKey, ToolLedger } from './tools.ts';

/**
 * Tool execution for specs-two: V9 idempotency, V14 chain of provenance,
 * V17 M-of-N consensus. Tools are HTTP endpoints: POST <endpoint_base>/tools/<name>
 * with the JSON arguments; the response's `result` is reported in the room.
 */

export const PROPOSAL_KEY = 'com.synapse.proposal';

export interface ToolDefinition {
  name: string;
  risk: 'normal' | 'privileged' | 'critical';
  target_param: string;
  description?: string;
  required_power?: number;
  quorum?: number;
  approver_power?: number;
}

export interface ToolsConfig {
  endpoint_base: string;
  idempotency_key: string;
  idempotency_window_seconds?: number;
  definitions: ToolDefinition[];
}

export interface ToolRequest {
  roomId: string;
  eventId: string;
  sender: string;
  senderName: string;
  power: number;
  body: string;
  members: Member[];
}

export interface ToolRuntimeDeps {
  /** Posts a message in the room; returns its event id. `mention` users are notified. */
  post(roomId: string, body: string, opts?: { mention?: string[]; extra?: Record<string, unknown>; notice?: boolean }): Promise<string>;
  /** specs-two V11: verifies a tool payload against the invariants; posts the warning itself when it fails. */
  verify(roomId: string, candidate: string, asker?: string): Promise<boolean>;
}

interface Pending {
  def: ToolDefinition;
  call: ToolCall;
  request: ToolRequest;
}

export class ToolRuntime {
  private readonly ledger = new ToolLedger();
  /** V14: request event id → awaiting the named authority's approval. */
  private readonly awaitingAuthority = new Map<string, Pending & { authority: string; events: Array<{ sender: string; type: string; content: Record<string, any> }> }>();
  /** V17: proposal event id → consensus gate. */
  private readonly proposals = new Map<string, Pending & { gate: ConsensusGate }>();

  private readonly cfg: ToolsConfig;
  private readonly deps: ToolRuntimeDeps;

  constructor(cfg: ToolsConfig, deps: ToolRuntimeDeps) {
    this.cfg = cfg;
    this.deps = deps;
  }

  specs(): ToolSpec[] {
    return this.cfg.definitions.map((d) => ({
      type: 'function',
      function: {
        name: d.name,
        description: `${d.description ?? d.name} (risk: ${d.risk})`,
        parameters: { type: 'object', properties: { [d.target_param]: { type: 'string' } }, required: [d.target_param] },
      },
    }));
  }

  private target(def: ToolDefinition, call: ToolCall) {
    return String(call.arguments[def.target_param] ?? '');
  }

  private label(def: ToolDefinition, call: ToolCall) {
    return `${def.name} (${this.target(def, call) || 'no target'})`;
  }

  async handle(call: ToolCall, request: ToolRequest) {
    const def = this.cfg.definitions.find((d) => d.name === call.name);
    if (!def) {
      log.warn('model requested unknown tool %s', call.name);
      return;
    }
    const where = { room_id: request.roomId, sender: request.sender, event: request.eventId, tool: def.name };

    if (def.risk === 'critical') {
      const quorum = def.quorum ?? 2;
      const minPower = def.approver_power ?? 100;
      const proposalId = await this.deps.post(
        request.roomId,
        `⚠️ This is a high-risk action: ${this.label(def, call)}. I need ${quorum} approvals (react ✅) from people with power level ${minPower} or more, other than the requester, before I run it. React ❌ to cancel.`,
        {
          mention: [request.sender],
          extra: {
            [PROPOSAL_KEY]: {
              tool: def.name,
              args: call.arguments,
              quorum,
              min_power: minPower,
              requester: request.sender,
              request_event: request.eventId,
              status: 'staged',
            },
          },
        },
      );
      this.proposals.set(proposalId, { def, call, request, gate: new ConsensusGate({ quorum, minPower, requester: request.sender }) });
      activity('tool-staged', { ...where, proposal: proposalId, quorum, min_power: minPower });
      return;
    }

    if (def.risk === 'privileged') {
      const required = def.required_power ?? 50;
      if (request.power < required) {
        const claim = detectDelegationClaim(request.body, request.members);
        const authority = claim && request.members.find((m) => m.userId === claim.claimedAuthority && m.power >= required);
        if (authority) {
          this.awaitingAuthority.set(request.eventId, { def, call, request, authority: authority.userId, events: [] });
          await this.deps.post(request.roomId, provenanceRejection(authority.userId), { mention: [request.sender] });
          activity('tool-rejected', { ...where, reason: `unverified delegation claim naming ${authority.userId}` });
        } else {
          await this.deps.post(request.roomId, `Cannot execute: ${def.name} requires power level ${required} or a verified approval.`, {
            mention: [request.sender],
          });
          activity('tool-rejected', { ...where, reason: `power ${request.power} below ${required}` });
        }
        return;
      }
    }

    await this.execute({ def, call, request });
  }

  /** Reactions: V14 authority approvals and V17 proposal votes. */
  async onReaction(roomId: string, r: { sender: string; power: number; targetEventId: string; key: string; content: Record<string, any> }) {
    const proposal = this.proposals.get(r.targetEventId);
    if (proposal && proposal.request.roomId === roomId) {
      const before = proposal.gate.state;
      if (r.key === '✅') proposal.gate.approve(r.sender, r.power);
      if (r.key === '❌') proposal.gate.reject(r.sender, r.power);
      const after = proposal.gate.state;
      if (before === 'staged' && after === 'approved') {
        this.proposals.delete(r.targetEventId);
        await this.execute(proposal, `approved by ${proposal.gate.approvers.join(', ')}`);
      } else if (before === 'staged' && after === 'cancelled') {
        this.proposals.delete(r.targetEventId);
        await this.deps.post(roomId, `Proposal cancelled by ${r.sender}: ${this.label(proposal.def, proposal.call)} will not run.`, { notice: true });
        activity('tool-cancelled', { room_id: roomId, tool: proposal.def.name, proposal: r.targetEventId, by: r.sender });
      }
      return;
    }
    await this.checkAuthority(roomId, r.targetEventId, { sender: r.sender, type: 'm.reaction', content: r.content });
  }

  /** Replies: V14 authority approvals ("approved", "go ahead"). */
  async onReply(roomId: string, m: { sender: string; inReplyTo: string; content: Record<string, any> }) {
    await this.checkAuthority(roomId, m.inReplyTo, { sender: m.sender, type: 'm.room.message', content: m.content });
  }

  private async checkAuthority(roomId: string, requestEventId: string, event: { sender: string; type: string; content: Record<string, any> }) {
    const pending = this.awaitingAuthority.get(requestEventId);
    if (!pending || pending.request.roomId !== roomId) return;
    pending.events.push(event);
    if (!hasVerifiedApproval(pending.authority, requestEventId, pending.events)) return;
    this.awaitingAuthority.delete(requestEventId);
    await this.execute(pending, `approved by ${pending.authority}`);
  }

  private async execute({ def, call, request }: Pending, approval?: string) {
    const where = { room_id: request.roomId, sender: request.sender, event: request.eventId, tool: def.name };
    const windowSeconds = this.cfg.idempotency_window_seconds ?? 60;
    const now = Date.now();
    const keyAt = (timestamp: number) =>
      idempotencyKey({ tool: def.name, target: this.target(def, call), timestamp }, this.cfg.idempotency_key, windowSeconds);
    const key = keyAt(now);
    // The 60s bucket slides: a request just after a bucket boundary still matches one just before it.
    const previous = keyAt(now - windowSeconds * 1000);
    const previousAt = previous !== key ? this.ledger.claimedAt(previous) : undefined;
    const claim =
      previousAt !== undefined && now - previousAt < windowSeconds * 1000
        ? this.ledger.claim(previous, { eventId: request.eventId, sender: request.sender })
        : this.ledger.claim(key, { eventId: request.eventId, sender: request.sender });
    if (claim.status === 'duplicate') {
      const original = request.members.find((m) => m.userId === claim.original.sender)?.displayName ?? claim.original.sender;
      await this.deps.post(
        request.roomId,
        `${this.label(def, call)} already dispatched via command from ${original} (${claim.original.eventId}); skipping duplicate action.`,
        { mention: [request.sender] },
      );
      activity('tool-duplicate', { ...where, original: claim.original.eventId });
      return;
    }
    if (!(await this.deps.verify(request.roomId, `Tool call: ${def.name}(${JSON.stringify(call.arguments)})`, request.sender))) {
      this.ledger.release(key);
      return;
    }
    let result: string;
    try {
      const res = await fetch(`${this.cfg.endpoint_base.replace(/\/$/, '')}/tools/${encodeURIComponent(def.name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(call.arguments),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      result = String(((await res.json()) as { result?: unknown }).result ?? 'done');
    } catch (err) {
      this.ledger.release(key);
      await this.deps.post(request.roomId, `${this.label(def, call)} failed: ${(err as Error).message}`, { mention: [request.sender] });
      activity('failed', { ...where, reason: `tool error: ${(err as Error).message}` });
      return;
    }
    this.ledger.complete(key, result);
    await this.deps.post(request.roomId, `✅ ${this.label(def, call)}: ${result}${approval ? ` (${approval})` : ''}`, { mention: [request.sender] });
    activity('tool-executed', { ...where, approval });
  }
}
