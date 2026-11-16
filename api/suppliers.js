// Suppliers: admin-only. Every method requires a logged-in session, and the
// data is stored encrypted (see getPrivate/savePrivate in _lib/store.js).
import crypto from "node:crypto";
import { send, fail, readJson, queryParam, isJsonRequest } from "./_lib/http.js";
import { getSession } from "./_lib/auth.js";
import { getPrivate, savePrivate, productLinks, oneChangeAtATime, saveSecretFile, readSecretFile, deleteSecretFile } from "./_lib/store.js";

const CATEGORIES = ["building", "sanitary", "fitness", "general"];

const FIELDS = {
  company: 120,
  contact: 120,
  phone: 60,
  wechat: 60,
  email: 160,
  city: 160,
  website: 200,
  notes: 2000,
};

function clean(body) {
  const out = {};
  for (const [key, max] of Object.entries(FIELDS)) {
    out[key] = String(body[key] || "").replace(/\r\n/g, "\n").trim().slice(0, max);
  }
  // Supplies products (shown in the product form) or only usual expenses
  // such as rent, freight or services. Suppliers saved before this existed count as product suppliers.
  out.productSupplier = body.productSupplier === undefined ? true : Boolean(body.productSupplier);
  // Product categories the supplier works with (one or more); the product form
  // only offers suppliers of the product's category.
  const cats = Array.isArray(body.categories) ? body.categories : [];
  out.categories = CATEGORIES.filter((c) => cats.includes(c));
  return out;
}

// A product supplier needs every field except website, phone/WhatsApp and notes.
const REQUIRED_FOR_PRODUCTS = ["contact", "wechat", "email", "city"];
function missingFields(data) {
  const missing = [];
  if (!data.company) missing.push("company");
  if (!data.productSupplier) return missing;
  for (const f of REQUIRED_FOR_PRODUCTS) if (!data[f]) missing.push(f);
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) missing.push("email");
  if (!data.categories.length) missing.push("categories");
  return [...new Set(missing)];
}

/* ---------- Supplier catalogs (product suppliers) ----------
   Files of up to 50 MB, kept encrypted like the finance attachments. A request
   to Vercel is limited to about 4.5 MB, so a file travels in parts of 3 MB:
   each part is stored on its own (?kind=part) and the catalog lists them in
   order (?kind=catalog); the panel reads the parts back and joins them. */
