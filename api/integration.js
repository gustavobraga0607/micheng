// Integration with Soulglobal, admin side: status and log of the events,
// connection test, retries, and documents shared with Soulglobal.
import crypto from "node:crypto";
import { send, fail, readJson, queryParam, isJsonRequest } from "./_lib/http.js";
import { getSession } from "./_lib/auth.js";
import {
  getPrivate, savePrivateWithEvents, withDataLock, BusyError, saveSecretFile, readSecretFile, deleteSecretFile,
  recentEvents, getEvent, updateEvent, readInboundLog, syncState, resetSynced,
} from "./_lib/store.js";
import { syncShared } from "./_lib/integration-sync.js";
import {
  integrationEnabled, integrationStatus, deliverPending, deliverSoon, retryEvent, queuePing, newEvent,
  documentOut, validDocument, cleanFileName, DOCUMENT_TYPES,
} from "./_lib/integration.js";

const MAX_FILE_BYTES = 3 * 1024 * 1024; // the request (base64) must stay under Vercel's 4.5 MB

// An event as the panel lists it (the order number or document name, not the whole data).
function eventOut(e) {
  const d = e.data || {};
  return {
    id: e.id, type: e.type, subject: e.subject, seq: e.seq, status: e.status, attempts: e.attempts,
    lastError: e.lastError, createdAt: e.createdAt, deliveredAt: e.deliveredAt, nextAt: e.nextAt || null,
    label: (d.order && d.order.number) || (d.document && d.document.name) ||
      (d.product && [d.product.sku, d.product.name && (d.product.name.pt || d.product.name.en)].filter(Boolean).join(" · ")) ||
      (d.receivable && [d.receivable.proformaNumber, d.receivable.description].filter(Boolean).join(" · ")) || null,
    proformaId: (d.order && d.order.id) || (d.document && d.document.proformaId) || null,
  };
}

function sendFile(res, doc, buffer, download) {
  res.statusCode = 200;
  res.setHeader("Content-Type", doc.contentType);
  res.setHeader("Content-Length", buffer.length);
  res.setHeader("Content-Disposition", (download ? "attachment" : "inline") + "; filename*=UTF-8''" + encodeURIComponent(doc.name));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(buffer);
}

export async function statusOut() {
  const priv = await getPrivate();
  const [events, inbound] = await Promise.all([recentEvents(150), readInboundLog(100)]);
  const counts = { pending: 0, failed: 0, delivered: 0 };
  for (const e of events) counts[e.status] = (counts[e.status] || 0) + 1;
  const sync = await syncState();
  return {
    ...integrationStatus(),
    lastSync: sync.lastSync || null,
    syncPending: Boolean(sync.dirty),
    counts,
    events: events.map(eventOut),
    inbound,
    documents: (priv.integrationDocs || []).slice().sort((a, b) => String(b.at).localeCompare(String(a.at))).map(documentOut),
    documentTypes: DOCUMENT_TYPES,
  };
}

