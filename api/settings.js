// Company parameters (Shenzhen Micheng's own details and bank account), used
// later on proformas. Admin-only, stored encrypted with the other private data.
import { send, fail, readJson, isJsonRequest } from "./_lib/http.js";
import { getSession } from "./_lib/auth.js";
import { getPrivate, savePrivate, oneChangeAtATime } from "./_lib/store.js";

const CURRENCIES = ["CNY", "USD", "EUR", "BRL"];
const FIELDS = {
  currency: 3,
  companyName: 160,
  address: 500,
  phone: 60,
  email: 160,
  website: 200,
  bankName: 160,
  bankBeneficiary: 160,
  bankAccount: 80,
  bankSwift: 40,
  bankAddress: 500,
  bankNotes: 1000,
};

async function handler(req, res) {
  try {
    if (!getSession(req)) return fail(res, 401, "Login required");
    const priv = await getPrivate();

    if (req.method === "GET") return send(res, 200, { settings: priv.settings });

    if (req.method === "PUT") {
      if (!isJsonRequest(req)) return fail(res, 415, "Expected JSON");
      const body = await readJson(req);
      const settings = {};
      for (const [key, max] of Object.entries(FIELDS)) {
        settings[key] = String(body[key] || "").replace(/\r\n/g, "\n").trim().slice(0, max);
      }
      if (!CURRENCIES.includes(settings.currency)) settings.currency = "CNY"; // RMB by default
      settings.updatedAt = new Date().toISOString();
      priv.settings = settings;
      await savePrivate(priv);
      return send(res, 200, { settings });
    }

    fail(res, 405, "Method not allowed");
  } catch (e) {
    console.error(e);
    fail(res, /JSON/.test(e.message) ? 400 : 500, /JSON/.test(e.message) ? "Invalid JSON" : "Server error");
  }
}

export default oneChangeAtATime(handler);
