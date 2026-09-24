import type { AppConfig } from "./config";
import { appendVary, rebuildResponse } from "./http";

export interface CorsDecision {
  /** 需要回显的 Access-Control-Allow-Origin；null 表示不加 CORS 头 */
  origin: string | null;
  credentials: boolean;
}

/** 白名单判定：`*` 放行所有；否则要求精确匹配请求的 Origin。 */
export function resolveOrigin(requestOrigin: string | null, cfg: AppConfig): CorsDecision {
  if (cfg.allowedOrigins.includes("*")) {
    // 带 * 时不能同时开 credentials（浏览器会拒绝），这里强制关闭
    return { origin: "*", credentials: false };
  }
  if (!requestOrigin) return { origin: null, credentials: false };
  const hit = cfg.allowedOrigins.some((allowed) => allowed.toLowerCase() === requestOrigin.toLowerCase());
  if (!hit) return { origin: null, credentials: false };
  return { origin: requestOrigin, credentials: cfg.corsAllowCredentials };
}

/** OPTIONS 预检：完全不打扰上游，直接本地应答。 */
export function corsPreflight(request: Request, cfg: AppConfig, requestId: string): Response {
  const decision = resolveOrigin(request.headers.get("origin"), cfg);
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "x-request-id": requestId,
    "x-proxy-cache": "BYPASS",
  });

  const requested = request.headers.get("access-control-request-headers");
  headers.set("access-control-allow-methods", cfg.corsAllowMethods.join(", "));
  headers.set("access-control-allow-headers", requested ? requested : cfg.corsAllowHeaders.join(", "));
  headers.set("access-control-max-age", String(cfg.corsMaxAge));

  if (decision.origin) {
    headers.set("access-control-allow-origin", decision.origin);
    if (decision.credentials) headers.set("access-control-allow-credentials", "true");
    else headers.set("access-control-allow-credentials", "false");
  } else {
    // 不在白名单：明确告诉对方来源不被允许，而不是伪装成功
    headers.set("access-control-allow-origin", "null");
  }

  appendVary(headers, ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"]);
  return new Response(null, { status: 204, headers });
}

/** 给最终响应补齐 CORS / 追踪 / 缓存状态头。 */
export function withCors(
  response: Response,
  request: Request,
  cfg: AppConfig,
  requestId: string,
  cacheStatus: "HIT" | "MISS" | "BYPASS",
): Response {
  const headers = new Headers(response.headers);
  const decision = resolveOrigin(request.headers.get("origin"), cfg);

  headers.delete("access-control-allow-origin");
  headers.delete("access-control-allow-credentials");
  if (decision.origin) {
    headers.set("access-control-allow-origin", decision.origin);
    if (decision.credentials) headers.set("access-control-allow-credentials", "true");
  }
  if (cfg.corsExposeHeaders.length > 0) {
    headers.set("access-control-expose-headers", cfg.corsExposeHeaders.join(", "));
  }

  // Supabase 自己带的 CORS 头会被浏览器看到两个值，统一由 Worker 兜底，先清掉上游的
  headers.delete("access-control-allow-methods");
  headers.delete("access-control-allow-headers");

  headers.set("x-request-id", requestId);
  headers.set("x-proxy-cache", cacheStatus);
  appendVary(headers, ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"]);

  return rebuildResponse(response, headers);
}