const PART_BYTES = 3 * 1024 * 1024;
const MAX_CATALOG_BYTES = 50 * 1024 * 1024;
const MAX_PARTS = Math.ceil(MAX_CATALOG_BYTES / PART_BYTES);
const CATALOG_TYPES = [
  "application/pdf", "image/jpeg", "image/png", "image/webp",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
];
// Only references to our own encrypted files.
const isPartRef = (r) => typeof r === "string" && (/^local:[\w-]+\.bin$/.test(r) || /^https:\/\/[\w.-]+\.public\.blob\.vercel-storage\.com\/private\/files\//.test(r));
const catalogOut = (c) => ({ id: c.id, name: c.name, type: c.type, size: c.size, parts: c.parts.length, uploadedAt: c.uploadedAt, by: c.by });

async function deleteParts(refs) {
  for (const r of refs) await deleteSecretFile(r).catch((e) => console.warn("Could not delete a catalog part", e.message));
}

// Adds the ids of the products each supplier is linked to.
export function withProducts(priv) {
  return priv.suppliers.map((s) => ({
    ...s,
    catalogs: (s.catalogs || []).map(catalogOut),
    productIds: Object.keys(priv.productSuppliers).filter((pid) => productLinks(priv, pid).some((l) => l.supplierId === s.id)),
  }));
}

async function handler(req, res) {
  try {
    if (!getSession(req)) return fail(res, 401, "Login required");
    if (req.method !== "GET" && req.method !== "DELETE" && !isJsonRequest(req)) return fail(res, 415, "Expected JSON");

    const priv = await getPrivate();

    if (req.method === "GET" && !queryParam(req, "kind")) return send(res, 200, { suppliers: withProducts(priv) });

    if (req.method === "POST" && !queryParam(req, "id")) {
      const data = clean(await readJson(req));
      const missing = missingFields(data);
      if (missing.length) return send(res, 400, { error: "Required fields missing", missing });
      const now = new Date().toISOString();
      const supplier = { id: crypto.randomUUID(), ...data, createdAt: now, updatedAt: now };
      priv.suppliers.unshift(supplier);
      await savePrivate(priv);
      return send(res, 201, { supplier: { ...supplier, productIds: [] } });
    }

    const id = queryParam(req, "id");
    const index = priv.suppliers.findIndex((s) => s.id === id);
    if (index < 0) return fail(res, 404, "Supplier not found");

    const kind = queryParam(req, "kind");
    const supplier = priv.suppliers[index];
    // One part of a catalog being uploaded (base64 in JSON).
    if (kind === "part" && req.method === "POST") {
      const data = String((await readJson(req)).data || "");
      if (!/^[A-Za-z0-9+/=]+$/.test(data)) return fail(res, 400, "Invalid part");
      const buffer = Buffer.from(data, "base64");
      if (!buffer.length || buffer.length > PART_BYTES) return fail(res, 400, "Invalid part");
      return send(res, 200, { ref: await saveSecretFile(buffer) });
    }
    // Parts of an upload that failed: removed.
    if (kind === "discard" && req.method === "POST") {
      const refs = (await readJson(req)).refs;
      await deleteParts((Array.isArray(refs) ? refs : []).filter(isPartRef).slice(0, MAX_PARTS));
      return send(res, 200, { ok: true });
    }
    if (kind === "catalog") {
      const catalogs = supplier.catalogs || [];
      if (req.method === "POST") {
        const body = await readJson(req);
        const refs = Array.isArray(body.refs) ? body.refs : [];
        const size = Number(body.size);
        if (!CATALOG_TYPES.includes(body.type)) return fail(res, 400, "Unsupported file");
        if (!refs.length || refs.length > MAX_PARTS || !refs.every(isPartRef) || !(size > 0) || size > MAX_CATALOG_BYTES) return fail(res, 400, "Invalid file");
        const name = String(body.name || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 160) || "catalog";
        const file = { id: crypto.randomUUID(), name, type: body.type, size, parts: refs, uploadedAt: new Date().toISOString(), by: getSession(req).u };
        priv.suppliers[index] = { ...supplier, catalogs: catalogs.concat(file) };
        await savePrivate(priv);
        return send(res, 200, { supplier: withProducts(priv)[index] });
      }
      const file = catalogs.find((c) => c.id === queryParam(req, "file"));
      if (!file) return fail(res, 404, "File not found");
      if (req.method === "GET") {
        const n = Number(queryParam(req, "part") || 0);
        if (!Number.isInteger(n) || n < 0 || n >= file.parts.length) return fail(res, 404, "Part not found");
        const buffer = await readSecretFile(file.parts[n]);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", buffer.length);
        res.setHeader("Cache-Control", "private, no-store");
        return res.end(buffer);
      }
      if (req.method === "DELETE") {
        priv.suppliers[index] = { ...supplier, catalogs: catalogs.filter((c) => c.id !== file.id) };
        await savePrivate(priv);
        await deleteParts(file.parts);
        return send(res, 200, { supplier: withProducts(priv)[index] });
      }
      return fail(res, 405, "Method not allowed");
    }

    if (req.method === "PUT") {
      const data = clean(await readJson(req));
      const missing = missingFields(data);
      if (missing.length) return send(res, 400, { error: "Required fields missing", missing });
      priv.suppliers[index] = { ...priv.suppliers[index], ...data, updatedAt: new Date().toISOString() };
      await savePrivate(priv);
      return send(res, 200, { supplier: withProducts(priv)[index] });
    }

    if (req.method === "DELETE") {
      const gone = priv.suppliers.splice(index, 1)[0];
      for (const pid of Object.keys(priv.productSuppliers)) {
        priv.productSuppliers[pid] = productLinks(priv, pid).filter((l) => l.supplierId !== id);
        if (!priv.productSuppliers[pid].length) delete priv.productSuppliers[pid];
      }
      await savePrivate(priv);
      for (const c of gone.catalogs || []) await deleteParts(c.parts);
      return send(res, 200, { ok: true });
    }

    fail(res, 405, "Method not allowed");
  } catch (e) {
    console.error(e);
    fail(res, /JSON/.test(e.message) ? 400 : 500, /JSON/.test(e.message) ? "Invalid JSON" : "Server error");
  }
}

export default oneChangeAtATime(handler);
