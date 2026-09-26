import 'server-only';
import { createRuntime, readConfig, type Runtime } from '@devanalytics/runtime';

/**
 * Process-wide runtime.
 *
 * Next.js re-evaluates modules across requests in development, so the runtime
 * is cached on globalThis. Without this, every navigation would open a new
 * database and the embedded engine would leak connections.
 */
const KEY = Symbol.for('devanalytics.runtime');
type Global = typeof globalThis & { [KEY]?: Promise<Runtime> };

export function getRuntime(): Promise<Runtime> {
  const g = globalThis as Global;
  g[KEY] ??= createRuntime(readConfig());
  return g[KEY];
}
