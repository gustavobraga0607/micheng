// Suppliers: admin-only. Every method requires a logged-in session, and the
// data is stored encrypted (see getPrivate/savePrivate in _lib/store.js).
import crypto from "node:crypto";
import { send, fail, readJson, queryParam, isJsonRequest } from "./_lib/http.js";
import { getSession } from "./_lib/auth.js";
import { getPrivate, savePrivate, productLinks, oneChangeAtATime } from "./_lib/store.js";

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
  return out;
}

// Adds the ids of the products each supplier is linked to.
function withProducts(priv) {
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
      if (!data.company) return fail(res, 400, "Company name is required");
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
      if (!data.company) return fail(res, 400, "Company name is required");
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
