import type { Config } from './config.ts';
import { log } from './log.ts';
import { increment } from './metrics.ts';

/** OpenAI-compatible inference client — specs.md §4 and §8.3. */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class InferenceUnavailable extends Error {}

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
  async complete(messages: ChatMessage[]): Promise<string> {
    if (this.breaker.state === 'open') throw new InferenceUnavailable('circuit open');

    const { max_attempts, backoff_factor } = this.cfg.retry;
    let lastError: unknown;
    for (let attempt = 1; attempt <= max_attempts; attempt++) {
      try {
        const text = await this.attempt(messages);
        this.breaker.recordSuccess();
        return text;
      } catch (err) {
        lastError = err;
        if (!(err instanceof RetryableError)) throw err;
        this.breaker.recordFailure();
        log.warn('inference attempt %d/%d failed: %s', attempt, max_attempts, err.message);
        if (attempt < max_attempts) {
          const backoff = RETRY_BASE_MS * backoff_factor ** (attempt - 1);
          await sleep(Math.max(backoff, err.retryAfterMs ?? 0));
        }
      }
    }
    throw new InferenceUnavailable(`all ${max_attempts} attempts failed: ${String(lastError)}`);
  }

  private async attempt(messages: ChatMessage[]): Promise<string> {
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
        }),
        signal: AbortSignal.timeout(this.cfg.timeout_seconds * 1000),
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
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError' || err instanceof TypeError) {
        throw new RetryableError(name === 'TimeoutError' ? 'timeout' : `connection: ${(err as Error).message}`);
      }
      throw err;
    }
  }
}

/** Accepts both SSE streams and plain JSON completions. */
async function readCompletion(res: Response): Promise<string> {
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content ?? '';
  }
  let text = '';
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return text;
      const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
      text += parsed.choices?.[0]?.delta?.content ?? '';
    }
  }
  return text;
}
