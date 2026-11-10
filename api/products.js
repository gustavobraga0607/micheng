import crypto from "node:crypto";
import { send, fail, readJson, queryParam, isJsonRequest } from "./_lib/http.js";
import { getSession } from "./_lib/auth.js";
import { getProducts, saveProducts, saveImage, deleteImage } from "./_lib/store.js";
import { translateAll, LANGS } from "./_lib/translate.js";

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 2000;

function decodeImage(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) throw new Error("Unsupported image. Use JPG, PNG or WEBP.");
  const buffer = Buffer.from(m[2], "base64");
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Image is too large (max 3 MB).");
  // Check the file signature so the declared type cannot lie.
  const sig = buffer.subarray(0, 12);
  const isJpeg = sig[0] === 0xff && sig[1] === 0xd8;
  const isPng = sig.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isWebp = sig.subarray(0, 4).toString() === "RIFF" && sig.subarray(8, 12).toString() === "WEBP";
  const ok = { "image/jpeg": isJpeg, "image/png": isPng, "image/webp": isWebp }[m[1]];
  if (!ok) throw new Error("The file is not a valid image.");
  return { buffer, contentType: m[1] };
}

function cleanText(value, max) {
  return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

function cleanTranslations(obj, max) {
  if (!obj || typeof obj !== "object") return null;
  const out = {};
  for (const l of LANGS) out[l] = cleanText(obj[l], max);
  return out;
}

async function applyTexts(product, body, existing) {
  const lang = LANGS.includes(body.lang) ? body.lang : null;
  const name = cleanText(body.name, MAX_NAME);
  const description = cleanText(body.description, MAX_DESCRIPTION);
  const manualName = cleanTranslations(body.translations && body.translations.name, MAX_NAME);
  const manualDesc = cleanTranslations(body.translations && body.translations.description, MAX_DESCRIPTION);
  const force = Boolean(body.retranslate);
  let translationOk = existing ? existing.translationOk !== false : true;

  if (!existing || force || name !== existing.source.name || lang !== existing.source.langHint) {
    const r = await translateAll(name, lang);
    product.name = r.values;
    product.source = { ...(product.source || {}), name, lang: r.source, langHint: lang };
    translationOk = r.ok;
  } else if (manualName) {
    product.name = manualName;
  }

  if (!existing || force || description !== existing.source.description || lang !== existing.source.langHint) {
    const r = await translateAll(description, lang || product.source.lang);
    product.description = r.values;
    product.source.description = description;
    translationOk = translationOk && r.ok;
  } else if (manualDesc) {
    product.description = manualDesc;
  }
  product.translationOk = translationOk;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const products = await getProducts();
      return send(res, 200, { products });
    }

    if (!getSession(req)) return fail(res, 401, "Login required");
    if (req.method !== "DELETE" && !isJsonRequest(req)) return fail(res, 415, "Expected JSON");

    const products = await getProducts();
    const id = queryParam(req, "id");

    if (req.method === "POST") {
      const body = await readJson(req);
      if (!cleanText(body.name, MAX_NAME)) return fail(res, 400, "Name is required");
      if (!body.image) return fail(res, 400, "Photo is required");
      const image = decodeImage(body.image);
      const now = new Date().toISOString();
      const product = { id: crypto.randomUUID(), createdAt: now, updatedAt: now };
      await applyTexts(product, body, null);
      product.image = await saveImage(product.id, image.buffer, image.contentType);
      products.unshift(product);
      await saveProducts(products);
      return send(res, 201, { product });
    }

    const index = products.findIndex((p) => p.id === id);
    if (index < 0) return fail(res, 404, "Product not found");

    if (req.method === "PUT") {
      const body = await readJson(req);
      if (!cleanText(body.name, MAX_NAME)) return fail(res, 400, "Name is required");
      const existing = products[index];
      const product = JSON.parse(JSON.stringify(existing));
      await applyTexts(product, body, existing);
      if (body.image) {
        const image = decodeImage(body.image);
        product.image = await saveImage(product.id, image.buffer, image.contentType);
        await deleteImage(existing.image);
      }
      product.updatedAt = new Date().toISOString();
      products[index] = product;
      await saveProducts(products);
      return send(res, 200, { product });
    }

    if (req.method === "DELETE") {
      const [removed] = products.splice(index, 1);
      await saveProducts(products);
      await deleteImage(removed.image);
      return send(res, 200, { ok: true });
    }

    fail(res, 405, "Method not allowed");
  } catch (e) {
    console.error(e);
    const clientError = /image|Unsupported|JSON/i.test(e.message);
    fail(res, clientError ? 400 : 500, clientError ? e.message : "Server error");
  }
}
