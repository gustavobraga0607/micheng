// Product and photo storage.
// In production this uses Vercel Blob (BLOB_READ_WRITE_TOKEN is set when a Blob
// store is connected to the project). Locally it falls back to the .data folder.
import { put, list, del } from "@vercel/blob";
import fs from "node:fs/promises";
import path from "node:path";

const DATA_PREFIX = "data/products";
const LOCAL_DIR = path.join(process.cwd(), ".data");
const LOCAL_FILE = path.join(LOCAL_DIR, "products.json");

const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

async function dataBlobs() {
  const { blobs } = await list({ prefix: DATA_PREFIX });
  return blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

export async function getProducts() {
  if (!useBlob()) {
    try {
      return JSON.parse(await fs.readFile(LOCAL_FILE, "utf8"));
    } catch (e) {
      return [];
    }
  }
  const blobs = await dataBlobs();
  if (!blobs.length) return [];
  const r = await fetch(blobs[0].url, { cache: "no-store" });
  if (!r.ok) throw new Error("Could not read products (" + r.status + ")");
  return r.json();
}

// Each save writes a new file under a fresh random URL (so no CDN cache can
// serve an old copy) and then removes the previous versions.
export async function saveProducts(products) {
  const body = JSON.stringify(products, null, 2);
  if (!useBlob()) {
    await fs.mkdir(LOCAL_DIR, { recursive: true });
    await fs.writeFile(LOCAL_FILE, body);
    return;
  }
  const saved = await put(DATA_PREFIX + ".json", body, {
    access: "public",
    addRandomSuffix: true,
    contentType: "application/json",
  });
  const old = (await dataBlobs()).filter((b) => b.url !== saved.url).map((b) => b.url);
  if (old.length) await del(old);
}

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
