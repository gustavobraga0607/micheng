// Storage for products, photos and the admin-only data (suppliers, clients...).
// - Data (products and the encrypted admin data) lives in Upstash Redis when a
//   Redis database is connected to the project (KV_REST_API_URL/TOKEN or
//   UPSTASH_REDIS_REST_URL/TOKEN). Earlier versions kept it in Vercel Blob: it is
//   copied to Redis the first time it is read.
// - Photos live in Vercel Blob (BLOB_READ_WRITE_TOKEN).
// Without these variables everything falls back to the local .data folder.
import { put, list, del } from "@vercel/blob";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getSession } from "./auth.js";

const PRODUCTS_PREFIX = "data/products";
const PRIVATE_PREFIX = "private/admin-data";
const LOCAL_DIR = path.join(process.cwd(), ".data");

const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

/* ---------- Upstash Redis (REST API, no extra dependency) ---------- */

const REDIS_PRODUCTS = "micheng:products";
const REDIS_PRIVATE = "micheng:private";
const REDIS_LOCK = "micheng:lock";

function envEnding(suffix) {
  const name = Object.keys(process.env).find((k) => k.endsWith(suffix) && process.env[k]);
  return name ? process.env[name] : "";
}

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || envEnding("KV_REST_API_URL");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || envEnding("KV_REST_API_TOKEN");
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

const useRedis = () => Boolean(redisConfig());

async function redisCall(pathname, body) {
  const { url, token } = redisConfig();
  const r = await fetch(url + pathname, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const out = await r.json().catch(() => ({ error: "HTTP " + r.status }));
  if (!r.ok || out.error) throw new Error("Redis error: " + (out.error || r.status));
  return out;
}

// One command, e.g. redis(["GET", key]).
async function redis(command) {
  return (await redisCall("/", command)).result;
}

// Several commands applied together (all or nothing).
async function redisTransaction(commands) {
  const out = await redisCall("/multi-exec", commands);
  for (const item of out) if (item.error) throw new Error("Redis error: " + item.error);
  return out.map((item) => item.result);
}

// Reads a key; on the first read after the move to Redis, copies the data that
// earlier versions kept in Vercel Blob (SET NX: never overwrites newer data).
async function redisRead(key, fromBlob) {
  const value = await redis(["GET", key]);
  if (value != null) return value;
  if (!useBlob()) return null;
  const old = await fromBlob();
  if (old == null) return null;
  await redis(["SET", key, old, "NX"]);
  return redis(["GET", key]);
}

/* ---------- One change at a time ----------
   Every change reads the whole data, edits it and writes it back. If two admins
   saved at the same moment, the later write would undo the earlier one, so
   changes take turns: each waits for the previous one to finish. */

const LOCK_TTL_MS = 70000; // longer than the slowest request (products: 60 s)
const LOCK_WAIT_MS = 45000;

export class BusyError extends Error {}

export async function withDataLock(fn) {
  if (!useRedis()) return fn();
  const token = crypto.randomUUID();
  const until = Date.now() + LOCK_WAIT_MS;
  while ((await redis(["SET", REDIS_LOCK, token, "NX", "PX", String(LOCK_TTL_MS)])) !== "OK") {
    if (Date.now() > until) throw new BusyError("Another change is still being saved. Please try again.");
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 250));
  }
  try {
    return await fn();
  } finally {
    // Release only our own lock (it may have expired and been taken by someone else).
    await redis(["EVAL", "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", "1", REDIS_LOCK, token])
      .catch((e) => console.warn("Could not release the data lock", e.message));
  }
}

// Wraps an API handler so that every request that may change data (anything but
// GET) runs inside withDataLock and reads the data only once it has the turn.
export function oneChangeAtATime(handler) {
  return async (req, res) => {
    // Reads, and requests without a login (refused by the handler), never wait.
    if (req.method === "GET" || req.method === "HEAD" || !getSession(req)) return handler(req, res);
    try {
      return await withDataLock(() => handler(req, res));
    } catch (e) {
      if (!(e instanceof BusyError)) throw e;
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Retry-After", "5");
      res.end(JSON.stringify({ error: e.message }));
    }
  };
}

