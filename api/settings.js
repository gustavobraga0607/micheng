// Company parameters (Shenzhen Micheng's own details and bank account), used
// on proformas and invoices, plus the company's stamp and signature image.
// Admin-only, stored encrypted with the other private data.
import { send, fail, readJson, isJsonRequest, queryParam } from "./_lib/http.js";
import { getSession } from "./_lib/auth.js";
import { getPrivate, savePrivate, oneChangeAtATime, saveSecretFile, readSecretFile, deleteSecretFile } from "./_lib/store.js";

const CURRENCIES = ["CNY", "USD", "EUR", "BRL"];
const FIELDS = {
  currency: 3,
  companyName: 160,
  companyTaxId: 80,
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

const MAX_STAMP_BYTES = 1.5 * 1024 * 1024;

// Settings as the panel sees them: the stamp only as "there is one" (the image
// itself is served by ?kind=stamp, to a logged-in admin).
export function settingsOut(priv) {
  const s = priv.stamp;
  return { ...priv.settings, stamp: s ? { type: s.type, size: s.size, uploadedAt: s.uploadedAt, by: s.by } : null };
}

function decodeStamp(data) {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ""));
  if (!m) return null;
  const buffer = Buffer.from(m[2], "base64");
  if (buffer.length > MAX_STAMP_BYTES) return null;
  const png = buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  if (!(m[1] === "image/png" ? png : jpeg)) return null;
  return { buffer, type: m[1] };
}

async function handler(req, res) {
  try {
    const session = getSession(req);
    if (!session) return fail(res, 401, "Login required");
    const priv = await getPrivate();

    /* ----- Stamp and signature image ----- */
    if (queryParam(req, "kind") === "stamp") {
      if (req.method === "GET") {
        if (!priv.stamp) return fail(res, 404, "No stamp");
        const buffer = await readSecretFile(priv.stamp.ref);
        res.statusCode = 200;
        res.setHeader("Content-Type", priv.stamp.type);
        res.setHeader("Content-Length", buffer.length);
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        return res.end(buffer);
      }
      if (req.method === "POST") {
        if (!isJsonRequest(req)) return fail(res, 415, "Expected JSON");
        const img = decodeStamp((await readJson(req)).data);
        if (!img) return fail(res, 400, "Unsupported image");
        const old = priv.stamp;
        priv.stamp = { ref: await saveSecretFile(img.buffer), type: img.type, size: img.buffer.length, uploadedAt: new Date().toISOString(), by: session.u };
        await savePrivate(priv);
        if (old) await deleteSecretFile(old.ref);
        return send(res, 200, { settings: settingsOut(priv) });
      }
      if (req.method === "DELETE") {
        const old = priv.stamp;
        priv.stamp = null;
        await savePrivate(priv);
        if (old) await deleteSecretFile(old.ref);
        return send(res, 200, { settings: settingsOut(priv) });
      }
      return fail(res, 405, "Method not allowed");
    }

    if (req.method === "GET") return send(res, 200, { settings: settingsOut(priv) });

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
      return send(res, 200, { settings: settingsOut(priv) });
    }

    fail(res, 405, "Method not allowed");
  } catch (e) {
    console.error(e);
    fail(res, /JSON/.test(e.message) ? 400 : 500, /JSON/.test(e.message) ? "Invalid JSON" : "Server error");
  }
}

export default oneChangeAtATime(handler);