// Shares a file with Soulglobal: stored encrypted, then announced by a
// "document.shared" event that carries a signed download link.
async function shareDocument(body, session) {
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ""));
  if (!m) return { status: 400, error: "Unsupported file" };
  const buffer = Buffer.from(m[2], "base64");
  if (buffer.length > MAX_FILE_BYTES) return { status: 400, error: "File too large" };
  if (!validDocument(m[1], buffer)) return { status: 400, error: "Unsupported file" };
  const type = DOCUMENT_TYPES.includes(body.type) ? body.type : "OTHER";
  const key = body.key ? String(body.key).slice(0, 200) : null;
  const ref = await saveSecretFile(buffer);
  try {
    return await withDataLock(async () => {
      const priv = await getPrivate();
      const pf = body.proformaId ? priv.proformas.find((p) => p.id === body.proformaId) : null;
      if (body.proformaId && !pf) return { status: 404, error: "Proforma not found" };
      const docs = (priv.integrationDocs = priv.integrationDocs || []);
      const doc = {
        id: crypto.randomUUID(), direction: "out", type, name: cleanFileName(body.name), contentType: m[1], size: buffer.length,
        sha256: crypto.createHash("sha256").update(buffer).digest("hex"), ref,
        proformaId: pf ? pf.id : null, proformaNumber: pf ? pf.number : null,
        key, version: 1, note: body.note ? String(body.note).slice(0, 500) : null, at: new Date().toISOString(), by: session.u,
      };
      // A new version of the same document (same key) replaces the previous one.
      const previous = key && docs.find((d) => d.direction === "out" && d.key === key && !d.supersededBy);
      if (previous) { doc.version = (previous.version || 1) + 1; previous.supersededBy = doc.id; }
      docs.push(doc);
      const event = newEvent("document.shared", pf ? "proforma:" + pf.id : "document:" + doc.id, {
        document: { ...documentOut(doc), replaces: previous ? previous.id : null },
        order: pf ? { id: pf.id, number: pf.number, soulglobal: pf.soulglobal ? { id: pf.soulglobal.id || null } : null } : null,
      });
      if (!event) return { status: 409, error: "Integration disabled" };
      await savePrivateWithEvents(priv, [event]);
      return { status: 201, document: documentOut(doc), event: eventOut(event) };
    });
  } catch (e) {
    await deleteSecretFile(ref); // nothing points to it
    throw e;
  } finally {
    deliverSoon();
  }
}

export default async function handler(req, res) {
  try {
    const session = getSession(req);
    if (!session) return fail(res, 401, "Login required");

    if (req.method === "GET") {
      const fileId = queryParam(req, "file");
      if (fileId) {
        const doc = ((await getPrivate()).integrationDocs || []).find((d) => d.id === fileId);
        if (!doc) return fail(res, 404, "File not found");
        return sendFile(res, doc, await readSecretFile(doc.ref), queryParam(req, "download"));
      }
      return send(res, 200, await statusOut());
    }

    if (req.method !== "POST") return fail(res, 405, "Method not allowed");
    if (!isJsonRequest(req)) return fail(res, 415, "Expected JSON");
    const body = await readJson(req);
    const action = queryParam(req, "action");
    if (!integrationEnabled()) return fail(res, 409, "Integration disabled");

    // Connection test: a "ping" event delivered right away.
    if (action === "ping") {
      const event = await queuePing(session.u);
      const run = await deliverPending({ budgetMs: 15000 });
      const after = await getEvent(event.id);
      return send(res, 200, { event: eventOut(after || event), run });
    }

    // Sends what is due now (instead of waiting for the next cron run).
    if (action === "deliver") return send(res, 200, { run: await deliverPending({ budgetMs: 25000 }) });

    // Puts failed events back in the queue (one, or all with { all: true }).
    if (action === "retry") {
      const targets = body.all
        ? (await recentEvents(2000)).filter((e) => e.status === "failed")
        : [await getEvent(String(body.id || ""))].filter(Boolean);
      if (!body.all && !targets.length) return fail(res, 404, "Event not found");
      for (const e of targets) if (e.status !== "delivered") await updateEvent(retryEvent(e));
      const run = await deliverPending({ budgetMs: 20000 });
      return send(res, 200, { retried: targets.length, run });
    }

    // Compares the catalog and the receivables now and sends what changed.
    // With { all: true }, sends everything again (e.g. after Soulglobal reset its copy).
    if (action === "sync") {
      if (body.all) await resetSynced();
      const sync = await syncShared({ force: true });
      const run = await deliverPending({ budgetMs: 20000 });
      return send(res, 200, { sync, run });
    }

    if (action === "document") {
      const out = await shareDocument(body, session);
      return out.error ? fail(res, out.status, out.error) : send(res, out.status, out);
    }

    fail(res, 400, "Unknown action");
  } catch (e) {
    if (e instanceof BusyError) return fail(res, 503, e.message);
    console.error(e);
    fail(res, /JSON/.test(e.message) ? 400 : 500, /JSON/.test(e.message) ? "Invalid JSON" : "Server error");
  }
}
