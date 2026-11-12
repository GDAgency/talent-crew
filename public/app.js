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
  const COLLS = ["people", "shifts", "payments", "receipts", "places"];
  const state = { people: [], shifts: [], payments: [], receipts: [], places: [], settings: { currency: "EUR" } };
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
  const approvalPill = (s) => approvalOf(s) === "pending" ? `<span class="pill wait">Waiting for approval</span>`
    : approvalOf(s) === "rejected" ? `<span class="pill over">Rejected</span>` : "";
  const pendingShifts = () => state.shifts.filter((s) => approvalOf(s) === "pending" && state.people.some((p) => p.id === s.personId))
    .sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.createdAt || 0) - (b.createdAt || 0));
  const CATS = [["travel", "Travel"], ["meals", "Meals"], ["wardrobe", "Wardrobe"], ["hair", "Hair & make-up"], ["equipment", "Equipment"], ["other", "Other"]];
  const catOf = (r) => (CATS.some(([k]) => k === r.category) ? r.category : "other");
  const catLabel = (k) => CATS.find(([c]) => c === k)?.[1] || "Other";
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
        if (res.me && me && res.me.id === me.id && stable(res.me) !== stable(me)) { me = res.me; await meta.set("me", me); paintMe(); }
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
    for (const p of state.people) map.set(p.id, { earned: 0, paid: 0, rec: 0, recN: 0, hMonth: 0, hAll: 0, hPend: 0, nPend: 0 });
    const m = isoMonth();
    for (const s of state.shifts) {
      const b = map.get(s.personId); if (!b) continue;
      if (!counts(s)) { if (approvalOf(s) === "pending") { b.hPend += Number(s.hours) || 0; b.nPend++; } continue; }
      const h = Number(s.hours) || 0;
      b.earned += h * (Number(s.rate) || 0); b.hAll += h;
      if ((s.date || "").startsWith(m)) b.hMonth += h;
    }
    for (const p of state.payments) { const b = map.get(p.personId); if (b) b.paid += Number(p.amount) || 0; }
    for (const r of state.receipts) { const b = map.get(r.personId); if (b && r.status !== "reimbursed") { b.rec += Number(r.amount) || 0; b.recN++; } }
    for (const b of map.values()) { b.wageDue = round2(b.earned - b.paid); b.owed = round2(b.wageDue + b.rec); }
    return map;
  }
  const statusPill = (b) => b.owed > 0.004 ? `<span class="pill owed">Owed</span>` : b.owed < -0.004 ? `<span class="pill over">Overpaid</span>` : `<span class="pill paid">Paid up</span>`;

  // ---------- Rendering ----------
  function render() {
    if (!me) return;
    if (!location.hash.slice(1) && ui.tab === "team" && staffMe()) return route(); // the first sync just linked this login
    const bal = balances();
    const recOpen = state.receipts.filter((r) => r.status !== "reimbursed" && bal.has(r.personId));
    const navRec = $("#nav-rec"); navRec.textContent = recOpen.length; navRec.hidden = !recOpen.length;
    const waiting = isAdmin() ? pendingShifts().length : 0;
    const navHrs = $("#nav-hrs"); navHrs.textContent = waiting; navHrs.hidden = !waiting; navHrs.title = `${waiting} waiting for approval`;
    $$(".admin").forEach((el) => (el.hidden = !isAdmin()));
    paintNav();
    fillFilters();
    if (ui.tab === "team") renderTeam(bal, recOpen);
    if (ui.tab === "me") renderMe(bal);
    if (ui.tab === "hours") { renderQueue(); renderHours(); }
    if (ui.tab === "receipts") renderReceipts();
    if (ui.tab === "payments") renderPayments();
    if (ui.tab === "settings") renderSettings();
    if ($("#d-detail").open && detailId) renderDetail(detailId);
    paintSync();
  }

  function empty(title, text, act, label) {
    return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(text)}</p>${act ? `<button class="btn primary" type="button" data-act="${act}">${esc(label)}</button>` : ""}</div>`;
  }

  function renderTeam(bal, recOpen) {
    let owed = 0, earnedMonth = 0, hMonth = 0, onJob = 0;
    const m = isoMonth();
    for (const b of bal.values()) { if (b.owed > 0) owed += b.owed; hMonth += b.hMonth; }
    for (const s of state.shifts) if ((s.date || "").startsWith(m) && bal.has(s.personId) && counts(s)) earnedMonth += (Number(s.hours) || 0) * (Number(s.rate) || 0);
    const today = isoDay();
    for (const p of state.people) if (p.location && p.locationAt && isoDay(new Date(p.locationAt)) === today) onJob++;
    const owedPeople = [...bal.values()].filter((b) => b.owed > 0.004).length;
    const recSum = recOpen.reduce((a, r) => a + (Number(r.amount) || 0), 0);
    $("#summary").innerHTML = `
      <div><span class="eyebrow">Owed to the team</span><span class="big ${owed > 0.004 ? "" : "zero"}">${money(owed)}</span><span class="note">${owedPeople ? `${owedPeople} ${owedPeople === 1 ? "person" : "people"} waiting to be paid` : "Everyone is paid up"}</span></div>
      <div><span class="eyebrow">Hours</span><span class="mid">${hrs(hMonth)}</span><span class="note">${money(earnedMonth)} in ${new Date().toLocaleDateString(locale, { month: "long" })}</span></div>
      <div><span class="eyebrow">Receipts</span><span class="mid">${money(recSum)}</span><span class="note">${recOpen.length} to reimburse</span></div>
      <div><span class="eyebrow">Checked in</span><span class="mid">${onJob}<span class="muted">/${state.people.length}</span></span><span class="note">today</span></div>`;
    const waiting = isAdmin() ? pendingShifts() : [];
    $("#queue-strip").innerHTML = waiting.length ? `<a class="queue-strip" href="#hours">${ICON.clock}<span><b>${waiting.length} ${waiting.length === 1 ? "entry" : "entries"} waiting for approval</b> · <span class="mono">${hrs(waiting.reduce((a, s) => a + (Number(s.hours) || 0), 0))}</span> logged by staff</span><span class="go">Review</span></a>` : "";

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
        </div>
        <div class="figs">
          <div><span class="k">This month</span><span class="v ${b.hMonth ? "" : "zero"}">${hrs(b.hMonth)}</span>${b.hPend ? `<span class="pend">+${hrs(b.hPend)} waiting</span>` : ""}</div>
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
    const cat = $("#r-cat");
    if (!cat.options.length) cat.innerHTML = `<option value="">All categories</option>` + CATS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
    cat.value = ui.rCat;
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
    let th = 0, tv = 0, hWait = 0;
    for (const s of rows) { if (!counts(s)) { if (approvalOf(s) === "pending") hWait += Number(s.hours) || 0; continue; } th += Number(s.hours) || 0; tv += (Number(s.hours) || 0) * (Number(s.rate) || 0); }
    const period = ui.hMonth ? new Date(ui.hMonth + "-01T12:00").toLocaleDateString(locale, { month: "long", year: "numeric" }) : "all time";
    el.innerHTML = `<div class="tablebox hours-table"><table>
      <thead><tr><th>Date</th><th>Person</th><th>Job · location</th><th class="n">Call–wrap</th><th class="n">Hours</th><th class="n">Rate</th><th class="n">Earned</th><th></th></tr></thead>
      <tbody>${rows.map((s) => `<tr>
        <td>${fmtShort(s.date)}${unsyncedTag("shifts", s.id) ? `<span class="sub">${unsyncedTag("shifts", s.id)}</span>` : ""}${approvalPill(s) ? `<span class="sub">${approvalPill(s)}</span>` : ""}${approvalOf(s) === "rejected" && s.approvalNote ? `<span class="sub">“${esc(s.approvalNote)}”</span>` : ""}</td>
        <td class="who">${esc(personName(s.personId))}</td>
        <td>${esc(s.job || "—")}${s.location ? `<span class="sub">${esc(s.location)}</span>` : ""}</td>
        <td class="n">${s.start && s.end ? `${esc(s.start)}–${esc(s.end)}` : `<span class="muted">—</span>`}</td>
        <td class="n">${hrs(s.hours)}</td>
        <td class="n">${money(s.rate)}</td>
        <td class="n">${money((Number(s.hours) || 0) * (Number(s.rate) || 0))}</td>
        <td class="n">${mine(s) ? `<button class="btn quiet sm" type="button" data-act="edit-shift" data-id="${s.id}">Edit</button>` : ""}</td>
      </tr>`).join("")}</tbody>
      <tfoot><tr><td colspan="4">${rows.length} ${rows.length === 1 ? "entry" : "entries"} · ${esc(period)}${hWait ? ` · <span class="muted">+ ${hrs(hWait)} waiting for approval</span>` : ""}</td><td class="n">${hrs(th)}</td><td></td><td class="n">${money(tv)}</td><td></td></tr></tfoot>
    </table></div>
    <div class="list">${rows.map((s) => `<button class="list-row" type="button" ${mine(s) ? `data-act="edit-shift" data-id="${s.id}"` : ""}>
        <span class="a">${esc(personName(s.personId))}</span><span class="b">${hrs(s.hours)}</span>
        <span class="c">${fmtShort(s.date)}${s.job ? " · " + esc(s.job) : ""}${s.location ? " · " + esc(s.location) : ""} ${unsyncedTag("shifts", s.id)}${approvalPill(s) ? ` ${approvalPill(s)}` : ""}</span><span class="d">${money((Number(s.hours) || 0) * (Number(s.rate) || 0))}</span>
      </button>`).join("")}
      <div class="list-foot"><span>${hrs(th)}${hWait ? `<small>+ ${hrs(hWait)} waiting</small>` : ""}</span><span>${money(tv)}</span></div>
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
    const byCat = new Map();
    for (const r of rows) byCat.set(catOf(r), (byCat.get(catOf(r)) || 0) + (Number(r.amount) || 0));
    el.innerHTML = `<p class="totals-line">${rows.length} ${rows.length === 1 ? "receipt" : "receipts"} · <span class="mono">${money(total)}</span></p>
      ${byCat.size > 1 || ui.rCat ? `<div class="cat-totals" aria-label="Totals by category">${CATS.filter(([k]) => byCat.has(k)).map(([k, l]) => `<span class="cat-total"><span class="cat c-${k}">${esc(l)}</span><span class="mono">${money(byCat.get(k))}</span></span>`).join("")}</div>` : ""}
      <div class="rgrid">${rows.map((r) => `<article class="receipt">
        <button class="shot" type="button" data-act="view-receipt" data-id="${r.id}" aria-label="Open receipt">${shot(r)}</button>
        <div class="meta">
          <div class="amt"><b>${money(r.amount)}</b>${r.status === "reimbursed" ? `<span class="pill paid">Reimbursed</span>` : `<span class="pill owed">To reimburse</span>`}</div>
          <div class="what">${esc(r.description || "No description")}</div>
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
    render();
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
    el.innerHTML = `
      <section class="panel">
        <h2>Your account</h2>
        <dl class="kv"><dt>Name</dt><dd>${esc(me.name)}</dd><dt>Username</dt><dd class="mono">${esc(me.username)}</dd><dt>Access</dt><dd>${isAdmin() ? "Admin" : "Staff"}</dd>
          <dt>On the board as</dt><dd>${myPerson() ? `${esc(myPerson().name)} · <a href="#me">My page</a>` : `<span class="muted">Not linked${isAdmin() ? " · link it under Team logins" : " · ask an admin to link your login"}</span>`}</dd></dl>
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
      <section class="panel wide">
        <div class="view-head"><div><h2>Team logins</h2><p>Staff can log hours, add receipts and update locations. Admins also manage people, rates and payments.</p></div>
          <div class="view-actions"><button class="btn primary" type="button" data-act="add-account">Add login</button></div></div>
        <div id="acct-list">${accountsErr ? `<p class="err">${esc(accountsErr)}</p>` : !accounts ? `<p class="muted">Loading…</p>` : accounts.map((a) => `<div class="acct">
          <div><div class="nm">${esc(a.name)} ${a.disabled ? `<span class="pill over">Disabled</span>` : ""}</div><div class="un">${esc(a.username)} · ${a.role === "admin" ? "Admin" : "Staff"}</div></div>
          <div class="ctl">
            <label class="link-sel"><span>Is</span><select data-link="${a.id}" aria-label="Person on the board for ${esc(a.name)}"><option value="">Not on the board</option>${state.people.slice().sort(byName).map((p) => `<option value="${p.id}" ${a.personId === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
            <button class="btn sm" type="button" data-act="reset-pw" data-id="${a.id}">Reset password</button>
            ${a.id === me.id ? "" : `<button class="btn sm" type="button" data-act="toggle-role" data-id="${a.id}">${a.role === "admin" ? "Make staff" : "Make admin"}</button>
            <button class="btn sm ${a.disabled ? "" : "danger"}" type="button" data-act="toggle-disabled" data-id="${a.id}">${a.disabled ? "Enable" : "Disable"}</button>`}
          </div></div>`).join("")}</div>
      </section>
      ${placesPanel()}
      <section class="panel wide" id="activity">${activityShell()}</section>` : ""}`;
    $("#install-btn")?.addEventListener("click", async () => { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; renderSettings(); });
    $("#currency")?.addEventListener("change", (e) => save("settings", { ...state.settings, id: "main", currency: e.target.value }).then(() => toast("Currency saved")));
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
    $("#dt-body").innerHTML = `
      <dl class="kv">
        <dt>Role</dt><dd>${roleLabel(p.role)}${p.speciality ? " · " + esc(p.speciality) : ""}</dd>
        <dt>Rate</dt><dd class="mono">${money(p.rate)} / h</dd>
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
        ${isAdmin() ? `<button class="btn sm primary" type="button" data-act="add-payment" data-id="${id}" ${b.owed > 0.004 ? "" : "disabled"}>${ICON.card}Record payment</button>` : ""}
      </div>
      <h4 class="eyebrow">Hours · ${hrs(b.hAll)} all time${b.hPend ? ` · + ${hrs(b.hPend)} waiting for approval` : ""}</h4>
      ${shifts.length ? `<div class="tablebox"><table><thead><tr><th>Date</th><th>Job · location</th><th class="n">Hours</th><th class="n">Earned</th></tr></thead><tbody>
        ${shifts.slice(0, 60).map((s) => `<tr><td>${fmtShort(s.date)}${approvalPill(s) ? `<span class="sub">${approvalPill(s)}</span>` : ""}</td><td>${esc(s.job || "—")}${s.location ? `<span class="sub">${esc(s.location)}</span>` : ""}</td><td class="n">${hrs(s.hours)}</td><td class="n">${money((Number(s.hours) || 0) * (Number(s.rate) || 0))}</td></tr>`).join("")}
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
    const self = staffMe() ? myPerson().id : "";
    $("#quick").innerHTML = opts.map(([a, i, t, s]) => `<button type="button" data-act="${a}"${self && ["add-shift", "add-receipt", "loc"].includes(a) ? ` data-id="${self}"` : ""}>${i}<div><b>${t}</b><span>${s}</span></div></button>`).join("");
    openSheet("#d-quick");
  }

  // Person
  let editingPerson = null;
  function openPerson(id) {
    if (!isAdmin()) return;
    editingPerson = id || null;
    const p = state.people.find((x) => x.id === id) || {};
    $("#pf-title").textContent = id ? `Edit ${p.name}` : "Add person";
    $("#pf-name").value = p.name || ""; $("#pf-role").value = p.role || "model"; $("#pf-rate").value = p.rate ?? "";
    $("#pf-spec").value = p.speciality || ""; $("#pf-loc").value = p.location || ""; $("#pf-phone").value = p.phone || "";
    $("#pf-del").hidden = !id; disarm($("#pf-del"), "Delete");
    showErr($("#pf-err"), "");
    openSheet("#d-person"); $("#pf-name").focus();
  }
  $("#d-person form").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.currentTarget, err = $("#pf-err");
    const name = $("#pf-name").value.trim(), rate = parseFloat($("#pf-rate").value);
    if (!name) return showErr(err, "Enter their name.");
    if (!(rate >= 0)) return showErr(err, "Enter an hourly rate. Use 0 for unpaid roles.");
    attempt(form, err, async () => {
      const prev = state.people.find((x) => x.id === editingPerson);
      const location = $("#pf-loc").value.trim();
      const data = { ...(prev || {}), name, role: $("#pf-role").value, rate: round2(rate), speciality: $("#pf-spec").value.trim(), phone: $("#pf-phone").value.trim(), location };
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
  function shiftCalc() {
    const h = parseFloat($("#sf-hours").value) || 0, r = parseFloat($("#sf-rate").value) || 0;
    const el = $("#sf-calc"); el.hidden = !(h && r);
    el.textContent = `${hrs(h)} × ${money(r)} = ${money(h * r)}`;
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
    $("#sf-rate").value = s.rate ?? p?.rate ?? "";
    $("#sf-rate").readOnly = !isAdmin() && !!p; // staff use the agreed rate
    $("#sf-job").value = s.job || "";
    $("#sf-loc").value = shiftId ? s.location || "" : p?.location || "";
    $("#sf-del").hidden = !shiftId; disarm($("#sf-del"), "Delete");
    showErr($("#sf-err"), ""); shiftCalc();
    openSheet("#d-shift");
  }
  $("#sf-person").addEventListener("change", () => {
    if (editingShift) return;
    const p = state.people.find((x) => x.id === $("#sf-person").value);
    if (p) { $("#sf-rate").value = p.rate ?? ""; $("#sf-loc").value = p.location || ""; }
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
    if (!(rate >= 0)) return showErr(err, "Enter the hourly rate.");
    attempt(e.currentTarget, err, async () => {
      const prev = state.shifts.find((x) => x.id === editingShift);
      const personId = $("#sf-person").value, location = $("#sf-loc").value.trim();
      await save("shifts", { ...(prev || {}), personId, date, hours: round2(hours), rate: round2(rate), start: $("#sf-start").value, end: $("#sf-end").value, job: $("#sf-job").value.trim(), location });
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
    const rc = $("#rf-cat");
    if (!rc.options.length) rc.innerHTML = CATS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
    rc.value = ui.lastCat || "travel";
    showErr($("#rf-err"), "");
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
      ui.lastCat = $("#rf-cat").value;
      await save("receipts", { id, category: $("#rf-cat").value, personId: $("#rf-person").value, amount: round2(amount), date, description: $("#rf-desc").value.trim(), status: "pending", hasPhoto: !!picked, photoType: picked?.type || null, photoUploaded: false });
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
        <dt>Category</dt><dd><span class="cat c-${catOf(r)}">${esc(catLabel(catOf(r)))}</span></dd>
        <dt>Date</dt><dd>${fmtDate(r.date)}</dd>
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
      case "place-del": return armed(t, "Remove?", () => { const pl = state.places.find((x) => x.id === id); if (pl) remove("places", pl).then(() => toast("Place removed")); });
      case "act-more": return loadActivity(true);
      case "my-hours": ui.hPerson = id; ui.hMonth = ""; location.hash = "hours"; return;
      case "my-receipts": ui.rPerson = id; ui.rStatus = "all"; $$("#rec-seg button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.rs === "all"))); location.hash = "receipts"; return;
      case "view-receipt": return openView(id);
      case "add-payment": return openPay(id);
      case "goto-hours": location.hash = "hours"; return;
      case "detail": detailId = id; renderDetail(id); return openSheet("#d-detail");
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

  // ---------- My page ----------
  // Linked staff see "My page" in place of the Team tab; the board stays one tap away.
  const NAV_SVG = { team: $("#nav-team svg").innerHTML, me: `<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.7-3.6 3.4-5.6 7-5.6s6.3 2 7 5.6"/>` };
  function paintNav() {
    const a = $("#nav-team"), on = staffMe();
    if (a.dataset.me === String(on)) return;
    a.dataset.me = String(on);
    a.setAttribute("href", on ? "#me" : "#team");
    a.querySelector("span").textContent = on ? "My page" : "Team";
    a.querySelector("svg").innerHTML = on ? NAV_SVG.me : NAV_SVG.team;
  }
  function paintMe() {
    $("#me-chip").innerHTML = `<div><b>${esc(me.name)}</b>${isAdmin() ? "Admin" : "Staff"}</div>`;
    render();
  }

  function renderMe(bal) {
    const el = $("#mypage"), p = myPerson();
    if (!p) {
      el.innerHTML = `<div class="view-head"><div><h1>My page</h1><p>Your hours, receipts and what you're owed, in one place.</p></div></div>` +
        empty("Your login isn't linked to the board yet", isAdmin() ? "Link your login to your name in Settings → Team logins." : "Ask an admin to link your login to your name on the board. Then your hours and balance show here.");
      return;
    }
    const b = bal.get(p.id), m = isoMonth();
    const desc = (a, c) => (c.date || "").localeCompare(a.date || "") || (c.createdAt || 0) - (a.createdAt || 0);
    const shifts = state.shifts.filter((s) => s.personId === p.id).sort(desc);
    const recs = state.receipts.filter((r) => r.personId === p.id).sort(desc);
    const waitMonth = shifts.filter((s) => approvalOf(s) === "pending" && (s.date || "").startsWith(m)).reduce((a, s) => a + (Number(s.hours) || 0), 0);
    const rejected = shifts.filter((s) => approvalOf(s) === "rejected");
    const live = p.location && p.locationAt && Date.now() - p.locationAt < 12 * 3600e3;
    const shiftRow = (s) => {
      const inner = `<span class="r-main"><span class="r-title">${fmtShort(s.date)}${s.start && s.end ? ` <span class="muted mono">${esc(s.start)}–${esc(s.end)}</span>` : ""}</span>
        <span class="r-sub">${[esc(s.job || ""), esc(s.location || "")].filter(Boolean).join(" · ") || "No job noted"}</span></span>
        <span class="r-end"><span class="mono">${hrs(s.hours)}</span>${approvalPill(s) || unsyncedTag("shifts", s.id)}</span>`;
      return mine(s) ? `<li><button class="r" type="button" data-act="edit-shift" data-id="${s.id}">${inner}</button></li>` : `<li><div class="r">${inner}</div></li>`;
    };
    const recRow = (r) => `<li><button class="r" type="button" data-act="view-receipt" data-id="${r.id}">
        <span class="r-main"><span class="r-title">${esc(r.description || "Receipt")}</span>
        <span class="r-sub"><span class="cat c-${catOf(r)}">${esc(catLabel(catOf(r)))}</span> ${fmtShort(r.date)} ${unsyncedTag("receipts", r.id)}</span></span>
        <span class="r-end"><span class="mono">${money(r.amount)}</span>${r.status === "reimbursed" ? `<span class="pill paid">Reimbursed</span>` : `<span class="pill owed">To reimburse</span>`}</span></button></li>`;
    el.innerHTML = `
      <div class="me-head">
        <div class="me-id">
          <span class="eyebrow">My page</span>
          <h1 class="me-name">${esc(p.name)}</h1>
          <div class="comp-role"><span class="tag ${p.role === "technician" ? "technician" : "model"}">${roleLabel(p.role)}</span>${p.speciality ? `<span>${esc(p.speciality)}</span>` : ""}<span class="mono">${money(p.rate)} / h</span></div>
        </div>
        <div class="view-actions"><a class="btn" href="#team">${ICON.pin}Team board</a></div>
      </div>
      <div class="summary me-sum">
        <div><span class="eyebrow">Owed to you</span><span class="big ${b.owed > 0.004 ? "" : "zero"}">${money(b.owed)}</span>
          <span class="note">${b.owed > 0.004 ? `Wages ${money(Math.max(0, b.wageDue))} · receipts ${money(b.rec)}` : b.owed < -0.004 ? "Paid ahead of hours worked" : "You're paid up"}</span></div>
        <div><span class="eyebrow">Paid to you</span><span class="mid">${money(b.paid)}</span><span class="note">wages so far</span></div>
        <div><span class="eyebrow">Receipts</span><span class="mid">${money(b.rec)}</span><span class="note">${b.recN} waiting to be paid back</span></div>
        <div><span class="eyebrow">This month</span><span class="mid">${hrs(b.hMonth)}</span><span class="note">${waitMonth ? `+ ${hrs(waitMonth)} waiting for approval` : "approved"}</span></div>
      </div>
      ${rejected.length ? `<div class="me-alert">${rejected.map((s) => `<div><span><b>${hrs(s.hours)} on ${fmtShort(s.date)} was rejected.</b>${s.approvalNote ? ` “${esc(s.approvalNote)}”` : ""} Fix it and save to send it again.</span>${mine(s) ? `<button class="btn sm" type="button" data-act="edit-shift" data-id="${s.id}">Fix</button>` : ""}</div>`).join("")}</div>` : ""}
      <div class="me-quick">
        <button type="button" data-act="add-shift" data-id="${p.id}">${ICON.clock}<span><b>Log my hours</b><small>Call, wrap and job</small></span></button>
        <button type="button" data-act="add-receipt" data-id="${p.id}">${ICON.cam}<span><b>Add receipt</b><small>Photograph an expense</small></span></button>
        <button type="button" data-act="loc" data-id="${p.id}" class="${live ? "live" : ""}">${ICON.pin}<span><b>Check in</b><small>${p.location ? `${esc(p.location)} · ${ago(p.locationAt)}` : "Say where you are"}</small></span></button>
      </div>
      <div class="me-cols">
        <section class="panel me-list">
          <div class="me-list-head"><h2>Recent hours</h2><button class="btn quiet sm" type="button" data-act="my-hours" data-id="${p.id}">All my hours</button></div>
          ${shifts.length ? `<ul class="rows">${shifts.slice(0, 8).map(shiftRow).join("")}</ul>` : `<p>No hours yet. Log a call and wrap, or just the hours.</p>`}
          ${b.nPend ? `<p class="me-foot"><span class="pill wait">${b.nPend} waiting</span> Hours count toward what you're owed once an admin approves them.</p>` : ""}
        </section>
        <section class="panel me-list">
          <div class="me-list-head"><h2>Recent receipts</h2><button class="btn quiet sm" type="button" data-act="my-receipts" data-id="${p.id}">All my receipts</button></div>
          ${recs.length ? `<ul class="rows">${recs.slice(0, 6).map(recRow).join("")}</ul>` : `<p>No receipts. Photograph one when you pay for something on a job.</p>`}
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
    el.innerHTML = `<section class="queue" aria-label="Waiting for approval">
      <div class="queue-head">
        <div><h2>Waiting for approval</h2><p>${list.length} ${list.length === 1 ? "entry" : "entries"} · <span class="mono">${hrs(total)}</span>. Hours count toward what's owed once approved.</p></div>
        <div class="queue-acts">
          <label class="pick-all"><input type="checkbox" id="q-all" ${n === list.length ? "checked" : ""}>Select all</label>
          <button class="btn sm danger" type="button" data-act="q-reject-sel" ${n ? "" : "disabled"}>Reject${n ? ` ${n}` : ""}</button>
          <button class="btn sm primary" type="button" data-act="q-approve-sel" ${n ? "" : "disabled"}>Approve${n ? ` ${n}` : ""}</button>
        </div>
      </div>
      <ul class="q-list">${list.map((s) => {
        const by = accountName(s.by);
        return `<li class="q-row${ui.qSel.has(s.id) ? " sel" : ""}">
          <input type="checkbox" class="q-pick" data-id="${s.id}" aria-label="Select ${esc(personName(s.personId))}, ${esc(fmtShort(s.date))}" ${ui.qSel.has(s.id) ? "checked" : ""}>
          <div class="q-main">
            <div class="q-top"><b>${esc(personName(s.personId))}</b><span class="mono">${hrs(s.hours)}</span></div>
            <div class="q-sub">${[fmtShort(s.date), s.start && s.end ? `${esc(s.start)}–${esc(s.end)}` : "", esc(s.job || ""), esc(s.location || "")].filter(Boolean).join(" · ")}</div>
            <div class="q-by">${by ? `Logged by ${esc(by)}` : "Logged by staff"} · ${ago(s.updatedAt || s.createdAt)} ${unsyncedTag("shifts", s.id)}</div>
          </div>
          <div class="q-acts">
            <button class="btn sm quiet" type="button" data-act="edit-shift" data-id="${s.id}">Edit</button>
            <button class="btn sm danger" type="button" data-act="q-reject" data-id="${s.id}">Reject</button>
            <button class="btn sm ok" type="button" data-act="q-approve" data-id="${s.id}">Approve</button>
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
    toast(list.length === 1 ? `${hrs(list[0].hours)} approved for ${personName(list[0].personId)}` : `${list.length} entries approved`);
  }
  let rejectIds = [];
  function openReject(ids) {
    rejectIds = ids.filter((id) => state.shifts.some((s) => s.id === id));
    if (!rejectIds.length) return;
    const one = rejectIds.length === 1 ? state.shifts.find((s) => s.id === rejectIds[0]) : null;
    $("#rj-title").textContent = one ? `Reject ${hrs(one.hours)} for ${personName(one.personId)}` : `Reject ${rejectIds.length} entries`;
    $("#rj-what").textContent = one ? [fmtDate(one.date), one.job, one.location].filter(Boolean).join(" · ") : "They stay on the hours list, marked rejected, and don't count toward what's owed.";
    $("#rj-btn").textContent = one ? "Reject" : `Reject ${rejectIds.length}`;
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
      toast(list.length === 1 ? "Rejected. They'll see your note." : `${list.length} entries rejected`);
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
    box.innerHTML = (saved.length ? `<div class="places-group"><span class="eyebrow">Saved places</span><div class="chips">${saved.map((n) => placeChip(n, n.trim().toLowerCase() === cur)).join("")}</div></div>` : "")
      + (recent.length ? `<div class="places-group"><span class="eyebrow">Recently used</span><div class="chips">${recent.map((n) => placeChip(n, n.toLowerCase() === cur)).join("")}</div></div>` : "");
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
      <h2>Saved places</h2>
      <p>Studios and venues the team goes to often. They show as one-tap buttons when someone checks in.</p>
      ${list.length ? `<div class="chips">${list.map((pl) => `<span class="chip static">${ICON.pin}<span>${esc(pl.name)}</span><button type="button" class="chip-x" data-act="place-del" data-id="${pl.id}" aria-label="Remove ${esc(pl.name)}">Remove</button></span>`).join("")}</div>` : ""}
      <form class="inline-add" id="place-form" novalidate>
        <input class="input" id="place-name" maxlength="120" autocomplete="off" placeholder="Studio 3, Via Tortona" aria-label="New place" value="${esc(ui.placeDraft || "")}">
        <button class="btn" type="submit">Add place</button>
      </form>
    </section>`;
  }

  // ---------- Activity (admins; the server keeps it, nobody can edit it) ----------
  const act = { entries: [], next: null, loading: false, err: null, loaded: false };
  function activityShell() {
    const people = state.people.slice().sort(byName);
    return `<div class="view-head"><div><h2>Activity</h2><p>Who did what, newest first. The server records every change; nobody can edit this list.</p></div>
      <div class="view-actions act-filters">
        <select id="act-person" aria-label="About">${`<option value="">About anyone</option>` + people.map((p) => `<option value="${p.id}" ${ui.actPerson === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
        <select id="act-user" aria-label="Done by">${`<option value="">By anyone</option>` + (accounts || []).map((a) => `<option value="${a.id}" ${ui.actUser === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select>
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
    } catch (e) { act.err = e.status ? e.msg : "Connect to the internet to see the activity."; }
    act.loading = false; act.loaded = true; paintActivity();
  }
  function actPerson(e) {
    const name = state.people.find((p) => p.id === e.personId)?.name || e.personName;
    return name ? `<b>${esc(name)}</b>` : "someone";
  }
  function actText(e) {
    // "Sara logged 8.5 h for themselves" rather than repeating her name.
    const own = /^(shift|receipt)\.|^person\.checkin$/.test(e.verb);
    const self = own && !!e.personId && accounts?.find((a) => a.id === e.userId)?.personId === e.personId;
    const i = e.info || {}, P = self ? "themselves" : actPerson(e), Ps = self ? "their" : `${actPerson(e)}'s`, T = `<b>${esc(i.target || "a login")}</b>`;
    const H = `<span class="mono">${hrs(i.hours)}</span>`, M = `<span class="mono">${money(i.amount)}</span>`;
    const on = i.date ? ` · ${fmtShort(i.date)}` : "";
    const t = {
      "shift.add": `logged ${H} for ${P}${on}${i.pending ? ` <span class="pill wait">Waiting</span>` : ""}`,
      "shift.edit": `changed ${Ps} hours to ${H}${on}${i.reopened ? ` <span class="pill wait">Back to waiting</span>` : ""}`,
      "shift.delete": `deleted ${H} for ${P}${on}`,
      "shift.approve": `approved ${H} for ${P}${on}`,
      "shift.reject": `rejected ${H} for ${P}${on}${i.note ? ` <span class="muted">“${esc(i.note)}”</span>` : ""}`,
      "receipt.add": `added a ${M} ${i.category ? esc(catLabel(i.category).toLowerCase()) + " " : ""}receipt for ${P}`,
      "receipt.edit": `edited a ${M} receipt for ${P}`,
      "receipt.delete": `deleted a ${M} receipt for ${P}`,
      "receipt.reimburse": `marked ${Ps} ${M} receipt reimbursed`,
      "receipt.unreimburse": `put ${Ps} ${M} receipt back to reimburse`,
      "payment.add": `recorded a ${M} payment to ${P}`,
      "payment.edit": `edited a ${M} payment to ${P}`,
      "payment.delete": `deleted a ${M} payment to ${P}`,
      "person.add": `added ${P} to the board`,
      "person.edit": `updated ${P}'s details`,
      "person.rate": `set ${P}'s rate to <span class="mono">${money(i.rate)}</span> / h`,
      "person.checkin": i.location ? (self ? `checked in at ${esc(i.location)}` : `checked ${P} in at ${esc(i.location)}`) : `cleared ${Ps} location`,
      "person.delete": `removed ${P} from the board`,
      "settings.edit": `set the currency to ${esc(i.currency || "")}`,
      "place.add": `saved the place ${esc(i.name || "")}`,
      "place.edit": `renamed a saved place to ${esc(i.name || "")}`,
      "place.delete": `removed the saved place ${esc(i.name || "")}`,
      "account.add": `created a ${i.role === "admin" ? "admin" : "staff"} login for ${T}`,
      "account.link": `linked ${T}'s login to ${P}`,
      "account.unlink": `unlinked ${T}'s login from ${P}`,
      "account.role": `made ${T} ${i.role === "admin" ? "an admin" : "staff"}`,
      "account.disable": `disabled ${T}'s login`,
      "account.enable": `enabled ${T}'s login`,
      "account.password": `reset ${T}'s password`,
    }[e.verb] || esc(e.verb);
    return `<b>${esc(e.actor || "Someone")}</b> ${t}`;
  }
  const actTone = (v) => v === "shift.approve" || v === "receipt.reimburse" ? "ok" : v === "shift.reject" || v.endsWith(".delete") ? "risk" : v.startsWith("payment") ? "money" : v === "shift.add" || v === "receipt.add" ? "new" : "";
  function dayLabel(ms) {
    const d = isoDay(new Date(ms)), today = isoDay(), y = isoDay(new Date(Date.now() - 864e5));
    return d === today ? "Today" : d === y ? "Yesterday" : fmtShort(d);
  }
  function paintActivity() {
    const el = $("#act-list"); if (!el) return;
    if (!act.loaded && !act.loading) { loadActivity(false); return; }
    if (act.err && !act.entries.length) { el.innerHTML = `<p class="err">${esc(act.err)}</p>`; return; }
    if (!act.entries.length) { el.innerHTML = act.loading ? `<p class="muted">Loading…</p>` : `<p class="muted">Nothing yet. Changes appear here as people log hours, add receipts and record payments.</p>`; return; }
    let day = "", html = "";
    for (const e of act.entries) {
      const dl = dayLabel(e.at);
      if (dl !== day) { if (day) html += `</ol>`; html += `<h3 class="act-day eyebrow">${esc(dl)}</h3><ol class="act-list">`; day = dl; }
      html += `<li class="act-row"><span class="act-dot ${actTone(e.verb)}" aria-hidden="true"></span><span class="act-txt">${actText(e)}</span><time datetime="${new Date(e.at).toISOString()}" title="${esc(new Date(e.at).toLocaleString(locale))}">${Date.now() - e.at < 864e5 ? ago(e.at) : new Date(e.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</time></li>`;
    }
    html += `</ol>`;
    if (act.next) html += `<div class="act-more"><button class="btn" type="button" data-act="act-more" ${act.loading ? "disabled" : ""}>${act.loading ? "Loading…" : "Show older"}</button></div>`;
    if (act.err) html += `<p class="err">${esc(act.err)}</p>`;
    el.innerHTML = html;
  }
  function bindSettingsExtras() {
    $$("[data-link]").forEach((sel) => sel.addEventListener("change", async () => {
      const id = sel.dataset.link, personId = sel.value || null;
      try {
        await api("/api/users/" + id, { body: { personId } });
        if (id === me.id) { me = { ...me, personId }; await meta.set("me", me); }
        const a = accounts.find((x) => x.id === id);
        toast(personId ? `${a?.name || "Login"} linked to ${personName(personId)}` : `${a?.name || "Login"} unlinked`);
        act.loaded = false;
      } catch (err) { toast(err.msg || "Connect to the internet to change links."); }
      loadAccounts();
    }));
    $("#place-name").addEventListener("input", (e) => (ui.placeDraft = e.target.value));
    $("#place-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = $("#place-name").value.trim().replace(/\s+/g, " ").slice(0, 120);
      if (!name) return $("#place-name").focus();
      if (state.places.some((p) => (p.name || "").toLowerCase() === name.toLowerCase())) return toast("That place is already saved");
      ui.placeDraft = "";
      await save("places", { name });
      toast(`${name} saved`);
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
    if (kind === "hours") download(`hours-${ui.hMonth || "all"}.csv`, [["Date", "Person", "Role", "Job", "Location", "Call", "Wrap", "Hours", "Rate", "Earned", "Approval"],
      ...shiftsShown().map((s) => { const p = state.people.find((x) => x.id === s.personId); return [s.date, p?.name, roleLabel(p?.role), s.job, s.location, s.start, s.end, s.hours, s.rate, round2(s.hours * s.rate), { approved: "Approved", pending: "Waiting for approval", rejected: "Rejected" }[approvalOf(s)]]; })]);
    else if (kind === "receipts") download(`receipts-${isoDay()}.csv`, [["Date", "Person", "Category", "Description", "Amount", "Status", "Reimbursed on"],
      ...receiptsShown().map((r) => [r.date, personName(r.personId), catLabel(catOf(r)), r.description, r.amount, r.status === "reimbursed" ? "Reimbursed" : "To reimburse", r.reimbursedAt || ""])]);
    else download(`payments-${isoDay()}.csv`, [["Date", "Person", "Method", "Note", "Wages", "Receipts", "Total"],
      ...state.payments.filter((p) => !ui.pPerson || p.personId === ui.pPerson).sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((p) => [p.date, personName(p.personId), p.method, p.note, p.amount, p.receiptsAmount || 0, round2((p.amount || 0) + (p.receiptsAmount || 0))])]);
  }));

  // ---------- Routing ----------
  const TABS = ["team", "hours", "receipts", "payments", "settings", "me"];
  function route() {
    const h = location.hash.slice(1);
    ui.tab = TABS.includes(h) ? h : staffMe() ? "me" : "team"; // linked staff land on their own page
    $$(".nav a").forEach((a) => (a.dataset.tab === ui.tab || (a.dataset.tab === "team" && ui.tab === "me") ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
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
    $("#app").hidden = true; $("#auth").hidden = false;
    $("#login-form").hidden = mode !== "login"; $("#setup-form").hidden = mode !== "setup";
    (mode === "login" ? $("#li-user") : $("#su-name")).focus();
  }
  async function enter(user) {
    const prev = await meta.get("me");
    if (prev && prev.id !== user.id) { await idb.wipe(); await loadState(); } // a different person on this device
    me = user; await meta.set("me", user);
    sync.authLost = false;
    $("#auth").hidden = true; $("#app").hidden = false;
    $("#me-chip").innerHTML = `<div><b>${esc(user.name)}</b>${user.role === "admin" ? "Admin" : "Staff"}</div>`;
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
