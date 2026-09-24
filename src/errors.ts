/** 结构化错误码。全部以 JSON 返回给客户端，便于前端统一处理。 */
export type ErrorCode =
  | "BAD_REQUEST"
  | "BAD_PATH"
  | "ROUTE_NOT_ALLOWED"
  | "PROXY_TOKEN_REQUIRED"
  | "MISSING_CONFIG"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_ERROR"
  | "CIRCUIT_OPEN"
  | "INTERNAL";

export interface ErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
    request_id: string;
    details?: Record<string, unknown>;
  };
}

/** 代理层自己抛出的错误：带 HTTP 状态码与机器可读 code。 */
export class ProxyError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ProxyError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function errorPayload(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): ErrorPayload {
  const payload: ErrorPayload = { error: { code, message, request_id: requestId } };
  if (details && Object.keys(details).length > 0) {
    payload.error.details = details;
  }
  return payload;
}

/** 把任意异常收敛成 ProxyError（未识别的异常一律 500 INTERNAL）。 */
export function asProxyError(err: unknown): ProxyError {
  if (err instanceof ProxyError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ProxyError("INTERNAL", 500, message || "内部错误");
}
