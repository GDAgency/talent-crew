// Talent & Crew — ledger server.
// Zero dependencies: Node 22+ (node:http + node:sqlite).
// Serves the installable web app from /public and a small JSON API:
//   accounts & sessions, offline-friendly record sync, receipt photo storage.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const PHOTO_DIR = path.join(DATA_DIR, "photos");
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const SESSION_DAYS = 90;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const COLLECTIONS = new Set(["people", "shifts", "payments", "receipts", "settings", "jobs", "places", "requests"]);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---------- Two sites, one server ----------
// ADMIN_HOSTS (e.g. adminlumia.rogatski.com) is the office site: admin accounts only.
// CLIENT_HOSTS (e.g. lumia.rogatski.com) is the public site: staff and customer accounts,
// and where both sign up (set SIGNUPS=off to close registration).
// With neither set (running on your own computer) any host serves everyone.
// ADMIN_PATH (e.g. /admin) instead puts the office site under that path of the public site:
// lumia.rogatski.com/admin/. ADMIN_HOSTS then only redirect there, so old links keep working.
const hostList = (v) => String(v || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const ADMIN_HOSTS = hostList(process.env.ADMIN_HOSTS);
const CLIENT_HOSTS = hostList(process.env.CLIENT_HOSTS);
const ADMIN_PATH = (() => {
  const v = String(process.env.ADMIN_PATH || "").trim().replace(/\/+$/, "");
  if (!v) return "";
  if (!/^\/[a-z0-9_-]+$/i.test(v)) throw new Error("ADMIN_PATH must look like /admin");
  return v.toLowerCase();
})();
const SPLIT_SITES = ADMIN_HOSTS.length > 0 || CLIENT_HOSTS.length > 0 || !!ADMIN_PATH;
// First-run setup can require a one-time code, so nobody who finds the site first can claim it.
const SETUP_CODE = String(process.env.SETUP_CODE || "");
const SIGNUPS = String(process.env.SIGNUPS || "on").toLowerCase() !== "off";
const hostOf = (req) => String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
const pathOf = (req) => String(req.url || "/").split("?")[0];
const underAdminPath = (req) => !!ADMIN_PATH && (pathOf(req) === ADMIN_PATH || pathOf(req).startsWith(ADMIN_PATH + "/"));
function siteOf(req) {
  if (!SPLIT_SITES) return "any";
  const host = hostOf(req);
  if (ADMIN_HOSTS.includes(host)) return "admin";
  // With ADMIN_PATH and no CLIENT_HOSTS, any other address is the public site.
  if (CLIENT_HOSTS.includes(host) || (ADMIN_PATH && !CLIENT_HOSTS.length)) return underAdminPath(req) ? "admin" : "client";
  return "unknown";
}
const roleAllowed = (site, role) => site === "any" || (site === "admin" && role === "admin") || (site === "client" && role !== "admin");
const ADMIN_URL = ADMIN_PATH ? (CLIENT_HOSTS[0] ? `https://${CLIENT_HOSTS[0]}` : "") + ADMIN_PATH + "/" : ADMIN_HOSTS[0] ? `https://${ADMIN_HOSTS[0]}` : null;
const CLIENT_URL = CLIENT_HOSTS[0] ? `https://${CLIENT_HOSTS[0]}` : ADMIN_PATH ? "/" : null;
const shortUrl = (u) => String(u || "").replace(/^https:\/\//, "").replace(/\/$/, "");
function wrongSiteMessage(site) {
  return site === "admin"
    ? `Questo è il sito dell'ufficio, per gli amministratori. La squadra accede da ${shortUrl(CLIENT_URL) || "il sito della squadra"}.`
    : `Gli amministratori accedono dal sito dell'ufficio: ${shortUrl(ADMIN_URL) || "il sito dell'ufficio"}.`;
}
// The office site under a path keeps its own sign-in, so one browser can be in both sites.
const cookieFor = (req) => (ADMIN_PATH && underAdminPath(req) ? { name: "tc_admin", path: ADMIN_PATH } : { name: "tc_session", path: "/" });

fs.mkdirSync(PHOTO_DIR, { recursive: true });

// ---------- Database ----------
const db = new DatabaseSync(path.join(DATA_DIR, "ledger.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    pw_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','staff','client')),
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS records (
    c TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (c, id)
  );
  CREATE INDEX IF NOT EXISTS records_rev ON records(rev);
  CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  INSERT OR IGNORE INTO counters VALUES ('rev', 0);
`);

// Change history: one row per accepted change, written only by this server.
// It is not a synced collection, and triggers keep it append-only.
db.exec(`
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    user_id TEXT,
    actor TEXT NOT NULL,
    verb TEXT NOT NULL,
    c TEXT,
    rec_id TEXT,
    person_id TEXT,
    person_name TEXT,
    info TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS audit_person ON audit(person_id, id);
  CREATE INDEX IF NOT EXISTS audit_user ON audit(user_id, id);
  CREATE INDEX IF NOT EXISTS audit_verb_at ON audit(verb, at);
  CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
`);
// A login can be linked to the person it belongs to on the board ("My page").
if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "person_id")) db.exec("ALTER TABLE users ADD COLUMN person_id TEXT");

// Customers are a third kind of account. Databases created before that have a CHECK that
// refuses the role, and SQLite can't alter a CHECK: rebuild the table once, in a transaction.
if (!db.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").get().sql.includes("'client'")) {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE users_new (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      pw_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','staff','client')),
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      person_id TEXT
    );
    INSERT INTO users_new (id, username, name, pw_hash, role, disabled, created_at, person_id)
      SELECT id, username, name, pw_hash, role, disabled, created_at, person_id FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;`);
  db.exec("PRAGMA foreign_keys = ON");
  console.log("Accounts table upgraded for customer accounts.");
}
// Self sign-up: staff wait for the office (pending); customers say which company they are
// (company) and the office confirms which client they see jobs for (client_name).
{
  const cols = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
  for (const [name, type] of [["pending", "INTEGER NOT NULL DEFAULT 0"], ["company", "TEXT"], ["client_name", "TEXT"], ["phone", "TEXT"], ["wants", "TEXT"]]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  }
}

const q = {
  userCount: db.prepare("SELECT COUNT(*) AS n FROM users"),
  userByName: db.prepare("SELECT * FROM users WHERE username = ?"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  users: db.prepare("SELECT id, username, name, role, disabled, created_at, person_id AS personId, pending, company, client_name AS clientName, phone, wants FROM users ORDER BY name COLLATE NOCASE"),
  liveRecs: db.prepare("SELECT data FROM records WHERE c = ? AND deleted = 0"),
  insertUser: db.prepare("INSERT INTO users (id, username, name, pw_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
  session: db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0"),
  insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  deleteUserSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
  purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
  getRec: db.prepare("SELECT * FROM records WHERE c = ? AND id = ?"),
  upsertRec: db.prepare(`INSERT INTO records (c, id, data, updated_at, rev, deleted) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (c, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, rev = excluded.rev, deleted = excluded.deleted`),
  since: db.prepare("SELECT c, id, data, rev FROM records WHERE rev > ? ORDER BY rev LIMIT ?"),
  bumpRev: db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'rev' RETURNING value"),
  curRev: db.prepare("SELECT value FROM counters WHERE name = 'rev'"),
  insertAudit: db.prepare("INSERT INTO audit (at, user_id, actor, verb, c, rec_id, person_id, person_name, info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  checkins: db.prepare(`SELECT at, person_id, info FROM audit WHERE verb = 'person.checkin' AND at >= ? AND at < ?
    AND (? = '' OR person_id = ?) ORDER BY at LIMIT 5000`),
  auditPage: db.prepare(`SELECT a.*, u.name AS cur_name FROM audit a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.id < ? AND (? = '' OR a.person_id = ?) AND (? = '' OR a.user_id = ?) ORDER BY a.id DESC LIMIT ?`),
};

// ---------- Helpers ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}
function checkPassword(pw, stored) {
  const [, s, h] = String(stored).split("$");
  if (!s || !h) return false;
  const expected = Buffer.from(h, "base64");
  const got = crypto.scryptSync(pw, Buffer.from(s, "base64"), expected.length);
  return crypto.timingSafeEqual(expected, got);
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, personId: u.person_id || null, pending: !!u.pending, company: u.company || "", clientName: u.client_name || "" });
const str = (v, max = 500) => String(v ?? "").slice(0, max);

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isSecure(req) {
  return process.env.COOKIE_SECURE === "1" || req.headers["x-forwarded-proto"] === "https";
}
function sessionCookie(req, token, maxAge) {
  const c = cookieFor(req);
  return `${c.name}=${token}; HttpOnly; Path=${c.path}; SameSite=Lax; Max-Age=${maxAge}${isSecure(req) ? "; Secure" : ""}`;
}
function currentUser(req) {
  const token = parseCookies(req)[cookieFor(req).name];
  if (!token) return null;
  const u = q.session.get(sha256(token), Date.now()) || null;
  // A session only works on the site that matches the account's role (re-checked on every
  // request, so promoting or demoting someone moves them to the other site).
  return u && roleAllowed(siteOf(req), u.role) ? u : null;
}
function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString("base64url");
  q.insertSession.run(sha256(token), user.id, Date.now() + SESSION_DAYS * 864e5);
  res.setHeader("Set-Cookie", sessionCookie(req, token, SESSION_DAYS * 86400));
}

function send(res, status, body, headers = {}) {
  const isJson = body !== undefined && !(body instanceof Buffer) && typeof body !== "string";
  res.writeHead(status, {
    "Content-Type": isJson ? "application/json; charset=utf-8" : headers["Content-Type"] || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}
const fail = (res, status, error) => send(res, status, { error });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("too_large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req, limit = 2 * 1024 * 1024) {
  const buf = await readBody(req, limit);
  try { return JSON.parse(buf.toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("bad_json"), { status: 400 }); }
}

// Simple in-memory login throttle: 10 failed attempts per IP per 15 minutes.
const loginFails = new Map();
function throttled(ip) {
  const e = loginFails.get(ip);
  if (!e || e.until < Date.now()) return false;
  return e.count >= 10;
}
function noteFail(ip) {
  const e = loginFails.get(ip);
  if (!e || e.until < Date.now()) loginFails.set(ip, { count: 1, until: Date.now() + 15 * 60e3 });
  else e.count++;
}

function validUsername(u) { return /^[a-zA-Z0-9._@-]{3,40}$/.test(u); }
function validPassword(p) { return typeof p === "string" && p.length >= 8 && p.length <= 200; }

// ---------- Pay terms ----------
// A shift carries a snapshot of the pay terms it was logged under, so later rate
// changes don't rewrite history. Staff can't choose those terms: a staff edit keeps
// the shift's existing snapshot (same person), otherwise it takes the person's
// current terms. Mirrors payTerms() in the app; missing fields = hourly, no overtime.
const PAY_KEYS = ["payType", "rate", "dayRate", "halfDayRate", "halfDayUnder", "otAfter", "otMult"];
const posNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
function payTermsOf(x) {
  const day = x.payType === "day";
  return {
    payType: day ? "day" : "hourly", rate: Number(x.rate) || 0,
    dayRate: day ? posNum(x.dayRate) : 0, halfDayRate: day ? posNum(x.halfDayRate) : 0, halfDayUnder: day ? posNum(x.halfDayUnder) : 0,
    otAfter: posNum(x.otAfter), otMult: posNum(x.otMult) || 1,
  };
}
function forceShiftTerms(prev, data) {
  if (prev && !prev.deleted && prev.personId === data.personId) {
    for (const k of PAY_KEYS) { if (k in prev) data[k] = prev[k]; else delete data[k]; }
    return true;
  }
  const rec = q.getRec.get("people", String(data.personId ?? ""));
  if (!rec || rec.deleted) return false;
  Object.assign(data, payTermsOf(JSON.parse(rec.data)));
  return true;
}

// ---------- Sync ----------
// Jobs (bookings) are admin-only to write: applyChange's staff branch denies any
// collection it doesn't list. Staff can read jobs, but not the client billing on them.
const JOB_MONEY_FIELDS = ["billing", "fee", "clientRate", "invoiceStatus", "clientPaidAt", "crewPaid", "archived", "archivedAt"];
// Staff see only their own money. A login linked to a person on the board gets that
// person's rates, hours, receipts and payments, plus any hours or receipts the login
// entered itself. Everyone else on the board comes through as name, role and location,
// and other people's money records arrive as deletions so they vanish from devices.
const PERSON_MONEY_FIELDS = PAY_KEYS;
const ownsPerson = (user, personId) => !!user.person_id && personId === user.person_id;
function visibleTo(user, c, data) {
  if (user.role === "admin" || !data) return true;
  if (c === "requests") return false;
  if (c === "payments") return ownsPerson(user, data.personId);
  if (c === "shifts" || c === "receipts") return ownsPerson(user, data.personId) || data.by === user.id;
  return true;
}
function redactFor(user, c, data) {
  if (user.role === "admin" || !data) return data;
  if (!visibleTo(user, c, data)) return { id: data.id, deleted: true, updatedAt: data.updatedAt };
  if (c === "jobs") {
    const out = { ...data };
    for (const k of JOB_MONEY_FIELDS) delete out[k];
    return out;
  }
  if (c === "people" && !ownsPerson(user, data.id)) {
    const out = { ...data };
    for (const k of PERSON_MONEY_FIELDS) delete out[k];
    return out;
  }
  return data;
}

// Applies one client change. Last writer wins by updatedAt. Staff accounts may
// log hours, add receipts and update anyone's location; everything that moves
// money (people, rates, payments, reimbursements, settings) is admin-only.
function applyChange(user, ch) {
  if (!ch || !COLLECTIONS.has(ch.c) || !ID_RE.test(String(ch.id)) || !ch.data || typeof ch.data !== "object" || Array.isArray(ch.data)) {
    return { result: "invalid" };
  }
  if (JSON.stringify(ch.data).length > 32 * 1024) return { result: "invalid" };
  const existing = q.getRec.get(ch.c, ch.id);
  const prev = existing ? JSON.parse(existing.data) : null;
  const t = Math.min(Number(ch.data.updatedAt) || Date.now(), Date.now() + 60e3);
  if (existing && existing.updated_at > t) return { result: "stale", existing };

  const admin = user.role === "admin";
  let data = { ...ch.data };
  if (!admin) {
    if (ch.c === "people") {
      if (!prev || prev.deleted) return { result: "denied", existing };
      data = { ...prev, location: str(data.location, 200), locationAt: Number(data.locationAt) || Date.now() };
    } else if (ch.c === "shifts" || ch.c === "receipts") {
      if (prev && prev.by !== user.id) return { result: "denied", existing };
      if (ch.c === "receipts") {
        data.status = prev?.status || "pending";
        data.reimbursedAt = prev?.reimbursedAt ?? null;
      }
      if (ch.c === "shifts" && !data.deleted && !forceShiftTerms(prev, data)) return { result: "denied", existing };
    } else {
      return { result: "denied", existing };
    }
  }
  // Once a photo is on the server, an edit made from an older copy can't unset it.
  if (ch.c === "receipts" && prev?.photoUploaded) {
    data.hasPhoto = true; data.photoType = prev.photoType; data.photoUploaded = true;
  }
  if (ch.c === "shifts" && !data.deleted) applyApproval(user, prev, data);
  data.id = ch.id;
  data.by = prev?.by ?? user.id;
  data.createdAt = prev?.createdAt ?? (Number(data.createdAt) || Date.now());
  data.updatedAt = t;
  data.deleted = !!data.deleted;

  const rev = q.bumpRev.get().value;
  q.upsertRec.run(ch.c, ch.id, JSON.stringify(data), t, rev, data.deleted ? 1 : 0);
  if (ch.c === "receipts" && data.deleted) fs.rm(photoPath(ch.id), { force: true }, () => {});
  auditChange(user, ch.c, ch.id, prev, data);
  return { result: "ok" };
}

// ---------- Approval of hours ----------
// Hours logged by staff wait for an admin. Only "approved" shifts count toward
// what is owed; a shift with no approval field (logged before this existed) is
// approved. Staff can't set these fields: they're derived here from the change.
const APPROVAL_FIELDS = ["approval", "approvalNote", "approvedBy", "approvedAt"];
const SHIFT_META = new Set(["id", "by", "createdAt", "updatedAt", "deleted", ...APPROVAL_FIELDS]);
function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  return JSON.stringify(v ?? null);
}
// What was worked (date, hours, rate, job…), ignoring bookkeeping fields.
const shiftContent = (s) => stable(Object.fromEntries(Object.entries(s || {}).filter(([k]) => !SHIFT_META.has(k))));
function applyApproval(user, prev, data) {
  const live = prev && !prev.deleted ? prev : null;
  const was = live ? live.approval || "approved" : null;
  if (user.role !== "admin") {
    if (!live || shiftContent(live) !== shiftContent(data)) {
      // New, or changed since it was reviewed: back in the queue.
      Object.assign(data, { approval: "pending", approvalNote: "", approvedBy: null, approvedAt: null });
    } else {
      for (const k of APPROVAL_FIELDS) data[k] = live[k] ?? (k === "approval" ? "approved" : null);
    }
    return;
  }
  if (!["approved", "rejected", "pending"].includes(data.approval)) data.approval = was || "approved";
  data.approvalNote = data.approval === "rejected" ? str(data.approvalNote, 300) : "";
  if (data.approval === "pending") { data.approvedBy = null; data.approvedAt = null; }
  else if (data.approval !== was) { data.approvedBy = user.id; data.approvedAt = Date.now(); }
  else { data.approvedBy = live?.approvedBy ?? user.id; data.approvedAt = live?.approvedAt ?? Date.now(); }
}

// ---------- Change history ----------
function personNameOf(id) {
  const r = id && q.getRec.get("people", id);
  return r ? JSON.parse(r.data).name || null : null;
}
function writeAudit(user, verb, { c = null, id = null, personId = null, personName = null, info = {} } = {}) {
  q.insertAudit.run(Date.now(), user.id, user.name, verb, c, id, personId, personName ?? personNameOf(personId), JSON.stringify(info));
}
const num = (v) => Math.round((Number(v) || 0) * 100) / 100;
function auditChange(user, c, id, prev, data) {
  const was = !!prev && !prev.deleted, is = !data.deleted;
  if (!was && !is) return;
  const strip = (o) => { const { updatedAt, ...rest } = o || {}; return stable(rest); };
  if (was && is && strip(prev) === strip(data)) return; // a resend of what's already stored
  const cur = is ? data : prev, add = !was, del = !is;
  let verb, info = {}, personId = cur.personId || null, personName = null;
  if (c === "shifts") {
    info = { hours: num(cur.hours), date: cur.date || "", job: str(cur.job, 80) };
    const before = was ? prev.approval || "approved" : null;
    if (add) { verb = "shift.add"; info.pending = data.approval === "pending"; }
    else if (del) verb = "shift.delete";
    else if (user.role === "admin" && data.approval !== before && data.approval !== "pending") {
      verb = data.approval === "approved" ? "shift.approve" : "shift.reject";
      if (data.approvalNote) info.note = data.approvalNote;
    } else { verb = "shift.edit"; info.reopened = before !== "pending" && data.approval === "pending"; }
  } else if (c === "receipts") {
    info = { amount: num(cur.amount), date: cur.date || "", category: cur.category || "", description: str(cur.description, 80) };
    if (add) verb = "receipt.add";
    else if (del) verb = "receipt.delete";
    else if (prev.status !== data.status) verb = data.status === "reimbursed" ? "receipt.reimburse" : "receipt.unreimburse";
    else verb = "receipt.edit";
  } else if (c === "payments") {
    info = { amount: num((Number(cur.amount) || 0) + (Number(cur.receiptsAmount) || 0)), receipts: (cur.receiptIds || []).length };
    verb = add ? "payment.add" : del ? "payment.delete" : "payment.edit";
  } else if (c === "people") {
    personId = id; personName = cur.name || null;
    const sameBut = (a, b) => strip({ ...a, location: 0, locationAt: 0 }) === strip({ ...b, location: 0, locationAt: 0 });
    if (add) verb = "person.add";
    else if (del) verb = "person.delete";
    else if (num(prev.rate) !== num(data.rate)) { verb = "person.rate"; info = { rate: num(data.rate) }; }
    else if (sameBut(prev, data)) { verb = "person.checkin"; info = { location: str(data.location, 120) }; }
    else verb = "person.edit";
  } else if (c === "settings") {
    verb = "settings.edit"; info = { currency: str(cur.currency, 8) };
  } else if (c === "jobs") {
    // Only the settling of a job is history: client paid, a person ticked as paid, archived.
    if (add || del) return;
    info = { title: str([cur.title, cur.client].filter(Boolean).join(" · "), 120) };
    const paidNow = Object.keys(data.crewPaid || {}).find((k) => !(prev.crewPaid || {})[k]);
    if (!!prev.archived !== !!data.archived) verb = data.archived ? "job.archive" : "job.unarchive";
    else if (prev.invoiceStatus !== data.invoiceStatus && data.invoiceStatus === "paid") verb = "job.clientpaid";
    else if (paidNow) { verb = "job.crewpaid"; personId = paidNow; }
    else return;
  } else if (c === "requests") {
    if (add || del || prev.status === data.status) return;
    verb = data.status === "accepted" ? "request.accept" : data.status === "declined" ? "request.decline" : null;
    if (!verb) return;
    personId = null;
    info = { title: str(cur.title, 120), client: str(cur.clientName, 80) };
  } else if (c === "places") {
    verb = add ? "place.add" : del ? "place.delete" : "place.edit"; info = { name: str(cur.name, 120) };
  } else return;
  writeAudit(user, verb, { c, id, personId, personName, info });
}

function handleSync(user, body) {
  const changes = Array.isArray(body.changes) ? body.changes.slice(0, 500) : [];
  const since = Math.max(0, Number(body.since) || 0);
  const fixes = [];
  let denied = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const ch of changes) {
      const r = applyChange(user, ch);
      if (r.result === "ok") continue;
      if (r.result === "denied" || r.result === "invalid") denied++;
      // Tell the client what the server really holds so it can undo its copy.
      if (r.existing) fixes.push({ c: r.existing.c, id: r.existing.id, data: redactFor(user, r.existing.c, JSON.parse(r.existing.data)) });
      else if (ch && COLLECTIONS.has(ch.c) && ID_RE.test(String(ch.id))) fixes.push({ c: ch.c, id: ch.id, data: null });
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const LIMIT = 2000;
  const rows = q.since.all(since, LIMIT + 1);
  const more = rows.length > LIMIT;
  const page = rows.slice(0, LIMIT);
  const rev = more ? page[page.length - 1].rev : q.curRev.get().value;
  return { rev, more, denied, records: page.map((r) => ({ c: r.c, id: r.id, data: redactFor(user, r.c, JSON.parse(r.data)) })), fixes, me: publicUser(user) };
}

// ---------- Agency address ----------
// The agency's own address is on the saved places list from day one, so check-ins and
// jobs can pick it with one tap. Inserted once; if an admin removes it, it stays removed.
(function seedAgencyPlace() {
  const ADDRESS = process.env.AGENCY_ADDRESS ?? "Piazza Duomo 20, Milano";
  if (!ADDRESS || q.getRec.get("places", "agency-address")) return;
  const now = Date.now(), rev = q.bumpRev.get().value;
  const data = { id: "agency-address", name: ADDRESS, by: null, createdAt: now, updatedAt: now, deleted: false };
  q.upsertRec.run("places", "agency-address", JSON.stringify(data), now, rev, 0);
})();

// ---------- Photos ----------
const photoPath = (id) => path.join(PHOTO_DIR, id);

async function putPhoto(req, res, user, id) {
  const type = String(req.headers["content-type"] || "").split(";")[0].trim();
  if (!PHOTO_TYPES.has(type)) return fail(res, 415, "Usa un file JPEG, PNG, WebP o PDF.");
  const rec = q.getRec.get("receipts", id);
  if (!rec || rec.deleted) return fail(res, 404, "Ricevuta non trovata.");
  const data = JSON.parse(rec.data);
  if (user.role !== "admin" && data.by !== user.id) return fail(res, 403, "Questa ricevuta non è tua.");
  const buf = await readBody(req, MAX_PHOTO_BYTES);
  if (!buf.length) return fail(res, 400, "Il file è vuoto.");
  const tmp = photoPath(id) + ".tmp";
  await fs.promises.writeFile(tmp, buf);
  await fs.promises.rename(tmp, photoPath(id));
  // Record the photo on the receipt so every device knows it is on the server.
  db.exec("BEGIN IMMEDIATE");
  try {
    const cur = JSON.parse(q.getRec.get("receipts", id).data);
    cur.hasPhoto = true; cur.photoType = type; cur.photoUploaded = true;
    const rev = q.bumpRev.get().value;
    const now = Math.max(Date.now(), cur.updatedAt || 0);
    cur.updatedAt = now;
    q.upsertRec.run("receipts", id, JSON.stringify(cur), now, rev, 0);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  send(res, 200, { ok: true });
}

function getPhoto(req, res, user, id) {
  const rec = q.getRec.get("receipts", id);
  if (!rec || rec.deleted) return fail(res, 404, "Non trovato.");
  const data = JSON.parse(rec.data);
  if (!visibleTo(user, "receipts", data)) return fail(res, 404, "Non trovato.");
  const file = photoPath(id);
  fs.stat(file, (err, st) => {
    if (err) return fail(res, 404, "Non trovato.");
    res.writeHead(200, {
      "Content-Type": PHOTO_TYPES.has(data.photoType) ? data.photoType : "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": "inline",
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- Customers ----------
// A customer sees two things: the requests they sent, and the jobs done for them with the
// people sent. A job is theirs when it was created from one of their requests, or when the
// office has confirmed which client the account belongs to and the job is for that client.
const signups = new Map();
const signupThrottled = (ip) => { const e = signups.get(ip); return !!e && e.until > Date.now() && e.count >= 5; };
function noteSignup(ip) {
  const e = signups.get(ip);
  if (!e || e.until < Date.now()) signups.set(ip, { count: 1, until: Date.now() + 3600e3 }); else e.count++;
}
const sameName = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/, HHMM = /^\d{2}:\d{2}$/;
const myRequests = (user) => q.liveRecs.all("requests").map((r) => JSON.parse(r.data)).filter((r) => r.userId === user.id);
function clientOverview(user) {
  const requests = myRequests(user), mine = new Set(requests.map((r) => r.id));
  const people = new Map(q.liveRecs.all("people").map((r) => { const p = JSON.parse(r.data); return [p.id, p]; }));
  const jobs = q.liveRecs.all("jobs").map((r) => JSON.parse(r.data))
    .filter((j) => (j.requestId && mine.has(j.requestId)) || (user.client_name && sameName(j.client, user.client_name)))
    .map((j) => ({
      id: j.id, title: j.title || "", client: j.client || "", date: j.date || "", endDate: j.endDate || "", call: j.call || "", wrap: j.wrap || "", location: j.location || "",
      requestId: j.requestId || "",
      people: (j.people || []).map((id) => people.get(id)).filter(Boolean).map((p) => ({ name: p.name || "", role: p.role || "", speciality: p.speciality || "" })),
      payment: j.invoiceStatus === "paid" ? "paid" : j.invoiceStatus === "invoiced" ? "invoiced" : "none", paidAt: j.clientPaidAt || "",
      fee: j.billing === "hourly" ? null : Number(j.fee) || 0,
    }));
  const set = q.getRec.get("settings", "main"), settings = set && !set.deleted ? JSON.parse(set.data) : {};
  return {
    requests: requests.map(({ userId, by, ...r }) => r).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    jobs: jobs.sort((a, b) => b.date.localeCompare(a.date)),
    currency: settings.currency || "EUR", agency: settings.agencyName || "",
  };
}
function putRecord(c, data) {
  q.upsertRec.run(c, data.id, JSON.stringify(data), data.updatedAt, q.bumpRev.get().value, data.deleted ? 1 : 0);
}
function clientRequest(res, user, b) {
  const title = str(b.title, 120).trim(), date = str(b.date, 10), endDate = str(b.endDate, 10);
  const count = (v) => Math.min(50, Math.max(0, Math.floor(Number(v) || 0)));
  if (!title) return fail(res, 400, "Scrivi per cosa ti servono le persone.");
  if (!ISO_DAY.test(date)) return fail(res, 400, "Scegli la data.");
  if (endDate && (!ISO_DAY.test(endDate) || endDate < date)) return fail(res, 400, "La data di fine viene prima dell'inizio.");
  const models = count(b.models), technicians = count(b.technicians);
  if (!models && !technicians) return fail(res, 400, "Indica quante persone ti servono.");
  if (myRequests(user).filter((r) => r.status === "new").length >= 20) return fail(res, 429, "Hai già molte richieste in attesa. Aspetta la risposta dell'ufficio.");
  const now = Date.now();
  const data = {
    id: crypto.randomUUID(), userId: user.id, by: user.id, clientName: user.client_name || user.company || user.name, contact: user.name, phone: user.phone || "",
    title, date, endDate: endDate > date ? endDate : "", call: HHMM.test(b.call) ? b.call : "", wrap: HHMM.test(b.wrap) ? b.wrap : "", location: str(b.location, 200).trim(),
    models, technicians, notes: str(b.notes, 1000).trim(), status: "new", jobId: "", createdAt: now, updatedAt: now, deleted: false,
  };
  putRecord("requests", data);
  writeAudit(user, "request.add", { c: "requests", id: data.id, info: { title, client: data.clientName } });
  return send(res, 200, { ok: true, id: data.id });
}
function clientCancel(res, user, id) {
  const rec = q.getRec.get("requests", id), r = rec && !rec.deleted ? JSON.parse(rec.data) : null;
  if (!r || r.userId !== user.id) return fail(res, 404, "Richiesta non trovata.");
  if (r.status !== "new") return fail(res, 409, "L'ufficio ha già risposto a questa richiesta.");
  putRecord("requests", { ...r, status: "cancelled", updatedAt: Date.now() });
  writeAudit(user, "request.cancel", { c: "requests", id, info: { title: r.title, client: r.clientName } });
  return send(res, 200, { ok: true });
}

// ---------- Static files ----------
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/" || !path.extname(rel)) rel = "/index.html";
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return fail(res, 404, "Non trovato");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, "Non trovato");
    const ext = path.extname(file);
    // Shell files revalidate every time; the service worker keeps the offline copy.
    const cache = ext === ".png" || ext === ".svg" ? "public, max-age=86400" : "no-cache";
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": cache });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// Each site installs as its own app, with its own name.
function serveManifest(req, res, site) {
  fs.readFile(path.join(PUBLIC_DIR, "manifest.webmanifest"), "utf8", (err, text) => {
    if (err) return fail(res, 404, "Non trovato");
    const m = JSON.parse(text);
    if (site === "admin") { m.name = `${m.name} · Ufficio`; m.short_name = "Lumia Ufficio"; }
    send(res, 200, Buffer.from(JSON.stringify(m)), { "Content-Type": "application/manifest+json", "Cache-Control": "no-cache" });
  });
}

// ---------- Router ----------
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "geolocation=(), microphone=()",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

async function route(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, "http://x");
  let p = url.pathname;
  const ip = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  const site = siteOf(req);

  if (p === "/api/health") return send(res, 200, { ok: true });
  if (site === "unknown") return fail(res, 404, "Sito sconosciuto.");
  // The office moved under ADMIN_PATH: send the old office address there.
  if (ADMIN_PATH && ADMIN_HOSTS.includes(hostOf(req)) && CLIENT_HOSTS[0]) {
    const rest = p.startsWith(ADMIN_PATH + "/") ? p.slice(ADMIN_PATH.length) : p;
    res.writeHead(301, { Location: `https://${CLIENT_HOSTS[0]}${ADMIN_PATH}${rest}${url.search}`, "Cache-Control": "no-store" });
    return res.end();
  }
  if (underAdminPath(req)) {
    if (p === ADMIN_PATH) { res.writeHead(301, { Location: `${ADMIN_PATH}/${url.search}`, "Cache-Control": "no-store" }); return res.end(); }
    p = p.slice(ADMIN_PATH.length); // the office site sees the same paths as the public one
  }
  // Behind Cloudflare: send plain-http visitors to https, and tell browsers to stay on https.
  if (SPLIT_SITES) {
    const proto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
    if (proto === "http") {
      res.writeHead(301, { Location: `https://${req.headers.host}${req.url}`, "Cache-Control": "no-store" });
      return res.end();
    }
    if (proto === "https") res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }

  if (!p.startsWith("/api/")) {
    if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "Metodo non consentito");
    if (p === "/manifest.webmanifest") return serveManifest(req, res, site);
    return serveStatic(req, res, p);
  }

  // Every state-changing API call must carry this header. Browsers never add
  // it to cross-site form posts, so it blocks CSRF together with SameSite.
  if (req.method !== "GET" && req.headers["x-tc"] !== "1") return fail(res, 403, "Intestazione della richiesta mancante.");

  // Where the Android and iPhone apps should go. The apps ask this on every start, so
  // an administrator can move them to a new server (Impostazioni → App per telefono).
  // Public, and readable from the apps' own start page (another origin).
  if (p === "/api/app-config" && req.method === "GET") {
    const set = q.getRec.get("settings", "main"), cfg = set && !set.deleted ? JSON.parse(set.data) : {};
    const own = CLIENT_HOSTS[0] || String(req.headers.host || "").replace(/:\d+$/, "");
    return send(res, 200, { server: str(cfg.appServer, 200) || `https://${own}`, name: str(cfg.agencyName, 80) || "Lumia" },
      { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  }

  if (p === "/api/site" && req.method === "GET") {
    return send(res, 200, { site, adminUrl: ADMIN_URL, clientUrl: CLIENT_URL, setupCode: !!SETUP_CODE, signups: SIGNUPS && site !== "admin" });
  }

  if (p === "/api/me" && req.method === "GET") {
    if (q.userCount.get().n === 0) {
      if (site === "client") return fail(res, 401, "Questo sito non è ancora stato configurato.");
      return send(res, 200, { needsSetup: true });
    }
    const u = currentUser(req);
    return u ? send(res, 200, { user: publicUser(u) }) : fail(res, 401, "Accesso non effettuato.");
  }

  if (p === "/api/setup" && req.method === "POST") {
    if (q.userCount.get().n !== 0) return fail(res, 409, "La configurazione è già stata completata.");
    if (site === "client") return fail(res, 403, wrongSiteMessage("client"));
    if (throttled(ip)) return fail(res, 429, "Troppi tentativi. Aspetta 15 minuti e riprova.");
    const b = await readJson(req);
    if (SETUP_CODE) {
      const given = Buffer.from(str(b.code, 200).trim()), want = Buffer.from(SETUP_CODE);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) { noteFail(ip); return fail(res, 403, "Il codice di attivazione non è corretto."); }
    }
    const username = str(b.username, 40).trim(), name = str(b.name, 80).trim();
    if (!validUsername(username)) return fail(res, 400, "Nome utente: 3–40 tra lettere, numeri o . _ @ -");
    if (!name) return fail(res, 400, "Inserisci il tuo nome.");
    if (!validPassword(b.password)) return fail(res, 400, "La password deve avere almeno 8 caratteri.");
    const user = { id: crypto.randomUUID(), username, name, role: "admin" };
    q.insertUser.run(user.id, username, name, hashPassword(b.password), "admin", Date.now());
    startSession(req, res, user);
    return send(res, 200, { user: publicUser(user) });
  }

  if (p === "/api/login" && req.method === "POST") {
    if (throttled(ip)) return fail(res, 429, "Troppi tentativi. Aspetta 15 minuti e riprova.");
    const b = await readJson(req, 10_000);
    const u = q.userByName.get(str(b.username, 40).trim());
    if (!u || u.disabled || !checkPassword(str(b.password, 200), u.pw_hash)) {
      noteFail(ip);
      return fail(res, 401, "Nome utente o password errati.");
    }
    loginFails.delete(ip);
    if (!roleAllowed(site, u.role)) return fail(res, 403, wrongSiteMessage(site));
    startSession(req, res, u);
    return send(res, 200, { user: publicUser(u) });
  }

  if (p === "/api/logout" && req.method === "POST") {
    const token = parseCookies(req).tc_session;
    if (token) q.deleteSession.run(sha256(token));
    res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
    return send(res, 200, { ok: true });
  }

  // Anyone can register on the public site: people who work with the agency (they wait
  // for the office to approve them) and customers (they can send requests straight away).
  if (p === "/api/signup" && req.method === "POST") {
    if (!SIGNUPS || site === "admin") return fail(res, 403, "Le iscrizioni non sono aperte su questo sito.");
    if (q.userCount.get().n === 0) return fail(res, 409, "Questo sito non è ancora stato configurato.");
    if (signupThrottled(ip)) return fail(res, 429, "Troppe iscrizioni da questa connessione. Riprova più tardi.");
    const b = await readJson(req, 10_000);
    const kind = b.kind === "client" ? "client" : "staff";
    const username = str(b.username, 40).trim(), name = str(b.name, 80).trim();
    const company = kind === "client" ? str(b.company, 80).trim() : "", phone = str(b.phone, 40).trim();
    if (!name) return fail(res, 400, "Inserisci nome e cognome.");
    if (kind === "client" && !company) return fail(res, 400, "Inserisci il nome dell'azienda.");
    if (!validUsername(username)) return fail(res, 400, "Nome utente: 3–40 tra lettere, numeri o . _ @ -");
    if (!validPassword(b.password)) return fail(res, 400, "La password deve avere almeno 8 caratteri.");
    if (q.userByName.get(username)) return fail(res, 409, "Questo nome utente è già in uso.");
    const id = crypto.randomUUID();
    q.insertUser.run(id, username, name, hashPassword(b.password), kind, Date.now());
    db.prepare("UPDATE users SET pending = ?, company = ?, phone = ?, wants = ? WHERE id = ?")
      .run(kind === "staff" ? 1 : 0, company || null, phone || null, kind === "staff" ? (b.wants === "technician" ? "technician" : "model") : null, id);
    noteSignup(ip);
    const u = q.userById.get(id);
    writeAudit(u, "account.signup", { info: { target: name, role: kind, company } });
    startSession(req, res, u);
    return send(res, 200, { user: publicUser(u) });
  }

  // Everything below needs a signed-in user.
  const user = currentUser(req);
  if (!user) return fail(res, 401, "Accesso non effettuato.");

  // Customers have their own small API and nothing else (no sync: they never see the ledger).
  if (user.role === "client") {
    if (p === "/api/client/overview" && req.method === "GET") return send(res, 200, clientOverview(user));
    if (p === "/api/client/requests" && req.method === "POST") return clientRequest(res, user, await readJson(req, 20_000));
    const cr = p.match(/^\/api\/client\/requests\/([A-Za-z0-9_-]{1,64})\/cancel$/);
    if (cr && req.method === "POST") return clientCancel(res, user, cr[1]);
    if (p !== "/api/password") return fail(res, 403, "Non disponibile per gli account cliente.");
  }
  // A person who signed up sees nothing until the office approves them.
  if (user.role === "staff" && user.pending && p !== "/api/password") return fail(res, 403, "La tua iscrizione è in attesa di approvazione da parte dell'ufficio.");

  if (p === "/api/sync" && req.method === "POST") {
    const body = await readJson(req, 8 * 1024 * 1024);
    return send(res, 200, handleSync(user, body));
  }

  const photo = p.match(/^\/api\/photos\/([A-Za-z0-9_-]{1,64})$/);
  if (photo) {
    if (req.method === "PUT") return putPhoto(req, res, user, photo[1]);
    if (req.method === "GET") return getPhoto(req, res, user, photo[1]);
    return fail(res, 405, "Metodo non consentito");
  }

  if (p === "/api/password" && req.method === "POST") {
    const b = await readJson(req, 10_000);
    const full = q.userById.get(user.id);
    if (!checkPassword(str(b.current, 200), full.pw_hash)) return fail(res, 400, "La password attuale non è corretta.");
    if (!validPassword(b.password)) return fail(res, 400, "La nuova password deve avere almeno 8 caratteri.");
    db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(hashPassword(b.password), user.id);
    return send(res, 200, { ok: true });
  }

  // Change history (admin only), newest first, paged by id.
  if (p === "/api/audit" && req.method === "GET") {
    if (user.role !== "admin") return fail(res, 403, "Solo gli amministratori possono vedere il registro attività.");
    const before = Math.floor(Number(url.searchParams.get("before"))) || Number.MAX_SAFE_INTEGER;
    const limit = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("limit"))) || 50));
    const person = str(url.searchParams.get("person"), 64), by = str(url.searchParams.get("user"), 64);
    const rows = q.auditPage.all(before, person, person, by, by, limit + 1);
    const page = rows.slice(0, limit);
    return send(res, 200, {
      entries: page.map((r) => ({ id: r.id, at: r.at, userId: r.user_id, actor: r.cur_name || r.actor, verb: r.verb, c: r.c, recId: r.rec_id, personId: r.person_id, personName: r.person_name, info: JSON.parse(r.info) })),
      next: rows.length > limit ? page[page.length - 1].id : null,
    });
  }

  // Where people said they were, for the calendar: every check-in between two times.
  // Admins see everyone; staff only themselves (nothing, if their login isn't linked).
  if (p === "/api/checkins" && req.method === "GET") {
    const from = Math.floor(Number(url.searchParams.get("from"))) || 0;
    const to = Math.min(Math.floor(Number(url.searchParams.get("to"))) || 0, from + 62 * 864e5);
    const only = user.role === "admin" ? "" : user.person_id || "\u0000";
    const rows = to > from ? q.checkins.all(from, to, only, only) : [];
    return send(res, 200, { checkins: rows.map((r) => ({ at: r.at, personId: r.person_id, location: JSON.parse(r.info).location || "" })).filter((c) => c.location) });
  }

  // Account management (admin only).
  if (p.startsWith("/api/users")) {
    if (user.role !== "admin") return fail(res, 403, "Solo gli amministratori gestiscono gli account.");
    if (p === "/api/users" && req.method === "GET") return send(res, 200, { users: q.users.all() });
    if (p === "/api/users" && req.method === "POST") {
      const b = await readJson(req, 10_000);
      const username = str(b.username, 40).trim(), name = str(b.name, 80).trim();
      const role = b.role === "admin" ? "admin" : b.role === "client" ? "client" : "staff";
      const company = role === "client" ? str(b.company, 80).trim() : "";
      if (!validUsername(username)) return fail(res, 400, "Nome utente: 3–40 tra lettere, numeri o . _ @ -");
      if (!name) return fail(res, 400, "Inserisci il nome della persona.");
      if (role === "client" && !company) return fail(res, 400, "Inserisci il nome del cliente.");
      if (!validPassword(b.password)) return fail(res, 400, "La password deve avere almeno 8 caratteri.");
      if (q.userByName.get(username)) return fail(res, 409, "Questo nome utente è già in uso.");
      const id = crypto.randomUUID();
      q.insertUser.run(id, username, name, hashPassword(b.password), role, Date.now());
      if (company) db.prepare("UPDATE users SET company = ?, client_name = ? WHERE id = ?").run(company, company, id);
      writeAudit(user, "account.add", { info: { target: name, role } });
      return send(res, 200, { ok: true, id });
    }
    const m = p.match(/^\/api\/users\/([A-Za-z0-9-]{1,64})$/);
    if (m && req.method === "POST") {
      const target = q.userById.get(m[1]);
      if (!target) return fail(res, 404, "Account non trovato.");
      const b = await readJson(req, 10_000);
      if (target.id === user.id && (b.disabled || (b.role && b.role !== "admin"))) return fail(res, 400, "Non puoi disattivare o declassare il tuo account.");
      let personId;
      if (b.personId !== undefined) {
        personId = b.personId ? String(b.personId) : null;
        if (personId) {
          const rec = ID_RE.test(personId) && q.getRec.get("people", personId);
          if (!rec || rec.deleted) return fail(res, 400, "Questa persona non è in elenco.");
          const other = db.prepare("SELECT name FROM users WHERE person_id = ? AND id != ?").get(personId, target.id);
          if (other) return fail(res, 409, `${JSON.parse(rec.data).name} is already linked to ${other.name}'s login.`);
        }
      }
      const tgt = { target: target.name };
      if (b.password !== undefined) {
        if (!validPassword(b.password)) return fail(res, 400, "La password deve avere almeno 8 caratteri.");
        db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(hashPassword(b.password), target.id);
        if (target.id !== user.id) q.deleteUserSessions.run(target.id);
        writeAudit(user, "account.password", { info: tgt });
      }
      if (b.pending === false && target.pending) {
        db.prepare("UPDATE users SET pending = 0 WHERE id = ?").run(target.id);
        writeAudit(user, "account.approve", { info: tgt });
      }
      if (typeof b.clientName === "string" && target.role === "client" && str(b.clientName, 80).trim() !== (target.client_name || "")) {
        const cn = str(b.clientName, 80).trim();
        db.prepare("UPDATE users SET client_name = ? WHERE id = ?").run(cn || null, target.id);
        writeAudit(user, "account.client", { info: { ...tgt, client: cn } });
      }
      if ((b.role === "admin" || b.role === "staff") && b.role !== target.role && target.role !== "client") {
        db.prepare("UPDATE users SET role = ? WHERE id = ?").run(b.role, target.id);
        writeAudit(user, "account.role", { info: { ...tgt, role: b.role } });
      }
      if (typeof b.disabled === "boolean" && b.disabled !== !!target.disabled) {
        db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(b.disabled ? 1 : 0, target.id);
        if (b.disabled) q.deleteUserSessions.run(target.id);
        writeAudit(user, b.disabled ? "account.disable" : "account.enable", { info: tgt });
      }
      if (personId !== undefined && personId !== (target.person_id || null)) {
        db.prepare("UPDATE users SET person_id = ? WHERE id = ?").run(personId, target.id);
        writeAudit(user, personId ? "account.link" : "account.unlink", { personId: personId || target.person_id || null, info: tgt });
      }
      return send(res, 200, { ok: true });
    }
  }

  return fail(res, 404, "Non trovato.");
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (res.headersSent) { res.destroy(); return; }
    if (e.status) return fail(res, e.status, e.status === 413 ? "Il file è troppo grande." : "Richiesta non valida.");
    console.error(e);
    fail(res, 500, "Errore del server.");
  });
});
server.listen(PORT, HOST, () => {
  console.log(`Lumia running on http://localhost:${PORT}  (data in ${DATA_DIR})`);
});
setInterval(() => q.purgeSessions.run(Date.now()), 3600e3).unref();

// ---------- Daily backups ----------
// A consistent copy of the database once a day in DATA_DIR/backups (14 kept).
// Receipt photos are plain files in DATA_DIR/photos; back up the whole DATA_DIR off this machine too.
const BACKUP_DIR = path.join(DATA_DIR, "backups");
function backupToday() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `ledger-${new Date().toISOString().slice(0, 10)}.db`);
    if (fs.existsSync(file)) return;
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -14);
    for (const f of old) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
    console.log(`Backup written: ${file}`);
  } catch (e) { console.error("Backup failed:", e.message); }
}
backupToday();
setInterval(backupToday, 3600e3).unref();
