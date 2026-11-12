// Puts a version in the address of the site's own CSS/JS files (?v=<version>),
// so after each deploy browsers load the new code together with the new pages.
// Usage (on the folder being deployed): node scripts/stamp-assets.mjs <dir> <version>
import fs from "node:fs";
import path from "node:path";

const [dir = ".", version = Date.now().toString(36)] = process.argv.slice(2);
for (const file of ["index.html", "products.html", "admin.html", "proforma.html"]) {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) continue;
  const html = fs.readFileSync(full, "utf8")
    .replace(/((?:src|href)="assets\/(?:js|css)\/[^"?]+\.(?:js|css))(\?v=[^"]*)?"/g, "$1?v=" + version + '"');
  fs.writeFileSync(full, html);
  console.log("stamped", file, version);
}
