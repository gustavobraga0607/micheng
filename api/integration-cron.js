// Run by the Vercel cron job (vercel.json, every minute): delivers the events
// that are due. When CRON_SECRET is set, Vercel sends it and nobody else can
// start a run; without it a run only sends what is already due, which is harmless.
import { send, fail } from "./_lib/http.js";
import { deliverPending, integrationEnabled } from "./_lib/integration.js";

export default async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== "Bearer " + secret) return fail(res, 401, "Unauthorized");
    if (!integrationEnabled()) return send(res, 200, { skipped: "disabled" });
    send(res, 200, await deliverPending({ budgetMs: 45000 }));
  } catch (e) {
    console.error("Integration cron", e);
    fail(res, 500, "Server error");
  }
}
