// Download of a document Micheng shared with Soulglobal, through the signed,
// short-lived link sent in the "document.shared" event (no login).
import { fail, queryParam } from "./_lib/http.js";
import { getPrivate, getFinance, readSecretFile } from "./_lib/store.js";
import { isSharedReceivable } from "./_lib/integration-sync.js";
import { verifyFileLink } from "./_lib/integration.js";

async function receiptFile(fileId) {
  for (const e of (await getFinance()).entries) {
    if (!isSharedReceivable(e)) continue;
    const f = (e.attachments || []).find((a) => a.id === fileId);
    if (f) return { name: f.name, contentType: f.type, ref: f.ref };
  }
  return null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "Method not allowed");
    const id = queryParam(req, "id");
    if (!verifyFileLink(id, queryParam(req, "exp"), queryParam(req, "sig"))) return fail(res, 403, "Invalid or expired link");
    // "fin:<id>": a payment receipt of a shared receivable; otherwise a shared document.
    const doc = id.startsWith("fin:") ? await receiptFile(id.slice(4))
      : ((await getPrivate()).integrationDocs || []).find((d) => d.id === id && d.direction === "out");
    if (!doc) return fail(res, 404, "File not found");
    const buffer = await readSecretFile(doc.ref);
    res.statusCode = 200;
    res.setHeader("Content-Type", doc.contentType);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(doc.name));
    if (doc.sha256) res.setHeader("X-Content-SHA256", doc.sha256);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(req.method === "HEAD" ? undefined : buffer);
  } catch (e) {
    console.error(e);
    fail(res, 500, "Server error");
  }
}
