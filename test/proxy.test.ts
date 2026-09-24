import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { __resetMemoryCache } from "../src/cache";
import { __resetCircuitBreakers } from "../src/resilience";
import { createTestContext, env, jsonResponse, request, type CapturedCall } from "./helpers";

/** 装上 fetch 假实现，返回所有被捕获的上游调用。 */
function stubFetch(handler: (call: CapturedCall, index: number) => Response | Promise<Response>) {
  const calls: CapturedCall[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: CapturedCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  vi.stubGlobal("fetch", mock);
  return { calls, mock };
}

function headersOf(call: CapturedCall): Headers {
  return new Headers(call.init.headers as HeadersInit);
}

beforeEach(() => {
  __resetMemoryCache();
  __resetCircuitBreakers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("密钥全隐藏：注入 + 丢弃客户端身份", () => {
  it("edge function 请求被注入 service key，客户端伪造的头被丢弃", async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));
    const { ctx } = createTestContext();

    const response = await worker.fetch(
      request("/functions/v1/hello", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer client-forged-token",
          apikey: "client-forged-anon",
          cookie: "sb-session=leak-me",
          "cf-connecting-ip": "203.0.113.9",
        },
        body: JSON.stringify({ name: "x" }),
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);

    const h = headersOf(calls[0]);
    expect(calls[0].url).toBe("https://testref.supabase.co/functions/v1/hello");
    expect(h.get("apikey")).toBe("service-key-value");
    expect(h.get("authorization")).toBe("Bearer service-key-value");
    expect(h.get("cookie")).toBeNull();
    expect(h.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(h.get("x-request-id")).toBeTruthy();
    expect(h.get("content-type")).toBe("application/json");
  });

  it("auth token 接口使用 anon key", async () => {
    const { calls } = stubFetch(() => jsonResponse({ access_token: "t" }));
    const { ctx } = createTestContext();

    await worker.fetch(request("/auth/v1/token?grant_type=password", { method: "POST", body: "{}" }), env(), ctx);

    expect(headersOf(calls[0]).get("apikey")).toBe("anon-key-value");
  });

  it("auth admin 接口使用 service key", async () => {
    const { calls } = stubFetch(() => jsonResponse({ users: [] }));
    const { ctx } = createTestContext();

    await worker.fetch(request("/auth/v1/admin/users", { method: "GET" }), env(), ctx);

    expect(headersOf(calls[0]).get("apikey")).toBe("service-key-value");
  });

  it("请求方法与查询串完整透传", async () => {
    const { calls } = stubFetch(() => jsonResponse({}));
    const { ctx } = createTestContext();

    await worker.fetch(request("/storage/v1/object/list/bucket?limit=10&prefix=a", { method: "GET" }), env(), ctx);

    expect(calls[0].url).toBe("https://testref.supabase.co/storage/v1/object/list/bucket?limit=10&prefix=a");
    expect(calls[0].init.method).toBe("GET");
  });
});

describe("路由与 CORS", () => {
  it("白名单外的 /rest/v1 直接 404，不触碰上游", async () => {
    const { calls } = stubFetch(() => jsonResponse({}));
    const { ctx } = createTestContext();

    const response = await worker.fetch(request("/rest/v1/users", { method: "GET" }), env(), ctx);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("ROUTE_NOT_ALLOWED");
    expect(calls).toHaveLength(0);
  });

  it("OPTIONS 预检本地应答并回显白名单 Origin", async () => {
    const { calls } = stubFetch(() => jsonResponse({}));
    const { ctx } = createTestContext();

    const response = await worker.fetch(
      request("/functions/v1/hello", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,x-custom",
        },
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type,x-custom");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(calls).toHaveLength(0);
  });

  it("非白名单 Origin 不回显 allow-origin，但仍然转发请求", async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));
    const { ctx } = createTestContext();

    const response = await worker.fetch(
      request("/functions/v1/hello", { method: "GET", headers: { origin: "https://evil.example.com" } }),
      env(),
      ctx,
    );

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("ALLOWED_ORIGINS=* 时放行所有来源", async () => {
    const { ctx } = createTestContext();
    const response = await worker.fetch(
      request("/functions/v1/hello", { method: "GET", headers: { origin: "https://any.example.com" } }),
      env({ ALLOWED_ORIGINS: "*" }),
      ctx,
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("健康检查不触碰上游", async () => {
    const { calls } = stubFetch(() => jsonResponse({}));
    const { ctx } = createTestContext();

    const response = await worker.fetch(request("/__health", { method: "GET" }), env(), ctx);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("x-request-id 透传，响应里带同一个 id", async () => {
    stubFetch(() => jsonResponse({}));
    const { ctx } = createTestContext();

    const response = await worker.fetch(
      request("/functions/v1/hello", { method: "GET", headers: { "x-request-id": "trace-0001-abcd" } }),
      env(),
      ctx,
    );

    expect(response.headers.get("x-request-id")).toBe("trace-0001-abcd");
  });
});

describe("超时 / 重试 / 熔断", () => {
  it("GET 遇到 503 会重试一次并返回最终 200", async () => {
    const { calls } = stubFetch((_call, index) =>
      index === 0 ? new Response("upstream down", { status: 503 }) : jsonResponse({ ok: true }),
    );
    const { ctx } = createTestContext();

    const response = await worker.fetch(request("/functions/v1/hello", { method: "GET" }), env(), ctx);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("带 body 的 POST 绝不重试（避免重复执行）", async () => {
    const { calls } = stubFetch(() => new Response("boom", { status: 503 }));
    const { ctx } = createTestContext();

    const response = await worker.fetch(
      request("/functions/v1/charge", { method: "POST", body: JSON.stringify({ amount: 1 }) }),
      env(),
      ctx,
    );

    expect(response.status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it("上游连续 5xx 触发熔断，后续请求直接 503 且不再打上游", async () => {
    const { calls } = stubFetch(() => new Response("down", { status: 502 }));
    const { ctx } = createTestContext();
    const e = env({ MAX_RETRIES: "0", CIRCUIT_FAIL_THRESHOLD: "2", CIRCUIT_OPEN_MS: "60000" });

    const first = await worker.fetch(request("/functions/v1/hello", { method: "GET" }), e, ctx);
    const second = await worker.fetch(request("/functions/v1/hello", { method: "GET" }), e, ctx);
    const third = await worker.fetch(request("/functions/v1/hello", { method: "GET" }), e, ctx);
    const body = await third.json();

    expect(first.status).toBe(502);
    expect(second.status).toBe(502);
    expect(third.status).toBe(503);
    expect(body.error.code).toBe("CIRCUIT_OPEN");
    expect(third.headers.get("retry-after")).toBeTruthy();
    expect(calls).toHaveLength(2);
  });

  it("上游超时返回 504 UPSTREAM_TIMEOUT", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("upstream timeout after 2000ms", "TimeoutError");
      }),
    );
    const { ctx } = createTestContext();

    const response = await worker.fetch(
      request("/functions/v1/slow", { method: "GET" }),
      env({ MAX_RETRIES: "0" }),
      ctx,
    );
    const body = await response.json();

    expect(response.status).toBe(504);
    expect(body.error.code).toBe("UPSTREAM_TIMEOUT");
  });

  it("上游网络异常返回 502 UPSTREAM_ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { ctx } = createTestContext();

    const response = await worker.fetch(request("/functions/v1/net", { method: "GET" }), env({ MAX_RETRIES: "0" }), ctx);

    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("UPSTREAM_ERROR");
  });
});

describe("缓存", () => {
  const cacheEnv = env({
    CACHE_ENABLED: "true",
    CACHE_TTL_SECONDS: "60",
    CACHE_PATH_PREFIXES: "/storage/v1/object/public/",
  });

  it("第二次 GET 命中缓存，上游只被调用一次", async () => {
    const { calls } = stubFetch(() =>
      jsonResponse({ url: "https://testref.supabase.co/storage/v1/object/public/b/a.json" }, 200, {
        "cache-control": "public, max-age=60",
      }),
    );
    const first = createTestContext();
    const second = createTestContext();

    const r1 = await worker.fetch(request("/storage/v1/object/public/b/a.json", { method: "GET" }), cacheEnv, first.ctx);
    await first.drain();
    const r2 = await worker.fetch(request("/storage/v1/object/public/b/a.json", { method: "GET" }), cacheEnv, second.ctx);
    await second.drain();

    expect(r1.headers.get("x-proxy-cache")).toBe("MISS");
    expect(r2.headers.get("x-proxy-cache")).toBe("HIT");
    expect(calls).toHaveLength(1);
  });

  it("带 set-cookie 的响应不缓存", async () => {
    const { calls } = stubFetch(
      () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "set-cookie": "a=b" } }),
    );
    const first = createTestContext();
    const second = createTestContext();

    await worker.fetch(request("/storage/v1/object/public/b/a.json", { method: "GET" }), cacheEnv, first.ctx);
    await first.drain();
    await worker.fetch(request("/storage/v1/object/public/b/a.json", { method: "GET" }), cacheEnv, second.ctx);
    await second.drain();

    expect(calls).toHaveLength(2);
  });

  it("不在缓存前缀内的路径不参与缓存", async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));
    const { ctx } = createTestContext();

    const response = await worker.fetch(request("/functions/v1/hello", { method: "GET" }), cacheEnv, ctx);

    expect(response.headers.get("x-proxy-cache")).toBe("BYPASS");
    expect(calls).toHaveLength(1);
  });
});