// Data files live at fixed paths and are overwritten in place. Reading one is a
// plain URL fetch (a cheap "simple" Blob operation) instead of a list() call,
// which is an "advanced" operation with a small monthly quota on the free plan.
function storeBaseUrl() {
  if (process.env.BLOB_BASE_URL) return process.env.BLOB_BASE_URL.replace(/\/$/, "");
  const m = /^vercel_blob_rw_([A-Za-z0-9]+)_/.exec(process.env.BLOB_READ_WRITE_TOKEN || "");
  if (!m) throw new Error("Cannot work out the Blob store URL (set BLOB_BASE_URL)");
  return "https://" + m[1].toLowerCase() + ".public.blob.vercel-storage.com";
}

// legacyPrefix: where earlier versions kept this file (defaults to prefix).
async function readData(prefix, ext, contentType, legacyPrefix) {
  // A unique query string skips the CDN copy, so a file just overwritten is read fresh.
  const url = storeBaseUrl() + "/" + prefix + ext + "?v=" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const r = await fetch(url, { cache: "no-store" });
  if (r.ok) return r.text();
  if (r.status !== 404) throw new Error("Could not read " + prefix + " (" + r.status + ")");
  return migrateLegacy(prefix, ext, contentType, legacyPrefix || prefix);
}

async function writeData(prefix, ext, body, contentType) {
  await put(prefix + ext, body, { access: "public", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60, contentType });
}

// Earlier versions saved each change under a new random name: the newest one is
// moved once to the fixed path and the old ones are deleted (deletes are free).
async function migrateLegacy(prefix, ext, contentType, legacyPrefix) {
  const { blobs } = await list({ prefix: legacyPrefix });
  const legacy = blobs.filter((b) => b.pathname !== prefix + ext)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!legacy.length) return null;
  const r = await fetch(legacy[0].url, { cache: "no-store" });
  if (!r.ok) throw new Error("Could not read " + prefix + " (" + r.status + ")");
  const text = await r.text();
  await writeData(prefix, ext, text, contentType);
  await del(legacy.map((b) => b.url));
  return text;
}

async function readLocal(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(LOCAL_DIR, file), "utf8"));
  } catch (e) {
    return fallback;
  }
}

async function writeLocal(file, data) {
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  await fs.writeFile(path.join(LOCAL_DIR, file), JSON.stringify(data, null, 2));
}

/* ---------- Products (public) ---------- */

const readBlobProducts = () => readData(PRODUCTS_PREFIX, ".json", "application/json");

export async function getProducts() {
  let text;
  if (useRedis()) text = await redisRead(REDIS_PRODUCTS, readBlobProducts);
  else if (useBlob()) text = await readBlobProducts();
  else return readLocal("products.json", []);
  return text ? JSON.parse(text) : [];
}

export async function saveProducts(products) {
  if (useRedis()) return void (await redis(["SET", REDIS_PRODUCTS, JSON.stringify(products)]));
  if (!useBlob()) return writeLocal("products.json", products);
  await writeData(PRODUCTS_PREFIX, ".json", JSON.stringify(products), "application/json");
}

// Saves the product list and the admin data together (all or nothing).
export async function saveProductsAndPrivate(products, priv) {
  if (useRedis()) {
    await redisTransaction([["SET", REDIS_PRODUCTS, JSON.stringify(products)], ["SET", REDIS_PRIVATE, encrypt(priv)]]);
    return;
  }
  await saveProducts(products);
  await savePrivate(priv);
}

/* ---------- Admin-only data: suppliers and product links ----------
   Blob files are reachable by anyone who knows their URL, so this data is
   encrypted (AES-256-GCM) with PRIVATE_DATA_KEY before it is stored.
   Changing or losing PRIVATE_DATA_KEY makes the saved suppliers unreadable. */

