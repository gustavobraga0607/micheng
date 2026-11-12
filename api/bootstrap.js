// Everything the admin panel needs when it opens, in one request (one
// function start and one database round trip instead of six).
import { send, fail } from "./_lib/http.js";
import { getSession } from "./_lib/auth.js";
import { getAllData } from "./_lib/store.js";
import { adminProducts } from "./products.js";
import { withProducts } from "./suppliers.js";
import { settingsOut } from "./settings.js";
import { proformaList } from "./proformas.js";
import { accountOut, entryOut } from "./finance.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return fail(res, 405, "Method not allowed");
    if (!getSession(req)) return fail(res, 401, "Login required");
    const { products, priv, fin } = await getAllData({ finance: true });
    send(res, 200, {
      products: await adminProducts(products, priv),
      suppliers: withProducts(priv),
      clients: priv.clients,
      settings: settingsOut(priv),
      proformas: proformaList(priv, products),
      finance: { accounts: fin.accounts.map(accountOut), entries: fin.entries.map(entryOut) },
    });
  } catch (e) {
    console.error(e);
    fail(res, 500, "Server error");
  }
}
