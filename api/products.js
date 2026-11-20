import crypto from "node:crypto";
import { send, fail, readJson, queryParam, isJsonRequest } from "./_lib/http.js";
import { getSession } from "./_lib/auth.js";
import { withSync } from "./_lib/integration-sync.js";
import { getProducts, saveProducts, saveProductsAndPrivate, saveImage, copyImage, deleteImage, getPrivate, getAllData, productLinks, withDataLock, BusyError, appendProductLog, readProductLog, savePrivate } from "./_lib/store.js";
import { translateAll, detectLanguage, LANGS } from "./_lib/translate.js";
import { assignSkus, addSpec, comboKey, photoFor } from "./_lib/sku.js";
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
const MAX_TECH_IMAGES = 20;
const MAX_GALLERY = 20;

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

function withLinks(product, links, refs, prices, clientSpecs) {
  return { ...product, supplierLinks: links, supplierIds: links.map((l) => l.supplierId), clientRefs: refs || {}, listPrices: prices || {}, clientSpecs: clientSpecs || {} };
}

function adminView(priv, product) {
  return withLinks(product, productLinks(priv, product.id), priv.clientRefs[product.id], priv.productPrices[product.id], (priv.clientSpecInfo || {})[product.id]);
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
      for (const key of Object.keys(map)) if (key !== "" && !(hasVariants && Object.hasOwn(p.variantSkus, key))) delete map[key];
    }
  }
  return stale;
}

