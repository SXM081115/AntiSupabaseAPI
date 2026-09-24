import type { Env } from "../src/types";

/** 一份「能用」的最小 env：project ref + 两把 key，其余走默认值。 */
export const TEST_ENV: Env = {
  SUPABASE_PROJECT_REF: "testref",
  SUPABASE_SERVICE_ROLE_KEY: "service-key-value",
  SUPABASE_ANON_KEY: "anon-key-value",
  ALLOWED_ORIGINS: "https://app.example.com",
  UPSTREAM_TIMEOUT_MS: "2000",
  MAX_RETRIES: "1",
  RETRY_BACKOFF_MS: "0",
  MAX_TOTAL_MS: "5000",
  CIRCUIT_FAIL_THRESHOLD: "5",
  CIRCUIT_OPEN_MS: "15000",
  CACHE_ENABLED: "false",
};

export function env(overrides: Partial<Env> = {}): Env {
  return { ...TEST_ENV, ...overrides };
}

export interface TestContext {
  ctx: ExecutionContext;
  drain: () => Promise<unknown[]>;
}

/** 伪造 ExecutionContext，waitUntil 的 Promise 收集起来以便断言前 await。 */
export function createTestContext(): TestContext {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: () => undefined,
    props: {},
  };
  return {
    ctx: ctx as unknown as ExecutionContext,
    drain: () => Promise.all(pending),
  };
}

export interface CapturedCall {
  url: string;
  init: RequestInit;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://proxy.test${path}`, init);
}
