// Finance: bank accounts and entries (receivables and payables). Admin-only,
// stored encrypted. An entry is "open" until it is paid/received, then it moves
// into its bank account's statement, where it can be ticked as reconciled
// against the bank's own statement.
import crypto from "node:crypto";
import { send, fail, readJson, queryParam, isJsonRequest } from "./_lib/http.js";
import { getSession } from "./_lib/auth.js";
import { getFinance, saveFinance, getPrivate, oneChangeAtATime, saveSecretFile, readSecretFile, deleteSecretFile } from "./_lib/store.js";
import { parseDecimal } from "./_lib/decimal.js";

const CURRENCIES = ["CNY", "USD", "EUR", "BRL"];
const MAX_REPEAT = 60;
const MAX_CHECKS = 30;

function text(value, max) {
  return String(value == null ? "" : value).replace(/\r\n/g, "\n").trim().slice(0, max);
}
function isoDate(value) {
  const v = String(value || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v + "T00:00:00Z")) ? v : null;
}
// Signed amount (an opening balance may be negative).
function signedMoney(value) {
  const s = String(value == null ? "" : value).trim();
  const neg = /^-/.test(s);
  const n = parseDecimal(neg ? s.slice(1) : s);
  return n == null ? null : neg ? -n : n;
}
function round2(n) { return Math.round(n * 100) / 100; }

