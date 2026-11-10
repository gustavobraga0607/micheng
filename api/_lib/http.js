// Small helpers shared by the API routes (Vercel Node functions).

export function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

export function fail(res, status, message) {
  send(res, status, { error: message });
}

// Vercel pre-parses JSON bodies into req.body; the local dev server does not.
export async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || "";
  header.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

export function queryParam(req, name) {
  return new URL(req.url, "http://localhost").searchParams.get(name);
}

// Mutating requests must be JSON: a cross-site HTML form cannot send that
// content type without a CORS preflight, which this API never grants.
export function isJsonRequest(req) {
  return String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json");
}
