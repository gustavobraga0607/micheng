// Storage for products, photos and the admin-only data (suppliers).
// In production this uses Vercel Blob (BLOB_READ_WRITE_TOKEN is set when a Blob
// store is connected to the project). Locally it falls back to the .data folder.
import { put, list, del } from "@vercel/blob";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const PRODUCTS_PREFIX = "data/products";
const PRIVATE_PREFIX = "private/admin-data";
const LOCAL_DIR = path.join(process.cwd(), ".data");

const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

async function blobsNewestFirst(prefix) {
  const { blobs } = await list({ prefix });
  return blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

async function readLatest(prefix) {
  const blobs = await blobsNewestFirst(prefix);
  if (!blobs.length) return null;
  const r = await fetch(blobs[0].url, { cache: "no-store" });
  if (!r.ok) throw new Error("Could not read " + prefix + " (" + r.status + ")");
  return r.text();
}

// Each save writes a new file under a fresh random URL (so no CDN cache can
// serve an old copy) and then removes the previous versions.
async function writeNew(prefix, ext, body, contentType) {
  const saved = await put(prefix + ext, body, { access: "public", addRandomSuffix: true, contentType });
  const old = (await blobsNewestFirst(prefix)).filter((b) => b.url !== saved.url).map((b) => b.url);
  if (old.length) await del(old);
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

export async function getProducts() {
  if (!useBlob()) return readLocal("products.json", []);
  const text = await readLatest(PRODUCTS_PREFIX);
  return text ? JSON.parse(text) : [];
}

export async function saveProducts(products) {
  if (!useBlob()) return writeLocal("products.json", products);
  await writeNew(PRODUCTS_PREFIX, ".json", JSON.stringify(products, null, 2), "application/json");
}

/* ---------- Admin-only data: suppliers and product links ----------
   Blob files are reachable by anyone who knows their URL, so this data is
   encrypted (AES-256-GCM) with PRIVATE_DATA_KEY before it is stored.
   Changing or losing PRIVATE_DATA_KEY makes the saved suppliers unreadable. */

const EMPTY_PRIVATE = {
  suppliers: [],
  productSuppliers: {}, // productId -> [{ supplierId, cost }]
  clients: [],
  settings: {},
  proformas: [],
  clientPrices: {}, // clientId -> { priceKey: { price, currency, proformaId, at } }
  proformaSeq: {}, // year -> last proforma number used
};

// Supplier links of a product, as [{ supplierId, cost }]. Links saved before
// purchase prices existed were plain supplier ids.
export function productLinks(priv, productId) {
  return (priv.productSuppliers[productId] || []).map((l) =>
    typeof l === "string" ? { supplierId: l, cost: null } : { supplierId: l.supplierId, cost: l.cost == null ? null : Number(l.cost) }
  );
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

export async function getPrivate() {
  if (!useBlob()) return { ...EMPTY_PRIVATE, ...(await readLocal("private.json", {})) };
  const text = await readLatest(PRIVATE_PREFIX);
  return text ? { ...EMPTY_PRIVATE, ...decrypt(text) } : { ...EMPTY_PRIVATE };
}

export async function savePrivate(data) {
  if (!useBlob()) return writeLocal("private.json", data);
  await writeNew(PRIVATE_PREFIX, ".enc", encrypt(data), "application/octet-stream");
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
