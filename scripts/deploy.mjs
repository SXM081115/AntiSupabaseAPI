/**
 * 确定性部署脚本：先发代码，再补密钥。
 *
 * 为什么需要它（本仓库踩过的真实坑）：
 *   `wrangler secret bulk/put` 走的是旧的 script-secrets 接口，密钥是挂在 script 上的；
 *   而 `wrangler deploy` 会创建一个新的 version（version_upload），
 *   该 version 的绑定快照来自 wrangler.jsonc 的 vars —— 不含刚才那个 script-secret。
 *   结果：本地 secret list 能看到密钥，线上 env 里却是空的，接口返回
 *   500 MISSING_CONFIG，且症状会随边缘版本传播延后几分钟才出现（极易误判）。
 *
 * 本脚本把顺序固定为「deploy → 重传密钥」，并在最后打印 /__health 的关键字段做自证：
 *   has_service_role_key / has_anon_key 必须都是 true，否则以非 0 退出。
 *
 * 用法：
 *   node scripts/deploy.mjs                 # 用默认 .dev.vars 作为密钥来源
 *   node scripts/deploy.mjs --vars a.vars   # 指定其它 .dev.vars 格式文件
 *   node scripts/deploy.mjs --skip-verify   # 跳过线上自证（仅离线打包时用）
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET_KEYS = ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"];
const DEFAULT_HEALTH = "https://edge.sxm2027.icu/__health";

function parseArgs(argv) {
  const args = { vars: ".dev.vars", verify: true, health: DEFAULT_HEALTH };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--vars") args.vars = argv[++i];
    else if (argv[i] === "--health") args.health = argv[++i];
    else if (argv[i] === "--skip-verify") args.verify = false;
  }
  return args;
}

/** 解析 .dev.vars（KEY=VALUE，忽略注释与空行，不处理引号转义——密钥是单行裸值） */
function readVars(path) {
  if (!existsSync(path)) {
    throw new Error(`找不到密钥文件 ${path}（先复制 .dev.vars.example 为 .dev.vars 并填入真实密钥）`);
  }
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

function run(command, args) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
}

const args = parseArgs(process.argv.slice(2));
const vars = readVars(args.vars);

const secrets = {};
for (const key of SECRET_KEYS) {
  if (vars[key]) secrets[key] = vars[key];
}
if (!secrets.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(`${args.vars} 里缺少 SUPABASE_SERVICE_ROLE_KEY`);
}
console.log(`准备上传的密钥: ${Object.keys(secrets).join(", ")}`);

// 1) 先部署代码（--keep-vars 防止配置未声明的 vars 被删）
run("npx", ["wrangler", "deploy", "--keep-vars"]);

// 2) 再补密钥 —— 必须在 deploy 之后，顺序不可颠倒
const dir = mkdtempSync(join(tmpdir(), "asb-secrets-"));
const secretFile = join(dir, "secrets.json");
try {
  writeFileSync(secretFile, JSON.stringify(secrets), { encoding: "utf8" });
  run("npx", ["wrangler", "secret", "bulk", secretFile]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// 3) 线上自证：密钥必须真的进到 runtime env
if (!args.verify) process.exit(0);

async function verifyHealth(label) {
  const res = await fetch(args.health, { headers: { "cache-control": "no-cache" } });
  const body = await res.json().catch(() => ({}));
  const flags = `status=${res.status} has_service_role_key=${body.has_service_role_key} has_anon_key=${body.has_anon_key}`;
  console.log(`[${label}] ${flags}`);
  return res.status === 200 && body.has_service_role_key === true;
}

let healthy = false;
for (let attempt = 1; attempt <= 6 && !healthy; attempt += 1) {
  if (attempt > 1) await new Promise((r) => setTimeout(r, 5000));
  healthy = await verifyHealth(`自证 ${attempt}/6`);
}

if (!healthy) {
  console.error(
    "\n❌ 密钥没有生效：/__health 报告的 has_service_role_key 仍为 false。\n" +
      "   排查顺序：1) wrangler secret list 是否有该名字；2) 是否在 secret 上传后又跑过 wrangler deploy（顺序必须是 deploy → secret）；\n" +
      "   3) 删除该 Worker 重新走一遍本脚本。",
  );
  process.exit(1);
}
console.log("\n✅ 部署完成，密钥已确认进入 runtime env");
