import crypto from "node:crypto";
import { send, fail, readJson, queryParam, isJsonRequest } from "./_lib/http.js";
import { getSession } from "./_lib/auth.js";
import { getProducts, saveProducts, saveProductsAndPrivate, saveImage, copyImage, deleteImage, getPrivate, getAllData, productLinks, withDataLock, BusyError, appendProductLog, readProductLog } from "./_lib/store.js";
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
      if (Object.hasOwn(variants, key) && c != null) variantCosts[key] = c;
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
        if (ref && (hasVariants ? Object.hasOwn(variants, key) : key === "")) clean[key] = ref;
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
      if (!(p.variantSkus && Object.hasOwn(p.variantSkus, key))) { stale.push(p.variantImages[key]); delete p.variantImages[key]; }
    }
    const byClient = priv.clientRefs && priv.clientRefs[p.id];
    if (!byClient) continue;
    const hasVariants = Object.keys(p.variantSkus || {}).length > 0;
    for (const map of Object.values(byClient)) {
      for (const key of Object.keys(map)) if (hasVariants ? !(Object.hasOwn(p.variantSkus, key)) : key !== "") delete map[key];
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

// Changes are made in two steps: the slow work (machine translation, photo
// upload) first, without holding up anyone else; then, taking turns with the
// other admins (withDataLock), the latest data is read, the change is applied
// and saved in a moment.
/* ---------- Change log: who changed what in each product, and when ---------- */
const short = (v, max = 300) => { const t = String(v == null ? "" : v); return t.length > max ? t.slice(0, max) + "…" : t; };
// Everything the log compares, from the product and its private data (suppliers, client codes).
function logView(priv, product) {
  if (!product) return null;
  return JSON.parse(JSON.stringify({ ...product, links: productLinks(priv, product.id), refs: priv.clientRefs[product.id] || {} }));
}
function variantCode(p, key) {
  const n = p.variantSkus && p.variantSkus[key];
  return n ? p.sku + "-" + n : String(p.sku || "") + (key ? " (" + key.slice(0, 8) + ")" : "");
}
function diffProduct(before, after, priv) {
  const out = [];
  const supName = (id) => { const s = priv.suppliers.find((x) => x.id === id); return s ? s.company : "?"; };
  const cliName = (id) => { const c = priv.clients.find((x) => x.id === id); return c ? c.name : "?"; };
  const srcLang = (after.source && after.source.lang) || "pt";
  // Name and description: the text typed (a new text is translated again, so the
  // translations are logged only when they were edited by themselves).
  const src = (p, k) => (p.source && p.source[k]) || "";
  const sameSrcName = src(before, "name") === src(after, "name");
  if (!sameSrcName) out.push({ t: "name", from: short(before.source && before.source.name), to: short(after.source && after.source.name) });
  else for (const l of Object.keys(after.name || {})) if (l !== srcLang && ((before.name || {})[l] || "") !== (after.name[l] || "")) out.push({ t: "nameTr", lang: l, from: short(before.name[l]), to: short(after.name[l]) });
  const sameSrcDesc = src(before, "description") === src(after, "description");
  if (!sameSrcDesc) out.push({ t: "description", from: short(before.source && before.source.description), to: short(after.source && after.source.description) });
  else for (const l of Object.keys(after.description || {})) if (l !== srcLang && ((before.description || {})[l] || "") !== (after.description[l] || "")) out.push({ t: "descriptionTr", lang: l, from: short(before.description[l]), to: short(after.description[l]) });
  if (before.category !== after.category) out.push({ t: "category", from: before.category, to: after.category });
  // Characteristics and their options
  const attrs = (p) => new Map((p.attributes || []).map((a) => [a.id, a]));
  const A = attrs(before), B = attrs(after);
  for (const [id, a] of A) if (!B.has(id)) out.push({ t: "attrRemoved", attr: a.source });
  for (const [id, b] of B) {
    const a = A.get(id);
    if (!a) { out.push({ t: "attrAdded", attr: b.source, options: b.options.map((o) => o.source) }); continue; }
    if (a.source !== b.source) out.push({ t: "attrRenamed", from: a.source, to: b.source });
    const ao = new Map(a.options.map((o) => [o.id, o])), bo = new Map(b.options.map((o) => [o.id, o]));
    for (const [oid, o] of ao) if (!bo.has(oid)) out.push({ t: "optRemoved", attr: b.source, option: o.source });
    for (const [oid, o] of bo) {
      if (!ao.has(oid)) out.push({ t: "optAdded", attr: b.source, option: o.source });
      else if (ao.get(oid).source !== o.source) out.push({ t: "optRenamed", attr: b.source, from: ao.get(oid).source, to: o.source });
    }
  }
  // Photos
  if (before.image !== after.image) out.push({ t: "photo" });
  const vb = before.variantImages || {}, va = after.variantImages || {};
  for (const k of new Set([...Object.keys(vb), ...Object.keys(va)])) {
    if (vb[k] !== va[k]) out.push({ t: va[k] ? "variantPhoto" : "variantPhotoRemoved", code: variantCode(after, k) });
  }
  // Suppliers and purchase prices
  const lb = new Map((before.links || []).map((l) => [l.supplierId, l])), la = new Map((after.links || []).map((l) => [l.supplierId, l]));
  for (const [sid] of lb) if (!la.has(sid)) out.push({ t: "supRemoved", supplier: supName(sid) });
  for (const [sid, l] of la) {
    const o = lb.get(sid);
    if (!o) { out.push({ t: "supAdded", supplier: supName(sid), cost: l.cost }); }
    else if (o.cost !== l.cost) out.push({ t: "cost", supplier: supName(sid), from: o.cost, to: l.cost });
    const vo = (o && o.variantCosts) || {}, vn = l.variantCosts || {};
    for (const k of new Set([...Object.keys(vo), ...Object.keys(vn)])) {
      if (vo[k] !== vn[k]) out.push({ t: "variantCost", supplier: supName(sid), code: variantCode(after, k), from: vo[k] == null ? null : vo[k], to: vn[k] == null ? null : vn[k] });
    }
  }
  // Codes the clients use for the product
  const rb = before.refs || {}, ra = after.refs || {};
  for (const cid of new Set([...Object.keys(rb), ...Object.keys(ra)])) {
    const mb = rb[cid] || {}, ma = ra[cid] || {};
    for (const k of new Set([...Object.keys(mb), ...Object.keys(ma)])) {
      if ((mb[k] || "") !== (ma[k] || "")) out.push({ t: "clientRef", client: cliName(cid), code: k ? variantCode(after, k) : "", from: mb[k] || "", to: ma[k] || "" });
    }
  }
  return out;
}
function logEntry(session, action, product, changes) {
  return { id: crypto.randomUUID(), at: new Date().toISOString(), user: session.u, action, productId: product.id, sku: product.sku || null,
    name: short((product.source && product.source.name) || (product.name && (product.name.pt || product.name.en)) || "", 160), changes };
}
async function writeLog(entries) {
  // The change is already saved: a failure to log must not turn it into an error.
  try { await appendProductLog(entries.filter(Boolean)); } catch (e) { console.error("Product log", e.message); }
}

async function handler(req, res) {
  const uploaded = []; // photos sent in this request: removed again if it fails
  try {
    if (req.method === "GET") {
      const products = await getProducts();
      // The admin panel asks with ?admin=1 (never cached); everyone else gets the cached public list.
      if (queryParam(req, "log") === "1") {
        if (!getSession(req)) return fail(res, 401, "Login required");
        const pid = queryParam(req, "id");
        const log = await readProductLog();
        return send(res, 200, { log: pid ? log.filter((e) => e.productId === pid) : log });
      }
      if (queryParam(req, "admin") !== "1") return sendPublic(res, products);
      if (!getSession(req)) return fail(res, 401, "Login required");
      return send(res, 200, { products: await adminProducts(products, await getPrivate()) });
    }

    const session = getSession(req);
    if (!session) return fail(res, 401, "Login required");
    if (req.method !== "DELETE" && !isJsonRequest(req)) return fail(res, 415, "Expected JSON");
    const id = queryParam(req, "id");

    // Photo of one variant (option combination), sent on its own so requests stay small.
    if (req.method === "POST" && queryParam(req, "action") === "variantImage") {
      const body = await readJson(req);
      const key = String(body.key || "");
      let url = null;
      if (!body.remove) {
        const image = decodeImage(body.image);
        const current = (await getProducts()).find((p) => p.id === id);
        if (!current) return fail(res, 404, "Product not found");
        if (!(current.variantSkus && Object.hasOwn(current.variantSkus, key))) return fail(res, 400, "Unknown variant");
        url = await saveImage(current.id + "-v" + current.variantSkus[key], image.buffer, image.contentType);
        uploaded.push(url);
      }
      const result = await withDataLock(async () => {
        const products = await getProducts();
        const product = products.find((p) => p.id === id);
        if (!product) return { status: 404, error: "Product not found" };
        if (!(product.variantSkus && Object.hasOwn(product.variantSkus, key))) return { status: 400, error: "Unknown variant" };
        product.variantImages = product.variantImages || {};
        const old = product.variantImages[key];
        if (url) product.variantImages[key] = url;
        else delete product.variantImages[key];
        product.updatedAt = new Date().toISOString();
        await saveProducts(products);
        return { product, old, priv: await getPrivate() };
      });
      if (!result.error) await writeLog([logEntry(session, "updated", result.product, [{ t: url ? "variantPhoto" : "variantPhotoRemoved", code: variantCode(result.product, key) }])]);
      if (result.error) { await cleanup(uploaded); return fail(res, result.status, result.error); }
      uploaded.length = 0;
      if (result.old && result.old !== url) await deleteImage(result.old);
      return send(res, 200, { product: adminView(result.priv, result.product) });
    }

    if (req.method === "POST") {
      const body = await readJson(req);
      if (!cleanText(body.name, MAX_NAME)) return fail(res, 400, "Name is required");
      if (!CATEGORIES.includes(body.category)) return fail(res, 400, "Category is required");
      // A duplicated product may reuse the original's photo (copied to a new file).
      const copyFrom = !body.image && body.copyImageFrom ? (await getProducts()).find((p) => p.id === body.copyImageFrom) : null;
      if (!body.image && !copyFrom) return fail(res, 400, "Photo is required");
      const image = body.image ? decodeImage(body.image) : null;
      const now = new Date().toISOString();
      const product = { id: crypto.randomUUID(), category: body.category, createdAt: now, updatedAt: now };
      await applyTexts(product, body, null);
      product.translationOk = (await applyAttributes(product, body, null)) && product.translationOk;
      product.image = image
        ? await saveImage(product.id, image.buffer, image.contentType)
        : await copyImage(copyFrom.image, product.id);
      uploaded.push(product.image);
      const { links, refs, stale, entry } = await withDataLock(async () => {
        const { products, priv } = await getAllData();
        products.unshift(product);
        const stale = prepareSkus(products, priv);
        const links = applySupplierLinks(priv, product.id, body, product);
        const refs = applyClientRefs(priv, product, body);
        await saveProductsAndPrivate(products, priv);
        const after = logView(priv, product);
        const empty = { source: {}, name: {}, description: {}, attributes: [], links: [], refs: {}, variantImages: {}, image: after.image };
        return { links, refs, stale, entry: logEntry(session, body.copyImageFrom ? "duplicated" : "created", product, diffProduct(empty, after, priv)) };
      });
      uploaded.length = 0;
      await writeLog([entry]);
      await cleanup(stale);
      return send(res, 201, { product: withLinks(product, links, refs) });
    }

    if (req.method === "PUT") {
      const body = await readJson(req);
      if (!cleanText(body.name, MAX_NAME)) return fail(res, 400, "Name is required");
      if (!CATEGORIES.includes(body.category)) return fail(res, 400, "Category is required");
      const existing = (await getProducts()).find((p) => p.id === id);
      if (!existing) return fail(res, 404, "Product not found");
      const product = JSON.parse(JSON.stringify(existing));
      product.category = body.category;
      await applyTexts(product, body, existing);
      product.translationOk = (await applyAttributes(product, body, existing)) && product.translationOk;
      let newImage = null;
      if (body.image) {
        const image = decodeImage(body.image);
        newImage = await saveImage(product.id, image.buffer, image.contentType);
        uploaded.push(newImage);
      }
      const result = await withDataLock(async () => {
        const { products, priv } = await getAllData();
        const index = products.findIndex((p) => p.id === id);
        if (index < 0) return null;
        // Someone else saved this product after this form was opened: do not undo their change.
        if (body.baseUpdatedAt && products[index].updatedAt !== body.baseUpdatedAt) return { conflict: true };
        // Keep what may have changed meanwhile and is not part of this form
        // (codes, variant photos, the main photo when no new one was sent).
        const fresh = products[index];
        const before = logView(priv, fresh);
        for (const k of ["sku", "variantSkus", "variantSeq", "variantImages", "image", "createdAt"]) {
          if (fresh[k] === undefined) delete product[k];
          else product[k] = fresh[k];
        }
        const oldImage = fresh.image;
        if (newImage) product.image = newImage;
        product.updatedAt = new Date().toISOString();
        products[index] = product;
        const stale = prepareSkus(products, priv);
        const links = applySupplierLinks(priv, product.id, body, product);
        const refs = applyClientRefs(priv, product, body);
        await saveProductsAndPrivate(products, priv);
        const changes = diffProduct(before, logView(priv, product), priv);
        return { links, refs, stale: newImage && oldImage !== newImage ? stale.concat(oldImage) : stale,
          entry: changes.length ? logEntry(session, "updated", product, changes) : null };
      });
      if (!result) { await cleanup(uploaded); return fail(res, 404, "Product not found"); }
      if (result.conflict) { await cleanup(uploaded); return fail(res, 409, "Changed by someone else"); }
      uploaded.length = 0;
      await writeLog([result.entry]);
      await cleanup(result.stale);
      return send(res, 200, { product: withLinks(product, result.links, result.refs) });
    }

    if (req.method === "DELETE") {
      const removed = await withDataLock(async () => {
        const { products, priv } = await getAllData();
        const index = products.findIndex((p) => p.id === id);
        if (index < 0) return null;
        const [gone] = products.splice(index, 1);
        const entry = logEntry(session, "deleted", gone, []);
        applySupplierLinks(priv, gone.id, { supplierLinks: [] });
        applyClientRefs(priv, gone, { clientRefs: {} });
        forgetPrices(priv, gone.id);
        await saveProductsAndPrivate(products, priv);
        // Proformas show the product's photos: keep them while one still lists it.
        const inProforma = priv.proformas.some((pf) => pf.items.some((i) => i.productId === gone.id));
        return { gone, keepPhotos: inProforma, entry };
      });
      if (!removed) return fail(res, 404, "Product not found");
      await writeLog([removed.entry]);
      if (!removed.keepPhotos) await cleanup([removed.gone.image].concat(Object.values(removed.gone.variantImages || {})));
      return send(res, 200, { ok: true });
    }

    fail(res, 405, "Method not allowed");
  } catch (e) {
    await cleanup(uploaded);
    if (e instanceof BusyError) return fail(res, 503, e.message);
    console.error(e);
    const clientError = /image|Unsupported|JSON/i.test(e.message);
    fail(res, clientError ? 400 : 500, clientError ? e.message : "Server error");
  }
}

// Product list as the admin panel shows it (with supplier links and client
// references). Products saved before SKUs existed get theirs here.
export async function adminProducts(products, priv) {
  if (assignSkus(products, priv)) {
    ({ products, priv } = await withDataLock(async () => {
      const fresh = await getAllData();
      if (assignSkus(fresh.products, fresh.priv)) await saveProductsAndPrivate(fresh.products, fresh.priv);
      return fresh;
    }));
  }
  return products.map((p) => adminView(priv, p));
}

async function cleanup(urls) {
  for (const url of urls) if (url) await deleteImage(url);
}

// Remembered sale prices of a deleted product are no longer needed.
function forgetPrices(priv, productId) {
  for (const prices of Object.values(priv.clientPrices || {}).concat(Object.values(priv.clientDeclared || {}))) {
    for (const key of Object.keys(prices)) if (key === productId || key.startsWith(productId + "|")) delete prices[key];
  }
}

export default handler;