// Same day N months later (31 Jan + 1 month = 28/29 Feb).
function addMonths(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

/* ----- Attached files: monthly bank statements and payment receipts ----- */
const MAX_FILE_BYTES = 3 * 1024 * 1024; // the request (base64) must stay under Vercel's 4.5 MB
const FILE_TYPES = {
  "application/pdf": (b) => b.subarray(0, 4).toString() === "%PDF",
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
  "image/png": (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  "image/webp": (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP",
};

function decodeFile(body) {
  const m = /^data:([a-z/]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ""));
  if (!m || !FILE_TYPES[m[1]]) return { error: "Unsupported file" };
  const buffer = Buffer.from(m[2], "base64");
  if (buffer.length > MAX_FILE_BYTES) return { error: "File too large" };
  if (!FILE_TYPES[m[1]](buffer)) return { error: "Unsupported file" };
  const name = text(body.name, 120).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim() || "file";
  return { buffer, type: m[1], name };
}

// Every attached file with where it is kept: [{ file, list }].
function allFiles(fin) {
  const out = [];
  for (const a of fin.accounts) for (const f of a.statements || []) out.push({ file: f, owner: a, key: "statements" });
  for (const e of fin.entries) for (const f of e.attachments || []) out.push({ file: f, owner: e, key: "attachments" });
  return out;
}

// Metadata sent to the browser (never the storage address).
function publicFile(f) {
  return { id: f.id, name: f.name, type: f.type, size: f.size, month: f.month || null, uploadedAt: f.uploadedAt, by: f.by };
}
function withoutRefs(obj, key) {
  return obj[key] ? { ...obj, [key]: obj[key].map(publicFile) } : obj;
}
export const accountOut = (a) => withoutRefs(a, "statements");
export const entryOut = (e) => withoutRefs(e, "attachments");

function cleanAccount(body, existing) {
  const name = text(body.name, 80);
  if (!name) return { error: "Account name is required" };
  const currency = CURRENCIES.includes(body.currency) ? body.currency : existing ? existing.currency : "CNY";
  const openingBalance = body.openingBalance === "" || body.openingBalance == null ? 0 : signedMoney(body.openingBalance);
  if (openingBalance == null) return { error: "Invalid opening balance" };
  return {
    name,
    bank: text(body.bank, 120),
    number: text(body.number, 60),
    currency,
    openingBalance: round2(openingBalance),
    openingDate: isoDate(body.openingDate) || (existing && existing.openingDate) || new Date().toISOString().slice(0, 10),
    notes: text(body.notes, 500),
  };
}

// Validates an entry. Returns { entry } (fields only) or { error }.
function cleanEntry(body, fin, priv, existing) {
  const type = body.type === "in" || body.type === "out" ? body.type : existing ? existing.type : null;
  if (!type) return { error: "Type is required" };
  const description = text(body.description, 200);
  if (!description) return { error: "Description is required" };
  const amount = parseDecimal(body.amount);
  if (!(amount > 0)) return { error: "Amount must be greater than zero" };
  const dueDate = isoDate(body.dueDate);
  if (!dueDate) return { error: "Due date is required" };
  let currency = CURRENCIES.includes(body.currency) ? body.currency : existing ? existing.currency : "CNY";

  let accountId = String(body.accountId || "");
  const account = accountId ? fin.accounts.find((a) => a.id === accountId) : null;
  if (accountId && !account) return { error: "Unknown bank account" };
  if (account) currency = account.currency; // money moves in the account's currency
  if (!account) accountId = null;

  const paid = body.status === "paid";
  const paidDate = paid ? isoDate(body.paidDate) : null;
  if (paid && !paidDate) return { error: "Payment date is required" };
  if (paid && !account) return { error: "Choose the bank account of the payment" };
  // Money that moved before the opening balance is already inside that balance.
  if (paid && paidDate < account.openingDate) return { error: "Payment date is before the account's opening balance" };

  // Who pays / receives: a registered client or supplier, or a name typed freely.
  let party = null;
  const client = body.clientId && priv.clients.find((c) => c.id === body.clientId);
  const supplier = body.supplierId && priv.suppliers.find((s) => s.id === body.supplierId);
  if (client) party = { kind: "client", id: client.id, name: client.name };
  else if (supplier) party = { kind: "supplier", id: supplier.id, name: supplier.company };
  else if (text(body.partyName, 160)) party = { kind: "other", id: null, name: text(body.partyName, 160) };

  const pf = body.proformaId && priv.proformas.find((p) => p.id === body.proformaId);

  return {
    entry: {
      type,
      description,
      category: text(body.category, 60),
      party,
      proformaId: pf ? pf.id : null,
      proformaNumber: pf ? pf.number : null,
      amount: round2(amount),
      currency,
      dueDate,
      accountId,
      status: paid ? "paid" : "open",
      paidDate,
      // Reconciled only makes sense for money that actually moved.
      reconciled: paid && Boolean(existing && existing.reconciled && existing.paidDate === paidDate && existing.accountId === accountId && existing.amount === round2(amount)),
      document: text(body.document, 60),
      notes: text(body.notes, 1000),
    },
  };
}

async function handler(req, res) {
  try {
    const session = getSession(req);
    if (!session) return fail(res, 401, "Login required");
    if (req.method !== "GET" && req.method !== "DELETE" && !isJsonRequest(req)) return fail(res, 415, "Expected JSON");

    const fin = await getFinance();
    const kind = queryParam(req, "kind");
    const id = queryParam(req, "id");
    const action = queryParam(req, "action");

    // Opens an attached file (decrypted), only for a logged-in admin.
    if (req.method === "GET" && kind === "file") {
      const found = allFiles(fin).find((x) => x.file.id === id);
      if (!found) return fail(res, 404, "File not found");
      const buffer = await readSecretFile(found.file.ref);
      res.statusCode = 200;
      res.setHeader("Content-Type", found.file.type);
      res.setHeader("Content-Length", buffer.length);
      res.setHeader("Content-Disposition", (queryParam(req, "download") ? "attachment" : "inline") + "; filename*=UTF-8''" + encodeURIComponent(found.file.name));
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.end(buffer);
    }
    if (req.method === "GET") return send(res, 200, { accounts: fin.accounts.map(accountOut), entries: fin.entries.map(entryOut) });

    const now = new Date().toISOString();
    const body = req.method === "DELETE" ? {} : await readJson(req);

    /* ----- Attached files ----- */
    if (kind === "file") {
      if (req.method === "POST") {
        const target = queryParam(req, "target");
        const owner = target === "account" ? fin.accounts.find((a) => a.id === id) : target === "entry" ? fin.entries.find((e) => e.id === id) : null;
        if (!owner) return fail(res, 404, target === "account" ? "Account not found" : "Entry not found");
        const month = target === "account" ? String(queryParam(req, "month") || "") : null;
        if (target === "account" && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return fail(res, 400, "Month is required");
        const f = decodeFile(body);
        if (f.error) return fail(res, 400, f.error);
        const file = { id: crypto.randomUUID(), name: f.name, type: f.type, size: f.buffer.length, ref: await saveSecretFile(f.buffer), uploadedAt: now, by: session.u };
        if (month) file.month = month;
        const key = target === "account" ? "statements" : "attachments";
        owner[key] = (owner[key] || []).concat(file);
        owner.updatedAt = now;
        try {
          await saveFinance(fin);
        } catch (e) {
          await deleteSecretFile(file.ref); // nothing points to it
          throw e;
        }
        return send(res, 201, target === "account" ? { account: accountOut(owner) } : { entry: entryOut(owner) });
      }
      if (req.method === "DELETE") {
        const found = allFiles(fin).find((x) => x.file.id === id);
        if (!found) return fail(res, 404, "File not found");
        found.owner[found.key] = found.owner[found.key].filter((f) => f.id !== id);
        found.owner.updatedAt = now;
        await saveFinance(fin);
        await deleteSecretFile(found.file.ref);
        return send(res, 200, found.key === "statements" ? { account: accountOut(found.owner) } : { entry: entryOut(found.owner) });
      }
      return fail(res, 405, "Method not allowed");
    }

    /* ----- Bank accounts ----- */
    if (kind === "account") {
      if (req.method === "POST" && !id) {
        const r = cleanAccount(body, null);
        if (r.error) return fail(res, 400, r.error);
        const account = { id: crypto.randomUUID(), ...r, checks: [], createdAt: now, updatedAt: now };
        fin.accounts.push(account);
        await saveFinance(fin);
        return send(res, 201, { account: accountOut(account) });
      }
      const index = fin.accounts.findIndex((a) => a.id === id);
      if (index < 0) return fail(res, 404, "Account not found");
      const current = fin.accounts[index];

      // The balance the bank's own statement shows on a date, to compare with ours.
      if (req.method === "POST" && action === "check") {
        const date = isoDate(body.date);
        const balance = signedMoney(body.balance);
        if (!date || balance == null) return fail(res, 400, "Date and balance are required");
        const checks = (current.checks || []).filter((c) => c.date !== date);
        checks.push({ date, balance: round2(balance), at: now, by: session.u });
        checks.sort((a, b) => a.date.localeCompare(b.date));
        fin.accounts[index] = { ...current, checks: checks.slice(-MAX_CHECKS), updatedAt: now };
        await saveFinance(fin);
        return send(res, 200, { account: accountOut(fin.accounts[index]) });
      }
      if (req.method === "PUT") {
        const r = cleanAccount(body, current);
        if (r.error) return fail(res, 400, r.error);
        const used = fin.entries.some((e) => e.accountId === id);
        if (used && r.currency !== current.currency) return fail(res, 409, "Account currency cannot change: it has entries");
        // Paid entries must stay on or after the opening balance date, or they would drop out of the statement.
        if (fin.entries.some((e) => e.accountId === id && e.status === "paid" && e.paidDate < r.openingDate)) return fail(res, 409, "Opening date is after payments already recorded");
        fin.accounts[index] = { ...current, ...r, updatedAt: now };
        await saveFinance(fin);
        return send(res, 200, { account: accountOut(fin.accounts[index]) });
      }
      if (req.method === "DELETE") {
        if (fin.entries.some((e) => e.accountId === id)) return fail(res, 409, "Account has entries");
        const [gone] = fin.accounts.splice(index, 1);
        await saveFinance(fin);
        for (const f of gone.statements || []) await deleteSecretFile(f.ref);
        return send(res, 200, { ok: true });
      }
      return fail(res, 405, "Method not allowed");
    }

    /* ----- Entries (receivables and payables) ----- */
    if (kind === "entry") {
      const priv = req.method === "POST" && !id || req.method === "PUT" ? await getPrivate() : null;

      if (req.method === "POST" && !id) {
        const r = cleanEntry(body, fin, priv, null);
        if (r.error) return fail(res, 400, r.error);
        // Repeat monthly (installments or a recurring bill): "Rent (2/12)".
        const repeat = Math.min(MAX_REPEAT, Math.max(1, parseInt(body.repeat, 10) || 1));
        const group = repeat > 1 ? crypto.randomUUID() : null;
        const created = [];
        for (let n = 0; n < repeat; n++) {
          const e = { id: crypto.randomUUID(), ...r.entry, createdAt: now, updatedAt: now, createdBy: session.u };
          if (group) {
            e.group = group;
            e.installment = { n: n + 1, of: repeat };
            e.dueDate = addMonths(r.entry.dueDate, n);
            if (n > 0) { e.status = "open"; e.paidDate = null; e.reconciled = false; } // only the first may already be paid
          }
          created.push(e);
        }
        fin.entries.push(...created);
        await saveFinance(fin);
        return send(res, 201, { entries: created.map(entryOut) });
      }

      const index = fin.entries.findIndex((e) => e.id === id);
      if (index < 0) return fail(res, 404, "Entry not found");
      const current = fin.entries[index];

      if (req.method === "PUT") {
        const r = cleanEntry(body, fin, priv, current);
        if (r.error) return fail(res, 400, r.error);
        fin.entries[index] = { ...current, ...r.entry, updatedAt: now, updatedBy: session.u };
        await saveFinance(fin);
        return send(res, 200, { entry: entryOut(fin.entries[index]) });
      }
      if (req.method === "POST" && action === "pay") {
        const paidDate = isoDate(body.paidDate);
        const account = fin.accounts.find((a) => a.id === body.accountId);
        if (!paidDate) return fail(res, 400, "Payment date is required");
        if (!account) return fail(res, 400, "Choose the bank account of the payment");
        if (account.currency !== current.currency) return fail(res, 400, "The account's currency is different from the entry's");
        if (paidDate < account.openingDate) return fail(res, 400, "Payment date is before the account's opening balance");
        const amount = body.amount == null || body.amount === "" ? current.amount : parseDecimal(body.amount);
        if (!(amount > 0)) return fail(res, 400, "Amount must be greater than zero");
        fin.entries[index] = { ...current, status: "paid", paidDate, accountId: account.id, amount: round2(amount), reconciled: false, updatedAt: now, updatedBy: session.u };
        await saveFinance(fin);
        return send(res, 200, { entry: entryOut(fin.entries[index]) });
      }
      if (req.method === "POST" && action === "unpay") {
        fin.entries[index] = { ...current, status: "open", paidDate: null, reconciled: false, updatedAt: now, updatedBy: session.u };
        await saveFinance(fin);
        return send(res, 200, { entry: entryOut(fin.entries[index]) });
      }
      if (req.method === "POST" && action === "reconcile") {
        if (current.status !== "paid") return fail(res, 409, "Only paid entries can be reconciled");
        fin.entries[index] = { ...current, reconciled: Boolean(body.reconciled), reconciledAt: body.reconciled ? now : null, updatedAt: now };
        await saveFinance(fin);
        return send(res, 200, { entry: entryOut(fin.entries[index]) });
      }
      if (req.method === "DELETE") {
        const [gone] = fin.entries.splice(index, 1);
        await saveFinance(fin);
        for (const f of gone.attachments || []) await deleteSecretFile(f.ref);
        return send(res, 200, { ok: true });
      }
      return fail(res, 405, "Method not allowed");
    }

    fail(res, 400, "Unknown kind");
  } catch (e) {
    console.error(e);
    fail(res, /JSON/.test(e.message) ? 400 : 500, /JSON/.test(e.message) ? "Invalid JSON" : "Server error");
  }
}

export default oneChangeAtATime(handler);
