import type { Config } from './config.ts';
import { activity } from './activity-log.ts';
import { log } from './log.ts';
import { increment } from './metrics.ts';

/** OpenAI-compatible inference client — specs.md §4 and §8.3. */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** OpenAI function-tool definition offered to the model. */
export interface ToolSpec {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface Completion {
  content: string;
  toolCalls: ToolCall[];
}

export class InferenceUnavailable extends Error {}

/** The caller cancelled the request (specs-two V12); never retried. */
export class InferenceAborted extends Error {}

const RETRY_BASE_MS = 500;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

class RetryableError extends Error {
  retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * CLOSED → OPEN after `threshold` consecutive failed attempts. While OPEN the
 * health endpoint is polled; `successesToClose` consecutive healthy probes close it.
 */
export class CircuitBreaker {
  private failures = 0;
  private healthy = 0;
  private poller?: NodeJS.Timeout;
  state: 'closed' | 'open' = 'closed';

  private readonly healthUrl: string;
  private readonly threshold: number;
  private readonly pollMs: number;
  private readonly successesToClose: number;

  constructor(healthUrl: string, threshold = 5, pollMs = 10_000, successesToClose = 2) {
    this.healthUrl = healthUrl;
    this.threshold = threshold;
    this.pollMs = pollMs;
    this.successesToClose = successesToClose;
  }

  recordSuccess() {
    this.failures = 0;
  }

  recordFailure() {
    increment('inference_failure_count');
    if (this.state === 'open') return;
    this.failures += 1;
    if (this.failures >= this.threshold) this.open();
  }

  private open() {
    log.warn('inference circuit OPEN after %d consecutive failures', this.failures);
    activity('circuit-open', { consecutive_failures: this.failures, reason: 'model paused; checking /health until it recovers' });
    increment('inference_circuit_open_count');
    this.state = 'open';
    this.healthy = 0;
    this.poller = setInterval(() => void this.probe(), this.pollMs);
  }

  private async probe() {
    const ok = await fetch(this.healthUrl, { signal: AbortSignal.timeout(this.pollMs / 2) })
      .then((r) => r.ok)
      .catch(() => false);
    this.healthy = ok ? this.healthy + 1 : 0;
    if (this.healthy >= this.successesToClose) {
      log.info('inference circuit CLOSED after %d healthy probes', this.healthy);
      activity('circuit-closed', { healthy_checks: this.healthy });
      clearInterval(this.poller);
      this.state = 'closed';
      this.failures = 0;
    }
  }

  stop() {
    clearInterval(this.poller);
  }
}

export class InferenceClient {
  readonly breaker: CircuitBreaker;
  private readonly cfg: Config['inference'];

  constructor(cfg: Config['inference']) {
    this.cfg = cfg;
    this.breaker = new CircuitBreaker(new URL('/health', cfg.base_url).toString());
  }

  /**
   * Returns the full completion text. Retries transient failures with
   * exponential backoff; throws InferenceUnavailable when the breaker is open
   * or every attempt failed.
   */
  async complete(messages: ChatMessage[], opts: { signal?: AbortSignal } = {}): Promise<string> {
    return (await this.chat(messages, opts)).content;
  }

  /** Full completion: text plus any tool calls. `signal` cancels without retrying. */
  async chat(messages: ChatMessage[], opts: { tools?: ToolSpec[]; signal?: AbortSignal } = {}): Promise<Completion> {
    if (this.breaker.state === 'open') throw new InferenceUnavailable('circuit open');

    const { max_attempts, backoff_factor } = this.cfg.retry;
    let lastError: unknown;
    for (let attempt = 1; attempt <= max_attempts; attempt++) {
      if (opts.signal?.aborted) throw new InferenceAborted('cancelled');
      try {
        const completion = await this.attempt(messages, opts);
        this.breaker.recordSuccess();
        return completion;
      } catch (err) {
        lastError = err;
        if (!(err instanceof RetryableError)) throw err;
        this.breaker.recordFailure();
        log.warn('inference attempt %d/%d failed: %s', attempt, max_attempts, err.message);
        activity('inference-retry', { attempt, of: max_attempts, reason: err.message });
        if (attempt < max_attempts) {
          const backoff = RETRY_BASE_MS * backoff_factor ** (attempt - 1);
          await sleep(Math.max(backoff, err.retryAfterMs ?? 0));
        }
      }
    }
    throw new InferenceUnavailable(`all ${max_attempts} attempts failed: ${String(lastError)}`);
  }

  private async attempt(messages: ChatMessage[], opts: { tools?: ToolSpec[]; signal?: AbortSignal }): Promise<Completion> {
    const p = this.cfg.parameters;
    const url = `${this.cfg.base_url.replace(/\/$/, '')}/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.api_key}` },
        body: JSON.stringify({
          model: this.cfg.model_name,
          messages,
          stream: true,
          temperature: p.temperature,
          top_p: p.top_p,
          max_tokens: p.max_tokens,
          presence_penalty: p.presence_penalty,
          frequency_penalty: p.frequency_penalty,
          ...(opts.tools?.length ? { tools: opts.tools, tool_choice: 'auto' } : {}),
        }),
        signal: opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(this.cfg.timeout_seconds * 1000)])
          : AbortSignal.timeout(this.cfg.timeout_seconds * 1000),
      });
      if (!res.ok) {
        await res.body?.cancel();
        if (RETRYABLE_STATUS.has(res.status)) {
          const retryAfter = Number(res.headers.get('retry-after'));
          throw new RetryableError(`HTTP ${res.status}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
        }
        throw new Error(`inference rejected request: HTTP ${res.status}`);
      }
      return await readCompletion(res);
    } catch (err) {
      if (err instanceof RetryableError) throw err;
      if (opts.signal?.aborted) throw new InferenceAborted('cancelled');
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError' || err instanceof TypeError) {
        throw new RetryableError(name === 'TimeoutError' ? 'timeout' : `connection: ${(err as Error).message}`);
      }
      throw err;
    }
  }
}

/** Accepts both SSE streams and plain JSON completions, including tool calls. */
async function readCompletion(res: Response): Promise<Completion> {
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> } }>;
    };
    const message = body.choices?.[0]?.message;
    return {
      content: message?.content ?? '',
      toolCalls: (message?.tool_calls ?? []).map((c) => ({ name: c.function.name, arguments: parseArgs(c.function.arguments) })),
    };
  }
  let text = '';
  const calls: Array<{ name: string; args: string }> = [];
  let buffer = '';
  const decoder = new TextDecoder();
  const finish = (): Completion => ({ content: text, toolCalls: calls.map((c) => ({ name: c.name, arguments: parseArgs(c.args) })) });
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return finish();
      const parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }> } }>;
      };
      const delta = parsed.choices?.[0]?.delta;
      text += delta?.content ?? '';
      for (const tc of delta?.tool_calls ?? []) {
        const i = tc.index ?? 0;
        calls[i] ??= { name: '', args: '' };
        calls[i].name += tc.function?.name ?? '';
        calls[i].args += tc.function?.arguments ?? '';
      }
    }
  }
  return finish();
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
