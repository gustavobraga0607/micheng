// Integration with the Soulglobal system (sg-imports): events both ways, signed
// with a shared secret, and documents shared through short-lived signed links.
// The contract the other side implements is in docs/integracao-soulglobal.md.
//
// Sending (Micheng -> Soulglobal): a change that should reach Soulglobal is saved
// together with its event (outbox, store.js). The event is then delivered right
// after the response and, if that fails, again by the cron job with growing
// waits, in order for each subject (e.g. one order). Delivery is "at least
// once": the receiver ignores an event id it has already handled.
//
// Without SOULGLOBAL_EVENTS_URL and INTEGRATION_SECRET the integration is off:
// no events are queued and the inbound route refuses every request.
import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { pendingEvents, updateEvent, trimEvents, tryLock, addEvents } from "./store.js";

export const PROTOCOL_VERSION = 1;
const SIGNATURE_TOLERANCE_S = 5 * 60;
const SEND_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 20; // about 3 days with the waits below
const BACKOFF_MIN = [1, 2, 5, 10, 30, 60, 120, 240, 360]; // then every 6 h
const FILE_LINK_S = 48 * 3600;

/* ---------- Configuration (Vercel environment variables) ---------- */

// INTEGRATION_SECRET may hold several secrets separated by commas: events are
// signed with the first and accepted with any, so the secret can be changed on
// one side at a time without losing events.
function secrets() {
  return String(process.env.INTEGRATION_SECRET || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function eventsUrl() {
  const raw = String(process.env.SOULGLOBAL_EVENTS_URL || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    // Plain http only for local tests.
    if (u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) return u.href;
  } catch (e) { /* invalid */ }
  return "";
}

// Address of this site, used in the document links sent to Soulglobal.
export function publicBaseUrl() {
  const raw = process.env.PUBLIC_BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL : "");
  return String(raw).trim().replace(/\/$/, "");
}

// Hosts Micheng may download received documents from (https only):
// SOULGLOBAL_FILE_HOSTS (comma separated; "*.supabase.co" style allowed),
// by default the host of SOULGLOBAL_EVENTS_URL and Supabase Storage.
function fileHosts() {
  const list = String(process.env.SOULGLOBAL_FILE_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.length) return list;
  const url = eventsUrl();
  return (url ? [new URL(url).hostname] : []).concat("*.supabase.co");
}

export function integrationEnabled() {
  return Boolean(eventsUrl() && secrets().length && secrets()[0].length >= 32);
}

// What the panel shows about the configuration (never the secret).
export function integrationStatus() {
  const s = secrets();
  const url = eventsUrl();
  return {
    enabled: integrationEnabled(),
    eventsUrl: url ? new URL(url).origin + new URL(url).pathname : null,
    eventsUrlInvalid: Boolean(process.env.SOULGLOBAL_EVENTS_URL && !url),
    secretSet: s.length > 0,
    secretTooShort: s.length > 0 && s[0].length < 32,
    secretCount: s.length,
    publicBaseUrl: publicBaseUrl() || null,
    fileHosts: fileHosts(),
    cronSecretSet: Boolean(process.env.CRON_SECRET),
  };
}

/* ---------- Signatures ----------
   Headers: X-Integration-Id (event id), X-Integration-Timestamp (Unix seconds)
   and X-Integration-Signature: "v1=" + hex HMAC-SHA256(secret, timestamp + "." + body). */

function hmac(secret, text) {
  return crypto.createHmac("sha256", secret).update(text).digest("hex");
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function signBody(body, timestamp = Math.floor(Date.now() / 1000)) {
  return { timestamp: String(timestamp), signature: "v1=" + hmac(secrets()[0], timestamp + "." + body) };
}

// Checks a received request. Returns null when valid, otherwise the reason.
export function verifySignature(rawBody, timestamp, signature) {
  if (!integrationEnabled()) return "disabled";
  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) return "timestamp";
  if (Math.abs(Date.now() / 1000 - ts) > SIGNATURE_TOLERANCE_S) return "expired";
  const given = String(signature || "").split(",").map((s) => s.trim()).filter((s) => s.startsWith("v1="));
  if (!given.length) return "signature";
  const ok = secrets().some((secret) => given.some((g) => safeEqual(g, "v1=" + hmac(secret, ts + "." + rawBody))));
  return ok ? null : "signature";
}

/* ---------- Document links ----------
   /api/integration-file?id=<document>&exp=<Unix seconds>&sig=<HMAC>. The link is
   made when the event is sent, so a late retry still carries a valid one. */

function fileSig(id, exp) {
  return crypto.createHmac("sha256", secrets()[0]).update("file:" + id + ":" + exp).digest("base64url");
}

export function signedFileUrl(id) {
  const base = publicBaseUrl();
  if (!base) throw new Error("PUBLIC_BASE_URL is not configured");
  const exp = Math.floor(Date.now() / 1000) + FILE_LINK_S;
  return base + "/api/integration-file?id=" + encodeURIComponent(id) + "&exp=" + exp + "&sig=" + fileSig(id, exp);
}

export function verifyFileLink(id, exp, sig) {
  if (!integrationEnabled() || !id || !/^\d+$/.test(String(exp || "")) || Number(exp) < Date.now() / 1000) return false;
  return secrets().some((secret) =>
    safeEqual(String(sig || ""), crypto.createHmac("sha256", secret).update("file:" + id + ":" + exp).digest("base64url")));
}

// Downloads a document Soulglobal shared (https, allowed hosts, no redirects).
export async function fetchRemoteFile(url, maxBytes) {
  let u;
  try { u = new URL(url); } catch (e) { throw new Error("Invalid document URL"); }
  const host = u.hostname.toLowerCase();
  const allowed = fileHosts().some((h) => (h.startsWith("*.") ? host.endsWith(h.slice(1)) : host === h));
  if (u.protocol !== "https:" || !allowed || u.username || u.password) throw new Error("Document host not allowed: " + host);
  const r = await fetch(u.href, { redirect: "manual", signal: AbortSignal.timeout(20000), cache: "no-store" });
  if (r.status >= 300 && r.status < 400) throw new Error("Document redirect not allowed");
  if (!r.ok) throw new Error("Could not download the document (" + r.status + ")");
  const declared = Number(r.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("Document too large");
  const buffer = Buffer.from(await r.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error("Document too large");
  return { buffer, contentType: (r.headers.get("content-type") || "application/octet-stream").split(";")[0].trim() };
}

/* ---------- Events ---------- */

// A new event to queue, or null when the integration is off. "subject" groups
// events that must arrive in order (e.g. "proforma:<id>").
export function newEvent(type, subject, data) {
  if (!integrationEnabled()) return null;
  return {
    id: crypto.randomUUID(),
    type,
    subject,
    data,
    createdAt: new Date().toISOString(),
    status: "pending", // pending | delivered | failed
    attempts: 0,
    nextAt: 0,
    lastError: null,
    deliveredAt: null,
  };
}

// The body sent: the event plus fresh links for its documents.
function envelope(event) {
  let data = event.data;
  if (data && data.document) data = { ...data, document: { ...data.document, url: signedFileUrl(data.document.id) } };
  if (data && data.receivable && data.receivable.attachments && data.receivable.attachments.length) {
    data = { ...data, receivable: { ...data.receivable, attachments: data.receivable.attachments.map((f) => ({ ...f, url: signedFileUrl("fin:" + f.id) })) } };
  }
  return JSON.stringify({
    id: event.id,
    type: event.type,
    version: PROTOCOL_VERSION,
    source: "micheng",
    seq: event.seq,
    subject: event.subject,
    occurredAt: event.createdAt,
    data,
  });
}

function backoffMs(attempts) {
  return BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60000;
}

async function send(event) {
  const body = envelope(event);
  const { timestamp, signature } = signBody(body);
  const r = await fetch(eventsUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "micheng-integration/" + PROTOCOL_VERSION,
      "X-Integration-Id": event.id,
      "X-Integration-Timestamp": timestamp,
      "X-Integration-Signature": signature,
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    cache: "no-store",
  });
  if (r.status >= 200 && r.status < 300) return;
  const text = (await r.text().catch(() => "")).slice(0, 200);
  throw new Error("HTTP " + r.status + (text ? ": " + text : ""));
}

// Delivers the events that are due, oldest first. Events of the same subject
// keep their order: while one waits for a retry, the later ones wait too.
// Returns a summary of the run.
export async function deliverPending({ budgetMs = 45000 } = {}) {
  const result = { delivered: 0, failed: 0, waiting: 0, skipped: false };
  if (!integrationEnabled()) return { ...result, skipped: "disabled" };
  const release = await tryLock("deliver", budgetMs + SEND_TIMEOUT_MS + 5000);
  if (!release) return { ...result, skipped: "busy" };
  const started = Date.now();
  try {
    // Passes over the queue until one sends nothing: events queued while this
    // run was going (their own run found it busy) are sent too.
    for (let progress = true; progress && Date.now() - started <= budgetMs;) {
      progress = false;
      result.waiting = 0;
      const blocked = new Set();
      for (const event of await pendingEvents()) {
        if (blocked.has(event.subject)) { result.waiting += 1; continue; }
        if (event.nextAt > Date.now() || Date.now() - started > budgetMs) {
          blocked.add(event.subject);
          result.waiting += 1;
          continue;
        }
        event.attempts += 1;
        event.lastAttemptAt = new Date().toISOString();
        try {
          await send(event);
          event.status = "delivered";
          event.deliveredAt = new Date().toISOString();
          event.lastError = null;
          result.delivered += 1;
          progress = true;
        } catch (e) {
          event.lastError = String(e.message || e).slice(0, 300);
          if (event.attempts >= MAX_ATTEMPTS) {
            event.status = "failed";
            result.failed += 1;
          } else {
            event.nextAt = Date.now() + backoffMs(event.attempts);
            result.waiting += 1;
          }
          blocked.add(event.subject);
        }
        await updateEvent(event);
      }
    }
    await trimEvents();
  } finally {
    await release();
  }
  return result;
}

// Waits for a run already going, then delivers (that run may have read the
// queue before the new events). The cron job is the safety net.
export async function deliverAfterTurn(budgetMs = 20000) {
  for (let i = 0; i < 10; i++) {
    const r = await deliverPending({ budgetMs });
    if (r.skipped !== "busy") return r;
    await new Promise((ok) => setTimeout(ok, 750));
  }
  return { skipped: "busy" };
}

// Delivers in the background after the response is sent (Vercel keeps the
// function alive for it). Anything left is picked up by the cron job.
export function deliverSoon() {
  if (!integrationEnabled()) return;
  const run = deliverAfterTurn().catch((e) => console.error("Integration delivery", e));
  try { waitUntil(run); } catch (e) { /* outside Vercel: the promise just runs */ }
}

// Puts a failed event (or every failed one) back in the queue.
export function retryEvent(event) {
  return { ...event, status: "pending", attempts: 0, nextAt: 0 };
}

// A connection test: queued like any event (it must reach the other side).
export async function queuePing(by) {
  const event = newEvent("ping", "ping", { by, at: new Date().toISOString() });
  if (!event) return null;
  await addEvents([event]);
  return event;
}

/* ---------- What Soulglobal receives about an order ----------
   An allow-list: suppliers, purchase costs, margins, declared values, the
   internal log and the share links never leave Micheng. */

const round2 = (n) => Math.round(n * 100) / 100;

export function orderSnapshot(pf) {
  const inv = pf.invoice;
  return {
    id: pf.id,
    number: pf.number,
    status: pf.status,
    date: pf.date || null,
    validUntil: pf.validUntil || null,
    currency: pf.currency,
    incoterm: pf.incoterm || null,
    language: pf.language || null,
    terms: pf.terms || "",
    closedAt: pf.closedAt || null,
    updatedAt: pf.updatedAt || null,
    clientId: pf.clientId || null,
    client: pf.client
      ? { name: pf.client.name || "", address: pf.client.address || "", country: pf.client.country || "", phone: pf.client.phone || "", taxId: pf.client.taxId || "" }
      : null,
    items: (pf.items || []).map((i) => ({
      id: i.id,
      productId: i.productId,
      sku: i.sku || null,
      name: (i.product && i.product.name) || {},
      description: (i.product && i.product.description) || null,
      category: (i.product && i.product.category) || null,
      image: (i.product && i.product.image) || null,
      options: (i.options || []).map((o) => ({ attributeId: o.attrId, optionId: o.optionId, attribute: o.attrName || {}, option: o.optionLabel || {} })),
      clientRef: i.clientRef || null,
      qty: i.qty,
      unitPrice: i.price,
      amount: i.price == null ? null : round2(i.price * i.qty),
    })),
    total: pf.totals ? pf.totals.sale : null,
    invoice: inv
      ? {
          number: inv.number, date: inv.date, incoterm: inv.incoterm, transport: inv.transport,
          portLoading: inv.portLoading, portDischarge: inv.portDischarge,
          originCountry: inv.originCountry, acquisitionCountry: inv.acquisitionCountry, provenanceCountry: inv.provenanceCountry,
          paymentTerms: inv.paymentTerms, buyer: inv.buyer, packagesQty: inv.packagesQty, packagesKind: inv.packagesKind, marks: inv.marks,
          grossWeight: inv.grossWeight, netWeight: inv.netWeight, volumeM3: inv.volumeM3,
          freight: inv.freight, insurance: inv.insurance, otherCosts: inv.otherCosts, otherCostsLabel: inv.otherCostsLabel,
          notes: inv.notes, units: inv.items || {}, savedAt: inv.savedAt || null,
        }
      : null,
    soulglobal: pf.soulglobal ? { id: pf.soulglobal.id || null, reference: pf.soulglobal.reference || null } : null,
  };
}

// Event about an order (null when the integration is off).
export function orderEvent(type, pf, extra) {
  return newEvent(type, "proforma:" + pf.id, { order: orderSnapshot(pf), ...(extra || {}) });
}

/* ---------- Shared documents ---------- */

export const DOCUMENT_TYPES = ["PROFORMA_INVOICE", "COMMERCIAL_INVOICE", "PACKING_LIST", "BILL_OF_LADING", "ORIGIN_CERTIFICATE",
  "PURCHASE_ORDER", "SWIFT", "INSPECTION_REPORT", "PHOTO", "OTHER"];
// Accepted files, each checked by its first bytes (not only by the declared type).
const zipLike = (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
export const DOCUMENT_CONTENT_TYPES = {
  "application/pdf": (b) => b.subarray(0, 4).toString() === "%PDF",
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
  "image/png": (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  "image/webp": (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": zipLike,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": zipLike,
  "application/zip": zipLike,
};

export function validDocument(contentType, buffer) {
  const check = DOCUMENT_CONTENT_TYPES[contentType];
  return Boolean(check && buffer.length && check(buffer));
}

export function cleanFileName(name) {
  return String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 140) || "document";
}

// The document as described in events and in the panel (no storage reference).
export function documentOut(d) {
  return {
    id: d.id, direction: d.direction, type: d.type, name: d.name, contentType: d.contentType, size: d.size, sha256: d.sha256,
    proformaId: d.proformaId || null, proformaNumber: d.proformaNumber || null, remoteId: d.remoteId || null,
    key: d.key || null, version: d.version || 1, supersededBy: d.supersededBy || null,
    note: d.note || null, at: d.at, by: d.by || null,
    review: d.review ? { status: d.review.status, reason: d.review.reason || null, at: d.review.at } : null,
  };
}
