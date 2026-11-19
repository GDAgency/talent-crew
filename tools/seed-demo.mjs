// Fills a Talent & Crew server with a realistic demo: 8 people, places, jobs around
// today, hours, receipts, payments and check-ins, plus a demo staff login.
// Everything goes through the app's own API (as the given admin), so records are
// validated and stored exactly as if typed in. Past check-in history can't be
// backdated through the API; the matching audit rows are printed as JSON on stdout
// (prefixed "CHECKINS ") for the operator to insert if wanted.
//
//   ADMIN_URL=… TEAM_URL=… ADMIN_USER=… ADMIN_PASS=… STAFF_USER=… STAFF_PASS=… node tools/seed-demo.mjs
const { ADMIN_URL, TEAM_URL, ADMIN_USER, ADMIN_PASS, STAFF_USER, STAFF_PASS } = process.env;
if (!ADMIN_URL || !TEAM_URL || !ADMIN_USER || !ADMIN_PASS || !STAFF_USER || !STAFF_PASS) { console.error("missing env"); process.exit(2); }

const pad = (n) => String(n).padStart(2, "0");
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const at = (offset, hh, mm = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(hh, mm, 0, 0); return d.getTime(); };
const rid = (p) => `demo-${p}-${Math.random().toString(36).slice(2, 10)}`;
const round2 = (n) => Math.round(n * 100) / 100;

