import { cacheKeyFor, createCacheStore, isCacheableResponse, makeCacheable } from "./cache";
import { loadConfig, type AppConfig } from "./config";
import { corsPreflight, withCors } from "./cors";
import { ProxyError, asProxyError, errorPayload } from "./errors";
import { applyNodeDuplexShim, jsonResponse } from "./http";
import { circuitKeyFor, resolveKey, resolveKeySlot } from "./keys";
import { createLogger } from "./log";
import { buildUpstreamHeaders, buildUpstreamUrl, finalizeUpstreamResponse, normalizeRequestPath } from "./proxy";
import { fetchWithResilience } from "./resilience";
import type { Env } from "./types";

const VERSION = "0.1.0";
const HEALTH_PATH = "/__health";

/** 不依赖配置就能算出的对外前缀，用于识别健康检查路径。 */
function rawProxyPrefix(env: Env): string {
  return (env.PROXY_PREFIX ?? "").trim().replace(/\/+$/, "");
}

function isHealthRequest(url: URL, env: Env): boolean {
  return url.pathname === HEALTH_PATH || url.pathname === `${rawProxyPrefix(env)}${HEALTH_PATH}`;
}

/**
 * 健康检查：不触碰上游，且在配置缺失时也能回答（返回 503 + config_error），
 * 这样「配错了」和「服务挂了」在监控上能分得清。
 *
 * 同时暴露「密钥是否真的绑定到了运行时 env」—— 这是本仓库踩过的真实坑：
 * wrangler secret bulk 走旧的 script-secrets 接口，若之后又跑 wrangler deploy，
 * 新版本的绑定快照里会丢掉密钥，表现为 500 MISSING_CONFIG，但 secret list 里密钥仍在。
 * 这里只回布尔值，绝不回显密钥内容或长度。
 */
function handleHealth(url: URL, env: Env, request: Request, requestId: string): Response {
  let cfg: AppConfig | null = null;
  let configError: string | null = null;
  try {
    cfg = loadConfig(env, url);
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
  }

  const hasServiceKey = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim().length > 0;
  const hasAnonKey = (env.SUPABASE_ANON_KEY ?? "").trim().length > 0;
  // service key 是必需的（/functions/v1 与 /auth/v1/admin 都靠它）
  const ok = configError === null && hasServiceKey;

  const payload = {
    ok,
    service: "antisupabase-api",
    version: VERSION,
    config_ok: configError === null,
    has_service_role_key: hasServiceKey,
    has_anon_key: hasAnonKey,
    ...(configError ? { config_error: configError } : {}),
    time: new Date().toISOString(),
  };

  const base = jsonResponse(payload, ok ? 200 : 503);
  if (cfg) return withCors(base, request, cfg, requestId, "BYPASS");

  const headers = new Headers(base.headers);
  headers.set("x-request-id", requestId);
  return new Response(base.body, { status: base.status, headers });
}

