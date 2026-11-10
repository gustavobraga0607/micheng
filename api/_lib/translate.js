// Automatic translation of product texts into the four site languages.
// Uses DeepL when DEEPL_API_KEY is set; otherwise the free MyMemory API
// (optionally with MYMEMORY_EMAIL, which raises its daily limit).

export const LANGS = ["en", "pt", "es", "zh"];
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

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
  // With "autodetect", text already in the target language is refused with this message.
  if (/SELECT TWO DISTINCT LANGUAGES/i.test(String(data.responseDetails || out))) {
    return { text, detected: target, sameLanguage: true };
  }
  if (Number(data.responseStatus) !== 200 || !out || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) {
    throw new Error("MyMemory: " + (data.responseDetails || out || "no translation"));
  }
  return { text: bestCandidate(text, data, target), detected: data.responseData.detectedLanguage };
}

// MyMemory answers with its top translation-memory hit plus alternatives.
// Memory hits can carry markup, numbering, ALL CAPS or even untranslated
// text, so prefer its machine translation ("MT!") and clean whatever is used.
function cleanCandidate(source, value) {
  let v = decodeEntities(String(value || "")).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  if (!/^\d/.test(source)) v = v.replace(/^\d+\s*[-.)]\s*/, "");
  const letters = v.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (letters.length > 3 && v === v.toUpperCase() && source !== source.toUpperCase()) {
    v = v.charAt(0) + v.slice(1).toLowerCase();
  }
  // Keep the capital first letter of the original ("Granito" -> "Granite").
  if (/^\p{Lu}/u.test(source) && /^\p{Ll}/u.test(v)) v = v.charAt(0).toUpperCase() + v.slice(1);
  return v;
}

function bestCandidate(source, data, target) {
  const wantsCjk = target.startsWith("zh");
  const valid = (v) => v && (wantsCjk ? CJK.test(v) : !CJK.test(v) || CJK.test(source));
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const options = [];
  matches.filter((m) => m["created-by"] === "MT!").forEach((m) => options.push(m.translation));
  options.push(data.responseData.translatedText);
  matches
    .slice()
    .sort((a, b) => Number(b.match) - Number(a.match))
    .forEach((m) => options.push(m.translation));
  for (const o of options) {
    const v = cleanCandidate(source, o);
    if (valid(v)) return v;
  }
  return cleanCandidate(source, data.responseData.translatedText);
}

async function myMemoryLong(text, source, target) {
  const pieces = [];
  let detected = null;
  let sameLanguage = false;
  for (const piece of chunks(text)) {
    const r = await myMemory(piece, source, target);
    pieces.push(r.text);
    detected = detected || r.detected;
    sameLanguage = sameLanguage || Boolean(r.sameLanguage);
  }
  return { text: pieces.join(" ").replace(/\s+/g, " ").trim(), detected, sameLanguage };
}

async function translateMyMemory(text, sourceHint) {
  let source = sourceHint;
  const values = {};
  if (!source) {
    // Detect the language with a first request towards English.
    const first = await myMemoryLong(text, "autodetect", "en");
    source = normalizeLang(first.detected) || "en";
    if (source !== "en" && !first.sameLanguage) values.en = first.text;
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


// Detects the language a product was registered in, from its name and
// description together (more text gives a more reliable guess than the name alone).
// Returns a language code such as "pt", "en", "es", "zh" (or another language
// the detector recognises), or null when detection is unavailable.
export async function detectLanguage(name, description) {
  const text = [name, description].map((s) => String(s || "").trim()).filter(Boolean).join(". ").slice(0, 400);
  if (!text) return null;
  if (CJK.test(text)) return "zh";
  try {
    if (process.env.DEEPL_API_KEY) {
      const key = process.env.DEEPL_API_KEY;
      const host = key.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
      const data = await fetchJson(host + "/v2/translate", {
        method: "POST",
        headers: { Authorization: "DeepL-Auth-Key " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ text: [text], target_lang: "EN-US" }),
      });
      return normalizeLang(data.translations[0].detected_source_language) || null;
    }
    const r = await myMemory(text, "autodetect", "en");
    return normalizeLang(r.detected) || null;
  } catch (e) {
    console.warn("Language detection failed:", e.message);
    return null;
  }
}

// Returns { source, values: {en, pt, es, zh}, ok }. On failure every language
// falls back to the original text and ok is false, so the product still saves.
export async function translateAll(text, sourceHint) {
  const clean = String(text || "").trim();
  const hint = /^[a-z]{2}$/.test(String(sourceHint || "")) ? sourceHint : null;
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