async function login(base, username, password) {
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "x-tc": "1", "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  if (!r.ok) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const me = (await r.json()).user;
  return { base, cookie, me };
}
async function call(s, path, body, method = "POST") {
  const r = await fetch(s.base + path, { method, headers: { "x-tc": "1", "content-type": "application/json", cookie: s.cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
}
async function push(s, changes) {
  const stamped = changes.map((ch, i) => ({ ...ch, data: { createdAt: Date.now(), ...ch.data, id: ch.id, updatedAt: Date.now() + i } }));
  for (let i = 0; i < stamped.length; i += 200) {
    const r = await call(s, "/api/sync", { since: 1e15, changes: stamped.slice(i, i + 200) });
    if (r.denied) throw new Error(`sync: ${r.denied} change(s) denied`);
  }
}

// ---------- The demo ----------
const PLACES = ["Studio Ventura, Via Ventura 15, Milano", "Palazzo Clerici, Via Clerici 5, Milano", "Fabbrica del Vapore, Via Procaccini 4, Milano", "Studio Navigli, Alzaia Naviglio Grande 66, Milano"];
const [VENTURA, CLERICI, VAPORE, NAVIGLI] = PLACES;
const HQ = "Piazza Duomo 20, Milano";
const terms = (payType, rate, dayRate = 0) => ({ payType, rate, dayRate, halfDayRate: 0, halfDayUnder: 0, otAfter: 0, otMult: 1 });
const PEOPLE = [
  { key: "giulia", name: "Giulia Ferri", role: "model", speciality: "Editoriale, campagne", phone: "+39 333 410 2281", ...terms("day", 60, 450) },
  { key: "sofia", name: "Sofia Marino", role: "model", speciality: "Sfilata, lookbook", phone: "+39 347 118 9043", ...terms("hourly", 65) },
  { key: "aurora", name: "Aurora Conti", role: "model", speciality: "Commerciale, video", phone: "+39 340 772 1560", ...terms("hourly", 55) },
  { key: "matteo", name: "Matteo Galli", role: "model", speciality: "Moda uomo", phone: "+39 338 905 3317", ...terms("hourly", 60) },
  { key: "beatrice", name: "Beatrice Russo", role: "model", speciality: "Sfilata, beauty", phone: "+39 349 260 7784", ...terms("day", 50, 400) },
  { key: "luca", name: "Luca Bianchi", role: "technician", speciality: "Luci", phone: "+39 335 618 2209", ...terms("hourly", 38) },
  { key: "davide", name: "Davide Moretti", role: "technician", speciality: "Assistente fotografo", phone: "+39 331 447 9012", ...terms("hourly", 35) },
  { key: "chiara", name: "Chiara Esposito", role: "technician", speciality: "Trucco e parrucco", phone: "+39 346 553 1876", ...terms("hourly", 32) },
];
const P = Object.fromEntries(PEOPLE.map((p) => [p.key, { ...p, id: rid("p") }]));
const pay = (p, h) => (p.payType === "day" ? p.dayRate : round2(h * p.rate));

// [client, title, from, to, call, location, crew, billing, amount, invoiceStatus, hours by person (worked days only)]
const JOBS = [
  ["Maison Verdi", "Lookbook primavera", -13, -12, "08:00", VENTURA, ["giulia", "sofia", "luca", "chiara"], "flat", 6800, "paid"],
  ["Atelier Brera", "Editoriale autunno", -8, -8, "09:30", CLERICI, ["aurora", "matteo", "davide"], "hourly", 180, "invoiced"],
  ["Casa Lanzi", "Catalogo gioielli", -5, -5, "10:00", NAVIGLI, ["beatrice", "sofia", "luca"], "flat", 3900, "not invoiced"],
  ["Rivista Lume", "Copertina dicembre", -2, -2, "07:30", VAPORE, ["giulia", "davide", "chiara"], "flat", 2500, "not invoiced"],
  ["Maison Verdi", "Campagna inverno", 0, 1, "08:00", VENTURA, ["giulia", "matteo", "luca", "chiara"], "flat", 7200, "not invoiced"],
  ["Ottica Sorelle Neri", "Video prodotto", 2, 2, "09:00", CLERICI, ["aurora", "davide"], "hourly", 150, "not invoiced"],
  ["Atelier Brera", "Sfilata collezione", 5, 6, "14:00", VAPORE, ["sofia", "beatrice", "aurora", "luca", "chiara"], "flat", 9500, "not invoiced"],
  ["Atelier Brera", "Lookbook uomo", 9, 9, "09:00", NAVIGLI, ["matteo", "giulia", "davide"], "flat", 3200, "not invoiced"],
].map(([client, title, from, to, call, location, crew, billing, amount, inv]) => ({ id: rid("j"), client, title, from, to, call, location, crew, billing, amount, inv }));

const endOf = (start, h) => { const [hh, mm] = start.split(":").map(Number); const t = hh * 60 + mm + Math.round(h * 60); return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`; };
const HOURS = { giulia: 8, sofia: 7.5, aurora: 6, matteo: 7, beatrice: 8, luca: 9, davide: 8.5, chiara: 7 };

const admin = await login(ADMIN_URL, ADMIN_USER, ADMIN_PASS);
console.log("signed in as", admin.me.name);

// Places (the agency address is already there)
await push(admin, PLACES.map((name) => ({ c: "places", id: rid("pl"), data: { name } })));

// People, with today's position for the ones not working today
const workingToday = new Set(JOBS.filter((j) => j.from <= 0 && 0 <= j.to).flatMap((j) => j.crew));
await push(admin, PEOPLE.map(({ key }) => {
  const { id, ...p } = P[key]; delete p.key;
  return { c: "people", id, data: { ...p } };
}));

// Jobs
await push(admin, JOBS.map((j) => ({ c: "jobs", id: j.id, data: {
  client: j.client, title: j.title, date: day(j.from), endDate: j.to > j.from ? day(j.to) : "", call: j.call, location: j.location, notes: "",
  people: j.crew.map((k) => P[k].id), billing: j.billing, fee: j.billing === "flat" ? j.amount : 0, clientRate: j.billing === "hourly" ? j.amount : 0, invoiceStatus: j.inv,
} })));

// Hours on every past job day (and today), logged by the office: approved.
const shifts = [], earned = {};
for (const j of JOBS) for (let d = j.from; d <= Math.min(j.to, 0); d++) for (const k of j.crew) {
  if (d === 0 && k === "luca") continue; // still on set today: hours come in later
  const p = P[k], h = HOURS[k] - (d === j.to ? 0 : 0.5);
  const { payType, rate, dayRate, halfDayRate, halfDayUnder, otAfter, otMult } = p;
  shifts.push({ c: "shifts", id: rid("s"), data: { personId: p.id, date: day(d), hours: h, payType, rate, dayRate, halfDayRate, halfDayUnder, otAfter, otMult,
    start: j.call, end: endOf(j.call, h), job: `${j.client} · ${j.title}`, location: j.location, jobId: j.id } });
  (earned[j.id] ||= {})[k] = round2(((earned[j.id] || {})[k] || 0) + pay(p, h));
}
await push(admin, shifts);

// Receipts: a few reimbursed with the first job's payments, the rest still open.
const R = (k, d, category, amount, description, jobIdx) => ({ c: "receipts", id: rid("r"), data: { personId: P[k].id, date: day(d), category, amount, description, jobId: jobIdx == null ? "" : JOBS[jobIdx].id, status: "pending", hasPhoto: false } });
const receipts = [
  R("giulia", -13, "travel", 18.5, "Taxi Centrale – Studio Ventura", 0),
  R("chiara", -13, "hair", 46.9, "Fondotinta e cipria", 0),
  R("luca", -12, "equipment", 32, "Gelatine colorate", 0),
  R("davide", -8, "travel", 14, "Taxi Palazzo Clerici", 1),
  R("sofia", -5, "meals", 12.8, "Pranzo sul set", 2),
  R("chiara", -2, "hair", 27.4, "Lacca e forcine", 3),
  R("giulia", -2, "travel", 21, "Taxi Fabbrica del Vapore", 3),
];
await push(admin, receipts);

// Payments: everyone on the first job is paid for it, with their receipts from it.
const first = JOBS[0], pays = [], reimbursed = [];
for (const k of first.crew) {
  const recs = receipts.filter((r) => r.data.personId === P[k].id && r.data.jobId === first.id);
  const recAmt = round2(recs.reduce((a, r) => a + r.data.amount, 0));
  pays.push({ c: "payments", id: rid("y"), data: { personId: P[k].id, date: day(-6), amount: earned[first.id][k], method: "Bank transfer", note: `${first.client} · ${first.title}`, receiptIds: recs.map((r) => r.id), receiptsAmount: recAmt } });
  for (const r of recs) reimbursed.push({ c: "receipts", id: r.id, data: { ...r.data, status: "reimbursed", reimbursedAt: day(-6) } });
}
// …and Aurora got an advance in cash.
pays.push({ c: "payments", id: rid("y"), data: { personId: P.aurora.id, date: day(-3), amount: 200, method: "Cash", note: "Acconto", receiptIds: [], receiptsAmount: 0 } });
await push(admin, pays);
await push(admin, reimbursed);

// Where people are right now (this also records today's check-ins).
const todayJob = JOBS.find((j) => j.from <= 0 && 0 <= j.to);
const now = { aurora: HQ, beatrice: "Showroom Atelier Brera, Corso Garibaldi 42, Milano", davide: CLERICI };
for (const k of todayJob.crew) now[k] = todayJob.location;
const people = (await call(admin, "/api/sync", { since: 0, changes: [] })).records.filter((r) => r.c === "people");
await push(admin, Object.entries(now).map(([k, loc]) => { const cur = people.find((r) => r.id === P[k].id).data; return { c: "people", id: P[k].id, data: { ...cur, location: loc, locationAt: Date.now() } }; }));

// Demo staff login, linked to Sofia; she logs a pending fitting and a receipt from her phone.
const users = (await call(admin, "/api/users", undefined, "GET")).users;
let staffId = users.find((u) => u.username === STAFF_USER)?.id;
if (!staffId) staffId = (await call(admin, "/api/users", { name: P.sofia.name, username: STAFF_USER, password: STAFF_PASS, role: "staff" })).id;
await call(admin, "/api/users/" + staffId, { personId: P.sofia.id });
const staff = await login(TEAM_URL, STAFF_USER, STAFF_PASS);
const { payType, rate, dayRate, halfDayRate, halfDayUnder, otAfter, otMult } = P.sofia;
await push(staff, [
  { c: "shifts", id: rid("s"), data: { personId: P.sofia.id, date: day(-1), hours: 3, payType, rate, dayRate, halfDayRate, halfDayUnder, otAfter, otMult, start: "15:00", end: "18:00", job: "Prova abiti · Atelier Brera", location: "Showroom Atelier Brera, Corso Garibaldi 42, Milano", jobId: JOBS[6].id } },
  { c: "receipts", id: rid("r"), data: { personId: P.sofia.id, date: day(-1), category: "travel", amount: 9.6, description: "Metro e tram per la prova abiti", jobId: JOBS[6].id, status: "pending", hasPhoto: false } },
]);
const sofiaNow = (await call(staff, "/api/sync", { since: 0, changes: [] })).records.find((r) => r.id === P.sofia.id).data;
await push(staff, [{ c: "people", id: P.sofia.id, data: { ...sofiaNow, location: HQ, locationAt: Date.now() } }]);

// Past check-ins (for the calendar's history): one per person per past job day, at call time.
const hist = [];
for (const j of JOBS) for (let d = j.from; d <= Math.min(j.to, -1); d++) for (const k of j.crew) {
  const [hh, mm] = j.call.split(":").map(Number);
  hist.push({ at: at(d, hh, mm) - 10 * 60e3, personId: P[k].id, personName: P[k].name, location: j.location });
}
// A few office days at the agency.
for (const [k, d] of [["aurora", -10], ["matteo", -10], ["sofia", -9], ["beatrice", -3], ["aurora", -1]]) hist.push({ at: at(d, 11, 15), personId: P[k].id, personName: P[k].name, location: HQ });
console.log("CHECKINS " + JSON.stringify({ userId: admin.me.id, actor: admin.me.name, rows: hist }));
console.log(`done: ${PEOPLE.length} people, ${PLACES.length} places, ${JOBS.length} jobs, ${shifts.length + 1} shifts, ${receipts.length + 1} receipts, ${pays.length} payments`);