/** 复用客户端传来的 request id（便于端到端追踪），否则生成一个。 */
function readRequestId(request: Request): string {
  const raw = (request.headers.get("x-request-id") ?? "").trim();
  if (/^[A-Za-z0-9._-]{8,64}$/.test(raw)) return raw;
  return crypto.randomUUID();
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 可选共享令牌门槛。默认 ENFORCE_PROXY_TOKEN=false，即完全开放。 */
function assertProxyToken(request: Request, env: Env): void {
  const expected = (env.PROXY_TOKEN ?? "").trim();
  if (!expected) {
    throw new ProxyError("MISSING_CONFIG", 500, "ENFORCE_PROXY_TOKEN=true 但未配置 PROXY_TOKEN");
  }
  const provided = (request.headers.get("x-proxy-token") ?? "").trim();
  if (!timingSafeEqual(provided, expected)) {
    throw new ProxyError("PROXY_TOKEN_REQUIRED", 401, "缺少或错误的 x-proxy-token");
  }
}

function toErrorResponse(
  err: ProxyError,
  requestId: string,
  cfg: AppConfig | null,
  request: Request | null,
  exposeDetails: boolean,
): Response {
  const payload = errorPayload(err.code, err.message, requestId, exposeDetails ? err.details : undefined);
  const base = jsonResponse(payload, err.status);
  const headers = new Headers(base.headers);
  headers.set("x-request-id", requestId);

  if (err.code === "CIRCUIT_OPEN" && typeof err.details?.retry_after_ms === "number") {
    headers.set("retry-after", String(Math.max(1, Math.ceil(err.details.retry_after_ms / 1000))));
  }

  if (cfg && request) {
    const withCorsHeaders = withCors(new Response(base.body, { status: base.status, headers }), request, cfg, requestId, "BYPASS");
    return withCorsHeaders;
  }
  return new Response(base.body, { status: base.status, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = readRequestId(request);
    const url = new URL(request.url);

    // ---- 0. 健康检查：先于配置解析，配错了也能自证 ----
    if (isHealthRequest(url, env)) {
      return handleHealth(url, env, request, requestId);
    }

    // ---- 1. 载入配置：失败也返回结构化 JSON，而不是 500 白页 ----
    let cfg: AppConfig;
    try {
      cfg = loadConfig(env, url);
    } catch (err) {
      const proxyErr = asProxyError(err);
      console.error(
        JSON.stringify({
          level: "error",
          msg: "config_load_failed",
          request_id: requestId,
          code: proxyErr.code,
          error: proxyErr.message,
        }),
      );
      return toErrorResponse(proxyErr, requestId, null, null, true);
    }

    const log = createLogger(cfg.logLevel, { request_id: requestId });
    const started = Date.now();
    const method = request.method.toUpperCase();

    try {
      // ---- 2. 健康检查已提前处理，这里进入正式反代流程 ----

      // ---- 3. CORS 预检本地应答 ----
      if (method === "OPTIONS") {
        return corsPreflight(request, cfg, requestId);
      }

      // ---- 4. 可选令牌门槛 ----
      if (cfg.enforceProxyToken) assertProxyToken(request, env);

      // ---- 5. 路径校验 ----
      const path = normalizeRequestPath(url.pathname, cfg);
      const isHead = method === "HEAD";
      const hasBody = request.body !== null && !isHead;

      // ---- 6. 缓存查找（仅 GET + 白名单前缀）----
      const store = createCacheStore();
      const cacheKey = await cacheKeyFor(request, url, path, cfg);
      if (cacheKey) {
        const hit = await store.match(cacheKey);
        if (hit) {
          log.info("proxy", {
            method,
            path,
            status: hit.status,
            duration_ms: Date.now() - started,
            cache: "HIT",
          });
          return withCors(hit, request, cfg, requestId, "HIT");
        }
      }

      // ---- 7. 选 key、拼上游请求 ----
      const key = resolveKey(resolveKeySlot(path, cfg), env);
      const upstreamUrl = buildUpstreamUrl(path, url.search, cfg);
      const headers = buildUpstreamHeaders(
        request,
        key,
        cfg,
        requestId,
        request.headers.get("cf-connecting-ip"),
        hasBody,
      );

      const init: RequestInit = { method, headers, redirect: "manual" };
      if (hasBody) init.body = request.body;
      applyNodeDuplexShim(init, hasBody);

      // ---- 8. 带超时/重试/熔断的上游调用 ----
      const { response: upstream, attempts, halfOpen } = await fetchWithResilience(upstreamUrl, init, {
        cfg,
        log,
        circuitKey: circuitKeyFor(path, cfg),
        hasBody,
      });

      // ---- 9. 出口改写 ----
      const finalized = await finalizeUpstreamResponse(upstream, { cfg, isHead });

      // ---- 10. 回填缓存（异步，不阻塞响应）----
      if (cacheKey && isCacheableResponse(finalized)) {
        const cacheable = makeCacheable(finalized.clone(), cfg.cacheTtlSeconds);
        ctx.waitUntil(
          store.put(cacheKey, cacheable).catch((err: unknown) => {
            log.warn("cache_put_failed", { path, error: err instanceof Error ? err.message : String(err) });
          }),
        );
      }

      const response = withCors(finalized, request, cfg, requestId, cacheKey ? "MISS" : "BYPASS");

      log.info("proxy", {
        method,
        path,
        status: response.status,
        upstream_status: upstream.status,
        duration_ms: Date.now() - started,
        attempts,
        key_slot: key.slot,
        half_open: halfOpen,
        cache: cacheKey ? "MISS" : "BYPASS",
      });
      return response;
    } catch (err) {
      const proxyErr = asProxyError(err);
      const fields = {
        method,
        path: url.pathname,
        code: proxyErr.code,
        status: proxyErr.status,
        error: proxyErr.message,
        details: proxyErr.details,
        duration_ms: Date.now() - started,
      };
      if (proxyErr.status >= 500) log.error("proxy_error", fields);
      else log.warn("proxy_error", fields);

      return toErrorResponse(proxyErr, requestId, cfg, request, cfg.debugUpstreamErrors);
    }
  },
} satisfies ExportedHandler<Env>;
