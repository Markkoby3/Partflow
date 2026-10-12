export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what: string, id: string) =>
  new AppError(404, "not_found", `${what} ${id} not found`, { id });

export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(409, code, message, details);

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new AppError(400, "bad_request", message, details);

/** Postgres unique_violation, optionally on a specific constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === "23505" && (constraint === undefined || e.constraint === constraint);
}
