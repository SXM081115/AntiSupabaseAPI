/**
 * Worker 环境变量 / 密钥的类型定义。
 *
 * 约定：
 *  - `wrangler.jsonc` 的 `vars` 放非敏感配置；
 *  - 凡是密钥都通过 `wrangler secret put <NAME>`（线上）或 `.dev.vars`（本地）注入；
 *  - 所有值都是字符串（Workers vars/secret 只能是 string），在 config.ts 里做类型转换。
 */
export interface Env {
  // ===== 目标 =====
  /** Supabase project ref，例如 `abcdefghijklmnop` → https://abcdefghijklmnop.supabase.co */
  SUPABASE_PROJECT_REF?: string;
  /** 完整的上游 origin（自定义域名场景），例如 https://api.example.com，优先级高于 project ref */
  SUPABASE_BASE_URL?: string;

  // ===== 密钥 =====
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_ANON_KEY?: string;
  /** 可选共享令牌，仅在 ENFORCE_PROXY_TOKEN=true 时启用校验 */
  PROXY_TOKEN?: string;

  // ===== 路由 =====
  PROXY_PREFIX?: string;
  ALLOWED_PATH_PREFIXES?: string;
  SERVICE_KEY_PREFIXES?: string;
  ANON_KEY_PREFIXES?: string;
  DEFAULT_KEY_SLOT?: string;

  // ===== CORS =====
  ALLOWED_ORIGINS?: string;
  CORS_ALLOW_HEADERS?: string;
  CORS_ALLOW_METHODS?: string;
  CORS_EXPOSE_HEADERS?: string;
  CORS_MAX_AGE?: string;
  CORS_ALLOW_CREDENTIALS?: string;

  // ===== 上游弹性 =====
  UPSTREAM_TIMEOUT_MS?: string;
  MAX_RETRIES?: string;
  RETRY_BACKOFF_MS?: string;
  MAX_TOTAL_MS?: string;
  RETRY_STATUSES?: string;
  RETRY_ON_429?: string;
  RETRY_AFTER_MAX_MS?: string;
  CIRCUIT_FAIL_THRESHOLD?: string;
  CIRCUIT_OPEN_MS?: string;

  // ===== 缓存 =====
  CACHE_ENABLED?: string;
  CACHE_TTL_SECONDS?: string;
  CACHE_PATH_PREFIXES?: string;
  CACHE_VARY_HEADERS?: string;

  // ===== 改写 =====
  REWRITE_LOCATION?: string;
  REWRITE_JSON_HOSTS?: string;
  COOKIE_DOMAIN_STRIP?: string;
  /** 是否丢弃客户端送来的 Cookie（密钥全隐藏模式下默认丢弃，避免身份与缓存串味） */
  STRIP_CLIENT_COOKIES?: string;

  // ===== 入口门槛 =====
  ENFORCE_PROXY_TOKEN?: string;

  // ===== 可观测 =====
  LOG_LEVEL?: string;
  DEBUG_UPSTREAM_ERRORS?: string;
}
