// Proformas: admin-only, stored encrypted with the other private data.
// A proforma keeps a copy (snapshot) of the client and of each product's
// texts, so later edits to products or clients do not change old documents.
// Closing a proforma remembers its sale prices for that client, and the
// next proforma for the same client starts from them.
import crypto from "node:crypto";
import { send, fail, readJson, queryParam, isJsonRequest } from "./_lib/http.js";
import { getSession } from "./_lib/auth.js";
import { getProducts, getPrivate, savePrivate, oneChangeAtATime } from "./_lib/store.js";
import { skuFor, variantImage } from "./_lib/sku.js";
import { parseDecimal } from "./_lib/decimal.js";

const CURRENCIES = ["CNY", "USD", "EUR", "BRL"];
const DOC_LANGS = ["en", "pt", "es"];
const MAX_ITEMS = 200;

const num = parseDecimal; // accepts "15,9" as well as "15.9"

function text(value, max) {
  return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

function isoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? value : null;
}

// Key used to remember a sale price: the product plus the chosen options.
export function priceKey(productId, options) {
  const ids = (options || []).map((o) => o.optionId).filter(Boolean).sort();
  return productId + (ids.length ? "|" + ids.join(",") : "");
}

// The client's reference for a product configuration, from the product catalog.
export function catalogRef(priv, clientId, productId, options) {
  const byClient = priv.clientRefs && priv.clientRefs[productId];
  const map = byClient && byClient[clientId];
  if (!map) return null;
  return map[(options || []).map((o) => o.optionId).filter(Boolean).sort().join(",")] || map[""] || null;
}

function buildItems(rawItems, products, priv, previous, clientId) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const prevItems = new Map(((previous && previous.items) || []).map((i) => [i.id, i]));
  const items = [];
  for (const raw of (Array.isArray(rawItems) ? rawItems : []).slice(0, MAX_ITEMS)) {
    if (!raw || !raw.productId) continue;
    const product = byId.get(raw.productId);
    const prev = prevItems.get(raw.id);
    let snapshot;
    let options = [];
    if (product) {
      const chosen = raw.options || {};
      for (const attr of product.attributes || []) {
        const opt = attr.options.find((o) => o.id === chosen[attr.id]);
        if (opt) options.push({ attrId: attr.id, optionId: opt.id, attrName: attr.name, optionLabel: opt.label });
      }
      // The photo of the chosen configuration, when it has its own.
      snapshot = { name: product.name, image: variantImage(product, options.map((o) => o.optionId)), category: product.category };
    } else if (prev && prev.productId === raw.productId) {
      // Product was deleted after this item was added: keep the saved copy.
      snapshot = prev.product;
      options = prev.options;
    } else {
      continue;
    }
    const supplierId = String(raw.supplierId || "");
    const supplier = priv.suppliers.find((s) => s.id === supplierId);
    items.push({
      id: prev ? prev.id : crypto.randomUUID(),
      productId: raw.productId,
      sku: product ? skuFor(product, options.map((o) => o.optionId)) : (prev && prev.sku) || null,
      product: snapshot,
      options,
      attributeCount: product ? (product.attributes || []).length : options.length,
      // Reference typed on the proforma, otherwise the one registered in the product.
      clientRef: typeof raw.clientRef === "string" ? raw.clientRef.trim().slice(0, 60) || null : catalogRef(priv, clientId, raw.productId, options),
      supplierId: supplier ? supplier.id : null,
      supplierName: supplier ? supplier.company : null,
      qty: num(raw.qty) || 0,
      cost: num(raw.cost),
      price: num(raw.price),
    });
  }
  return items;
}

// Profit and margin only count items whose cost is known; items without a cost
// are reported in costMissing instead of being treated as 100% profit.
function totals(items) {
  let sale = 0, saleWithCost = 0, cost = 0, costMissing = 0;
  for (const i of items) {
    const lineSale = (i.price || 0) * i.qty;
    sale += lineSale;
    if (i.cost == null) costMissing += 1;
    else { cost += i.cost * i.qty; saleWithCost += lineSale; }
  }
  const r = (n) => Math.round(n * 100) / 100;
  const known = costMissing < items.length;
  return { sale: r(sale), saleWithCost: r(saleWithCost), cost: r(cost), profit: known ? r(saleWithCost - cost) : null, costMissing };
}

async function applyBody(proforma, body, priv, previous) {
  const client = priv.clients.find((c) => c.id === body.clientId);
  proforma.clientId = client ? client.id : (previous && previous.clientId) || null;
  if (client) proforma.client = { name: client.name, address: client.address, phone: client.phone, taxId: client.taxId };
  else if (!previous || previous.clientId !== proforma.clientId) proforma.client = null;
  proforma.date = isoDate(body.date) || proforma.date || new Date().toISOString().slice(0, 10);
  proforma.validUntil = isoDate(body.validUntil);
  proforma.currency = CURRENCIES.includes(body.currency) ? body.currency : proforma.currency || priv.settings.currency || "CNY";
  proforma.language = DOC_LANGS.includes(body.language) ? body.language : proforma.language || "en";
  proforma.terms = text(body.terms, 3000);
  proforma.items = buildItems(body.items, await getProducts(), priv, previous, proforma.clientId);
  proforma.totals = totals(proforma.items);
}

function nextNumber(priv, date) {
  const year = String(date || new Date().toISOString()).slice(0, 4);
  priv.proformaSeq[year] = (priv.proformaSeq[year] || 0) + 1;
  return "PF-" + year + "-" + String(priv.proformaSeq[year]).padStart(3, "0");
}

