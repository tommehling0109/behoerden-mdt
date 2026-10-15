export class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const listeners = new Set();
/** Wird bei 401 (Sitzung abgelaufen) ausgelöst. */
export const onUnauthenticated = (fn) => listeners.add(fn);

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mdt' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'Keine Verbindung zum Server.', 'network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && (data.code === 'unauthenticated' || data.code === 'unauthenticated_partner')) listeners.forEach((f) => f(data.code));
    throw new ApiError(res.status, data.error || 'Unbekannter Fehler.', data.code);
  }
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
  put: (u, b = {}) => request('PUT', u, b),
  patch: (u, b = {}) => request('PATCH', u, b),
  del: (u) => request('DELETE', u),
};
