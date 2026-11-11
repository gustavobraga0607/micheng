import crypto from "node:crypto";
import { parseCookies } from "./http.js";

const COOKIE = "mc_session";
const MAX_AGE = 12 * 60 * 60; // seconds

// Without SESSION_SECRET (local development only) sessions last until restart.
const devSecret = crypto.randomBytes(32).toString("hex");
function secret() {
  return process.env.SESSION_SECRET || devSecret;
}

// The signature also depends on the user's current password, so changing a
// password (or removing an admin) ends that user's open sessions at once.
function sign(value, user) {
  const stored = adminAccounts()[user];
  const credential = stored == null ? "" : crypto.createHash("sha256").update(String(stored)).digest("hex");
  return crypto.createHmac("sha256", secret() + ":" + credential).update(value).digest("base64url");
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Administrators: the main one from ADMIN_USER / ADMIN_PASSWORD, plus any extra
// ones in ADMIN_USERS, a JSON object {"user": "scrypt:<salt>:<hash>"} (a plain
// password also works there, but hashes keep it out of the settings screen).
function adminAccounts() {
  const accounts = Object.create(null); // no inherited keys: "constructor" is not a user
  if (process.env.ADMIN_PASSWORD) accounts[(process.env.ADMIN_USER || "admin").toLowerCase()] = process.env.ADMIN_PASSWORD;
  if (process.env.ADMIN_USERS) {
    try {
      const extra = JSON.parse(process.env.ADMIN_USERS);
      Object.keys(extra).forEach((u) => (accounts[u.trim().toLowerCase()] = String(extra[u])));
    } catch (e) {
      console.error("ADMIN_USERS is not valid JSON");
    }
  }
  return accounts;
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString("base64url")) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString("base64url");
  return "scrypt:" + salt + ":" + hash;
}

function passwordMatches(password, stored) {
  if (stored.startsWith("scrypt:")) {
    const salt = stored.split(":")[1];
    return safeEqual(hashPassword(password, salt), stored);
  }
  return safeEqual(password, stored);
}

export function adminConfigured() {
  return Object.keys(adminAccounts()).length > 0;
}

export function checkCredentials(user, password) {
  const accounts = adminAccounts();
  const name = String(user || "").trim().toLowerCase();
  // Unknown users still pay for a hash, so timing does not reveal valid names.
  const stored = accounts[name] || hashPassword("unused");
  const ok = passwordMatches(password || "", stored);
  return Boolean(accounts[name]) && ok;
}

function isSecure(req) {
  return req.headers["x-forwarded-proto"] === "https" || process.env.VERCEL === "1";
}

export function createSession(req, res, user) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + MAX_AGE * 1000 })).toString("base64url");
  const token = payload + "." + sign(payload, user);
  const attrs = ["Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=" + MAX_AGE];
  if (isSecure(req)) attrs.push("Secure");
  res.setHeader("Set-Cookie", COOKIE + "=" + token + "; " + attrs.join("; "));
}

export function clearSession(req, res) {
  const attrs = ["Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (isSecure(req)) attrs.push("Secure");
  res.setHeader("Set-Cookie", COOKIE + "=; " + attrs.join("; "));
}

export function getSession(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token || token.indexOf(".") < 0) return null;
  const [payload, signature] = token.split(".");
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const user = String(data.u || "");
    if (!(user in adminAccounts())) return null; // admin removed
    if (!safeEqual(signature, sign(payload, user))) return null;
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch (e) {
    return null;
  }
}
