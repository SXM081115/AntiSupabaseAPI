import type { AppConfig } from "./config";
import { ProxyError } from "./errors";
import type { Logger } from "./log";

export interface CircuitState {
  failures: number;
  /** 非 null 表示熔断已开启，值为上次开启/放行探针的时间戳 */
  openedAt: number | null;
}

/** 模块级熔断状态：同一 isolate 内跨请求共享，随 isolate 回收自动清零。 */
const CIRCUITS = new Map<string, CircuitState>();

export function __resetCircuitBreakers(): void {
  CIRCUITS.clear();
}

function circuitFor(key: string): CircuitState {
  let state = CIRCUITS.get(key);
  if (!state) {
    state = { failures: 0, openedAt: null };
    CIRCUITS.set(key, state);
  }
  return state;
}

export interface CircuitGate {
  allowed: boolean;
  halfOpen: boolean;
  retryAfterMs: number;
}

/** 熔断门禁：开启期间直接拒流；冷却期结束后放行一个半开探针。 */
export function checkCircuit(key: string, cfg: AppConfig): CircuitGate {
  const state = circuitFor(key);
  if (state.openedAt === null) return { allowed: true, halfOpen: false, retryAfterMs: 0 };

  const elapsed = Date.now() - state.openedAt;
  if (elapsed >= cfg.circuitOpenMs) {
    // 半开：只放一个探针（把 openedAt 推到当前，等价于再次进入冷却）
    state.openedAt = Date.now();
    return { allowed: true, halfOpen: true, retryAfterMs: 0 };
  }
  return { allowed: false, halfOpen: false, retryAfterMs: cfg.circuitOpenMs - elapsed };
}

function recordSuccess(state: CircuitState): void {
  state.failures = 0;
  state.openedAt = null;
}

function recordFailure(state: CircuitState, cfg: AppConfig): void {
  state.failures += 1;
  if (state.openedAt !== null || state.failures >= cfg.circuitFailThreshold) {
    state.openedAt = Date.now();
  }
}

export interface ResilienceContext {
  cfg: AppConfig;
  log: Logger;
  circuitKey: string;
  /** 是否带请求体。带体请求不做重试（body 只能读一次，重放不可靠）。 */
  hasBody: boolean;
}

export interface ResilienceResult {
  response: Response;
  attempts: number;
  halfOpen: boolean;
}

function isRetryableStatus(status: number, cfg: AppConfig): boolean {
  if (cfg.retryStatuses.includes(status)) return true;
  return cfg.retryOn429 && status === 429;
}

function retryAfterMs(response: Response, cfg: AppConfig): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return 0;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, cfg.retryAfterMaxMs);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), cfg.retryAfterMaxMs);
  return 0;
}

function backoffMs(attempt: number, cfg: AppConfig, hint: number): number {
  const base = cfg.retryBackoffMs * 2 ** (attempt - 1);
  const jitter = cfg.retryBackoffMs > 0 ? Math.floor(Math.random() * cfg.retryBackoffMs) : 0;
  return Math.max(base + jitter, hint);
}

function sleep(ms: number, deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, remaining)));
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`upstream timeout after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/**
 * 带超时、有限重试、熔断的上游请求。
 * 只对「无 body 请求」重试，因此 POST/PATCH/DELETE 天然不会被重复执行。
 */
export async function fetchWithResilience(url: URL, init: RequestInit, ctx: ResilienceContext): Promise<ResilienceResult> {
  const { cfg } = ctx;
  const state = circuitFor(ctx.circuitKey);

  const gate = checkCircuit(ctx.circuitKey, cfg);
  if (!gate.allowed) {
    throw new ProxyError("CIRCUIT_OPEN", 503, "上游连续失败，熔断开启中", {
      retry_after_ms: Math.round(gate.retryAfterMs),
      bucket: ctx.circuitKey,
    });
  }

  const maxAttempts = Math.max(1, cfg.maxRetries + 1);
  const canRetry = !ctx.hasBody;
  const deadline = Date.now() + cfg.maxTotalMs;
  let lastError: unknown = null;
  let timedOut = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url.toString(), init, cfg.upstreamTimeoutMs);

      if (isRetryableStatus(response.status, cfg) && canRetry && attempt < maxAttempts && Date.now() < deadline) {
        ctx.log.warn("upstream_retry", {
          attempt,
          status: response.status,
          path: url.pathname,
          bucket: ctx.circuitKey,
        });
        const hint = retryAfterMs(response, cfg);
        try {
          await response.body?.cancel();
        } catch {
          // 取消失败无所谓，响应即将被丢弃
        }
        await sleep(backoffMs(attempt, cfg, hint), deadline);
        continue;
      }

      if (response.status >= 500) recordFailure(state, cfg);
      else recordSuccess(state);

      return { response, attempts: attempt, halfOpen: gate.halfOpen };
    } catch (err) {
      lastError = err;
      timedOut = isTimeoutError(err);
      ctx.log.warn("upstream_error", {
        attempt,
        path: url.pathname,
        bucket: ctx.circuitKey,
        timed_out: timedOut,
        error: err instanceof Error ? err.message : String(err),
      });

      if (!canRetry || attempt >= maxAttempts || Date.now() >= deadline) break;
      await sleep(backoffMs(attempt, cfg, 0), deadline);
    }
  }

  recordFailure(state, cfg);

  if (timedOut) {
    throw new ProxyError("UPSTREAM_TIMEOUT", 504, "上游响应超时", { timeout_ms: cfg.upstreamTimeoutMs });
  }
  throw new ProxyError("UPSTREAM_ERROR", 502, "无法连接上游", {
    reason: lastError instanceof Error ? lastError.message : "network_error",
  });
}
