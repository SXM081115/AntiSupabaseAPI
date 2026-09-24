/**
 * HTTP 底层小工具：空 body 状态码、hop-by-hop 头、Vary 合并、Set-Cookie 读写。
 * 这些细节在 Workers / Node(undici) 两个运行时上行为有差异，集中在这里做兼容。
 */

/** 这些状态码按规范不能带响应体。 */
export const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** 逐跳头，端到端代理必须剥掉。 */
export const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** 客户端送来的这些头必须丢弃：由 Worker 重写或由 Cloudflare 自己生成。 */
export const STRIP_REQUEST_HEADERS = [
  ...HOP_BY_HOP_HEADERS,
  "host",
  "content-length",
  "apikey",
  "authorization",
  "cf-connecting-ip",
  "cf-ray",
  "cf-ipcountry",
  "cf-visitor",
  "cf-worker",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
  "x-proxy-token",
];

export function isNullBodyStatus(status: number): boolean {
  return NULL_BODY_STATUS.has(status);
}

/** 用新的响应头重建 Response，自动处理不能带 body 的状态码。 */
export function rebuildResponse(source: Response, headers: Headers): Response {
  if (isNullBodyStatus(source.status)) {
    return new Response(null, { status: source.status, statusText: source.statusText, headers });
  }
  if (!source.body) {
    return new Response(null, { status: source.status, statusText: source.statusText, headers });
  }
  // 流式透传：不缓冲 body，storage 大文件下载/上传都走这条路径
  return new Response(source.body, { status: source.status, statusText: source.statusText, headers });
}

/** 合并 Vary 头，避免重复项，且保留 `*` 的语义。 */
export function appendVary(headers: Headers, values: string[]): void {
  const existing = headers.get("vary");
  if (existing?.trim() === "*") return;
  const parts = new Set<string>();
  for (const raw of existing ? existing.split(",") : []) {
    const v = raw.trim();
    if (v) parts.add(v.toLowerCase());
  }
  for (const v of values) {
    const t = v.trim();
    if (t) parts.add(t.toLowerCase());
  }
  if (parts.size > 0) headers.set("vary", [...parts].join(", "));
}

/**
 * 读取全部 Set-Cookie。Workers 与 Node 20+ 都有 getSetCookie()，
 * 老运行时退回单条读取（会丢失多 Cookie 场景，仅作兜底）。
 */
export function getSetCookies(headers: Headers): string[] {
  const maybe = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof maybe.getSetCookie === "function") {
    return maybe.getSetCookie();
  }
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

/** 覆写全部 Set-Cookie（Headers.append 支持多值）。 */
export function setSetCookies(headers: Headers, cookies: string[]): void {
  headers.delete("set-cookie");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
}

/** 从 Set-Cookie 里剥掉 Domain 属性，让 Cookie 变成 host-only（落到 Worker 自己的域名上）。 */
export function stripCookieDomain(cookie: string): string {
  return cookie
    .split(";")
    .filter((part) => !/^\s*domain\s*=/i.test(part))
    .join(";");
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Node(undici) 在 body 为 ReadableStream 时要求 duplex: 'half'；Workers 忽略该字段。 */
export function applyNodeDuplexShim(init: RequestInit, hasBody: boolean): void {
  if (!hasBody) return;
  const proc = (globalThis as unknown as { process?: { versions?: { node?: string } } }).process;
  if (typeof proc?.versions?.node === "string") {
    (init as unknown as Record<string, unknown>).duplex = "half";
  }
}
