export const errorCodes = [
  'unauthorized',
  'forbidden',
  'not_found',
  'validation_error',
  'revision_conflict',
  'scope_violation',
  'locked_skill',
  'readonly_skill',
  'executor_unavailable',
  'rate_limited',
  'budget_exceeded',
  'idempotency_conflict',
  'lease_expired',
  'unknown_outcome',
  'internal_error',
] as const;
export type ErrorCode = (typeof errorCodes)[number];
export class CuratorError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CuratorError';
  }
  toJSON() {
    return { code: this.code, message: this.message };
  }
}
export function ensure(condition: unknown, code: ErrorCode, message: string): asserts condition {
  if (!condition) throw new CuratorError(code, message);
}
