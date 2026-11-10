// Clients: admin-only. Every method requires a logged-in session, and the
// data is stored encrypted together with the suppliers (see _lib/store.js).
import crypto from "node:crypto";
import { send, fail, readJson, queryParam, isJsonRequest } from "./_lib/http.js";
import { getSession } from "./_lib/auth.js";
import { getPrivate, savePrivate, oneChangeAtATime } from "./_lib/store.js";

const FIELDS = {
  name: 160,
  address: 500,
  phone: 60,
  taxId: 80,
};

function clean(body) {
  const out = {};
  for (const [key, max] of Object.entries(FIELDS)) {
    out[key] = String(body[key] || "").replace(/\r\n/g, "\n").trim().slice(0, max);
  }
  return out;
}

async function handler(req, res) {
  try {
    if (!getSession(req)) return fail(res, 401, "Login required");
    if (req.method !== "GET" && req.method !== "DELETE" && !isJsonRequest(req)) return fail(res, 415, "Expected JSON");

    const priv = await getPrivate();

    if (req.method === "GET") return send(res, 200, { clients: priv.clients });

    if (req.method === "POST") {
      const data = clean(await readJson(req));
      if (!data.name) return fail(res, 400, "Client name is required");
      const now = new Date().toISOString();
      const client = { id: crypto.randomUUID(), ...data, createdAt: now, updatedAt: now };
      priv.clients.unshift(client);
      await savePrivate(priv);
      return send(res, 201, { client });
    }

    const id = queryParam(req, "id");
    const index = priv.clients.findIndex((c) => c.id === id);
    if (index < 0) return fail(res, 404, "Client not found");

    if (req.method === "PUT") {
      const data = clean(await readJson(req));
      if (!data.name) return fail(res, 400, "Client name is required");
      priv.clients[index] = { ...priv.clients[index], ...data, updatedAt: new Date().toISOString() };
      await savePrivate(priv);
      return send(res, 200, { client: priv.clients[index] });
    }

    if (req.method === "DELETE") {
      priv.clients.splice(index, 1);
      for (const byClient of Object.values(priv.clientRefs || {})) delete byClient[id]; // their references go too
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
