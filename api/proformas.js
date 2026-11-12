// Proformas: admin-only, stored encrypted with the other private data.
// A proforma keeps a copy (snapshot) of the client and of each product's
// texts, so later edits to products or clients do not change old documents.
// Closing a proforma remembers its sale prices for that client, and the
// next proforma for the same client starts from them.
import crypto from "node:crypto";
import { send, fail, readJson, queryParam, isJsonRequest } from "./_lib/http.js";
import { getSession } from "./_lib/auth.js";
import { getAllData, getFinance, savePrivate, oneChangeAtATime } from "./_lib/store.js";
import { skuFor, variantImage } from "./_lib/sku.js";
import { parseDecimal } from "./_lib/decimal.js";

const CURRENCIES = ["CNY", "USD", "EUR", "BRL"];
const DOC_LANGS = ["en", "pt", "es"];
const INCOTERMS = ["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"];
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
      snapshot = { name: product.name, description: product.description || null, image: variantImage(product, options.map((o) => o.optionId)), category: product.category };
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
      // Declared value (internal control): kept across edits, never part of the documents.
      declared: prev && prev.declared != null ? prev.declared : null,
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

function applyBody(proforma, body, priv, previous, products) {
  const client = priv.clients.find((c) => c.id === body.clientId);
  proforma.clientId = client ? client.id : (previous && previous.clientId) || null;
  if (client) proforma.client = { name: client.name, address: client.address, phone: client.phone, taxId: client.taxId };
  else if (!previous || previous.clientId !== proforma.clientId) proforma.client = null;
  proforma.date = isoDate(body.date) || proforma.date || new Date().toISOString().slice(0, 10);
  proforma.validUntil = isoDate(body.validUntil);
  proforma.currency = CURRENCIES.includes(body.currency) ? body.currency : proforma.currency || priv.settings.currency || "CNY";
  proforma.language = DOC_LANGS.includes(body.language) ? body.language : proforma.language || "en";
  proforma.terms = text(body.terms, 3000);
  // Incoterm agreed with the client (required to close the order; used on the invoice).
  proforma.incoterm = INCOTERMS.includes(body.incoterm) ? body.incoterm : null;
  proforma.incotermPlace = text(body.incotermPlace, 80);
  proforma.items = buildItems(body.items, products, priv, previous, proforma.clientId);
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
  if (!p.incoterm || !p.incotermPlace) problems.push("incoterm");
  if (!p.items.length) problems.push("items");
  p.items.forEach((i, n) => {
    if (!(i.qty > 0)) problems.push("qty:" + (n + 1));
    if (i.price == null) problems.push("price:" + (n + 1));
    if (i.options.length < i.attributeCount) problems.push("options:" + (n + 1));
  });
  return problems.concat(duplicateProblems(p.items));
}

/* ---------- Change log ----------
   Each order keeps a record of what happened to it: closed, reopened, items
   added, removed or changed after closing, discounted prices. */
const MAX_LOG = 300;

// What identifies an item in the log (texts in every language, so the panel
// shows them in the language being used).
function logItem(i) {
  return {
    id: i.id,
    sku: i.sku || null,
    name: (i.product && i.product.name) || {},
    options: (i.options || []).map((o) => o.optionLabel || {}),
  };
}

function addLog(proforma, by, kind, changes) {
  const entry = { at: new Date().toISOString(), by, kind };
  if (changes) entry.changes = changes;
  proforma.log = (proforma.log || []).concat(entry).slice(-MAX_LOG);
}

// Differences between the items before and after a change, by item id.
// Same product with the same options.
function sameConfig(a, b) {
  return a.productId === b.productId &&
    a.options.map((o) => o.optionId).sort().join(",") === b.options.map((o) => o.optionId).sort().join(",");
}

