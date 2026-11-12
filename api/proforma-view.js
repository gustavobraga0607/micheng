// Public web page of a proforma (/proforma?t=<link code>), opened by the client
// from the link on the PDF. Only what the PDF shows is returned — never costs,
// margins or suppliers. Photos are always the product's current ones.
import crypto from "node:crypto";
import { fail, queryParam } from "./_lib/http.js";
import { getAllData } from "./_lib/store.js";
import { variantImage } from "./_lib/sku.js";
import { poNumber } from "./proformas.js";

function sameToken(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// This route is public: limit how fast one address can call it (per server
// instance, in memory), so guessing link codes or flooding it stays cheap for us.
const WINDOW_MS = 60000, MAX_PER_WINDOW = 40;
const hits = new Map();
function tooMany(req) {
  const ip = String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  const h = hits.get(ip);
  if (!h || now - h.start > WINDOW_MS) { hits.set(ip, { start: now, count: 1 }); return false; }
  h.count += 1;
  return h.count > MAX_PER_WINDOW;
}

function sendPo(res, priv, products, pf, supplierId) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const s = priv.settings || {};
  const sup = priv.suppliers.find((x) => x.id === supplierId) || {};
  const items = pf.items.filter((i) => i.supplierId === supplierId).map((i, n) => {
    const product = byId.get(i.productId);
    const snap = i.product || {};
    return {
      n: n + 1,
      code: i.sku || null,
      ref: null,
      name: snap.name || {},
      description: snap.description || (product && product.description) || {},
      options: i.options.map((o) => ({ name: o.attrName || {}, value: o.optionLabel || {} })),
      image: product ? variantImage(product, i.options.map((o) => o.optionId)) : snap.image || null,
      qty: i.qty,
      price: i.cost,
      amount: i.cost == null ? null : Math.round(i.cost * i.qty * 100) / 100,
    };
  });
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({
    kind: "po",
    number: poNumber(pf, supplierId),
    date: (pf.closedAt || pf.date || "").slice(0, 10),
    currency: pf.currency,
    language: "zh",
    company: { name: s.companyName || "", address: s.address || "", phone: s.phone || "", email: s.email || "", website: s.website || "" },
    client: null,
    supplier: { name: sup.company || "", contact: sup.contact || "", phone: sup.phone || "", wechat: sup.wechat || "", email: sup.email || "", city: sup.city || "" },
    items,
    total: Math.round(items.reduce((t, i) => t + (i.amount || 0), 0) * 100) / 100,
    terms: "",
  }));
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return fail(res, 405, "Method not allowed");
    const token = String(queryParam(req, "t") || "");
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return fail(res, 404, "Not found");
    if (tooMany(req)) return fail(res, 429, "Too many requests");
    const { products, priv } = await getAllData();
    const pf = priv.proformas.find((p) => p.shareToken && sameToken(p.shareToken, token));
    if (!pf) {
      // A supplier's purchase order link: only that supplier's items, with the
      // purchase price; never the client or the sale prices.
      for (const o of priv.proformas) {
        const entry = Object.entries(o.poTokens || {}).find(([, t]) => sameToken(t, token));
        if (entry) return sendPo(res, priv, products, o, entry[0]);
      }
      return fail(res, 404, "Not found");
    }

    const byId = new Map(products.map((p) => [p.id, p]));
    const s = priv.settings || {};
    const items = pf.items.map((i, n) => {
      const product = byId.get(i.productId);
      const ids = i.options.map((o) => o.optionId);
      const snap = i.product || {};
      return {
        n: n + 1,
        code: i.sku || null,
        ref: i.clientRef || null,
        name: snap.name || {},
        description: snap.description || (product && product.description) || {},
        options: i.options.map((o) => ({ name: o.attrName || {}, value: o.optionLabel || {} })),
        image: product ? variantImage(product, ids) : snap.image || null,
        qty: i.qty,
        price: i.price,
        amount: Math.round((i.price || 0) * i.qty * 100) / 100,
      };
    });
    const out = {
      number: pf.number,
      date: pf.date,
      validUntil: pf.validUntil || null,
      currency: pf.currency,
      incoterm: pf.incoterm || null,
      language: pf.language || "en",
      company: { name: s.companyName || "", address: s.address || "", phone: s.phone || "", email: s.email || "", website: s.website || "" },
      client: pf.client ? { name: pf.client.name || "", address: pf.client.address || "", country: pf.client.country || "", phone: pf.client.phone || "", taxId: pf.client.taxId || "" } : null,
      items,
      total: pf.totals ? pf.totals.sale : items.reduce((t, i) => t + i.amount, 0),
      terms: pf.terms || "",
    };
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(out));
  } catch (e) {
    console.error(e);
    fail(res, 500, "Server error");
  }
}
