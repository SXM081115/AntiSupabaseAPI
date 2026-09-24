# AntiSupabaseAPI

用 **Cloudflare Worker** 给 **Supabase Edge API** 做反向代理：客户端只访问你的 Worker 域名，
`apikey` / `Authorization` 由 Worker 在服务端注入，前端拿不到任何 Supabase 密钥。

已内置：路径白名单、密钥分级注入（service / anon 按前缀自动选）、CORS 白名单、超时+重试+熔断、
结构化日志与请求 ID 透传、GET 响应缓存、Location / Set-Cookie / JSON 主机名改写。

```
浏览器 / App
     │  https://<worker 域名>/functions/v1/hello      ← 不带任何密钥
     ▼
Cloudflare Worker（本仓库）
     │  ① 路径白名单校验  ② 按前缀选 service/anon key  ③ CORS / 缓存 / 熔断 / 日志
     ▼
https://<project-ref>.supabase.co/functions/v1/hello   ← 由 Worker 注入 apikey 与 Bearer
```

## 1. 先搞清两个名词

### 1.1 `SUPABASE_PROJECT_REF` 是什么

Supabase 项目的**唯一 ID**（20 位左右的字母数字，例如 `abcdefghijklmnop`）。两个地方能看到它：

- 控制台地址：`https://supabase.com/dashboard/project/<PROJECT_REF>`
- 默认 API 域名：`https://<PROJECT_REF>.supabase.co`

它**不是密钥**，是「项目门牌号」。Worker 用它拼出上游地址，所以它出现在 `wrangler.jsonc` 的 `vars` 里（公开配置项）。

> 拿法：Supabase 控制台 → 左上角项目名旁 → **Project Settings → General → Reference ID**。

### 1.2 「自定义域名」是什么（这里有**两层**，别混）

| 层 | 含义 | 例子 | 在本项目里填哪 |
| --- | --- | --- | --- |
| **A. Supabase 侧自定义域名** | Supabase 付费能力，把 API 挂到你自己域名（一般 Pro 才开放） | `https://api.yourdomain.com` 指向 Supabase | 填 `SUPABASE_BASE_URL`（此时不用 project ref） |
| **B. Worker 侧自定义域名** | 让 Cloudflare Worker 接管一个域名，作为**对外入口** | `https://edge.yourdomain.com` 指向 Worker | 改 `wrangler.jsonc` 的 `routes`，或直接用免费的 `*.workers.dev` |

**默认情况**：A 不需要（直接用 `https://<ref>.supabase.co`），B 也不需要（先跑 `*.workers.dev` 子域）。
等你确定要对外用自己域名时，再配置 B。**A 和 B 不能是同一个域名**，否则会自己代理自己形成环路。

推荐最终形态：Worker 用 `edge.yourdomain.com`，Supabase 保持 `<ref>.supabase.co`。

## 2. 快速开始

```bash
# 1) 安装依赖
pnpm install

# 2) 填 project ref（把 your-project-ref 换成真实值）
#    编辑 wrangler.jsonc → vars.SUPABASE_PROJECT_REF

# 3) 注入密钥（不会进 git，也不会出现在 wrangler.jsonc 里）
pnpm wrangler secret put SUPABASE_SERVICE_ROLE_KEY
pnpm wrangler secret put SUPABASE_ANON_KEY

# 4) 本地跑起来
pnpm run dev
#    另开一个终端验证：
curl -i http://127.0.0.1:8787/__health
curl -i http://127.0.0.1:8787/functions/v1/<你的函数名>

# 5) 自检 + 部署
pnpm run check          # typecheck + 40 个单测
pnpm run deploy         # → https://antisupabase-api.<你的子域>.workers.dev
```

本地调试时密钥也可以放 `.dev.vars`（复制 `.dev.vars.example`，该文件已被 `.gitignore` 忽略）。

## 3. 客户端怎么调

**浏览器 / 前端**——不需要任何 Supabase 密钥：

```js
const res = await fetch("https://antisupabase-api.<你的子域>.workers.dev/functions/v1/hello", {
  method: "POST",
  headers: { "content-type": "application/json" }, // 不要加 apikey / Authorization
  body: JSON.stringify({ name: "x" }),
});
const data = await res.json();
console.log(res.headers.get("x-request-id"), res.headers.get("x-proxy-cache"));
```

**supabase-js**——把 URL 指向 Worker，key 位置随便填一个非空字符串即可（Worker 会丢弃并替换它）：

```js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://antisupabase-api.<你的子域>.workers.dev",
  "not-a-real-key-worker-injects-its-own",
);
```

**curl**：

```bash
curl -i -X POST "https://antisupabase-api.<你的子域>.workers.dev/functions/v1/hello" \
  -H "content-type: application/json" -d '{"name":"x"}'
```

## 4. 路由与密钥分级

路径必须命中 `ALLOWED_PATH_PREFIXES`（默认三个），否则直接 **404 `ROUTE_NOT_ALLOWED`**，不打上游。

