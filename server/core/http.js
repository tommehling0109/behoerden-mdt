export class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const bad = (m, d) => new HttpError(400, m, 'bad_request', d);
export const forbidden = (m = 'Dafür fehlt dir die Berechtigung.') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Nicht gefunden.') => new HttpError(404, m, 'not_found');
export const conflict = (m) => new HttpError(409, m, 'conflict');

export function createRouter() {
  const routes = [];
  const add = (method) => (path, opts, handler) => {
    if (typeof opts === 'function') [handler, opts] = [opts, {}];
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    routes.push({ method, re, keys, opts, handler });
  };
  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'),
    routes,
    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        return { route: r, params };
      }
      return { route: null, pathMatched };
    },
  };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function readJson(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Anfrage zu groß.', 'too_large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw bad('Ungültiges JSON.');
  }
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

// kleine Validierungshelfer
export const str = (v, name, { min = 0, max = 200, required = true } = {}) => {
  if (v == null || v === '') {
    if (required) throw bad(`${name} ist erforderlich.`);
    return '';
  }
  if (typeof v !== 'string') throw bad(`${name} ist ungültig.`);
  const s = v.trim();
  if (s.length < min) throw bad(`${name} muss mindestens ${min} Zeichen haben.`);
  if (s.length > max) throw bad(`${name} darf höchstens ${max} Zeichen haben.`);
  return s;
};
export const intList = (v, name) => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => !Number.isInteger(x))) throw bad(`${name} ist ungültig.`);
  return [...new Set(v)];
};
export const strList = (v, name) => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad(`${name} ist ungültig.`);
  return [...new Set(v)];
};
