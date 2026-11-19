// SKU codes. Every product gets a sequential number (from 1001, never reused,
// counter kept in the private data as skuSeq). Each combination of options of a
// product gets a fixed suffix: 2432-1, 2432-2… Suffixes are assigned once and
// never change, even when options are added later.

const FIRST_SKU = 1001;
const MAX_COMBOS = 1000;

// Key of a combination of options: the option ids, sorted.
export function comboKey(optionIds) {
  return optionIds.filter(Boolean).slice().sort().join(",");
}

// All option combinations of a product, in attribute/option order
// (first characteristic varies slowest), or [] when it has none.
function combos(product) {
  let list = [[]];
  for (const a of product.attributes || []) {
    if (!a.options.length) continue;
    list = list.flatMap((c) => a.options.map((o) => c.concat(o.id)));
    if (list.length > MAX_COMBOS) return [];
  }
  return list.filter((c) => c.length).map(comboKey);
}

// Gives missing SKUs (oldest products first).
// Returns true when something changed and the products must be saved.
export function assignSkus(products, priv) {
  let changed = false;
  let seq = Math.max(FIRST_SKU - 1, Number(priv.skuSeq) || 0, ...products.map((p) => Number(p.sku) || 0));
  const byAge = products.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const p of byAge) {
    if (!p.sku) { p.sku = ++seq; changed = true; }
    // Variants (specifications) are no longer every combination of the options:
    // only those created on the Especificações tab exist (see addSpec). Their
    // codes never change and are never reused.
    const variants = p.variantSkus || {};
    const vseq = Math.max(Number(p.variantSeq) || 0, 0, ...Object.values(variants));
    if (!p.variantSkus || p.variantSeq !== vseq) changed = true;
    p.variantSkus = variants;
    p.variantSeq = vseq;
  }
  if (priv.skuSeq !== seq) { priv.skuSeq = seq; changed = true; }
  return changed;
}

// SKU of a product with the chosen options: "2432" or "2432-1".
// Options removed from the product since the choice was made are ignored.
export function skuFor(product, optionIds) {
  if (!product || !product.sku) return null;
  const current = new Set((product.attributes || []).flatMap((a) => a.options.map((o) => o.id)));
  const n = product.variantSkus && product.variantSkus[comboKey((optionIds || []).filter((id) => current.has(id)))];
  return n ? product.sku + "-" + n : String(product.sku);
}

// Photo of a configuration: the specification's own photo, else the gallery photo
// linked to one of its options (e.g. Colour: Black), else the product's main photo.
export function photoFor(product, key) {
  if (!product) return null;
  if (product.variantImages && product.variantImages[key]) return product.variantImages[key];
  const ids = String(key || "").split(",").filter(Boolean);
  const hit = (product.gallery || []).find((g) => g.optionId && ids.includes(g.optionId));
  return hit ? hit.url : product.image;
}
export function variantImage(product, optionIds) {
  if (!product) return null;
  const current = new Set((product.attributes || []).flatMap((a) => a.options.map((o) => o.id)));
  return photoFor(product, comboKey((optionIds || []).filter((id) => current.has(id))));
}

// A new specification of a product: its code suffix (next number, never reused).
export function addSpec(product, key) {
  const variants = product.variantSkus || (product.variantSkus = {});
  if (Object.hasOwn(variants, key)) return variants[key];
  product.variantSeq = Math.max(Number(product.variantSeq) || 0, ...Object.values(variants), 0) + 1;
  variants[key] = product.variantSeq;
  return variants[key];
}
export { combos };