| 路径前缀 | 使用的 key | 改哪个变量 |
| --- | --- | --- |
| `/functions/v1/` | `service_role` | `SERVICE_KEY_PREFIXES` |
| `/auth/v1/admin/` | `service_role` | `SERVICE_KEY_PREFIXES` |
| `/auth/v1/` 其余 | `anon` | `ANON_KEY_PREFIXES` |
| `/storage/v1/` | `anon` | `ANON_KEY_PREFIXES` |
| 未匹配 | `DEFAULT_KEY_SLOT`（默认 anon） | `DEFAULT_KEY_SLOT` |

规则按**前缀最长者优先**匹配，所以 `/auth/v1/admin/` 一定压过 `/auth/v1/`。
`SUPABASE_ANON_KEY` 不填时会自动回落到 `service_role`。

> `/rest/v1`（PostgREST）**没有**开放——这是你选定时的选择。需要时把它加进 `ALLOWED_PATH_PREFIXES` 即可。

## 5. 环境变量总表

`wrangler.jsonc → vars` 放非敏感项；密钥一律用 `wrangler secret put`（线上）/ `.dev.vars`（本地）。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SUPABASE_PROJECT_REF` | `your-project-ref` | 上游 `<ref>.supabase.co` |
| `SUPABASE_BASE_URL` *(secret 可选)* | 空 | 完整上游 origin，优先于 ref |
| `SUPABASE_SERVICE_ROLE_KEY` 🔒 | — | 必填 |
| `SUPABASE_ANON_KEY` 🔒 | 空 | 不填则全部走 service key |
| `PROXY_TOKEN` 🔒 | 空 | 仅当 `ENFORCE_PROXY_TOKEN=true` 才生效 |
| `PROXY_PREFIX` | 空 | 对外路径前缀，如 `/sb` → `/sb/functions/v1/x` |
| `ALLOWED_PATH_PREFIXES` | `/functions/v1/,/auth/v1/,/storage/v1/` | 白名单 |
| `SERVICE_KEY_PREFIXES` | `/functions/v1/,/auth/v1/admin/` | service key 前缀 |
| `ANON_KEY_PREFIXES` | `/auth/v1/,/storage/v1/` | anon key 前缀 |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://localhost:5173` | CORS 白名单，`*` 表示全放行 |
| `CORS_ALLOW_HEADERS` / `CORS_ALLOW_METHODS` / `CORS_EXPOSE_HEADERS` / `CORS_MAX_AGE` / `CORS_ALLOW_CREDENTIALS` | 见配置 | 预检应答内容 |
| `UPSTREAM_TIMEOUT_MS` | `30000` | 单次上游请求超时 |
| `MAX_RETRIES` | `1` | 仅对**无 body 请求**重试 |
| `RETRY_BACKOFF_MS` | `250` | 退避基数（指数 + 抖动） |
| `MAX_TOTAL_MS` | `60000` | 含重试的总预算 |
| `RETRY_STATUSES` | `502,503,504` | 可重试状态码 |
| `RETRY_ON_429` / `RETRY_AFTER_MAX_MS` | `false` / `5000` | 是否重试限流，及 Retry-After 上限 |
| `CIRCUIT_FAIL_THRESHOLD` | `5` | 连续失败多少次开启熔断（按路径前缀分桶） |
| `CIRCUIT_OPEN_MS` | `15000` | 熔断保持时长，之后放行一个半开探针 |
| `CACHE_ENABLED` | `true` | 仅 GET |
| `CACHE_TTL_SECONDS` | `60` | 缓存 TTL |
| `CACHE_PATH_PREFIXES` | `/storage/v1/object/public/` | 只缓存这些前缀 |
| `CACHE_VARY_HEADERS` | `accept,accept-language` | 参与缓存键的头 |
| `REWRITE_LOCATION` | `true` | 把 3xx 的 Location 指回 Worker |
| `REWRITE_JSON_HOSTS` | `false` | 替换 JSON 响应体里的上游域名（magic link 场景） |
| `COOKIE_DOMAIN_STRIP` | `true` | 剥掉 Set-Cookie 的 Domain，变成 host-only |
| `STRIP_CLIENT_COOKIES` | `true` | 丢弃客户端 Cookie |
| `ENFORCE_PROXY_TOKEN` | `false` | 改成 `true` 并配 `PROXY_TOKEN` 即启用共享令牌门槛 |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `DEBUG_UPSTREAM_ERRORS` | `false` | 错误响应里是否附带内部细节 |

## 6. 本地用假上游自测（不消耗 Supabase 额度）

想验证「密钥真的被替换了」「Cookie 真的被丢了」，不用连真实 Supabase：

```bash
# 终端 A：起一个把请求原样回显的假上游（127.0.0.1:8801）
pnpm run mock:upstream

# 终端 B：建一个 .dev.vars（覆盖 wrangler.jsonc 的 vars，仅本地生效）
cat > .dev.vars <<'EOF'
SUPABASE_BASE_URL=http://127.0.0.1:8801
SUPABASE_SERVICE_ROLE_KEY=service-key-value
SUPABASE_ANON_KEY=anon-key-value
EOF

# 终端 C：跑起来
pnpm run dev

# 终端 D：打一发伪造身份的请求，看回显里 apikey 已被换掉、cookie 已消失
curl -s -X POST "http://127.0.0.1:8787/functions/v1/hello" \
  -H "content-type: application/json" \
  -H "authorization: Bearer forged" -H "apikey: forged" -H "cookie: sb=leak" \
  -d 'name=x'
```

