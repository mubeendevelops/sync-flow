export interface AppErrorOptions {
  status: number;
  title: string;
  detail?: string;
  /** RFC 7807 `type` URI. Defaults to "about:blank" (no dereferenceable docs page yet). */
  type?: string;
  /** Extra RFC 7807 extension members (e.g. field-level validation errors). */
  extensions?: Record<string, unknown>;
  cause?: unknown;
}

/** Typed error carrying everything needed to render an RFC 7807 problem+json response. */
export class AppError extends Error {
  readonly status: number;
  readonly title: string;
  readonly type: string;
  readonly detail?: string;
  readonly extensions?: Record<string, unknown>;

  constructor(options: AppErrorOptions) {
    super(options.detail ?? options.title);
    this.name = "AppError";
    this.status = options.status;
    this.title = options.title;
    this.type = options.type ?? "about:blank";
    this.detail = options.detail;
    this.extensions = options.extensions;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  static badRequest(detail?: string, extensions?: Record<string, unknown>): AppError {
    return new AppError({ status: 400, title: "Bad Request", detail, extensions });
  }

  static unauthorized(detail?: string): AppError {
    return new AppError({ status: 401, title: "Unauthorized", detail });
  }

  static forbidden(detail?: string): AppError {
    return new AppError({ status: 403, title: "Forbidden", detail });
  }

  static notFound(detail?: string): AppError {
    return new AppError({ status: 404, title: "Not Found", detail });
  }

  static conflict(detail?: string): AppError {
    return new AppError({ status: 409, title: "Conflict", detail });
  }

  static tooManyRequests(detail?: string): AppError {
    return new AppError({ status: 429, title: "Too Many Requests", detail });
  }

  static internal(detail?: string, cause?: unknown): AppError {
    return new AppError({ status: 500, title: "Internal Server Error", detail, cause });
  }
}
