/**
 * Turning an unknown thrown value into a line a human can read.
 *
 * Stoat REST failures surface in several shapes — an `Error`, a bare string, or
 * a plain object carrying `reason` / `message` / `type` — and three modules
 * carried the same ladder for unwrapping them.
 */

/** Best-effort human-readable message for any thrown value. */
export function getReadableError(error: any): string {
  if (!error) return 'unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const reason = error.reason || error.message || error.type || null;
    return reason ? String(reason) : JSON.stringify(error);
  }
  return String(error);
}
