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
const COLLECTIONS = new Set(["people", "shifts", "payments", "receipts", "settings", "jobs", "places"]);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---------- Two sites, one server ----------
// ADMIN_HOSTS (e.g. adminlumia.rogatski.com) is the office site: admin accounts only.
// CLIENT_HOSTS (e.g. lumia.rogatski.com) is the team site: staff accounts only.
// With neither set (running on your own computer) any host serves everyone.
const hostList = (v) => String(v || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const ADMIN_HOSTS = hostList(process.env.ADMIN_HOSTS);
const CLIENT_HOSTS = hostList(process.env.CLIENT_HOSTS);
const SPLIT_SITES = ADMIN_HOSTS.length > 0 || CLIENT_HOSTS.length > 0;
// First-run setup can require a one-time code, so nobody who finds the site first can claim it.
const SETUP_CODE = String(process.env.SETUP_CODE || "");
function siteOf(req) {
  if (!SPLIT_SITES) return "any";
  const host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
  if (ADMIN_HOSTS.includes(host)) return "admin";
  if (CLIENT_HOSTS.includes(host)) return "client";
  return "unknown";
}
const roleAllowed = (site, role) => site === "any" || (site === "admin" && role === "admin") || (site === "client" && role !== "admin");
const siteUrl = (hosts) => (hosts[0] ? `https://${hosts[0]}` : null);
function wrongSiteMessage(site) {
  return site === "admin"
    ? `This is the office site, for admins. Team members sign in at ${CLIENT_HOSTS[0] || "the team site"}.`
    : `Admins sign in on the office site: ${ADMIN_HOSTS[0] || "the admin site"}.`;
}

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
    role TEXT NOT NULL CHECK (role IN ('admin','staff')),
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
  CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
`);
// A login can be linked to the person it belongs to on the board ("My page").
if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "person_id")) db.exec("ALTER TABLE users ADD COLUMN person_id TEXT");

const q = {
  userCount: db.prepare("SELECT COUNT(*) AS n FROM users"),
  userByName: db.prepare("SELECT * FROM users WHERE username = ?"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  users: db.prepare("SELECT id, username, name, role, disabled, created_at, person_id AS personId FROM users ORDER BY name COLLATE NOCASE"),
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
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, personId: u.person_id || null });
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
  return `tc_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${isSecure(req) ? "; Secure" : ""}`;
}
function currentUser(req) {
  const token = parseCookies(req).tc_session;
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
const JOB_MONEY_FIELDS = ["billing", "fee", "clientRate", "invoiceStatus"];
function redactFor(user, c, data) {
  if (c !== "jobs" || user.role === "admin" || !data) return data;
  const out = { ...data };
  for (const k of JOB_MONEY_FIELDS) delete out[k];
  return out;
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

// ---------- Photos ----------
const photoPath = (id) => path.join(PHOTO_DIR, id);

async function putPhoto(req, res, user, id) {
  const type = String(req.headers["content-type"] || "").split(";")[0].trim();
  if (!PHOTO_TYPES.has(type)) return fail(res, 415, "Use a JPEG, PNG, WebP or PDF file.");
  const rec = q.getRec.get("receipts", id);
  if (!rec || rec.deleted) return fail(res, 404, "Receipt not found.");
  const data = JSON.parse(rec.data);
  if (user.role !== "admin" && data.by !== user.id) return fail(res, 403, "Not your receipt.");
  const buf = await readBody(req, MAX_PHOTO_BYTES);
  if (!buf.length) return fail(res, 400, "Empty file.");
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

function getPhoto(req, res, id) {
  const rec = q.getRec.get("receipts", id);
  if (!rec || rec.deleted) return fail(res, 404, "Not found.");
  const data = JSON.parse(rec.data);
  const file = photoPath(id);
  fs.stat(file, (err, st) => {
    if (err) return fail(res, 404, "Not found.");
    res.writeHead(200, {
      "Content-Type": PHOTO_TYPES.has(data.photoType) ? data.photoType : "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": "inline",
    });
    fs.createReadStream(file).pipe(res);
  });
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
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return fail(res, 404, "Not found");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, "Not found");
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
    if (err) return fail(res, 404, "Not found");
    const m = JSON.parse(text);
    if (site === "admin") { m.name = `${m.name} · Office`; m.short_name = "T&C Office"; }
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
  const p = url.pathname;
  const ip = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  const site = siteOf(req);

  if (p === "/api/health") return send(res, 200, { ok: true });
  if (site === "unknown") return fail(res, 404, "Unknown site.");
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
    if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "Method not allowed");
    if (p === "/manifest.webmanifest") return serveManifest(req, res, site);
    return serveStatic(req, res, p);
  }

  // Every state-changing API call must carry this header. Browsers never add
  // it to cross-site form posts, so it blocks CSRF together with SameSite.
  if (req.method !== "GET" && req.headers["x-tc"] !== "1") return fail(res, 403, "Missing request header.");

  if (p === "/api/site" && req.method === "GET") {
    return send(res, 200, { site, adminUrl: siteUrl(ADMIN_HOSTS), clientUrl: siteUrl(CLIENT_HOSTS), setupCode: !!SETUP_CODE });
  }

  if (p === "/api/me" && req.method === "GET") {
    if (q.userCount.get().n === 0) {
      if (site === "client") return fail(res, 401, "This site isn't set up yet.");
      return send(res, 200, { needsSetup: true });
    }
    const u = currentUser(req);
    return u ? send(res, 200, { user: publicUser(u) }) : fail(res, 401, "Not signed in.");
  }

  if (p === "/api/setup" && req.method === "POST") {
    if (q.userCount.get().n !== 0) return fail(res, 409, "Setup is already done.");
    if (site === "client") return fail(res, 403, wrongSiteMessage("client"));
    if (throttled(ip)) return fail(res, 429, "Too many attempts. Wait 15 minutes and try again.");
    const b = await readJson(req);
    if (SETUP_CODE) {
      const given = Buffer.from(str(b.code, 200).trim()), want = Buffer.from(SETUP_CODE);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) { noteFail(ip); return fail(res, 403, "That setup code is wrong."); }
    }
    const username = str(b.username, 40).trim(), name = str(b.name, 80).trim();
    if (!validUsername(username)) return fail(res, 400, "Username: 3–40 letters, numbers or . _ @ -");
    if (!name) return fail(res, 400, "Enter your name.");
    if (!validPassword(b.password)) return fail(res, 400, "Password must be at least 8 characters.");
    const user = { id: crypto.randomUUID(), username, name, role: "admin" };
    q.insertUser.run(user.id, username, name, hashPassword(b.password), "admin", Date.now());
    startSession(req, res, user);
    return send(res, 200, { user: publicUser(user) });
  }

  if (p === "/api/login" && req.method === "POST") {
    if (throttled(ip)) return fail(res, 429, "Too many attempts. Wait 15 minutes and try again.");
    const b = await readJson(req, 10_000);
    const u = q.userByName.get(str(b.username, 40).trim());
    if (!u || u.disabled || !checkPassword(str(b.password, 200), u.pw_hash)) {
      noteFail(ip);
      return fail(res, 401, "Wrong username or password.");
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

  // Everything below needs a signed-in user.
  const user = currentUser(req);
  if (!user) return fail(res, 401, "Not signed in.");

  if (p === "/api/sync" && req.method === "POST") {
    const body = await readJson(req, 8 * 1024 * 1024);
    return send(res, 200, handleSync(user, body));
  }

  const photo = p.match(/^\/api\/photos\/([A-Za-z0-9_-]{1,64})$/);
  if (photo) {
    if (req.method === "PUT") return putPhoto(req, res, user, photo[1]);
    if (req.method === "GET") return getPhoto(req, res, photo[1]);
    return fail(res, 405, "Method not allowed");
  }

  if (p === "/api/password" && req.method === "POST") {
    const b = await readJson(req, 10_000);
    const full = q.userById.get(user.id);
    if (!checkPassword(str(b.current, 200), full.pw_hash)) return fail(res, 400, "Your current password is wrong.");
    if (!validPassword(b.password)) return fail(res, 400, "New password must be at least 8 characters.");
    db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(hashPassword(b.password), user.id);
    return send(res, 200, { ok: true });
  }

  // Change history (admin only), newest first, paged by id.
  if (p === "/api/audit" && req.method === "GET") {
    if (user.role !== "admin") return fail(res, 403, "Only admins can see the activity log.");
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

  // Account management (admin only).
  if (p.startsWith("/api/users")) {
    if (user.role !== "admin") return fail(res, 403, "Only admins manage accounts.");
    if (p === "/api/users" && req.method === "GET") return send(res, 200, { users: q.users.all() });
    if (p === "/api/users" && req.method === "POST") {
      const b = await readJson(req, 10_000);
      const username = str(b.username, 40).trim(), name = str(b.name, 80).trim();
      const role = b.role === "admin" ? "admin" : "staff";
      if (!validUsername(username)) return fail(res, 400, "Username: 3–40 letters, numbers or . _ @ -");
      if (!name) return fail(res, 400, "Enter the person's name.");
      if (!validPassword(b.password)) return fail(res, 400, "Password must be at least 8 characters.");
      if (q.userByName.get(username)) return fail(res, 409, "That username is taken.");
      const id = crypto.randomUUID();
      q.insertUser.run(id, username, name, hashPassword(b.password), role, Date.now());
      writeAudit(user, "account.add", { info: { target: name, role } });
      return send(res, 200, { ok: true, id });
    }
    const m = p.match(/^\/api\/users\/([A-Za-z0-9-]{1,64})$/);
    if (m && req.method === "POST") {
      const target = q.userById.get(m[1]);
      if (!target) return fail(res, 404, "Account not found.");
      const b = await readJson(req, 10_000);
      if (target.id === user.id && (b.disabled || (b.role && b.role !== "admin"))) return fail(res, 400, "You can't disable or demote your own account.");
      let personId;
      if (b.personId !== undefined) {
        personId = b.personId ? String(b.personId) : null;
        if (personId) {
          const rec = ID_RE.test(personId) && q.getRec.get("people", personId);
          if (!rec || rec.deleted) return fail(res, 400, "That person isn't on the board.");
          const other = db.prepare("SELECT name FROM users WHERE person_id = ? AND id != ?").get(personId, target.id);
          if (other) return fail(res, 409, `${JSON.parse(rec.data).name} is already linked to ${other.name}'s login.`);
        }
      }
      const tgt = { target: target.name };
      if (b.password !== undefined) {
        if (!validPassword(b.password)) return fail(res, 400, "Password must be at least 8 characters.");
        db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(hashPassword(b.password), target.id);
        if (target.id !== user.id) q.deleteUserSessions.run(target.id);
        writeAudit(user, "account.password", { info: tgt });
      }
      if ((b.role === "admin" || b.role === "staff") && b.role !== target.role) {
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

  return fail(res, 404, "Not found.");
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (res.headersSent) { res.destroy(); return; }
    if (e.status) return fail(res, e.status, e.status === 413 ? "That file is too large." : "Bad request.");
    console.error(e);
    fail(res, 500, "Server error.");
  });
});
server.listen(PORT, HOST, () => {
  console.log(`Talent & Crew running on http://localhost:${PORT}  (data in ${DATA_DIR})`);
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
