import crypto from "node:crypto";
import { send, fail, readJson, queryParam, isJsonRequest } from "./_lib/http.js";
import { getSession } from "./_lib/auth.js";
import { getProducts, saveProducts, saveProductsAndPrivate, saveImage, copyImage, deleteImage, getPrivate, productLinks, withDataLock, oneChangeAtATime } from "./_lib/store.js";
import { translateAll, detectLanguage, LANGS } from "./_lib/translate.js";
import { assignSkus } from "./_lib/sku.js";
import { parseDecimal } from "./_lib/decimal.js";

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 2000;
// Same categories as the home page cards.
const CATEGORIES = ["building", "sanitary", "fitness", "general"];

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

// Translations given for every language (e.g. a bulk import): used as they are.
function fullTranslations(obj, max) {
  const t = cleanTranslations(obj, max);
  return t && LANGS.every((l) => t[l]) ? t : null;
}

async function applyTexts(product, body, existing) {
  const name = cleanText(body.name, MAX_NAME);
  const description = cleanText(body.description, MAX_DESCRIPTION);

  // New product with all translations provided: no detection or machine translation.
  const givenName = !existing && fullTranslations(body.translations && body.translations.name, MAX_NAME);
  if (givenName) {
    const givenDesc = fullTranslations(body.translations.description, MAX_DESCRIPTION);
    product.name = givenName;
    product.description = givenDesc || { en: description, pt: description, es: description, zh: description };
    product.source = { name, description, lang: LANGS.includes(body.lang) ? body.lang : "pt" };
    product.translationOk = Boolean(givenDesc) || !description;
    return;
  }
  const manualName = cleanTranslations(body.translations && body.translations.name, MAX_NAME);
  const manualDesc = cleanTranslations(body.translations && body.translations.description, MAX_DESCRIPTION);
  const force = Boolean(body.retranslate);
  const nameChanged = !existing || force || name !== existing.source.name;
  const descChanged = !existing || force || description !== existing.source.description;

  // The registration language is always detected automatically, from the
  // name and description together, whenever the source text changes.
  let source = existing ? existing.source.lang : null;
  if (nameChanged || descChanged) source = await detectLanguage(name, description);

  let translationOk = existing ? existing.translationOk !== false : true;
  if (nameChanged) {
    const r = await translateAll(name, source);
    product.name = r.values;
    source = source || r.source;
    translationOk = r.ok;
  } else if (manualName) {
    product.name = manualName;
  }
  if (descChanged) {
    const r = await translateAll(description, source);
    product.description = r.values;
    source = source || r.source;
    translationOk = translationOk && r.ok;
  } else if (manualDesc) {
    product.description = manualDesc;
  }
  product.source = { name, description, lang: source || null };
  product.translationOk = translationOk;
}

/* ---------- Characteristics (e.g. "Coating": "PVC", "Silicone") ----------
   Each characteristic and option keeps a stable id, so a future proforma can
   record exactly which option was chosen even if its text is edited later.
   Texts are written in the product's language and translated automatically;
   unchanged texts keep their existing translations. */
const MAX_ATTRIBUTES = 10;
const MAX_OPTIONS = 20;
const MAX_ATTR_TEXT = 60;

