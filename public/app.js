/* Talent & Crew — offline-first client.
   Every change is written to this device first (IndexedDB) and queued in an outbox.
   When the device is online the outbox is sent to /api/sync and newer records come back.
   Receipt photos are kept on the device and uploaded once their receipt has synced. */
(() => {
  "use strict";

  // ---------- Small helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const isoDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const isoMonth = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const locale = "it-IT";
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  const byName = (a, b) => (a.name || "").localeCompare(b.name || "", locale);

  const ICON = {
    pin: `<svg viewBox="0 0 24 24"><path d="M12 21s-6.5-5.8-6.5-11A6.5 6.5 0 0 1 18.5 10c0 5.2-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>`,
    clock: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>`,
    cam: `<svg viewBox="0 0 24 24"><path d="M4 8h3l1.6-2.5h6.8L17 8h3v11H4z"/><circle cx="12" cy="13.2" r="3.6"/></svg>`,
    card: `<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12.5" rx="2"/><path d="M3 10h18M7 15h3"/></svg>`,
    doc: `<svg viewBox="0 0 24 24"><path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4"/></svg>`,
    receipt: `<svg viewBox="0 0 24 24"><path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/></svg>`,
    plus: `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`,
    person: `<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.7-3.6 3.4-5.6 7-5.6s6.3 2 7 5.6"/></svg>`,
  };

  // ---------- Local database (IndexedDB) ----------
  const idb = (() => {
    let opening;
    const open = () => opening ||= new Promise((res, rej) => {
      const r = indexedDB.open("talent-crew", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("records", { keyPath: "key" });
        d.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
        d.createObjectStore("photos", { keyPath: "id" });
        d.createObjectStore("meta", { keyPath: "k" });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const store = async (name, mode = "readonly") => (await open()).transaction(name, mode).objectStore(name);
    return {
      get: async (s, k) => req((await store(s)).get(k)),
      all: async (s) => req((await store(s)).getAll()),
      count: async (s) => req((await store(s)).count()),
      put: async (s, v) => req((await store(s, "readwrite")).put(v)),
      del: async (s, k) => req((await store(s, "readwrite")).delete(k)),
      // Several writes across stores in one transaction: all land or none do.
      batch: async (ops) => {
        const d = await open();
        const names = [...new Set(ops.map((o) => o.s))];
        if (!names.length) return;
        return new Promise((res, rej) => {
          const t = d.transaction(names, "readwrite");
          for (const o of ops) { const st = t.objectStore(o.s); o.del ? st.delete(o.key) : st.put(o.val); }
          t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
        });
      },
      wipe: async () => {
        const d = await open();
        return new Promise((res, rej) => {
          const t = d.transaction(["records", "outbox", "photos", "meta"], "readwrite");
          for (const n of ["records", "outbox", "photos", "meta"]) t.objectStore(n).clear();
          t.oncomplete = () => res(); t.onerror = () => rej(t.error);
        });
      },
    };
  })();
  const meta = { get: async (k) => (await idb.get("meta", k))?.v, set: (k, v) => idb.put("meta", { k, v }) };

  // ---------- State ----------
  const COLLS = ["people", "shifts", "payments", "receipts", "jobs", "places", "requests"];
  const state = { people: [], shifts: [], payments: [], receipts: [], jobs: [], places: [], requests: [], settings: { currency: "EUR" } };
  const ui = { tab: "team", role: "all", q: "", hPerson: "", hMonth: isoMonth(), rStatus: "pending", rPerson: "", pPerson: "", rCat: "", qSel: new Set(), actPerson: "", actUser: "" };
  let me = null;
  let pendingKeys = new Set();        // records with changes not yet on the server
  let localPhotos = new Map();        // receipt id -> { url, uploaded }
  let sync = { busy: false, online: navigator.onLine, last: 0, error: null, authLost: false };
  const isAdmin = () => me?.role === "admin";
  const mine = (r) => isAdmin() || r.by === me?.id;

  // ---------- Me, approvals, categories ----------
  // The person on the board this login belongs to (an admin links it in Settings).
  const myPerson = () => (me?.personId ? state.people.find((p) => p.id === me.personId) || null : null);
  const staffMe = () => !isAdmin() && !!myPerson();
  // Staff see money (rates, hours, receipts, payments) only for themselves; the server sends nothing else.
  const seesPay = (personId) => isAdmin() || (!!me?.personId && personId === me.personId);
  // Hours logged by staff wait for an admin; entries from before approvals existed count as approved.
  const approvalOf = (s) => s.approval || "approved";
  const counts = (s) => approvalOf(s) === "approved";
  const SHIFT_META = new Set(["id", "by", "createdAt", "updatedAt", "deleted", "approval", "approvalNote", "approvedBy", "approvedAt"]);
  function stable(v) {
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
    return JSON.stringify(v ?? null);
  }
  const shiftContent = (s) => stable(Object.fromEntries(Object.entries(s || {}).filter(([k]) => !SHIFT_META.has(k))));
  // Mirrors the server, so the right state shows while offline. The server has the final say.
  function withApproval(data) {
    const prev = data.id ? state.shifts.find((s) => s.id === data.id) : null;
    if (isAdmin()) return prev || data.approval ? data : { ...data, approval: "approved", approvedBy: me.id, approvedAt: Date.now() };
    if (!prev || shiftContent(prev) !== shiftContent(data)) return { ...data, approval: "pending", approvalNote: "", approvedBy: null, approvedAt: null };
    return { ...data, approval: prev.approval || "approved", approvalNote: prev.approvalNote || "", approvedBy: prev.approvedBy ?? null, approvedAt: prev.approvedAt ?? null };
  }
  const approvalPill = (s) => approvalOf(s) === "pending" ? `<span class="pill wait">In attesa di approvazione</span>`
    : approvalOf(s) === "rejected" ? `<span class="pill over">Rifiutato</span>` : "";
  const pendingShifts = () => state.shifts.filter((s) => approvalOf(s) === "pending" && state.people.some((p) => p.id === s.personId))
    .sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.createdAt || 0) - (b.createdAt || 0));
  const CATS = [["travel", "Viaggi"], ["meals", "Pasti"], ["wardrobe", "Guardaroba"], ["hair", "Trucco e parrucco"], ["equipment", "Attrezzatura"], ["other", "Altro"]];
  const catOf = (r) => (CATS.some(([k]) => k === r.category) ? r.category : "other");
  const catLabel = (k) => CATS.find(([c]) => c === k)?.[1] || "Altro";
  // Payment methods are stored as their original English option text; show them in Italian.
  const METHODS = [["Bank transfer", "Bonifico"], ["Cash", "Contanti"], ["Card", "Carta"], ["Other", "Altro"]];
  const methodLabel = (m) => METHODS.find(([k]) => k === m)?.[1] || m || "";
  const accountName = (id) => accounts?.find((a) => a.id === id)?.name || "";

  async function loadState() {
    const rows = await idb.all("records");
    for (const c of COLLS) state[c] = [];
    state.settings = { currency: "EUR" };
    for (const r of rows) {
      if (r.c === "settings") { if (r.id === "main" && !r.data.deleted) state.settings = { currency: "EUR", ...r.data }; continue; }
      if (state[r.c] && !r.data.deleted) state[r.c].push(r.data);
    }
    pendingKeys = new Set((await idb.all("outbox")).map((o) => o.c + "/" + o.id));
    const photos = await idb.all("photos");
    const keep = new Map();
    for (const p of photos) keep.set(p.id, { url: localPhotos.get(p.id)?.url || URL.createObjectURL(p.blob), uploaded: p.uploaded });
    for (const [id, v] of localPhotos) if (!keep.has(id)) URL.revokeObjectURL(v.url);
    localPhotos = keep;
  }

  // Save a record on this device, queue it for the server, redraw.
  async function save(c, data) {
    if (c === "shifts" && !data.deleted) data = withApproval(data);
    const now = Date.now();
    const rec = { ...data, id: data.id || uid(), updatedAt: now };
    if (!rec.createdAt) rec.createdAt = now;
    if (!rec.by) rec.by = me.id;
    await idb.batch([
      { s: "records", val: { key: c + "/" + rec.id, c, id: rec.id, data: rec } },
      { s: "outbox", val: { c, id: rec.id, data: rec } },
    ]);
    await loadState();
    render();
    kickSync();
    return rec;
  }
  const remove = (c, rec) => save(c, { ...rec, deleted: true });
  // Several records in one go (bulk approvals): one write, one redraw.
  async function saveMany(c, list) {
    const now = Date.now(), ops = [];
    for (let data of list) {
      if (c === "shifts" && !data.deleted) data = withApproval(data);
      const rec = { ...data, id: data.id || uid(), updatedAt: now, createdAt: data.createdAt || now, by: data.by || me.id };
      ops.push({ s: "records", val: { key: c + "/" + rec.id, c, id: rec.id, data: rec } }, { s: "outbox", val: { c, id: rec.id, data: rec } });
    }
    await idb.batch(ops);
    await loadState(); render(); kickSync();
  }

  // ---------- Server ----------
  async function api(path, { method = "POST", body, blob } = {}) {
    const headers = { "x-tc": "1" };
    if (blob) headers["content-type"] = blob.type;
    else if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(path, { method, headers, credentials: "same-origin", body: blob || (body !== undefined ? JSON.stringify(body) : undefined) });
    let j = null;
    try { j = await r.json(); } catch { /* empty */ }
    if (!r.ok) throw Object.assign(new Error(j?.error || "Richiesta non riuscita"), { status: r.status, msg: j?.error });
    return j;
  }

  let syncTimer = null;
  function kickSync(delay = 400) { clearTimeout(syncTimer); syncTimer = setTimeout(runSync, delay); }

  let syncAgain = false;
  async function runSync() {
    if (!me || sync.authLost || usesPortal(me)) return;
    if (sync.busy) { syncAgain = true; return; }
    sync.busy = true; syncAgain = false; paintSync();
    try {
      let loops = 0;
      do {
        syncAgain = false;
        const outbox = await idb.all("outbox");
        const sent = outbox.slice(0, 300);
        const since = (await meta.get("rev")) || 0;
        const res = await api("/api/sync", { body: { since, changes: sent.map((o) => ({ c: o.c, id: o.id, data: o.data })) } });
        sync.online = true;
        const sentSeqs = new Set(sent.map((o) => o.seq));
        const after = await idb.all("outbox");
        const stillLocal = new Set(after.filter((o) => !sentSeqs.has(o.seq)).map((o) => o.c + "/" + o.id));
        const ops = sent.map((o) => ({ s: "outbox", del: true, key: o.seq }));
        for (const r of [...res.records, ...res.fixes]) {
          const key = r.c + "/" + r.id;
          if (stillLocal.has(key)) continue; // a newer local edit is waiting; it wins
          if (r.data === null) ops.push({ s: "records", del: true, key });
          else ops.push({ s: "records", val: { key, c: r.c, id: r.id, data: r.data } });
        }
        ops.push({ s: "meta", val: { k: "rev", v: res.rev } });
        await idb.batch(ops);
        if (res.me && me && res.me.id === me.id && stable(res.me) !== stable(me)) {
          // Linked to a different person: what this login may see changed, so fetch everything again.
          if (res.me.personId !== me.personId && res.me.role !== "admin") { await meta.set("rev", 0); syncAgain = true; }
          me = res.me; await meta.set("me", me); paintMe();
        }
        if (res.denied) toast(res.denied === 1 ? "Una modifica non è consentita al tuo account ed è stata annullata." : `${res.denied} modifiche non sono consentite al tuo account e sono state annullate.`);
        if (res.more || after.length > sent.length) syncAgain = true;
        await loadState();
        render();
      } while (syncAgain && ++loops < 20);
      await uploadPhotos();
      sync.last = Date.now(); sync.error = null;
      await meta.set("lastSync", sync.last);
    } catch (e) {
      if (e.status === 401) { sync.authLost = true; }
      else if (e.status) { sync.error = e.msg || "Il server ha rifiutato la sincronizzazione."; }
      else { sync.online = false; }
    } finally {
      sync.busy = false; paintSync(); render();
    }
  }

  async function uploadPhotos() {
    const photos = await idb.all("photos");
    const waiting = new Set((await idb.all("outbox")).filter((o) => o.c === "receipts").map((o) => o.id));
    for (const p of photos) {
      if (p.uploaded) {
        // Keep a month of photos on the device for offline viewing, then let the server hold them.
        if (Date.now() - (p.savedAt || 0) > 30 * 864e5) await idb.del("photos", p.id);
        continue;
      }
      if (waiting.has(p.id)) continue;
      const rec = state.receipts.find((r) => r.id === p.id);
      if (!rec) { await idb.del("photos", p.id); continue; }
      try {
        await api("/api/photos/" + encodeURIComponent(p.id), { method: "PUT", blob: p.blob });
        await idb.put("photos", { ...p, uploaded: true });
      } catch (e) {
        if (e.status === 404 || e.status === 403 || e.status === 415 || e.status === 413) {
          await idb.put("photos", { ...p, uploaded: true, failed: e.msg || "rejected" });
          toast(`Impossibile salvare la foto di una ricevuta: ${e.msg || "rifiutata dal server"}`);
        } else throw e;
      }
    }
    // Pull the server's photo flags back down.
    const res = await api("/api/sync", { body: { since: (await meta.get("rev")) || 0, changes: [] } });
    if (res.records.length) {
      await idb.batch([...res.records.map((r) => ({ s: "records", val: { key: r.c + "/" + r.id, c: r.c, id: r.id, data: r.data } })), { s: "meta", val: { k: "rev", v: res.rev } }]);
    }
    await loadState();
  }

  // ---------- Formatting ----------
  let moneyFmt = null, moneyCur = null;
  function money(n) {
    const cur = state.settings.currency || "EUR";
    if (!moneyFmt || moneyCur !== cur) { moneyFmt = new Intl.NumberFormat(locale, { style: "currency", currency: cur }); moneyCur = cur; }
    return moneyFmt.format(round2(n));
  }
  const hrs = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString(locale, { maximumFractionDigits: 2 }) + " h";
  const fmtDate = (s) => { if (!s) return ""; const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" }); };
  const fmtShort = (s) => { if (!s) return ""; const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" }); };
  function ago(ms) {
    if (!ms) return "";
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return "adesso";
    if (s < 3600) return Math.floor(s / 60) + " min fa";
    if (s < 86400) return Math.floor(s / 3600) + " h fa";
    const d = Math.floor(s / 86400);
    if (d < 7) return d === 1 ? "ieri" : d + " giorni fa";
    return new Date(ms).toLocaleDateString(locale, { day: "numeric", month: "short" });
  }
  const personName = (id) => state.people.find((p) => p.id === id)?.name || "Persona rimossa";
  const roleLabel = (r) => (r === "technician" ? "Tecnico" : "Modello/a");
  const unsyncedTag = (c, id) => (pendingKeys.has(c + "/" + id) ? `<span class="unsynced">Su questo dispositivo</span>` : "");

  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200);
  }
  const showErr = (el, msg) => { el.textContent = msg || ""; el.hidden = !msg; };

  // ---------- Money ----------
  function balances() {
    const map = new Map();
    for (const p of state.people) map.set(p.id, { earned: 0, paid: 0, rec: 0, recN: 0, hMonth: 0, hAll: 0, hPend: 0, nPend: 0 });
    const m = isoMonth();
    for (const s of state.shifts) {
      const b = map.get(s.personId); if (!b) continue;
      if (!counts(s)) { if (approvalOf(s) === "pending") { b.hPend += Number(s.hours) || 0; b.nPend++; } continue; }
      const h = Number(s.hours) || 0;
      b.earned += shiftPay(s).amount; b.hAll += h;
      if ((s.date || "").startsWith(m)) b.hMonth += h;
    }
    for (const p of state.payments) { const b = map.get(p.personId); if (b) b.paid += Number(p.amount) || 0; }
    for (const r of state.receipts) { const b = map.get(r.personId); if (b && r.status !== "reimbursed") { b.rec += Number(r.amount) || 0; b.recN++; } }
    for (const b of map.values()) { b.wageDue = round2(b.earned - b.paid); b.owed = round2(b.wageDue + b.rec); }
    return map;
  }
  const statusPill = (b) => b.owed > 0.004 ? `<span class="pill owed">Da pagare</span>` : b.owed < -0.004 ? `<span class="pill over">Pagato in eccesso</span>` : `<span class="pill paid">In regola</span>`;

  // ---------- Pay rules ----------
  // Terms are set per person by an admin and copied onto every shift when it's logged
  // (like the old `rate` snapshot), so changing someone's rate never rewrites history.
  // Missing fields mean hourly with no overtime: old shifts still pay hours × rate.
  const posNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  function payTerms(x) {
    x = x || {};
    const day = x.payType === "day";
    return {
      payType: day ? "day" : "hourly", rate: Number(x.rate) || 0,
      dayRate: day ? posNum(x.dayRate) : 0, halfDayRate: day ? posNum(x.halfDayRate) : 0, halfDayUnder: day ? posNum(x.halfDayUnder) : 0,
      otAfter: posNum(x.otAfter), otMult: posNum(x.otMult) || 1,
    };
  }
  // Pure: hours + terms -> pay. Overtime hours (past otAfter in one shift) are paid at rate × otMult,
  // on top of the day rate for day-rate people. A half-day rate applies to shifts under halfDayUnder hours.
  function payCalc(hours, t) {
    const h = Number(hours) || 0;
    const ot = t.otAfter > 0 && h > t.otAfter ? h - t.otAfter : 0;
    const reg = h - ot, otPay = ot * t.rate * t.otMult;
    if (t.payType === "day") {
      const half = t.halfDayRate > 0 && t.halfDayUnder > 0 && h < t.halfDayUnder;
      return { amount: (half ? t.halfDayRate : t.dayRate) + otPay, regularHours: reg, overtimeHours: ot, basis: half ? "half-day" : "day" };
    }
    return { amount: reg * t.rate + otPay, regularHours: reg, overtimeHours: ot, basis: "hourly" };
  }
  // The terms a shift is paid under: its own snapshot (the server stops staff choosing them).
  const shiftTerms = (s) => payTerms(s);
  // The one place a shift's earnings come from: { amount, regularHours, overtimeHours, basis }.
  const shiftPay = (s) => payCalc(s.hours, shiftTerms(s));
  // Which shifts count towards pay (hook for an approval filter).
  const countsForPay = (s) => counts(s); // only approved hours are paid
  const fmtMult = (m) => (Math.round(m * 100) / 100).toLocaleString(locale) + "×";
  function termsText(t) {
    const parts = t.payType === "day"
      ? [`${money(t.dayRate)} al giorno`, ...(t.halfDayRate && t.halfDayUnder ? [`${money(t.halfDayRate)} mezza giornata sotto le ${hrs(t.halfDayUnder)}`] : [])]
      : [`${money(t.rate)} / h`];
    if (t.otAfter) parts.push(`straordinario oltre ${hrs(t.otAfter)} a ${fmtMult(t.otMult)}${t.payType === "day" ? ` di ${money(t.rate)} / h` : ""}`);
    return parts.join(" · ");
  }
  // "8 h × €25.00 + 2 h straordinario × €25.00 × 1.5 = €275.00", "Day rate €400.00", …
  function payExplain(hours, t, total = true) {
    const p = payCalc(hours, t);
    const ot = p.overtimeHours ? ` + ${hrs(p.overtimeHours)} straordinario × ${money(t.rate)} × ${(Math.round(t.otMult * 100) / 100).toLocaleString(locale)}` : "";
    if (t.payType === "day") {
      const base = p.basis === "half-day" ? `Mezza giornata (sotto le ${hrs(t.halfDayUnder)}) ${money(t.halfDayRate)}` : `Tariffa giornaliera ${money(t.dayRate)}`;
      return base + ot + (ot && total ? ` = ${money(p.amount)}` : "");
    }
    return `${hrs(p.regularHours)} × ${money(t.rate)}${ot}${total ? ` = ${money(p.amount)}` : ""}`;
  }
  const otSub = (s) => { const o = shiftPay(s).overtimeHours; return o ? `<span class="sub">${hrs(o)} straordinario</span>` : ""; };
  const rateCell = (t) => (t.payType === "day" ? `${money(t.dayRate)}<span class="sub">al giorno</span>` : money(t.rate));

  // ---------- Rendering ----------
  function render() {
    if (!me) return;
    if (!location.hash.slice(1) && ((ui.tab === "team" && staffMe()) || (ui.tab !== "calendar" && isAdmin()))) return route(); // the first sync just linked this login
    const bal = balances();
    const recOpen = state.receipts.filter((r) => r.status !== "reimbursed" && bal.has(r.personId));
    const navReq = $("#nav-req"), nReq = isAdmin() ? openRequests().length : 0; navReq.textContent = nReq; navReq.hidden = !nReq;
    const navRec = $("#nav-rec"); navRec.textContent = recOpen.length; navRec.hidden = !recOpen.length;
    const waiting = isAdmin() ? pendingShifts().length : 0;
    const navHrs = $("#nav-hrs"); navHrs.textContent = waiting; navHrs.hidden = !waiting; navHrs.title = `${waiting} in attesa di approvazione`;
    $$(".admin").forEach((el) => (el.hidden = !isAdmin()));
    $$(".staff-only").forEach((el) => (el.hidden = isAdmin()));
    paintNav();
    fillFilters();
    if (ui.tab === "team") renderTeam(bal, recOpen);
    if (ui.tab === "me") renderMe(bal);
    if (ui.tab === "hours") { renderQueue(); renderHours(); }
    if (ui.tab === "receipts") renderReceipts();
    if (ui.tab === "payments") renderPayments();
    if (ui.tab === "settings") renderSettings();
    renderJobsHook(); // jobs view + open job sheet
    if ($("#d-detail").open && detailId) renderDetail(detailId);
    if ($("#d-statement").open) renderStatement();
    paintSync();
  }

  function empty(title, text, act, label) {
    return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(text)}</p>${act ? `<button class="btn primary" type="button" data-act="${act}">${esc(label)}</button>` : ""}</div>`;
  }

  function renderTeam(bal, recOpen) {
    let owed = 0, earnedMonth = 0, hMonth = 0, onJob = 0;
    const m = isoMonth();
    for (const b of bal.values()) { if (b.owed > 0) owed += b.owed; hMonth += b.hMonth; }
    for (const s of state.shifts) if ((s.date || "").startsWith(m) && bal.has(s.personId) && counts(s)) earnedMonth += shiftPay(s).amount;
    const today = isoDay();
    for (const p of state.people) if (p.location && p.locationAt && isoDay(new Date(p.locationAt)) === today) onJob++;
    const owedPeople = [...bal.values()].filter((b) => b.owed > 0.004).length;
    const recSum = recOpen.reduce((a, r) => a + (Number(r.amount) || 0), 0);
    $("#summary").hidden = !isAdmin();
    $("#summary").innerHTML = !isAdmin() ? "" : `
      <div><span class="eyebrow">Da pagare alla squadra</span><span class="big ${owed > 0.004 ? "" : "zero"}">${money(owed)}</span><span class="note">${owedPeople ? (owedPeople === 1 ? "1 persona attende il pagamento" : `${owedPeople} persone attendono il pagamento`) : "Tutti in regola"}</span></div>
      <div><span class="eyebrow">Ore</span><span class="mid">${hrs(hMonth)}</span><span class="note">${money(earnedMonth)} a ${new Date().toLocaleDateString(locale, { month: "long" })}</span></div>
      <div><span class="eyebrow">Ricevute</span><span class="mid">${money(recSum)}</span><span class="note">${recOpen.length} da rimborsare</span></div>
      <div><span class="eyebrow">Posizione segnalata</span><span class="mid">${onJob}<span class="muted">/${state.people.length}</span></span><span class="note">oggi${bookedTodayNote()}</span></div>`;
    const waiting = isAdmin() ? pendingShifts() : [];
    $("#queue-strip").innerHTML = waiting.length ? `<a class="queue-strip" href="#hours">${ICON.clock}<span><b>${waiting.length === 1 ? "1 voce in attesa" : `${waiting.length} voci in attesa`} di approvazione</b> · <span class="mono">${hrs(waiting.reduce((a, s) => a + (Number(s.hours) || 0), 0))}</span> registrate dai collaboratori</span><span class="go">Controlla</span></a>` : "";

    const el = $("#board");
    if (!state.people.length) {
      el.innerHTML = isAdmin()
        ? empty("Ancora nessuno nella squadra", "Aggiungi modelli e tecnici con la loro tariffa oraria. Poi la squadra potrà registrare le ore, segnalare la propria posizione e fotografare le ricevute.", "add-person", "Aggiungi la prima persona")
        : empty("Ancora nessuno nella squadra", "Un amministratore deve aggiungere la squadra prima che si possano registrare ore e ricevute.");
      return;
    }
    const q = ui.q.trim().toLowerCase();
    let list = state.people.slice().sort(byName);
    if (ui.role === "model" || ui.role === "technician") list = list.filter((p) => (p.role || "model") === ui.role);
    if (ui.role === "owed") list = list.filter((p) => (bal.get(p.id)?.owed || 0) > 0.004);
    if (q) list = list.filter((p) => [p.name, p.location, p.speciality].some((v) => (v || "").toLowerCase().includes(q)));
    if (!list.length) { el.innerHTML = empty("Nessun risultato", "Prova un altro filtro o un'altra ricerca."); return; }
    el.innerHTML = `<div class="board">${list.map((p) => {
      const b = bal.get(p.id);
      const live = p.location && p.locationAt && Date.now() - p.locationAt < 12 * 3600e3;
      return `<article class="comp">
        <div class="comp-top">
          <div class="comp-id">
            <div>
              <button class="comp-name" type="button" data-act="detail" data-id="${p.id}">${esc(p.name)}</button>
              <div class="comp-role"><span class="tag ${p.role === "technician" ? "technician" : "model"}">${roleLabel(p.role)}</span>${p.speciality ? `<span>${esc(p.speciality)}</span>` : ""}${unsyncedTag("people", p.id)}</div>
            </div>
            ${seesPay(p.id) ? statusPill(b) : ""}
          </div>
          <div class="where ${live ? "live" : ""}">${ICON.pin}
            <div class="txt">${p.location ? `<div class="loc">${esc(p.location)}</div><div class="ago">Aggiornata ${ago(p.locationAt)}</div>` : `<div class="loc unknown">Posizione sconosciuta</div>`}</div>
            <button class="btn quiet sm" type="button" data-act="loc" data-id="${p.id}">Aggiorna</button>
          </div>
          ${bookingLine(p.id)}
        </div>
        ${seesPay(p.id) ? `<div class="figs">
          <div><span class="k">Questo mese</span><span class="v ${b.hMonth ? "" : "zero"}">${hrs(b.hMonth)}</span>${b.hPend ? `<span class="pend">+${hrs(b.hPend)} in attesa</span>` : ""}</div>
          <div><span class="k">Ricevute</span><span class="v ${b.rec ? "" : "zero"}">${money(b.rec)}</span></div>
          <div><span class="k">Da pagare</span><span class="v ${b.owed > 0.004 ? "owed" : "zero"}">${money(b.owed)}</span></div>
        </div>` : ""}
        <div class="comp-acts">
          <button class="btn sm" type="button" data-act="add-shift" data-id="${p.id}">${ICON.clock}Ore</button>
          <button class="btn sm" type="button" data-act="add-receipt" data-id="${p.id}">${ICON.cam}Ricevuta</button>
          ${isAdmin() ? `<button class="btn sm" type="button" data-act="add-payment" data-id="${p.id}" ${b.owed > 0.004 ? "" : "disabled"}>${ICON.card}Paga</button>
          <button class="btn quiet sm end" type="button" data-act="edit-person" data-id="${p.id}">Modifica</button>` : ""}
        </div>
      </article>`;
    }).join("")}</div>`;
  }

  function fillFilters() {
    const people = state.people.slice().sort(byName);
    const opts = `<option value="">Tutti</option>` + people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    for (const [sel, key] of [["#h-person", "hPerson"], ["#r-person", "rPerson"], ["#p-person", "pPerson"]]) {
      const el = $(sel);
      if (el.dataset.sig !== opts) { el.innerHTML = opts; el.dataset.sig = opts; }
      if (ui[key] && !people.some((p) => p.id === ui[key])) ui[key] = "";
      el.value = ui[key];
    }
    fillMonths($("#h-month"), ui.hMonth, true);
    const cat = $("#r-cat");
    if (!cat.options.length) cat.innerHTML = `<option value="">Tutte le categorie</option>` + CATS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
    cat.value = ui.rCat;
  }

  // Month choice in Italian whatever the browser's language: from the earliest record to three months ahead.
  function fillMonths(el, value, withAll) {
    const dates = [...state.shifts, ...state.receipts, ...state.payments, ...state.jobs].map((x) => (x.date || "").slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m));
    const now = new Date(), last = isoMonth(new Date(now.getFullYear(), now.getMonth() + 3, 1));
    let first = [isoMonth(new Date(now.getFullYear(), now.getMonth() - 12, 1)), value || last, ...dates].sort()[0];
    const opts = [];
    for (let [y, m] = first.split("-").map(Number); ; m++) { if (m > 12) { m = 1; y++; } const k = `${y}-${pad(m)}`; if (k > last && k > (value || "")) break; opts.push(k); if (opts.length > 240) break; }
    const label = (k) => { const t = new Date(k + "-01T12:00").toLocaleDateString(locale, { month: "long", year: "numeric" }); return t[0].toUpperCase() + t.slice(1); };
    const html = (withAll ? `<option value="">Tutti i mesi</option>` : "") + opts.reverse().map((k) => `<option value="${k}">${label(k)}</option>`).join("");
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }
    el.value = value || "";
  }

  const shiftsShown = () => state.shifts
    .filter((s) => (!ui.hPerson || s.personId === ui.hPerson) && (!ui.hMonth || (s.date || "").startsWith(ui.hMonth)))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));

  function renderHours() {
    const el = $("#hours");
    const rows = shiftsShown();
    if (!rows.length) {
      el.innerHTML = state.people.length
        ? empty(ui.hMonth ? "Nessuna ora registrata questo mese" : "Ancora nessuna ora registrata", "Registra convocazione e fine, o solo le ore. Funziona anche senza campo e si sincronizza quando torni online.", "add-shift", "Registra ore")
        : empty("Prima aggiungi le persone", isAdmin() ? "Le ore si registrano a nome di qualcuno della squadra." : "Prima un amministratore deve aggiungere la squadra.", isAdmin() ? "add-person" : null, "Aggiungi persona");
      return;
    }
    let th = 0, tv = 0, hWait = 0;
    for (const s of rows) { if (!counts(s)) { if (approvalOf(s) === "pending") hWait += Number(s.hours) || 0; continue; } th += Number(s.hours) || 0; tv += shiftPay(s).amount; }
    const period = ui.hMonth ? new Date(ui.hMonth + "-01T12:00").toLocaleDateString(locale, { month: "long", year: "numeric" }) : "sempre";
    el.innerHTML = `<div class="tablebox hours-table"><table>
      <thead><tr><th>Data</th><th>Persona</th><th>Lavoro · posizione</th><th class="n">Convocazione–fine</th><th class="n">Ore</th><th class="n">Tariffa</th><th class="n">Guadagnato</th><th></th></tr></thead>
      <tbody>${rows.map((s) => `<tr>
        <td>${fmtShort(s.date)}${unsyncedTag("shifts", s.id) ? `<span class="sub">${unsyncedTag("shifts", s.id)}</span>` : ""}${approvalPill(s) ? `<span class="sub">${approvalPill(s)}</span>` : ""}${approvalOf(s) === "rejected" && s.approvalNote ? `<span class="sub">“${esc(s.approvalNote)}”</span>` : ""}</td>
        <td class="who">${esc(personName(s.personId))}</td>
        <td>${esc(s.job || "—")}${s.location ? `<span class="sub">${esc(s.location)}</span>` : ""}</td>
        <td class="n">${s.start && s.end ? `${esc(s.start)}–${esc(s.end)}` : `<span class="muted">—</span>`}</td>
        <td class="n">${hrs(s.hours)}${otSub(s)}</td>
        <td class="n">${rateCell(shiftTerms(s))}</td>
        <td class="n">${money(shiftPay(s).amount)}</td>
        <td class="n">${mine(s) ? `<button class="btn quiet sm" type="button" data-act="edit-shift" data-id="${s.id}">Modifica</button>` : ""}</td>
      </tr>`).join("")}</tbody>
      <tfoot><tr><td colspan="4">${rows.length === 1 ? "1 voce" : `${rows.length} voci`} · ${esc(period)}${hWait ? ` · <span class="muted">+ ${hrs(hWait)} in attesa di approvazione</span>` : ""}</td><td class="n">${hrs(th)}</td><td></td><td class="n">${money(tv)}</td><td></td></tr></tfoot>
    </table></div>
    <div class="list">${rows.map((s) => `<button class="list-row" type="button" ${mine(s) ? `data-act="edit-shift" data-id="${s.id}"` : ""}>
        <span class="a">${esc(personName(s.personId))}</span><span class="b">${hrs(s.hours)}</span>
        <span class="c">${fmtShort(s.date)}${s.job ? " · " + esc(s.job) : ""}${s.location ? " · " + esc(s.location) : ""} ${unsyncedTag("shifts", s.id)}${approvalPill(s) ? ` ${approvalPill(s)}` : ""}</span><span class="d">${money(shiftPay(s).amount)}</span>
      </button>`).join("")}
      <div class="list-foot"><span>${hrs(th)}${hWait ? `<small>+ ${hrs(hWait)} in attesa</small>` : ""}</span><span>${money(tv)}</span></div>
    </div>`;
  }

  const receiptsShown = () => state.receipts
    .filter((r) => (ui.rStatus === "all" || (ui.rStatus === "reimbursed" ? r.status === "reimbursed" : r.status !== "reimbursed")) && (!ui.rPerson || r.personId === ui.rPerson) && (!ui.rCat || catOf(r) === ui.rCat))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));

  function photoSrc(r) {
    const local = localPhotos.get(r.id);
    if (local) return local.url;
    if (r.photoUploaded) return "/api/photos/" + encodeURIComponent(r.id);
    return null;
  }
  function shot(r) {
    const local = localPhotos.get(r.id);
    const waiting = local && !local.uploaded ? `<span class="pill wait flag">Foto non ancora caricata</span>` : "";
    if (!r.hasPhoto) return `<span class="ph">${ICON.receipt}Nessuna foto</span>`;
    if (r.photoType === "application/pdf") return `<span class="ph">${ICON.doc}Ricevuta PDF</span>${waiting}`;
    const src = photoSrc(r);
    if (!src) return `<span class="ph">${ICON.cam}Foto su un altro telefono, non ancora caricata</span>`;
    return `<img src="${esc(src)}" alt="Ricevuta: ${esc(r.description || "foto")}" loading="lazy">${waiting}`;
  }

  function renderReceipts() {
    const el = $("#receipts");
    const rows = receiptsShown();
    if (!rows.length) {
      el.innerHTML = ui.rStatus === "pending"
        ? empty("Niente da rimborsare", "Quando qualcuno paga un taxi, un pasto o del materiale per un lavoro, fotografa qui la ricevuta. Viene aggiunta a quanto gli è dovuto.", state.people.length ? "add-receipt" : null, "Fotografa una ricevuta")
        : empty("Nessuna ricevuta qui", "Le ricevute compaiono qui una volta aggiunte.");
      return;
    }
    const total = rows.reduce((a, r) => a + (Number(r.amount) || 0), 0);
    const byCat = new Map();
    for (const r of rows) byCat.set(catOf(r), (byCat.get(catOf(r)) || 0) + (Number(r.amount) || 0));
    el.innerHTML = `<p class="totals-line">${rows.length} ${rows.length === 1 ? "ricevuta" : "ricevute"} · <span class="mono">${money(total)}</span></p>
      ${byCat.size > 1 || ui.rCat ? `<div class="cat-totals" aria-label="Totali per categoria">${CATS.filter(([k]) => byCat.has(k)).map(([k, l]) => `<span class="cat-total"><span class="cat c-${k}">${esc(l)}</span><span class="mono">${money(byCat.get(k))}</span></span>`).join("")}</div>` : ""}
      <div class="rgrid">${rows.map((r) => `<article class="receipt">
        <button class="shot" type="button" data-act="view-receipt" data-id="${r.id}" aria-label="Apri ricevuta">${shot(r)}</button>
        <div class="meta">
          <div class="amt"><b>${money(r.amount)}</b>${r.status === "reimbursed" ? `<span class="pill paid">Rimborsato</span>` : `<span class="pill owed">Da rimborsare</span>`}</div>
          <div class="what">${esc(r.description || "Nessuna descrizione")}</div>
          <div class="cat-line"><span class="cat c-${catOf(r)}">${esc(catLabel(catOf(r)))}</span></div>
          <div class="by">${[esc(personName(r.personId)), fmtShort(r.date)].filter(Boolean).join(" · ")} ${unsyncedTag("receipts", r.id)}</div>
        </div>
      </article>`).join("")}</div>`;
  }

  function renderPayments() {
    const el = $("#payments");
    const rows = state.payments.filter((p) => !ui.pPerson || p.personId === ui.pPerson)
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
    if (!rows.length) {
      el.innerHTML = empty("Nessun pagamento registrato", "Registra ogni pagamento quando parte, così in Persone si vede chi è stato pagato e cosa resta da pagare.", isAdmin() && state.people.length ? "add-payment" : null, "Registra un pagamento");
      return;
    }
    let total = 0;
    const jobOf = (p) => (p.jobId && state.jobs.find((j) => j.id === p.jobId)) || null;
    const cards = rows.map((p) => {
      const rec = Number(p.receiptsAmount) || 0, t = (Number(p.amount) || 0) + rec, j = jobOf(p);
      const what = [methodLabel(p.method), p.note || (j ? jobLabel(j) : "")].filter(Boolean).map(esc).join(" · ");
      return `<div class="list-row">
        <span class="a">${esc(personName(p.personId))}</span><span class="b">${money(t)}</span>
        <span class="c">${fmtShort(p.date)} · ${what}${rec ? ` · di cui ricevute ${money(rec)}` : ""}${unsyncedTag("payments", p.id) ? ` ${unsyncedTag("payments", p.id)}` : ""}</span>
        <span class="d">${isAdmin() ? `<button class="btn quiet sm danger" type="button" data-act="del-payment" data-id="${p.id}">Elimina</button>` : ""}</span>
      </div>`;
    }).join("");
    el.innerHTML = `<div class="list">${cards}<div class="list-total"><span>${rows.length} ${rows.length === 1 ? "pagamento" : "pagamenti"}</span><b>${money(rows.reduce((a, p) => a + (Number(p.amount) || 0) + (Number(p.receiptsAmount) || 0), 0))}</b></div></div><div class="tablebox hours-table"><table>
      <thead><tr><th>Data</th><th>Pagato a</th><th>Metodo · nota</th><th class="n">Compensi</th><th class="n">Ricevute</th><th class="n">Totale</th><th></th></tr></thead>
      <tbody>${rows.map((p) => {
        const rec = Number(p.receiptsAmount) || 0, t = (Number(p.amount) || 0) + rec; total += t;
        const n = p.receiptIds?.length || 0;
        return `<tr>
          <td>${fmtShort(p.date)}${unsyncedTag("payments", p.id) ? `<span class="sub">${unsyncedTag("payments", p.id)}</span>` : ""}</td>
          <td class="who">${esc(personName(p.personId))}</td>
          <td>${esc(methodLabel(p.method))}${p.note ? `<span class="sub">${esc(p.note)}</span>` : ""}${p.jobId && state.jobs.some((j) => j.id === p.jobId) && jobLabel(state.jobs.find((j) => j.id === p.jobId)) !== p.note ? `<span class="sub">Per: ${esc(jobLabel(state.jobs.find((j) => j.id === p.jobId)))}</span>` : ""}</td>
          <td class="n">${money(p.amount)}</td>
          <td class="n">${rec ? `${money(rec)}<span class="sub">${n} ${n === 1 ? "ricevuta" : "ricevute"}</span>` : `<span class="muted">—</span>`}</td>
          <td class="n">${money(t)}</td>
          <td class="n">${isAdmin() ? `<button class="btn quiet sm danger" type="button" data-act="del-payment" data-id="${p.id}">Elimina</button>` : ""}</td>
        </tr>`;
      }).join("")}</tbody>
      <tfoot><tr><td colspan="5">${rows.length} ${rows.length === 1 ? "pagamento" : "pagamenti"}</td><td class="n">${money(total)}</td><td></td></tr></tfoot>
    </table></div>`;
  }

  // ---------- Settings ----------
  let accounts = null, accountsErr = null;
  async function loadAccounts() {
    if (!isAdmin()) return;
    try { accounts = (await api("/api/users", { method: "GET" })).users; accountsErr = null; }
    catch (e) { accountsErr = e.status ? e.msg : "Connettiti a internet per gestire gli accessi."; }
    render();
  }
  let installEvt = null;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  async function renderSettings() {
    const ob = await idb.count("outbox");
    const ph = (await idb.all("photos")).filter((p) => !p.uploaded).length;
    const el = $("#settings");
    const installPanel = standalone() ? `<p>Installata su questo dispositivo. Si apre a schermo intero e funziona anche senza campo.</p>`
      : installEvt ? `<p>Installala su questo dispositivo per aprirla come un'app e usarla anche senza campo.</p><div><button class="btn primary" type="button" id="install-btn">Installa app</button></div>`
      : isIOS ? `<p>Su iPhone o iPad: in Safari tocca <b>Condividi</b>, poi <b>Aggiungi alla schermata Home</b>. Si aprirà come un'app e funzionerà anche senza campo.</p>`
      : `<p>In Chrome o Edge usa l'icona di installazione nella barra degli indirizzi, oppure dal menu <b>Installa app</b> / <b>Aggiungi a schermata Home</b>. Su iPhone usa <b>Condividi → Aggiungi alla schermata Home</b> in Safari.</p>`;
    const ag = document.activeElement?.id === "agency" ? document.activeElement : null;
    const agencyDraft = ag ? [ag.value, ag.selectionStart ?? ag.value.length] : null; // keep typing across a background redraw
    el.innerHTML = `
      <section class="panel">
        <h2>Il tuo account</h2>
        <dl class="kv"><dt>Nome</dt><dd>${esc(me.name)}</dd><dt>Nome utente</dt><dd class="mono">${esc(me.username)}</dd><dt>Accesso</dt><dd>${isAdmin() ? "Amministratore" : "Collaboratore"}</dd>
          <dt>In squadra come</dt><dd>${myPerson() ? `${esc(myPerson().name)} · <a href="#me">La mia pagina</a>` : `<span class="muted">Non collegato${isAdmin() ? " · collegalo in Accessi della squadra" : " · chiedi a un amministratore di collegare il tuo accesso"}</span>`}</dd></dl>
        <div class="sheet-foot"><button class="btn" type="button" data-act="password">Cambia password</button><button class="btn danger" type="button" id="logout-btn">Esci</button></div>
      </section>
      <section class="panel">
        <h2>Questo dispositivo</h2>
        <dl class="kv">
          <dt>Connessione</dt><dd>${sync.online ? "Online" : "Offline"}</dd>
          <dt>Da inviare</dt><dd>${ob ? `${ob} ${ob === 1 ? "modifica" : "modifiche"}` : "Niente"}${ph ? ` · ${ph} foto` : ""}</dd>
          <dt>Ultima sincronizzazione</dt><dd>${sync.last ? ago(sync.last) : "Non ancora"}</dd>
        </dl>
        <div><button class="btn" type="button" data-act="sync-now">Sincronizza ora</button></div>
      </section>
      <section class="panel"><h2>Usala come app</h2>${installPanel}</section>
      ${isAdmin() ? `<section class="panel">
        <h2>Valuta</h2>
        <div class="field"><label for="currency">Importi mostrati in</label>
          <select id="currency">${[["EUR", "Euro (€)"], ["GBP", "Sterlina (£)"], ["USD", "Dollaro USA ($)"], ["CHF", "Franco svizzero (CHF)"]].map(([v, l]) => `<option value="${v}" ${state.settings.currency === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      </section>
      <section class="panel">
        <h2>Estratti conto</h2>
        <div class="field"><label for="agency">Nome dell'agenzia</label><input id="agency" maxlength="80" autocomplete="organization" placeholder="Lumia" value="${esc(state.settings.agencyName || "")}"><span class="hint">Stampato in cima a ogni estratto conto.</span></div>
        <div class="field"><label for="agency-addr">Indirizzo dell'agenzia</label><input id="agency-addr" maxlength="160" autocomplete="street-address" placeholder="${esc(AGENCY_ADDRESS)}" value="${esc(agencyAddress())}"><span class="hint">Sotto il nome, negli estratti conto.</span></div>
      </section>
      <section class="panel wide">
        <div class="view-head"><div><h2>Accessi della squadra</h2><p>I collaboratori possono registrare ore, aggiungere ricevute e segnalare la posizione. Gli amministratori gestiscono anche persone, tariffe e pagamenti.</p></div>
          <div class="view-actions"><button class="btn primary" type="button" data-act="add-account">Aggiungi accesso</button></div></div>
        <div id="acct-list">${accountsErr ? `<p class="err">${esc(accountsErr)}</p>` : !accounts ? `<p class="muted">Caricamento…</p>` : accounts.map((a) => `<div class="acct">
          <div><div class="nm">${esc(a.name)} ${a.disabled ? `<span class="pill over">Disattivato</span>` : ""}${a.pending && !a.disabled ? ` <span class="pill owed">Nuova iscrizione</span>` : ""}${a.role === "client" && !a.clientName && !a.disabled ? ` <span class="pill owed">Cliente da confermare</span>` : ""}</div><div class="un">${esc(a.username)} · ${a.role === "admin" ? "Amministratore" : a.role === "client" ? `Cliente${a.company ? " · " + esc(a.company) : ""}` : `Collaboratore${a.pending ? ` · ${roleLabel(a.wants)}` : ""}`}${a.phone ? " · " + esc(a.phone) : ""}</div></div>
          <div class="ctl">
            ${a.role === "client" ? `<label class="link-sel"><span>Cliente</span><input class="client-link" data-client="${a.id}" list="jf-clients" value="${esc(a.clientName || "")}" placeholder="${esc(a.company || "Nome cliente")}" aria-label="Cliente di ${esc(a.name)}"></label>
            ${!a.clientName && a.company ? `<button class="btn sm primary" type="button" data-act="confirm-client" data-id="${a.id}">Conferma ${esc(a.company)}</button>` : ""}
            <button class="btn sm" type="button" data-act="reset-pw" data-id="${a.id}">Reimposta password</button>
            <button class="btn sm ${a.disabled ? "" : "danger"}" type="button" data-act="toggle-disabled" data-id="${a.id}">${a.disabled ? "Riattiva" : "Disattiva"}</button>` : a.pending ? `<button class="btn sm primary" type="button" data-act="approve-signup" data-id="${a.id}">Approva e aggiungi alla squadra</button>
            <button class="btn sm ${a.disabled ? "" : "danger"}" type="button" data-act="toggle-disabled" data-id="${a.id}">${a.disabled ? "Riattiva" : "Rifiuta"}</button>` : `<label class="link-sel"><span>È</span><select data-link="${a.id}" aria-label="Persona della squadra per ${esc(a.name)}"><option value="">Non in squadra</option>${state.people.slice().sort(byName).map((p) => `<option value="${p.id}" ${a.personId === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
            <button class="btn sm" type="button" data-act="reset-pw" data-id="${a.id}">Reimposta password</button>
            ${a.id === me.id ? "" : `<button class="btn sm" type="button" data-act="toggle-role" data-id="${a.id}">${a.role === "admin" ? "Rendi collaboratore" : "Rendi amministratore"}</button>
            <button class="btn sm ${a.disabled ? "" : "danger"}" type="button" data-act="toggle-disabled" data-id="${a.id}">${a.disabled ? "Riattiva" : "Disattiva"}</button>`}`}
          </div></div>`).join("")}</div>
      </section>
      ${placesPanel()}
      <section class="panel wide" id="activity">${activityShell()}</section>` : ""}`;
    $("#install-btn")?.addEventListener("click", async () => { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; renderSettings(); });
    $("#currency")?.addEventListener("change", (e) => save("settings", { ...state.settings, id: "main", currency: e.target.value }).then(() => toast("Valuta salvata")));
    if (agencyDraft && $("#agency")) { const a = $("#agency"); a.value = agencyDraft[0]; a.focus(); a.setSelectionRange(agencyDraft[1], agencyDraft[1]); }
    $("#agency-addr")?.addEventListener("change", (e) => save("settings", { ...state.settings, id: "main", agencyAddress: e.target.value.trim().slice(0, 160) }).then(() => toast("Indirizzo dell'agenzia salvato")));
    $("#agency")?.addEventListener("change", (e) => save("settings", { ...state.settings, id: "main", agencyName: e.target.value.trim().slice(0, 80) }).then(() => toast("Nome dell'agenzia salvato")));
    $("#logout-btn").addEventListener("click", (e) => logout(e.currentTarget, ob + ph));
    if (isAdmin()) { bindSettingsExtras(); paintActivity(); }
  }

  // ---------- Person detail ----------
  let detailId = null;
  function renderDetail(id) {
    const p = state.people.find((x) => x.id === id);
    if (!p) { $("#d-detail").close(); return; }
    const b = balances().get(id);
    $("#dt-title").textContent = p.name;
    const sortD = (a, c) => (c.date || "").localeCompare(a.date || "");
    const shifts = state.shifts.filter((s) => s.personId === id).sort(sortD);
    const pays = state.payments.filter((s) => s.personId === id).sort(sortD);
    const recs = state.receipts.filter((s) => s.personId === id).sort(sortD);
    if (!seesPay(id)) {
      $("#dt-body").innerHTML = `
      <dl class="kv">
        <dt>Ruolo</dt><dd>${roleLabel(p.role)}${p.speciality ? " · " + esc(p.speciality) : ""}</dd>
        <dt>Posizione</dt><dd>${p.location ? `${esc(p.location)} <span class="muted">· ${ago(p.locationAt)}</span>` : `<span class="muted">Sconosciuta</span>`}</dd>
        ${p.phone ? `<dt>Telefono</dt><dd class="mono">${esc(p.phone)}</dd>` : ""}
      </dl>
      <p class="muted">Ore, compensi e pagamenti dei colleghi sono visibili solo all'ufficio.</p>`;
      return;
    }
    $("#dt-body").innerHTML = `
      <dl class="kv">
        <dt>Ruolo</dt><dd>${roleLabel(p.role)}${p.speciality ? " · " + esc(p.speciality) : ""}</dd>
        <dt>Paga</dt><dd class="mono">${esc(termsText(payTerms(p)))}</dd>
        <dt>Posizione</dt><dd>${p.location ? `${esc(p.location)} <span class="muted">· ${ago(p.locationAt)}</span>` : `<span class="muted">Sconosciuta</span>`}</dd>
        ${p.phone ? `<dt>Telefono</dt><dd class="mono">${esc(p.phone)}</dd>` : ""}
      </dl>
      <div class="detail-figs">
        <div><span class="eyebrow">Guadagnato</span><span class="v">${money(b.earned)}</span></div>
        <div><span class="eyebrow">Compensi pagati</span><span class="v">${money(b.paid)}</span></div>
        <div><span class="eyebrow">Ricevute da rimborsare</span><span class="v">${money(b.rec)}</span></div>
        <div><span class="eyebrow">Da pagare ora</span><span class="v ${b.owed > 0.004 ? "owed" : "paid"}">${money(b.owed)}</span></div>
      </div>
      <div class="sheet-foot">
        <button class="btn sm" type="button" data-act="add-shift" data-id="${id}">${ICON.clock}Registra ore</button>
        <button class="btn sm" type="button" data-act="add-receipt" data-id="${id}">${ICON.cam}Aggiungi ricevuta</button>
        <button class="btn sm" type="button" data-act="statement" data-id="${id}">${ICON.doc}Estratto conto</button>
        ${isAdmin() ? `<button class="btn sm primary" type="button" data-act="add-payment" data-id="${id}" ${b.owed > 0.004 ? "" : "disabled"}>${ICON.card}Registra pagamento</button>` : ""}
      </div>
      <h4 class="eyebrow">Ore · ${hrs(b.hAll)} in totale${b.hPend ? ` · + ${hrs(b.hPend)} in attesa di approvazione` : ""}</h4>
      ${shifts.length ? `<div class="tablebox"><table><thead><tr><th>Data</th><th>Lavoro · posizione</th><th class="n">Ore</th><th class="n">Guadagnato</th></tr></thead><tbody>
        ${shifts.slice(0, 60).map((s) => `<tr><td>${fmtShort(s.date)}${approvalPill(s) ? `<span class="sub">${approvalPill(s)}</span>` : ""}</td><td>${esc(s.job || "—")}${s.location ? `<span class="sub">${esc(s.location)}</span>` : ""}</td><td class="n">${hrs(s.hours)}${otSub(s)}</td><td class="n">${money(shiftPay(s).amount)}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">Nessuna ora registrata.</p>`}
      <h4 class="eyebrow">Ricevute</h4>
      ${recs.length ? `<div class="tablebox"><table><thead><tr><th>Data</th><th>Per</th><th class="n">Importo</th><th>Stato</th></tr></thead><tbody>
        ${recs.map((r) => `<tr><td>${fmtShort(r.date)}</td><td><button class="btn quiet sm" type="button" data-act="view-receipt" data-id="${r.id}">${esc(r.description || "Ricevuta")}</button></td><td class="n">${money(r.amount)}</td><td>${r.status === "reimbursed" ? `<span class="pill paid">Rimborsato</span>` : `<span class="pill owed">Da rimborsare</span>`}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">Nessuna ricevuta.</p>`}
      <h4 class="eyebrow">Pagamenti</h4>
      ${pays.length ? `<div class="tablebox"><table><thead><tr><th>Data</th><th>Metodo</th><th class="n">Compensi</th><th class="n">Ricevute</th></tr></thead><tbody>
        ${pays.map((x) => `<tr><td>${fmtShort(x.date)}</td><td>${esc(methodLabel(x.method))}${x.note ? `<span class="sub">${esc(x.note)}</span>` : ""}</td><td class="n">${money(x.amount)}</td><td class="n">${x.receiptsAmount ? money(x.receiptsAmount) : "—"}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">Ancora nessun pagamento.</p>`}`;
  }

  // ---------- Sync indicator ----------
  async function paintSync() {
    const el = $("#sync"), txt = $("#sync-txt"), banner = $("#banner");
    if (!el || !me) return;
    const n = pendingKeys.size + [...localPhotos.values()].filter((p) => !p.uploaded).length;
    let st = "ok", label = sync.last ? `Sincronizzato ${ago(sync.last)}` : "Aggiornato";
    if (sync.busy) { st = "syncing"; label = "Sincronizzazione…"; }
    else if (sync.authLost) { st = "error"; label = "Accedi per sincronizzare"; }
    else if (!sync.online) { st = "offline"; label = n ? `Offline · ${n} ${n === 1 ? "salvata" : "salvate"} qui` : "Offline"; }
    else if (sync.error) { st = "error"; label = "Problema di sincronizzazione"; }
    else if (n) { st = "syncing"; label = `${n} da inviare`; }
    el.dataset.state = st; txt.textContent = label;
    el.title = sync.error || (st === "offline" ? "Nessuna connessione. Tutto ciò che aggiungi resta su questo dispositivo e viene inviato quando torni online." : "Sincronizza ora");

    const bt = $("#banner-btn");
    if (sync.authLost) {
      banner.hidden = false; banner.className = "banner risk";
      $("#banner-txt").textContent = n ? (n === 1 ? "Il tuo accesso è scaduto. Accedi di nuovo per inviare la modifica salvata su questo dispositivo." : `Il tuo accesso è scaduto. Accedi di nuovo per inviare le ${n} modifiche salvate su questo dispositivo.`) : "Il tuo accesso è scaduto. Accedi di nuovo per vedere gli ultimi aggiornamenti.";
      bt.hidden = false; bt.textContent = "Accedi"; bt.onclick = () => showAuth("login", true);
    } else if (!sync.online && n) {
      banner.hidden = false; banner.className = "banner";
      $("#banner-txt").textContent = (n === 1 ? "Sei offline. 1 modifica è salvata su questo dispositivo e verrà inviata quando torni online." : `Sei offline. ${n} modifiche sono salvate su questo dispositivo e verranno inviate quando torni online.`);
      bt.hidden = true;
    } else banner.hidden = true;
  }

  // ---------- Sheets ----------
  function openSheet(id) { const d = $(id); if (!d.open) d.showModal(); return d; }
  document.addEventListener("click", (e) => {
    const c = e.target.closest("[data-close]"); if (c) c.closest("dialog").close();
  });
  // Tap outside a sheet closes it.
  $$("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));

  function personOptions(sel, selected) {
    sel.innerHTML = state.people.slice().sort(byName).map((p) => `<option value="${p.id}">${esc(p.name)} · ${roleLabel(p.role)}</option>`).join("");
    if (selected && state.people.some((p) => p.id === selected)) sel.value = selected;
  }
  function needPeople() {
    if (state.people.length) return false;
    if (isAdmin()) { toast("Prima aggiungi una persona"); openPerson(); } else toast("Prima un amministratore deve aggiungere la squadra.");
    return true;
  }
  async function attempt(form, errEl, fn) {
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true; showErr(errEl, "");
    try { await fn(); }
    catch (e) { console.error(e); showErr(errEl, e.msg || "Impossibile salvare su questo dispositivo. Libera un po' di spazio e riprova."); }
    finally { btn.disabled = false; }
  }
  // Destructive buttons ask twice instead of using a popup.
  function armed(btn, label, fn) {
    if (btn.classList.contains("armed")) { clearTimeout(btn.t); btn.classList.remove("armed"); btn.textContent = btn.dataset.label; fn(); return; }
    btn.dataset.label = btn.textContent; btn.textContent = label; btn.classList.add("armed");
    btn.t = setTimeout(() => { btn.classList.remove("armed"); btn.textContent = btn.dataset.label; }, 4000);
  }
  function disarm(btn, text) { clearTimeout(btn.t); btn.classList.remove("armed"); btn.textContent = text; }

  // Quick-add
  function openQuick() {
    const opts = [
      ["add-shift", ICON.clock, "Registra ore", "Convocazione, fine e lavoro"],
      ["add-receipt", ICON.cam, "Ricevuta", "Fotografa una spesa"],
      ["loc", ICON.pin, "Posizione", "Aggiorna una posizione"],
    ];
    if (isAdmin()) opts.push(["add-payment", ICON.card, "Pagamento", "Registra un pagamento"]);
    else opts.push(["goto-hours", ICON.clock, "Le mie ore", "Vedi cosa è registrato"]);
    const self = staffMe() ? myPerson().id : "";
    $("#quick").innerHTML = opts.map(([a, i, t, s]) => `<button type="button" data-act="${a}"${self && ["add-shift", "add-receipt", "loc"].includes(a) ? ` data-id="${self}"` : ""}>${i}<div><b>${t}</b><span>${s}</span></div></button>`).join("");
    openSheet("#d-quick");
  }

  // Person pay terms (admin form). Returns the terms, or an error message.
  function personFormTerms() {
    const v = (id) => $(id).value.trim(), n = (id) => parseFloat($(id).value);
    const day = $("#pf-paytype").value === "day";
    const rate = day && v("#pf-rate") === "" ? 0 : n("#pf-rate");
    const otAfter = v("#pf-otafter") === "" ? 0 : n("#pf-otafter");
    const otMult = v("#pf-otmult") === "" ? 1.5 : n("#pf-otmult");
    if (!(rate >= 0)) return day ? "La tariffa oraria non può essere negativa." : "Inserisci una tariffa oraria. Usa 0 per i ruoli non retribuiti.";
    if (!(otAfter >= 0 && otAfter < 24)) return "Lo straordinario parte dopo un numero di ore tra 0 e 24. Lascia vuoto per nessuno straordinario.";
    if (otAfter && !(otMult >= 1 && otMult <= 5)) return "Lo straordinario paga tra 1× e 5× la tariffa oraria.";
    const t = { payType: day ? "day" : "hourly", rate: round2(rate), dayRate: 0, halfDayRate: 0, halfDayUnder: 0, otAfter: round2(otAfter), otMult: otMult >= 1 && otMult <= 5 ? round2(otMult) : 1.5 };
    if (!day) return t;
    const dr = n("#pf-dayrate"), hr = v("#pf-halfrate") === "" ? 0 : n("#pf-halfrate"), hu = v("#pf-halfunder") === "" ? 0 : n("#pf-halfunder");
    if (!(dr > 0)) return "Inserisci la tariffa giornaliera.";
    if (hr || hu) {
      if (!(hr > 0)) return "Inserisci la tariffa di mezza giornata, oppure cancella le ore sotto cui si applica.";
      if (!(hu > 0 && hu <= 24)) return "Inserisci quante ore valgono come mezza giornata.";
    }
    if (otAfter && !(rate > 0)) return "Inserisci la tariffa oraria con cui si paga lo straordinario.";
    return { ...t, dayRate: round2(dr), halfDayRate: round2(hr), halfDayUnder: round2(hu) };
  }
  function fillPersonTerms(p) {
    const t = payTerms(p);
    $("#pf-paytype").value = t.payType;
    $("#pf-dayrate").value = t.dayRate || "";
    $("#pf-halfrate").value = t.halfDayRate || ""; $("#pf-halfunder").value = t.halfDayUnder || "";
    $("#pf-otafter").value = t.otAfter || ""; $("#pf-otmult").value = p.otMult ? t.otMult : 1.5;
    $("#pf-more").open = !!(t.otAfter || t.halfDayRate);
    personTermsUI();
  }
  function personTermsUI() {
    const day = $("#pf-paytype").value === "day";
    $("#pf-day-wrap").hidden = $("#pf-half-wrap").hidden = !day;
    $('label[for="pf-rate"]').textContent = day ? "Tariffa oraria per lo straordinario" : "Tariffa oraria";
    $("#pf-rate").placeholder = day ? "Solo per lo straordinario" : "";
    const t = personFormTerms();
    $("#pf-terms").textContent = typeof t === "string" ? "" : `Paga ${termsText(t)}. Ogni turno mantiene le condizioni con cui è stato registrato.`;
  }
  $("#d-person form").addEventListener("input", personTermsUI);
  $("#pf-paytype").addEventListener("change", personTermsUI);

  // Person
  let editingPerson = null;
  function openPerson(id) {
    if (!isAdmin()) return;
    editingPerson = id || null;
    const p = state.people.find((x) => x.id === id) || {};
    $("#pf-title").textContent = id ? `Modifica ${p.name}` : "Aggiungi persona";
    $("#pf-name").value = p.name || ""; $("#pf-role").value = p.role || "model"; $("#pf-rate").value = p.rate ?? "";
    fillPersonTerms(p);
    $("#pf-spec").value = p.speciality || ""; $("#pf-loc").value = p.location || ""; $("#pf-phone").value = p.phone || "";
    $("#pf-del").hidden = !id; disarm($("#pf-del"), "Elimina");
    showErr($("#pf-err"), "");
    openSheet("#d-person"); $("#pf-name").focus();
  }
  $("#d-person form").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.currentTarget, err = $("#pf-err");
    const name = $("#pf-name").value.trim();
    if (!name) return showErr(err, "Inserisci il nome.");
    const terms = personFormTerms();
    if (typeof terms === "string") return showErr(err, terms);
    attempt(form, err, async () => {
      const prev = state.people.find((x) => x.id === editingPerson);
      const location = $("#pf-loc").value.trim();
      const data = { ...(prev || {}), name, role: $("#pf-role").value, ...terms, speciality: $("#pf-spec").value.trim(), phone: $("#pf-phone").value.trim(), location };
      if (!prev || (prev.location || "") !== location) data.locationAt = Date.now();
      await save("people", data);
      $("#d-person").close(); toast(prev ? "Salvato" : `${name} aggiunto/a alla squadra`);
    });
  });
  $("#pf-del").addEventListener("click", (e) => {
    const btn = e.currentTarget, id = editingPerson;
    const related = ["shifts", "payments", "receipts"].flatMap((c) => state[c].filter((r) => r.personId === id).map((r) => [c, r]));
    armed(btn, related.length ? `Eliminare con ${related.length === 1 ? "1 voce" : `${related.length} voci`}?` : "Tocca di nuovo per eliminare", async () => {
      for (const [c, r] of related) await remove(c, r);
      await remove("people", state.people.find((p) => p.id === id));
      $("#d-person").close(); toast("Eliminato");
    });
  });

  // Location check-in
  let locId = null;
  function openLoc(id) {
    if (needPeople()) return;
    locId = id || null;
    $("#lf-person-wrap").hidden = !!id;
    personOptions($("#lf-person"), id || state.people[0]?.id);
    const fill = () => { const p = state.people.find((x) => x.id === (locId || $("#lf-person").value)); $("#lf-who").textContent = p ? p.name.split(" ")[0] : "?"; $("#lf-loc").value = p?.location || ""; };
    $("#lf-person").onchange = fill; fill();
    paintPlaces();
    showErr($("#lf-err"), "");
    openSheet("#d-loc"); $("#lf-loc").focus(); $("#lf-loc").select();
  }
  $("#d-loc form").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = locId || $("#lf-person").value;
    attempt(e.currentTarget, $("#lf-err"), async () => {
      const p = state.people.find((x) => x.id === id);
      await save("people", { ...p, location: $("#lf-loc").value.trim(), locationAt: Date.now() });
      $("#d-loc").close(); toast(`Posizione di ${p.name.split(" ")[0]} aggiornata`);
    });
  });

  // Hours
  let editingShift = null;
  function calcHours() {
    const a = $("#sf-start").value, b = $("#sf-end").value;
    if (a && b) {
      const [ah, am] = a.split(":").map(Number), [bh, bm] = b.split(":").map(Number);
      let mins = bh * 60 + bm - (ah * 60 + am); if (mins <= 0) mins += 1440; // wrap after midnight
      $("#sf-hours").value = Math.round(mins / 15) / 4;
    }
    shiftCalc();
  }
  // The pay terms this shift is logged under. The rate box edits the main rate of those terms
  // (hourly rate, or day rate); overtime and half-day rules come with the person.
  let sfTerms = payTerms();
  function setShiftTerms(t) {
    sfTerms = t;
    $('label[for="sf-rate"]').textContent = t.payType === "day" ? "Tariffa giornaliera" : "Tariffa oraria";
    $("#sf-rate").value = t.payType === "day" ? t.dayRate : t.rate;
  }
  function shiftFormTerms() {
    const r = round2(parseFloat($("#sf-rate").value) || 0);
    return sfTerms.payType === "day" ? { ...sfTerms, dayRate: r } : { ...sfTerms, rate: r };
  }
  function shiftCalc() {
    const h = parseFloat($("#sf-hours").value) || 0, r = parseFloat($("#sf-rate").value) || 0;
    const el = $("#sf-calc"); el.hidden = !(h && r);
    el.textContent = payExplain(h, shiftFormTerms());
  }
  function openShift(personId, shiftId) {
    if (needPeople()) return;
    editingShift = shiftId || null;
    const s = state.shifts.find((x) => x.id === shiftId) || {};
    personOptions($("#sf-person"), s.personId || personId || ui.hPerson || state.people.slice().sort(byName)[0]?.id);
    const p = state.people.find((x) => x.id === $("#sf-person").value);
    $("#sf-title").textContent = shiftId ? "Modifica ore" : "Registra ore";
    $("#sf-date").value = s.date || isoDay();
    $("#sf-start").value = s.start || ""; $("#sf-end").value = s.end || "";
    $("#sf-hours").value = s.hours ?? "";
    setShiftTerms(shiftId ? shiftTerms(s) : payTerms(p));
    $("#sf-rate").readOnly = !isAdmin() && !!p; // staff use the agreed rate
    $("#sf-job").value = s.job || "";
    $("#sf-loc").value = shiftId ? s.location || "" : p?.location || "";
    $("#sf-del").hidden = !shiftId; disarm($("#sf-del"), "Elimina");
    showErr($("#sf-err"), ""); shiftCalc();
    jobFillShift(s, shiftId); // booking select; pre-fills when logging from a job
    openSheet("#d-shift");
  }
  $("#sf-person").addEventListener("change", () => {
    if (editingShift) return;
    const p = state.people.find((x) => x.id === $("#sf-person").value);
    if (p) { setShiftTerms(payTerms(p)); $("#sf-loc").value = p.location || ""; }
    shiftCalc();
  });
  $("#sf-start").addEventListener("change", calcHours);
  $("#sf-end").addEventListener("change", calcHours);
  $("#sf-hours").addEventListener("input", shiftCalc);
  $("#sf-rate").addEventListener("input", shiftCalc);
  $("#d-shift form").addEventListener("submit", (e) => {
    e.preventDefault();
    const err = $("#sf-err");
    const hours = parseFloat($("#sf-hours").value), rate = parseFloat($("#sf-rate").value), date = $("#sf-date").value;
    if (!date) return showErr(err, "Scegli la data del lavoro.");
    if (!(hours > 0) || hours > 24) return showErr(err, "Inserisci tra 0,25 e 24 ore, oppure compila convocazione e fine.");
    if (!(rate >= 0)) return showErr(err, sfTerms.payType === "day" ? "Inserisci la tariffa giornaliera." : "Inserisci la tariffa oraria.");
    attempt(e.currentTarget, err, async () => {
      const prev = state.shifts.find((x) => x.id === editingShift);
      const personId = $("#sf-person").value, location = $("#sf-loc").value.trim();
      await save("shifts", { ...(prev || {}), personId, date, hours: round2(hours), ...shiftFormTerms(), start: $("#sf-start").value, end: $("#sf-end").value, job: $("#sf-job").value.trim(), location, jobId: $("#sf-jobid").value || "" });
      const p = state.people.find((x) => x.id === personId);
      if (!prev && date === isoDay() && location && p && (p.location || "") !== location) await save("people", { ...p, location, locationAt: Date.now() });
      $("#d-shift").close();
      toast(prev ? "Ore aggiornate" : `${hrs(hours)} registrate per ${personName(personId)}${sync.online ? "" : " · salvate su questo dispositivo"}`);
    });
  });
  $("#sf-del").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    armed(btn, "Tocca di nuovo per eliminare", async () => {
      await remove("shifts", state.shifts.find((s) => s.id === editingShift));
      $("#d-shift").close(); toast("Voce eliminata");
    });
  });

  // Receipts
  let picked = null, pickedUrl = null;
  function setPicked(blob, name) {
    picked = blob;
    if (pickedUrl) URL.revokeObjectURL(pickedUrl); pickedUrl = null;
    const pv = $("#rf-preview");
    if (!blob) { pv.hidden = true; pv.innerHTML = ""; $("#rf-capture").hidden = false; return; }
    $("#rf-capture").hidden = true; pv.hidden = false;
    if (blob.type.startsWith("image/")) { pickedUrl = URL.createObjectURL(blob); pv.innerHTML = `<img alt="Anteprima ricevuta" src="${pickedUrl}">`; }
    else pv.innerHTML = `<div class="pdf">${esc(name || "PDF")}</div>`;
    pv.insertAdjacentHTML("beforeend", `<button class="btn sm" type="button" id="rf-retake">Rifai</button>`);
    $("#rf-retake").onclick = () => setPicked(null);
  }
  function openReceipt(personId) {
    if (needPeople()) return;
    personOptions($("#rf-person"), personId || ui.rPerson || state.people.slice().sort(byName)[0]?.id);
    setPicked(null);
    $("#rf-amount").value = ""; $("#rf-date").value = isoDay(); $("#rf-desc").value = "";
    const rc = $("#rf-cat");
    if (!rc.options.length) rc.innerHTML = CATS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
    rc.value = ui.lastCat || "travel";
    showErr($("#rf-err"), "");
    jobFillReceipt($("#rf-person").value); // optional job link
    openSheet("#d-receipt");
  }
  // Resize phone photos to a sharp 2000px JPEG: readable, a fraction of the size.
  async function shrink(file) {
    if (!file.type.startsWith("image/") || file.type === "image/gif" || file.type === "image/svg+xml") return file;
    try {
      const bmp = await createImageBitmap(file);
      const s = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      if (s === 1 && file.size < 1.2e6 && /^image\/(jpeg|png|webp)$/.test(file.type)) return file;
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      return (await new Promise((r) => c.toBlob(r, "image/jpeg", 0.84))) || file;
    } catch { return file; }
  }
  async function onFile(input) {
    const f = input.files?.[0]; input.value = "";
    if (!f) return;
    if (!/^image\//.test(f.type) && f.type !== "application/pdf") return showErr($("#rf-err"), "Usa una foto o un PDF.");
    showErr($("#rf-err"), "");
    const blob = await shrink(f);
    if (blob.size > 15 * 1024 * 1024) return showErr($("#rf-err"), "Il file supera i 15 MB. Rifai la foto o scegli un file più piccolo.");
    if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(blob.type)) return showErr($("#rf-err"), "Questo formato di foto non è leggibile qui. Prova a rifarla o salvala come JPEG.");
    setPicked(blob, f.name);
  }
  $("#rf-cam").addEventListener("click", () => $("#rf-cam-in").click());
  $("#rf-pick").addEventListener("click", () => $("#rf-file-in").click());
  $("#rf-cam-in").addEventListener("change", (e) => onFile(e.target));
  $("#rf-file-in").addEventListener("change", (e) => onFile(e.target));
  $("#d-receipt form").addEventListener("submit", (e) => {
    e.preventDefault();
    const err = $("#rf-err");
    const amount = parseFloat($("#rf-amount").value), date = $("#rf-date").value;
    if (!(amount > 0)) return showErr(err, "Inserisci l'importo della ricevuta.");
    if (!date) return showErr(err, "Scegli la data della ricevuta.");
    attempt(e.currentTarget, err, async () => {
      const id = uid();
      if (picked) await idb.put("photos", { id, blob: picked, type: picked.type, uploaded: false, savedAt: Date.now() });
      ui.lastCat = $("#rf-cat").value;
      await save("receipts", { id, category: $("#rf-cat").value, personId: $("#rf-person").value, amount: round2(amount), date, description: $("#rf-desc").value.trim(), jobId: $("#rf-job").value || "", status: "pending", hasPhoto: !!picked, photoType: picked?.type || null, photoUploaded: false });
      $("#d-receipt").close(); setPicked(null);
      toast(`Ricevuta da ${money(amount)} salvata${sync.online ? "" : " su questo dispositivo"}`);
    });
  });

  function openView(id) {
    const r = state.receipts.find((x) => x.id === id); if (!r) return;
    $("#vw-title").textContent = `${money(r.amount)} · ${personName(r.personId)}`;
    const src = r.hasPhoto ? photoSrc(r) : null;
    const media = !r.hasPhoto ? `<div class="empty"><p>A questa ricevuta non è allegata nessuna foto.</p></div>`
      : !src ? `<div class="empty"><p>La foto è ancora sul telefono che l'ha scattata. Comparirà quando quel telefono tornerà online.</p></div>`
      : r.photoType === "application/pdf" ? `<div class="empty"><p>Questa ricevuta è un PDF.</p><a class="btn" href="${esc(src)}" target="_blank" rel="noopener">Apri PDF</a></div>`
      : `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="Foto della ricevuta"></a>`;
    const canChange = isAdmin() || (r.by === me.id && r.status !== "reimbursed");
    $("#vw-body").innerHTML = `${media}
      <dl class="kv">
        <dt>Per</dt><dd>${esc(r.description || "—")}</dd>
        <dt>Pagato da</dt><dd>${esc(personName(r.personId))}</dd>
        <dt>Categoria</dt><dd><span class="cat c-${catOf(r)}">${esc(catLabel(catOf(r)))}</span></dd>
        <dt>Data</dt><dd>${fmtDate(r.date)}</dd>
        ${receiptJobRow(r)}
        <dt>Stato</dt><dd>${r.status === "reimbursed" ? `<span class="pill paid">Rimborsato${r.reimbursedAt ? " · " + fmtDate(r.reimbursedAt) : ""}</span>` : `<span class="pill owed">Da rimborsare</span>`}</dd>
      </dl>
      <div class="err" id="vw-err" hidden></div>
      ${canChange ? `<div class="sheet-foot">
        <button class="btn danger left" type="button" id="vw-del">Elimina</button>
        ${isAdmin() ? (r.status === "reimbursed" ? `<button class="btn" type="button" id="vw-undo">Segna come non rimborsato</button>` : `<button class="btn primary" type="button" id="vw-done">Segna come rimborsato</button>`) : ""}
      </div>` : ""}`;
    $("#vw-done")?.addEventListener("click", async () => { await save("receipts", { ...r, status: "reimbursed", reimbursedAt: isoDay() }); $("#d-view").close(); toast("Segnato come rimborsato"); });
    $("#vw-undo")?.addEventListener("click", async () => { await save("receipts", { ...r, status: "pending", reimbursedAt: null }); $("#d-view").close(); toast("Di nuovo tra le ricevute da rimborsare"); });
    $("#vw-del")?.addEventListener("click", (e) => armed(e.currentTarget, "Tocca di nuovo per eliminare", async () => {
      await idb.del("photos", r.id).catch(() => {});
      await remove("receipts", r); $("#d-view").close(); toast("Ricevuta eliminata");
    }));
    openSheet("#d-view");
  }

  // Payments
  function payInfo() {
    const pid = $("#yf-person").value, b = balances().get(pid); if (!b) return;
    const open = state.receipts.filter((r) => r.personId === pid && r.status !== "reimbursed");
    $("#yf-bal").textContent = `Compensi dovuti ${money(Math.max(0, b.wageDue))}${b.rec ? ` · ricevute ${money(b.rec)}` : ""} · da pagare ${money(b.owed)}`;
    $("#yf-amount").value = Math.max(0, b.wageDue).toFixed(2);
    $("#yf-rec-wrap").hidden = !open.length;
    $("#yf-rec-lbl").textContent = (open.length === 1 ? `Rimborsa anche 1 ricevuta (${money(b.rec)}) con questo pagamento` : `Rimborsa anche ${open.length} ricevute (${money(b.rec)}) con questo pagamento`);
  }
  let payJob = "";
  function payJobs() {
    const pid = $("#yf-person").value, sel = $("#yf-job");
    const jobs = state.jobs.filter((j) => !j.archived && ((j.people || []).includes(pid) || state.shifts.some((x) => x.jobId === j.id && x.personId === pid))).sort((a, b) => byStart(b, a));
    sel.innerHTML = `<option value="">Nessun lavoro in particolare</option>` + jobs.map((j) => { const c = crewPay(j).find((x) => x.pid === pid); return `<option value="${j.id}">${esc(jobLabel(j))} · ${fmtShort(j.date)}${c && c.done ? " · già pagato" : c && c.due ? ` · da pagare ${money(c.due)}` : ""}</option>`; }).join("");
    sel.value = jobs.some((j) => j.id === payJob) ? payJob : "";
    $("#yf-job-wrap").hidden = !jobs.length;
    payForJob();
  }
  function payForJob() {
    const j = state.jobs.find((x) => x.id === $("#yf-job").value), pid = $("#yf-person").value;
    if (!j) return payInfo();
    const c = crewPay(j).find((x) => x.pid === pid);
    $("#yf-amount").value = (c ? c.due : 0).toFixed(2);
    if (!$("#yf-note").value.trim() || $("#yf-note").dataset.auto === "1") { $("#yf-note").value = jobLabel(j); $("#yf-note").dataset.auto = "1"; }
  }
  $("#yf-job").addEventListener("change", () => { payJob = $("#yf-job").value; if (!payJob && $("#yf-note").dataset.auto === "1") $("#yf-note").value = ""; payForJob(); });
  $("#yf-note").addEventListener("input", () => { $("#yf-note").dataset.auto = ""; });
  function openPay(personId, jobId) {
    if (!isAdmin() || needPeople()) return;
    payJob = jobId || "";
    const bal = balances();
    personOptions($("#yf-person"), personId || ui.pPerson || state.people.slice().sort(byName).find((p) => (bal.get(p.id)?.owed || 0) > 0.004)?.id || state.people[0]?.id);
    $("#yf-date").value = isoDay(); $("#yf-note").value = ""; $("#yf-rec").checked = true;
    $("#yf-note").dataset.auto = "";
    showErr($("#yf-err"), ""); payInfo(); payJobs();
    openSheet("#d-pay");
  }
  $("#yf-person").addEventListener("change", () => { payInfo(); payJobs(); });
  $("#d-pay form").addEventListener("submit", (e) => {
    e.preventDefault();
    const err = $("#yf-err");
    const pid = $("#yf-person").value, amount = parseFloat($("#yf-amount").value) || 0, date = $("#yf-date").value;
    const recs = $("#yf-rec-wrap").hidden || !$("#yf-rec").checked ? [] : state.receipts.filter((r) => r.personId === pid && r.status !== "reimbursed");
    const recAmt = round2(recs.reduce((a, r) => a + (Number(r.amount) || 0), 0));
    if (!date) return showErr(err, "Scegli la data del pagamento.");
    if (amount < 0) return showErr(err, "L'importo non può essere negativo.");
    if (amount === 0 && !recs.length) return showErr(err, "Inserisci i compensi pagati, oppure spunta la casella delle ricevute.");
    attempt(e.currentTarget, err, async () => {
      await save("payments", { personId: pid, date, amount: round2(amount), method: $("#yf-method").value, note: $("#yf-note").value.trim(), receiptIds: recs.map((r) => r.id), receiptsAmount: recAmt, jobId: $("#yf-job").value || "" });
      for (const r of recs) await save("receipts", { ...r, status: "reimbursed", reimbursedAt: date });
      $("#d-pay").close(); toast(`Registrati ${money(amount + recAmt)} a ${personName(pid)}`);
    });
  });

  // Accounts
  let acctMode = null;
  function openAccount(mode, id) {
    acctMode = { mode, id };
    const a = accounts?.find((x) => x.id === id);
    const reset = mode === "reset";
    $("#af-title").textContent = reset ? `Nuova password per ${a?.name}` : "Aggiungi accesso";
    $("#af-name-wrap").hidden = $("#af-user-wrap").hidden = $("#af-role-wrap").hidden = reset;
    $("#af-pass-lbl").textContent = reset ? "Nuova password" : "Password";
    $("#af-btn").textContent = reset ? "Imposta password" : "Crea accesso";
    $("#af-name").value = ""; $("#af-user").value = ""; $("#af-role").value = "staff"; $("#af-company").value = ""; $("#af-company-wrap").hidden = true;
    $("#af-pass").value = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("") + "-" + [...crypto.getRandomValues(new Uint8Array(4))].map((b) => "23456789"[b % 8]).join("");
    showErr($("#af-err"), "");
    openSheet("#d-account");
  }
  $("#af-role").addEventListener("change", () => { $("#af-company-wrap").hidden = $("#af-role").value !== "client" || acctMode?.mode === "reset"; });
  $("#d-account form").addEventListener("submit", (e) => {
    e.preventDefault();
    const err = $("#af-err");
    attempt(e.currentTarget, err, async () => {
      if (acctMode.mode === "reset") await api("/api/users/" + acctMode.id, { body: { password: $("#af-pass").value } });
      else await api("/api/users", { body: { name: $("#af-name").value.trim(), username: $("#af-user").value.trim(), role: $("#af-role").value, company: $("#af-company").value.trim(), password: $("#af-pass").value } });
      $("#d-account").close(); toast(acctMode.mode === "reset" ? "Password cambiata" : "Accesso creato");
      loadAccounts();
    }).catch(() => {});
  });
  $("#d-password form").addEventListener("submit", (e) => {
    e.preventDefault();
    attempt(e.currentTarget, $("#cp-err"), async () => {
      await api("/api/password", { body: { current: $("#cp-cur").value, password: $("#cp-new").value } });
      $("#d-password").close(); toast("Password cambiata");
    });
  });

  // ---------- Statements ----------
  // A statement is a running account for one person over a period:
  // opening balance + work + receipts added − wages paid − receipts paid back = closing balance.
  // Over all time it equals the board's "owed" figure (earned − wages + receipts not yet reimbursed).
  const agencyName = () => String(state.settings.agencyName || "").trim() || "Lumia";
  const AGENCY_ADDRESS = "Piazza Duomo 20, Milano";
  const agencyAddress = () => (state.settings.agencyAddress ?? AGENCY_ADDRESS).trim();
  const byDateAsc = (a, b) => (a.date || "").localeCompare(b.date || "") || (a.createdAt || 0) - (b.createdAt || 0);
  function statementData(pid, from, to) {
    const inP = (d) => d >= from && d <= to, before = (d) => d < from;
    const person = state.people.find((p) => p.id === pid) || { name: personName(pid) };
    const shifts = state.shifts.filter((s) => s.personId === pid && countsForPay(s));
    const recs = state.receipts.filter((r) => r.personId === pid);
    const pays = state.payments.filter((p) => p.personId === pid);
    const paidBackOn = (r) => r.reimbursedAt || r.date || "";
    const back = recs.filter((r) => r.status === "reimbursed");
    let opening = 0;
    for (const s of shifts) if (before(s.date || "")) opening += shiftPay(s).amount;
    for (const r of recs) if (before(r.date || "")) opening += Number(r.amount) || 0;
    for (const p of pays) if (before(p.date || "")) opening -= Number(p.amount) || 0;
    for (const r of back) if (before(paidBackOn(r))) opening -= Number(r.amount) || 0;
    const work = shifts.filter((s) => inP(s.date || "")).sort(byDateAsc).map((s) => ({ s, pay: shiftPay(s), terms: shiftTerms(s) }));
    const added = recs.filter((r) => inP(r.date || "")).sort(byDateAsc);
    const out = pays.filter((p) => inP(p.date || "")).sort(byDateAsc).map((p) => ({ date: p.date, p, wages: Number(p.amount) || 0, recs: [] }));
    for (const r of back) {
      if (!inP(paidBackOn(r))) continue;
      const row = out.find((x) => (x.p?.receiptIds || []).includes(r.id));
      if (row) row.recs.push(r); else out.push({ date: paidBackOn(r), r, wages: 0, recs: [r] });
    }
    out.sort(byDateAsc);
    for (const o of out) o.back = o.recs.reduce((a, r) => a + (Number(r.amount) || 0), 0);
    const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
    const t = {
      hours: sum(work, (w) => Number(w.s.hours) || 0), reg: sum(work, (w) => w.pay.regularHours), ot: sum(work, (w) => w.pay.overtimeHours),
      earned: sum(work, (w) => w.pay.amount), recAdded: sum(added, (r) => Number(r.amount) || 0), wages: sum(out, (o) => o.wages), back: sum(out, (o) => o.back),
    };
    const closing = opening + t.earned + t.recAdded - t.wages - t.back;
    return { pid, person, from, to, opening, closing, work, added, out, t };
  }
  const lastDay = (m) => { const [y, mo] = m.split("-").map(Number); return `${m}-${pad(new Date(y, mo, 0).getDate())}`; };
  const monthName = (m) => new Date(m + "-01T12:00").toLocaleDateString(locale, { month: "long", year: "numeric" });
  const stUI = { mode: "month", month: isoMonth(), from: "", to: "" };
  function stPeriod() {
    if (stUI.mode === "month") { const m = stUI.month || isoMonth(); return { from: m + "-01", to: lastDay(m), key: m, label: monthName(m) }; }
    let from = stUI.from || isoMonth() + "-01", to = stUI.to || isoDay();
    if (from > to) [from, to] = [to, from];
    return { from, to, key: `${from}_${to}`, label: `${fmtDate(from)} – ${fmtDate(to)}` };
  }
  const sign = (n, s) => `<span class="stmt-sign">${s}</span>${money(n)}`;
  function stmtDoc(st, label) {
    const p = st.person, c = round2(st.closing), ag = esc(agencyName());
    const due = c > 0.004 ? ["owed", `Da pagare a ${esc((p.name || "").split(" ")[0] || "te")}`] : c < -0.004 ? ["over", "Pagato in eccesso"] : ["paid", "Saldato"];
    const n = st.work.length;
    const workRows = st.work.map((w) => `<tr><td>${fmtShort(w.s.date)}</td><td>${esc(w.s.job || "—")}${w.s.location ? `<span class="sub">${esc(w.s.location)}</span>` : ""}</td><td class="n">${hrs(w.s.hours)}${w.pay.overtimeHours ? `<span class="sub">${hrs(w.pay.overtimeHours)} straord.</span>` : ""}</td><td class="basis">${esc(payExplain(w.s.hours, w.terms, false))}</td><td class="n">${money(w.pay.amount)}</td></tr>`).join("");
    const recRows = st.added.map((r) => `<tr><td>${fmtShort(r.date)}</td><td>${esc(r.description || "Ricevuta")}</td><td>${r.status === "reimbursed" ? `Rimborsato${r.reimbursedAt ? " " + fmtShort(r.reimbursedAt) : ""}` : "Da rimborsare"}</td><td class="n">${money(r.amount)}</td></tr>`).join("");
    const outRows = st.out.map((o) => `<tr><td>${fmtShort(o.date)}</td><td>${o.p ? `${esc(methodLabel(o.p.method) || "Pagamento")}${o.p.note ? `<span class="sub">${esc(o.p.note)}</span>` : ""}` : `Ricevuta rimborsata<span class="sub">${esc(o.r.description || "Ricevuta")}</span>`}</td><td class="n">${o.wages ? money(o.wages) : "—"}</td><td class="n">${o.back ? money(o.back) : "—"}</td><td class="n">${money(o.wages + o.back)}</td></tr>`).join("");
    const none = (t) => `<p class="stmt-none">${t}</p>`;
    return `<article class="stmt">
      <header class="stmt-top">
        <div class="stmt-from"><b class="stmt-agency">${ag}</b>${agencyAddress() ? `<span class="stmt-addr">${esc(agencyAddress())}</span>` : ""}<span class="stmt-kind">Estratto conto</span></div>
        <dl class="stmt-meta"><div><dt>Periodo</dt><dd>${esc(label)}</dd></div><div><dt>Emesso il</dt><dd>${fmtDate(isoDay())}</dd></div></dl>
      </header>
      <div class="stmt-band">
        <div class="stmt-payee">
          <span class="stmt-k">Intestato a</span>
          <h2 class="stmt-name">${esc(p.name || "")}</h2>
          <p>${p.role ? roleLabel(p.role) : ""}${p.speciality ? " · " + esc(p.speciality) : ""}</p>
          ${p.id ? `<p class="stmt-terms">${esc(termsText(payTerms(p)))}</p>` : ""}
        </div>
        <div class="stmt-due ${due[0]}"><span class="stmt-k">${due[1]}</span><b>${money(c)}</b><span>Saldo al ${fmtDate(st.to)}</span></div>
      </div>
      <div class="stmt-recon">
        <div><span>Saldo iniziale<em>al ${fmtDate(st.from)}</em></span><b>${money(st.opening)}</b></div>
        <div><span>Lavoro<em>${n} ${n === 1 ? "turno" : "turni"} · ${hrs(st.t.hours)}${st.t.ot ? ` di cui ${hrs(st.t.ot)} di straordinario` : ""}</em></span><b>${sign(st.t.earned, "+")}</b></div>
        <div><span>Ricevute aggiunte<em>${st.added.length} ${st.added.length === 1 ? "ricevuta" : "ricevute"}</em></span><b>${sign(st.t.recAdded, "+")}</b></div>
        <div><span>Compensi pagati</span><b>${sign(st.t.wages, "−")}</b></div>
        <div><span>Ricevute rimborsate</span><b>${sign(st.t.back, "−")}</b></div>
        <div class="total"><span>Saldo finale<em>al ${fmtDate(st.to)}</em></span><b>${money(c)}</b></div>
      </div>
      <section class="stmt-sec"><h3>Lavoro</h3>${n ? `<div class="stmt-scroll"><table>
        <thead><tr><th>Data</th><th>Lavoro · posizione</th><th class="n">Ore</th><th>Base di calcolo</th><th class="n">Importo</th></tr></thead>
        <tbody>${workRows}</tbody>
        <tfoot><tr><td colspan="2">${n} ${n === 1 ? "turno" : "turni"}</td><td class="n">${hrs(st.t.hours)}</td><td></td><td class="n">${money(st.t.earned)}</td></tr></tfoot>
      </table></div>` : none("Nessuna ora registrata in questo periodo.")}</section>
      <section class="stmt-sec"><h3>Ricevute aggiunte</h3>${st.added.length ? `<div class="stmt-scroll"><table>
        <thead><tr><th>Data</th><th>Per</th><th>Stato</th><th class="n">Importo</th></tr></thead>
        <tbody>${recRows}</tbody>
        <tfoot><tr><td colspan="3">${st.added.length} ${st.added.length === 1 ? "ricevuta" : "ricevute"}</td><td class="n">${money(st.t.recAdded)}</td></tr></tfoot>
      </table></div>` : none("Nessuna ricevuta in questo periodo.")}</section>
      <section class="stmt-sec"><h3>Pagamenti</h3>${st.out.length ? `<div class="stmt-scroll"><table>
        <thead><tr><th>Data</th><th>Metodo · nota</th><th class="n">Compensi</th><th class="n">Ricevute</th><th class="n">Totale</th></tr></thead>
        <tbody>${outRows}</tbody>
        <tfoot><tr><td colspan="2">${st.out.length} ${st.out.length === 1 ? "pagamento" : "pagamenti"}</td><td class="n">${money(st.t.wages)}</td><td class="n">${money(st.t.back)}</td><td class="n">${money(st.t.wages + st.t.back)}</td></tr></tfoot>
      </table></div>` : none("Nessun pagamento in questo periodo.")}</section>
      <footer class="stmt-foot"><span>Importi in ${esc(state.settings.currency || "EUR")}. Un saldo positivo è dovuto da ${ag} a ${esc(p.name || "il beneficiario")}; un saldo negativo indica un pagamento in eccesso.</span></footer>
    </article>`;
  }
  // The statement's own CSS rules, lifted from this page's stylesheet, so the downloaded file looks the same.
  function docCss() {
    const out = [];
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch { continue; }
      for (const r of rules) {
        if (r.selectorText === ":root" || (r.selectorText && r.selectorText.includes(".stmt"))) out.push(r.cssText);
        else if (r.conditionText !== undefined && r.cssText.includes(".stmt") && !/prefers-color-scheme/.test(r.conditionText)) out.push(r.cssText);
      }
    }
    return out.join("\n");
  }
  function statementFile(st, label) {
    const title = `${agencyName()} · Estratto conto · ${st.person.name || ""} · ${label}`;
    return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:#E8E8E4;color:#121316;font-family:"Instrument Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact}
main{padding:32px 16px}
${docCss()}
:root{color-scheme:light}
.stmt{max-width:820px;margin:0 auto}
@media print{body{background:#fff}main{padding:0}}
</style></head>
<body><main>${stmtDoc(st, label)}</main></body></html>`;
  }
  function statementCsv(st, label) {
    const name = st.person.name || "";
    const rows = [["Estratto conto", agencyName(), agencyAddress()], ["Intestato a", name], ["Periodo", label, st.from, st.to], ["Condizioni di pagamento", st.person.id ? termsText(payTerms(st.person)) : ""], ["Emesso il", isoDay()], [],
      ["Data", "Voce", "Dettagli", "Ore", "Ore ordinarie", "Ore di straordinario", "Base di calcolo", "Entrate", "Uscite", "Saldo"]];
    let bal = st.opening;
    rows.push([st.from, "Saldo iniziale", "", "", "", "", "", "", "", round2(bal)]);
    const lines = [
      ...st.work.map((w) => ({ date: w.s.date, o: 0, row: ["Lavoro", [w.s.job, w.s.location].filter(Boolean).join(" · "), w.s.hours, round2(w.pay.regularHours), round2(w.pay.overtimeHours), payExplain(w.s.hours, w.terms, false)], inn: w.pay.amount, out: 0 })),
      ...st.added.map((r) => ({ date: r.date, o: 1, row: ["Ricevuta", r.description || "", "", "", "", ""], inn: Number(r.amount) || 0, out: 0 })),
      ...st.out.map((x) => ({ date: x.date, o: 2, row: [x.p ? "Pagamento" : "Ricevuta rimborsata", x.p ? [methodLabel(x.p.method), x.p.note, x.back ? `incl. ${x.recs.length} ${x.recs.length === 1 ? "ricevuta" : "ricevute"}` : ""].filter(Boolean).join(" · ") : x.r.description || "", "", "", "", ""], inn: 0, out: x.wages + x.back })),
    ].sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.o - b.o);
    for (const l of lines) { bal += l.inn - l.out; rows.push([l.date, ...l.row, l.inn ? round2(l.inn) : "", l.out ? round2(l.out) : "", round2(bal)]); }
    rows.push([st.to, "Saldo finale", "", round2(st.t.hours), round2(st.t.reg), round2(st.t.ot), "", round2(st.t.earned + st.t.recAdded), round2(st.t.wages + st.t.back), round2(st.closing)]);
    rows.push([], ["Guadagnato", round2(st.t.earned)], ["Ricevute aggiunte", round2(st.t.recAdded)], ["Compensi pagati", round2(st.t.wages)], ["Ricevute rimborsate", round2(st.t.back)]);
    return rows;
  }
  // One row per person for a period: what an accountant needs for the month.
  function periodSummaryCsv(per) {
    const rows = [["Persona", "Ruolo", "Condizioni di pagamento", "Turni", "Ore", "Ore ordinarie", "Ore di straordinario", "Guadagnato", "Ricevute aggiunte", "Compensi pagati", "Ricevute rimborsate", "Totale pagato", "Saldo iniziale", "Saldo finale"]];
    const tot = Array(10).fill(0);
    for (const p of state.people.slice().sort(byName)) {
      const st = statementData(p.id, per.from, per.to);
      const nums = [st.work.length, st.t.hours, st.t.reg, st.t.ot, st.t.earned, st.t.recAdded, st.t.wages, st.t.back, st.t.wages + st.t.back, st.closing];
      nums.forEach((v, i) => (tot[i] += v));
      rows.push([p.name, roleLabel(p.role), termsText(payTerms(p)), ...nums.slice(0, 4).map(round2), ...nums.slice(4, 9).map(round2), round2(st.opening), round2(st.closing)]);
    }
    rows.push(["Totale", "", "", ...tot.slice(0, 4).map(round2), ...tot.slice(4, 9).map(round2), "", round2(tot[9])]);
    return rows;
  }
  const slug = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "persona";
  function saveFile(name, text, type) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  let stCur = null;
  function renderStatement() {
    const sel = $("#st-person");
    if (!state.people.some((p) => p.id === sel.value)) { personOptions(sel, sel.value); if (!sel.value) { $("#d-statement").close(); return; } }
    const per = stPeriod();
    $$("#st-mode button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === stUI.mode)));
    $("#st-month").hidden = stUI.mode !== "month";
    $("#st-range").hidden = stUI.mode === "month";
    const st = statementData(sel.value, per.from, per.to);
    stCur = { st, per };
    $("#st-doc").innerHTML = stmtDoc(st, per.label);
    $("#print-root").innerHTML = $("#st-doc").innerHTML;
  }
  function openStatement(pid) {
    if (needPeople()) return;
    personOptions($("#st-person"), pid || $("#st-person").value || ui.pPerson || state.people.slice().sort(byName)[0]?.id);
    fillMonths($("#st-month"), stUI.month);
    if (!stUI.from) { stUI.from = isoMonth() + "-01"; stUI.to = isoDay(); }
    $("#st-from").value = stUI.from; $("#st-to").value = stUI.to;
    renderStatement();
    openSheet("#d-statement");
    $("#d-statement .sheet-body").scrollTop = 0;
  }
  $("#st-person").addEventListener("change", renderStatement);
  $("#st-mode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; stUI.mode = b.dataset.mode; renderStatement(); });
  $("#st-month").addEventListener("change", (e) => { if (e.target.value) { stUI.month = e.target.value; renderStatement(); } });
  $("#st-from").addEventListener("change", (e) => { stUI.from = e.target.value; renderStatement(); });
  $("#st-to").addEventListener("change", (e) => { stUI.to = e.target.value; renderStatement(); });
  $("#st-print").addEventListener("click", () => { renderStatement(); window.print(); });
  $("#st-html").addEventListener("click", () => {
    const { st, per } = stCur;
    saveFile(`estratto-conto-${slug(st.person.name)}-${per.key}.html`, statementFile(st, per.label), "text/html");
  });
  $("#st-csv").addEventListener("click", () => {
    const { st, per } = stCur;
    download(`estratto-conto-${slug(st.person.name)}-${per.key}.csv`, statementCsv(st, per.label));
  });
  $("#st-all").addEventListener("click", () => { const per = stPeriod(); download(`riepilogo-${per.key}.csv`, periodSummaryCsv(per)); });

  // ---------- Global clicks ----------
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]"); if (!t || t.disabled) return;
    const id = t.dataset.id, act = t.dataset.act;
    if (t.closest("#d-quick")) $("#d-quick").close();
    switch (act) {
      case "add-person": return openPerson();
      case "edit-person": return openPerson(id);
      case "loc": return openLoc(id);
      case "add-shift": return openShift(id || (staffMe() ? myPerson().id : undefined));
      case "edit-shift": return openShift(null, id);
      case "add-receipt": return openReceipt(id || (staffMe() ? myPerson().id : undefined));
      case "q-approve": return approve([id]);
      case "q-approve-sel": return approve([...ui.qSel]);
      case "q-reject": return openReject([id]);
      case "q-reject-sel": return openReject([...ui.qSel]);
      case "place-del": return armed(t, "Rimuovere?", () => { const pl = state.places.find((x) => x.id === id); if (pl) remove("places", pl).then(() => toast("Luogo rimosso")); });
      case "act-more": return loadActivity(true);
      case "my-hours": ui.hPerson = id; ui.hMonth = ""; location.hash = "hours"; return;
      case "my-receipts": ui.rPerson = id; ui.rStatus = "all"; $$("#rec-seg button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.rs === "all"))); location.hash = "receipts"; return;
      case "view-receipt": return openView(id);
      case "add-payment": return openPay(id);
      case "goto-hours": location.hash = "hours"; return;
      case "detail": detailId = id; renderDetail(id); return openSheet("#d-detail");
      case "statement": return openStatement(id);
      case "password": $("#cp-cur").value = ""; $("#cp-new").value = ""; showErr($("#cp-err"), ""); return openSheet("#d-password");
      case "sync-now": sync.error = null; sync.online = true; return runSync().then(() => renderSettings());
      case "add-account": return openAccount("create");
      case "reset-pw": return openAccount("reset", id);
      case "confirm-client": { const a = accounts.find((x) => x.id === id); return api("/api/users/" + id, { body: { clientName: a.company } }).then(() => { toast(`${a.name} vede i lavori di ${a.company}`); return loadAccounts(); }).catch((err) => toast(err.msg || "Connettiti a internet per modificare gli accessi.")); }
      case "approve-signup": {
        const a = accounts.find((x) => x.id === id); if (!a) return;
        t.disabled = true;
        return (async () => {
          const same = state.people.find((p) => p.name.trim().toLowerCase() === a.name.trim().toLowerCase() && !accounts.some((x) => x.personId === p.id));
          const person = same || await save("people", { name: a.name, role: a.wants === "technician" ? "technician" : "model", phone: a.phone || "", payType: "hourly", rate: 0 });
          // The person has to reach the server before the login can be linked to them.
          for (let i = 0; ; i++) {
            await runSync();
            try { await api("/api/users/" + id, { body: { pending: false, personId: person.id } }); break; }
            catch (err) { if (i >= 6 || err.status !== 400) throw err; await new Promise((r) => setTimeout(r, 700)); }
          }
          toast(`${a.name} approvato/a${same ? "" : ": imposta la tariffa in Persone"}`);
          loadAccounts();
        })().catch((err) => { toast(err.msg || "Connettiti a internet per approvare."); loadAccounts(); });
      }
      case "toggle-role": case "toggle-disabled": {
        const a = accounts.find((x) => x.id === id);
        const body = act === "toggle-role" ? { role: a.role === "admin" ? "staff" : "admin" } : { disabled: !a.disabled };
        return api("/api/users/" + id, { body }).then(loadAccounts).catch((err) => toast(err.msg || "Connettiti a internet per modificare gli accessi."));
      }
      case "del-payment": return armed(t, "Conferma", async () => {
        const p = state.payments.find((x) => x.id === id);
        for (const rid of p?.receiptIds || []) { const r = state.receipts.find((x) => x.id === rid); if (r) await save("receipts", { ...r, status: "pending", reimbursedAt: null }); }
        await remove("payments", p); toast("Pagamento eliminato. Le sue ricevute sono di nuovo da rimborsare.");
      });
    }
  });
  $("#fab").addEventListener("click", openQuick);
  $("#sync").addEventListener("click", () => { if (sync.authLost) return showAuth("login", true); sync.error = null; sync.online = true; runSync(); });
  $("#d-detail").addEventListener("close", () => (detailId = null));
  for (const d of ["#d-shift", "#d-receipt", "#d-pay", "#d-view", "#d-loc"]) $(d).addEventListener("close", () => detailId && renderDetail(detailId));

  $("#role-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    ui.role = b.dataset.role; $$("#role-seg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); render();
  });
  $("#rec-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    ui.rStatus = b.dataset.rs; $$("#rec-seg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); render();
  });
  $("#q").addEventListener("input", (e) => { ui.q = e.target.value; render(); });
  $("#h-person").addEventListener("change", (e) => { ui.hPerson = e.target.value; render(); });
  $("#h-month").addEventListener("change", (e) => { ui.hMonth = e.target.value; render(); });

  $("#r-person").addEventListener("change", (e) => { ui.rPerson = e.target.value; render(); });
  $("#p-person").addEventListener("change", (e) => { ui.pPerson = e.target.value; render(); });

  // Broken image (photo not cached offline yet) -> calm placeholder.
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img.tagName !== "IMG" || img.dataset.failed) return;
    img.dataset.failed = "1";
    const ph = document.createElement("span"); ph.className = "ph"; ph.innerHTML = ICON.cam + "<span>La foto compare quando sei online</span>";
    img.replaceWith(ph);
  }, true);

  // ---------- My page ----------
  // Linked staff see "My page" in place of the Team tab; the board stays one tap away.
  const NAV_SVG = { team: $("#nav-team svg").innerHTML, me: `<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.7-3.6 3.4-5.6 7-5.6s6.3 2 7 5.6"/>` };
  function paintNav() {
    const a = $("#nav-team"), on = staffMe();
    if (a.dataset.me === String(on)) return;
    a.dataset.me = String(on);
    a.setAttribute("href", on ? "#me" : "#team");
    const lbl = a.querySelector("span"); lbl.textContent = on ? "La mia pagina" : "Persone"; if (on) lbl.dataset.short = "Profilo"; else delete lbl.dataset.short;
    a.style.order = on ? "-1" : ""; // staff: their own page comes first
    a.querySelector("svg").innerHTML = on ? NAV_SVG.me : NAV_SVG.team;
  }
  function paintMe() {
    $("#me-chip").innerHTML = `<div><b>${esc(me.name)}</b>${isAdmin() ? "Amministratore" : "Collaboratore"}</div>`;
    render();
  }

  function renderMe(bal) {
    const el = $("#mypage"), p = myPerson();
    if (!p) {
      el.innerHTML = `<div class="view-head"><div><h1>La mia pagina</h1><p>Le tue ore, le ricevute e quanto ti è dovuto, in un unico posto.</p></div></div>` +
        empty("Il tuo accesso non è ancora collegato alla squadra", isAdmin() ? "Collega il tuo accesso al tuo nome in Impostazioni → Accessi della squadra." : "Chiedi a un amministratore di collegare il tuo accesso al tuo nome nella squadra. Poi qui vedrai le tue ore e il tuo saldo.");
      return;
    }
    const b = bal.get(p.id), m = isoMonth();
    const desc = (a, c) => (c.date || "").localeCompare(a.date || "") || (c.createdAt || 0) - (a.createdAt || 0);
    const shifts = state.shifts.filter((s) => s.personId === p.id).sort(desc);
    const recs = state.receipts.filter((r) => r.personId === p.id).sort(desc);
    const pays = state.payments.filter((x) => x.personId === p.id).sort(desc);
    const waitMonth = shifts.filter((s) => approvalOf(s) === "pending" && (s.date || "").startsWith(m)).reduce((a, s) => a + (Number(s.hours) || 0), 0);
    const rejected = shifts.filter((s) => approvalOf(s) === "rejected");
    const live = p.location && p.locationAt && Date.now() - p.locationAt < 12 * 3600e3;
    const shiftRow = (s) => {
      const inner = `<span class="r-main"><span class="r-title">${fmtShort(s.date)}${s.start && s.end ? ` <span class="muted mono">${esc(s.start)}–${esc(s.end)}</span>` : ""}</span>
        <span class="r-sub">${[esc(s.job || ""), esc(s.location || "")].filter(Boolean).join(" · ") || "Nessun lavoro indicato"}</span></span>
        <span class="r-end"><span class="mono">${hrs(s.hours)}</span>${approvalPill(s) || unsyncedTag("shifts", s.id)}</span>`;
      return mine(s) ? `<li><button class="r" type="button" data-act="edit-shift" data-id="${s.id}">${inner}</button></li>` : `<li><div class="r">${inner}</div></li>`;
    };
    const recRow = (r) => `<li><button class="r" type="button" data-act="view-receipt" data-id="${r.id}">
        <span class="r-main"><span class="r-title">${esc(r.description || "Ricevuta")}</span>
        <span class="r-sub"><span class="cat c-${catOf(r)}">${esc(catLabel(catOf(r)))}</span> ${fmtShort(r.date)} ${unsyncedTag("receipts", r.id)}</span></span>
        <span class="r-end"><span class="mono">${money(r.amount)}</span>${r.status === "reimbursed" ? `<span class="pill paid">Rimborsato</span>` : `<span class="pill owed">Da rimborsare</span>`}</span></button></li>`;
    el.innerHTML = `
      <div class="me-head">
        <div class="me-id">
          <span class="eyebrow">La mia pagina</span>
          <h1 class="me-name">${esc(p.name)}</h1>
          <div class="comp-role"><span class="tag ${p.role === "technician" ? "technician" : "model"}">${roleLabel(p.role)}</span>${p.speciality ? `<span>${esc(p.speciality)}</span>` : ""}<span class="mono">${money(p.rate)} / h</span></div>
        </div>
        <div class="view-actions"><a class="btn" href="#calendar">${CAL}Calendario</a><a class="btn" href="#team">${ICON.pin}Persone</a></div>
      </div>
      <div class="summary me-sum">
        <div><span class="eyebrow">Ti è dovuto</span><span class="big ${b.owed > 0.004 ? "" : "zero"}">${money(b.owed)}</span>
          <span class="note">${b.owed > 0.004 ? `Compensi ${money(Math.max(0, b.wageDue))} · ricevute ${money(b.rec)}` : b.owed < -0.004 ? "Pagato in anticipo sulle ore lavorate" : "Sei in regola"}</span></div>
        <div><span class="eyebrow">Pagato a te</span><span class="mid">${money(b.paid)}</span><span class="note">compensi finora</span></div>
        <div><span class="eyebrow">Ricevute</span><span class="mid">${money(b.rec)}</span><span class="note">${b.recN} da rimborsare</span></div>
        <div><span class="eyebrow">Questo mese</span><span class="mid">${hrs(b.hMonth)}</span><span class="note">${waitMonth ? `+ ${hrs(waitMonth)} in attesa di approvazione` : "approvate"}</span></div>
      </div>
      ${rejected.length ? `<div class="me-alert">${rejected.map((s) => `<div><span><b>${hrs(s.hours)} del ${fmtShort(s.date)}: rifiutate.</b>${s.approvalNote ? ` “${esc(s.approvalNote)}”` : ""} Correggi e salva per inviarle di nuovo.</span>${mine(s) ? `<button class="btn sm" type="button" data-act="edit-shift" data-id="${s.id}">Correggi</button>` : ""}</div>`).join("")}</div>` : ""}
      <div class="me-quick">
        <button type="button" data-act="add-shift" data-id="${p.id}">${ICON.clock}<span><b>Registra le mie ore</b><small>Convocazione, fine e lavoro</small></span></button>
        <button type="button" data-act="add-receipt" data-id="${p.id}">${ICON.cam}<span><b>Aggiungi ricevuta</b><small>Fotografa una spesa</small></span></button>
        <button type="button" data-act="loc" data-id="${p.id}" class="${live ? "live" : ""}">${ICON.pin}<span><b>Posizione</b><small>${p.location ? `${esc(p.location)} · ${ago(p.locationAt)}` : "Di' dove sei"}</small></span></button>
      </div>
      <div class="me-cols">
        <section class="panel me-list">
          <div class="me-list-head"><h2>Ore recenti</h2><button class="btn quiet sm" type="button" data-act="my-hours" data-id="${p.id}">Tutte le mie ore</button></div>
          ${shifts.length ? `<ul class="rows">${shifts.slice(0, 8).map(shiftRow).join("")}</ul>` : `<p>Ancora nessuna ora. Registra convocazione e fine, o solo le ore.</p>`}
          ${b.nPend ? `<p class="me-foot"><span class="pill wait">${b.nPend} in attesa</span> Le ore contano in quanto ti è dovuto una volta approvate da un amministratore.</p>` : ""}
        </section>
        <section class="panel me-list">
          <div class="me-list-head"><h2>Ricevute recenti</h2><button class="btn quiet sm" type="button" data-act="my-receipts" data-id="${p.id}">Tutte le mie ricevute</button></div>
          ${recs.length ? `<ul class="rows">${recs.slice(0, 6).map(recRow).join("")}</ul>` : `<p>Nessuna ricevuta. Fotografane una quando paghi qualcosa per un lavoro.</p>`}
        </section>
        <section class="panel me-list">
          <div class="me-list-head"><h2>Pagamenti ricevuti</h2><button class="btn quiet sm" type="button" data-act="statement" data-id="${p.id}">Estratto conto</button></div>
          ${pays.length ? `<ul class="rows">${pays.slice(0, 6).map((x) => `<li><div class="r"><span class="r-main"><span class="r-title">${fmtShort(x.date)}</span><span class="r-sub">${esc(methodLabel(x.method))}${x.note ? ` · ${esc(x.note)}` : ""}</span></span><span class="r-end"><span class="mono">${money((Number(x.amount) || 0) + (Number(x.receiptsAmount) || 0))}</span></span></div></li>`).join("")}</ul>` : `<p>Ancora nessun pagamento.</p>`}
        </section>
      </div>`;
  }

  // ---------- Approval queue (admins) ----------
  function renderQueue() {
    const el = $("#queue");
    if (!isAdmin()) { el.innerHTML = ""; return; }
    const list = pendingShifts();
    for (const id of [...ui.qSel]) if (!list.some((s) => s.id === id)) ui.qSel.delete(id);
    if (!list.length) { el.innerHTML = ""; return; }
    const n = ui.qSel.size, total = list.reduce((a, s) => a + (Number(s.hours) || 0), 0);
    el.innerHTML = `<section class="queue" aria-label="In attesa di approvazione">
      <div class="queue-head">
        <div><h2>In attesa di approvazione</h2><p>${list.length === 1 ? "1 voce" : `${list.length} voci`} · <span class="mono">${hrs(total)}</span>. Le ore contano nel dovuto una volta approvate.</p></div>
        <div class="queue-acts">
          <label class="pick-all"><input type="checkbox" id="q-all" ${n === list.length ? "checked" : ""}>Seleziona tutto</label>
          <button class="btn sm danger" type="button" data-act="q-reject-sel" ${n ? "" : "disabled"}>Rifiuta${n ? ` ${n}` : ""}</button>
          <button class="btn sm primary" type="button" data-act="q-approve-sel" ${n ? "" : "disabled"}>Approva${n ? ` ${n}` : ""}</button>
        </div>
      </div>
      <ul class="q-list">${list.map((s) => {
        const by = accountName(s.by);
        return `<li class="q-row${ui.qSel.has(s.id) ? " sel" : ""}">
          <input type="checkbox" class="q-pick" data-id="${s.id}" aria-label="Seleziona ${esc(personName(s.personId))}, ${esc(fmtShort(s.date))}" ${ui.qSel.has(s.id) ? "checked" : ""}>
          <div class="q-main">
            <div class="q-top"><b>${esc(personName(s.personId))}</b><span class="mono">${hrs(s.hours)}</span></div>
            <div class="q-sub">${[fmtShort(s.date), s.start && s.end ? `${esc(s.start)}–${esc(s.end)}` : "", esc(s.job || ""), esc(s.location || "")].filter(Boolean).join(" · ")}</div>
            <div class="q-by">${by ? `Registrate da ${esc(by)}` : "Registrate dai collaboratori"} · ${ago(s.updatedAt || s.createdAt)} ${unsyncedTag("shifts", s.id)}</div>
          </div>
          <div class="q-acts">
            <button class="btn sm quiet" type="button" data-act="edit-shift" data-id="${s.id}">Modifica</button>
            <button class="btn sm danger" type="button" data-act="q-reject" data-id="${s.id}">Rifiuta</button>
            <button class="btn sm ok" type="button" data-act="q-approve" data-id="${s.id}">Approva</button>
          </div>
        </li>`;
      }).join("")}</ul>
    </section>`;
  }
  $("#queue").addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "q-all") { ui.qSel = new Set(t.checked ? pendingShifts().map((s) => s.id) : []); }
    else if (t.classList.contains("q-pick")) { t.checked ? ui.qSel.add(t.dataset.id) : ui.qSel.delete(t.dataset.id); }
    else return;
    renderQueue();
  });
  async function approve(ids) {
    const list = ids.map((id) => state.shifts.find((s) => s.id === id)).filter(Boolean);
    if (!list.length) return;
    await saveMany("shifts", list.map((s) => ({ ...s, approval: "approved", approvalNote: "", approvedBy: me.id, approvedAt: Date.now() })));
    ids.forEach((id) => ui.qSel.delete(id)); renderQueue();
    toast(list.length === 1 ? `${hrs(list[0].hours)} approvate per ${personName(list[0].personId)}` : `${list.length} voci approvate`);
  }
  let rejectIds = [];
  function openReject(ids) {
    rejectIds = ids.filter((id) => state.shifts.some((s) => s.id === id));
    if (!rejectIds.length) return;
    const one = rejectIds.length === 1 ? state.shifts.find((s) => s.id === rejectIds[0]) : null;
    $("#rj-title").textContent = one ? `Rifiuta ${hrs(one.hours)} per ${personName(one.personId)}` : `Rifiuta ${rejectIds.length} voci`;
    $("#rj-what").textContent = one ? [fmtDate(one.date), one.job, one.location].filter(Boolean).join(" · ") : "Restano nell'elenco delle ore, segnate come rifiutate, e non contano nel dovuto.";
    $("#rj-btn").textContent = one ? "Rifiuta" : `Rifiuta ${rejectIds.length}`;
    $("#rj-note").value = ""; showErr($("#rj-err"), "");
    openSheet("#d-reject"); $("#rj-note").focus();
  }
  $("#d-reject form").addEventListener("submit", (e) => {
    e.preventDefault();
    attempt(e.currentTarget, $("#rj-err"), async () => {
      const note = $("#rj-note").value.trim().slice(0, 300);
      const list = rejectIds.map((id) => state.shifts.find((s) => s.id === id)).filter(Boolean);
      await saveMany("shifts", list.map((s) => ({ ...s, approval: "rejected", approvalNote: note, approvedBy: me.id, approvedAt: Date.now() })));
      rejectIds.forEach((id) => ui.qSel.delete(id));
      $("#d-reject").close(); renderQueue();
      toast(list.length === 1 ? "Rifiutato. Vedrà la tua nota." : `${list.length} voci rifiutate`);
    });
  });

  // ---------- Saved places ----------
  function placeChip(name, current) {
    return `<button type="button" class="chip" data-place="${esc(name)}" aria-pressed="${current ? "true" : "false"}">${ICON.pin}<span>${esc(name)}</span></button>`;
  }
  // Saved places first, then up to five other places used recently (check-ins and logged hours).
  function paintPlaces() {
    const cur = ($("#lf-loc").value || "").trim().toLowerCase();
    const saved = state.places.slice().sort(byName).map((p) => p.name).filter(Boolean);
    const seen = new Set(saved.map((x) => x.trim().toLowerCase()));
    const used = [...state.people.filter((p) => p.location).map((p) => [p.locationAt || 0, p.location]),
      ...state.shifts.filter((s) => s.location).map((s) => [s.updatedAt || s.createdAt || 0, s.location])].sort((a, b) => b[0] - a[0]);
    const recent = [];
    for (const [, loc] of used) { const k = loc.trim().toLowerCase(); if (!k || seen.has(k)) continue; seen.add(k); recent.push(loc.trim()); if (recent.length >= 5) break; }
    const box = $("#lf-places");
    box.hidden = !saved.length && !recent.length;
    box.innerHTML = (saved.length ? `<div class="places-group"><span class="eyebrow">Luoghi salvati</span><div class="chips">${saved.map((n) => placeChip(n, n.trim().toLowerCase() === cur)).join("")}</div></div>` : "")
      + (recent.length ? `<div class="places-group"><span class="eyebrow">Usati di recente</span><div class="chips">${recent.map((n) => placeChip(n, n.toLowerCase() === cur)).join("")}</div></div>` : "");
  }
  // One tap checks in.
  $("#lf-places").addEventListener("click", (e) => {
    const c = e.target.closest("[data-place]"); if (!c) return;
    $("#lf-loc").value = c.dataset.place;
    $("#d-loc form").requestSubmit();
  });
  function placesPanel() {
    const list = state.places.slice().sort(byName);
    return `<section class="panel">
      <h2>Luoghi salvati</h2>
      <p>Studi e luoghi dove la squadra va spesso. Compaiono come pulsanti rapidi quando qualcuno segnala la propria posizione.</p>
      ${list.length ? `<div class="chips">${list.map((pl) => `<span class="chip static">${ICON.pin}<span>${esc(pl.name)}</span><button type="button" class="chip-x" data-act="place-del" data-id="${pl.id}" aria-label="Rimuovi ${esc(pl.name)}">Rimuovi</button></span>`).join("")}</div>` : ""}
      <form class="inline-add" id="place-form" novalidate>
        <input class="input" id="place-name" maxlength="120" autocomplete="off" placeholder="Piazza Duomo 20, Milano" aria-label="Nuovo luogo" value="${esc(ui.placeDraft || "")}">
        <button class="btn" type="submit">Aggiungi luogo</button>
      </form>
    </section>`;
  }

  // ---------- Activity (admins; the server keeps it, nobody can edit it) ----------
  const act = { entries: [], next: null, loading: false, err: null, loaded: false };
  function activityShell() {
    const people = state.people.slice().sort(byName);
    return `<div class="view-head"><div><h2>Attività</h2><p>Chi ha fatto cosa, dalle più recenti. Il server registra ogni modifica; nessuno può modificare questo elenco.</p></div>
      <div class="view-actions act-filters">
        <select id="act-person" aria-label="Riguardo a">${`<option value="">Riguardo a chiunque</option>` + people.map((p) => `<option value="${p.id}" ${ui.actPerson === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
        <select id="act-user" aria-label="Fatto da">${`<option value="">Fatto da chiunque</option>` + (accounts || []).map((a) => `<option value="${a.id}" ${ui.actUser === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select>
      </div></div>
      <div id="act-list"></div>`;
  }
  async function loadActivity(more) {
    if (act.loading) return;
    act.loading = true; paintActivity();
    try {
      const qs = new URLSearchParams({ limit: "40" });
      if (ui.actPerson) qs.set("person", ui.actPerson);
      if (ui.actUser) qs.set("user", ui.actUser);
      if (more && act.next) qs.set("before", act.next);
      const r = await api("/api/audit?" + qs, { method: "GET" });
      act.entries = more ? [...act.entries, ...r.entries] : r.entries; act.next = r.next; act.err = null;
    } catch (e) { act.err = e.status ? e.msg : "Connettiti a internet per vedere l'attività."; }
    act.loading = false; act.loaded = true; paintActivity();
  }
  function actPerson(e) {
    const name = state.people.find((p) => p.id === e.personId)?.name || e.personName;
    return name ? `<b>${esc(name)}</b>` : "qualcuno";
  }
  function actText(e) {
    // "Sara ha registrato 8,5 h per sé" rather than repeating her name.
    const own = /^(shift|receipt)\.|^person\.checkin$/.test(e.verb);
    const self = own && !!e.personId && accounts?.find((a) => a.id === e.userId)?.personId === e.personId;
    const i = e.info || {}, X = actPerson(e), P = self ? "sé" : X, Di = self ? "" : ` di ${X}`, T = `<b>${esc(i.target || "qualcuno")}</b>`;
    const H = `<span class="mono">${hrs(i.hours)}</span>`, M = `<span class="mono">${money(i.amount)}</span>`;
    const on = i.date ? ` · ${fmtShort(i.date)}` : "";
    const t = {
      "shift.add": `ha registrato ${H} per ${P}${on}${i.pending ? ` <span class="pill wait">In attesa</span>` : ""}`,
      "shift.edit": `ha modificato ${self ? "le proprie ore" : `le ore di ${X}`} in ${H}${on}${i.reopened ? ` <span class="pill wait">Di nuovo in attesa</span>` : ""}`,
      "shift.delete": `ha eliminato ${H} per ${P}${on}`,
      "shift.approve": `ha approvato ${H} per ${P}${on}`,
      "shift.reject": `ha rifiutato ${H} per ${P}${on}${i.note ? ` <span class="muted">“${esc(i.note)}”</span>` : ""}`,
      "receipt.add": `ha aggiunto una ricevuta da ${M}${i.category ? ` (${esc(catLabel(i.category).toLowerCase())})` : ""} per ${P}`,
      "receipt.edit": `ha modificato una ricevuta da ${M} per ${P}`,
      "receipt.delete": `ha eliminato una ricevuta da ${M} per ${P}`,
      "receipt.reimburse": `ha segnato come rimborsata ${self ? "la propria ricevuta" : "la ricevuta"} da ${M}${Di}`,
      "receipt.unreimburse": `ha rimesso da rimborsare ${self ? "la propria ricevuta" : "la ricevuta"} da ${M}${Di}`,
      "payment.add": `ha registrato un pagamento di ${M} a ${P}`,
      "payment.edit": `ha modificato un pagamento di ${M} a ${P}`,
      "payment.delete": `ha eliminato un pagamento di ${M} a ${P}`,
      "person.add": `ha aggiunto ${P} alla squadra`,
      "person.edit": `ha aggiornato i dati di ${P}`,
      "person.rate": `ha impostato la tariffa di ${P} a <span class="mono">${money(i.rate)}</span> / h`,
      "person.checkin": i.location ? (self ? `ha segnalato la propria posizione: ${esc(i.location)}` : `ha segnalato ${X} a ${esc(i.location)}`) : `ha cancellato ${self ? "la propria posizione" : `la posizione di ${X}`}`,
      "person.delete": `ha rimosso ${P} dalla squadra`,
      "settings.edit": `ha impostato la valuta su ${esc(i.currency || "")}`,
      "job.clientpaid": `ha segnato che il cliente ha pagato ${esc(i.title || "un lavoro")}`,
      "job.crewpaid": `ha segnato ${P} come pagato/a per ${esc(i.title || "un lavoro")}`,
      "job.archive": `ha archiviato ${esc(i.title || "un lavoro")}: cliente e squadra pagati`,
      "job.unarchive": `ha ripristinato ${esc(i.title || "un lavoro")} dall'archivio`,
      "place.add": `ha salvato il luogo ${esc(i.name || "")}`,
      "place.edit": `ha rinominato un luogo salvato in ${esc(i.name || "")}`,
      "place.delete": `ha rimosso il luogo salvato ${esc(i.name || "")}`,
      "account.signup": `si è registrato/a come ${i.role === "client" ? `cliente${i.company ? " (" + esc(i.company) + ")" : ""}` : "collaboratore"}`,
      "account.approve": `ha approvato l'iscrizione di ${T}`,
      "account.client": i.client ? `ha collegato ${T} al cliente ${esc(i.client)}` : `ha scollegato ${T} dal cliente`,
      "request.add": `ha chiesto persone per ${esc(i.title || "")}${i.client ? " (" + esc(i.client) + ")" : ""}`,
      "request.cancel": `ha annullato la richiesta ${esc(i.title || "")}`,
      "request.accept": `ha accettato la richiesta ${esc(i.title || "")}${i.client ? " di " + esc(i.client) : ""}`,
      "request.decline": `ha rifiutato la richiesta ${esc(i.title || "")}${i.client ? " di " + esc(i.client) : ""}`,
      "account.add": `ha creato un accesso ${i.role === "admin" ? "amministratore" : "collaboratore"} per ${T}`,
      "account.link": `ha collegato l'accesso di ${T} a ${P}`,
      "account.unlink": `ha scollegato l'accesso di ${T} da ${P}`,
      "account.role": `ha reso ${T} ${i.role === "admin" ? "amministratore" : "collaboratore"}`,
      "account.disable": `ha disattivato l'accesso di ${T}`,
      "account.enable": `ha riattivato l'accesso di ${T}`,
      "account.password": `ha reimpostato la password di ${T}`,
    }[e.verb] || esc(e.verb);
    return `<b>${esc(e.actor || "Qualcuno")}</b> ${t}`;
  }
  const actTone = (v) => v === "shift.approve" || v === "receipt.reimburse" ? "ok" : v === "shift.reject" || v.endsWith(".delete") ? "risk" : v.startsWith("payment") ? "money" : v === "shift.add" || v === "receipt.add" ? "new" : "";
  function dayLabel(ms) {
    const d = isoDay(new Date(ms)), today = isoDay(), y = isoDay(new Date(Date.now() - 864e5));
    return d === today ? "Oggi" : d === y ? "Ieri" : fmtShort(d);
  }
  function paintActivity() {
    const el = $("#act-list"); if (!el) return;
    if (!act.loaded && !act.loading) { loadActivity(false); return; }
    if (act.err && !act.entries.length) { el.innerHTML = `<p class="err">${esc(act.err)}</p>`; return; }
    if (!act.entries.length) { el.innerHTML = act.loading ? `<p class="muted">Caricamento…</p>` : `<p class="muted">Ancora niente. Le modifiche compaiono qui man mano che si registrano ore, ricevute e pagamenti.</p>`; return; }
    let day = "", html = "";
    for (const e of act.entries) {
      const dl = dayLabel(e.at);
      if (dl !== day) { if (day) html += `</ol>`; html += `<h3 class="act-day eyebrow">${esc(dl)}</h3><ol class="act-list">`; day = dl; }
      html += `<li class="act-row"><span class="act-dot ${actTone(e.verb)}" aria-hidden="true"></span><span class="act-txt">${actText(e)}</span><time datetime="${new Date(e.at).toISOString()}" title="${esc(new Date(e.at).toLocaleString(locale))}">${Date.now() - e.at < 864e5 ? ago(e.at) : new Date(e.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</time></li>`;
    }
    html += `</ol>`;
    if (act.next) html += `<div class="act-more"><button class="btn" type="button" data-act="act-more" ${act.loading ? "disabled" : ""}>${act.loading ? "Caricamento…" : "Mostra precedenti"}</button></div>`;
    if (act.err) html += `<p class="err">${esc(act.err)}</p>`;
    el.innerHTML = html;
  }
  function bindSettingsExtras() {
    $$("[data-client]").forEach((inp) => inp.addEventListener("change", async () => {
      try { await api("/api/users/" + inp.dataset.client, { body: { clientName: inp.value.trim() } }); toast(inp.value.trim() ? `Vede i lavori di ${inp.value.trim()}` : "Cliente scollegato"); loadAccounts(); }
      catch (err) { toast(err.msg || "Connettiti a internet per modificare gli accessi."); }
    }));
    $$("[data-link]").forEach((sel) => sel.addEventListener("change", async () => {
      const id = sel.dataset.link, personId = sel.value || null;
      try {
        await api("/api/users/" + id, { body: { personId } });
        if (id === me.id) { me = { ...me, personId }; await meta.set("me", me); }
        const a = accounts.find((x) => x.id === id);
        toast(personId ? `${a?.name || "Accesso"} collegato a ${personName(personId)}` : `${a?.name || "Accesso"} scollegato`);
        act.loaded = false;
      } catch (err) { toast(err.msg || "Connettiti a internet per modificare i collegamenti."); }
      loadAccounts();
    }));
    $("#place-name").addEventListener("input", (e) => (ui.placeDraft = e.target.value));
    $("#place-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = $("#place-name").value.trim().replace(/\s+/g, " ").slice(0, 120);
      if (!name) return $("#place-name").focus();
      if (state.places.some((p) => (p.name || "").toLowerCase() === name.toLowerCase())) return toast("Questo luogo è già salvato");
      ui.placeDraft = "";
      await save("places", { name });
      toast(`${name} salvato`);
      $("#place-name")?.focus();
    });
    $("#act-person").addEventListener("change", (e) => { ui.actPerson = e.target.value; act.loaded = false; act.entries = []; paintActivity(); });
    $("#act-user").addEventListener("change", (e) => { ui.actUser = e.target.value; act.loaded = false; act.entries = []; paintActivity(); });
  }
  $("#r-cat").addEventListener("change", (e) => { ui.rCat = e.target.value; render(); });

  // ---------- CSV export ----------
  const cell = (v) => { const s = String(v ?? ""); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  function download(name, rows) {
    const blob = new Blob(["﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  $$("[data-export]").forEach((btn) => btn.addEventListener("click", () => {
    const kind = btn.dataset.export;
    if (kind === "hours") download(`ore-${ui.hMonth || "tutte"}.csv`, [["Data", "Persona", "Ruolo", "Lavoro", "Posizione", "Convocazione", "Fine", "Ore", "Tariffa", "Guadagnato", "Tipo di paga", "Tariffa giornaliera", "Ore ordinarie", "Ore di straordinario", "Straordinario ×", "Base di calcolo", "Approvazione"],
      ...shiftsShown().map((s) => { const p = state.people.find((x) => x.id === s.personId), t = shiftTerms(s), pay = shiftPay(s); return [s.date, p?.name, roleLabel(p?.role), s.job, s.location, s.start, s.end, s.hours, t.rate, round2(pay.amount), t.payType === "day" ? "Giornaliera" : "Oraria", t.dayRate || "", round2(pay.regularHours), round2(pay.overtimeHours), t.otAfter ? t.otMult : "", payExplain(s.hours, t, false), { approved: "Approvato", pending: "In attesa di approvazione", rejected: "Rifiutato" }[approvalOf(s)]]; })]);
    else if (kind === "receipts") download(`ricevute-${isoDay()}.csv`, [["Data", "Persona", "Categoria", "Descrizione", "Importo", "Stato", "Rimborsato il"],
      ...receiptsShown().map((r) => [r.date, personName(r.personId), catLabel(catOf(r)), r.description, r.amount, r.status === "reimbursed" ? "Rimborsato" : "Da rimborsare", r.reimbursedAt || ""])]);
    else download(`pagamenti-${isoDay()}.csv`, [["Data", "Persona", "Metodo", "Nota", "Compensi", "Ricevute", "Totale"],
      ...state.payments.filter((p) => !ui.pPerson || p.personId === ui.pPerson).sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((p) => [p.date, personName(p.personId), methodLabel(p.method), p.note, p.amount, p.receiptsAmount || 0, round2((p.amount || 0) + (p.receiptsAmount || 0))])]);
  }));

  // ---------- Jobs (bookings) & client billing ----------
  // jobs/{id}: client, title, date, endDate (optional, multi-day), call, location, notes,
  //   people[] (booked person ids), billing ("flat" | "hourly"), fee, clientRate,
  //   invoiceStatus ("not invoiced" | "invoiced" | "paid").
  // Shifts and receipts carry an optional jobId. Only admins write jobs; staff see them
  // without the billing fields (the server strips those for staff).
  const jui = { view: "list", q: "", pastOpen: false };
  let jobOpenId = null, editingJob = null, shiftFromJob = null;
  const CAL = `<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></svg>`;
  const INV = { "not invoiced": "Non fatturato", invoiced: "Fatturato", paid: "Pagato" };
  const jobEnd = (j) => (j.endDate && j.endDate > j.date ? j.endDate : j.date || "");
  const jobOn = (j, day) => !!j.date && j.date <= day && day <= jobEnd(j);
  const addDays = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); return isoDay(new Date(y, m - 1, d + n)); };
  const jobName = (j) => j.title || j.client || "Lavoro senza titolo";
  const jobLabel = (j) => [j.title, j.client].filter(Boolean).join(" · ") || "Lavoro senza titolo";
  const jobRange = (j) => (jobEnd(j) > j.date ? `${fmtShort(j.date)} – ${fmtShort(jobEnd(j))}` : fmtShort(j.date));
  const invOf = (j) => (INV[j.invoiceStatus] ? j.invoiceStatus : "not invoiced");
  const crewOf = (j) => (j.people || []).filter((id) => state.people.some((p) => p.id === id));
  const shiftCost = (s) => shiftPay(s).amount; // what the person earns for this shift (rate type, overtime)
  const byStart = (a, b) => (a.date || "").localeCompare(b.date || "") || (a.call || "").localeCompare(b.call || "");

  // Billed to the client, what the job cost (wages + linked receipts), and the margin.
  function jobMoney(j) {
    const shifts = state.shifts.filter((s) => s.jobId === j.id);
    const recs = state.receipts.filter((r) => r.jobId === j.id);
    const paid = shifts.filter(counts); // hours waiting for approval aren't billed or costed yet
    const hours = paid.reduce((a, s) => a + (Number(s.hours) || 0), 0);
    const wages = paid.reduce((a, s) => a + shiftCost(s), 0);
    const exp = recs.reduce((a, r) => a + (Number(r.amount) || 0), 0);
    const billed = j.billing === "hourly" ? hours * (Number(j.clientRate) || 0) : Number(j.fee) || 0;
    return { shifts, recs, hours, wages: round2(wages), exp: round2(exp), billed: round2(billed), cost: round2(wages + exp), margin: round2(billed - wages - exp) };
  }
  // Settling a job has two sides: the client pays the agency, the agency pays each person
  // for their hours on it. A person counts as paid for a job when payments linked to it
  // cover what they earned there, or when the office ticks them off by hand (paid some other way).
  function crewPay(j) {
    const ids = [...new Set([...crewOf(j), ...state.shifts.filter((s) => s.jobId === j.id && state.people.some((p) => p.id === s.personId)).map((s) => s.personId)])];
    return ids.map((pid) => {
      const earned = round2(state.shifts.filter((s) => s.jobId === j.id && s.personId === pid && counts(s)).reduce((a, s) => a + shiftCost(s), 0));
      const pays = state.payments.filter((x) => x.jobId === j.id && x.personId === pid);
      const paid = round2(pays.reduce((a, x) => a + (Number(x.amount) || 0), 0));
      const manual = j.crewPaid?.[pid] || "";
      const done = !!manual || (earned > 0.004 && paid >= earned - 0.004);
      const at = manual || pays.map((x) => x.date || "").sort().pop() || "";
      return { pid, earned, paid, manual, done, at, due: done ? 0 : round2(Math.max(0, earned - paid)), idle: !done && earned < 0.005 };
    });
  }
  function settle(j) {
    const crew = crewPay(j), owed = crew.filter((c) => !c.idle);
    const clientPaid = invOf(j) === "paid", crewDone = owed.every((c) => c.done);
    return { crew, clientPaid, crewDone, nPaid: owed.filter((c) => c.done).length, nOwed: owed.length, done: clientPaid && crewDone };
  }
  function crewPill(j, st = settle(j)) {
    if (!st.nOwed) return "";
    return st.crewDone ? `<span class="pill paid">Squadra pagata</span>` : `<span class="pill owed">Squadra ${st.nPaid}/${st.nOwed}</span>`;
  }
  const clientPill = (j) => (invOf(j) === "paid" ? `<span class="pill paid">Cliente ha pagato</span>` : invPill(j));

  // Billed amount; an hourly job with nothing logged yet shows its rate instead of 0.
  const billedLabel = (j, mm) => (j.billing === "hourly" && !mm.hours ? `${money(j.clientRate)} / h` : money(mm.billed));
  function invPill(j) {
    const st = invOf(j);
    if (st === "paid") return `<span class="pill paid">Pagato</span>`;
    if (st === "invoiced") return `<span class="pill inv">Fatturato</span>`;
    return jobEnd(j) < isoDay() ? `<span class="pill owed">Da fatturare</span>` : `<span class="pill wait">Non fatturato</span>`;
  }

  // The board: a person's booking today, or their next one.
  function nextBooking(pid) {
    const today = isoDay();
    return state.jobs.filter((j) => (j.people || []).includes(pid) && jobEnd(j) >= today).sort((a, b) => (jobOn(b, today) - jobOn(a, today)) || byStart(a, b))[0] || null;
  }
  function bookingLine(pid) {
    const j = nextBooking(pid); if (!j) return "";
    const today = isoDay(), on = jobOn(j, today);
    const when = (on ? "Prenotato oggi" : j.date === addDays(today, 1) ? "Prenotato domani" : `Prossimo lavoro · ${fmtShort(j.date)}`) + (j.call ? ` · convocazione ${esc(j.call)}` : "");
    const what = [jobName(j), j.location].filter(Boolean).map(esc).join(", ");
    return `<button class="booked ${on ? "on" : ""}" type="button" data-act="job-open" data-id="${j.id}">${CAL}<span class="txt"><span class="bk-when">${when}</span><span class="bk-what">${what}</span></span></button>`;
  }
  function bookedTodayNote() {
    const today = isoDay(), ids = new Set();
    for (const j of state.jobs) if (jobOn(j, today)) for (const id of crewOf(j)) ids.add(id);
    return ids.size ? ` · ${ids.size} ${ids.size === 1 ? "prenotato" : "prenotati"}` : "";
  }

  function renderJobsHook() {
    if (ui.tab === "calendar") renderCalendar();
    if ($("#d-job").open && jobOpenId) renderJob(jobOpenId);
  }

  const jobsMatching = () => {
    const q = jui.q.trim().toLowerCase();
    return q ? state.jobs.filter((j) => [j.client, j.title, j.location, ...crewOf(j).map(personName)].some((v) => (v || "").toLowerCase().includes(q))) : state.jobs.slice();
  };

  function renderJobs() {
    const el = $("#jobs");
    if (!isAdmin()) jui.view = "list";
    $$("#job-seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.jv === jui.view)));
    const nReq = openRequests().length; $('#job-seg [data-jv="requests"]').textContent = nReq ? `Richieste · ${nReq}` : "Richieste";
    if (jui.view === "requests") return renderRequests(el);
    if (!state.jobs.length) {
      el.innerHTML = isAdmin()
        ? empty("Ancora nessun lavoro prenotato", "Aggiungi un lavoro con cliente, data, orario di convocazione e posizione, poi prenota le persone. Compare sulla loro scheda in Persone e nel calendario e le ore si possono registrare direttamente da lì.", "job-add", "Prenota il primo lavoro")
        : empty("Ancora nessun lavoro prenotato", "I lavori compaiono qui quando un amministratore li prenota.");
      return;
    }
    const nArch = state.jobs.filter((j) => j.archived).length, ab = $('#job-seg [data-jv="archive"]');
    ab.textContent = nArch ? `Archivio · ${nArch}` : "Archivio";
    if (jui.view === "clients") return renderClients(el);
    if (jui.view === "archive") {
      const arch = jobsMatching().filter((j) => j.archived).sort((a, b) => (b.archivedAt || "").localeCompare(a.archivedAt || "") || byStart(b, a));
      el.innerHTML = arch.length ? `<p class="totals-line">Lavori chiusi: il cliente ha pagato e la squadra è stata pagata. Restano qui per consultazione.</p><div class="jlist">${arch.map(jobCard).join("")}</div>`
        : empty(nArch ? "Nessun lavoro corrisponde" : "Archivio vuoto", nArch ? "Prova un'altra ricerca." : "Quando il cliente ha pagato e tutta la squadra è stata pagata per un lavoro, puoi archiviarlo: lo trovi qui.");
      return;
    }
    const list = jobsMatching().filter((j) => !j.archived);
    if (!list.length) { el.innerHTML = empty("Nessun lavoro corrisponde", "Prova un'altra ricerca."); return; }
    const today = isoDay(), tmw = addDays(today, 1), week = addDays(today, 7);
    const groups = [["Oggi", []], ["Domani", []], ["Questa settimana", []], ["Più avanti", []]], past = [];
    for (const j of list.sort(byStart)) {
      if (jobEnd(j) < today) past.push(j);
      else if (jobOn(j, today)) groups[0][1].push(j);
      else if (j.date === tmw) groups[1][1].push(j);
      else if (j.date <= week) groups[2][1].push(j);
      else groups[3][1].push(j);
    }
    past.reverse();
    const up = groups.filter((g) => g[1].length);
    el.innerHTML = (up.length ? up.map(([t, js]) => `<section class="jgroup"><h2 class="jgroup-h">${t}<b>${js.length}</b></h2><div class="jlist">${js.map(jobCard).join("")}</div></section>`).join("")
      : `<p class="totals-line">Nessun lavoro prenotato da oggi in poi.</p>`)
      + (past.length ? `<details class="jpast" ${jui.pastOpen || (jui.q && !up.length) ? "open" : ""}><summary class="jgroup-h">Lavori passati<b>${past.length}</b></summary><div class="jlist">${past.map(jobCard).join("")}</div></details>` : "");
  }

  function jobCard(j) {
    const today = isoDay(), on = jobOn(j, today), [y, m, d] = (j.date || "").split("-").map(Number);
    const dt = new Date(y, (m || 1) - 1, d || 1), crew = crewOf(j);
    const meta = [jobEnd(j) > j.date ? `Fino a ${fmtShort(jobEnd(j))}` : "", j.call ? `Convocazione ${esc(j.call)}` : "", esc(j.location || "")].filter(Boolean).join(" · ");
    const bill = isAdmin() ? `<span class="jmoney"><b>${billedLabel(j, jobMoney(j))}</b>${clientPill(j)}${crewPill(j)}</span>` : "";
    return `<button class="jcard ${on ? "on" : ""} ${jobEnd(j) < today ? "past" : ""}" type="button" data-act="job-open" data-id="${j.id}">
      <span class="jdate"><span>${dt.toLocaleDateString(locale, { weekday: "short" })}</span><b>${d || "?"}</b><span>${dt.toLocaleDateString(locale, { month: "short" })}</span></span>
      <span class="jbody">
        ${j.client && j.title ? `<span class="jclient">${esc(j.client)}</span>` : ""}
        <span class="jtitle">${esc(jobName(j))}</span>
        ${meta ? `<span class="jmeta">${meta}</span>` : ""}
        <span class="jcrew">${crew.length ? crew.map((id) => `<span class="crew-chip">${esc(personName(id))}</span>`).join("") : `<span class="muted">Ancora nessuno prenotato</span>`}${unsyncedTag("jobs", j.id)}</span>
      </span>${bill}
    </button>`;
  }

  function renderClients(el) {
    const by = new Map();
    let billed = 0, cost = 0, awaiting = 0, toInv = 0;
    const today = isoDay();
    for (const j of jobsMatching()) {
      const k = (j.client || "").trim() || "Nessun cliente", mm = jobMoney(j);
      if (!by.has(k)) by.set(k, { name: k, jobs: [], billed: 0, cost: 0 });
      const c = by.get(k); c.jobs.push([j, mm]); c.billed += mm.billed; c.cost += mm.cost;
      billed += mm.billed; cost += mm.cost;
      if (invOf(j) === "invoiced") awaiting += mm.billed;
      if (invOf(j) === "not invoiced" && jobEnd(j) < today) toInv++;
    }
    if (!by.size) { el.innerHTML = empty("Nessun cliente corrisponde", "Prova un'altra ricerca."); return; }
    const margin = round2(billed - cost), n = [...by.values()].reduce((a, c) => a + c.jobs.length, 0);
    const pct = (mg, b) => (b > 0.004 ? `${Math.round((mg / b) * 100)}% del fatturato` : "");
    el.innerHTML = `<div class="summary">
        <div><span class="eyebrow">Margine</span><span class="big ${margin < -0.004 ? "neg" : "ink"}">${money(margin)}</span><span class="note">${pct(margin, billed) || "Ancora niente fatturato"}</span></div>
        <div><span class="eyebrow">Fatturato</span><span class="mid">${money(billed)}</span><span class="note">${n} ${n === 1 ? "lavoro" : "lavori"}</span></div>
        <div><span class="eyebrow">Costo</span><span class="mid">${money(cost)}</span><span class="note">Compensi e ricevute</span></div>
        <div><span class="eyebrow">In attesa di incasso</span><span class="mid">${money(awaiting)}</span><span class="note">${toInv ? (toInv === 1 ? "1 lavoro passato da fatturare" : `${toInv} lavori passati da fatturare`) : "Niente da fatturare"}</span></div>
      </div>
      <div class="clients">${[...by.values()].sort((a, b) => b.billed - a.billed || a.name.localeCompare(b.name, locale)).map((c) => {
        const mg = round2(c.billed - c.cost);
        return `<article class="client">
          <div class="client-head"><h3>${esc(c.name)}</h3><span>${c.jobs.length} ${c.jobs.length === 1 ? "lavoro" : "lavori"}</span></div>
          <div class="figs">
            <div><span class="k">Fatturato</span><span class="v">${money(c.billed)}</span></div>
            <div><span class="k">Costo</span><span class="v">${money(c.cost)}</span></div>
            <div><span class="k">Margine</span><span class="v ${mg < -0.004 ? "neg" : ""}">${money(mg)}</span></div>
          </div>
          <div class="cjobs">${c.jobs.sort((a, b) => byStart(b[0], a[0])).map(([j, mm]) => `<button class="cj" type="button" data-act="job-open" data-id="${j.id}">
            <span class="cj-t"><span class="cj-d">${fmtShort(j.date)}</span>${esc(j.title || "Lavoro senza titolo")}</span>
            <span class="cj-r"><span class="cj-m">${billedLabel(j, mm)}</span>${invPill(j)}</span>
          </button>`).join("")}</div>
        </article>`;
      }).join("")}</div>`;
  }

  // Job sheet
  function renderJob(id) {
    const j = state.jobs.find((x) => x.id === id);
    if (!j) { $("#d-job").close(); return; }
    const mm = jobMoney(j), crew = crewOf(j), a = isAdmin();
    const hoursBy = new Map();
    for (const s of mm.shifts) hoursBy.set(s.personId, (hoursBy.get(s.personId) || 0) + (Number(s.hours) || 0));
    $("#jd-title").textContent = jobName(j);
    const st = invOf(j);
    $("#jd-body").innerHTML = `
      <dl class="kv">
        <dt>Cliente</dt><dd>${esc(j.client || "—")}</dd>
        <dt>Quando</dt><dd>${jobRange(j)}${jobOn(j, isoDay()) ? ` <span class="pill inv">Oggi</span>` : ""}</dd>
        <dt>Orario</dt><dd class="mono">${j.call ? esc(j.call) + (j.wrap ? "–" + esc(j.wrap) : "") : "—"}</dd>
        <dt>Posizione</dt><dd>${esc(j.location || "—")}</dd>
        ${j.notes ? `<dt>Note</dt><dd class="pre">${esc(j.notes)}</dd>` : ""}
      </dl>
      ${a ? `<div class="detail-figs jfigs">
        <div><span class="eyebrow">Fatturato al cliente</span><span class="v">${money(mm.billed)}</span><span class="sub">${j.billing === "hourly" ? `${hrs(mm.hours)} × ${money(j.clientRate)}` : "Compenso fisso"}</span></div>
        <div><span class="eyebrow">Costo</span><span class="v">${money(mm.cost)}</span><span class="sub">Compensi ${money(mm.wages)} · ricevute ${money(mm.exp)}</span></div>
        <div><span class="eyebrow">Margine</span><span class="v ${mm.margin < -0.004 ? "neg" : "pos"}">${money(mm.margin)}</span><span class="sub">${mm.billed > 0.004 ? `${Math.round((mm.margin / mm.billed) * 100)}% del fatturato` : "Ancora niente fatturato"}</span></div>
      </div>
      ${settleBox(j)}` : ""}
      <h4 class="eyebrow">Prenotati · ${crew.length}</h4>
      ${crew.length ? `<div class="crew">${crew.map((pid) => {
        const p = state.people.find((x) => x.id === pid), h = hoursBy.get(pid) || 0;
        return `<div class="crew-row"><div class="who"><button class="comp-name" type="button" data-act="detail" data-id="${pid}">${esc(p.name)}</button><span>${roleLabel(p.role)}${seesPay(pid) ? ` · ${h ? hrs(h) + " registrate" : "nessuna ora registrata"}` : ""}</span></div>
          <button class="btn sm" type="button" data-act="job-log" data-id="${j.id}" data-person="${pid}">${ICON.clock}Registra ore</button></div>`;
      }).join("")}</div>` : `<p class="muted">Ancora nessuno prenotato.${a ? " Modifica il lavoro per prenotare le persone." : ""}</p>`}
      <h4 class="eyebrow">Ore su questo lavoro · ${hrs(mm.hours)}</h4>
      ${mm.shifts.length ? `<div class="tablebox"><table><thead><tr><th>Data</th><th>Persona</th><th class="n">Convocazione–fine</th><th class="n">Ore</th><th class="n">Guadagnato</th></tr></thead><tbody>
        ${mm.shifts.sort((x, y) => (y.date || "").localeCompare(x.date || "")).map((s) => `<tr><td>${fmtShort(s.date)}${unsyncedTag("shifts", s.id) ? `<span class="sub">${unsyncedTag("shifts", s.id)}</span>` : ""}</td><td class="who">${esc(personName(s.personId))}</td><td class="n">${s.start && s.end ? `${esc(s.start)}–${esc(s.end)}` : `<span class="muted">—</span>`}</td><td class="n">${hrs(s.hours)}</td><td class="n">${money(shiftCost(s))}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">Ancora nessuna ora registrata su questo lavoro.</p>`}
      ${mm.recs.length ? `<h4 class="eyebrow">Ricevute su questo lavoro · ${money(mm.exp)}</h4>
      <div class="tablebox"><table><thead><tr><th>Data</th><th>Per</th><th>Pagato da</th><th class="n">Importo</th></tr></thead><tbody>
        ${mm.recs.map((r) => `<tr><td>${fmtShort(r.date)}</td><td><button class="btn quiet sm" type="button" data-act="view-receipt" data-id="${r.id}">${esc(r.description || "Ricevuta")}</button></td><td>${esc(personName(r.personId))}</td><td class="n">${money(r.amount)}</td></tr>`).join("")}
      </tbody></table></div>` : ""}
      ${a ? `<div class="sheet-foot"><button class="btn" type="button" data-act="job-edit" data-id="${j.id}">Modifica lavoro</button></div>` : ""}`;
  }

  // Has the client paid us, have we paid the people: the two sides of a job, and its archive.
  function settleBox(j) {
    const st = settle(j), inv = invOf(j);
    const rows = st.crew.map((c) => {
      const state_ = c.done ? `<span class="pill paid">Pagato${c.at ? ` · ${fmtShort(c.at)}` : ""}</span>` : c.idle ? `<span class="pill wait">Nessuna ora approvata</span>` : `<span class="pill owed">Da pagare ${money(c.due)}</span>`;
      const acts = j.archived ? "" : c.manual ? `<button class="btn quiet sm" type="button" data-act="job-unmark" data-id="${j.id}" data-person="${c.pid}">Annulla</button>`
        : c.done || c.idle ? "" : `<button class="btn sm primary" type="button" data-act="job-pay" data-id="${j.id}" data-person="${c.pid}">${ICON.card}Paga</button><button class="btn quiet sm" type="button" data-act="job-mark" data-id="${j.id}" data-person="${c.pid}" title="Già pagato in altro modo">Già pagato</button>`;
      return `<li><span class="sp-who"><b>${esc(personName(c.pid))}</b><span class="mono">${money(c.earned)}${c.paid && !c.done ? ` · pagati ${money(c.paid)}` : ""}</span></span>${state_}<span class="sp-acts">${acts}</span></li>`;
    }).join("");
    const foot = j.archived
      ? `<div class="settle-foot done"><span><b>Archiviato${j.archivedAt ? ` il ${fmtDate(j.archivedAt)}` : ""}.</b> Cliente e squadra pagati.</span><button class="btn sm" type="button" data-act="job-unarchive" data-id="${j.id}">Ripristina</button></div>`
      : st.done ? `<div class="settle-foot done"><span><b>Tutto saldato.</b> Il cliente ha pagato e la squadra è stata pagata.</span><button class="btn sm ink" type="button" data-act="job-archive" data-id="${j.id}">Archivia</button></div>`
      : `<div class="settle-foot"><span>Per archiviare manca: ${[st.clientPaid ? "" : "il pagamento del cliente", st.crewDone ? "" : (st.nOwed - st.nPaid === 1 ? "1 persona da pagare" : `${st.nOwed - st.nPaid} persone da pagare`)].filter(Boolean).join(" e ")}.</span></div>`;
    return `<section class="settle">
      <div class="settle-side">
        <div class="settle-h"><span class="step ${st.clientPaid ? "ok" : ""}">1</span><div><h4>Il cliente ci ha pagato?</h4><p>${st.clientPaid ? `Sì${j.clientPaidAt ? `, il ${fmtDate(j.clientPaidAt)}` : ""}.` : inv === "invoiced" ? "Fattura inviata, in attesa del pagamento." : "Non ancora fatturato."}</p></div></div>
        <div class="seg" role="group" aria-label="Pagamento del cliente">${Object.entries(INV).map(([v, l]) => `<button type="button" data-act="job-inv" data-id="${j.id}" data-v="${v}" aria-pressed="${inv === v}" ${j.archived ? "disabled" : ""}>${v === "paid" ? "Ha pagato" : l}</button>`).join("")}</div>
      </div>
      <div class="settle-side">
        <div class="settle-h"><span class="step ${st.crewDone && st.nOwed ? "ok" : ""}">2</span><div><h4>Abbiamo pagato la squadra?</h4><p>${!st.nOwed ? "Ancora nessuna ora approvata su questo lavoro." : st.crewDone ? "Sì, tutti pagati per questo lavoro." : `${st.nPaid} su ${st.nOwed} pagati per questo lavoro.`}</p></div></div>
        ${rows ? `<ul class="settle-people">${rows}</ul>` : ""}
      </div>
      ${foot}
    </section>`;
  }

  // Requests from customers (office side): turn one into a job, or decline it.
  const openRequests = () => (state.requests || []).filter((r) => r.status === "new");
  let jobFromRequest = null;
  function renderRequests(el) {
    const all = (state.requests || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const card = (r) => {
      const [label, cls] = REQ_STATUS[r.status] || REQ_STATUS.new, j = r.jobId && state.jobs.find((x) => x.id === r.jobId);
      return `<article class="pt-card">
        <div class="pt-card-h"><div><span class="eyebrow">${esc(r.clientName || "Cliente")}</span><h3>${esc(r.title)}</h3><p>${whenText(r)}${r.location ? ` · ${esc(r.location)}` : ""}</p></div><span class="pill ${cls}">${r.status === "new" ? "Da gestire" : label}</span></div>
        <p class="pt-need">${needText(r)}${r.notes ? ` · ${esc(r.notes)}` : ""}</p>
        <p class="muted">Da ${esc(r.contact || "")}${r.phone ? ` · ${esc(r.phone)}` : ""} · ${ago(r.createdAt)}</p>
        <div class="pt-acts">${r.status === "new" ? `<button class="btn sm primary" type="button" data-act="req-accept" data-id="${r.id}">${ICON.plus || ""}Crea lavoro</button><button class="btn sm danger" type="button" data-act="req-decline" data-id="${r.id}">Non disponibile</button>`
          : j ? `<button class="btn sm" type="button" data-act="job-open" data-id="${j.id}">Apri il lavoro</button>` : r.status === "declined" ? `<button class="btn quiet sm" type="button" data-act="req-reopen" data-id="${r.id}">Riapri</button>` : ""}</div>
      </article>`;
    };
    const open = all.filter((r) => r.status === "new"), rest = all.filter((r) => r.status !== "new");
    el.innerHTML = all.length ? `${open.length ? open.map(card).join("") : `<p class="totals-line">Nessuna richiesta da gestire.</p>`}${rest.length ? `<h4 class="eyebrow pt-h">Già gestite · ${rest.length}</h4>${rest.map(card).join("")}` : ""}`
      : empty("Nessuna richiesta", "Quando un cliente registrato chiede delle persone, la richiesta arriva qui: con un tocco diventa un lavoro.");
  }

  // Job form (admins)
  function openJob(id, day, call, pid) {
    if (!isAdmin()) return;
    editingJob = id || null;
    if (!(day && typeof day === "object")) jobFromRequest = null;
    const j = state.jobs.find((x) => x.id === id) || (day && typeof day === "object" ? day : day ? { date: day, call: call || "", wrap: call ? fmtMin(Math.min(1439, toMin(call) + 480)) : "", people: pid ? [pid] : [] } : {});
    $("#jf-title").textContent = id ? "Modifica lavoro" : "Nuovo lavoro";
    $("#jf-client").value = j.client || ""; $("#jf-name").value = j.title || "";
    $("#jf-date").value = j.date || isoDay(); $("#jf-end").value = j.endDate || ""; $("#jf-call").value = j.call || ""; $("#jf-wrap").value = j.wrap || "";
    $("#jf-loc").value = j.location || ""; $("#jf-notes").value = j.notes || "";
    $("#jf-billing").value = j.billing === "hourly" ? "hourly" : "flat";
    const amt = j.billing === "hourly" ? j.clientRate : j.fee;
    $("#jf-amount").value = amt ? amt : "";
    $("#jf-inv").value = invOf(j);
    $("#jf-more").open = !!amt || invOf(j) !== "not invoiced";
    $("#jf-clients").innerHTML = [...new Set(state.jobs.map((x) => (x.client || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, locale)).map((c) => `<option value="${esc(c)}"></option>`).join("");
    pickPeople(new Set(j.people || []));
    billingLabel();
    $("#jf-del").hidden = !id; disarm($("#jf-del"), "Elimina");
    showErr($("#jf-err"), "");
    openSheet("#d-jobform"); $("#jf-client").focus();
  }
  const pickedPeople = () => new Set($$("#jf-people input:checked").map((i) => i.value));
  function pickPeople(sel) {
    const date = $("#jf-date").value, end = $("#jf-end").value > date ? $("#jf-end").value : date;
    const people = state.people.slice().sort(byName);
    $("#jf-people").innerHTML = people.length ? people.map((p) => {
      const clash = date && state.jobs.find((o) => o.id !== editingJob && (o.people || []).includes(p.id) && o.date <= end && date <= jobEnd(o));
      return `<label class="pickp"><input type="checkbox" value="${p.id}" ${sel.has(p.id) ? "checked" : ""}><span class="nm">${esc(p.name)}</span><span class="rl ${clash ? "clash" : ""}">${clash ? `Già su ${esc(jobName(clash))}` : roleLabel(p.role)}</span></label>`;
    }).join("") : `<p class="hint">Prima aggiungi le persone alla squadra, poi prenotale qui.</p>`;
  }
  function billingLabel() { $("#jf-amount-lbl").textContent = $("#jf-billing").value === "hourly" ? "Tariffa oraria al cliente" : "Compenso dal cliente"; }
  $("#jf-billing").addEventListener("change", billingLabel);
  $("#jf-date").addEventListener("change", () => pickPeople(pickedPeople()));
  $("#jf-end").addEventListener("change", () => pickPeople(pickedPeople()));
  $("#d-jobform form").addEventListener("submit", (e) => {
    e.preventDefault();
    const err = $("#jf-err");
    const client = $("#jf-client").value.trim(), title = $("#jf-name").value.trim(), date = $("#jf-date").value, end = $("#jf-end").value;
    const raw = $("#jf-amount").value.trim(), amt = raw === "" ? 0 : parseFloat(raw);
    if (!client && !title) return showErr(err, "Inserisci il cliente o il nome del lavoro.");
    if (!date) return showErr(err, "Scegli la data del lavoro.");
    if (end && end < date) return showErr(err, "La data di fine è precedente alla data di inizio.");
    if (!(amt >= 0)) return showErr(err, "Inserisci quanto paga il cliente, oppure lascia vuoto.");
    attempt(e.currentTarget, err, async () => {
      const prev = state.jobs.find((x) => x.id === editingJob);
      const billing = $("#jf-billing").value === "hourly" ? "hourly" : "flat";
      const rec = await save("jobs", {
        ...(prev || {}), client, title, date, endDate: end > date ? end : "", call: $("#jf-call").value, wrap: $("#jf-wrap").value, location: $("#jf-loc").value.trim(),
        notes: $("#jf-notes").value.trim(), people: [...pickedPeople()], billing,
        fee: billing === "flat" ? round2(amt) : Number(prev?.fee) || 0, clientRate: billing === "hourly" ? round2(amt) : Number(prev?.clientRate) || 0,
        invoiceStatus: $("#jf-inv").value, clientPaidAt: $("#jf-inv").value === "paid" ? prev?.clientPaidAt || isoDay() : "",
        ...(!prev && jobFromRequest ? { requestId: jobFromRequest } : {}),
      });
      const rq = !prev && jobFromRequest && state.requests.find((x) => x.id === jobFromRequest);
      if (rq) await save("requests", { ...rq, status: "accepted", jobId: rec.id });
      jobFromRequest = null;
      $("#d-jobform").close();
      toast(prev ? "Lavoro salvato" : `${jobName(rec)} prenotato${sync.online ? "" : " · salvato su questo dispositivo"}`);
    });
  });
  $("#jf-del").addEventListener("click", (e) => {
    const j = state.jobs.find((x) => x.id === editingJob); if (!j) return;
    armed(e.currentTarget, "Tocca di nuovo per eliminare", async () => {
      await remove("jobs", j);
      $("#d-jobform").close(); if ($("#d-job").open) $("#d-job").close();
      toast("Lavoro eliminato. Ore e ricevute registrate su di esso restano.");
    });
  });

  // Booking select in the hours and receipt forms
  function jobOptions(sel, selected) {
    const today = isoDay(), from = addDays(today, -60), to = addDays(today, 30);
    const rank = (j) => (jobOn(j, today) ? 0 : j.date > today ? 1 : 2);
    const list = state.jobs.filter((j) => j.id === selected || (jobEnd(j) >= from && j.date <= to))
      .sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? byStart(b, a) : byStart(a, b)));
    sel.innerHTML = `<option value="">Nessun lavoro</option>` + list.map((j) => `<option value="${j.id}">${esc(`${fmtShort(j.date)} · ${jobLabel(j)}`)}</option>`).join("");
    sel.value = list.some((j) => j.id === selected) ? selected : "";
    sel.closest(".field").hidden = !state.jobs.length;
  }
  const bookedOn = (pid, day) => state.jobs.filter((j) => jobOn(j, day) && (j.people || []).includes(pid)).sort(byStart)[0] || null;
  function applyJobToShift(jid, fresh) {
    const j = state.jobs.find((x) => x.id === jid); if (!j) return;
    if (fresh) { const today = isoDay(); $("#sf-date").value = jobOn(j, today) ? today : j.date; }
    if (j.call && (fresh || !$("#sf-start").value)) $("#sf-start").value = j.call;
    $("#sf-job").value = jobLabel(j);
    if (j.location && (fresh || !$("#sf-loc").value.trim())) $("#sf-loc").value = j.location;
    calcHours();
  }
  function jobFillShift(s, shiftId) {
    const from = shiftFromJob; shiftFromJob = null;
    let jid = s.jobId || "";
    if (!shiftId) jid = from?.jobId || bookedOn($("#sf-person").value, isoDay())?.id || "";
    jobOptions($("#sf-jobid"), jid);
    if (!shiftId && jid) applyJobToShift(jid, true);
  }
  $("#sf-jobid").addEventListener("change", (e) => { if (e.target.value) applyJobToShift(e.target.value, !editingShift); });
  function jobFillReceipt(pid) { jobOptions($("#rf-job"), bookedOn(pid, isoDay())?.id || ""); }
  $("#rf-person").addEventListener("change", (e) => { if (!$("#rf-job").value) jobOptions($("#rf-job"), bookedOn(e.target.value, $("#rf-date").value || isoDay())?.id || ""); });
  function receiptJobRow(r) {
    const j = r.jobId && state.jobs.find((x) => x.id === r.jobId);
    return j ? `<dt>Lavoro</dt><dd><button class="btn quiet sm" type="button" data-act="job-open" data-id="${j.id}">${esc(jobLabel(j))}</button></dd>` : "";
  }

  // CSV: what's on the Jobs view (search applied). Billing columns for admins only.
  function exportJobs() {
    const a = isAdmin();
    const head = ["Data", "Fino a", "Cliente", "Lavoro", "Posizione", "Convocazione", "Prenotati", "Ore registrate"];
    if (a) head.push("Il cliente paga", "Compenso", "Tariffa cliente", "Fatturato", "Compensi", "Ricevute", "Costo", "Margine", "Fattura", "Cliente ha pagato il", "Squadra pagata", "Archiviato il");
    const rows = jobsMatching().sort((x, y) => byStart(y, x)).map((j) => {
      const mm = jobMoney(j);
      const r = [j.date, jobEnd(j) > j.date ? jobEnd(j) : "", j.client, j.title, j.location, j.call, crewOf(j).map(personName).join("; "), round2(mm.hours)];
      if (a) r.push(j.billing === "hourly" ? "A ore" : "Compenso fisso", j.billing === "hourly" ? "" : round2(j.fee), j.billing === "hourly" ? round2(j.clientRate) : "", mm.billed, mm.wages, mm.exp, mm.cost, mm.margin, INV[invOf(j)], invOf(j) === "paid" ? j.clientPaidAt || "sì" : "", (() => { const st = settle(j); return st.nOwed ? `${st.nPaid}/${st.nOwed}` : ""; })(), j.archived ? j.archivedAt || "sì" : "");
      return r;
    });
    download(`lavori-${isoDay()}.csv`, [head, ...rows]);
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]"); if (!t || t.disabled) return;
    const id = t.dataset.id;
    switch (t.dataset.act) {
      case "job-open": jobOpenId = id; renderJob(id); return openSheet("#d-job");
      case "job-add": return openJob();
      case "cal-day": cui.sel = t.dataset.day; renderCalendar(); return;
      case "cal-goto": cui.view = "day"; cui.anchor = cui.sel = t.dataset.day; renderCalendar(); window.scrollTo(0, 0); return;
      case "cal-book": return openJob(null, t.dataset.day);
      case "job-edit": return openJob(id);
      case "job-log": shiftFromJob = { jobId: id }; openShift(t.dataset.person); shiftFromJob = null; return;
      case "job-export": return exportJobs();
      case "job-inv": {
        const j = state.jobs.find((x) => x.id === id);
        if (!j || !isAdmin() || j.archived || invOf(j) === t.dataset.v) return;
        const paid = t.dataset.v === "paid";
        return save("jobs", { ...j, invoiceStatus: t.dataset.v, clientPaidAt: paid ? isoDay() : "" }).then(() => toast(paid ? "Il cliente ha pagato: segnato" : `Segnato come ${INV[t.dataset.v].toLowerCase()}`));
      }
      case "job-pay": return openPay(t.dataset.person, id);
      case "req-accept": {
        const r = state.requests.find((x) => x.id === id); if (!r || !isAdmin()) return;
        jobFromRequest = r.id;
        return openJob(null, { client: r.clientName || "", title: r.title, date: r.date, endDate: r.endDate, call: r.call, wrap: r.wrap, location: r.location,
          notes: [`Richiesta: ${needText(r)}`, r.notes, r.contact ? `Contatto: ${r.contact}${r.phone ? " " + r.phone : ""}` : ""].filter(Boolean).join("\n"), people: [] });
      }
      case "req-decline": return armed(t, "Conferma", async () => { const r = state.requests.find((x) => x.id === id); if (r) { await save("requests", { ...r, status: "declined" }); toast("Richiesta rifiutata: il cliente lo vede"); } });
      case "req-reopen": { const r = state.requests.find((x) => x.id === id); return r && save("requests", { ...r, status: "new" }); }
      case "job-mark": case "job-unmark": {
        const j = state.jobs.find((x) => x.id === id), pid = t.dataset.person;
        if (!j || !isAdmin() || j.archived) return;
        const crewPaid = { ...(j.crewPaid || {}) };
        if (t.dataset.act === "job-mark") crewPaid[pid] = isoDay(); else delete crewPaid[pid];
        return save("jobs", { ...j, crewPaid }).then(() => toast(t.dataset.act === "job-mark" ? `${personName(pid)}: segnato come pagato per questo lavoro` : "Segno rimosso"));
      }
      case "job-archive": {
        const j = state.jobs.find((x) => x.id === id);
        if (!j || !isAdmin() || !settle(j).done) return;
        return save("jobs", { ...j, archived: true, archivedAt: isoDay() }).then(() => { $("#d-job").close(); toast(`${jobName(j)} archiviato`); });
      }
      case "job-unarchive": {
        const j = state.jobs.find((x) => x.id === id);
        if (!j || !isAdmin()) return;
        return save("jobs", { ...j, archived: false, archivedAt: "" }).then(() => toast("Lavoro ripristinato"));
      }
    }
  });
  $("#d-job").addEventListener("close", () => (jobOpenId = null));
  $("#job-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; jui.view = b.dataset.jv; render(); });
  $("#job-q").addEventListener("input", (e) => { jui.q = e.target.value; render(); });
  document.addEventListener("toggle", (e) => { if (e.target.classList?.contains("jpast")) jui.pastOpen = e.target.open; }, true);

  // ---------- Calendar ----------
  // Where everyone is, day by day, from three sources: jobs they're booked on (planned),
  // hours they logged (worked) and locations they reported (check-ins, fetched from the
  // server's history; the latest one is also on the person). Staff see only themselves.
  const cui = { view: matchMedia("(max-width: 820px)").matches ? "day" : "week", anchor: isoDay(), sel: isoDay(), role: "" };
  const checkins = { key: "", list: [], at: 0, busy: false };
  const parseDay = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
  const mondayOf = (iso) => { const d = parseDay(iso); return addDays(iso, -((d.getDay() + 6) % 7)); };
  function calRange() {
    if (cui.view === "month") {
      const first = cui.anchor.slice(0, 7) + "-01", start = mondayOf(first);
      const d = parseDay(first), last = isoDay(new Date(d.getFullYear(), d.getMonth() + 1, 0));
      const end = addDays(mondayOf(last), 6);
      return { start, end, first, last };
    }
    if (cui.view === "day") return { start: cui.anchor, end: cui.anchor };
    const start = mondayOf(cui.anchor);
    return { start, end: addDays(start, 6) };
  }
  const daysOf = (start, end) => { const out = []; for (let d = start; d <= end; d = addDays(d, 1)) out.push(d); return out; };
  const calPeople = () => state.people
    .filter((p) => (isAdmin() ? !cui.role || (p.role || "model") === cui.role : p.id === me?.personId))
    .sort(byName);

  async function loadCheckins(force) {
    const { start, end } = calRange(), key = start + "_" + end;
    if (checkins.busy || (!force && checkins.key === key && Date.now() - checkins.at < 60e3)) return;
    if (!isAdmin() && !me?.personId) return;
    checkins.busy = true;
    try {
      const from = parseDay(start).getTime(), to = parseDay(addDays(end, 1)).getTime();
      const r = await api(`/api/checkins?from=${from}&to=${to}`, { method: "GET" });
      Object.assign(checkins, { key, list: r.checkins || [], at: Date.now() });
      if (ui.tab === "calendar") renderCalendar();
    } catch { /* offline: the calendar shows bookings, hours and latest positions */ }
    finally { checkins.busy = false; }
  }

  // day -> personId -> entries, each { kind: "job" | "shift" | "here", loc, … }
  function calEntries(start, end, people) {
    const ids = new Set(people.map((p) => p.id)), out = new Map();
    const add = (day, pid, e) => {
      if (day < start || day > end || !ids.has(pid)) return;
      if (!out.has(day)) out.set(day, new Map());
      const m = out.get(day); if (!m.has(pid)) m.set(pid, []);
      m.get(pid).push(e);
    };
    for (const j of state.jobs) {
      if (!j.date || jobEnd(j) < start || j.date > end) continue;
      for (const d of daysOf(j.date < start ? start : j.date, jobEnd(j) > end ? end : jobEnd(j)))
        for (const pid of crewOf(j)) add(d, pid, { kind: "job", loc: j.location || "", title: jobName(j), call: j.call || "", jobId: j.id });
    }
    for (const s of state.shifts) {
      if (!s.date) continue;
      const j = s.jobId && state.jobs.find((x) => x.id === s.jobId);
      add(s.date, s.personId, { kind: "shift", loc: s.location || j?.location || "", title: s.job || (j ? jobName(j) : ""), hours: s.hours, start: s.start, end: s.end, pending: approvalOf(s) === "pending" });
    }
    const seen = new Set();
    for (const c of checkins.list) {
      const k = c.personId + "@" + c.at; seen.add(k);
      add(isoDay(new Date(c.at)), c.personId, { kind: "here", loc: c.location, at: c.at });
    }
    for (const p of people) if (p.location && p.locationAt && !seen.has(p.id + "@" + p.locationAt) && !checkins.list.some((c) => c.personId === p.id && Math.abs(c.at - p.locationAt) < 5e3))
      add(isoDay(new Date(p.locationAt)), p.id, { kind: "here", loc: p.location, at: p.locationAt });
    // Within a day: bookings first, then hours, then check-ins by time.
    const rank = { job: 0, shift: 1, here: 2 };
    for (const m of out.values()) for (const list of m.values()) list.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.at || 0) - (b.at || 0));
    return out;
  }
  // The one place to show for a person on a day: the last reported position, else where they logged hours, else the booking.
  const mainPlace = (list) => [...list].reverse().find((e) => e.kind === "here" && e.loc)?.loc || list.find((e) => e.kind === "shift" && e.loc)?.loc || list.find((e) => e.loc)?.loc || list[0]?.title || "";
  const KIND = { job: "Prenotato", shift: "Ore registrate", here: "Posizione segnalata" };
  const kindIcon = (k) => (k === "job" ? CAL : k === "shift" ? ICON.clock : ICON.pin);
  const kindDots = (list) => [...new Set(list.map((e) => e.kind))].map((k) => `<i class="kd k-${k}" title="${KIND[k]}"></i>`).join("");
  const dayLong = (iso) => parseDay(iso).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
  const hm = (ms) => new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

  function calTitle() {
    const { start, end } = calRange();
    if (matchMedia("(max-width: 820px)").matches) {
      if (cui.view === "month") return parseDay(cui.anchor).toLocaleDateString(locale, { month: "long", year: "numeric" });
      if (cui.view === "day") return (start === isoDay() ? "Oggi · " : "") + parseDay(start).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
      const x = parseDay(start), y = parseDay(end), same = x.getMonth() === y.getMonth();
      return `${x.toLocaleDateString(locale, same ? { day: "numeric" } : { day: "numeric", month: "short" })} – ${y.toLocaleDateString(locale, { day: "numeric", month: "short" })}`;
    }
    if (cui.view === "month") return parseDay(cui.anchor).toLocaleDateString(locale, { month: "long", year: "numeric" });
    if (cui.view === "day") return (start === isoDay() ? "Oggi · " : "") + parseDay(start).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const a = parseDay(start), b = parseDay(end);
    const sameMonth = a.getMonth() === b.getMonth();
    return `${a.toLocaleDateString(locale, sameMonth ? { day: "numeric" } : { day: "numeric", month: "short" })} – ${b.toLocaleDateString(locale, { day: "numeric", month: sameMonth ? "long" : "short", year: "numeric" })}`;
  }

  function renderCalendar() {
    const sec = $('[data-view="calendar"]');
    sec.dataset.cv = cui.view;
    $$("#cal-seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.cv === cui.view)));
    $("#cal-role").value = cui.role;
    if (cui.view === "list") return renderJobs();
    $("#cal-title").textContent = calTitle();
    const el = $("#cal"), people = calPeople();
    if (!state.people.length) {
      el.innerHTML = isAdmin() ? empty("Ancora nessuno in squadra", "Aggiungi modelli e tecnici in Persone. Poi qui vedi dove sono, giorno per giorno.", "add-person", "Aggiungi persona")
        : empty("Calendario vuoto", "Un amministratore deve prima aggiungere le persone.");
      return;
    }
    if (!people.length) {
      el.innerHTML = isAdmin() ? empty("Nessuno con questo filtro", "Scegli «Tutti» per vedere tutta la squadra.")
        : empty("Il tuo accesso non è ancora collegato", "Chiedi a un amministratore di collegare il tuo accesso al tuo nome. Poi qui vedrai i tuoi lavori e dove sei stato.");
      return;
    }
    const { start, end } = calRange(), today = isoDay();
    const legend = `<div class="cal-legend" aria-hidden="true"><span><i class="kd k-job"></i>Prenotato</span><span><i class="kd k-shift"></i>Ore registrate</span><span><i class="kd k-here"></i>Posizione segnalata</span>${isAdmin() && cui.view !== "month" ? `<span class="hint-add">Tocca un'ora libera per prenotare un lavoro</span>` : ""}</div>`;
    if (cui.view === "month") {
      const ent = calEntries(start, end, people);
      if (cui.sel < start || cui.sel > end) cui.sel = today >= start && today <= end ? today : calRange().first;
      el.innerHTML = monthGrid(start, end, ent, today) + legend + dayAgenda(cui.sel, ent.get(cui.sel) || new Map(), people);
    } else {
      cui.sel = cui.view === "day" ? start : cui.sel;
      el.innerHTML = (cui.view === "day" ? dayGrid(start, people) : weekGrid(start, end, people)) + legend;
      // Positions go on through the DOM: the page's security policy forbids style attributes in markup.
      for (const n of el.querySelectorAll("[data-st]")) n.style.cssText = n.dataset.st;
    }
    loadCheckins();
  }

  // ---------- Time grid (day and week views) ----------
  // A real calendar: hours down the side, one column per person (day view) or per day
  // (week view), and a block for every job and every stretch of logged hours.
  const HOUR_PX = 48;
  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const fmtMin = (n) => `${pad(Math.floor(n / 60) % 24)}:${pad(n % 60)}`;
  const span = (s, e) => { if (e == null || e <= s) e = e != null && e < s ? 1440 : s + 60; return [s, Math.min(e, 1440)]; };
  const jobSpan = (j, day) => {
    const s = toMin(j.call); if (s == null) return null;
    let e = toMin(j.wrap);
    if (e == null) { // no end set: the latest logged end on that day, else a standard 8 hours
      const ends = state.shifts.filter((x) => x.jobId === j.id && x.date === day).map((x) => toMin(x.end)).filter((v) => v != null && v > s);
      e = ends.length ? Math.max(...ends) : s + 480;
    }
    return span(s, e);
  };
  const pinsOf = (day, ids) => {
    const out = [], seen = new Set();
    const add = (pid, at, loc) => { if (!ids.has(pid) || !loc || isoDay(new Date(at)) !== day) return; const k = pid + "@" + Math.round(at / 5e3); if (seen.has(k)) return; seen.add(k); const d = new Date(at); out.push({ pid, at, min: d.getHours() * 60 + d.getMinutes(), loc }); };
    for (const c of checkins.list) add(c.personId, c.at, c.location);
    for (const p of state.people) if (p.location && p.locationAt) add(p.id, p.locationAt, p.location);
    return out.sort((a, b) => a.at - b.at);
  };
  // What one person does on one day. Hours they logged on a job replace the planned block.
  function personDay(pid, day) {
    const timed = [], allday = [], used = new Set();
    for (const j of state.jobs) {
      if (!jobOn(j, day) || !(j.people || []).includes(pid)) continue;
      const mine = state.shifts.filter((s) => s.jobId === j.id && s.personId === pid && s.date === day);
      mine.forEach((s) => used.add(s.id));
      const clocked = mine.filter((s) => toMin(s.start) != null && toMin(s.end) != null);
      const logged = mine.reduce((a, s) => a + (Number(s.hours) || 0), 0);
      if (clocked.length) for (const s of clocked) { const [a, b] = span(toMin(s.start), toMin(s.end)); timed.push({ kind: "shift", s: a, e: b, title: jobName(j), sub: s.location || j.location || "", shiftId: s.id, jobId: j.id, pending: approvalOf(s) === "pending", note: hrs(s.hours) }); }
      else { const sp = jobSpan(j, day), ev = { kind: "job", title: jobName(j), sub: j.location || "", jobId: j.id, note: logged ? `${hrs(logged)} registrate` : "" }; if (sp) timed.push({ ...ev, s: sp[0], e: sp[1] }); else allday.push(ev); }
    }
    for (const s of state.shifts) {
      if (s.personId !== pid || s.date !== day || used.has(s.id)) continue;
      const ev = { kind: "shift", title: s.job || "Ore registrate", sub: s.location || "", shiftId: s.id, pending: approvalOf(s) === "pending", note: hrs(s.hours) };
      if (toMin(s.start) != null && toMin(s.end) != null) { const [a, b] = span(toMin(s.start), toMin(s.end)); timed.push({ ...ev, s: a, e: b }); } else allday.push(ev);
    }
    return { timed, allday };
  }
  // The whole agency on one day: one block per job (with who is on it), plus hours logged outside jobs.
  function agencyDay(day, people) {
    const ids = new Set(people.map((p) => p.id)), timed = [], allday = [];
    const first = (id) => personName(id).split(" ")[0];
    for (const j of state.jobs) {
      if (!jobOn(j, day)) continue;
      const crew = crewOf(j).filter((id) => ids.has(id));
      if (!crew.length && (cui.role || crewOf(j).length)) continue;
      const done = new Set(state.shifts.filter((s) => s.jobId === j.id && s.date === day).map((s) => s.personId)).size;
      const ev = { kind: "job", title: jobName(j), sub: j.location || "", jobId: j.id, who: crew.length ? crew.map(first).join(", ") : "Nessuno prenotato", note: done ? `ore registrate ${done}/${crew.length}` : "" };
      const sp = jobSpan(j, day); if (sp) timed.push({ ...ev, s: sp[0], e: sp[1] }); else allday.push(ev);
    }
    for (const s of state.shifts) {
      if (s.date !== day || !ids.has(s.personId)) continue;
      const j = s.jobId && state.jobs.find((x) => x.id === s.jobId);
      if (j && jobOn(j, day) && (j.people || []).includes(s.personId)) continue; // already inside the job block
      const ev = { kind: "shift", title: first(s.personId), sub: [s.job, s.location].filter(Boolean).join(" · "), shiftId: s.id, pending: approvalOf(s) === "pending", note: hrs(s.hours) };
      if (toMin(s.start) != null && toMin(s.end) != null) { const [a, b] = span(toMin(s.start), toMin(s.end)); timed.push({ ...ev, s: a, e: b }); } else allday.push(ev);
    }
    return { timed, allday };
  }
  // Side-by-side lanes for blocks that overlap.
  function lanes(list) {
    list.sort((a, b) => a.s - b.s || b.e - a.e);
    let cluster = [], ends = [], maxEnd = -1;
    const close = () => { for (const ev of cluster) ev.lanes = ends.length; cluster = []; ends = []; };
    for (const ev of list) {
      if (ev.s >= maxEnd) close();
      let i = ends.findIndex((t) => t <= ev.s); if (i < 0) i = ends.length;
      ends[i] = ev.e; ev.lane = i; cluster.push(ev); maxEnd = Math.max(maxEnd, ev.e);
    }
    close();
    return list;
  }
  const evAct = (ev) => (ev.shiftId && (isAdmin() || state.shifts.find((s) => s.id === ev.shiftId)?.by === me.id) ? `data-act="edit-shift" data-id="${ev.shiftId}"` : ev.jobId ? `data-act="job-open" data-id="${ev.jobId}"` : "disabled");
  const evBody = (ev, time) => `${time ? `<span class="ev-t">${time}</span>` : ""}<b>${esc(ev.title)}</b>${ev.who ? `<span class="ev-who">${esc(ev.who)}</span>` : ""}${ev.sub ? `<span class="ev-sub">${esc(ev.sub)}</span>` : ""}${ev.note ? `<span class="ev-note">${esc(ev.note)}</span>` : ""}${ev.pending ? `<span class="ev-note">in attesa di approvazione</span>` : ""}`;
  const evTitle = (ev, time) => esc([time, ev.title, ev.who, ev.sub, ev.note, ev.pending ? "In attesa di approvazione" : ""].filter(Boolean).join("\n"));

  // cols: [{ day, pid, head, cls, timed, allday, pins }]
  function timeGrid(cols, colMin) {
    const all = cols.flatMap((c) => c.timed), pins = cols.flatMap((c) => c.pins || []);
    const lo = Math.min(7 * 60, ...all.map((e) => e.s), ...pins.map((p) => p.min)), hi = Math.max(20 * 60, ...all.map((e) => e.e), ...pins.map((p) => p.min + 30));
    const from = Math.floor(lo / 60) * 60, to = Math.min(1440, Math.ceil(hi / 60) * 60), H = ((to - from) / 60) * HOUR_PX;
    const y = (m) => ((m - from) / 60) * HOUR_PX;
    const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes(), today = isoDay();
    const hasAllday = cols.some((c) => c.allday.length);
    const axis = []; for (let m = from; m < to; m += 60) axis.push(`<span data-st="top:${y(m)}px">${fmtMin(m)}</span>`);
    const col = (c) => {
      const blocks = lanes(c.timed).map((ev) => {
        const time = `${fmtMin(ev.s)}–${fmtMin(ev.e)}`, h = Math.max(22, y(ev.e) - y(ev.s) - 2), w = 100 / ev.lanes;
        return `<button type="button" class="ev k-${ev.kind} ${ev.pending ? "pending" : ""} ${h < 44 ? "short" : ""}" data-st="top:${y(ev.s) + 1}px;height:${h}px;left:calc(${ev.lane * w}% + 2px);width:calc(${w}% - 4px)" ${evAct(ev)} title="${evTitle(ev, time)}">${evBody(ev, time)}</button>`;
      }).join("");
      const marks = (c.pins || []).map((p) => `<span class="tg-pin" data-st="top:${y(p.min)}px" title="${esc(`${fmtMin(p.min)} · ${p.loc}`)}">${ICON.pin}</span>`).join("");
      const line = c.day === today && nowMin >= from && nowMin <= to ? `<i class="tg-now" data-st="top:${y(nowMin)}px"></i>` : "";
      return `<div class="tg-col ${c.cls || ""}" data-day="${c.day}" ${c.pid ? `data-pid="${c.pid}"` : ""} data-st="height:${H}px">${blocks}${marks}${line}</div>`;
    };
    return `<div class="tg" data-st="--cols:${cols.length};--colmin:${colMin}px;--hour:${HOUR_PX}px">
      <div class="tg-in">
        <div class="tg-corner"></div>${cols.map((c) => `<div class="tg-head ${c.cls || ""}">${c.head}</div>`).join("")}
        ${hasAllday ? `<div class="tg-corner tg-adl">Senza orario</div>${cols.map((c) => `<div class="tg-all ${c.cls || ""}">${c.allday.map((ev) => `<button type="button" class="ev flat k-${ev.kind} ${ev.pending ? "pending" : ""}" ${ev.act || evAct(ev)} title="${evTitle(ev)}">${evBody(ev)}</button>`).join("")}</div>`).join("")}` : ""}
        <div class="tg-axis" data-st="height:${H}px">${axis.join("")}</div>${cols.map(col).join("")}
      </div>
    </div>`;
  }

  function dayGrid(day, people) {
    const ids = new Set(people.map((p) => p.id)), pins = pinsOf(day, ids), today = isoDay();
    const cols = people.map((p) => {
      const { timed, allday } = personDay(p.id, day), mine = pins.filter((x) => x.pid === p.id), last = mine[mine.length - 1];
      const where = last ? `<span class="tg-where">${ICON.pin}<span>${esc(last.loc)} · ${fmtMin(last.min)}</span></span>` : `<span class="tg-where none">Nessuna posizione</span>`;
      return { day, pid: p.id, cls: day === today ? "today" : "", timed, allday, pins: mine,
        head: `<button type="button" class="tg-person" data-act="detail" data-id="${p.id}"><b>${esc(p.name)}</b><span>${roleLabel(p.role)}</span></button>${where}` };
    });
    return timeGrid(cols, 150);
  }

  function weekGrid(start, end, people) {
    const ids = new Set(people.map((p) => p.id)), today = isoDay(), solo = !isAdmin();
    const cols = daysOf(start, end).map((d) => {
      const dt = parseDay(d), pins = pinsOf(d, ids);
      const { timed, allday } = solo ? personDay(me.personId, d) : agencyDay(d, people);
      // Reported positions: for the office, one chip per place with how many people; for staff, their own.
      const places = new Map(); for (const p of pins) places.set(p.loc, (places.get(p.loc) || new Set()).add(p.pid));
      const whoAll = new Set(pins.map((x) => x.pid));
      const chips = solo || !places.size ? [] : [{ kind: "here", act: `data-act="cal-goto" data-day="${d}"`,
        title: places.size === 1 ? [...places.keys()][0] : `Posizioni: ${places.size} luoghi`,
        note: whoAll.size === 1 ? personName([...whoAll][0]).split(" ")[0] : `${whoAll.size} persone` }];
      return { day: d, cls: d === today ? "today" : "", timed, allday: [...allday, ...chips], pins: solo ? pins : [],
        head: `<button type="button" class="tg-day" data-act="cal-goto" data-day="${d}" title="Apri il giorno"><span>${dt.toLocaleDateString(locale, { weekday: "short" })}</span><b>${dt.getDate()}</b></button>` };
    });
    return timeGrid(cols, 118);
  }

  function monthGrid(start, end, ent, today) {
    const { first, last } = calRange();
    const wd = daysOf(start, addDays(start, 6)).map((d) => `<div class="cal-wd">${parseDay(d).toLocaleDateString(locale, { weekday: "short" })}</div>`).join("");
    const cells = daysOf(start, end).map((d) => {
      const m = ent.get(d) || new Map(), n = m.size, out = d < first || d > last;
      const lines = [...m.entries()].sort((a, b) => personName(a[0]).localeCompare(personName(b[0]), locale)).slice(0, 3)
        .map(([pid, list]) => `<span class="ml"><i class="kd k-${list[list.length - 1].kind}"></i><b>${esc(isAdmin() ? personName(pid).split(" ")[0] : mainPlace(list))}</b>${isAdmin() ? ` ${esc(mainPlace(list))}` : ""}</span>`).join("");
      return `<button type="button" class="cal-mday ${out ? "out" : ""} ${d === today ? "today" : ""} ${d === cui.sel ? "sel" : ""}" data-act="cal-day" data-day="${d}" aria-label="${esc(dayLong(d))}${n ? `, ${n} ${n === 1 ? "persona" : "persone"}` : ""}">
        <span class="dn">${parseDay(d).getDate()}</span>${lines}${n > 3 ? `<span class="more">+${n - 3}</span>` : ""}${n ? `<span class="cnt">${n}</span>` : ""}</button>`;
    }).join("");
    return `<div class="cal-month"><div class="cal-mhead">${wd}</div><div class="cal-mgrid">${cells}</div></div>`;
  }

  function dayAgenda(day, m, people) {
    const withInfo = people.filter((p) => m.has(p.id)), without = people.filter((p) => !m.has(p.id));
    const line = (e) => {
      let txt;
      if (e.kind === "job") txt = `<b>${esc(e.title)}</b>${e.loc ? ` · ${esc(e.loc)}` : ""}${e.call ? ` · convocazione ${esc(e.call)}` : ""}`;
      else if (e.kind === "shift") txt = `<b>${hrs(e.hours)}</b>${e.start && e.end ? ` ${esc(e.start)}–${esc(e.end)}` : ""}${e.title ? ` · ${esc(e.title)}` : ""}${e.loc ? ` · ${esc(e.loc)}` : ""}${e.pending ? ` <span class="pill wait">In attesa</span>` : ""}`;
      else txt = `<b>${esc(e.loc)}</b> · alle ${hm(e.at)}`;
      const tag = e.kind === "job" ? `button type="button" data-act="job-open" data-id="${e.jobId}"` : "div";
      return `<li class="k-${e.kind}"><${tag} class="ag-line">${kindIcon(e.kind)}<span><span class="ag-k">${KIND[e.kind]}</span>${txt}</span></${tag.split(" ")[0]}></li>`;
    };
    return `<section class="panel cal-agenda" aria-label="${esc(dayLong(day))}">
      <div class="ag-head"><h2>${day === isoDay() ? "Oggi · " : ""}${esc(dayLong(day))}</h2><button class="btn sm" type="button" data-act="cal-goto" data-day="${day}">${CAL}Apri il giorno</button>${isAdmin() ? `<button class="btn sm" type="button" data-act="cal-book" data-day="${day}">${ICON.plus || "+"} Prenota un lavoro</button>` : ""}</div>
      ${withInfo.length ? `<ul class="ag-people">${withInfo.map((p) => `<li><div class="ag-who"><button class="comp-name" type="button" data-act="detail" data-id="${p.id}">${esc(p.name)}</button><span class="tag ${p.role === "technician" ? "technician" : "model"}">${roleLabel(p.role)}</span></div><ul class="ag-lines">${m.get(p.id).map(line).join("")}</ul></li>`).join("")}</ul>`
        : `<p class="muted">${isAdmin() ? "Nessuno è prenotato o ha segnalato una posizione in questo giorno." : "Niente in questo giorno."}</p>`}
      ${isAdmin() && withInfo.length && without.length ? `<p class="ag-none"><span class="eyebrow">Senza informazioni</span> ${without.map((p) => esc(p.name)).join(", ")}</p>` : ""}
    </section>`;
  }

  $("#cal-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    cui.view = b.dataset.cv;
    if (cui.sel) cui.anchor = cui.sel;
    if (location.hash !== "#calendar") history.replaceState(null, "", "#calendar");
    renderCalendar();
  });
  $('[data-view="calendar"] .cal-nav').addEventListener("click", (e) => {
    const b = e.target.closest("[data-cal]"); if (!b) return;
    if (b.dataset.cal === "today") { cui.anchor = cui.sel = isoDay(); }
    else {
      const dir = b.dataset.cal === "next" ? 1 : -1;
      if (cui.view === "month") { const d = parseDay(cui.anchor); cui.anchor = isoDay(new Date(d.getFullYear(), d.getMonth() + dir, 1)); }
      else cui.anchor = addDays(cui.anchor, (cui.view === "day" ? 1 : 7) * dir);
      cui.sel = "";
    }
    renderCalendar();
  });
  $("#cal").addEventListener("click", (e) => {
    const col = e.target.closest(".tg-col");
    if (!col || e.target.closest(".ev, .tg-pin") || !isAdmin()) return;
    const from = toMin($(".tg-axis span", col.parentNode)?.textContent) ?? 420;
    const min = Math.min(1410, from + Math.floor(((e.clientY - col.getBoundingClientRect().top) / HOUR_PX) * 2) * 30);
    openJob(null, col.dataset.day, fmtMin(min), col.dataset.pid);
  });
  $("#cal-role").addEventListener("change", (e) => { cui.role = e.target.value; renderCalendar(); });

  // ---------- Routing ----------
  const TABS = ["calendar", "team", "hours", "receipts", "payments", "settings", "me"];
  function route() {
    let h = location.hash.slice(1);
    if (h === "jobs") { cui.view = "list"; h = "calendar"; history.replaceState(null, "", "#calendar"); }
    if (h === "payments" && !isAdmin()) h = ""; // staff see their payments on their own page
    // Office lands on the calendar, linked staff on their own page.
    ui.tab = TABS.includes(h) ? h : isAdmin() ? "calendar" : staffMe() ? "me" : "team";
    $$(".nav a, .gear").forEach((a) => (a.dataset.tab === ui.tab || (a.dataset.tab === "team" && ui.tab === "me") ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    $$("[data-view]").forEach((v) => (v.hidden = v.dataset.view !== ui.tab));
    if (ui.tab === "settings") { act.loaded = false; loadAccounts(); }
    render();
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);

  // ---------- Sign in ----------
  let reauth = false;
  function showAuth(mode, isReauth = false) {
    reauth = isReauth;
    $("#app").hidden = true; $("#portal").hidden = true; $("#auth").hidden = false;
    $("#login-form").hidden = mode !== "login"; $("#setup-form").hidden = mode !== "setup"; $("#signup-form").hidden = mode !== "signup";
    (mode === "login" ? $("#li-user") : mode === "signup" ? $("#sg-name") : $("#su-name")).focus();
  }
  async function enter(user) {
    const prev = await meta.get("me");
    if (prev && prev.id !== user.id) { await idb.wipe(); await loadState(); } // a different person on this device
    else if (prev && prev.role !== user.role) await meta.set("rev", 0); // role changed: re-fetch (staff copies of jobs carry no billing)
    me = user; await meta.set("me", user);
    sync.authLost = false;
    if (usesPortal(user)) return showPortal(user);
    $("#auth").hidden = true; $("#portal").hidden = true; $("#app").hidden = false;
    $("#me-chip").innerHTML = `<div><b>${esc(user.name)}</b>${user.role === "admin" ? "Amministratore" : "Collaboratore"}</div>`;
    navigator.storage?.persist?.().catch(() => {});
    loadAccounts();
    route();
    runSync();
  }
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#li-err"), btn = $("#li-btn");
    showErr(err, ""); btn.disabled = true;
    try {
      const r = await api("/api/login", { body: { username: $("#li-user").value.trim(), password: $("#li-pass").value } });
      $("#li-pass").value = "";
      await enter(r.user);
    } catch (x) {
      showErr(err, x.status ? x.msg : "Nessuna connessione. Devi essere online per accedere.");
    } finally { btn.disabled = false; }
  });
  $("#setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#su-err"), btn = $("#su-btn");
    showErr(err, ""); btn.disabled = true;
    try {
      const r = await api("/api/setup", { body: { code: $("#su-code").value.trim(), name: $("#su-name").value.trim(), username: $("#su-user").value.trim(), password: $("#su-pass").value } });
      await enter(r.user);
    } catch (x) { showErr(err, x.status ? x.msg : "Nessuna connessione. Devi essere online per la configurazione."); }
    finally { btn.disabled = false; }
  });
  async function logout(btn, unsent) {
    const go = async () => {
      try { await api("/api/logout", {}); } catch { /* offline: still clear the device */ }
      await idb.wipe(); await loadState(); me = null;
      showAuth("login");
    };
    if (unsent) armed(btn, (unsent === 1 ? "Uscire e perdere 1 modifica non inviata?" : `Uscire e perdere ${unsent} modifiche non inviate?`), go);
    else go();
  }

  // ---------- Customers (and people waiting for approval) ----------
  // Customers never get the ledger: this screen talks to its own small API, online only.
  const usesPortal = (u) => !!u && (u.role === "client" || (u.role === "staff" && u.pending));
  const REQ_STATUS = { new: ["Inviata", "wait"], accepted: ["Accettata", "paid"], declined: ["Non disponibile", "over"], cancelled: ["Annullata", "wait"] };
  const needText = (r) => [r.models ? `${r.models} ${r.models === 1 ? "modello/a" : "modelli/e"}` : "", r.technicians ? `${r.technicians} ${r.technicians === 1 ? "tecnico" : "tecnici"}` : ""].filter(Boolean).join(" · ");
  const whenText = (x) => `${fmtShort(x.date)}${x.endDate && x.endDate > x.date ? ` – ${fmtShort(x.endDate)}` : ""}${x.call ? ` · ${esc(x.call)}${x.wrap ? "–" + esc(x.wrap) : ""}` : ""}`;
  let portalData = null;
  function showPortal(user) {
    me = user;
    $("#auth").hidden = true; $("#app").hidden = true; $("#portal").hidden = false;
    $("#pt-name").textContent = user.name;
    $("#pt-kind").textContent = user.role === "client" ? "Clienti" : "Squadra";
    if (user.role === "client") loadPortal(); else paintWaiting();
  }
  function paintWaiting() {
    $("#pt-main").innerHTML = `<section class="panel pt-wait"><h1>Iscrizione ricevuta</h1>
      <p>Grazie, ${esc(me.name.split(" ")[0])}. L'ufficio deve approvare la tua iscrizione: appena lo fa, qui trovi il tuo calendario, le tue ore e le tue ricevute.</p>
      <div><button class="btn primary" type="button" id="pt-check">Controlla di nuovo</button></div></section>`;
    $("#pt-check").addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      try { const r = await api("/api/me", { method: "GET" }); if (!usesPortal(r.user)) return enter(r.user); toast("Non ancora approvata. Riprova più tardi."); }
      catch (x) { toast(x.status ? x.msg : "Nessuna connessione."); }
      paintWaiting();
    });
  }
  async function loadPortal() {
    const el = $("#pt-main");
    if (!portalData) el.innerHTML = `<p class="muted">Caricamento…</p>`;
    try { portalData = await api("/api/client/overview", { method: "GET" }); }
    catch (x) {
      if (x.status === 401) return showAuth("login");
      if (!portalData) { el.innerHTML = `<section class="panel"><p>${esc(x.status ? x.msg : "Nessuna connessione. Riprova quando sei online.")}</p><div><button class="btn" type="button" id="pt-retry">Riprova</button></div></section>`; $("#pt-retry").addEventListener("click", loadPortal); return; }
    }
    paintPortal();
  }
  function paintPortal() {
    const d = portalData, today = isoDay();
    if (d.currency) state.settings = { ...state.settings, currency: d.currency };
    const jobEndOf = (j) => (j.endDate && j.endDate > j.date ? j.endDate : j.date);
    const job = (j) => {
      const pay = j.payment === "paid" ? `<span class="pill paid">Pagato${j.paidAt ? ` · ${fmtShort(j.paidAt)}` : ""}</span>` : j.payment === "invoiced" ? `<span class="pill owed">Fattura da pagare</span>` : `<span class="pill wait">Non ancora fatturato</span>`;
      return `<article class="pt-card">
        <div class="pt-card-h"><div><h3>${esc(j.title || j.client || "Lavoro")}</h3><p>${whenText(j)}${j.location ? ` · ${esc(j.location)}` : ""}</p></div><div class="pt-pay">${j.fee ? `<b class="mono">${money(j.fee)}</b>` : ""}${pay}</div></div>
        ${j.people.length ? `<ul class="pt-people">${j.people.map((p) => `<li><b>${esc(p.name)}</b><span>${roleLabel(p.role)}${p.speciality ? " · " + esc(p.speciality) : ""}</span></li>`).join("")}</ul>` : `<p class="muted">L'ufficio sta ancora scegliendo le persone.</p>`}
      </article>`;
    };
    const req = (r) => {
      const [label, cls] = REQ_STATUS[r.status] || REQ_STATUS.new;
      return `<article class="pt-card">
        <div class="pt-card-h"><div><h3>${esc(r.title)}</h3><p>${whenText(r)}${r.location ? ` · ${esc(r.location)}` : ""}</p></div><span class="pill ${cls}">${label}</span></div>
        <p class="pt-need">${needText(r)}${r.notes ? ` · ${esc(r.notes)}` : ""}</p>
        ${r.status === "declined" && r.reply ? `<p class="muted">Risposta dell'ufficio: ${esc(r.reply)}</p>` : ""}
        ${r.status === "new" ? `<div><button class="btn sm" type="button" data-cancel="${r.id}">Annulla richiesta</button></div>` : ""}
      </article>`;
    };
    const coming = d.jobs.filter((j) => jobEndOf(j) >= today).reverse(), past = d.jobs.filter((j) => jobEndOf(j) < today);
    const open = d.requests.filter((r) => r.status === "new"), answered = d.requests.filter((r) => r.status !== "new" && !(r.status === "accepted" && d.jobs.some((j) => j.requestId === r.id)));
    $("#pt-main").innerHTML = `
      <div class="view-head"><div><h1>Ciao, ${esc(me.name.split(" ")[0])}</h1><p>${esc(me.clientName || me.company || "")}</p></div>
        <div class="view-actions"><button class="btn primary" type="button" id="pt-new">${ICON.plus || ""}Richiedi persone</button></div></div>
      <h2 class="pt-h">Persone inviate${coming.length ? ` · ${coming.length}` : ""}</h2>
      ${coming.length ? coming.map(job).join("") : `<p class="muted pt-empty">Nessun lavoro in programma. Quando l'ufficio accetta una richiesta, qui vedi chi viene, quando e dove.</p>`}
      <h2 class="pt-h">Richieste in attesa${open.length ? ` · ${open.length}` : ""}</h2>
      ${open.length ? open.map(req).join("") : `<p class="muted pt-empty">Nessuna richiesta in attesa.</p>`}
      ${answered.length ? `<h2 class="pt-h">Altre richieste</h2>${answered.map(req).join("")}` : ""}
      ${past.length ? `<h2 class="pt-h">Lavori passati · ${past.length}</h2>${past.map(job).join("")}` : ""}`;
    $("#pt-new").addEventListener("click", () => {
      for (const id of ["rq-title", "rq-end", "rq-call", "rq-wrap", "rq-loc", "rq-notes"]) $("#" + id).value = "";
      $("#rq-date").value = addDays(today, 7); $("#rq-date").min = today; $("#rq-models").value = 1; $("#rq-techs").value = 0;
      showErr($("#rq-err"), ""); openSheet("#d-request");
    });
    $$("#pt-main [data-cancel]").forEach((b) => b.addEventListener("click", () => armed(b, "Tocca di nuovo per annullare", async () => {
      try { await api(`/api/client/requests/${b.dataset.cancel}/cancel`, {}); toast("Richiesta annullata"); } catch (x) { toast(x.status ? x.msg : "Nessuna connessione."); }
      loadPortal();
    })));
  }
  $("#d-request form").addEventListener("submit", (e) => {
    e.preventDefault();
    attempt(e.currentTarget, $("#rq-err"), async () => {
      await api("/api/client/requests", { body: { title: $("#rq-title").value.trim(), date: $("#rq-date").value, endDate: $("#rq-end").value, call: $("#rq-call").value, wrap: $("#rq-wrap").value,
        location: $("#rq-loc").value.trim(), models: $("#rq-models").value, technicians: $("#rq-techs").value, notes: $("#rq-notes").value.trim() } });
      $("#d-request").close(); toast("Richiesta inviata all'ufficio");
      loadPortal();
    }).catch(() => {});
  });
  $("#pt-out").addEventListener("click", () => logout());
  $("#pt-pass").addEventListener("click", () => { $("#cp-cur").value = ""; $("#cp-new").value = ""; showErr($("#cp-err"), ""); openSheet("#d-password"); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && me?.role === "client" && !$("#portal").hidden && !$$("dialog[open]").length) loadPortal(); });

  // ---------- Sign up ----------
  let sgKind = "staff";
  function paintSignup() {
    $$("#sg-kind button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === sgKind)));
    $("#sg-company-wrap").hidden = sgKind !== "client"; $("#sg-wants-wrap").hidden = sgKind !== "staff";
    $("#sg-sub").textContent = sgKind === "client" ? "Per le aziende: richiedi modelli/e e tecnici e vedi chi ti viene inviato." : "Per modelli/e e tecnici. L'ufficio approva l'iscrizione prima che tu possa entrare.";
  }
  $("#sg-kind").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { sgKind = b.dataset.kind; paintSignup(); } });
  $("#go-signup").addEventListener("click", (e) => { e.preventDefault(); paintSignup(); showErr($("#sg-err"), ""); showAuth("signup"); });
  $("#go-login").addEventListener("click", (e) => { e.preventDefault(); showAuth("login"); });
  $("#signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#sg-err"), btn = $("#sg-btn");
    showErr(err, ""); btn.disabled = true;
    try {
      const r = await api("/api/signup", { body: { kind: sgKind, name: $("#sg-name").value.trim(), company: $("#sg-company").value.trim(), wants: $("#sg-wants").value, phone: $("#sg-phone").value.trim(), username: $("#sg-user").value.trim(), password: $("#sg-pass").value } });
      $("#sg-pass").value = "";
      await enter(r.user);
    } catch (x) { showErr(err, x.status ? x.msg : "Nessuna connessione. Devi essere online per registrarti."); }
    finally { btn.disabled = false; }
  });

  // ---------- Boot ----------
  window.addEventListener("online", () => { sync.online = true; kickSync(0); });
  window.addEventListener("offline", () => { sync.online = false; paintSync(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") kickSync(0); });
  setInterval(() => { if (navigator.onLine && document.visibilityState === "visible") runSync(); }, 45000);
  setInterval(() => { if (!$$("dialog[open]").length && ui.tab === "team") render(); else paintSync(); }, 60000);
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; if (ui.tab === "settings") renderSettings(); });

  $("#today").textContent = new Date().toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" });

  // Office site (admins) or team site (staff): adjust the sign-in screen to match.
  async function loadSite() {
    let site = await meta.get("site").catch(() => null);
    try { const r = await fetch("/api/site", { credentials: "same-origin" }); if (r.ok) { site = await r.json(); await meta.set("site", site); } } catch { /* offline: use the saved copy */ }
    if (!site) return;
    const host = (u) => (u ? u.replace(/^https?:\/\//, "") : "");
    const other = $("#li-other");
    if (site.site === "admin") {
      $("#auth-site").textContent = "Ufficio";
      $("#li-title").textContent = "Accesso ufficio";
      $("#li-sub").textContent = "Per gli amministratori dell'agenzia: persone, tariffe, lavori e pagamenti.";
      if (site.clientUrl) { other.hidden = false; other.innerHTML = `Modello/a o tecnico? Accedi su <a href="${esc(site.clientUrl)}">${esc(host(site.clientUrl))}</a>`; }
    } else if (site.site === "client") {
      $("#auth-site").textContent = "Squadra e clienti";
      $("#li-sub").textContent = "Per chi lavora con l'agenzia e per i clienti.";
      if (site.adminUrl) { other.hidden = false; other.innerHTML = `Amministratore dell'agenzia? Usa <a href="${esc(site.adminUrl)}">${esc(host(site.adminUrl))}</a>`; }
    }
    $("#su-code-wrap").hidden = !site.setupCode;
    $("#li-signup").hidden = !site.signups;
  }

  async function boot() {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    await loadSite();
    await loadState();
    sync.last = (await meta.get("lastSync")) || 0;
    const cached = await meta.get("me");
    try {
      const r = await fetch("/api/me", { credentials: "same-origin" });
      if (r.ok) {
        const j = await r.json();
        if (j.needsSetup) return showAuth("setup");
        return enter(j.user);
      }
      if (r.status === 401) {
        if (cached && pendingKeys.size) { me = cached; sync.authLost = true; return enter(cached).then(() => { sync.authLost = true; paintSync(); }); }
        return showAuth("login");
      }
      throw new Error("server " + r.status);
    } catch {
      // Offline (or server unreachable): open with what's on this device.
      if (cached && usesPortal(cached)) return showPortal(cached);
      if (cached) { sync.online = false; me = cached; $("#auth").hidden = true; $("#app").hidden = false;
        $("#me-chip").innerHTML = `<div><b>${esc(cached.name)}</b>${cached.role === "admin" ? "Amministratore" : "Collaboratore"}</div>`;
        route(); return; }
      showAuth("login");
      showErr($("#li-err"), "Nessuna connessione. Accedi una volta mentre sei online, poi l'app funziona anche offline.");
    }
  }
  boot();
})();
