// Events sent by Soulglobal (POST /api/integration-inbound). Same protocol as
// the events Micheng sends (docs/integracao-soulglobal.md): signed with the
// shared secret, each event id handled once.
//
// Answers: 200 handled (or already handled, or a type this version ignores);
// 401 bad signature; 422 invalid event (do not retry); 409/500/503 try again later.
import crypto from "node:crypto";
import { send, fail, readRaw } from "./_lib/http.js";
import {
  getPrivate, savePrivate, withDataLock, BusyError, saveSecretFile, deleteSecretFile,
  claimInbox, finishInbox, appendInboundLog,
} from "./_lib/store.js";
import { integrationEnabled, verifySignature, fetchRemoteFile, validDocument, cleanFileName, DOCUMENT_TYPES } from "./_lib/integration.js";

const MAX_BODY = 1024 * 1024;
const MAX_DOCUMENT = 20 * 1024 * 1024;

class Rejected extends Error {} // the event itself is wrong: retrying will not help

const str = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);
const httpsUrl = (v) => (/^https:\/\/[^\s]+$/.test(String(v || "")) ? String(v).slice(0, 1000) : null);

// The Micheng order an event refers to: by its id, or by its number.
function findOrder(priv, ref) {
  if (!ref) return null;
  return priv.proformas.find((p) => (ref.michengId && p.id === ref.michengId) || (ref.number && p.number === ref.number)) || null;
}

