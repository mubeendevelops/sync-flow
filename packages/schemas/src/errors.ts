import { z } from "zod";

/**
 * apps/server renders every error as RFC 7807 application/problem+json
 * (see apps/server/src/middleware/error-handler.ts). This is the wire shape both sides agree on.
 */
export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  /** Present on 400s from validate() middleware — a zod treeifyError tree, shape not pinned. */
  errors: z.unknown().optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

/** Thrown by the API client for any non-2xx response. Carries the parsed problem+json body. */
export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly type: string;
  readonly detail?: string;
  readonly fieldErrors?: unknown;

  constructor(problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = "ApiError";
    this.status = problem.status;
    this.title = problem.title;
    this.type = problem.type;
    this.detail = problem.detail;
    this.fieldErrors = problem.errors;
  }
}

/**
 * Best-effort normalization for a failed response: parse it as problem+json, falling back to a
 * generic problem if the body isn't shaped as expected (e.g. an upstream proxy error page).
 */
export async function normalizeErrorResponse(response: Response): Promise<ApiError> {
  try {
    const body: unknown = await response.json();
    const result = problemDetailsSchema.safeParse(body);
    if (result.success) {
      return new ApiError(result.data);
    }
  } catch {
    // response body wasn't JSON at all — fall through to the generic problem below
  }
  return new ApiError({
    type: "about:blank",
    title: response.statusText || "Request Failed",
    status: response.status,
  });
}
