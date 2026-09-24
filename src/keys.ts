import type { AppConfig, KeySlot } from "./config";
import { matchesPrefix } from "./config";
import { ProxyError } from "./errors";
import type { Env } from "./types";

export interface ResolvedKey {
  slot: KeySlot;
  /** 同时用于 `apikey` 与 `Authorization: Bearer <key>` */
  key: string;
}

/** 按「前缀最长优先」选出该路径该用哪个 key。 */
export function resolveKeySlot(path: string, cfg: AppConfig): KeySlot {
  for (const rule of cfg.keyRules) {
    if (matchesPrefix(path, rule.prefix)) return rule.slot;
  }
  return cfg.defaultKeySlot;
}

/**
 * 取到真实密钥。key 只在 Worker 内部流转：
 * 客户端送来的 apikey / Authorization 在 proxy.ts 里被无条件丢弃后再由这里注入。
 */
export function resolveKey(slot: KeySlot, env: Env): ResolvedKey {
  const service = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const anon = (env.SUPABASE_ANON_KEY ?? "").trim();

  if (slot === "anon") {
    if (anon) return { slot, key: anon };
    if (service) return { slot: "service", key: service };
    throw new ProxyError("MISSING_CONFIG", 500, "缺少 SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY 密钥");
  }

  if (!service) {
    throw new ProxyError("MISSING_CONFIG", 500, "缺少 SUPABASE_SERVICE_ROLE_KEY 密钥");
  }
  return { slot, key: service };
}

/** 熔断器分桶键：按上游路径前缀分组，某一类接口挂了不拖垮其他接口。 */
export function circuitKeyFor(path: string, cfg: AppConfig): string {
  for (const prefix of cfg.allowedPathPrefixes) {
    if (matchesPrefix(path, prefix)) return prefix;
  }
  return "/";
}