describe("出口改写", () => {
  it("Location 指向上游时被改写成 Worker 自己的域名", async () => {
    stubFetch(() => new Response(null, { status: 302, headers: { location: "https://testref.supabase.co/auth/v1/verify?token=abc" } }));
    const { ctx } = createTestContext();

    const response = await worker.fetch(request("/auth/v1/verify?token=abc", { method: "GET" }), env(), ctx);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://proxy.test/auth/v1/verify?token=abc");
  });

  it("Set-Cookie 的 Domain 属性被剥掉", async () => {
    stubFetch(() => new Response("{}", { status: 200, headers: { "set-cookie": "sb-token=abc; Domain=testref.supabase.co; Path=/; HttpOnly" } }));
    const { ctx } = createTestContext();

    const response = await worker.fetch(request("/auth/v1/token", { method: "POST", body: "{}" }), env(), ctx);
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(cookie).toContain("sb-token=abc");
    expect(cookie.toLowerCase()).not.toContain("domain=");
  });

  it("REWRITE_JSON_HOSTS=true 时响应 JSON 里的上游域名被替换", async () => {
    stubFetch(() => jsonResponse({ action_link: "https://testref.supabase.co/auth/v1/verify?token=xyz" }));
    const { ctx } = createTestContext();

    const response = await worker.fetch(
      request("/functions/v1/invite", { method: "GET" }),
      env({ REWRITE_JSON_HOSTS: "true" }),
      ctx,
    );
    const body = await response.json();

    expect(body.action_link).toBe("http://proxy.test/auth/v1/verify?token=xyz");
  });
});

