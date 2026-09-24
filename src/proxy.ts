import type { AppConfig } from "./config";
import { matchesPrefix } from "./config";
import { ProxyError } from "./errors";
import {
  HOP_BY_HOP_HEADERS,
  STRIP_REQUEST_HEADERS,
  getSetCookies,
  isNullBodyStatus,
  rebuildResponse,
  setSetCookies,
  stripCookieDomain,
} from "./http";
import type { ResolvedKey } from "./keys";

const MAX_JSON_REWRITE_BYTES = 1_048_576;

/**
 * 校验并规范化入站路径：
 *  1. 剥掉可选 PROXY_PREFIX；
 *  2. 拒绝编码绕过（%2e / %2f / %5c / 反斜杠 / ..）；
 *  3. 必须命中 ALLOWED_PATH_PREFIXES 白名单，否则 404。
 */
export function normalizeRequestPath(rawPath: string, cfg: AppConfig): string {
  let path = rawPath && rawPath.length > 0 ? rawPath : "/";
  const prefix = cfg.proxyPrefix;

  if (prefix && prefix !== "/") {
    if (path === prefix) path = "/";
    else if (path.startsWith(`${prefix}/`)) path = path.slice(prefix.length);
    else throw new ProxyError("ROUTE_NOT_ALLOWED", 404, "路径不在反代前缀内", { prefix });
  }

  const lower = path.toLowerCase();
  if (
    path.includes("..") ||
    path.includes("\\") ||
    lower.includes("%2e") ||
    lower.includes("%2f") ||
    lower.includes("%5c") ||
    lower.includes("//")
  ) {
    throw new ProxyError("BAD_PATH", 400, "路径包含非法片段");
  }

  if (!path.startsWith("/")) path = `/${path}`;

  if (!cfg.allowedPathPrefixes.some((allowed) => matchesPrefix(path, allowed))) {
    throw new ProxyError("ROUTE_NOT_ALLOWED", 404, "该路径不在反代白名单内", {
      allowed: cfg.allowedPathPrefixes,
    });
  }

  return path;
}

/** 拼出上游 URL，并再次断言 origin 未被路径操纵改写（防 SSRF / 开放重定向）。 */
export function buildUpstreamUrl(path: string, search: string, cfg: AppConfig): URL {
  const url = new URL(path, cfg.upstreamOrigin);
  url.search = search;
  if (url.origin !== cfg.upstreamOrigin) {
    throw new ProxyError("BAD_PATH", 400, "上游地址校验失败");
  }
  return url;
}

/** 构造发往 Supabase 的请求头：丢弃客户端身份，注入由 Worker 选定的密钥。 */
export function buildUpstreamHeaders(
  request: Request,
  key: ResolvedKey,
  cfg: AppConfig,
  requestId: string,
  clientIp: string | null,
  hasBody: boolean,
): Headers {
  const headers = new Headers();

  request.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (STRIP_REQUEST_HEADERS.includes(lower)) return;
    if (lower.startsWith("cf-")) return;
    if (cfg.stripClientCookies && lower === "cookie") return;
    headers.set(name, value);
  });

  if (!hasBody) {
    headers.delete("content-type");
  }

  headers.set("apikey", key.key);
  headers.set("authorization", `Bearer ${key.key}`);
  headers.set("x-request-id", requestId);
  headers.set("x-forwarded-proto", new URL(request.url).protocol.replace(":", ""));
  if (clientIp) headers.set("x-forwarded-for", clientIp);
  if (!headers.has("user-agent")) headers.set("user-agent", "antisupabase-api/0.1");

  return headers;
}

export interface FinalizeOptions {
  cfg: AppConfig;
  isHead: boolean;
}

function isJsonResponse(headers: Headers): boolean {
  return (headers.get("content-type") ?? "").toLowerCase().includes("application/json");
}

function rewriteLocationHeader(headers: Headers, cfg: AppConfig): void {
  const location = headers.get("location");
  if (!location) return;
  let resolved: URL;
  try {
    resolved = new URL(location, cfg.upstreamOrigin);
  } catch {
    return;
  }
  if (resolved.origin !== cfg.upstreamOrigin) return;
  resolved.protocol = new URL(cfg.proxyOrigin).protocol;
  resolved.host = new URL(cfg.proxyOrigin).host;
  headers.set("location", resolved.toString());
}

function rewriteJsonHostsInBody(upstream: Response, headers: Headers, cfg: AppConfig): Promise<Response> {
  const upstreamUrl = new URL(cfg.upstreamOrigin);
  const proxyUrl = new URL(cfg.proxyOrigin);
  const upstreamOrigin = upstreamUrl.origin;
  const upstreamHost = upstreamUrl.host;
  const proxyOrigin = proxyUrl.origin;
  const proxyHost = proxyUrl.host;

  const declaredLength = Number.parseInt(headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_REWRITE_BYTES) {
    return Promise.resolve(rebuildResponse(upstream, headers));
  }

  return upstream
    .text()
    .then((text) => {
      if (!text.includes(upstreamOrigin) && !text.includes(upstreamHost)) {
        const out = new Headers(headers);
        out.delete("content-length");
        return new Response(text, { status: upstream.status, statusText: upstream.statusText, headers: out });
      }
      // 先整体替换 origin（连 scheme 一起换成 Worker 自己的），再兜底替换裸主机名
      const replaced = text.split(upstreamOrigin).join(proxyOrigin).split(upstreamHost).join(proxyHost);
      try {
        JSON.parse(replaced);
      } catch {
        // 替换后不再是合法 JSON 就原样返回，绝不破坏上游响应
        return new Response(text, { status: upstream.status, statusText: upstream.statusText, headers });
      }
      const out = new Headers(headers);
      out.delete("content-length");
      return new Response(replaced, { status: upstream.status, statusText: upstream.statusText, headers: out });
    })
    .catch(() => rebuildResponse(upstream, headers));
}

/**
 * 上游响应的出口处理：剥逐跳头、改写 Location/Set-Cookie/JSON 主机名。
 * 默认走流式透传，不缓冲 body。
 */
export async function finalizeUpstreamResponse(upstream: Response, opts: FinalizeOptions): Promise<Response> {
  const { cfg } = opts;
  const headers = new Headers(upstream.headers);
  for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);

  if (cfg.rewriteLocation) rewriteLocationHeader(headers, cfg);

  if (cfg.cookieDomainStrip) {
    const cookies = getSetCookies(headers);
    if (cookies.length > 0) setSetCookies(headers, cookies.map(stripCookieDomain));
  }

  const canRewriteBody =
    cfg.rewriteJsonHosts &&
    !opts.isHead &&
    !isNullBodyStatus(upstream.status) &&
    upstream.body !== null &&
    isJsonResponse(headers);

  if (canRewriteBody) {
    return rewriteJsonHostsInBody(upstream, headers, cfg);
  }

  if (opts.isHead || isNullBodyStatus(upstream.status)) {
    return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  return rebuildResponse(upstream, headers);
}