// Public product list: cached by Vercel's CDN, so site visits do not read the
// database each time (changes show up on the site within about a minute).
function sendPublic(res, products) {
  // Technical drawings are internal: not in the public list.
  // The site shows name, photo and description only: specifications and their
  // characteristics, codes and photos stay in the panel.
  // The site shows the characteristics with their options (no specifications, codes or costs).
  // The gallery photos only browse on the site: no link to the characteristics.
  products = products.map(({ techImages, specs, variantSkus, variantSeq, variantImages, gallery, ...rest }) =>
    ({ ...rest, ...(gallery && gallery.length ? { gallery: gallery.map((g) => g.url) } : {}) }));
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
  return JSON.parse(JSON.stringify({ ...product, links: productLinks(priv, product.id), refs: priv.clientRefs[product.id] || {}, prices: priv.productPrices[product.id] || {}, cspecs: (priv.clientSpecInfo || {})[product.id] || {} }));
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
  // Technical drawings
  const tb = new Set((before.techImages || []).map((t) => t.url)), ta = new Set((after.techImages || []).map((t) => t.url));
  const addedT = [...ta].filter((u) => !tb.has(u)).length, removedT = [...tb].filter((u) => !ta.has(u)).length;
  if (addedT) out.push({ t: "techAdded", n: addedT });
  if (removedT) out.push({ t: "techRemoved", n: removedT });
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
  // Gallery photos: added, removed, linked to another option
  const optLabel = (p, oid) => {
    for (const a of p.attributes || []) for (const o of a.options) if (o.id === oid) return a.source + ": " + o.source;
    return null;
  };
  const gb = new Map((before.gallery || []).map((g) => [g.url, g])), ga = new Map((after.gallery || []).map((g) => [g.url, g]));
  for (const [u, g] of ga) {
    if (!gb.has(u)) out.push({ t: "galleryAdded", to: g.optionId ? optLabel(after, g.optionId) : null });
    else if ((gb.get(u).optionId || null) !== (g.optionId || null)) out.push({ t: "galleryLink", from: optLabel(after, gb.get(u).optionId), to: optLabel(after, g.optionId) });
  }
  for (const [u, g] of gb) if (!ga.has(u)) out.push({ t: "galleryRemoved", from: g.optionId ? optLabel(before, g.optionId) : null });
  // Specifications: created, archived / reactivated, details changed
  const vb0 = before.variantSkus || {}, va0 = after.variantSkus || {};
  for (const k of Object.keys(va0)) if (!Object.hasOwn(vb0, k)) out.push({ t: "specAdded", code: variantCode(after, k) });
  for (const k of Object.keys(vb0)) if (!Object.hasOwn(va0, k)) out.push({ t: "specRemoved", code: variantCode(before, k) });
  const sb = before.specs || {}, sa = after.specs || {};
  for (const k of new Set([...Object.keys(sb), ...Object.keys(sa)])) {
    if (!Object.hasOwn(va0, k)) continue; // deleted (logged above)
    const x = sb[k] || {}, y = sa[k] || {};
    if (Boolean(x.archived) !== Boolean(y.archived)) out.push({ t: y.archived ? "specArchived" : "specRestored", code: variantCode(after, k) });
    for (const f of Object.keys(SPEC_FIELDS)) if ((x[f] || "") !== (y[f] || "")) out.push({ t: "specField", code: variantCode(after, k), field: f, from: short(x[f]), to: short(y[f]) });
  }
  // The client's data for a specification
  const cb = before.cspecs || {}, ca = after.cspecs || {};
  for (const cid of new Set([...Object.keys(cb), ...Object.keys(ca)])) {
    const mb = cb[cid] || {}, ma = ca[cid] || {};
    for (const k of new Set([...Object.keys(mb), ...Object.keys(ma)])) {
      const x = mb[k] || {}, y = ma[k] || {};
      if ((x.supplierId || "") !== (y.supplierId || "")) out.push({ t: "clientSpec", client: cliName(cid), code: k ? variantCode(after, k) : String(after.sku || ""), field: "supplier", from: x.supplierId ? supName(x.supplierId) : null, to: y.supplierId ? supName(y.supplierId) : null });
      if ((x.cost == null ? null : x.cost) !== (y.cost == null ? null : y.cost)) out.push({ t: "clientSpec", client: cliName(cid), code: k ? variantCode(after, k) : String(after.sku || ""), field: "cost", from: x.cost == null ? null : x.cost, to: y.cost == null ? null : y.cost });
      for (const f of ["name", "requirements", "sample", "sampleDate"]) {
        if ((x[f] || "") !== (y[f] || "")) out.push({ t: "clientSpec", client: cliName(cid), code: k ? variantCode(after, k) : String(after.sku || ""), field: f, from: short(x[f]), to: short(y[f]) });
      }
    }
  }
  // List sale prices (pricing screen)
  const pb = before.prices || {}, pa = after.prices || {};
  for (const k of new Set([...Object.keys(pb), ...Object.keys(pa)])) {
    if (pb[k] !== pa[k]) out.push({ t: "price", code: k ? variantCode(after, k) : String(after.sku || ""), from: pb[k] == null ? null : pb[k], to: pa[k] == null ? null : pa[k] });
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

/* ---------- Specifications ----------
   A product's variants are now its specifications: only the option
   combinations that were created exist (product.variantSkus), each with its
   own code, details (product.specs[key]) and, per client, the client's code
   (priv.clientRefs) and data (priv.clientSpecInfo). The key of a
   specification is the sorted ids of its options (comboKey), as before. */
const SPEC_FIELDS = { details: 2000, weight: 60, measures: 120, packaging: 300 };
const CHECKLIST_FIELDS = ["details", "weight", "measures", "packaging", "photo"];
const DEFAULT_CHECKLIST = ["details"];

// Keys of the specifications that are used somewhere (clients, costs, prices, photos, proformas).
function usedSpecKeys(p, priv) {
  const used = new Set();
  for (const l of productLinks(priv, p.id)) for (const k of Object.keys(l.variantCosts || {})) used.add(k);
  for (const k of Object.keys(priv.productPrices[p.id] || {})) used.add(k);
  for (const m of Object.values(priv.clientRefs[p.id] || {})) for (const k of Object.keys(m)) used.add(k);
  for (const k of Object.keys(p.variantImages || {})) used.add(k);
  for (const pf of priv.proformas) for (const i of pf.items) if (i.productId === p.id) used.add(comboKey(i.options.map((o) => o.optionId)));
  for (const prices of Object.values(priv.clientPrices || {})) for (const k of Object.keys(prices)) if (k.startsWith(p.id + "|")) used.add(k.slice(p.id.length + 1));
  return used;
}

// One-time change: the generated combinations nobody used are archived (kept, not deleted).
// A product whose combinations were all unused keeps them all.
function migrateSpecs(products, priv) {
  priv.migrations = priv.migrations || {};
  if (priv.migrations.specsV1) return false;
  for (const p of products) {
    const keys = Object.keys(p.variantSkus || {});
    if (!keys.length) continue;
    const used = usedSpecKeys(p, priv);
    if (!keys.some((k) => used.has(k))) continue;
    p.specs = p.specs || {};
    for (const k of keys) if (!used.has(k)) p.specs[k] = { ...(p.specs[k] || {}), archived: true, archivedBy: "migration" };
  }
  priv.migrations.specsV1 = new Date().toISOString();
  return true;
}

function checklistFor(priv, category) {
  const c = priv.settings && priv.settings.checklist;
  const list = c && Array.isArray(c[category]) ? c[category] : DEFAULT_CHECKLIST;
  return list.filter((f) => CHECKLIST_FIELDS.includes(f));
}

// Moves everything kept under a specification's key to its new key (its options changed).
function rekeySpec(p, priv, from, to) {
  const move = (obj) => { if (obj && Object.hasOwn(obj, from)) { obj[to] = obj[from]; delete obj[from]; } };
  move(p.variantSkus); move(p.variantImages); move(p.specs);
  for (const l of productLinks(priv, p.id)) move(l.variantCosts);
  move(priv.productPrices[p.id]);
  for (const m of Object.values(priv.clientRefs[p.id] || {})) move(m);
  for (const m of Object.values((priv.clientSpecInfo || {})[p.id] || {})) move(m);
  for (const prices of Object.values(priv.clientPrices || {}).concat(Object.values(priv.clientDeclared || {}))) {
    if (Object.hasOwn(prices, p.id + "|" + from)) { prices[p.id + "|" + to] = prices[p.id + "|" + from]; delete prices[p.id + "|" + from]; }
  }
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

    // A specification: created, changed (its options, details) or archived / reactivated.
    // body: { key?: existing key, options: { attrId: optionId }, info: { details, weight, ... }, archived? }
    if (req.method === "POST" && queryParam(req, "action") === "spec") {
      const body = await readJson(req);
      const result = await withDataLock(async () => {
        const { products, priv } = await getAllData();
        const product = products.find((p) => p.id === id);
        if (!product) return { status: 404, error: "Product not found" };
        const before = logView(priv, product);
        // Deleting for good: only an archived specification no proforma uses.
        if (body.remove === true) {
          const key = String(body.key == null ? "" : body.key);
          if (!Object.hasOwn(product.variantSkus || {}, key)) return { status: 404, error: "Specification not found" };
          if (!((product.specs || {})[key] || {}).archived) return { status: 409, error: "Archive first" };
          const usedIn = priv.proformas.find((pf) => pf.items.some((i) => i.productId === product.id && comboKey(i.options.map((o) => o.optionId)) === key));
          if (usedIn) return { status: 409, error: "Specification in use", number: usedIn.number };
          const image = (product.variantImages || {})[key];
          for (const obj of [product.variantSkus, product.variantImages, product.specs]) if (obj) delete obj[key];
          for (const l of productLinks(priv, product.id)) if (l.variantCosts) delete l.variantCosts[key];
          if (priv.productPrices[product.id]) delete priv.productPrices[product.id][key];
          for (const m of Object.values(priv.clientRefs[product.id] || {})) delete m[key];
          for (const m of Object.values((priv.clientSpecInfo || {})[product.id] || {})) delete m[key];
          for (const prices of Object.values(priv.clientPrices || {}).concat(Object.values(priv.clientDeclared || {}))) delete prices[product.id + "|" + key];
          product.updatedAt = new Date().toISOString();
          await saveProductsAndPrivate(products, priv); // variantSeq is kept: a deleted code is never reused
          return { key: null, image, product, priv, entry: logEntry(session, "updated", product, diffProduct(before, logView(priv, product), priv)) };
        }
        const attrs = (product.attributes || []).filter((a) => a.options.length);
        if (!attrs.length) return { status: 400, error: "Product without characteristics" };
        const oldKey = body.key != null ? String(body.key) : null;
        if (oldKey != null && !Object.hasOwn(product.variantSkus || {}, oldKey)) return { status: 404, error: "Specification not found" };
        // Every characteristic must have one of its options.
        const chosen = [];
        const missing = [];
        for (const a of attrs) {
          const o = String((body.options || {})[a.id] || "");
          if (!a.options.some((x) => x.id === o)) missing.push(a.source);
          else chosen.push(o);
        }
        if (missing.length) return { status: 422, error: "Missing characteristics", missing };
        const key = comboKey(chosen);
        if (key !== oldKey && Object.hasOwn(product.variantSkus || {}, key)) {
          return { status: 409, error: "Specification exists", code: product.sku + "-" + product.variantSkus[key] };
        }
        const info = { ...((product.specs || {})[oldKey != null ? oldKey : key] || {}) };
        for (const [f, max] of Object.entries(SPEC_FIELDS)) {
          if (body.info && Object.hasOwn(body.info, f)) info[f] = String(body.info[f] || "").replace(/\r\n/g, "\n").trim().slice(0, max);
        }
        if (Object.hasOwn(body, "archived")) { info.archived = Boolean(body.archived); delete info.archivedBy; }
        // Mandatory fields of the category (not for an archived specification)
        // A new specification created in bulk (several at once) may start incomplete.
        if (!info.archived && !(oldKey == null && body.skipChecklist === true)) {
          const need = checklistFor(priv, product.category).filter((f) =>
            f === "photo" ? oldKey != null && photoFor(product, oldKey) === product.image : !String(info[f] || "").trim());
          if (need.length) return { status: 422, error: "Checklist incomplete", fields: need };
        }
        if (oldKey == null) addSpec(product, key);
        else if (key !== oldKey) rekeySpec(product, priv, oldKey, key);
        product.specs = { ...(product.specs || {}), [key]: info };
        product.updatedAt = new Date().toISOString();
        await saveProductsAndPrivate(products, priv);
        return { key, product, priv, entry: logEntry(session, "updated", product, diffProduct(before, logView(priv, product), priv)) };
      });
      if (result.error) return send(res, result.status, { error: result.error, missing: result.missing, fields: result.fields, code: result.code, number: result.number });
      await writeLog([result.entry]);
      if (result.image) await deleteImage(result.image).catch(() => {});
      return send(res, 200, { key: result.key, product: adminView(result.priv, result.product) });
    }

    // A client linked to a specification: the client's code, name for it, requirements
    // and approved sample. body: { clientId, key, ref, name, requirements, sample, sampleDate, remove? }
    if (req.method === "POST" && queryParam(req, "action") === "clientSpec") {
      const body = await readJson(req);
      const result = await withDataLock(async () => {
        const { products, priv } = await getAllData();
        const product = products.find((p) => p.id === id);
        if (!product) return { status: 404, error: "Product not found" };
        const clientId = String(body.clientId || "");
        if (!priv.clients.some((c) => c.id === clientId)) return { status: 400, error: "Unknown client" };
        const key = String(body.key || "");
        const hasSpecs = Object.keys(product.variantSkus || {}).length > 0;
        if (key ? !Object.hasOwn(product.variantSkus || {}, key) : hasSpecs) return { status: 400, error: "Unknown specification" };
        const before = logView(priv, product);
        priv.clientSpecInfo = priv.clientSpecInfo || {};
        const refs = (priv.clientRefs[product.id] = priv.clientRefs[product.id] || {});
        const infos = (priv.clientSpecInfo[product.id] = priv.clientSpecInfo[product.id] || {});
        refs[clientId] = refs[clientId] || {};
        infos[clientId] = infos[clientId] || {};
        if (body.remove) {
          delete refs[clientId][key]; delete infos[clientId][key];
        } else {
          const txt = (v, max) => String(v || "").replace(/\r\n/g, "\n").trim().slice(0, max);
          const ref = txt(body.ref, 60);
          if (ref) refs[clientId][key] = ref; else delete refs[clientId][key];
          const sample = ["approved", "pending", "rejected"].includes(body.sample) ? body.sample : "";
          const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.sampleDate || "")) ? body.sampleDate : "";
          // The client's own supplier and purchase cost for this specification (blank = the default)
          const supplierId = String(body.supplierId || "");
          const cost = supplierId ? money(body.cost) : null;
          if (supplierId) {
            const sup = priv.suppliers.find((s) => s.id === supplierId);
            if (!sup || sup.productSupplier === false) return { status: 400, error: "Unknown supplier" };
            // A supplier the product does not have yet is linked to it (no default cost).
            const links = productLinks(priv, product.id);
            if (!links.some((l) => l.supplierId === supplierId)) {
              links.push({ supplierId, cost: null, variantCosts: {} });
              priv.productSuppliers[product.id] = links;
            }
          }
          infos[clientId][key] = { name: txt(body.name, 160), requirements: txt(body.requirements, 1000), sample, sampleDate: sample ? date : "",
            ...(supplierId ? { supplierId, cost } : {}) };
        }
        for (const map of [refs, infos]) {
          if (!Object.keys(map[clientId]).length) delete map[clientId];
        }
        if (!Object.keys(refs).length) delete priv.clientRefs[product.id];
        if (!Object.keys(infos).length) delete priv.clientSpecInfo[product.id];
        await savePrivate(priv);
        const diff = diffProduct(before, logView(priv, product), priv);
        return { product, priv, entry: diff.length ? logEntry(session, "updated", product, diff) : null };
      });
      if (result.error) return fail(res, result.status, result.error);
      await writeLog([result.entry]);
      return send(res, 200, { product: adminView(result.priv, result.product) });
    }

    // Pricing screen: list prices and purchase prices of many variants at once.
    // changes: [{ productId, key ("" = no variants), price?, costs?: { supplierId: cost | null }, unlink?: [supplierId] }]
    if (req.method === "POST" && queryParam(req, "action") === "pricing") {
      const body = await readJson(req);
      const changes = Array.isArray(body.changes) ? body.changes.slice(0, 2000) : [];
      const result = await withDataLock(async () => {
        const { products, priv } = await getAllData();
        const byId = new Map(products.map((p) => [p.id, p]));
        const productSupplier = new Set(priv.suppliers.filter((x) => x.productSupplier !== false).map((x) => x.id));
        const before = new Map();
        for (const c of changes) {
          const product = byId.get(String(c.productId || ""));
          if (!product) return { status: 400, error: "Unknown product" };
          const key = String(c.key || "");
          if (key ? !(product.variantSkus && Object.hasOwn(product.variantSkus, key)) : (product.attributes || []).some((a) => a.options.length)) {
            return { status: 400, error: "Unknown variant" };
          }
          if (!before.has(product.id)) before.set(product.id, logView(priv, product));
          if (Object.hasOwn(c, "price")) {
            const price = money(c.price);
            const prices = { ...(priv.productPrices[product.id] || {}) };
            if (price == null) delete prices[key]; else prices[key] = price;
            if (Object.keys(prices).length) priv.productPrices[product.id] = prices; else delete priv.productPrices[product.id];
          }
          // A supplier taken off the product (all its specifications)
          for (const sid of Array.isArray(c.unlink) ? c.unlink.map(String) : []) {
            const links = productLinks(priv, product.id).filter((l) => l.supplierId !== sid);
            if (links.length) priv.productSuppliers[product.id] = links; else delete priv.productSuppliers[product.id];
          }
          for (const [supplierId, value] of Object.entries(c.costs || {})) {
            const links = productLinks(priv, product.id);
            let link = links.find((l) => l.supplierId === supplierId);
            if (!link) {
              if (!productSupplier.has(supplierId)) return { status: 400, error: "Unknown supplier" };
              link = { supplierId, cost: null, variantCosts: {} };
              links.push(link);
            }
            const cost = money(value);
            if (key) { if (cost == null) delete link.variantCosts[key]; else link.variantCosts[key] = cost; }
            else link.cost = cost;
            priv.productSuppliers[product.id] = links;
          }
        }
        if (body.targetMargin != null) {
          const m = Number(body.targetMargin);
          if (m >= 0 && m < 1) priv.pricing = { ...(priv.pricing || {}), targetMargin: Math.round(m * 1000) / 1000 };
        }
        // Target margin per category (blank = the general one)
        if (body.targets && typeof body.targets === "object") {
          const targets = {};
          for (const c of ["building", "sanitary", "fitness", "general"]) {
            const m = Number(body.targets[c]);
            if (body.targets[c] != null && body.targets[c] !== "" && m >= 0 && m < 1) targets[c] = Math.round(m * 1000) / 1000;
          }
          priv.pricing = { ...(priv.pricing || {}), targets };
        }
        // Exchange rates used to show prices in the client's currency (RMB per unit)
        if (body.rates && typeof body.rates === "object") {
          const rates = { ...((priv.pricing || {}).rates || {}) };
          for (const cur of ["USD", "EUR", "BRL"]) {
            const r = Number(body.rates[cur]);
            if (body.rates[cur] != null && r > 0 && r < 1000) rates[cur] = Math.round(r * 10000) / 10000;
          }
          priv.pricing = { ...(priv.pricing || {}), rates };
        }
        await savePrivate(priv);
        const entries = [];
        for (const [id, b] of before) {
          const product = byId.get(id);
          const diff = diffProduct(b, logView(priv, product), priv);
          if (diff.length) entries.push(logEntry(session, "updated", product, diff));
        }
        return { entries, updated: [...before.keys()].map((id) => adminView(priv, byId.get(id))), pricing: priv.pricing };
      });
      if (result.error) return fail(res, result.status, result.error);
      await writeLog(result.entries);
      return send(res, 200, { products: result.updated, pricing: result.pricing });
    }

    // Technical drawings of a product (any number, not per variant), kept apart from the photos.
    if (req.method === "POST" && queryParam(req, "action") === "techImage") {
      const body = await readJson(req);
      let url = null;
      if (!body.remove) {
        const current = (await getProducts()).find((p) => p.id === id);
        if (!current) return fail(res, 404, "Product not found");
        if ((current.techImages || []).length >= MAX_TECH_IMAGES) return fail(res, 400, "Too many technical drawings");
        const image = decodeImage(body.image);
        url = await saveImage(current.id + "-tech", image.buffer, image.contentType);
        uploaded.push(url);
      }
      const result = await withDataLock(async () => {
        const { products, priv } = await getAllData();
        const product = products.find((p) => p.id === id);
        if (!product) return { status: 404, error: "Product not found" };
        const before = logView(priv, product);
        const list = product.techImages || [];
        let gone = null;
        if (url) product.techImages = list.concat({ url, name: String(body.name || "").slice(0, 120), at: new Date().toISOString(), by: session.u });
        else {
          gone = list.find((t) => t.url === body.remove);
          if (!gone) return { status: 404, error: "Drawing not found" };
          product.techImages = list.filter((t) => t !== gone);
        }
        product.updatedAt = new Date().toISOString();
        await saveProducts(products);
        return { product, priv, gone, entry: logEntry(session, "updated", product, diffProduct(before, logView(priv, product), priv)) };
      });
      if (result.error) { await cleanup(uploaded); return fail(res, result.status, result.error); }
      uploaded.length = 0;
      await writeLog([result.entry]);
      if (result.gone) await cleanup([result.gone.url]);
      return send(res, 200, { product: adminView(result.priv, result.product) });
    }

    // Product gallery: more photos, each one optionally linked to an option of a
    // characteristic (its specifications then use it). body: { image, optionId? } to add,
    // { url, optionId } to change the link, { remove: url } to delete.
    if (req.method === "POST" && queryParam(req, "action") === "gallery") {
      const body = await readJson(req);
      let url = null;
      if (body.image) {
        const current = (await getProducts()).find((p) => p.id === id);
        if (!current) return fail(res, 404, "Product not found");
        if ((current.gallery || []).length >= MAX_GALLERY) return fail(res, 400, "Too many photos");
        const image = decodeImage(body.image);
        url = await saveImage(current.id + "-g", image.buffer, image.contentType);
        uploaded.push(url);
      }
      const result = await withDataLock(async () => {
        const { products, priv } = await getAllData();
        const product = products.find((p) => p.id === id);
        if (!product) return { status: 404, error: "Product not found" };
        const before = logView(priv, product);
        const options = new Set((product.attributes || []).flatMap((a) => a.options.map((o) => o.id)));
        const optionId = body.optionId && options.has(String(body.optionId)) ? String(body.optionId) : null;
        const list = (product.gallery || []).slice();
        let gone = null;
        if (url) list.push({ url, optionId, at: new Date().toISOString(), by: session.u });
        else if (body.remove) {
          gone = list.find((g) => g.url === body.remove);
          if (!gone) return { status: 404, error: "Photo not found" };
          list.splice(list.indexOf(gone), 1);
        } else {
          const g = list.find((x) => x.url === body.url);
          if (!g) return { status: 404, error: "Photo not found" };
          list[list.indexOf(g)] = { ...g, optionId };
        }
        product.gallery = list;
        product.updatedAt = new Date().toISOString();
        await saveProducts(products);
        return { product, priv, gone, entry: logEntry(session, "updated", product, diffProduct(before, logView(priv, product), priv)) };
      });
      if (result.error) { await cleanup(uploaded); return fail(res, result.status, result.error); }
      uploaded.length = 0;
      await writeLog([result.entry]);
      if (result.gone) await cleanup([result.gone.url]);
      return send(res, 200, { product: adminView(result.priv, result.product) });
    }

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
      const { links, refs, stale, prices, cspecs, entry } = await withDataLock(async () => {
        const { products, priv } = await getAllData();
        products.unshift(product);
        const stale = prepareSkus(products, priv);
        const links = applySupplierLinks(priv, product.id, body, product);
        const refs = applyClientRefs(priv, product, body);
        await saveProductsAndPrivate(products, priv);
        const after = logView(priv, product);
        const empty = { source: {}, name: {}, description: {}, attributes: [], links: [], refs: {}, variantImages: {}, image: after.image };
        return { links, refs, stale, prices: priv.productPrices[product.id], cspecs: (priv.clientSpecInfo || {})[product.id], entry: logEntry(session, body.copyImageFrom ? "duplicated" : "created", product, diffProduct(empty, after, priv)) };
      });
      uploaded.length = 0;
      await writeLog([entry]);
      await cleanup(stale);
      return send(res, 201, { product: withLinks(product, links, refs, prices, cspecs) });
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
        for (const k of ["sku", "variantSkus", "variantSeq", "variantImages", "techImages", "specs", "gallery", "image", "createdAt"]) {
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
        return { links, refs, prices: priv.productPrices[product.id], cspecs: (priv.clientSpecInfo || {})[product.id], stale: newImage && oldImage !== newImage ? stale.concat(oldImage) : stale,
          entry: changes.length ? logEntry(session, "updated", product, changes) : null };
      });
      if (!result) { await cleanup(uploaded); return fail(res, 404, "Product not found"); }
      if (result.conflict) { await cleanup(uploaded); return fail(res, 409, "Changed by someone else"); }
      uploaded.length = 0;
      await writeLog([result.entry]);
      await cleanup(result.stale);
      return send(res, 200, { product: withLinks(product, result.links, result.refs, result.prices, result.cspecs) });
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
        delete priv.productPrices[gone.id];
        if (priv.clientSpecInfo) delete priv.clientSpecInfo[gone.id];
        await saveProductsAndPrivate(products, priv);
        // Proformas show the product's photos: keep them while one still lists it.
        const inProforma = priv.proformas.some((pf) => pf.items.some((i) => i.productId === gone.id));
        return { gone, keepPhotos: inProforma, entry };
      });
      if (!removed) return fail(res, 404, "Product not found");
      await writeLog([removed.entry]);
      if (!removed.keepPhotos) await cleanup([removed.gone.image].concat(Object.values(removed.gone.variantImages || {}), (removed.gone.gallery || []).map((g) => g.url)));
      await cleanup((removed.gone.techImages || []).map((t) => t.url)); // technical drawings are not shown on proformas
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
  const pending = (pr, pv) => assignSkus(pr, pv) | migrateSpecs(pr, pv);
  if (pending(JSON.parse(JSON.stringify(products)), JSON.parse(JSON.stringify(priv)))) {
    ({ products, priv } = await withDataLock(async () => {
      const fresh = await getAllData();
      if (pending(fresh.products, fresh.priv)) await saveProductsAndPrivate(fresh.products, fresh.priv);
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

// Catalog changes reach Soulglobal (when the integration is on) in the background.
export default withSync(handler);