function itemChanges(before, after) {
  const old = new Map(before.map((i) => [i.id, i]));
  const now = new Map(after.map((i) => [i.id, i]));
  const changes = [];
  for (const i of before) {
    const n = now.get(i.id);
    if (!n || !sameConfig(i, n)) changes.push({ type: "removed", item: logItem(i), qty: i.qty, price: i.price });
  }
  for (const i of after) {
    const o = old.get(i.id);
    if (!o || !sameConfig(o, i)) { changes.push({ type: "added", item: logItem(i), qty: i.qty, price: i.price }); continue; }
    if (o.qty !== i.qty) changes.push({ type: "qty", item: logItem(i), from: o.qty, to: i.qty });
    if (o.price !== i.price) changes.push({ type: "price", item: logItem(i), from: o.price, to: i.price });
  }
  return changes;
}

// Sale prices (and the client's references) of an order are remembered for the client.
function rememberPrices(priv, proforma, items, now) {
  const prices = (priv.clientPrices[proforma.clientId] = priv.clientPrices[proforma.clientId] || {});
  for (const item of items) {
    const memo = { price: item.price, currency: proforma.currency, proformaId: proforma.id, number: proforma.number, at: now };
    prices[priceKey(item.productId, item.options)] = memo; // exact options
    prices[item.productId] = memo; // any options (fallback)
    if (item.clientRef) {
      const product = (priv.clientRefs[item.productId] = priv.clientRefs[item.productId] || {});
      const map = (product[proforma.clientId] = product[proforma.clientId] || {});
      map[item.options.map((o) => o.optionId).sort().join(",")] = item.clientRef;
    }
  }
}

// Discounted prices kept for the client load into items that have none (same currency only).
function loadDiscounts(priv, proforma, items) {
  const declared = priv.clientDeclared[proforma.clientId] || {};
  return items.map((item) => {
    if (item.declared != null) return item;
    const memo = declared[priceKey(item.productId, item.options)] || declared[item.productId];
    return memo && memo.currency === proforma.currency ? { ...item, declared: memo.value } : item;
  });
}

/* ---------- Commercial invoice ----------
   Generated once the order is fully paid. Holds what the documents need besides
   the order itself (Regulamento Aduaneiro, art. 557): packages, weights, countries,
   Incoterm, ports, freight and other costs, payment terms, unit per item. */
const TRANSPORTS = ["sea", "air", "road", "rail", "multimodal"];

// Money received for an order, in its currency (paid income entries linked to it).
export function receivedFor(fin, pf) {
  return Math.round(fin.entries
    .filter((e) => e.proformaId === pf.id && e.type === "in" && e.status === "paid" && e.currency === pf.currency)
    .reduce((t, e) => t + e.amount, 0) * 100) / 100;
}

function cleanInvoice(body, pf) {
  const n = (v) => (v === "" || v == null ? null : num(v));
  const inv = {
    number: text(body.number, 40),
    date: isoDate(body.date),
    incoterm: pf.incoterm || (INCOTERMS.includes(body.incoterm) ? body.incoterm : null),
    incotermPlace: pf.incotermPlace || text(body.incotermPlace, 80),
    transport: TRANSPORTS.includes(body.transport) ? body.transport : null,
    portLoading: text(body.portLoading, 80),
    portDischarge: text(body.portDischarge, 80),
    originCountry: text(body.originCountry, 60),
    acquisitionCountry: text(body.acquisitionCountry, 60),
    provenanceCountry: text(body.provenanceCountry, 60),
    paymentTerms: text(body.paymentTerms, 500),
    buyer: text(body.buyer, 500),
    packagesQty: Number.isInteger(Number(body.packagesQty)) && Number(body.packagesQty) > 0 ? Number(body.packagesQty) : null,
    packagesKind: text(body.packagesKind, 80),
    marks: text(body.marks, 300),
    grossWeight: n(body.grossWeight),
    netWeight: n(body.netWeight),
    volumeM3: n(body.volumeM3),
    freight: n(body.freight),
    insurance: n(body.insurance),
    otherCosts: n(body.otherCosts),
    otherCostsLabel: text(body.otherCostsLabel, 80),
    notes: text(body.notes, 1000),
    items: {},
  };
  const raw = body.items && typeof body.items === "object" ? body.items : {};
  for (const i of pf.items) {
    const r = raw[i.id] || {};
    inv.items[i.id] = { unit: text(r.unit, 20) || "PCS" };
  }
  const missing = [];
  for (const k of ["number", "date", "incoterm", "incotermPlace", "transport", "portLoading", "portDischarge", "originCountry", "acquisitionCountry",
    "provenanceCountry", "paymentTerms", "packagesQty", "packagesKind", "grossWeight", "netWeight", "volumeM3"]) {
    if (inv[k] == null || inv[k] === "") missing.push(k);
  }
  if (!missing.length && !(inv.grossWeight > 0 && inv.netWeight > 0 && inv.volumeM3 > 0)) missing.push("weights");
  if (!missing.length && inv.netWeight > inv.grossWeight) missing.push("netOverGross");
  return { inv, missing };
}