const handlers = {
  ping: async () => ({ result: "pong" }),

  // Soulglobal created or updated the order / shipment linked to a Micheng order.
  // data.order: { michengId | number, soulglobalId, reference, status, step, url }
  "order.updated": async (evt) => {
    const o = (evt.data && evt.data.order) || {};
    if (!o.michengId && !o.number) throw new Rejected("order.michengId or order.number is required");
    return withDataLock(async () => {
      const priv = await getPrivate();
      const pf = findOrder(priv, o);
      if (!pf) throw new Rejected("Order not found");
      const at = evt.occurredAt || new Date().toISOString();
      // An older event arriving late never undoes a newer one.
      if (pf.soulglobal && pf.soulglobal.updatedAt && pf.soulglobal.updatedAt > at) return { result: "stale" };
      pf.soulglobal = {
        id: str(o.soulglobalId, 100), reference: str(o.reference, 120), status: str(o.status, 60), step: str(o.step, 60),
        url: httpsUrl(o.url), updatedAt: at, eventId: evt.id,
      };
      await savePrivate(priv);
      return { result: "linked", proformaId: pf.id };
    });
  },

  // A document from Soulglobal: downloaded and kept encrypted, linked to the order.
  // data.document: { id, type, name, contentType, size, sha256, url }; data.order: { michengId | number }
  "document.shared": async (evt) => {
    const d = (evt.data && evt.data.document) || {};
    if (!d.id || !d.url) throw new Rejected("document.id and document.url are required");
    let file;
    try {
      file = await fetchRemoteFile(String(d.url), MAX_DOCUMENT);
    } catch (e) {
      if (/not allowed|Invalid document URL|too large/.test(e.message)) throw new Rejected(e.message);
      throw e; // the download may work later
    }
    const contentType = d.contentType && validDocument(d.contentType, file.buffer) ? d.contentType
      : validDocument(file.contentType, file.buffer) ? file.contentType : null;
    if (!contentType) throw new Rejected("Unsupported file");
    const sha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");
    if (d.sha256 && String(d.sha256).toLowerCase() !== sha256) throw new Error("Checksum mismatch"); // retry: maybe a bad download
    const ref = await saveSecretFile(file.buffer);
    let replacedRef = null;
    try {
      const out = await withDataLock(async () => {
        const priv = await getPrivate();
        const pf = findOrder(priv, evt.data.order);
        const docs = (priv.integrationDocs = priv.integrationDocs || []);
        const remoteId = String(d.id).slice(0, 100);
        const existing = docs.find((x) => x.direction === "in" && x.remoteId === remoteId);
        const doc = {
          id: existing ? existing.id : crypto.randomUUID(), direction: "in", remoteId,
          type: DOCUMENT_TYPES.includes(d.type) ? d.type : "OTHER", remoteType: str(d.type, 60),
          name: cleanFileName(d.name), contentType, size: file.buffer.length, sha256, ref,
          proformaId: pf ? pf.id : null, proformaNumber: pf ? pf.number : null,
          note: str(d.note, 500), at: evt.occurredAt || new Date().toISOString(), by: "soulglobal", eventId: evt.id,
        };
        if (existing) { replacedRef = existing.ref; Object.assign(existing, doc); } else docs.push(doc);
        await savePrivate(priv);
        return { result: "stored", documentId: doc.id, proformaId: doc.proformaId };
      });
      if (replacedRef) await deleteSecretFile(replacedRef);
      return out;
    } catch (e) {
      await deleteSecretFile(ref);
      throw e;
    }
  },

  // Soulglobal reviewed a document Micheng shared.
  // data: { documentId (Micheng's id), status: "PENDING" | "APPROVED" | "REJECTED", reason }
  "document.reviewed": async (evt) => {
    const data = evt.data || {};
    const status = ["PENDING", "APPROVED", "REJECTED"].includes(data.status) ? data.status : null;
    if (!data.documentId || !status) throw new Rejected("documentId and a valid status are required");
    return withDataLock(async () => {
      const priv = await getPrivate();
      const doc = (priv.integrationDocs || []).find((x) => x.direction === "out" && x.id === data.documentId);
      if (!doc) throw new Rejected("Document not found");
      const at = evt.occurredAt || new Date().toISOString();
      if (doc.review && doc.review.at > at) return { result: "stale" };
      doc.review = { status, reason: str(data.reason, 1000), at, eventId: evt.id };
      await savePrivate(priv);
      return { result: "reviewed" };
    });
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "Method not allowed");
  if (!integrationEnabled()) return fail(res, 503, "Integration disabled");
  let raw;
  try {
    raw = await readRaw(req, MAX_BODY);
  } catch (e) {
    return fail(res, e.status || 400, e.message);
  }
  const reason = verifySignature(raw, req.headers["x-integration-timestamp"], req.headers["x-integration-signature"]);
  if (reason) return fail(res, 401, "Invalid signature (" + reason + ")");

  let evt;
  try {
    evt = JSON.parse(raw);
  } catch (e) {
    return fail(res, 422, "Invalid JSON");
  }
  const id = typeof evt.id === "string" ? evt.id.trim() : "";
  if (!id || id.length > 128 || typeof evt.type !== "string" || !evt.type) return fail(res, 422, "Event id and type are required");
  const headerId = req.headers["x-integration-id"];
  if (headerId && headerId !== id) return fail(res, 422, "X-Integration-Id does not match the event id");

  const claim = await claimInbox(id);
  if (claim === "done") return send(res, 200, { ok: true, duplicate: true });
  if (claim === "busy") {
    res.setHeader("Retry-After", "30");
    return fail(res, 409, "Event is being handled");
  }

  const log = { id, type: evt.type, seq: evt.seq ?? null, occurredAt: evt.occurredAt || null, receivedAt: new Date().toISOString() };
  const handle = handlers[evt.type];
  try {
    const out = handle ? await handle(evt) : { result: "ignored" };
    await finishInbox(id, true);
    await appendInboundLog({ ...log, status: handle ? "processed" : "ignored", result: out.result || null });
    return send(res, 200, { ok: true, ...out });
  } catch (e) {
    const rejected = e instanceof Rejected;
    await finishInbox(id, rejected).catch(() => {}); // a rejected event is done; a failed one may come again
    await appendInboundLog({ ...log, status: rejected ? "rejected" : "failed", error: String(e.message).slice(0, 300) }).catch(() => {});
    if (rejected) return fail(res, 422, e.message);
    if (e instanceof BusyError) { res.setHeader("Retry-After", "10"); return fail(res, 503, e.message); }
    console.error("Integration inbound", e);
    return fail(res, 500, "Could not handle the event");
  }
}
