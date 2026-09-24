import { ProxyError } from "./errors";
import { parseLogLevel, type LogLevel } from "./log";
import type { Env } from "./types";

export type KeySlot = "service" | "anon";

/** 密钥路由规则：命中 prefix 的请求用哪个 key。 */
export interface KeyRule {
  prefix: string;
  slot: KeySlot;
}

export interface AppConfig {
  /** 上游 origin，例如 https://abcdefgh.supabase.co */
  upstreamOrigin: string;
  /** Worker 自身对外 origin，用于 Location / JSON 主机名改写 */
  proxyOrigin: string;
  /** 可选路径前缀（例如 /sb），会把 /sb/functions/v1/x 映射到上游 /functions/v1/x */
  proxyPrefix: string;
  /** 允许反代的上游路径前缀白名单 */
  allowedPathPrefixes: string[];
  /** 按前缀最长优先匹配的 key 规则 */
  keyRules: KeyRule[];
  defaultKeySlot: KeySlot;

  allowedOrigins: string[];
  corsAllowHeaders: string[];
  corsAllowMethods: string[];
  corsExposeHeaders: string[];
  corsMaxAge: number;
  corsAllowCredentials: boolean;

  upstreamTimeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  maxTotalMs: number;
  retryStatuses: number[];
  retryOn429: boolean;
  retryAfterMaxMs: number;
  circuitFailThreshold: number;
  circuitOpenMs: number;

  cacheEnabled: boolean;
  cacheTtlSeconds: number;
  cachePathPrefixes: string[];
  cacheVaryHeaders: string[];

  rewriteLocation: boolean;
  rewriteJsonHosts: boolean;
  cookieDomainStrip: boolean;
  stripClientCookies: boolean;

  enforceProxyToken: boolean;
  debugUpstreamErrors: boolean;
  logLevel: LogLevel;
}

const DEFAULTS = {
  proxyPrefix: "",
  allowedPathPrefixes: "/functions/v1/,/auth/v1/,/storage/v1/",
  serviceKeyPrefixes: "/functions/v1/,/auth/v1/admin/",
  anonKeyPrefixes: "/auth/v1/,/storage/v1/",
  defaultKeySlot: "anon",
  allowedOrigins: "http://localhost:3000,http://localhost:5173",
  corsAllowHeaders:
    "authorization,apikey,content-type,x-client-info,x-request-id,x-supabase-api-version,x-upsert,x-proxy-token,prefer,range,accept,accept-language,cache-control,if-none-match",
  corsAllowMethods: "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS",
  corsExposeHeaders: "x-request-id,x-proxy-cache,content-range,content-length,location,link,x-supabase-api-version",
  corsMaxAge: 86400,
  upstreamTimeoutMs: 30000,
  maxRetries: 1,
  retryBackoffMs: 250,
  maxTotalMs: 60000,
  retryStatuses: "502,503,504",
  retryAfterMaxMs: 5000,
  circuitFailThreshold: 5,
  circuitOpenMs: 15000,
  cacheTtlSeconds: 60,
  cachePathPrefixes: "/storage/v1/object/public/",
  cacheVaryHeaders: "accept,accept-language",
  logLevel: "info",
} as const;

