import crypto from "node:crypto";
import { parseCookies } from "./http.js";

const COOKIE = "mc_session";
const MAX_AGE = 12 * 60 * 60; // seconds

// Without SESSION_SECRET (local development only) sessions last until restart.
const devSecret = crypto.randomBytes(32).toString("hex");
function secret() {
  return process.env.SESSION_SECRET || devSecret;
}

function sign(value) {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function adminConfigured() {
  return Boolean(process.env.ADMIN_PASSWORD);
}

export function checkCredentials(user, password) {
  const expectedUser = process.env.ADMIN_USER || "admin";
  const expectedPass = process.env.ADMIN_PASSWORD;
  if (!expectedPass) return false;
  // Evaluate both comparisons so timing does not reveal which one failed.
  const okUser = safeEqual(String(user || "").trim().toLowerCase(), expectedUser.toLowerCase());
  const okPass = safeEqual(password || "", expectedPass);
  return okUser && okPass;
}

function isSecure(req) {
  return req.headers["x-forwarded-proto"] === "https" || process.env.VERCEL === "1";
}

export function createSession(req, res, user) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + MAX_AGE * 1000 })).toString("base64url");
  const token = payload + "." + sign(payload);
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
  if (!safeEqual(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch (e) {
    return null;
  }
}
