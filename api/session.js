import { send } from "./_lib/http.js";
import { getSession } from "./_lib/auth.js";

export default function handler(req, res) {
  const session = getSession(req);
  send(res, 200, { authenticated: Boolean(session), user: session ? session.u : null });
}
