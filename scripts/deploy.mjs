/**
 * 部署脚本：发代码 → 自证密钥可用。
 *
 * 背景（本仓库两次上线事故的根因，现已根治）：
 *   1) `wrangler secret put/bulk` 把密钥挂在 **script** 上，而 `wrangler deploy`
 *      以「版本」为单位重建绑定快照 —— 密钥绑定会随下一次部署消失。
 *      现象：`wrangler secret list` 里密钥都在，线上 `env` 却是空的 → 500 MISSING_CONFIG，
 *      且症状常常延后几分钟才出现（边缘仍有旧 isolate 在跑），极难排查。
 *   2) 改用 Cloudflare Secrets Store 绑定后，绑定本身写在 wrangler.jsonc 里，
 *      随每个版本快照走，任何部署方式都不会再丢。
 *   3) 但 Secrets Store 绑定在运行时**不是字符串**，而是带 `get()` 的对象；
 *      直接用 `env.X` 当字符串读会拿到空值 —— 源码由 readSecretBinding() 统一兼容两种形态。
 *
 * 因此本脚本只做两件事：先 deploy，再用 /__health 自证密钥真的读得到。
 * 密钥值的来源与更新走 Secrets Store（--sync-store 会用 .dev.vars 覆盖 store 里的值）。
 *
 * 用法：
 *   node scripts/deploy.mjs                  # 部署 + 自证
 *   node scripts/deploy.mjs --sync-store     # 先把 .dev.vars 的值同步进 Secrets Store，再部署自证
 *   node scripts/deploy.mjs --skip-verify    # 只发代码（离线/调试用）
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const STORE_ID = "c181d40ddfe2475da76cf25fe5c0905f";
const SECRET_KEYS = ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"];
const DEFAULT_HEALTH = "https://edge.sxm2027.icu/__health";

function parseArgs(argv) {
  const args = { vars: ".dev.vars", verify: true, syncStore: false, health: DEFAULT_HEALTH };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--vars") args.vars = argv[++i];
    else if (argv[i] === "--health") args.health = argv[++i];
    else if (argv[i] === "--skip-verify") args.verify = false;
    else if (argv[i] === "--sync-store") args.syncStore = true;
  }
  return args;
}

/** 解析 .dev.vars（KEY=VALUE，忽略注释与空行） */
function readVars(path) {
  if (!existsSync(path)) throw new Error(`找不到密钥文件 ${path}`);
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function run(args) {
  console.log(`\n$ npx ${args.join(" ")}`);
  execFileSync("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
}

const args = parseArgs(process.argv.slice(2));

// 0) 可选：把本机 .dev.vars 的值同步进 Secrets Store
if (args.syncStore) {
  const vars = readVars(args.vars);
  for (const key of SECRET_KEYS) {
    if (!vars[key]) {
      console.log(`跳过 ${key}（${args.vars} 里没有）`);
      continue;
    }
    run([
      "wrangler", "secrets-store", "secret", "update", STORE_ID,
      "--name", key, "--value", vars[key], "--remote",
    ]);
  }
}

// 1) 发代码
run(["wrangler", "deploy", "--keep-vars"]);

// 2) 自证：密钥必须真的能被运行时读到
if (!args.verify) process.exit(0);

async function verify(label) {
  const res = await fetch(args.health, { headers: { "cache-control": "no-cache" } });
  const body = await res.json().catch(() => ({}));
  const kb = body.key_binding ?? {};
  console.log(
    `[${label}] status=${res.status} has_service_role_key=${body.has_service_role_key} ` +
      `has_anon_key=${body.has_anon_key} service_binding=${kb.service?.type}/${kb.service?.async}/${kb.service?.length}`,
  );
  return res.status === 200 && body.has_service_role_key === true;
}

let healthy = false;
for (let attempt = 1; attempt <= 8 && !healthy; attempt += 1) {
  if (attempt > 1) await new Promise((r) => setTimeout(r, 6000));
  healthy = await verify(`自证 ${attempt}/8`);
}

if (!healthy) {
  console.error(
    "\n❌ 密钥未能被运行时读到：/__health 的 has_service_role_key 仍为 false。\n" +
      "   排查：1) wrangler.jsonc 里的 secrets_store_secrets 绑定是否在（binding 名必须与代码里 env.X 一致）；\n" +
      "        2) Secrets Store 里该 secret 的状态是否为 active；\n" +
      "        3) 是否还有同名的 script 级 secret（wrangler secret list）在干扰 —— 建议删掉，只留 store 一处来源。",
  );
  process.exit(1);
}
console.log("\n✅ 部署完成，密钥已被运行时正确读取");
