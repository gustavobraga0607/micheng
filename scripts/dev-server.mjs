// Local development server: serves the static site and runs the /api routes
// the same way Vercel does. Usage: ADMIN_PASSWORD=secret npm run dev
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const port = Number(process.env.PORT || 3000);
const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".json": "application/json",
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      const name = url.pathname.slice(5).replace(/[^a-z-]/g, "");
      const mod = await import(pathToFileURL(path.join(root, "api", name + ".js")).href);
      return await mod.default(req, res);
    }
    let file = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (file.endsWith("/")) file += "index.html";
    if (!path.extname(file)) file += ".html"; // like Vercel cleanUrls: /admin -> admin.html
    const full = path.join(root, file);
    const insideData = full.includes(path.sep + ".data" + path.sep);
    if (!full.startsWith(root) || full.includes("node_modules") || full.includes(path.sep + "api" + path.sep) ||
        (insideData && !full.includes(path.sep + ".data" + path.sep + "uploads" + path.sep))) throw new Error("forbidden");
    const data = await fs.readFile(full);
    res.writeHead(200, { "Content-Type": types[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    if (!res.headersSent) res.writeHead(e.code === "ERR_MODULE_NOT_FOUND" || e.code === "ENOENT" ? 404 : 500);
    res.end(e.code === "ENOENT" || e.code === "ERR_MODULE_NOT_FOUND" ? "Not found" : String(e.message));
  }
}).listen(port, () => console.log("Micheng dev server on http://localhost:" + port));
