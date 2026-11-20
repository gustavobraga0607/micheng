// Shared catalog and receivables: keeps Soulglobal's copy of the product catalog
// and of the money received for each order up to date. Micheng owns this data;
// Soulglobal only receives it.
//
// Instead of an event at every place products or finance are saved, a
// reconciler compares each shared record with a hash of what was last queued
// and queues "upserted" / "deleted" events for the differences. It runs after
// each change (in the background) and from the cron job, so the first run sends
// everything and any missed change is sent on the next run.
import crypto from "node:crypto";
import { getProducts, getFinance, syncState, syncedHashes, commitSync, tryLock } from "./store.js";
import { integrationEnabled, newEvent, deliverAfterTurn } from "./integration.js";
import { waitUntil } from "@vercel/functions";

const MAX_EVENTS_PER_RUN = 300; // the rest goes in the next run
const FULL_CHECK_MS = 60 * 60 * 1000; // compare everything at least once an hour

/* ---------- What is shared ---------- */

// A product as the site shows it, plus its codes and specifications (no
// supplier, cost, price, client data or technical drawings).
export function productSnapshot(p) {
  const specs = p.specs || {};
  const optionLabel = new Map();
  const attributes = (p.attributes || []).map((a) => ({
    id: a.id,
    name: a.name || {},
    options: (a.options || []).map((o) => {
      optionLabel.set(o.id, o.label || {});
      return { id: o.id, label: o.label || {} };
    }),
  }));
  const specifications = Object.entries(p.variantSkus || {})
    .filter(([key]) => !(specs[key] && specs[key].archived))
    .map(([key, n]) => {
      const s = specs[key] || {};
      return {
        key,
        sku: p.sku ? p.sku + "-" + n : null,
        optionIds: key.split(",").filter(Boolean),
        image: (p.variantImages && p.variantImages[key]) || null,
        details: s.details || null,
        weight: s.weight || null,
        measures: s.measures || null,
        packaging: s.packaging || null,
      };
    });
  return {
    id: p.id,
    sku: p.sku ? String(p.sku) : null,
    name: p.name || {},
    description: p.description || {},
    category: p.category || null,
    image: p.image || null,
    gallery: (p.gallery || []).map((g) => ({ url: g.url, optionId: g.optionId || null })),
    attributes,
    specifications,
    createdAt: p.createdAt || null,
    updatedAt: p.updatedAt || null,
  };
}

// Money a client owes / paid for an order (income entries linked to an order).
// No bank account, internal notes or reconciliation.
export const isSharedReceivable = (e) => e.type === "in" && Boolean(e.proformaId);

export function receivableSnapshot(e) {
  return {
    id: e.id,
    proformaId: e.proformaId,
    proformaNumber: e.proformaNumber || null,
    description: e.description || "",
    category: e.category || null,
    client: e.party ? e.party.name || null : null,
    amount: e.amount,
    currency: e.currency,
    dueDate: e.dueDate || null,
    status: e.status, // open | paid
    paidDate: e.paidDate || null,
    document: e.document || null,
    // Payment receipts: downloaded through signed links added when sent.
    attachments: (e.attachments || []).map((f) => ({ id: f.id, name: f.name, contentType: f.type, size: f.size })),
    createdAt: e.createdAt || null,
    updatedAt: e.updatedAt || null,
  };
}

function hash(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 32);
}

/* ---------- Reconciler ---------- */

// Queues the events for what changed. force: compare even if nothing was marked.
export async function syncShared({ force = false } = {}) {
  if (!integrationEnabled()) return { skipped: "disabled" };
  const state = await syncState();
  if (!force && !state.dirty && Date.now() - state.lastSync < FULL_CHECK_MS) return { skipped: "clean" };
  const release = await tryLock("sync", 60000);
  if (!release) return { skipped: "busy" };
  try {
    const [products, fin, sent] = await Promise.all([getProducts(), getFinance(), syncedHashes()]);
    const wanted = new Map();
    for (const p of products) wanted.set("product:" + p.id, { kind: "product", data: productSnapshot(p) });
    for (const e of fin.entries) if (isSharedReceivable(e)) wanted.set("receivable:" + e.id, { kind: "receivable", data: receivableSnapshot(e) });

    const events = [], setHashes = {}, delKeys = [];
    let complete = true;
    const room = () => events.length < MAX_EVENTS_PER_RUN || ((complete = false), false);
    for (const [key, w] of wanted) {
      const h = hash(w.data);
      if (sent[key] === h) continue;
      if (!room()) break;
      events.push(newEvent(w.kind + ".upserted", key, { [w.kind]: w.data }));
      setHashes[key] = h;
    }
    for (const key of Object.keys(sent)) {
      if (wanted.has(key)) continue;
      if (!room()) break;
      const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      events.push(newEvent(kind + ".deleted", key, { [kind]: { id } }));
      delKeys.push(key);
    }
    await commitSync(events, setHashes, delKeys, { dirtySeen: state.dirty, complete });
    return { queued: events.length, complete };
  } finally {
    await release();
  }
}

// A run already going may have read the data before this change: wait for it
// to finish and run again (the cron job would also catch it within a minute).
async function syncAfterTurn() {
  for (let i = 0; i < 8; i++) {
    const r = await syncShared();
    if (r.skipped !== "busy") return r;
    await new Promise((ok) => setTimeout(ok, 750));
  }
  return { skipped: "busy" };
}

// After a change to products or finance: sync and deliver in the background.
export function syncSoon() {
  if (!integrationEnabled()) return;
  const run = syncAfterTurn()
    .then(() => deliverAfterTurn())
    .catch((e) => console.error("Integration sync", e));
  try { waitUntil(run); } catch (e) { /* outside Vercel: the promise just runs */ }
}

// Wraps an API handler: after any change (not GET), sync in the background.
export function withSync(handler) {
  return async (req, res) => {
    try {
      return await handler(req, res);
    } finally {
      if (req.method !== "GET" && req.method !== "HEAD" && res.statusCode < 400) syncSoon();
    }
  };
}
