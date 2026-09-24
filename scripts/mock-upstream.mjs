/**
 * 本地假上游：把收到的请求（方法、路径、全部请求头、body）原样 JSON 回显。
 *
 * 用途：在不消耗真实 Supabase 配额的前提下，验证 Worker 的行为——
 *   1. 是否把客户端的 apikey / Authorization / Cookie 丢掉；
 *   2. 是否按路径前缀注入了正确的 key；
 *   3. 路径与查询串是否原样透传；
 *   4. 缓存命中（配合响应的 cache-control）。
 *
 * 用法：
 *   node scripts/mock-upstream.mjs                # 监听 http://127.0.0.1:8801
 *   PORT=9000 node scripts/mock-upstream.mjs      # 换端口
 *
 * 然后让 Worker 指向它（.dev.vars）：
 *   SUPABASE_BASE_URL=http://127.0.0.1:8801
 *   SUPABASE_SERVICE_ROLE_KEY=service-key-value
 *   SUPABASE_ANON_KEY=anon-key-value
 */
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8801);
const host = process.env.HOST ?? "127.0.0.1";

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const payload = {
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
      body: Buffer.concat(chunks).toString("utf8"),
      received_at: new Date().toISOString(),
    };

    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60",
      "x-mock-upstream": "true",
    });
    res.end(JSON.stringify(payload, null, 2));
  });
});

server.listen(port, host, () => {
  console.log(`[mock-upstream] listening on http://${host}:${port}`);
});
