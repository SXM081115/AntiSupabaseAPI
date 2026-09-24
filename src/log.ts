export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function parseLogLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  const v = (value ?? "").trim().toLowerCase();
  return v in RANK ? (v as LogLevel) : fallback;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/**
 * 单行 JSON 日志（Cloudflare Workers Logs / wrangler tail 都能直接按字段检索）。
 * 只打印自己拼的字符串，避免 runtime 对对象做不稳定序列化。
 */
export function createLogger(level: LogLevel, base: Record<string, unknown> = {}): Logger {
  const threshold = RANK[level];

  const emit = (lvl: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (RANK[lvl] < threshold) return;
    let line: string;
    try {
      line = JSON.stringify({ level: lvl, msg: message, ts: new Date().toISOString(), ...base, ...fields });
    } catch {
      line = JSON.stringify({ level: lvl, msg: message, ts: new Date().toISOString(), log_error: "unserializable_fields" });
    }
    if (lvl === "error") console.error(line);
    else if (lvl === "warn") console.warn(line);
    else console.log(line);
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger(level, { ...base, ...fields }),
  };
}
