// Reads a non-negative decimal typed as "15.9", "15,9", "1.234,56", "1,234.56" or "1.000".
// Returns null for empty or invalid input.
export function parseDecimal(value) {
  if (value === "" || value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value * 10000) / 10000 : null;
  let s = String(value).trim().replace(/\s/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // The last separator is the decimal one; the other separates thousands.
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma > -1) {
    // "15,9" is a decimal; "1,000,000" only groups thousands.
    s = (s.match(/,/g).length > 1) ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(s)) {
    // "1.000" / "12.500": dots grouping thousands, as written in Brazil.
    s = s.replace(/\./g, "");
  }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10000) / 10000 : null;
}
