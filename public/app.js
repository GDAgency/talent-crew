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
  const locale = navigator.language || "en-GB";
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  const byName = (a, b) => (a.name || "").localeCompare(b.name || "", locale);

  const ICON = {
    pin: `<svg viewBox="0 0 24 24"><path d="M12 21s-6.5-5.8-6.5-11A6.5 6.5 0 0 1 18.5 10c0 5.2-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>`,
    clock: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>`,
    cam: `<svg viewBox="0 0 24 24"><path d="M4 8h3l1.6-2.5h6.8L17 8h3v11H4z"/><circle cx="12" cy="13.2" r="3.6"/></svg>`,
    card: `<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12.5" rx="2"/><path d="M3 10h18M7 15h3"/></svg>`,
    doc: `<svg viewBox="0 0 24 24"><path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4"/></svg>`,
    receipt: `<svg viewBox="0 0 24 24"><path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/></svg>`,
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
  const COLLS = ["people", "shifts", "payments", "receipts", "jobs"];
  const state = { people: [], shifts: [], payments: [], receipts: [], jobs: [], settings: { currency: "EUR" } };
  const ui = { tab: "team", role: "all", q: "", hPerson: "", hMonth: isoMonth(), rStatus: "pending", rPerson: "", pPerson: "" };
  let me = null;
  let pendingKeys = new Set();        // records with changes not yet on the server
  let localPhotos = new Map();        // receipt id -> { url, uploaded }
  let sync = { busy: false, online: navigator.onLine, last: 0, error: null, authLost: false };
  const isAdmin = () => me?.role === "admin";
  const mine = (r) => isAdmin() || r.by === me?.id;

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

  // ---------- Server ----------
  async function api(path, { method = "POST", body, blob } = {}) {
    const headers = { "x-tc": "1" };
    if (blob) headers["content-type"] = blob.type;
    else if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(path, { method, headers, credentials: "same-origin", body: blob || (body !== undefined ? JSON.stringify(body) : undefined) });
    let j = null;
    try { j = await r.json(); } catch { /* empty */ }
    if (!r.ok) throw Object.assign(new Error(j?.error || "Request failed"), { status: r.status, msg: j?.error });
    return j;
  }

  let syncTimer = null;
  function kickSync(delay = 400) { clearTimeout(syncTimer); syncTimer = setTimeout(runSync, delay); }

  let syncAgain = false;
  async function runSync() {
    if (!me || sync.authLost) return;
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
        if (res.denied) toast(res.denied === 1 ? "One change wasn't allowed for your account and was undone." : `${res.denied} changes weren't allowed for your account and were undone.`);
        if (res.more || after.length > sent.length) syncAgain = true;
        await loadState();
        render();
      } while (syncAgain && ++loops < 20);
      await uploadPhotos();
      sync.last = Date.now(); sync.error = null;
      await meta.set("lastSync", sync.last);
    } catch (e) {
      if (e.status === 401) { sync.authLost = true; }
      else if (e.status) { sync.error = e.msg || "The server refused the sync."; }
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
          toast(`A receipt photo couldn't be stored: ${e.msg || "rejected by the server"}`);
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
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    const d = Math.floor(s / 86400);
    if (d < 7) return d === 1 ? "yesterday" : d + " days ago";
    return new Date(ms).toLocaleDateString(locale, { day: "numeric", month: "short" });
  }
  const personName = (id) => state.people.find((p) => p.id === id)?.name || "Removed person";
  const roleLabel = (r) => (r === "technician" ? "Technician" : "Model");
  const unsyncedTag = (c, id) => (pendingKeys.has(c + "/" + id) ? `<span class="unsynced">On this device</span>` : "");

  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200);
  }
  const showErr = (el, msg) => { el.textContent = msg || ""; el.hidden = !msg; };

  // ---------- Money ----------
  function balances() {
    const map = new Map();
    for (const p of state.people) map.set(p.id, { earned: 0, paid: 0, rec: 0, recN: 0, hMonth: 0, hAll: 0 });
    const m = isoMonth();
    for (const s of state.shifts) {
      const b = map.get(s.personId); if (!b) continue;
      const h = Number(s.hours) || 0;
      b.earned += shiftPay(s).amount; b.hAll += h;
      if ((s.date || "").startsWith(m)) b.hMonth += h;
    }
    for (const p of state.payments) { const b = map.get(p.personId); if (b) b.paid += Number(p.amount) || 0; }
    for (const r of state.receipts) { const b = map.get(r.personId); if (b && r.status !== "reimbursed") { b.rec += Number(r.amount) || 0; b.recN++; } }
    for (const b of map.values()) { b.wageDue = round2(b.earned - b.paid); b.owed = round2(b.wageDue + b.rec); }
    return map;
  }
  const statusPill = (b) => b.owed > 0.004 ? `<span class="pill owed">Owed</span>` : b.owed < -0.004 ? `<span class="pill over">Overpaid</span>` : `<span class="pill paid">Paid up</span>`;

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
  const countsForPay = () => true;
  const fmtMult = (m) => (Math.round(m * 100) / 100).toLocaleString(locale) + "×";
  function termsText(t) {
    const parts = t.payType === "day"
      ? [`${money(t.dayRate)} a day`, ...(t.halfDayRate && t.halfDayUnder ? [`${money(t.halfDayRate)} half day under ${hrs(t.halfDayUnder)}`] : [])]
      : [`${money(t.rate)} / h`];
    if (t.otAfter) parts.push(`overtime after ${hrs(t.otAfter)} at ${fmtMult(t.otMult)}${t.payType === "day" ? ` of ${money(t.rate)} / h` : ""}`);
    return parts.join(" · ");
  }
  // "8 h × €25.00 + 2 h overtime × €25.00 × 1.5 = €275.00", "Day rate €400.00", …
  function payExplain(hours, t, total = true) {
    const p = payCalc(hours, t);
    const ot = p.overtimeHours ? ` + ${hrs(p.overtimeHours)} overtime × ${money(t.rate)} × ${(Math.round(t.otMult * 100) / 100).toLocaleString(locale)}` : "";
    if (t.payType === "day") {
      const base = p.basis === "half-day" ? `Half day (under ${hrs(t.halfDayUnder)}) ${money(t.halfDayRate)}` : `Day rate ${money(t.dayRate)}`;
      return base + ot + (ot && total ? ` = ${money(p.amount)}` : "");
    }
    return `${hrs(p.regularHours)} × ${money(t.rate)}${ot}${total ? ` = ${money(p.amount)}` : ""}`;
  }
  const otSub = (s) => { const o = shiftPay(s).overtimeHours; return o ? `<span class="sub">${hrs(o)} overtime</span>` : ""; };
  const rateCell = (t) => (t.payType === "day" ? `${money(t.dayRate)}<span class="sub">a day</span>` : money(t.rate));

  // ---------- Rendering ----------
  function render() {
    if (!me) return;
    const bal = balances();
    const recOpen = state.receipts.filter((r) => r.status !== "reimbursed" && bal.has(r.personId));
    const navRec = $("#nav-rec"); navRec.textContent = recOpen.length; navRec.hidden = !recOpen.length;
    $$(".admin").forEach((el) => (el.hidden = !isAdmin()));
    fillFilters();
    if (ui.tab === "team") renderTeam(bal, recOpen);
    if (ui.tab === "hours") renderHours();
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
    for (const s of state.shifts) if ((s.date || "").startsWith(m) && bal.has(s.personId)) earnedMonth += shiftPay(s).amount;
    const today = isoDay();
    for (const p of state.people) if (p.location && p.locationAt && isoDay(new Date(p.locationAt)) === today) onJob++;
    const owedPeople = [...bal.values()].filter((b) => b.owed > 0.004).length;
    const recSum = recOpen.reduce((a, r) => a + (Number(r.amount) || 0), 0);
    $("#summary").innerHTML = `
      <div><span class="eyebrow">Owed to the team</span><span class="big ${owed > 0.004 ? "" : "zero"}">${money(owed)}</span><span class="note">${owedPeople ? `${owedPeople} ${owedPeople === 1 ? "person" : "people"} waiting to be paid` : "Everyone is paid up"}</span></div>
      <div><span class="eyebrow">Hours</span><span class="mid">${hrs(hMonth)}</span><span class="note">${money(earnedMonth)} in ${new Date().toLocaleDateString(locale, { month: "long" })}</span></div>
      <div><span class="eyebrow">Receipts</span><span class="mid">${money(recSum)}</span><span class="note">${recOpen.length} to reimburse</span></div>
      <div><span class="eyebrow">Checked in</span><span class="mid">${onJob}<span class="muted">/${state.people.length}</span></span><span class="note">today${bookedTodayNote()}</span></div>`;

    const el = $("#board");
    if (!state.people.length) {
      el.innerHTML = isAdmin()
        ? empty("No one on the books yet", "Add your models and technicians with their hourly rate. Then the team can log hours, check in their location and photograph receipts.", "add-person", "Add the first person")
        : empty("No one on the books yet", "An admin needs to add the team before hours and receipts can be logged.");
      return;
    }
    const q = ui.q.trim().toLowerCase();
    let list = state.people.slice().sort(byName);
    if (ui.role === "model" || ui.role === "technician") list = list.filter((p) => (p.role || "model") === ui.role);
    if (ui.role === "owed") list = list.filter((p) => (bal.get(p.id)?.owed || 0) > 0.004);
    if (q) list = list.filter((p) => [p.name, p.location, p.speciality].some((v) => (v || "").toLowerCase().includes(q)));
    if (!list.length) { el.innerHTML = empty("Nobody matches", "Try a different filter or search."); return; }
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
            ${statusPill(b)}
          </div>
          <div class="where ${live ? "live" : ""}">${ICON.pin}
            <div class="txt">${p.location ? `<div class="loc">${esc(p.location)}</div><div class="ago">Updated ${ago(p.locationAt)}</div>` : `<div class="loc unknown">Location unknown</div>`}</div>
            <button class="btn quiet sm" type="button" data-act="loc" data-id="${p.id}">Update</button>
          </div>
          ${bookingLine(p.id)}
        </div>
        <div class="figs">
          <div><span class="k">This month</span><span class="v ${b.hMonth ? "" : "zero"}">${hrs(b.hMonth)}</span></div>
          <div><span class="k">Receipts</span><span class="v ${b.rec ? "" : "zero"}">${money(b.rec)}</span></div>
          <div><span class="k">Owed</span><span class="v ${b.owed > 0.004 ? "owed" : "zero"}">${money(b.owed)}</span></div>
        </div>
        <div class="comp-acts">
          <button class="btn sm" type="button" data-act="add-shift" data-id="${p.id}">${ICON.clock}Hours</button>
          <button class="btn sm" type="button" data-act="add-receipt" data-id="${p.id}">${ICON.cam}Receipt</button>
          ${isAdmin() ? `<button class="btn sm" type="button" data-act="add-payment" data-id="${p.id}" ${b.owed > 0.004 ? "" : "disabled"}>${ICON.card}Pay</button>
          <button class="btn quiet sm end" type="button" data-act="edit-person" data-id="${p.id}">Edit</button>` : ""}
        </div>
      </article>`;
    }).join("")}</div>`;
  }

  function fillFilters() {
    const people = state.people.slice().sort(byName);
    const opts = `<option value="">Everyone</option>` + people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    for (const [sel, key] of [["#h-person", "hPerson"], ["#r-person", "rPerson"], ["#p-person", "pPerson"]]) {
      const el = $(sel);
      if (el.dataset.sig !== opts) { el.innerHTML = opts; el.dataset.sig = opts; }
      if (ui[key] && !people.some((p) => p.id === ui[key])) ui[key] = "";
      el.value = ui[key];
    }
    $("#h-month").value = ui.hMonth;
  }

  const shiftsShown = () => state.shifts
    .filter((s) => (!ui.hPerson || s.personId === ui.hPerson) && (!ui.hMonth || (s.date || "").startsWith(ui.hMonth)))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));

  function renderHours() {
    const el = $("#hours");
    const rows = shiftsShown();
    if (!rows.length) {
      el.innerHTML = state.people.length
        ? empty(ui.hMonth ? "No hours logged for this month" : "No hours logged yet", "Log a call and wrap time, or just the hours. It works without signal and syncs when you're back online.", "add-shift", "Log hours")
        : empty("Add people first", isAdmin() ? "Hours are logged against someone on the board." : "An admin needs to add the team first.", isAdmin() ? "add-person" : null, "Add person");
      return;
    }
    let th = 0, tv = 0;
    for (const s of rows) { th += Number(s.hours) || 0; tv += shiftPay(s).amount; }
    const period = ui.hMonth ? new Date(ui.hMonth + "-01T12:00").toLocaleDateString(locale, { month: "long", year: "numeric" }) : "all time";
    el.innerHTML = `<div class="tablebox hours-table"><table>
      <thead><tr><th>Date</th><th>Person</th><th>Job · location</th><th class="n">Call–wrap</th><th class="n">Hours</th><th class="n">Rate</th><th class="n">Earned</th><th></th></tr></thead>
      <tbody>${rows.map((s) => `<tr>
        <td>${fmtShort(s.date)}${unsyncedTag("shifts", s.id) ? `<span class="sub">${unsyncedTag("shifts", s.id)}</span>` : ""}</td>
        <td class="who">${esc(personName(s.personId))}</td>
        <td>${esc(s.job || "—")}${s.location ? `<span class="sub">${esc(s.location)}</span>` : ""}</td>
        <td class="n">${s.start && s.end ? `${esc(s.start)}–${esc(s.end)}` : `<span class="muted">—</span>`}</td>
        <td class="n">${hrs(s.hours)}${otSub(s)}</td>
        <td class="n">${rateCell(shiftTerms(s))}</td>
        <td class="n">${money(shiftPay(s).amount)}</td>
        <td class="n">${mine(s) ? `<button class="btn quiet sm" type="button" data-act="edit-shift" data-id="${s.id}">Edit</button>` : ""}</td>
      </tr>`).join("")}</tbody>
      <tfoot><tr><td colspan="4">${rows.length} ${rows.length === 1 ? "entry" : "entries"} · ${esc(period)}</td><td class="n">${hrs(th)}</td><td></td><td class="n">${money(tv)}</td><td></td></tr></tfoot>
    </table></div>
    <div class="list">${rows.map((s) => `<button class="list-row" type="button" ${mine(s) ? `data-act="edit-shift" data-id="${s.id}"` : ""}>
        <span class="a">${esc(personName(s.personId))}</span><span class="b">${hrs(s.hours)}</span>
        <span class="c">${fmtShort(s.date)}${s.job ? " · " + esc(s.job) : ""}${s.location ? " · " + esc(s.location) : ""} ${unsyncedTag("shifts", s.id)}</span><span class="d">${money(shiftPay(s).amount)}</span>
      </button>`).join("")}
      <div class="list-foot"><span>${hrs(th)}</span><span>${money(tv)}</span></div>
    </div>`;
  }

  const receiptsShown = () => state.receipts
    .filter((r) => (ui.rStatus === "all" || (ui.rStatus === "reimbursed" ? r.status === "reimbursed" : r.status !== "reimbursed")) && (!ui.rPerson || r.personId === ui.rPerson))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));

  function photoSrc(r) {
    const local = localPhotos.get(r.id);
    if (local) return local.url;
    if (r.photoUploaded) return "/api/photos/" + encodeURIComponent(r.id);
    return null;
  }
  function shot(r) {
    const local = localPhotos.get(r.id);
    const waiting = local && !local.uploaded ? `<span class="pill wait flag">Photo not uploaded yet</span>` : "";
    if (!r.hasPhoto) return `<span class="ph">${ICON.receipt}No photo</span>`;
    if (r.photoType === "application/pdf") return `<span class="ph">${ICON.doc}PDF receipt</span>${waiting}`;
    const src = photoSrc(r);
    if (!src) return `<span class="ph">${ICON.cam}Photo on another phone, not uploaded yet</span>`;
    return `<img src="${esc(src)}" alt="Receipt: ${esc(r.description || "photo")}" loading="lazy">${waiting}`;
  }

  function renderReceipts() {
    const el = $("#receipts");
    const rows = receiptsShown();
    if (!rows.length) {
      el.innerHTML = ui.rStatus === "pending"
        ? empty("Nothing waiting to be paid back", "When someone pays for a taxi, a meal or supplies on a job, photograph the receipt here. It's added to what they're owed.", state.people.length ? "add-receipt" : null, "Photograph a receipt")
        : empty("No receipts here", "Receipts appear here once they're added.");
      return;
    }
    const total = rows.reduce((a, r) => a + (Number(r.amount) || 0), 0);
    el.innerHTML = `<p class="totals-line">${rows.length} ${rows.length === 1 ? "receipt" : "receipts"} · <span class="mono">${money(total)}</span></p>
      <div class="rgrid">${rows.map((r) => `<article class="receipt">
        <button class="shot" type="button" data-act="view-receipt" data-id="${r.id}" aria-label="Open receipt">${shot(r)}</button>
        <div class="meta">
          <div class="amt"><b>${money(r.amount)}</b>${r.status === "reimbursed" ? `<span class="pill paid">Reimbursed</span>` : `<span class="pill owed">To reimburse</span>`}</div>
          <div class="what">${esc(r.description || "No description")}</div>
          <div class="by">${[esc(personName(r.personId)), fmtShort(r.date)].filter(Boolean).join(" · ")} ${unsyncedTag("receipts", r.id)}</div>
        </div>
      </article>`).join("")}</div>`;
  }

  function renderPayments() {
    const el = $("#payments");
    const rows = state.payments.filter((p) => !ui.pPerson || p.personId === ui.pPerson)
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
    if (!rows.length) {
      el.innerHTML = empty("No payments recorded", "Record each payment as it goes out, so the board shows who's been paid and what's still owed.", isAdmin() && state.people.length ? "add-payment" : null, "Record a payment");
      return;
    }
    let total = 0;
    el.innerHTML = `<div class="tablebox"><table>
      <thead><tr><th>Date</th><th>Paid to</th><th>Method · note</th><th class="n">Wages</th><th class="n">Receipts</th><th class="n">Total</th><th></th></tr></thead>
      <tbody>${rows.map((p) => {
        const rec = Number(p.receiptsAmount) || 0, t = (Number(p.amount) || 0) + rec; total += t;
        const n = p.receiptIds?.length || 0;
        return `<tr>
          <td>${fmtShort(p.date)}${unsyncedTag("payments", p.id) ? `<span class="sub">${unsyncedTag("payments", p.id)}</span>` : ""}</td>
          <td class="who">${esc(personName(p.personId))}</td>
          <td>${esc(p.method || "")}${p.note ? `<span class="sub">${esc(p.note)}</span>` : ""}</td>
          <td class="n">${money(p.amount)}</td>
          <td class="n">${rec ? `${money(rec)}<span class="sub">${n} receipt${n === 1 ? "" : "s"}</span>` : `<span class="muted">—</span>`}</td>
          <td class="n">${money(t)}</td>
          <td class="n">${isAdmin() ? `<button class="btn quiet sm danger" type="button" data-act="del-payment" data-id="${p.id}">Delete</button>` : ""}</td>
        </tr>`;
      }).join("")}</tbody>
      <tfoot><tr><td colspan="5">${rows.length} ${rows.length === 1 ? "payment" : "payments"}</td><td class="n">${money(total)}</td><td></td></tr></tfoot>
    </table></div>`;
  }

  // ---------- Settings ----------
  let accounts = null, accountsErr = null;
  async function loadAccounts() {
    if (!isAdmin()) return;
    try { accounts = (await api("/api/users", { method: "GET" })).users; accountsErr = null; }
    catch (e) { accountsErr = e.status ? e.msg : "Connect to the internet to manage logins."; }
    if (ui.tab === "settings") renderSettings();
  }
  let installEvt = null;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  async function renderSettings() {
    const ob = await idb.count("outbox");
    const ph = (await idb.all("photos")).filter((p) => !p.uploaded).length;
    const el = $("#settings");
    const installPanel = standalone() ? `<p>Installed on this device. It opens full-screen and works without signal.</p>`
      : installEvt ? `<p>Install it on this device to open it like an app and use it without signal.</p><div><button class="btn primary" type="button" id="install-btn">Install app</button></div>`
      : isIOS ? `<p>On iPhone or iPad: tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b>. It will then open like an app and work without signal.</p>`
      : `<p>In Chrome or Edge, use the install icon in the address bar, or the menu's <b>Install app</b> / <b>Add to Home screen</b>. On iPhone use Safari's <b>Share → Add to Home Screen</b>.</p>`;
    const ag = document.activeElement?.id === "agency" ? document.activeElement : null;
    const agencyDraft = ag ? [ag.value, ag.selectionStart ?? ag.value.length] : null; // keep typing across a background redraw
    el.innerHTML = `
      <section class="panel">
        <h2>Your account</h2>
        <dl class="kv"><dt>Name</dt><dd>${esc(me.name)}</dd><dt>Username</dt><dd class="mono">${esc(me.username)}</dd><dt>Access</dt><dd>${isAdmin() ? "Admin" : "Staff"}</dd></dl>
        <div class="sheet-foot"><button class="btn" type="button" data-act="password">Change password</button><button class="btn danger" type="button" id="logout-btn">Sign out</button></div>
      </section>
      <section class="panel">
        <h2>This device</h2>
        <dl class="kv">
          <dt>Connection</dt><dd>${sync.online ? "Online" : "Offline"}</dd>
          <dt>Waiting to send</dt><dd>${ob ? `${ob} change${ob === 1 ? "" : "s"}` : "Nothing"}${ph ? ` · ${ph} photo${ph === 1 ? "" : "s"}` : ""}</dd>
          <dt>Last synced</dt><dd>${sync.last ? ago(sync.last) : "Not yet"}</dd>
        </dl>
        <div><button class="btn" type="button" data-act="sync-now">Sync now</button></div>
      </section>
      <section class="panel"><h2>Use it as an app</h2>${installPanel}</section>
      ${isAdmin() ? `<section class="panel">
        <h2>Currency</h2>
        <div class="field"><label for="currency">Amounts are shown in</label>
          <select id="currency">${[["EUR", "Euro (€)"], ["GBP", "Pound (£)"], ["USD", "US dollar ($)"], ["CHF", "Swiss franc (CHF)"]].map(([v, l]) => `<option value="${v}" ${state.settings.currency === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      </section>
      <section class="panel">
        <h2>Statements</h2>
        <div class="field"><label for="agency">Agency name</label><input id="agency" maxlength="80" autocomplete="organization" placeholder="Talent &amp; Crew" value="${esc(state.settings.agencyName || "")}"><span class="hint">Printed at the top of every statement.</span></div>
      </section>
      <section class="panel wide">
        <div class="view-head"><div><h2>Team logins</h2><p>Staff can log hours, add receipts and update locations. Admins also manage people, rates and payments.</p></div>
          <div class="view-actions"><button class="btn primary" type="button" data-act="add-account">Add login</button></div></div>
        <div id="acct-list">${accountsErr ? `<p class="err">${esc(accountsErr)}</p>` : !accounts ? `<p class="muted">Loading…</p>` : accounts.map((a) => `<div class="acct">
          <div><div class="nm">${esc(a.name)} ${a.disabled ? `<span class="pill over">Disabled</span>` : ""}</div><div class="un">${esc(a.username)} · ${a.role === "admin" ? "Admin" : "Staff"}</div></div>
          <div class="ctl">
            <button class="btn sm" type="button" data-act="reset-pw" data-id="${a.id}">Reset password</button>
            ${a.id === me.id ? "" : `<button class="btn sm" type="button" data-act="toggle-role" data-id="${a.id}">${a.role === "admin" ? "Make staff" : "Make admin"}</button>
            <button class="btn sm ${a.disabled ? "" : "danger"}" type="button" data-act="toggle-disabled" data-id="${a.id}">${a.disabled ? "Enable" : "Disable"}</button>`}
          </div></div>`).join("")}</div>
      </section>` : ""}`;
    $("#install-btn")?.addEventListener("click", async () => { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; renderSettings(); });
    $("#currency")?.addEventListener("change", (e) => save("settings", { ...state.settings, id: "main", currency: e.target.value }).then(() => toast("Currency saved")));
    if (agencyDraft && $("#agency")) { const a = $("#agency"); a.value = agencyDraft[0]; a.focus(); a.setSelectionRange(agencyDraft[1], agencyDraft[1]); }
    $("#agency")?.addEventListener("change", (e) => save("settings", { ...state.settings, id: "main", agencyName: e.target.value.trim().slice(0, 80) }).then(() => toast("Agency name saved")));
    $("#logout-btn").addEventListener("click", (e) => logout(e.currentTarget, ob + ph));
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
    $("#dt-body").innerHTML = `
      <dl class="kv">
        <dt>Role</dt><dd>${roleLabel(p.role)}${p.speciality ? " · " + esc(p.speciality) : ""}</dd>
        <dt>Pay</dt><dd class="mono">${esc(termsText(payTerms(p)))}</dd>
        <dt>Location</dt><dd>${p.location ? `${esc(p.location)} <span class="muted">· ${ago(p.locationAt)}</span>` : `<span class="muted">Unknown</span>`}</dd>
        ${p.phone ? `<dt>Phone</dt><dd class="mono">${esc(p.phone)}</dd>` : ""}
      </dl>
      <div class="detail-figs">
        <div><span class="eyebrow">Earned</span><span class="v">${money(b.earned)}</span></div>
        <div><span class="eyebrow">Wages paid</span><span class="v">${money(b.paid)}</span></div>
        <div><span class="eyebrow">Receipts owed</span><span class="v">${money(b.rec)}</span></div>
        <div><span class="eyebrow">Owed now</span><span class="v ${b.owed > 0.004 ? "owed" : "paid"}">${money(b.owed)}</span></div>
      </div>
      <div class="sheet-foot">
        <button class="btn sm" type="button" data-act="add-shift" data-id="${id}">${ICON.clock}Log hours</button>
        <button class="btn sm" type="button" data-act="add-receipt" data-id="${id}">${ICON.cam}Add receipt</button>
        <button class="btn sm" type="button" data-act="statement" data-id="${id}">${ICON.doc}Statement</button>
        ${isAdmin() ? `<button class="btn sm primary" type="button" data-act="add-payment" data-id="${id}" ${b.owed > 0.004 ? "" : "disabled"}>${ICON.card}Record payment</button>` : ""}
      </div>
      <h4 class="eyebrow">Hours · ${hrs(b.hAll)} all time</h4>
      ${shifts.length ? `<div class="tablebox"><table><thead><tr><th>Date</th><th>Job · location</th><th class="n">Hours</th><th class="n">Earned</th></tr></thead><tbody>
        ${shifts.slice(0, 60).map((s) => `<tr><td>${fmtShort(s.date)}</td><td>${esc(s.job || "—")}${s.location ? `<span class="sub">${esc(s.location)}</span>` : ""}</td><td class="n">${hrs(s.hours)}${otSub(s)}</td><td class="n">${money(shiftPay(s).amount)}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">No hours logged.</p>`}
      <h4 class="eyebrow">Receipts</h4>
      ${recs.length ? `<div class="tablebox"><table><thead><tr><th>Date</th><th>For</th><th class="n">Amount</th><th>Status</th></tr></thead><tbody>
        ${recs.map((r) => `<tr><td>${fmtShort(r.date)}</td><td><button class="btn quiet sm" type="button" data-act="view-receipt" data-id="${r.id}">${esc(r.description || "Receipt")}</button></td><td class="n">${money(r.amount)}</td><td>${r.status === "reimbursed" ? `<span class="pill paid">Reimbursed</span>` : `<span class="pill owed">To reimburse</span>`}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">No receipts.</p>`}
      <h4 class="eyebrow">Payments</h4>
      ${pays.length ? `<div class="tablebox"><table><thead><tr><th>Date</th><th>Method</th><th class="n">Wages</th><th class="n">Receipts</th></tr></thead><tbody>
        ${pays.map((x) => `<tr><td>${fmtShort(x.date)}</td><td>${esc(x.method || "")}${x.note ? `<span class="sub">${esc(x.note)}</span>` : ""}</td><td class="n">${money(x.amount)}</td><td class="n">${x.receiptsAmount ? money(x.receiptsAmount) : "—"}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">No payments yet.</p>`}`;
  }

  // ---------- Sync indicator ----------
  async function paintSync() {
    const el = $("#sync"), txt = $("#sync-txt"), banner = $("#banner");
    if (!el || !me) return;
    const n = pendingKeys.size + [...localPhotos.values()].filter((p) => !p.uploaded).length;
    let st = "ok", label = sync.last ? `Synced ${ago(sync.last)}` : "Up to date";
    if (sync.busy) { st = "syncing"; label = "Syncing…"; }
    else if (sync.authLost) { st = "error"; label = "Sign in to sync"; }
    else if (!sync.online) { st = "offline"; label = n ? `Offline · ${n} saved here` : "Offline"; }
    else if (sync.error) { st = "error"; label = "Sync problem"; }
    else if (n) { st = "syncing"; label = `${n} waiting to send`; }
    el.dataset.state = st; txt.textContent = label;
    el.title = sync.error || (st === "offline" ? "No connection. Everything you add is kept on this device and sent when you're back online." : "Sync now");

    const bt = $("#banner-btn");
    if (sync.authLost) {
      banner.hidden = false; banner.className = "banner risk";
      $("#banner-txt").textContent = n ? `Your sign-in has expired. Sign in again to send the ${n} change${n === 1 ? "" : "s"} saved on this device.` : "Your sign-in has expired. Sign in again to get the latest.";
      bt.hidden = false; bt.textContent = "Sign in"; bt.onclick = () => showAuth("login", true);
    } else if (!sync.online && n) {
      banner.hidden = false; banner.className = "banner";
      $("#banner-txt").textContent = `You're offline. ${n} change${n === 1 ? " is" : "s are"} saved on this device and will send when you're back online.`;
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
    if (isAdmin()) { toast("Add a person first"); openPerson(); } else toast("An admin needs to add the team first.");
    return true;
  }
  async function attempt(form, errEl, fn) {
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true; showErr(errEl, "");
    try { await fn(); }
    catch (e) { console.error(e); showErr(errEl, e.msg || "Couldn't save on this device. Free up some storage and try again."); }
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
      ["add-shift", ICON.clock, "Log hours", "Call, wrap and job"],
      ["add-receipt", ICON.cam, "Receipt", "Photograph an expense"],
      ["loc", ICON.pin, "Check in", "Update a location"],
    ];
    if (isAdmin()) opts.push(["add-payment", ICON.card, "Payment", "Record money paid"]);
    else opts.push(["goto-hours", ICON.clock, "My hours", "See what's logged"]);
    $("#quick").innerHTML = opts.map(([a, i, t, s]) => `<button type="button" data-act="${a}">${i}<div><b>${t}</b><span>${s}</span></div></button>`).join("");
    openSheet("#d-quick");
  }

  // Person pay terms (admin form). Returns the terms, or an error message.
  function personFormTerms() {
    const v = (id) => $(id).value.trim(), n = (id) => parseFloat($(id).value);
    const day = $("#pf-paytype").value === "day";
    const rate = day && v("#pf-rate") === "" ? 0 : n("#pf-rate");
    const otAfter = v("#pf-otafter") === "" ? 0 : n("#pf-otafter");
    const otMult = v("#pf-otmult") === "" ? 1.5 : n("#pf-otmult");
    if (!(rate >= 0)) return day ? "The hourly rate can't be negative." : "Enter an hourly rate. Use 0 for unpaid roles.";
    if (!(otAfter >= 0 && otAfter < 24)) return "Overtime starts after 0 to 24 hours. Leave it empty for no overtime.";
    if (otAfter && !(otMult >= 1 && otMult <= 5)) return "Overtime pays between 1× and 5× the hourly rate.";
    const t = { payType: day ? "day" : "hourly", rate: round2(rate), dayRate: 0, halfDayRate: 0, halfDayUnder: 0, otAfter: round2(otAfter), otMult: otMult >= 1 && otMult <= 5 ? round2(otMult) : 1.5 };
    if (!day) return t;
    const dr = n("#pf-dayrate"), hr = v("#pf-halfrate") === "" ? 0 : n("#pf-halfrate"), hu = v("#pf-halfunder") === "" ? 0 : n("#pf-halfunder");
    if (!(dr > 0)) return "Enter the day rate.";
    if (hr || hu) {
      if (!(hr > 0)) return "Enter the half-day rate, or clear the hours under it.";
      if (!(hu > 0 && hu <= 24)) return "Enter how many hours count as a half day.";
    }
    if (otAfter && !(rate > 0)) return "Enter the hourly rate overtime is paid at.";
    return { ...t, dayRate: round2(dr), halfDayRate: round2(hr), halfDayUnder: round2(hu) };
  }
  function fillPersonTerms(p) {
    const t = payTerms(p);
    $("#pf-paytype").value = t.payType;
    $("#pf-dayrate").value = t.dayRate || "";
    $("#pf-halfrate").value = t.halfDayRate || ""; $("#pf-halfunder").value = t.halfDayUnder || "";
    $("#pf-otafter").value = t.otAfter || ""; $("#pf-otmult").value = p.otMult ? t.otMult : 1.5;
    personTermsUI();
  }
  function personTermsUI() {
    const day = $("#pf-paytype").value === "day";
    $("#pf-day-wrap").hidden = $("#pf-half-wrap").hidden = !day;
    $('label[for="pf-rate"]').textContent = day ? "Hourly rate for overtime" : "Hourly rate";
    $("#pf-rate").placeholder = day ? "Only for overtime" : "";
    const t = personFormTerms();
    $("#pf-terms").textContent = typeof t === "string" ? "" : `Pays ${termsText(t)}. Each shift keeps the terms it was logged under.`;
  }
  $("#d-person form").addEventListener("input", personTermsUI);
  $("#pf-paytype").addEventListener("change", personTermsUI);

  // Person
  let editingPerson = null;
  function openPerson(id) {
    if (!isAdmin()) return;
    editingPerson = id || null;
    const p = state.people.find((x) => x.id === id) || {};
    $("#pf-title").textContent = id ? `Edit ${p.name}` : "Add person";
    $("#pf-name").value = p.name || ""; $("#pf-role").value = p.role || "model"; $("#pf-rate").value = p.rate ?? "";
    fillPersonTerms(p);
    $("#pf-spec").value = p.speciality || ""; $("#pf-loc").value = p.location || ""; $("#pf-phone").value = p.phone || "";
    $("#pf-del").hidden = !id; disarm($("#pf-del"), "Delete");
    showErr($("#pf-err"), "");
    openSheet("#d-person"); $("#pf-name").focus();
  }
  $("#d-person form").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.currentTarget, err = $("#pf-err");
    const name = $("#pf-name").value.trim();
    if (!name) return showErr(err, "Enter their name.");
    const terms = personFormTerms();
    if (typeof terms === "string") return showErr(err, terms);
    attempt(form, err, async () => {
      const prev = state.people.find((x) => x.id === editingPerson);
      const location = $("#pf-loc").value.trim();
      const data = { ...(prev || {}), name, role: $("#pf-role").value, ...terms, speciality: $("#pf-spec").value.trim(), phone: $("#pf-phone").value.trim(), location };
      if (!prev || (prev.location || "") !== location) data.locationAt = Date.now();
      await save("people", data);
      $("#d-person").close(); toast(prev ? "Saved" : `${name} added to the board`);
    });
  });
  $("#pf-del").addEventListener("click", (e) => {
    const btn = e.currentTarget, id = editingPerson;
    const related = ["shifts", "payments", "receipts"].flatMap((c) => state[c].filter((r) => r.personId === id).map((r) => [c, r]));
    armed(btn, related.length ? `Delete with ${related.length} records?` : "Tap again to delete", async () => {
      for (const [c, r] of related) await remove(c, r);
      await remove("people", state.people.find((p) => p.id === id));
      $("#d-person").close(); toast("Deleted");
    });
  });

  // Location check-in
  let locId = null;
  function openLoc(id) {
    if (needPeople()) return;
    locId = id || null;
    $("#lf-person-wrap").hidden = !!id;
    personOptions($("#lf-person"), id || state.people[0]?.id);
    const fill = () => { const p = state.people.find((x) => x.id === (locId || $("#lf-person").value)); $("#lf-who").textContent = p ? p.name.split(" ")[0] : "they"; $("#lf-loc").value = p?.location || ""; };
    $("#lf-person").onchange = fill; fill();
    showErr($("#lf-err"), "");
    openSheet("#d-loc"); $("#lf-loc").focus(); $("#lf-loc").select();
  }
  $("#d-loc form").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = locId || $("#lf-person").value;
    attempt(e.currentTarget, $("#lf-err"), async () => {
      const p = state.people.find((x) => x.id === id);
      await save("people", { ...p, location: $("#lf-loc").value.trim(), locationAt: Date.now() });
      $("#d-loc").close(); toast(`${p.name.split(" ")[0]} checked in`);
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
    $('label[for="sf-rate"]').textContent = t.payType === "day" ? "Day rate" : "Rate per hour";
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
    $("#sf-title").textContent = shiftId ? "Edit hours" : "Log hours";
    $("#sf-date").value = s.date || isoDay();
    $("#sf-start").value = s.start || ""; $("#sf-end").value = s.end || "";
    $("#sf-hours").value = s.hours ?? "";
    setShiftTerms(shiftId ? shiftTerms(s) : payTerms(p));
    $("#sf-rate").readOnly = !isAdmin() && !!p; // staff use the agreed rate
    $("#sf-job").value = s.job || "";
    $("#sf-loc").value = shiftId ? s.location || "" : p?.location || "";
    $("#sf-del").hidden = !shiftId; disarm($("#sf-del"), "Delete");
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
    if (!date) return showErr(err, "Pick the date of the job.");
    if (!(hours > 0) || hours > 24) return showErr(err, "Enter between 0.25 and 24 hours, or fill in call and wrap.");
    if (!(rate >= 0)) return showErr(err, sfTerms.payType === "day" ? "Enter the day rate." : "Enter the hourly rate.");
    attempt(e.currentTarget, err, async () => {
      const prev = state.shifts.find((x) => x.id === editingShift);
      const personId = $("#sf-person").value, location = $("#sf-loc").value.trim();
      await save("shifts", { ...(prev || {}), personId, date, hours: round2(hours), ...shiftFormTerms(), start: $("#sf-start").value, end: $("#sf-end").value, job: $("#sf-job").value.trim(), location, jobId: $("#sf-jobid").value || "" });
      const p = state.people.find((x) => x.id === personId);
      if (!prev && date === isoDay() && location && p && (p.location || "") !== location) await save("people", { ...p, location, locationAt: Date.now() });
      $("#d-shift").close();
      toast(prev ? "Hours updated" : `${hrs(hours)} logged for ${personName(personId)}${sync.online ? "" : " · saved on this device"}`);
    });
  });
  $("#sf-del").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    armed(btn, "Tap again to delete", async () => {
      await remove("shifts", state.shifts.find((s) => s.id === editingShift));
      $("#d-shift").close(); toast("Entry deleted");
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
    if (blob.type.startsWith("image/")) { pickedUrl = URL.createObjectURL(blob); pv.innerHTML = `<img alt="Receipt preview" src="${pickedUrl}">`; }
    else pv.innerHTML = `<div class="pdf">${esc(name || "PDF")}</div>`;
    pv.insertAdjacentHTML("beforeend", `<button class="btn sm" type="button" id="rf-retake">Retake</button>`);
    $("#rf-retake").onclick = () => setPicked(null);
  }
  function openReceipt(personId) {
    if (needPeople()) return;
    personOptions($("#rf-person"), personId || ui.rPerson || state.people.slice().sort(byName)[0]?.id);
    setPicked(null);
    $("#rf-amount").value = ""; $("#rf-date").value = isoDay(); $("#rf-desc").value = "";
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
    if (!/^image\//.test(f.type) && f.type !== "application/pdf") return showErr($("#rf-err"), "Use a photo or a PDF.");
    showErr($("#rf-err"), "");
    const blob = await shrink(f);
    if (blob.size > 15 * 1024 * 1024) return showErr($("#rf-err"), "That file is over 15 MB. Take the photo again or pick a smaller file.");
    if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(blob.type)) return showErr($("#rf-err"), "This photo format can't be read here. Try taking it again, or save it as JPEG.");
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
    if (!(amount > 0)) return showErr(err, "Enter the amount on the receipt.");
    if (!date) return showErr(err, "Pick the date on the receipt.");
    attempt(e.currentTarget, err, async () => {
      const id = uid();
      if (picked) await idb.put("photos", { id, blob: picked, type: picked.type, uploaded: false, savedAt: Date.now() });
      await save("receipts", { id, personId: $("#rf-person").value, amount: round2(amount), date, description: $("#rf-desc").value.trim(), jobId: $("#rf-job").value || "", status: "pending", hasPhoto: !!picked, photoType: picked?.type || null, photoUploaded: false });
      $("#d-receipt").close(); setPicked(null);
      toast(`Receipt for ${money(amount)} saved${sync.online ? "" : " on this device"}`);
    });
  });

  function openView(id) {
    const r = state.receipts.find((x) => x.id === id); if (!r) return;
    $("#vw-title").textContent = `${money(r.amount)} · ${personName(r.personId)}`;
    const src = r.hasPhoto ? photoSrc(r) : null;
    const media = !r.hasPhoto ? `<div class="empty"><p>No photo was attached to this receipt.</p></div>`
      : !src ? `<div class="empty"><p>The photo is still on the phone that took it. It will appear once that phone is back online.</p></div>`
      : r.photoType === "application/pdf" ? `<div class="empty"><p>This receipt is a PDF.</p><a class="btn" href="${esc(src)}" target="_blank" rel="noopener">Open PDF</a></div>`
      : `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="Receipt photo"></a>`;
    const canChange = isAdmin() || (r.by === me.id && r.status !== "reimbursed");
    $("#vw-body").innerHTML = `${media}
      <dl class="kv">
        <dt>For</dt><dd>${esc(r.description || "—")}</dd>
        <dt>Paid by</dt><dd>${esc(personName(r.personId))}</dd>
        <dt>Date</dt><dd>${fmtDate(r.date)}</dd>
        ${receiptJobRow(r)}
        <dt>Status</dt><dd>${r.status === "reimbursed" ? `<span class="pill paid">Reimbursed${r.reimbursedAt ? " · " + fmtDate(r.reimbursedAt) : ""}</span>` : `<span class="pill owed">To reimburse</span>`}</dd>
      </dl>
      <div class="err" id="vw-err" hidden></div>
      ${canChange ? `<div class="sheet-foot">
        <button class="btn danger left" type="button" id="vw-del">Delete</button>
        ${isAdmin() ? (r.status === "reimbursed" ? `<button class="btn" type="button" id="vw-undo">Mark not reimbursed</button>` : `<button class="btn primary" type="button" id="vw-done">Mark reimbursed</button>`) : ""}
      </div>` : ""}`;
    $("#vw-done")?.addEventListener("click", async () => { await save("receipts", { ...r, status: "reimbursed", reimbursedAt: isoDay() }); $("#d-view").close(); toast("Marked reimbursed"); });
    $("#vw-undo")?.addEventListener("click", async () => { await save("receipts", { ...r, status: "pending", reimbursedAt: null }); $("#d-view").close(); toast("Back on the to-reimburse list"); });
    $("#vw-del")?.addEventListener("click", (e) => armed(e.currentTarget, "Tap again to delete", async () => {
      await idb.del("photos", r.id).catch(() => {});
      await remove("receipts", r); $("#d-view").close(); toast("Receipt deleted");
    }));
    openSheet("#d-view");
  }

  // Payments
  function payInfo() {
    const pid = $("#yf-person").value, b = balances().get(pid); if (!b) return;
    const open = state.receipts.filter((r) => r.personId === pid && r.status !== "reimbursed");
    $("#yf-bal").textContent = `Wages due ${money(Math.max(0, b.wageDue))}${b.rec ? ` · receipts ${money(b.rec)}` : ""} · owed ${money(b.owed)}`;
    $("#yf-amount").value = Math.max(0, b.wageDue).toFixed(2);
    $("#yf-rec-wrap").hidden = !open.length;
    $("#yf-rec-lbl").textContent = `Also pay back ${open.length} receipt${open.length === 1 ? "" : "s"} (${money(b.rec)}) in this payment`;
  }
  function openPay(personId) {
    if (!isAdmin() || needPeople()) return;
    const bal = balances();
    personOptions($("#yf-person"), personId || ui.pPerson || state.people.slice().sort(byName).find((p) => (bal.get(p.id)?.owed || 0) > 0.004)?.id || state.people[0]?.id);
    $("#yf-date").value = isoDay(); $("#yf-note").value = ""; $("#yf-rec").checked = true;
    showErr($("#yf-err"), ""); payInfo();
    openSheet("#d-pay");
  }
  $("#yf-person").addEventListener("change", payInfo);
  $("#d-pay form").addEventListener("submit", (e) => {
    e.preventDefault();
    const err = $("#yf-err");
    const pid = $("#yf-person").value, amount = parseFloat($("#yf-amount").value) || 0, date = $("#yf-date").value;
    const recs = $("#yf-rec-wrap").hidden || !$("#yf-rec").checked ? [] : state.receipts.filter((r) => r.personId === pid && r.status !== "reimbursed");
    const recAmt = round2(recs.reduce((a, r) => a + (Number(r.amount) || 0), 0));
    if (!date) return showErr(err, "Pick the payment date.");
    if (amount < 0) return showErr(err, "The amount can't be negative.");
    if (amount === 0 && !recs.length) return showErr(err, "Enter the wages paid, or tick the receipts box.");
    attempt(e.currentTarget, err, async () => {
      await save("payments", { personId: pid, date, amount: round2(amount), method: $("#yf-method").value, note: $("#yf-note").value.trim(), receiptIds: recs.map((r) => r.id), receiptsAmount: recAmt });
      for (const r of recs) await save("receipts", { ...r, status: "reimbursed", reimbursedAt: date });
      $("#d-pay").close(); toast(`${money(amount + recAmt)} to ${personName(pid)} recorded`);
    });
  });

  // Accounts
  let acctMode = null;
  function openAccount(mode, id) {
    acctMode = { mode, id };
    const a = accounts?.find((x) => x.id === id);
    const reset = mode === "reset";
    $("#af-title").textContent = reset ? `New password for ${a?.name}` : "Add login";
    $("#af-name-wrap").hidden = $("#af-user-wrap").hidden = $("#af-role-wrap").hidden = reset;
    $("#af-pass-lbl").textContent = reset ? "New password" : "Password";
    $("#af-btn").textContent = reset ? "Set password" : "Create login";
    $("#af-name").value = ""; $("#af-user").value = ""; $("#af-role").value = "staff";
    $("#af-pass").value = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("") + "-" + [...crypto.getRandomValues(new Uint8Array(4))].map((b) => "23456789"[b % 8]).join("");
    showErr($("#af-err"), "");
    openSheet("#d-account");
  }
  $("#d-account form").addEventListener("submit", (e) => {
    e.preventDefault();
    const err = $("#af-err");
    attempt(e.currentTarget, err, async () => {
      if (acctMode.mode === "reset") await api("/api/users/" + acctMode.id, { body: { password: $("#af-pass").value } });
      else await api("/api/users", { body: { name: $("#af-name").value.trim(), username: $("#af-user").value.trim(), role: $("#af-role").value, password: $("#af-pass").value } });
      $("#d-account").close(); toast(acctMode.mode === "reset" ? "Password changed" : "Login created");
      loadAccounts();
    }).catch(() => {});
  });
  $("#d-password form").addEventListener("submit", (e) => {
    e.preventDefault();
    attempt(e.currentTarget, $("#cp-err"), async () => {
      await api("/api/password", { body: { current: $("#cp-cur").value, password: $("#cp-new").value } });
      $("#d-password").close(); toast("Password changed");
    });
  });

  // ---------- Statements ----------
  // A statement is a running account for one person over a period:
  // opening balance + work + receipts added − wages paid − receipts paid back = closing balance.
  // Over all time it equals the board's "owed" figure (earned − wages + receipts not yet reimbursed).
  const agencyName = () => String(state.settings.agencyName || "").trim() || "Talent & Crew";
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
    const due = c > 0.004 ? ["owed", `Owed to ${esc((p.name || "").split(" ")[0] || "you")}`] : c < -0.004 ? ["over", "Overpaid"] : ["paid", "Settled"];
    const n = st.work.length;
    const workRows = st.work.map((w) => `<tr><td>${fmtShort(w.s.date)}</td><td>${esc(w.s.job || "—")}${w.s.location ? `<span class="sub">${esc(w.s.location)}</span>` : ""}</td><td class="n">${hrs(w.s.hours)}${w.pay.overtimeHours ? `<span class="sub">${hrs(w.pay.overtimeHours)} OT</span>` : ""}</td><td class="basis">${esc(payExplain(w.s.hours, w.terms, false))}</td><td class="n">${money(w.pay.amount)}</td></tr>`).join("");
    const recRows = st.added.map((r) => `<tr><td>${fmtShort(r.date)}</td><td>${esc(r.description || "Receipt")}</td><td>${r.status === "reimbursed" ? `Paid back${r.reimbursedAt ? " " + fmtShort(r.reimbursedAt) : ""}` : "To reimburse"}</td><td class="n">${money(r.amount)}</td></tr>`).join("");
    const outRows = st.out.map((o) => `<tr><td>${fmtShort(o.date)}</td><td>${o.p ? `${esc(o.p.method || "Payment")}${o.p.note ? `<span class="sub">${esc(o.p.note)}</span>` : ""}` : `Receipt paid back<span class="sub">${esc(o.r.description || "Receipt")}</span>`}</td><td class="n">${o.wages ? money(o.wages) : "—"}</td><td class="n">${o.back ? money(o.back) : "—"}</td><td class="n">${money(o.wages + o.back)}</td></tr>`).join("");
    const none = (t) => `<p class="stmt-none">${t}</p>`;
    return `<article class="stmt">
      <header class="stmt-top">
        <div class="stmt-from"><b class="stmt-agency">${ag}</b><span class="stmt-kind">Statement of account</span></div>
        <dl class="stmt-meta"><div><dt>Period</dt><dd>${esc(label)}</dd></div><div><dt>Issued</dt><dd>${fmtDate(isoDay())}</dd></div></dl>
      </header>
      <div class="stmt-band">
        <div class="stmt-payee">
          <span class="stmt-k">Prepared for</span>
          <h2 class="stmt-name">${esc(p.name || "")}</h2>
          <p>${p.role ? roleLabel(p.role) : ""}${p.speciality ? " · " + esc(p.speciality) : ""}</p>
          ${p.id ? `<p class="stmt-terms">${esc(termsText(payTerms(p)))}</p>` : ""}
        </div>
        <div class="stmt-due ${due[0]}"><span class="stmt-k">${due[1]}</span><b>${money(c)}</b><span>Balance at ${fmtDate(st.to)}</span></div>
      </div>
      <div class="stmt-recon">
        <div><span>Opening balance<em>at ${fmtDate(st.from)}</em></span><b>${money(st.opening)}</b></div>
        <div><span>Work<em>${n} ${n === 1 ? "shift" : "shifts"} · ${hrs(st.t.hours)}${st.t.ot ? ` incl. ${hrs(st.t.ot)} overtime` : ""}</em></span><b>${sign(st.t.earned, "+")}</b></div>
        <div><span>Receipts added<em>${st.added.length} ${st.added.length === 1 ? "receipt" : "receipts"}</em></span><b>${sign(st.t.recAdded, "+")}</b></div>
        <div><span>Wages paid</span><b>${sign(st.t.wages, "−")}</b></div>
        <div><span>Receipts paid back</span><b>${sign(st.t.back, "−")}</b></div>
        <div class="total"><span>Closing balance<em>at ${fmtDate(st.to)}</em></span><b>${money(c)}</b></div>
      </div>
      <section class="stmt-sec"><h3>Work</h3>${n ? `<div class="stmt-scroll"><table>
        <thead><tr><th>Date</th><th>Job · location</th><th class="n">Hours</th><th>Pay basis</th><th class="n">Amount</th></tr></thead>
        <tbody>${workRows}</tbody>
        <tfoot><tr><td colspan="2">${n} ${n === 1 ? "shift" : "shifts"}</td><td class="n">${hrs(st.t.hours)}</td><td></td><td class="n">${money(st.t.earned)}</td></tr></tfoot>
      </table></div>` : none("No hours logged in this period.")}</section>
      <section class="stmt-sec"><h3>Receipts added</h3>${st.added.length ? `<div class="stmt-scroll"><table>
        <thead><tr><th>Date</th><th>For</th><th>Status</th><th class="n">Amount</th></tr></thead>
        <tbody>${recRows}</tbody>
        <tfoot><tr><td colspan="3">${st.added.length} ${st.added.length === 1 ? "receipt" : "receipts"}</td><td class="n">${money(st.t.recAdded)}</td></tr></tfoot>
      </table></div>` : none("No receipts in this period.")}</section>
      <section class="stmt-sec"><h3>Payments</h3>${st.out.length ? `<div class="stmt-scroll"><table>
        <thead><tr><th>Date</th><th>Method · note</th><th class="n">Wages</th><th class="n">Receipts</th><th class="n">Total</th></tr></thead>
        <tbody>${outRows}</tbody>
        <tfoot><tr><td colspan="2">${st.out.length} ${st.out.length === 1 ? "payment" : "payments"}</td><td class="n">${money(st.t.wages)}</td><td class="n">${money(st.t.back)}</td><td class="n">${money(st.t.wages + st.t.back)}</td></tr></tfoot>
      </table></div>` : none("No payments in this period.")}</section>
      <footer class="stmt-foot"><span>Amounts in ${esc(state.settings.currency || "EUR")}. A positive balance is owed by ${ag} to ${esc(p.name || "the payee")}; a negative balance has been overpaid.</span></footer>
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
    const title = `${agencyName()} · Statement · ${st.person.name || ""} · ${label}`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
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
    const rows = [["Statement of account", agencyName()], ["Prepared for", name], ["Period", label, st.from, st.to], ["Pay terms", st.person.id ? termsText(payTerms(st.person)) : ""], ["Issued", isoDay()], [],
      ["Date", "Entry", "Details", "Hours", "Regular hours", "Overtime hours", "Pay basis", "In", "Out", "Balance"]];
    let bal = st.opening;
    rows.push([st.from, "Opening balance", "", "", "", "", "", "", "", round2(bal)]);
    const lines = [
      ...st.work.map((w) => ({ date: w.s.date, o: 0, row: ["Work", [w.s.job, w.s.location].filter(Boolean).join(" · "), w.s.hours, round2(w.pay.regularHours), round2(w.pay.overtimeHours), payExplain(w.s.hours, w.terms, false)], inn: w.pay.amount, out: 0 })),
      ...st.added.map((r) => ({ date: r.date, o: 1, row: ["Receipt", r.description || "", "", "", "", ""], inn: Number(r.amount) || 0, out: 0 })),
      ...st.out.map((x) => ({ date: x.date, o: 2, row: [x.p ? "Payment" : "Receipt paid back", x.p ? [x.p.method, x.p.note, x.back ? `incl. ${x.recs.length} receipt${x.recs.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") : x.r.description || "", "", "", "", ""], inn: 0, out: x.wages + x.back })),
    ].sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.o - b.o);
    for (const l of lines) { bal += l.inn - l.out; rows.push([l.date, ...l.row, l.inn ? round2(l.inn) : "", l.out ? round2(l.out) : "", round2(bal)]); }
    rows.push([st.to, "Closing balance", "", round2(st.t.hours), round2(st.t.reg), round2(st.t.ot), "", round2(st.t.earned + st.t.recAdded), round2(st.t.wages + st.t.back), round2(st.closing)]);
    rows.push([], ["Earned", round2(st.t.earned)], ["Receipts added", round2(st.t.recAdded)], ["Wages paid", round2(st.t.wages)], ["Receipts paid back", round2(st.t.back)]);
    return rows;
  }
  // One row per person for a period: what an accountant needs for the month.
  function periodSummaryCsv(per) {
    const rows = [["Person", "Role", "Pay terms", "Shifts", "Hours", "Regular hours", "Overtime hours", "Earned", "Receipts added", "Wages paid", "Receipts paid back", "Total paid", "Opening balance", "Closing balance"]];
    const tot = Array(10).fill(0);
    for (const p of state.people.slice().sort(byName)) {
      const st = statementData(p.id, per.from, per.to);
      const nums = [st.work.length, st.t.hours, st.t.reg, st.t.ot, st.t.earned, st.t.recAdded, st.t.wages, st.t.back, st.t.wages + st.t.back, st.closing];
      nums.forEach((v, i) => (tot[i] += v));
      rows.push([p.name, roleLabel(p.role), termsText(payTerms(p)), ...nums.slice(0, 4).map(round2), ...nums.slice(4, 9).map(round2), round2(st.opening), round2(st.closing)]);
    }
    rows.push(["Total", "", "", ...tot.slice(0, 4).map(round2), ...tot.slice(4, 9).map(round2), "", round2(tot[9])]);
    return rows;
  }
  const slug = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "person";
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
    $("#st-month").value = stUI.month;
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
    saveFile(`statement-${slug(st.person.name)}-${per.key}.html`, statementFile(st, per.label), "text/html");
  });
  $("#st-csv").addEventListener("click", () => {
    const { st, per } = stCur;
    download(`statement-${slug(st.person.name)}-${per.key}.csv`, statementCsv(st, per.label));
  });
  $("#st-all").addEventListener("click", () => { const per = stPeriod(); download(`summary-${per.key}.csv`, periodSummaryCsv(per)); });

  // ---------- Global clicks ----------
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]"); if (!t || t.disabled) return;
    const id = t.dataset.id, act = t.dataset.act;
    if (t.closest("#d-quick")) $("#d-quick").close();
    switch (act) {
      case "add-person": return openPerson();
      case "edit-person": return openPerson(id);
      case "loc": return openLoc(id);
      case "add-shift": return openShift(id);
      case "edit-shift": return openShift(null, id);
      case "add-receipt": return openReceipt(id);
      case "view-receipt": return openView(id);
      case "add-payment": return openPay(id);
      case "goto-hours": location.hash = "hours"; return;
      case "detail": detailId = id; renderDetail(id); return openSheet("#d-detail");
      case "statement": return openStatement(id);
      case "password": $("#cp-cur").value = ""; $("#cp-new").value = ""; showErr($("#cp-err"), ""); return openSheet("#d-password");
      case "sync-now": sync.error = null; sync.online = true; return runSync().then(() => renderSettings());
      case "add-account": return openAccount("create");
      case "reset-pw": return openAccount("reset", id);
      case "toggle-role": case "toggle-disabled": {
        const a = accounts.find((x) => x.id === id);
        const body = act === "toggle-role" ? { role: a.role === "admin" ? "staff" : "admin" } : { disabled: !a.disabled };
        return api("/api/users/" + id, { body }).then(loadAccounts).catch((err) => toast(err.msg || "Connect to the internet to change logins."));
      }
      case "del-payment": return armed(t, "Confirm", async () => {
        const p = state.payments.find((x) => x.id === id);
        for (const rid of p?.receiptIds || []) { const r = state.receipts.find((x) => x.id === rid); if (r) await save("receipts", { ...r, status: "pending", reimbursedAt: null }); }
        await remove("payments", p); toast("Payment deleted. Its receipts are back on the to-reimburse list.");
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
  $("#h-all").addEventListener("click", () => { ui.hMonth = ""; render(); });
  $("#r-person").addEventListener("change", (e) => { ui.rPerson = e.target.value; render(); });
  $("#p-person").addEventListener("change", (e) => { ui.pPerson = e.target.value; render(); });

  // Broken image (photo not cached offline yet) -> calm placeholder.
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img.tagName !== "IMG" || img.dataset.failed) return;
    img.dataset.failed = "1";
    const ph = document.createElement("span"); ph.className = "ph"; ph.innerHTML = ICON.cam + "<span>Photo shows when you're online</span>";
    img.replaceWith(ph);
  }, true);

  // ---------- CSV export ----------
  const cell = (v) => { const s = String(v ?? ""); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  function download(name, rows) {
    const blob = new Blob(["﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  $$("[data-export]").forEach((btn) => btn.addEventListener("click", () => {
    const kind = btn.dataset.export;
    if (kind === "hours") download(`hours-${ui.hMonth || "all"}.csv`, [["Date", "Person", "Role", "Job", "Location", "Call", "Wrap", "Hours", "Rate", "Earned", "Pay type", "Day rate", "Regular hours", "Overtime hours", "Overtime ×", "Pay basis"],
      ...shiftsShown().map((s) => { const p = state.people.find((x) => x.id === s.personId), t = shiftTerms(s), pay = shiftPay(s); return [s.date, p?.name, roleLabel(p?.role), s.job, s.location, s.start, s.end, s.hours, t.rate, round2(pay.amount), t.payType, t.dayRate || "", round2(pay.regularHours), round2(pay.overtimeHours), t.otAfter ? t.otMult : "", payExplain(s.hours, t, false)]; })]);
    else if (kind === "receipts") download(`receipts-${isoDay()}.csv`, [["Date", "Person", "Description", "Amount", "Status", "Reimbursed on"],
      ...receiptsShown().map((r) => [r.date, personName(r.personId), r.description, r.amount, r.status === "reimbursed" ? "Reimbursed" : "To reimburse", r.reimbursedAt || ""])]);
    else download(`payments-${isoDay()}.csv`, [["Date", "Person", "Method", "Note", "Wages", "Receipts", "Total"],
      ...state.payments.filter((p) => !ui.pPerson || p.personId === ui.pPerson).sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((p) => [p.date, personName(p.personId), p.method, p.note, p.amount, p.receiptsAmount || 0, round2((p.amount || 0) + (p.receiptsAmount || 0))])]);
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
  const INV = { "not invoiced": "Not invoiced", invoiced: "Invoiced", paid: "Paid" };
  const jobEnd = (j) => (j.endDate && j.endDate > j.date ? j.endDate : j.date || "");
  const jobOn = (j, day) => !!j.date && j.date <= day && day <= jobEnd(j);
  const addDays = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); return isoDay(new Date(y, m - 1, d + n)); };
  const jobName = (j) => j.title || j.client || "Untitled job";
  const jobLabel = (j) => [j.title, j.client].filter(Boolean).join(" · ") || "Untitled job";
  const jobRange = (j) => (jobEnd(j) > j.date ? `${fmtShort(j.date)} – ${fmtShort(jobEnd(j))}` : fmtShort(j.date));
  const invOf = (j) => (INV[j.invoiceStatus] ? j.invoiceStatus : "not invoiced");
  const crewOf = (j) => (j.people || []).filter((id) => state.people.some((p) => p.id === id));
  const shiftCost = (s) => shiftPay(s).amount; // what the person earns for this shift (rate type, overtime)
  const byStart = (a, b) => (a.date || "").localeCompare(b.date || "") || (a.call || "").localeCompare(b.call || "");

  // Billed to the client, what the job cost (wages + linked receipts), and the margin.
  function jobMoney(j) {
    const shifts = state.shifts.filter((s) => s.jobId === j.id);
    const recs = state.receipts.filter((r) => r.jobId === j.id);
    const hours = shifts.reduce((a, s) => a + (Number(s.hours) || 0), 0);
    const wages = shifts.reduce((a, s) => a + shiftCost(s), 0);
    const exp = recs.reduce((a, r) => a + (Number(r.amount) || 0), 0);
    const billed = j.billing === "hourly" ? hours * (Number(j.clientRate) || 0) : Number(j.fee) || 0;
    return { shifts, recs, hours, wages: round2(wages), exp: round2(exp), billed: round2(billed), cost: round2(wages + exp), margin: round2(billed - wages - exp) };
  }
  // Billed amount; an hourly job with nothing logged yet shows its rate instead of 0.
  const billedLabel = (j, mm) => (j.billing === "hourly" && !mm.hours ? `${money(j.clientRate)} / h` : money(mm.billed));
  function invPill(j) {
    const st = invOf(j);
    if (st === "paid") return `<span class="pill paid">Paid</span>`;
    if (st === "invoiced") return `<span class="pill inv">Invoiced</span>`;
    return jobEnd(j) < isoDay() ? `<span class="pill owed">To invoice</span>` : `<span class="pill wait">Not invoiced</span>`;
  }

  // The board: a person's booking today, or their next one.
  function nextBooking(pid) {
    const today = isoDay();
    return state.jobs.filter((j) => (j.people || []).includes(pid) && jobEnd(j) >= today).sort((a, b) => (jobOn(b, today) - jobOn(a, today)) || byStart(a, b))[0] || null;
  }
  function bookingLine(pid) {
    const j = nextBooking(pid); if (!j) return "";
    const today = isoDay(), on = jobOn(j, today);
    const when = (on ? "Booked today" : j.date === addDays(today, 1) ? "Booked tomorrow" : `Next booking · ${fmtShort(j.date)}`) + (j.call ? ` · call ${esc(j.call)}` : "");
    const what = [jobName(j), j.location].filter(Boolean).map(esc).join(", ");
    return `<button class="booked ${on ? "on" : ""}" type="button" data-act="job-open" data-id="${j.id}">${CAL}<span class="txt"><span class="bk-when">${when}</span><span class="bk-what">${what}</span></span></button>`;
  }
  function bookedTodayNote() {
    const today = isoDay(), ids = new Set();
    for (const j of state.jobs) if (jobOn(j, today)) for (const id of crewOf(j)) ids.add(id);
    return ids.size ? ` · ${ids.size} booked` : "";
  }

  function renderJobsHook() {
    if (ui.tab === "jobs") renderJobs();
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
    if (!state.jobs.length) {
      el.innerHTML = isAdmin()
        ? empty("No jobs booked yet", "Add a job with the client, date, call time and location, then book people on it. It shows on their card on the board, and hours can be logged straight from it.", "job-add", "Book the first job")
        : empty("No jobs booked yet", "Jobs appear here once an admin books them.");
      return;
    }
    if (jui.view === "clients") return renderClients(el);
    const list = jobsMatching();
    if (!list.length) { el.innerHTML = empty("No jobs match", "Try a different search."); return; }
    const today = isoDay(), tmw = addDays(today, 1), week = addDays(today, 7);
    const groups = [["Today", []], ["Tomorrow", []], ["This week", []], ["Later", []]], past = [];
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
      : `<p class="totals-line">Nothing booked from today on.</p>`)
      + (past.length ? `<details class="jpast" ${jui.pastOpen || (jui.q && !up.length) ? "open" : ""}><summary class="jgroup-h">Past jobs<b>${past.length}</b></summary><div class="jlist">${past.map(jobCard).join("")}</div></details>` : "");
  }

  function jobCard(j) {
    const today = isoDay(), on = jobOn(j, today), [y, m, d] = (j.date || "").split("-").map(Number);
    const dt = new Date(y, (m || 1) - 1, d || 1), crew = crewOf(j);
    const meta = [jobEnd(j) > j.date ? `Until ${fmtShort(jobEnd(j))}` : "", j.call ? `Call ${esc(j.call)}` : "", esc(j.location || "")].filter(Boolean).join(" · ");
    const bill = isAdmin() ? `<span class="jmoney"><b>${billedLabel(j, jobMoney(j))}</b>${invPill(j)}</span>` : "";
    return `<button class="jcard ${on ? "on" : ""} ${jobEnd(j) < today ? "past" : ""}" type="button" data-act="job-open" data-id="${j.id}">
      <span class="jdate"><span>${dt.toLocaleDateString(locale, { weekday: "short" })}</span><b>${d || "?"}</b><span>${dt.toLocaleDateString(locale, { month: "short" })}</span></span>
      <span class="jbody">
        ${j.client && j.title ? `<span class="jclient">${esc(j.client)}</span>` : ""}
        <span class="jtitle">${esc(jobName(j))}</span>
        ${meta ? `<span class="jmeta">${meta}</span>` : ""}
        <span class="jcrew">${crew.length ? crew.map((id) => `<span class="chip">${esc(personName(id))}</span>`).join("") : `<span class="muted">No one booked yet</span>`}${unsyncedTag("jobs", j.id)}</span>
      </span>${bill}
    </button>`;
  }

  function renderClients(el) {
    const by = new Map();
    let billed = 0, cost = 0, awaiting = 0, toInv = 0;
    const today = isoDay();
    for (const j of jobsMatching()) {
      const k = (j.client || "").trim() || "No client", mm = jobMoney(j);
      if (!by.has(k)) by.set(k, { name: k, jobs: [], billed: 0, cost: 0 });
      const c = by.get(k); c.jobs.push([j, mm]); c.billed += mm.billed; c.cost += mm.cost;
      billed += mm.billed; cost += mm.cost;
      if (invOf(j) === "invoiced") awaiting += mm.billed;
      if (invOf(j) === "not invoiced" && jobEnd(j) < today) toInv++;
    }
    if (!by.size) { el.innerHTML = empty("No clients match", "Try a different search."); return; }
    const margin = round2(billed - cost), n = [...by.values()].reduce((a, c) => a + c.jobs.length, 0);
    const pct = (mg, b) => (b > 0.004 ? `${Math.round((mg / b) * 100)}% of billed` : "");
    el.innerHTML = `<div class="summary">
        <div><span class="eyebrow">Margin</span><span class="big ${margin < -0.004 ? "neg" : "ink"}">${money(margin)}</span><span class="note">${pct(margin, billed) || "Nothing billed yet"}</span></div>
        <div><span class="eyebrow">Billed</span><span class="mid">${money(billed)}</span><span class="note">${n} ${n === 1 ? "job" : "jobs"}</span></div>
        <div><span class="eyebrow">Cost</span><span class="mid">${money(cost)}</span><span class="note">Wages and receipts</span></div>
        <div><span class="eyebrow">Awaiting payment</span><span class="mid">${money(awaiting)}</span><span class="note">${toInv ? `${toInv} past ${toInv === 1 ? "job" : "jobs"} to invoice` : "Nothing left to invoice"}</span></div>
      </div>
      <div class="clients">${[...by.values()].sort((a, b) => b.billed - a.billed || a.name.localeCompare(b.name, locale)).map((c) => {
        const mg = round2(c.billed - c.cost);
        return `<article class="client">
          <div class="client-head"><h3>${esc(c.name)}</h3><span>${c.jobs.length} ${c.jobs.length === 1 ? "job" : "jobs"}</span></div>
          <div class="figs">
            <div><span class="k">Billed</span><span class="v">${money(c.billed)}</span></div>
            <div><span class="k">Cost</span><span class="v">${money(c.cost)}</span></div>
            <div><span class="k">Margin</span><span class="v ${mg < -0.004 ? "neg" : ""}">${money(mg)}</span></div>
          </div>
          <div class="cjobs">${c.jobs.sort((a, b) => byStart(b[0], a[0])).map(([j, mm]) => `<button class="cj" type="button" data-act="job-open" data-id="${j.id}">
            <span class="cj-t"><span class="cj-d">${fmtShort(j.date)}</span>${esc(j.title || "Untitled job")}</span>
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
        <dt>Client</dt><dd>${esc(j.client || "—")}</dd>
        <dt>When</dt><dd>${jobRange(j)}${jobOn(j, isoDay()) ? ` <span class="pill inv">Today</span>` : ""}</dd>
        <dt>Call</dt><dd class="mono">${esc(j.call || "—")}</dd>
        <dt>Location</dt><dd>${esc(j.location || "—")}</dd>
        ${j.notes ? `<dt>Notes</dt><dd class="pre">${esc(j.notes)}</dd>` : ""}
      </dl>
      ${a ? `<div class="detail-figs jfigs">
        <div><span class="eyebrow">Billed to client</span><span class="v">${money(mm.billed)}</span><span class="sub">${j.billing === "hourly" ? `${hrs(mm.hours)} × ${money(j.clientRate)}` : "Flat fee"}</span></div>
        <div><span class="eyebrow">Cost</span><span class="v">${money(mm.cost)}</span><span class="sub">Wages ${money(mm.wages)} · receipts ${money(mm.exp)}</span></div>
        <div><span class="eyebrow">Margin</span><span class="v ${mm.margin < -0.004 ? "neg" : "pos"}">${money(mm.margin)}</span><span class="sub">${mm.billed > 0.004 ? `${Math.round((mm.margin / mm.billed) * 100)}% of billed` : "Nothing billed yet"}</span></div>
      </div>
      <div class="jinv"><span class="eyebrow">Invoice</span><div class="seg" role="group" aria-label="Invoice status">${Object.entries(INV).map(([v, l]) => `<button type="button" data-act="job-inv" data-id="${j.id}" data-v="${v}" aria-pressed="${st === v}">${l}</button>`).join("")}</div></div>` : ""}
      <h4 class="eyebrow">Booked · ${crew.length}</h4>
      ${crew.length ? `<div class="crew">${crew.map((pid) => {
        const p = state.people.find((x) => x.id === pid), h = hoursBy.get(pid) || 0;
        return `<div class="crew-row"><div class="who"><button class="comp-name" type="button" data-act="detail" data-id="${pid}">${esc(p.name)}</button><span>${roleLabel(p.role)} · ${h ? hrs(h) + " logged" : "no hours logged"}</span></div>
          <button class="btn sm" type="button" data-act="job-log" data-id="${j.id}" data-person="${pid}">${ICON.clock}Log hours</button></div>`;
      }).join("")}</div>` : `<p class="muted">No one booked yet.${a ? " Edit the job to book people." : ""}</p>`}
      <h4 class="eyebrow">Hours on this job · ${hrs(mm.hours)}</h4>
      ${mm.shifts.length ? `<div class="tablebox"><table><thead><tr><th>Date</th><th>Person</th><th class="n">Call–wrap</th><th class="n">Hours</th><th class="n">Earned</th></tr></thead><tbody>
        ${mm.shifts.sort((x, y) => (y.date || "").localeCompare(x.date || "")).map((s) => `<tr><td>${fmtShort(s.date)}${unsyncedTag("shifts", s.id) ? `<span class="sub">${unsyncedTag("shifts", s.id)}</span>` : ""}</td><td class="who">${esc(personName(s.personId))}</td><td class="n">${s.start && s.end ? `${esc(s.start)}–${esc(s.end)}` : `<span class="muted">—</span>`}</td><td class="n">${hrs(s.hours)}</td><td class="n">${money(shiftCost(s))}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">No hours logged on this job yet.</p>`}
      ${mm.recs.length ? `<h4 class="eyebrow">Receipts on this job · ${money(mm.exp)}</h4>
      <div class="tablebox"><table><thead><tr><th>Date</th><th>For</th><th>Paid by</th><th class="n">Amount</th></tr></thead><tbody>
        ${mm.recs.map((r) => `<tr><td>${fmtShort(r.date)}</td><td><button class="btn quiet sm" type="button" data-act="view-receipt" data-id="${r.id}">${esc(r.description || "Receipt")}</button></td><td>${esc(personName(r.personId))}</td><td class="n">${money(r.amount)}</td></tr>`).join("")}
      </tbody></table></div>` : ""}
      ${a ? `<div class="sheet-foot"><button class="btn" type="button" data-act="job-edit" data-id="${j.id}">Edit job</button></div>` : ""}`;
  }

  // Job form (admins)
  function openJob(id) {
    if (!isAdmin()) return;
    editingJob = id || null;
    const j = state.jobs.find((x) => x.id === id) || {};
    $("#jf-title").textContent = id ? "Edit job" : "New job";
    $("#jf-client").value = j.client || ""; $("#jf-name").value = j.title || "";
    $("#jf-date").value = j.date || isoDay(); $("#jf-end").value = j.endDate || ""; $("#jf-call").value = j.call || "";
    $("#jf-loc").value = j.location || ""; $("#jf-notes").value = j.notes || "";
    $("#jf-billing").value = j.billing === "hourly" ? "hourly" : "flat";
    const amt = j.billing === "hourly" ? j.clientRate : j.fee;
    $("#jf-amount").value = amt ? amt : "";
    $("#jf-inv").value = invOf(j);
    $("#jf-clients").innerHTML = [...new Set(state.jobs.map((x) => (x.client || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, locale)).map((c) => `<option value="${esc(c)}"></option>`).join("");
    pickPeople(new Set(j.people || []));
    billingLabel();
    $("#jf-del").hidden = !id; disarm($("#jf-del"), "Delete");
    showErr($("#jf-err"), "");
    openSheet("#d-jobform"); $("#jf-client").focus();
  }
  const pickedPeople = () => new Set($$("#jf-people input:checked").map((i) => i.value));
  function pickPeople(sel) {
    const date = $("#jf-date").value, end = $("#jf-end").value > date ? $("#jf-end").value : date;
    const people = state.people.slice().sort(byName);
    $("#jf-people").innerHTML = people.length ? people.map((p) => {
      const clash = date && state.jobs.find((o) => o.id !== editingJob && (o.people || []).includes(p.id) && o.date <= end && date <= jobEnd(o));
      return `<label class="pickp"><input type="checkbox" value="${p.id}" ${sel.has(p.id) ? "checked" : ""}><span class="nm">${esc(p.name)}</span><span class="rl ${clash ? "clash" : ""}">${clash ? `Also on ${esc(jobName(clash))}` : roleLabel(p.role)}</span></label>`;
    }).join("") : `<p class="hint">Add people to the board first, then book them here.</p>`;
  }
  function billingLabel() { $("#jf-amount-lbl").textContent = $("#jf-billing").value === "hourly" ? "Client rate per hour" : "Fee to client"; }
  $("#jf-billing").addEventListener("change", billingLabel);
  $("#jf-date").addEventListener("change", () => pickPeople(pickedPeople()));
  $("#jf-end").addEventListener("change", () => pickPeople(pickedPeople()));
  $("#d-jobform form").addEventListener("submit", (e) => {
    e.preventDefault();
    const err = $("#jf-err");
    const client = $("#jf-client").value.trim(), title = $("#jf-name").value.trim(), date = $("#jf-date").value, end = $("#jf-end").value;
    const raw = $("#jf-amount").value.trim(), amt = raw === "" ? 0 : parseFloat(raw);
    if (!client && !title) return showErr(err, "Enter the client or the job name.");
    if (!date) return showErr(err, "Pick the date of the job.");
    if (end && end < date) return showErr(err, "The end date is before the start date.");
    if (!(amt >= 0)) return showErr(err, "Enter what the client pays, or leave it empty.");
    attempt(e.currentTarget, err, async () => {
      const prev = state.jobs.find((x) => x.id === editingJob);
      const billing = $("#jf-billing").value === "hourly" ? "hourly" : "flat";
      const rec = await save("jobs", {
        ...(prev || {}), client, title, date, endDate: end > date ? end : "", call: $("#jf-call").value, location: $("#jf-loc").value.trim(),
        notes: $("#jf-notes").value.trim(), people: [...pickedPeople()], billing,
        fee: billing === "flat" ? round2(amt) : Number(prev?.fee) || 0, clientRate: billing === "hourly" ? round2(amt) : Number(prev?.clientRate) || 0,
        invoiceStatus: $("#jf-inv").value,
      });
      $("#d-jobform").close();
      toast(prev ? "Job saved" : `${jobName(rec)} booked${sync.online ? "" : " · saved on this device"}`);
    });
  });
  $("#jf-del").addEventListener("click", (e) => {
    const j = state.jobs.find((x) => x.id === editingJob); if (!j) return;
    armed(e.currentTarget, "Tap again to delete", async () => {
      await remove("jobs", j);
      $("#d-jobform").close(); if ($("#d-job").open) $("#d-job").close();
      toast("Job deleted. Hours and receipts logged on it are kept.");
    });
  });

  // Booking select in the hours and receipt forms
  function jobOptions(sel, selected) {
    const today = isoDay(), from = addDays(today, -60), to = addDays(today, 30);
    const rank = (j) => (jobOn(j, today) ? 0 : j.date > today ? 1 : 2);
    const list = state.jobs.filter((j) => j.id === selected || (jobEnd(j) >= from && j.date <= to))
      .sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? byStart(b, a) : byStart(a, b)));
    sel.innerHTML = `<option value="">No booking</option>` + list.map((j) => `<option value="${j.id}">${esc(`${fmtShort(j.date)} · ${jobLabel(j)}`)}</option>`).join("");
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
    return j ? `<dt>Job</dt><dd><button class="btn quiet sm" type="button" data-act="job-open" data-id="${j.id}">${esc(jobLabel(j))}</button></dd>` : "";
  }

  // CSV: what's on the Jobs view (search applied). Billing columns for admins only.
  function exportJobs() {
    const a = isAdmin();
    const head = ["Date", "Until", "Client", "Job", "Location", "Call", "Booked", "Hours logged"];
    if (a) head.push("Client pays", "Fee", "Client rate", "Billed", "Wages", "Receipts", "Cost", "Margin", "Invoice");
    const rows = jobsMatching().sort((x, y) => byStart(y, x)).map((j) => {
      const mm = jobMoney(j);
      const r = [j.date, jobEnd(j) > j.date ? jobEnd(j) : "", j.client, j.title, j.location, j.call, crewOf(j).map(personName).join("; "), round2(mm.hours)];
      if (a) r.push(j.billing === "hourly" ? "Per hour" : "Flat fee", j.billing === "hourly" ? "" : round2(j.fee), j.billing === "hourly" ? round2(j.clientRate) : "", mm.billed, mm.wages, mm.exp, mm.cost, mm.margin, INV[invOf(j)]);
      return r;
    });
    download(`jobs-${isoDay()}.csv`, [head, ...rows]);
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]"); if (!t || t.disabled) return;
    const id = t.dataset.id;
    switch (t.dataset.act) {
      case "job-open": jobOpenId = id; renderJob(id); return openSheet("#d-job");
      case "job-add": return openJob();
      case "job-edit": return openJob(id);
      case "job-log": shiftFromJob = { jobId: id }; openShift(t.dataset.person); shiftFromJob = null; return;
      case "job-export": return exportJobs();
      case "job-inv": {
        const j = state.jobs.find((x) => x.id === id);
        if (!j || !isAdmin() || invOf(j) === t.dataset.v) return;
        return save("jobs", { ...j, invoiceStatus: t.dataset.v }).then(() => toast(`Marked ${INV[t.dataset.v].toLowerCase()}`));
      }
    }
  });
  $("#d-job").addEventListener("close", () => (jobOpenId = null));
  $("#job-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; jui.view = b.dataset.jv; render(); });
  $("#job-q").addEventListener("input", (e) => { jui.q = e.target.value; render(); });
  document.addEventListener("toggle", (e) => { if (e.target.classList?.contains("jpast")) jui.pastOpen = e.target.open; }, true);

  // ---------- Routing ----------
  const TABS = ["team", "jobs", "hours", "receipts", "payments", "settings"];
  function route() {
    const h = location.hash.slice(1);
    ui.tab = TABS.includes(h) ? h : "team";
    $$(".nav a").forEach((a) => (a.dataset.tab === ui.tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    $$("[data-view]").forEach((v) => (v.hidden = v.dataset.view !== ui.tab));
    if (ui.tab === "settings") loadAccounts();
    render();
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);

  // ---------- Sign in ----------
  let reauth = false;
  function showAuth(mode, isReauth = false) {
    reauth = isReauth;
    $("#app").hidden = true; $("#auth").hidden = false;
    $("#login-form").hidden = mode !== "login"; $("#setup-form").hidden = mode !== "setup";
    (mode === "login" ? $("#li-user") : $("#su-name")).focus();
  }
  async function enter(user) {
    const prev = await meta.get("me");
    if (prev && prev.id !== user.id) { await idb.wipe(); await loadState(); } // a different person on this device
    else if (prev && prev.role !== user.role) await meta.set("rev", 0); // role changed: re-fetch (staff copies of jobs carry no billing)
    me = user; await meta.set("me", user);
    sync.authLost = false;
    $("#auth").hidden = true; $("#app").hidden = false;
    $("#me-chip").innerHTML = `<div><b>${esc(user.name)}</b>${user.role === "admin" ? "Admin" : "Staff"}</div>`;
    navigator.storage?.persist?.().catch(() => {});
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
      showErr(err, x.status ? x.msg : "No connection. You need to be online to sign in.");
    } finally { btn.disabled = false; }
  });
  $("#setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#su-err"), btn = $("#su-btn");
    showErr(err, ""); btn.disabled = true;
    try {
      const r = await api("/api/setup", { body: { name: $("#su-name").value.trim(), username: $("#su-user").value.trim(), password: $("#su-pass").value } });
      await enter(r.user);
    } catch (x) { showErr(err, x.status ? x.msg : "No connection. You need to be online to set up."); }
    finally { btn.disabled = false; }
  });
  async function logout(btn, unsent) {
    const go = async () => {
      try { await api("/api/logout", {}); } catch { /* offline: still clear the device */ }
      await idb.wipe(); await loadState(); me = null;
      showAuth("login");
    };
    if (unsent) armed(btn, `Sign out and lose ${unsent} unsent change${unsent === 1 ? "" : "s"}?`, go);
    else go();
  }

  // ---------- Boot ----------
  window.addEventListener("online", () => { sync.online = true; kickSync(0); });
  window.addEventListener("offline", () => { sync.online = false; paintSync(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") kickSync(0); });
  setInterval(() => { if (navigator.onLine && document.visibilityState === "visible") runSync(); }, 45000);
  setInterval(() => { if (!$$("dialog[open]").length && ui.tab === "team") render(); else paintSync(); }, 60000);
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; if (ui.tab === "settings") renderSettings(); });

  $("#today").textContent = new Date().toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" });

  async function boot() {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
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
      if (cached) { sync.online = false; me = cached; $("#auth").hidden = true; $("#app").hidden = false;
        $("#me-chip").innerHTML = `<div><b>${esc(cached.name)}</b>${cached.role === "admin" ? "Admin" : "Staff"}</div>`;
        route(); return; }
      showAuth("login");
      showErr($("#li-err"), "No connection. Sign in once while online, then the app works offline.");
    }
  }
  boot();
})();