describe("可选令牌门槛", () => {
  const gated = env({ ENFORCE_PROXY_TOKEN: "true", PROXY_TOKEN: "s3cr3t-token" });

  it("缺少令牌返回 401", async () => {
    const { calls } = stubFetch(() => jsonResponse({}));
    const { ctx } = createTestContext();

    const response = await worker.fetch(request("/functions/v1/hello", { method: "GET" }), gated, ctx);

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("携带正确令牌放行，且令牌不会转发给上游", async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));
    const { ctx } = createTestContext();

    const response = await worker.fetch(
      request("/functions/v1/hello", { method: "GET", headers: { "x-proxy-token": "s3cr3t-token" } }),
      gated,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(headersOf(calls[0]).get("x-proxy-token")).toBeNull();
  });
});

describe("缺配置时不崩", () => {
  it("没有 project ref 时返回 500 MISSING_CONFIG", async () => {
    const { ctx } = createTestContext();
    const response = await worker.fetch(request("/functions/v1/hello", { method: "GET" }), {}, ctx);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("MISSING_CONFIG");
  });

  it("配置缺失时健康检查仍可访问，返回 503 并说明原因", async () => {
    const { ctx } = createTestContext();
    const response = await worker.fetch(request("/__health", { method: "GET" }), {}, ctx);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.config_ok).toBe(false);
    expect(body.config_error).toContain("SUPABASE_PROJECT_REF");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });
});