// Runs async jobs with limited parallelism (keeps the translation API happy
// while staying well inside the function time limit).
async function runLimited(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

// Short words translate badly on their own ("Dourado" became "gold coin"), so a
// characteristic is translated as one line, "Coating: PVC, Silicone", and split
// back. If the split does not match, each text is translated separately.
function splitAttributeLine(line, count) {
  const clean = String(line || "").replace(/^[\s•·*\-–]+/, "").replace(/[.。]\s*$/, "").trim();
  const m = /^([^:：]+)[:：](.*)$/.exec(clean);
  if (!m) return null;
  const options = m[2].split(/[,，、;；]/).map((o) => o.trim()).filter(Boolean);
  if (options.length !== count || !m[1].trim()) return null;
  return { name: m[1].trim(), options };
}

// Keeps acronyms and capitals as written ("PVC", not "pvc"), capitalises the first letter.
function matchCase(source, value) {
  if (!value) return source;
  if (value.toLowerCase() === source.toLowerCase()) return source;
  if (/^\p{Lu}/u.test(source) && /^\p{Ll}/u.test(value)) return value.charAt(0).toUpperCase() + value.slice(1);
  return value;
}

async function translateAttribute(name, options, lang) {
  const line = name + ": " + options.join(", ");
  const r = await translateAll(line, lang);
  const out = { name: {}, options: options.map(() => ({})), ok: r.ok };
  let parsed = r.ok;
  for (const l of LANGS) {
    const parts = splitAttributeLine(r.values[l], options.length);
    if (!parts) { parsed = false; break; }
    out.name[l] = matchCase(name, parts.name);
    parts.options.forEach((o, i) => (out.options[i][l] = matchCase(options[i], o)));
  }
  if (parsed) return out;
  // Fallback: one text at a time.
  const texts = [name].concat(options);
  const each = await runLimited(texts.map((t) => () => translateAll(t, lang)), 4);
  return {
    name: each[0].values,
    options: each.slice(1).map((e) => e.values),
    ok: each.every((e) => e.ok),
  };
}

async function applyAttributes(product, body, existing) {
  if (!Array.isArray(body.attributes)) {
    product.attributes = existing ? existing.attributes || [] : [];
    return true;
  }
  const lang = product.source.lang;
  const force = Boolean(body.retranslate) || Boolean(existing && existing.source.lang !== lang);
  const old = new Map(((existing && existing.attributes) || []).map((a) => [a.id, a]));
  let ok = true;

  const attributes = [];
  for (const raw of body.attributes.slice(0, MAX_ATTRIBUTES)) {
    const name = cleanText(raw && raw.name, MAX_ATTR_TEXT);
    if (!name) continue;
    const prev = old.get(raw.id);
    const prevOptions = new Map(((prev && prev.options) || []).map((o) => [o.id, o]));
    const seen = new Set();
    const options = [];
    for (const rawOpt of (Array.isArray(raw.options) ? raw.options : []).slice(0, MAX_OPTIONS)) {
      const label = cleanText(rawOpt && rawOpt.label, MAX_ATTR_TEXT);
      if (!label || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      const prevOpt = prevOptions.get(rawOpt.id);
      options.push({
        id: prevOpt ? prevOpt.id : crypto.randomUUID(),
        source: label,
        label: prevOpt && prevOpt.source === label ? prevOpt.label : fullTranslations(rawOpt.labelTranslations, MAX_ATTR_TEXT),
      });
    }
    if (!options.length) continue;
    attributes.push({
      id: prev ? prev.id : crypto.randomUUID(),
      source: name,
      name: prev && prev.source === name ? prev.name : fullTranslations(raw.nameTranslations, MAX_ATTR_TEXT),
      options,
    });
  }

  // Only characteristics with new or changed texts are translated again.
  const pending = attributes.filter((a) => force || !a.name || a.options.some((o) => !o.label));
  const results = await runLimited(pending.map((a) => () => translateAttribute(a.source, a.options.map((o) => o.source), lang)), 3);
  pending.forEach((a, i) => {
    a.name = results[i].name;
    a.options.forEach((o, j) => (o.label = results[i].options[j]));
    ok = ok && results[i].ok;
  });

  product.attributes = attributes;
  return ok;
}

// Supplier links are admin-only: they live in the encrypted private data,
// never in the public product list.
const money = parseDecimal; // accepts "15,9" as well as "15.9"

// The helpers below change the private data (priv) in memory; each request reads
// it once and saves it once, since every Blob write counts against a quota.

// Each link carries that supplier's purchase price (cost) for the product and,
// optionally, a price per option combination (variantCosts), which must be one
// of the product's current variants.
// Accepts body.supplierLinks [{ supplierId, cost, variantCosts }] or the older body.supplierIds.
function applySupplierLinks(priv, productId, body, product) {
  let raw = null;
  if (Array.isArray(body.supplierLinks)) raw = body.supplierLinks;
  else if (Array.isArray(body.supplierIds)) raw = body.supplierIds.map((id) => ({ supplierId: id, cost: null }));
  if (!raw) return productLinks(priv, productId);
  const known = new Set(priv.suppliers.map((s) => s.id));
  const seen = new Set();
  const links = [];
  for (const l of raw) {
    const id = String((l && l.supplierId) || "");
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    const variants = (product && product.variantSkus) || {};
    const variantCosts = {};
    for (const [key, value] of Object.entries((l && l.variantCosts) || {})) {
      const c = money(value);
      if (key in variants && c != null) variantCosts[key] = c;
    }
    links.push({ supplierId: id, cost: money(l.cost), variantCosts });
  }
  if (links.length) priv.productSuppliers[productId] = links;
  else delete priv.productSuppliers[productId];
  return links;
}

function withLinks(product, links, refs) {
  return { ...product, supplierLinks: links, supplierIds: links.map((l) => l.supplierId), clientRefs: refs || {} };
}

function adminView(priv, product) {
  return withLinks(product, productLinks(priv, product.id), priv.clientRefs[product.id]);
}

// Client references (the client's own code for this product), one per variant
// (comboKey) or "" for a product without variants. Admin-only (private data).
function applyClientRefs(priv, product, body) {
  if (body.clientRefs && typeof body.clientRefs === "object") {
    const clients = new Set(priv.clients.map((c) => c.id));
    const variants = product.variantSkus || {};
    const hasVariants = Object.keys(variants).length > 0;
    const refs = {};
    for (const [clientId, map] of Object.entries(body.clientRefs)) {
      if (!clients.has(clientId) || !map || typeof map !== "object") continue;
      const clean = {};
      for (const [key, value] of Object.entries(map)) {
        const ref = String(value || "").trim().slice(0, 60);
        if (ref && (hasVariants ? key in variants : key === "")) clean[key] = ref;
      }
      if (Object.keys(clean).length) refs[clientId] = clean;
    }
    if (Object.keys(refs).length) priv.clientRefs[product.id] = refs;
    else delete priv.clientRefs[product.id];
  }
  return priv.clientRefs[product.id] || {};
}

// Gives SKUs, and removes photos and references of variants that no longer
// exist. Returns the photo URLs to delete once the data is saved.
function prepareSkus(products, priv) {
  assignSkus(products, priv);
  const stale = [];
  for (const p of products) {
    for (const key of Object.keys(p.variantImages || {})) {
      if (!(p.variantSkus && key in p.variantSkus)) { stale.push(p.variantImages[key]); delete p.variantImages[key]; }
    }
    const byClient = priv.clientRefs && priv.clientRefs[p.id];
    if (!byClient) continue;
    const hasVariants = Object.keys(p.variantSkus || {}).length > 0;
    for (const map of Object.values(byClient)) {
      for (const key of Object.keys(map)) if (hasVariants ? !(key in p.variantSkus) : key !== "") delete map[key];
    }
  }
  return stale;
}

// Public product list: cached by Vercel's CDN, so site visits do not read the
// database each time (changes show up on the site within about a minute).
function sendPublic(res, products) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=86400");
  res.end(JSON.stringify({ products }));
}

async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const products = await getProducts();
      // The admin panel asks with ?admin=1 (never cached); everyone else gets the cached public list.
      if (queryParam(req, "admin") !== "1") return sendPublic(res, products);
      if (!getSession(req)) return fail(res, 401, "Login required");
      let priv = await getPrivate();
      let list = products;
      // Products saved before SKUs existed get theirs on the first admin load.
      if (assignSkus(products, priv)) {
        [list, priv] = await withDataLock(async () => {
          const fresh = await getProducts(), freshPriv = await getPrivate();
          if (assignSkus(fresh, freshPriv)) await saveProductsAndPrivate(fresh, freshPriv);
          return [fresh, freshPriv];
        });
      }
      return send(res, 200, { products: list.map((p) => adminView(priv, p)) });
    }

    if (!getSession(req)) return fail(res, 401, "Login required");
    if (req.method !== "DELETE" && !isJsonRequest(req)) return fail(res, 415, "Expected JSON");

    const products = await getProducts();
    const id = queryParam(req, "id");

    // Photo of one variant (option combination), sent on its own so requests stay small.
    if (req.method === "POST" && queryParam(req, "action") === "variantImage") {
      const index = products.findIndex((p) => p.id === id);
      if (index < 0) return fail(res, 404, "Product not found");
      const product = products[index];
      const body = await readJson(req);
      const key = String(body.key || "");
      if (!(product.variantSkus && key in product.variantSkus)) return fail(res, 400, "Unknown variant");
      product.variantImages = product.variantImages || {};
      const old = product.variantImages[key];
      if (body.remove) delete product.variantImages[key];
      else {
        const image = decodeImage(body.image);
        product.variantImages[key] = await saveImage(product.id + "-v" + product.variantSkus[key], image.buffer, image.contentType);
      }
      product.updatedAt = new Date().toISOString();
      await saveProducts(products);
      if (old && old !== product.variantImages[key]) await deleteImage(old);
      return send(res, 200, { product: adminView(await getPrivate(), product) });
    }

    if (req.method === "POST") {
      const body = await readJson(req);
      if (!cleanText(body.name, MAX_NAME)) return fail(res, 400, "Name is required");
      if (!CATEGORIES.includes(body.category)) return fail(res, 400, "Category is required");
      // A duplicated product may reuse the original's photo (copied to a new file).
      const copyFrom = !body.image && body.copyImageFrom ? products.find((p) => p.id === body.copyImageFrom) : null;
      if (!body.image && !copyFrom) return fail(res, 400, "Photo is required");
      const image = body.image ? decodeImage(body.image) : null;
      const now = new Date().toISOString();
      const product = { id: crypto.randomUUID(), category: body.category, createdAt: now, updatedAt: now };
      await applyTexts(product, body, null);
      product.translationOk = (await applyAttributes(product, body, null)) && product.translationOk;
      product.image = image
        ? await saveImage(product.id, image.buffer, image.contentType)
        : await copyImage(copyFrom.image, product.id);
      products.unshift(product);
      const priv = await getPrivate();
      const stale = prepareSkus(products, priv);
      const links = applySupplierLinks(priv, product.id, body, product);
      const refs = applyClientRefs(priv, product, body);
      await saveProductsAndPrivate(products, priv);
      for (const url of stale) await deleteImage(url);
      return send(res, 201, { product: withLinks(product, links, refs) });
    }

    const index = products.findIndex((p) => p.id === id);
    if (index < 0) return fail(res, 404, "Product not found");

    if (req.method === "PUT") {
      const body = await readJson(req);
      if (!cleanText(body.name, MAX_NAME)) return fail(res, 400, "Name is required");
      if (!CATEGORIES.includes(body.category)) return fail(res, 400, "Category is required");
      const existing = products[index];
      const product = JSON.parse(JSON.stringify(existing));
      product.category = body.category;
      await applyTexts(product, body, existing);
      product.translationOk = (await applyAttributes(product, body, existing)) && product.translationOk;
      if (body.image) {
        const image = decodeImage(body.image);
        product.image = await saveImage(product.id, image.buffer, image.contentType);
        await deleteImage(existing.image);
      }
      product.updatedAt = new Date().toISOString();
      products[index] = product;
      const priv = await getPrivate();
      const stale = prepareSkus(products, priv);
      const links = applySupplierLinks(priv, product.id, body, product);
      const refs = applyClientRefs(priv, product, body);
      await saveProductsAndPrivate(products, priv);
      for (const url of stale) await deleteImage(url);
      return send(res, 200, { product: withLinks(product, links, refs) });
    }

    if (req.method === "DELETE") {
      const [removed] = products.splice(index, 1);
      const priv = await getPrivate();
      applySupplierLinks(priv, removed.id, { supplierLinks: [] });
      applyClientRefs(priv, removed, { clientRefs: {} });
      await saveProductsAndPrivate(products, priv);
      await deleteImage(removed.image);
      for (const url of Object.values(removed.variantImages || {})) await deleteImage(url);
      return send(res, 200, { ok: true });
    }

    fail(res, 405, "Method not allowed");
  } catch (e) {
    console.error(e);
    const clientError = /image|Unsupported|JSON/i.test(e.message);
    fail(res, clientError ? 400 : 500, clientError ? e.message : "Server error");
  }
}

export default oneChangeAtATime(handler);