const EMPTY_PRIVATE = {
  suppliers: [],
  productSuppliers: {}, // productId -> [{ supplierId, cost, variantCosts }]
  clients: [],
  settings: {},
  proformas: [],
  clientPrices: {}, // clientId -> { priceKey: { price, currency, proformaId, at } }
  proformaSeq: {}, // year -> last proforma number used
  clientRefs: {}, // productId -> clientId -> { comboKey ("" = no variants): client's reference }
};

// Supplier links of a product, as [{ supplierId, cost }]. Links saved before
// purchase prices existed were plain supplier ids.
// variantCosts: purchase price per option combination ({ "optId,optId": cost }),
// overriding the default cost for that configuration.
export function productLinks(priv, productId) {
  return (priv.productSuppliers[productId] || []).map((l) =>
    typeof l === "string"
      ? { supplierId: l, cost: null, variantCosts: {} }
      : { supplierId: l.supplierId, cost: l.cost == null ? null : Number(l.cost), variantCosts: l.variantCosts || {} }
  );
}

// Fixed but unguessable path for the encrypted file (derived from the key).
function privatePath() {
  const tag = crypto.createHash("sha256").update("micheng-private-path:" + (process.env.PRIVATE_DATA_KEY || "")).digest("hex").slice(0, 24);
  return PRIVATE_PREFIX + "-" + tag;
}

function privateKey() {
  const secret = process.env.PRIVATE_DATA_KEY;
  if (!secret) throw new Error("PRIVATE_DATA_KEY is not configured");
  return crypto.createHash("sha256").update("micheng-private-data:" + secret).digest();
}

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", privateKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
}

function decrypt(text) {
  const box = JSON.parse(text);
  const decipher = crypto.createDecipheriv("aes-256-gcm", privateKey(), Buffer.from(box.iv, "base64"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

const readBlobPrivate = () => readData(privatePath(), ".enc", "application/octet-stream", PRIVATE_PREFIX);

export async function getPrivate() {
  let text;
  if (useRedis()) text = await redisRead(REDIS_PRIVATE, readBlobPrivate);
  else if (useBlob()) text = await readBlobPrivate();
  else return { ...EMPTY_PRIVATE, ...(await readLocal("private.json", {})) };
  return text ? { ...EMPTY_PRIVATE, ...decrypt(text) } : { ...EMPTY_PRIVATE };
}

export async function savePrivate(data) {
  if (useRedis()) return void (await redis(["SET", REDIS_PRIVATE, encrypt(data)]));
  if (!useBlob()) return writeLocal("private.json", data);
  await writeData(privatePath(), ".enc", encrypt(data), "application/octet-stream");
}

/* ---------- Photos ---------- */

export async function saveImage(id, buffer, contentType) {
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[contentType];
  if (!useBlob()) {
    const dir = path.join(LOCAL_DIR, "uploads");
    await fs.mkdir(dir, { recursive: true });
    const name = id + "-" + Date.now() + "." + ext;
    await fs.writeFile(path.join(dir, name), buffer);
    return "/.data/uploads/" + name;
  }
  const blob = await put("products/" + id + "." + ext, buffer, {
    access: "public",
    addRandomSuffix: true,
    contentType,
  });
  return blob.url;
}

// Copies an existing product photo to a new file for another product (used when
// duplicating), so deleting one product never removes the other's photo.
export async function copyImage(url, newId) {
  if (!url) return null;
  if (!useBlob()) {
    if (!url.startsWith("/.data/uploads/")) return null;
    const buffer = await fs.readFile(path.join(LOCAL_DIR, "uploads", path.basename(url)));
    const ext = path.extname(url).toLowerCase();
    return saveImage(newId, buffer, ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg");
  }
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("Could not read the photo to copy (" + r.status + ")");
  const type = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
  return saveImage(newId, Buffer.from(await r.arrayBuffer()), ["image/png", "image/webp"].includes(type) ? type : "image/jpeg");
}

export async function deleteImage(url) {
  if (!url) return;
  try {
    if (!useBlob()) {
      if (url.startsWith("/.data/uploads/")) await fs.unlink(path.join(LOCAL_DIR, "uploads", path.basename(url)));
      return;
    }
    await del(url);
  } catch (e) {
    console.warn("Could not delete image", url, e.message);
  }
}