回显里应当看到 `"apikey": "service-key-value"`，且**没有** `cookie` 字段。用完删掉 `.dev.vars` 即可。

## 7. 关于「完全开放 + 密钥全隐藏」这个组合

当前配置下，**任何拿到 Worker 域名的人都能以 `service_role` 身份调用你的 `/functions/v1/`**，
这等价于把你的 Supabase 管理权限挂在公网上。想收口时按代价从低到高选一个：

1. **共享令牌**（改 1 处 + 1 条 secret）：`ENFORCE_PROXY_TOKEN` 改 `"true"`，
   `pnpm wrangler secret put PROXY_TOKEN`，前端所有请求带上 `x-proxy-token: <值>`。
2. **收窄白名单**：删掉 `SERVICE_KEY_PREFIXES` 里的 `/auth/v1/admin/`，把 `ALLOWED_PATH_PREFIXES` 缩到只剩需要的函数前缀。
3. **Cloudflare Access**：在域名前面加一层 Zero Trust 策略，代码零改动。

## 8. 可观测

每次请求输出一行 JSON，直接可在 `pnpm run tail` / Workers Logs 里按字段过滤：

```json
{"level":"info","msg":"proxy","request_id":"…","method":"GET","path":"/functions/v1/hello",
 "status":200,"upstream_status":200,"duration_ms":12,"attempts":1,"key_slot":"service",
 "half_open":false,"cache":"MISS"}
```

`x-request-id` 会透传到上游并回写响应（客户端传了合法值就复用），端到端可串起来。
`x-proxy-cache: HIT | MISS | BYPASS` 直接反映缓存结果。

## 9. 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `BAD_PATH` | 路径含非法片段（`..` / 编码绕过 / 双斜杠） |
| 404 | `ROUTE_NOT_ALLOWED` | 不在路径白名单（含 `/rest/v1` 等未开放面） |
| 401 | `PROXY_TOKEN_REQUIRED` | 启用了令牌门槛但没带 `x-proxy-token` |
| 500 | `MISSING_CONFIG` | 缺 project ref 或密钥 |
| 502 | `UPSTREAM_ERROR` | 连不上上游 / 网络异常 |
| 503 | `CIRCUIT_OPEN` | 熔断开启（响应带 `retry-after`） |
| 504 | `UPSTREAM_TIMEOUT` | 上游超时 |

统一体：

```json
{ "error": { "code": "CIRCUIT_OPEN", "message": "…", "request_id": "…", "details": { "retry_after_ms": 12000 } } }
```

## 10. 故障排查

| 现象 | 排查 |
| --- | --- |
| `pnpm install` 只打印 `Already up to date` 且没有 `node_modules` | 上级目录（如 `C:\Users\<你>\`）有 `pnpm-workspace.yaml`，被当成了它的子目录。仓库根的 `pnpm-workspace.yaml` 已修好这点；若仍复现，用 `pnpm install --ignore-workspace`。 |
| 本地 `pnpm run dev` 报缺密钥 | `.dev.vars` 没建好，或名字拼错（大小写敏感）。 |
| 线上 500 `MISSING_CONFIG` | `wrangler secret put` 没执行，或 `SUPABASE_PROJECT_REF` 还是占位值 `your-project-ref`。 |
| 浏览器 CORS 报错 | `ALLOWED_ORIGINS` 没加你的前端来源（含端口与协议，`https://` 与 `http://` 视作不同来源）。 |
| 401/403 来自 Supabase 而不是 Worker | 该路径的 key 选错了：检查 `SERVICE_KEY_PREFIXES` / `ANON_KEY_PREFIXES`。 |
| 上传/下载大文件异常 | 确认没有给 `CACHE_PATH_PREFIXES` 加进非 public 的 storage 前缀，且未对带 `Range` 的请求启用缓存（代码已跳过 Range）。 |

## 11. CI/CD

`.github/workflows/deploy.yml`：push 到 `main` 时先 typecheck + 跑测试，再用 Wrangler 部署。
需要在 GitHub 仓库 Secrets 里配置：

| Secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 权限：Workers Scripts:Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID |
| `SUPABASE_SERVICE_ROLE_KEY` | 同步为 Worker secret |
| `SUPABASE_ANON_KEY` | 同步为 Worker secret（可选） |

## 12. 开发命令

```bash
pnpm run dev            # wrangler dev，本地 8787
pnpm run mock:upstream  # 本地假上游，127.0.0.1:8801
pnpm run typecheck      # tsc --noEmit
pnpm run test           # vitest，41 个用例
pnpm run check          # typecheck + test
pnpm run tail           # 实时日志
pnpm run deploy         # 部署
```