function str(value: string | undefined, fallback: string): string {
  const s = (value ?? "").trim();
  return s === "" ? fallback : s;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  const s = (value ?? "").trim().toLowerCase();
  if (s === "") return fallback;
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function list(value: string | undefined, fallback: string): string[] {
  const source = str(value, fallback);
  return source
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 路径前缀规范化：确保以 `/` 开头、以 `/` 结尾，避免 `/auth/v1` 误匹配 `/auth/v1x`。 */
export function normalizePrefix(raw: string): string {
  let p = raw.trim();
  if (p === "" || p === "/") return "/";
  if (!p.startsWith("/")) p = `/${p}`;
  if (!p.endsWith("/")) p = `${p}/`;
  return p;
}

/** 前缀匹配：`/functions/v1/` 既匹配 `/functions/v1/foo` 也匹配 `/functions/v1`。 */
export function matchesPrefix(path: string, prefix: string): boolean {
  if (prefix === "/") return true;
  if (path === prefix.slice(0, -1)) return true;
  return path.startsWith(prefix);
}

/** 解析上游 origin：显式 SUPABASE_BASE_URL 优先，否则用 project ref 拼默认域名。 */
export function resolveUpstreamOrigin(env: Env): string {
  const explicit = (env.SUPABASE_BASE_URL ?? "").trim();
  if (explicit) {
    let url: URL;
    try {
      url = new URL(explicit);
    } catch {
      throw new ProxyError("MISSING_CONFIG", 500, "SUPABASE_BASE_URL 不是合法 URL");
    }
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !isLocal) {
      throw new ProxyError("MISSING_CONFIG", 500, "SUPABASE_BASE_URL 必须是 https");
    }
    return url.origin;
  }

  const ref = (env.SUPABASE_PROJECT_REF ?? "").trim();
  if (!/^[a-z0-9]{3,40}$/i.test(ref) || ref === "your-project-ref") {
    throw new ProxyError("MISSING_CONFIG", 500, "请在 wrangler.jsonc 配置 SUPABASE_PROJECT_REF，或改用 SUPABASE_BASE_URL");
  }
  return `https://${ref.toLowerCase()}.supabase.co`;
}

function buildKeyRules(env: Env): KeyRule[] {
  const rules: KeyRule[] = [];
  for (const raw of list(env.SERVICE_KEY_PREFIXES, DEFAULTS.serviceKeyPrefixes)) {
    rules.push({ prefix: normalizePrefix(raw), slot: "service" });
  }
  for (const raw of list(env.ANON_KEY_PREFIXES, DEFAULTS.anonKeyPrefixes)) {
    rules.push({ prefix: normalizePrefix(raw), slot: "anon" });
  }
  // 最长前缀优先：/auth/v1/admin/ 必须压过 /auth/v1/
  rules.sort((a, b) => b.prefix.length - a.prefix.length);
  return rules;
}

/**
 * 载入并校验配置。任何致命配置问题都在这里抛 ProxyError(MISSING_CONFIG)，
 * 由入口统一转成 500 JSON，不把上游地址等内容泄露给客户端。
 */
export function loadConfig(env: Env, requestUrl?: URL): AppConfig {
  const upstreamOrigin = resolveUpstreamOrigin(env);
  const proxyOrigin = requestUrl ? requestUrl.origin : "http://proxy.invalid";

  return {
    upstreamOrigin,
    proxyOrigin,
    proxyPrefix: (env.PROXY_PREFIX ?? DEFAULTS.proxyPrefix).trim().replace(/\/+$/, ""),
    allowedPathPrefixes: list(env.ALLOWED_PATH_PREFIXES, DEFAULTS.allowedPathPrefixes).map(normalizePrefix),
    keyRules: buildKeyRules(env),
    defaultKeySlot: (env.DEFAULT_KEY_SLOT ?? DEFAULTS.defaultKeySlot).trim().toLowerCase() === "service" ? "service" : "anon",

    allowedOrigins: list(env.ALLOWED_ORIGINS, DEFAULTS.allowedOrigins),
    corsAllowHeaders: list(env.CORS_ALLOW_HEADERS, DEFAULTS.corsAllowHeaders),
    corsAllowMethods: list(env.CORS_ALLOW_METHODS, DEFAULTS.corsAllowMethods),
    corsExposeHeaders: list(env.CORS_EXPOSE_HEADERS, DEFAULTS.corsExposeHeaders).map((h) => h.toLowerCase()),
    corsMaxAge: int(env.CORS_MAX_AGE, DEFAULTS.corsMaxAge, 0, 604800),
    corsAllowCredentials: bool(env.CORS_ALLOW_CREDENTIALS, false),

    upstreamTimeoutMs: int(env.UPSTREAM_TIMEOUT_MS, DEFAULTS.upstreamTimeoutMs, 1000, 300000),
    maxRetries: int(env.MAX_RETRIES, DEFAULTS.maxRetries, 0, 5),
    retryBackoffMs: int(env.RETRY_BACKOFF_MS, DEFAULTS.retryBackoffMs, 0, 10000),
    maxTotalMs: int(env.MAX_TOTAL_MS, DEFAULTS.maxTotalMs, 1000, 600000),
    retryStatuses: list(env.RETRY_STATUSES, DEFAULTS.retryStatuses)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n >= 400 && n <= 599),
    retryOn429: bool(env.RETRY_ON_429, false),
    retryAfterMaxMs: int(env.RETRY_AFTER_MAX_MS, DEFAULTS.retryAfterMaxMs, 0, 60000),
    circuitFailThreshold: int(env.CIRCUIT_FAIL_THRESHOLD, DEFAULTS.circuitFailThreshold, 1, 1000),
    circuitOpenMs: int(env.CIRCUIT_OPEN_MS, DEFAULTS.circuitOpenMs, 0, 600000),

    cacheEnabled: bool(env.CACHE_ENABLED, true),
    cacheTtlSeconds: int(env.CACHE_TTL_SECONDS, DEFAULTS.cacheTtlSeconds, 0, 86400),
    cachePathPrefixes: list(env.CACHE_PATH_PREFIXES, DEFAULTS.cachePathPrefixes).map(normalizePrefix),
    cacheVaryHeaders: list(env.CACHE_VARY_HEADERS, DEFAULTS.cacheVaryHeaders).map((h) => h.toLowerCase()),

    rewriteLocation: bool(env.REWRITE_LOCATION, true),
    rewriteJsonHosts: bool(env.REWRITE_JSON_HOSTS, false),
    cookieDomainStrip: bool(env.COOKIE_DOMAIN_STRIP, true),
    stripClientCookies: bool(env.STRIP_CLIENT_COOKIES, true),

    enforceProxyToken: bool(env.ENFORCE_PROXY_TOKEN, false),
    debugUpstreamErrors: bool(env.DEBUG_UPSTREAM_ERRORS, false),
    logLevel: parseLogLevel(env.LOG_LEVEL, DEFAULTS.logLevel),
  };
}