// Proformas as the admin panel shows them.
export function proformaList(priv, products) {
  // Items saved before SKUs existed show the current code of their product.
  const byId = new Map(products.map((p) => [p.id, p]));
  return priv.proformas.map((pf) => ({
    ...pf,
    items: pf.items.map((i) => ({
      ...i,
      sku: i.sku || skuFor(byId.get(i.productId), i.options.map((o) => o.optionId)),
      // Drafts saved before references existed show the catalog reference.
      clientRef: i.clientRef !== undefined || pf.status === "closed" ? i.clientRef || null : catalogRef(priv, pf.clientId, i.productId, i.options),
    })),
  }));
}

async function handler(req, res) {
  try {
    const session = getSession(req);
    if (!session) return fail(res, 401, "Login required");
    if (req.method !== "GET" && req.method !== "DELETE" && !isJsonRequest(req)) return fail(res, 415, "Expected JSON");

    const { products, priv } = await getAllData();
    const id = queryParam(req, "id");
    const action = queryParam(req, "action");

    if (req.method === "GET") {
      const clientId = queryParam(req, "prices");
      if (clientId) return send(res, 200, { prices: priv.clientPrices[clientId] || {} });
      return send(res, 200, { proformas: proformaList(priv, products) });
    }

    if (req.method === "POST" && !id) {
      const body = await readJson(req);
      const now = new Date().toISOString();
      const proforma = { id: crypto.randomUUID(), status: "draft", createdAt: now, updatedAt: now, createdBy: session.u };
      applyBody(proforma, body, priv, null, products);
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
      // Someone else saved this proforma after this editor opened it: do not undo their change.
      if (body.baseUpdatedAt && current.updatedAt !== body.baseUpdatedAt) return fail(res, 409, "Changed by someone else");
      const proforma = { ...current, updatedAt: new Date().toISOString() };
      applyBody(proforma, body, priv, current, products);
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
      rememberPrices(priv, proforma, proforma.items, now);
      proforma.items = loadDiscounts(priv, proforma, proforma.items);
      addLog(proforma, session.u, "closed", null);
      priv.proformas[index] = proforma;
      await savePrivate(priv);
      return send(res, 200, { proforma });
    }

    // Declared value of each item of an order: what the client declares on their
    // own invoice. Internal control only: it never changes the proforma, its PDF,
    // Excel or web page. Remembered per client for the next orders.
    if (req.method === "POST" && action === "declared") {
      if (current.status !== "closed") return fail(res, 409, "Only orders have declared values");
      const body = await readJson(req);
      const values = body.items && typeof body.items === "object" ? body.items : {};
      const now = new Date().toISOString();
      const memo = (priv.clientDeclared[current.clientId] = priv.clientDeclared[current.clientId] || {});
      const items = current.items.map((item) => {
        if (!Object.hasOwn(values, item.id)) return item;
        const raw = values[item.id];
        const value = raw === "" || raw == null ? null : num(raw);
        if (raw !== "" && raw != null && value == null) return item; // invalid: left as it was
        if (value != null && current.clientId) {
          const m = { value, currency: current.currency, number: current.number, at: now };
          memo[priceKey(item.productId, item.options)] = m; // exact options
          memo[item.productId] = m; // any options (fallback)
        }
        return { ...item, declared: value };
      });
      const proforma = { ...current, items, updatedAt: now };
      const changed = current.items.map((before, n) => ({ before, after: items[n] }))
        .filter((x) => x.before.declared !== x.after.declared)
        .map((x) => ({ type: "discount", item: logItem(x.after), from: x.before.declared == null ? null : x.before.declared, to: x.after.declared == null ? null : x.after.declared }));
      if (changed.length) addLog(proforma, session.u, "discount", changed);
      priv.proformas[index] = proforma;
      await savePrivate(priv);
      return send(res, 200, { proforma });
    }

    // Changes to the items of a closed order (add, remove, quantity, price),
    // without reopening it. Every change goes to the order's log.
    if (req.method === "POST" && action === "amend") {
      if (current.status !== "closed") return fail(res, 409, "Only orders can be amended");
      const body = await readJson(req);
      if (body.baseUpdatedAt && current.updatedAt !== body.baseUpdatedAt) return fail(res, 409, "Changed by someone else");
      const oldById = new Map(current.items.map((i) => [i.id, i]));
      // A row switched to another product or options starts without the old discounted price.
      const items = buildItems(body.items, products, priv, current, current.clientId).map((i) => {
        const o = oldById.get(i.id);
        return o && !sameConfig(o, i) ? { ...i, declared: null } : i;
      });
      const problems = closeProblems({ ...current, items });
      if (problems.length) return send(res, 422, { error: "Cannot amend", problems });
      const changes = itemChanges(current.items, items);
      if (!changes.length) return send(res, 200, { proforma: current });
      const now = new Date().toISOString();
      const proforma = { ...current, updatedAt: now };
      proforma.items = loadDiscounts(priv, proforma, items);
      proforma.totals = totals(proforma.items);
      const touched = new Set(changes.filter((c) => c.type !== "removed").map((c) => c.item.id));
      rememberPrices(priv, proforma, proforma.items.filter((i) => touched.has(i.id)), now);
      addLog(proforma, session.u, "items", changes);
      priv.proformas[index] = proforma;
      await savePrivate(priv);
      return send(res, 200, { proforma });
    }

    // Commercial invoice: saves its data (the panel then makes the PDF). Only for
    // orders whose payments were all received.
    if (req.method === "POST" && action === "invoice") {
      if (current.status !== "closed") return fail(res, 409, "Only orders have invoices");
      const received = receivedFor(await getFinance(), current);
      if (received + 0.005 < current.totals.sale) return send(res, 409, { error: "Not fully paid", received, total: current.totals.sale });
      const { inv, missing } = cleanInvoice(await readJson(req), current);
      if (missing.length) return send(res, 422, { error: "Invoice data missing", missing });
      const now = new Date().toISOString();
      const first = !current.invoice;
      const proforma = { ...current, invoice: { ...inv, savedAt: now, savedBy: session.u }, updatedAt: now };
      addLog(proforma, session.u, first ? "invoice" : "invoiceUpdated", [{ type: "invoice", number: inv.number }]);
      priv.proformas[index] = proforma;
      await savePrivate(priv);
      return send(res, 200, { proforma });
    }

    // Link of the proforma's web page (photos in full size), sent to the client.
    // Created once; works for drafts and closed proformas alike.
    if (req.method === "POST" && action === "share") {
      if (current.shareToken) return send(res, 200, { proforma: current });
      const proforma = { ...current, shareToken: crypto.randomBytes(18).toString("base64url") };
      priv.proformas[index] = proforma;
      await savePrivate(priv);
      return send(res, 200, { proforma });
    }

    if (req.method === "POST" && action === "reopen") {
      const proforma = { ...current, status: "draft", closedAt: null, updatedAt: new Date().toISOString() };
      addLog(proforma, session.u, "reopened", null);
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
