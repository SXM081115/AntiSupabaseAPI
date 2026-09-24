import { describe, expect, it } from "vitest";
import { loadConfig, matchesPrefix, normalizePrefix, resolveUpstreamOrigin } from "../src/config";
import { buildUpstreamUrl, normalizeRequestPath } from "../src/proxy";
import { resolveKey, resolveKeySlot } from "../src/keys";
import { env } from "./helpers";

describe("配置解析", () => {
  it("从 project ref 拼出上游 origin", () => {
    expect(resolveUpstreamOrigin(env())).toBe("https://testref.supabase.co");
  });

  it("SUPABASE_BASE_URL 优先于 project ref", () => {
    expect(resolveUpstreamOrigin(env({ SUPABASE_BASE_URL: "https://api.example.com/some/path" }))).toBe(
      "https://api.example.com",
    );
  });

  it("缺少 project ref 时报 MISSING_CONFIG", () => {
    expect(() => resolveUpstreamOrigin({})).toThrowError(/SUPABASE_PROJECT_REF/);
  });

  it("前缀规范化补齐两侧斜杠", () => {
    expect(normalizePrefix("auth/v1")).toBe("/auth/v1/");
    expect(normalizePrefix("/storage/v1/")).toBe("/storage/v1/");
    expect(normalizePrefix("/")).toBe("/");
  });

  it("前缀匹配不会误伤同前缀兄弟路径", () => {
    expect(matchesPrefix("/auth/v1/token", "/auth/v1/")).toBe(true);
    expect(matchesPrefix("/auth/v1", "/auth/v1/")).toBe(true);
    expect(matchesPrefix("/auth/v1x/token", "/auth/v1/")).toBe(false);
  });
});

describe("密钥槽位路由（最长前缀优先）", () => {
  const cfg = loadConfig(env());

  it("edge functions 走 service key", () => {
    expect(resolveKeySlot("/functions/v1/hello", cfg)).toBe("service");
  });

  it("auth/v1/admin 压过 auth/v1，走 service key", () => {
    expect(resolveKeySlot("/auth/v1/admin/users", cfg)).toBe("service");
  });

  it("普通 auth 接口走 anon key", () => {
    expect(resolveKeySlot("/auth/v1/token", cfg)).toBe("anon");
  });

  it("storage 走 anon key", () => {
    expect(resolveKeySlot("/storage/v1/object/public/bucket/a.png", cfg)).toBe("anon");
  });

  it("anon key 缺省时自动回落到 service key", () => {
    const noAnon = loadConfig(env({ SUPABASE_ANON_KEY: undefined }));
    expect(resolveKey("anon", env({ SUPABASE_ANON_KEY: undefined })).key).toBe("service-key-value");
    expect(resolveKeySlot("/auth/v1/token", noAnon)).toBe("anon");
  });

  it("service key 缺失时返回 MISSING_CONFIG", () => {
    expect(() => resolveKey("service", env({ SUPABASE_SERVICE_ROLE_KEY: undefined }))).toThrowError(/SERVICE_ROLE/);
  });
});

describe("路径规范化", () => {
  const cfg = loadConfig(env());

  it("放行三个白名单前缀", () => {
    expect(normalizeRequestPath("/functions/v1/hello", cfg)).toBe("/functions/v1/hello");
    expect(normalizeRequestPath("/auth/v1/token", cfg)).toBe("/auth/v1/token");
    expect(normalizeRequestPath("/storage/v1/object/public/a.png", cfg)).toBe("/storage/v1/object/public/a.png");
  });

  it("未在白名单内的 /rest/v1 被拒（404）", () => {
    expect(() => normalizeRequestPath("/rest/v1/users", cfg)).toThrowError(/白名单/);
  });

  it("拒绝编码绕过与目录穿越", () => {
    expect(() => normalizeRequestPath("/functions/v1/..%2f..%2fadmin", cfg)).toThrowError();
    expect(() => normalizeRequestPath("/functions/v1/%2e%2e/admin", cfg)).toThrowError();
    expect(() => normalizeRequestPath("/functions/v1/a//b", cfg)).toThrowError();
  });

  it("PROXY_PREFIX 会被剥掉", () => {
    const prefixed = loadConfig(env({ PROXY_PREFIX: "/sb" }));
    expect(normalizeRequestPath("/sb/functions/v1/hello", prefixed)).toBe("/functions/v1/hello");
    expect(() => normalizeRequestPath("/functions/v1/hello", prefixed)).toThrowError(/前缀/);
  });

  it("上游 URL 拼接后 origin 不变（防 SSRF）", () => {
    const url = buildUpstreamUrl("/functions/v1/hello", "?a=1", cfg);
    expect(url.toString()).toBe("https://testref.supabase.co/functions/v1/hello?a=1");
  });
});
