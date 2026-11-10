import { send, fail, readJson, isJsonRequest } from "./_lib/http.js";
import { adminConfigured, checkCredentials, createSession } from "./_lib/auth.js";
import { failedLogins, recordFailedLogin, clearFailedLogins } from "./_lib/store.js";

const MAX_FAILURES = 10; // per address, in 15 minutes

function clientAddress(req) {
  return String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
}

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

  const address = clientAddress(req);
  try {
    if ((await failedLogins(address)) >= MAX_FAILURES) return fail(res, 429, "Too many failed attempts. Try again later.");
    if (!checkCredentials(body.user, body.password)) {
      await recordFailedLogin(address);
      // Slow down password guessing.
      await new Promise((r) => setTimeout(r, 800));
      return fail(res, 401, "Invalid user or password");
    }
    await clearFailedLogins(address);
  } catch (e) {
    console.error(e);
    return fail(res, 500, "Server error");
  }
  createSession(req, res, String(body.user).trim().toLowerCase());
  send(res, 200, { ok: true });
}
