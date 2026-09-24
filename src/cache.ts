import type { AppConfig } from "./config";
import { matchesPrefix } from "./config";
import { rebuildResponse } from "./http";

export interface CacheStore {
  match(key: string): Promise<Response | null>;
  put(key: string, response: Response): Promise<void>;
}

// ---------------------------------------------------------------------------
// 内存版存储：node 下跑单测 / 本地无 Cache API 时使用
// ---------------------------------------------------------------------------
const MEMORY = new Map<string, { expiresAt: number; response: Response }>();

export function __resetMemoryCache(): void {
  MEMORY.clear();
}

function maxAgeSeconds(response: Response, fallback: number): number {
  const cc = response.headers.get("cache-control") ?? "";
  const m = /max-age\s*=\s*(\d+)/i.exec(cc);
  if (m?.[1]) {
    const parsed = Number.parseInt(m[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

const memoryStore: CacheStore = {
  async match(key) {
    const hit = MEMORY.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      MEMORY.delete(key);
      return null;
    }
    return hit.response.clone();
  },
  async put(key, response) {
    const ttl = maxAgeSeconds(response, 60);
    const buffer = await response.clone().arrayBuffer();
    const headers = new Headers(response.headers);
    MEMORY.set(key, {
      expiresAt: Date.now() + ttl * 1000,
      response: new Response(buffer, { status: response.status, statusText: response.statusText, headers }),
    });
  },
};

// ---------------------------------------------------------------------------
// Workers Cache API 存储（生产路径，命中在边缘节点内，不消耗上游配额）
// ---------------------------------------------------------------------------
const cacheApiStore: CacheStore = {
  async match(key) {
    const hit = await caches.default.match(new Request(key));
    return hit ?? null;
  },
  async put(key, response) {
    await caches.default.put(new Request(key), response);
  },
};

function cacheApiAvailable(): boolean {
  const c = (globalThis as unknown as { caches?: { default?: { match?: unknown; put?: unknown } } }).caches;
  return Boolean(c && typeof c.default?.match === "function" && typeof c.default?.put === "function");
}

export function createCacheStore(): CacheStore {
  return cacheApiAvailable() ? cacheApiStore : memoryStore;
}

// ---------------------------------------------------------------------------
// 可缓存判定
// ---------------------------------------------------------------------------
export function isCacheableRequest(request: Request, path: string, cfg: AppConfig): boolean {
  if (!cfg.cacheEnabled || cfg.cacheTtlSeconds <= 0) return false;
  if (request.method !== "GET") return false;
  if (!cfg.cachePathPrefixes.some((prefix) => matchesPrefix(path, prefix))) return false;

  const cc = (request.headers.get("cache-control") ?? "").toLowerCase();
  if (cc.includes("no-store") || cc.includes("no-cache")) return false;

  // 携带身份信息一律不缓存，避免把 A 的响应喂给 B
  if (request.headers.has("authorization") || request.headers.has("apikey") || request.headers.has("cookie")) return false;
  if (request.headers.has("range")) return false; // Range 请求交给上游，避免部分内容被整体缓存

  return true;
}

export function isCacheableResponse(response: Response): boolean {
  if (response.status !== 200) return false;
  if (response.headers.has("set-cookie")) return false;

  const ct = (response.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("text/event-stream")) return false; // SSE / 流式响应不可缓存

  const cc = (response.headers.get("cache-control") ?? "").toLowerCase();
  if (cc.includes("no-store") || cc.includes("private")) return false;
  if ((response.headers.get("vary") ?? "").trim() === "*") return false;

  return true;
}

/**
 * 生成缓存副本：
 *  - 删掉 set-cookie / vary（vary 已经折进缓存键，留着会让 Cache API 二次变体匹配失败）
 *  - 去掉 access-control-*（CORS 头在出口按当前请求的 Origin 重新生成）
 */
export function makeCacheable(response: Response, ttlSeconds: number): Response {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.delete("vary");
  for (const key of [...headers.keys()]) {
    if (key.toLowerCase().startsWith("access-control-")) headers.delete(key);
  }
  headers.set("cache-control", `public, max-age=${ttlSeconds}`);
  return rebuildResponse(response, headers);
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 缓存键：路径 + 查询串 + 指定 Vary 头的取值一起哈希。
 * 用合成 URL 作为键，避免和真实请求 URL 混淆。
 */
export async function cacheKeyFor(request: Request, url: URL, path: string, cfg: AppConfig): Promise<string | null> {
  if (!isCacheableRequest(request, path, cfg)) return null;

  const varyPart = cfg.cacheVaryHeaders
    .map((h) => `${h}=${(request.headers.get(h) ?? "").trim().toLowerCase()}`)
    .join("&");
  const digest = await sha256Hex(`${request.method} ${path}?${url.searchParams.toString()}|${varyPart}`);
  return `https://cache.antisupabase.internal/v1/${digest}`;
}
