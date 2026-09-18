/**
 * Shared browser-side fetch helpers for the dashboard editor apps.
 *
 * Every editor's `app.ts` talks to its own namespace through the same tiny
 * envelope contract: the server answers `{ ok: true, ... }` on success and
 * `{ ok: false, error }` on failure, so a rejected promise carries the
 * server's message straight into the toast. Each app used to carry its own
 * copy of these four wrappers; they live here now and are bundled in.
 *
 * `__API_BASE__` is compiled in per editor by `createEditorBundler`, so the
 * same module resolves to `/roles`, `/welcome`, … depending on which bundle
 * it ends up in.
 */
declare const __API_BASE__: string;

/** Namespace prefix every request is made relative to, e.g. `/roles`. */
export const API_BASE = typeof __API_BASE__ === 'string' ? __API_BASE__ : '';

async function request(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(API_BASE + url, init);
  const data = await response.json();
  // The full envelope rides along on `error.data` for callers that branch on
  // extra fields (e.g. antiraid's `needsConfirm`).
  if (!data.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data });
  return data;
}

function withJsonBody(method: string, body: any, signal?: AbortSignal): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal };
}

export function getJson(url: string): Promise<any> {
  return request(url);
}

export function postJson(url: string, body: any, signal?: AbortSignal): Promise<any> {
  return request(url, withJsonBody('POST', body, signal));
}

export function patchJson(url: string, body: any): Promise<any> {
  return request(url, withJsonBody('PATCH', body));
}

export function putJson(url: string, body: any): Promise<any> {
  return request(url, withJsonBody('PUT', body));
}

export function delJson(url: string): Promise<any> {
  return request(url, { method: 'DELETE' });
}
