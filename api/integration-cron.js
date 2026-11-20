// Run by the Vercel cron job (vercel.json, every minute): queues catalog and
// receivable changes not sent yet, then delivers the events that are due.
// When CRON_SECRET is set, Vercel sends it and nobody else can start a run;
// without it a run only sends what changed or is due, which is harmless.
import { send, fail } from "./_lib/http.js";
import { deliverPending, integrationEnabled } from "./_lib/integration.js";
import { syncShared } from "./_lib/integration-sync.js";

export default async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== "Bearer " + secret) return fail(res, 401, "Unauthorized");
    if (!integrationEnabled()) return send(res, 200, { skipped: "disabled" });
    const sync = await syncShared();
    send(res, 200, { sync, ...(await deliverPending({ budgetMs: 40000 })) });
  } catch (e) {
    console.error("Integration cron", e);
    fail(res, 500, "Server error");
  }
}
