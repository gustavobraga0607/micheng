import { send, fail, readJson, isJsonRequest } from "./_lib/http.js";
import { adminConfigured, checkCredentials, createSession } from "./_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "Method not allowed");
  if (!isJsonRequest(req)) return fail(res, 415, "Expected JSON");
  if (!adminConfigured()) return fail(res, 503, "Admin login is not configured (ADMIN_PASSWORD).");

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return fail(res, 400, "Invalid JSON");
  }

  if (!checkCredentials(body.user, body.password)) {
    // Slow down password guessing.
    await new Promise((r) => setTimeout(r, 800));
    return fail(res, 401, "Invalid user or password");
  }
  createSession(req, res, String(body.user).trim().toLowerCase());
  send(res, 200, { ok: true });
}
