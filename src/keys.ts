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

/** 密钥绑定在运行时可能是「字符串」或「带 get() 的对象」两种形态。 */
export interface SecretBindingShape {
  /** typeof 结果，用于诊断 */
  type: string;
  /** 是否需要在取值前 await 一个 get() */
  async: boolean;
}

/**
 * 统一读取密钥绑定，同时兼容两种形态：
 *  1. 普通文本 secret / var / .dev.vars —— 直接就是 string；
 *  2. Cloudflare Secrets Store 绑定 —— 暴露的是一个带 `get()` 的对象，
 *     直接当字符串用会拿到空值（本项目实测踩过：env.X 读出 undefined，
 *     而 secret list 与 store 里密钥都健在）。
 */
export async function readSecretBinding(binding: unknown): Promise<{ value: string; shape: SecretBindingShape }> {
  if (typeof binding === "string") {
    return { value: binding.trim(), shape: { type: "string", async: false } };
  }

  const maybe = binding as { get?: unknown } | null | undefined;
  if (maybe && typeof maybe.get === "function") {
    try {
      const raw = await (maybe.get as () => unknown | Promise<unknown>)();
      return {
        value: typeof raw === "string" ? raw.trim() : "",
        shape: { type: typeof binding, async: true },
      };
    } catch {
      return { value: "", shape: { type: typeof binding, async: true } };
    }
  }

  return { value: "", shape: { type: binding === null ? "null" : typeof binding, async: false } };
}

/**
 * 取到真实密钥。key 只在 Worker 内部流转：
 * 客户端送来的 apikey / Authorization 在 proxy.ts 里被无条件丢弃后再由这里注入。
 */
export async function resolveKey(slot: KeySlot, env: Env): Promise<ResolvedKey> {
  const service = (await readSecretBinding(env.SUPABASE_SERVICE_ROLE_KEY)).value;
  const anon = (await readSecretBinding(env.SUPABASE_ANON_KEY)).value;

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