// The same product with exactly the same options may appear only once
// (otherwise the PDF would show two identical lines). Returns "duplicate:n:of".
function duplicateProblems(items) {
  const first = new Map();
  const problems = [];
  items.forEach((i, n) => {
    if (i.options.length < i.attributeCount) return; // options still being chosen
    const key = priceKey(i.productId, i.options);
    if (first.has(key)) problems.push("duplicate:" + (n + 1) + ":" + (first.get(key) + 1));
    else first.set(key, n);
  });
  return problems;
}

// Problems that stop a proforma from being closed (empty list = OK).
function closeProblems(p) {
  const problems = [];
  if (!p.clientId) problems.push("client");
  if (!p.items.length) problems.push("items");
  p.items.forEach((i, n) => {
    if (!(i.qty > 0)) problems.push("qty:" + (n + 1));
    if (i.price == null) problems.push("price:" + (n + 1));
    if (i.options.length < i.attributeCount) problems.push("options:" + (n + 1));
  });
  return problems.concat(duplicateProblems(p.items));
}

async function handler(req, res) {
  try {
    const session = getSession(req);
    if (!session) return fail(res, 401, "Login required");
    if (req.method !== "GET" && req.method !== "DELETE" && !isJsonRequest(req)) return fail(res, 415, "Expected JSON");

    const priv = await getPrivate();
    const id = queryParam(req, "id");
    const action = queryParam(req, "action");

    if (req.method === "GET") {
      const clientId = queryParam(req, "prices");
      if (clientId) return send(res, 200, { prices: priv.clientPrices[clientId] || {} });
      // Items saved before SKUs existed show the current code of their product.
      const products = await getProducts();
      const byId = new Map(products.map((p) => [p.id, p]));
      const proformas = priv.proformas.map((pf) => ({
        ...pf,
        items: pf.items.map((i) => ({
          ...i,
          sku: i.sku || skuFor(byId.get(i.productId), i.options.map((o) => o.optionId)),
          // Drafts saved before references existed show the catalog reference.
          clientRef: i.clientRef !== undefined || pf.status === "closed" ? i.clientRef || null : catalogRef(priv, pf.clientId, i.productId, i.options),
        })),
      }));
      return send(res, 200, { proformas });
    }

    if (req.method === "POST" && !id) {
      const body = await readJson(req);
      const now = new Date().toISOString();
      const proforma = { id: crypto.randomUUID(), status: "draft", createdAt: now, updatedAt: now, createdBy: session.u };
      await applyBody(proforma, body, priv, null);
      const dups = duplicateProblems(proforma.items);
      if (dups.length) return send(res, 422, { error: "Duplicate items", problems: dups });
      proforma.number = nextNumber(priv, proforma.date);
      priv.proformas.unshift(proforma);
      await savePrivate(priv);
      return send(res, 201, { proforma });
    }

    const index = priv.proformas.findIndex((p) => p.id === id);
    if (index < 0) return fail(res, 404, "Proforma not found");
    const current = priv.proformas[index];

    if (req.method === "PUT") {
      if (current.status === "closed") return fail(res, 409, "Closed proformas cannot be edited. Reopen it first.");
      const body = await readJson(req);
      const proforma = { ...current, updatedAt: new Date().toISOString() };
      await applyBody(proforma, body, priv, current);
      const dups = duplicateProblems(proforma.items);
      if (dups.length) return send(res, 422, { error: "Duplicate items", problems: dups });
      priv.proformas[index] = proforma;
      await savePrivate(priv);
      return send(res, 200, { proforma });
    }

    if (req.method === "POST" && action === "close") {
      if (current.status === "closed") return send(res, 200, { proforma: current });
      const problems = closeProblems(current);
      if (problems.length) return send(res, 422, { error: "Cannot close", problems });
      const now = new Date().toISOString();
      const proforma = { ...current, status: "closed", closedAt: now, closedBy: session.u, updatedAt: now };
      const prices = (priv.clientPrices[proforma.clientId] = priv.clientPrices[proforma.clientId] || {});
      for (const item of proforma.items) {
        const memo = { price: item.price, currency: proforma.currency, proformaId: proforma.id, number: proforma.number, at: now };
        prices[priceKey(item.productId, item.options)] = memo; // exact options
        prices[item.productId] = memo; // any options (fallback)
        // A reference typed on the proforma is remembered in the product catalog.
        if (item.clientRef) {
          const product = (priv.clientRefs[item.productId] = priv.clientRefs[item.productId] || {});
          const map = (product[proforma.clientId] = product[proforma.clientId] || {});
          map[item.options.map((o) => o.optionId).sort().join(",")] = item.clientRef;
        }
      }
      priv.proformas[index] = proforma;
      await savePrivate(priv);
      return send(res, 200, { proforma });
    }

    if (req.method === "POST" && action === "reopen") {
      const proforma = { ...current, status: "draft", closedAt: null, updatedAt: new Date().toISOString() };
      priv.proformas[index] = proforma;
      await savePrivate(priv);
      return send(res, 200, { proforma });
    }

    if (req.method === "DELETE") {
      priv.proformas.splice(index, 1);
      await savePrivate(priv);
      return send(res, 200, { ok: true });
    }

    fail(res, 405, "Method not allowed");
  } catch (e) {
    console.error(e);
    fail(res, /JSON/.test(e.message) ? 400 : 500, /JSON/.test(e.message) ? "Invalid JSON" : "Server error");
  }
}

export default oneChangeAtATime(handler);
