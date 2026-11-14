// Company parameters (Shenzhen Micheng's own details and bank account), used
// on proformas and invoices, plus the company's stamp and signature image.
// Admin-only, stored encrypted with the other private data. The WhatsApp number,
// WeChat ID and WeChat QR code shown on the public site are also kept in a
// separate public record (?kind=contact, readable without a login).
import { send, fail, readJson, isJsonRequest, queryParam } from "./_lib/http.js";
import { getSession } from "./_lib/auth.js";
import { getPrivate, savePrivate, oneChangeAtATime, saveSecretFile, readSecretFile, deleteSecretFile, getContact, saveContact } from "./_lib/store.js";

const CURRENCIES = ["CNY", "USD", "EUR", "BRL"];
const FIELDS = {
  currency: 3,
  companyName: 160,
  companyTaxId: 80,
  address: 500,
  phone: 60,
  email: 160,
  website: 200,
  whatsapp: 30,
  wechatId: 60,
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

const MAX_QR_BYTES = 300 * 1024;

// The number as wa.me wants it: digits only, with the country code.
const whatsappDigits = (v) => String(v || "").replace(/\D/g, "").slice(0, 20);

function decodeStamp(data, max = MAX_STAMP_BYTES) {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ""));
  if (!m) return null;
  const buffer = Buffer.from(m[2], "base64");
  if (buffer.length > max) return null;
  const png = buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  if (!(m[1] === "image/png" ? png : jpeg)) return null;
  return { buffer, type: m[1] };
}

async function handler(req, res) {
  try {
    /* ----- Public: contact buttons of the site ----- */
    if (queryParam(req, "kind") === "contact" && req.method === "GET") {
      const c = await getContact();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      // Browsers always ask again; Vercel's CDN keeps it for a minute, so a
      // change shows on the site within about a minute.
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Vercel-CDN-Cache-Control", "max-age=60, stale-while-revalidate=300");
      return res.end(JSON.stringify({ whatsapp: c.whatsapp || "", whatsappLabel: c.whatsappLabel || "", wechatId: c.wechatId || "", wechatQr: c.wechatQr || null }));
    }

    const session = getSession(req);
    if (!session) return fail(res, 401, "Login required");
    const priv = await getPrivate();

    /* ----- WeChat QR code shown on the site ----- */
    if (queryParam(req, "kind") === "wechatqr") {
      if (req.method !== "POST" && req.method !== "DELETE") return fail(res, 405, "Method not allowed");
      const contact = await getContact();
      if (req.method === "POST") {
        if (!isJsonRequest(req)) return fail(res, 415, "Expected JSON");
        const data = (await readJson(req)).data;
        const img = decodeStamp(data, MAX_QR_BYTES);
        if (!img) return fail(res, 400, "Unsupported image");
        contact.wechatQr = "data:" + img.type + ";base64," + img.buffer.toString("base64");
      } else contact.wechatQr = null;
      await saveContact(contact);
      priv.settings = { ...priv.settings, wechatQrAt: contact.wechatQr ? new Date().toISOString() : null };
      await savePrivate(priv);
      return send(res, 200, { settings: settingsOut(priv) });
    }

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
      settings.wechatQrAt = (priv.settings && priv.settings.wechatQrAt) || null;
      priv.settings = settings;
      await savePrivate(priv);
      const contact = await getContact();
      await saveContact({ ...contact, whatsapp: whatsappDigits(settings.whatsapp), whatsappLabel: settings.whatsapp, wechatId: settings.wechatId });
      return send(res, 200, { settings: settingsOut(priv) });
    }

    fail(res, 405, "Method not allowed");
  } catch (e) {
    console.error(e);
    fail(res, /JSON/.test(e.message) ? 400 : 500, /JSON/.test(e.message) ? "Invalid JSON" : "Server error");
  }
}

export default oneChangeAtATime(handler);
