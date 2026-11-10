// Automatic translation of product texts into the four site languages.
// Uses DeepL when DEEPL_API_KEY is set; otherwise the free MyMemory API
// (optionally with MYMEMORY_EMAIL, which raises its daily limit).

export const LANGS = ["en", "pt", "es", "zh"];

const MYMEMORY_CODES = { en: "en", pt: "pt-BR", es: "es", zh: "zh-CN" };
const DEEPL_TARGET = { en: "EN-US", pt: "PT-BR", es: "ES", zh: "ZH-HANS" };

function normalizeLang(code) {
  const c = String(code || "").toLowerCase();
  if (c.startsWith("zh")) return "zh";
  return c.slice(0, 2);
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// MyMemory accepts at most ~500 bytes per request: split long texts on sentence ends.
function chunks(text, max = 400) {
  const parts = text.match(/[^.!?。！？\n]+[.!?。！？\n]*/g) || [text];
  const out = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + p).length > max && cur) {
      out.push(cur);
      cur = "";
    }
    if (p.length > max) {
      for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
    } else {
      cur += p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function fetchJson(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { ...options, signal: ctrl.signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("HTTP " + r.status);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function myMemory(text, source, target) {
  const params = new URLSearchParams({ q: text, langpair: source + "|" + target });
  if (process.env.MYMEMORY_EMAIL) params.set("de", process.env.MYMEMORY_EMAIL);
  const data = await fetchJson("https://api.mymemory.translated.net/get?" + params);
  const out = data && data.responseData && data.responseData.translatedText;
  if (Number(data.responseStatus) !== 200 || !out || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) {
    throw new Error("MyMemory: " + (data.responseDetails || out || "no translation"));
  }
  return { text: decodeEntities(out), detected: data.responseData.detectedLanguage };
}

async function myMemoryLong(text, source, target) {
  const pieces = [];
  let detected = null;
  for (const piece of chunks(text)) {
    const r = await myMemory(piece, source, target);
    pieces.push(r.text);
    detected = detected || r.detected;
  }
  return { text: pieces.join(" ").replace(/\s+/g, " ").trim(), detected };
}

async function translateMyMemory(text, sourceHint) {
  let source = sourceHint;
  const values = {};
  if (!source) {
    // Detect the language with a first request towards English.
    const first = await myMemoryLong(text, "autodetect", "en");
    source = normalizeLang(first.detected) || "en";
    if (source !== "en") values.en = first.text;
  }
  for (const lang of LANGS) {
    if (lang === source) values[lang] = text;
    else if (!values[lang]) values[lang] = (await myMemoryLong(text, MYMEMORY_CODES[source] || source, MYMEMORY_CODES[lang])).text;
  }
  return { source, values };
}

async function translateDeepL(text, sourceHint) {
  const key = process.env.DEEPL_API_KEY;
  const host = key.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
  const values = {};
  let source = sourceHint;
  for (const lang of LANGS) {
    if (lang === source) {
      values[lang] = text;
      continue;
    }
    const body = { text: [text], target_lang: DEEPL_TARGET[lang] };
    if (source) body.source_lang = source.toUpperCase();
    const data = await fetchJson(host + "/v2/translate", {
      method: "POST",
      headers: { Authorization: "DeepL-Auth-Key " + key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const tr = data.translations[0];
    if (!source) source = normalizeLang(tr.detected_source_language);
    values[lang] = source === lang ? text : tr.text;
  }
  return { source, values };
}

// Returns { source, values: {en, pt, es, zh}, ok }. On failure every language
// falls back to the original text and ok is false, so the product still saves.
export async function translateAll(text, sourceHint) {
  const clean = String(text || "").trim();
  const hint = LANGS.includes(sourceHint) ? sourceHint : null;
  if (!clean) return { source: hint, values: { en: "", pt: "", es: "", zh: "" }, ok: true };
  try {
    const r = process.env.DEEPL_API_KEY ? await translateDeepL(clean, hint) : await translateMyMemory(clean, hint);
    return { ...r, ok: true };
  } catch (e) {
    console.warn("Translation failed:", e.message);
    const values = {};
    LANGS.forEach((l) => (values[l] = clean));
    return { source: hint, values, ok: false };
  }
}
