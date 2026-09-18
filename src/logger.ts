/**
 * Tiny leveled logger. The codebase is full of best-effort `catch {}` blocks
 * that swallow failures silently — fine for resilience, terrible for
 * diagnosing why a feature "just doesn't work". `debug()` lets those spots emit
 * detail without spamming normal runs: output is gated behind the `DEBUG` env
 * var, while `warn`/`error`/`info` always print.
 *
 * DEBUG values:
 *   unset / "" / "0" / "false"  → debug output off
 *   "1" / "true" / "*" / "all"  → all debug scopes on
 *   "ticket,notify,stats"       → only those scopes on (comma/space separated)
 *
 * Scope match is case-insensitive and prefix-based, so DEBUG="notify" also
 * enables scope "notify:poll".
 */

export type DebugSpec = { all: boolean; scopes: string[] };

export function parseDebugSpec(raw: string | undefined): DebugSpec {
  const value = String(raw || '').trim().toLowerCase();
  if (!value || value === '0' || value === 'false' || value === 'off') {
    return { all: false, scopes: [] };
  }
  if (value === '1' || value === 'true' || value === '*' || value === 'all' || value === 'on') {
    return { all: true, scopes: [] };
  }
  return { all: false, scopes: value.split(/[,\s]+/).filter(Boolean) };
}

/** Pure scope-match check against a parsed spec (extracted for testing). */
export function scopeMatches(spec: DebugSpec, scope = ''): boolean {
  if (spec.all) return true;
  if (!spec.scopes.length) return false;
  const s = scope.toLowerCase();
  return spec.scopes.some((allowed) => s === allowed || s.startsWith(`${allowed}:`) || s.startsWith(allowed));
}

const spec = parseDebugSpec(process.env.DEBUG);

/** Whether debug output for `scope` is enabled by the current DEBUG setting. */
export function isDebugEnabled(scope = ''): boolean {
  return scopeMatches(spec, scope);
}

/**
 * Emit a debug line for `scope`, no-op unless DEBUG enables that scope. Accepts
 * a lazy `() => string` message so expensive formatting is skipped when off.
 */
export function debug(scope: string, message: unknown | (() => unknown), ...rest: unknown[]): void {
  if (!isDebugEnabled(scope)) return;
  const resolved = typeof message === 'function' ? (message as () => unknown)() : message;
  console.debug(`🐛 [${scope}]`, resolved, ...rest);
}

export function info(message: unknown, ...rest: unknown[]): void {
  console.log(message, ...rest);
}

export function warn(message: unknown, ...rest: unknown[]): void {
  console.warn(message, ...rest);
}

export function error(message: unknown, ...rest: unknown[]): void {
  console.error(message, ...rest);
}
