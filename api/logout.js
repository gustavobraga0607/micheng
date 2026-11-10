import { send, fail } from "./_lib/http.js";
import { clearSession } from "./_lib/auth.js";

export default function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "Method not allowed");
  clearSession(req, res);
  send(res, 200, { ok: true });
}
