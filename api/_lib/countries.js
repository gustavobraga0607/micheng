// Country name -> the code used in the proforma / invoice numbers ("Brasil" -> "BR").
// Names come from the runtime's own list of countries (Intl), in Portuguese,
// English, Spanish and Chinese, so any country is recognized; a few codes follow
// the company's own convention (USA, UK, UAE).
const OWN = { US: "USA", GB: "UK", AE: "UAE" };
// Old or special codes that are not countries today (DD = East Germany…).
const SKIP = new Set(["DD", "VD", "DY", "HV", "RH", "NH", "PU", "PZ", "WK", "JT", "MI", "PC", "AI2", "YU", "CS", "SU", "ZR", "TP", "BU", "NT", "YD", "FX", "QO", "EU", "EZ", "UN", "XA", "XB", "ZZ", "QU", "AN", "IC", "EA", "CP", "DG", "TA", "AC", "CQ"]);
const EXTRA = { "republica checa": "CZ", "hong kong": "HK", "macau": "MO", "macao": "MO", "taiwan": "TW", "eua": "USA", "usa": "USA", "estados unidos da america": "USA", "united states of america": "USA", "inglaterra": "UK", "england": "UK", "holanda": "NL", "emirados arabes": "UAE", "dubai": "UAE", "coreia": "KR", "korea": "KR" };

const plain = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

let byName = null;
function table() {
  if (byName) return byName;
  byName = new Map(Object.entries(EXTRA));
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const lang of ["pt", "en", "es", "zh"]) {
    let names;
    try { names = new Intl.DisplayNames([lang], { type: "region" }); } catch (e) { continue; }
    for (const a of letters) for (const b of letters) {
      const code = a + b;
      let name;
      try { name = names.of(code); } catch (e) { continue; }
      if (!name || name === code || SKIP.has(code)) continue;
      // "Hong Kong, RAE da China" is also found as "Hong Kong".
      for (const key of [plain(name), plain(name.split(/[,(（，]/)[0])]) if (key && !byName.has(key)) byName.set(key, OWN[code] || code);
    }
  }
  return byName;
}

export function countryCode(country) {
  const key = plain(country);
  return key ? table().get(key) || "" : "";
}
