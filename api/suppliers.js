// Suppliers: admin-only. Every method requires a logged-in session, and the
// data is stored encrypted (see getPrivate/savePrivate in _lib/store.js).
import crypto from "node:crypto";
import { send, fail, readJson, queryParam, isJsonRequest } from "./_lib/http.js";
import { getSession } from "./_lib/auth.js";
import { getPrivate, savePrivate, productLinks, oneChangeAtATime } from "./_lib/store.js";

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

// A product supplier needs every field except website and phone/WhatsApp.
const REQUIRED_FOR_PRODUCTS = ["contact", "wechat", "email", "city", "notes"];
function missingFields(data) {
  const missing = [];
  if (!data.company) missing.push("company");
  if (!data.productSupplier) return missing;
  for (const f of REQUIRED_FOR_PRODUCTS) if (!data[f]) missing.push(f);
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) missing.push("email");
  if (!data.categories.length) missing.push("categories");
  return [...new Set(missing)];
}

// Adds the ids of the products each supplier is linked to.
export function withProducts(priv) {
  return priv.suppliers.map((s) => ({
    ...s,
    productIds: Object.keys(priv.productSuppliers).filter((pid) => productLinks(priv, pid).some((l) => l.supplierId === s.id)),
  }));
}

async function handler(req, res) {
  try {
    if (!getSession(req)) return fail(res, 401, "Login required");
    if (req.method !== "GET" && req.method !== "DELETE" && !isJsonRequest(req)) return fail(res, 415, "Expected JSON");

    const priv = await getPrivate();

    if (req.method === "GET") return send(res, 200, { suppliers: withProducts(priv) });

    if (req.method === "POST") {
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

    if (req.method === "PUT") {
      const data = clean(await readJson(req));
      const missing = missingFields(data);
      if (missing.length) return send(res, 400, { error: "Required fields missing", missing });
      priv.suppliers[index] = { ...priv.suppliers[index], ...data, updatedAt: new Date().toISOString() };
      await savePrivate(priv);
      return send(res, 200, { supplier: withProducts(priv)[index] });
    }

    if (req.method === "DELETE") {
      priv.suppliers.splice(index, 1);
      for (const pid of Object.keys(priv.productSuppliers)) {
        priv.productSuppliers[pid] = productLinks(priv, pid).filter((l) => l.supplierId !== id);
        if (!priv.productSuppliers[pid].length) delete priv.productSuppliers[pid];
      }
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
