// Fills a Lumia server with a large demo roster: MODELS models and TECHS technicians (default
// 100 and 40), with places, ~80 jobs from six weeks ago to a month ahead, hours, receipts and
// payments. Older jobs are paid and archived, recent ones partly settled, future ones booked.
// Everything goes through the app's own API as the given admin, so records are validated and
// stored exactly as if typed in. Every id starts with "demo-", so the demo can be removed later.
//
//   ADMIN_URL=https://lumia.rogatski.com/admin ADMIN_USER=… ADMIN_PASS=… [MODELS=100 TECHS=40 SEED=7] node tools/seed-big.mjs
const { ADMIN_URL, ADMIN_USER, ADMIN_PASS } = process.env;
if (!ADMIN_URL || !ADMIN_USER || !ADMIN_PASS) { console.error("Set ADMIN_URL, ADMIN_USER and ADMIN_PASS."); process.exit(2); }
const N_MODELS = Number(process.env.MODELS || 100), N_TECHS = Number(process.env.TECHS || 40);

// Repeatable randomness, so the same SEED gives the same demo.
let seed = Number(process.env.SEED || 7) >>> 0;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const shuffle = (a) => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const pad = (n) => String(n).padStart(2, "0");
const day = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const round2 = (n) => Math.round(n * 100) / 100;
let idn = 0;
const rid = (p) => `demo-${p}-${(++idn).toString(36)}${Math.floor(rnd() * 36 ** 5).toString(36)}`;

async function login(base, username, password) {
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "x-tc": "1", "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  if (!r.ok) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
  return { base, cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), me: (await r.json()).user };
}
async function call(s, path, body) {
  const r = await fetch(s.base + path, { method: "POST", headers: { "x-tc": "1", "content-type": "application/json", cookie: s.cookie }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
}
let stamp = Date.now();
async function push(s, changes) {
  const stamped = changes.map((ch) => ({ ...ch, data: { createdAt: stamp, ...ch.data, id: ch.id, updatedAt: ++stamp } }));
  for (let i = 0; i < stamped.length; i += 200) {
    const r = await call(s, "/api/sync", { since: 1e15, changes: stamped.slice(i, i + 200) });
    if (r.denied) throw new Error(`sync: ${r.denied} change(s) denied`);
  }
}

// ---------- People ----------
const F = ["Giulia", "Sofia", "Aurora", "Alice", "Ginevra", "Emma", "Giorgia", "Beatrice", "Vittoria", "Ludovica", "Matilde", "Chiara", "Martina", "Anna", "Bianca", "Camilla", "Elena", "Francesca", "Gaia", "Greta", "Irene", "Ilaria", "Laura", "Margherita", "Nicole", "Noemi", "Rebecca", "Sara", "Valentina", "Viola", "Arianna", "Benedetta", "Carlotta", "Costanza", "Eleonora", "Federica", "Lucia", "Marta", "Rachele", "Serena"];
const M = ["Matteo", "Luca", "Davide", "Lorenzo", "Leonardo", "Francesco", "Alessandro", "Andrea", "Gabriele", "Riccardo", "Tommaso", "Edoardo", "Federico", "Giacomo", "Marco", "Nicolò", "Pietro", "Simone", "Stefano", "Filippo", "Emanuele", "Giovanni", "Michele", "Samuele", "Diego", "Elia", "Jacopo", "Manuel", "Mattia", "Paolo"];
const S = ["Rossi", "Russo", "Ferrari", "Esposito", "Bianchi", "Romano", "Colombo", "Ricci", "Marino", "Greco", "Bruno", "Gallo", "Conti", "De Luca", "Mancini", "Costa", "Giordano", "Rizzo", "Lombardi", "Moretti", "Barbieri", "Fontana", "Santoro", "Mariani", "Rinaldi", "Caruso", "Ferrara", "Galli", "Martini", "Leone", "Longo", "Gentile", "Martinelli", "Vitale", "Lombardo", "Serra", "Coppola", "De Santis", "D'Angelo", "Marchetti", "Parisi", "Villa", "Conte", "Ferraro", "Ferri", "Fabbri", "Bianco", "Marini", "Grasso", "Valentini", "Messina", "Sala", "De Angelis", "Gatti", "Pellegrini", "Palumbo", "Sanna", "Farina", "Rizzi", "Monti", "Cattaneo", "Morelli", "Amato", "Silvestri", "Mazza", "Testa", "Grassi", "Pellegrino", "Carbone", "Giuliani", "Benedetti", "Barone", "Rossetti", "Caputo", "Montanari", "Guerra", "Palmieri", "Bernardi", "Martino", "Fiore", "De Rosa", "Ferretti", "Bellini", "Basile", "Riva", "Donati", "Piras", "Vitali", "Battaglia", "Sartori", "Neri", "Costantini", "Milani", "Pagano", "Ruggiero", "Sorrentino", "D'Amico", "Orlando", "Damico", "Negri"];
const MODEL_SPEC = ["Editoriale", "Sfilata", "Commerciale", "Beauty", "Lookbook", "Campagne", "Video", "Fitting", "Intimo e mare", "Gioielli e mani", "Moda uomo", "Curvy", "Hostess eventi", "Sfilata, beauty", "Editoriale, campagne", "Commerciale, video"];
const TECH_SPEC = ["Luci", "Fotografo", "Assistente fotografo", "Trucco e parrucco", "Trucco", "Parrucco", "Stylist", "Assistente stylist", "Videomaker", "Operatore camera", "Fonico", "Scenografo", "Sarta", "Digital tech", "Runner di produzione", "Direttore di produzione"];
const phone = () => `+39 3${int(20, 49)} ${int(100, 999)} ${int(1000, 9999)}`;
const used = new Set();
const fullName = (first) => { for (;;) { const n = `${pick(first)} ${pick(S)}`; if (!used.has(n)) { used.add(n); return n; } } };
const terms = (payType, rate, dayRate) => ({ payType, rate, dayRate, halfDayRate: payType === "day" ? Math.round(dayRate * 0.6 / 10) * 10 : 0, halfDayUnder: payType === "day" ? 5 : 0, otAfter: payType === "hourly" && chance(0.3) ? 8 : 0, otMult: 1.25 });

const people = [];
for (let i = 0; i < N_MODELS; i++) {
  const woman = chance(0.72), day = chance(0.35), rate = int(10, 18) * 5;
  people.push({ id: rid("p"), name: fullName(woman ? F : M), role: "model", speciality: woman ? pick(MODEL_SPEC.filter((s) => s !== "Moda uomo")) : pick(["Moda uomo", "Editoriale", "Commerciale", "Sfilata", "Campagne", "Video"]),
    phone: phone(), notes: chance(0.25) ? pick(["Altezza 178", "Altezza 175, taglia 38", "Altezza 186, taglia 48", "Disponibile anche all'estero", "Patente B", "Inglese e francese", "Solo weekend fino a giugno"]) : "", ...terms(day ? "day" : "hourly", rate, day ? int(35, 75) * 10 : 0) });
}
for (let i = 0; i < N_TECHS; i++) {
  const spec = pick(TECH_SPEC), rate = int(5, 10) * 5, day = chance(0.25);
  people.push({ id: rid("p"), name: fullName(chance(0.5) ? F : M), role: "technician", speciality: spec, phone: phone(), notes: "", ...terms(day ? "day" : "hourly", rate, day ? int(25, 50) * 10 : 0) });
}
const models = people.filter((p) => p.role === "model"), techs = people.filter((p) => p.role === "technician");

// ---------- Places, clients, jobs ----------
const PLACES = ["Studio Ventura, Via Ventura 15, Milano", "Palazzo Clerici, Via Clerici 5, Milano", "Fabbrica del Vapore, Via Procaccini 4, Milano", "Studio Navigli, Alzaia Naviglio Grande 66, Milano", "Superstudio Più, Via Tortona 27, Milano",
  "Teatro Gerolamo, Piazza Beccaria 8, Milano", "Studio Lambrate, Via Ventura 6, Milano", "Villa Necchi, Via Mozart 14, Milano", "Spazio Maiocchi, Via Achille Maiocchi 7, Milano", "Studio Isola, Via Pastrengo 14, Milano", "Hotel Principe di Savoia, Piazza della Repubblica 17, Milano", "Villa Erba, Largo Luchino Visconti 4, Cernobbio"];
const HQ = "Piazza Duomo 20, Milano";
const CLIENTS = ["Maison Verdi", "Atelier Brera", "Casa Lanzi", "Rivista Lume", "Ottica Sorelle Neri", "Calzature Orsini", "Profumi Aria", "Lanificio Valle", "Gioielli Corte", "Rivista Mosaico", "Denim Officina", "Pelletteria Fiora", "Cosmetici Iride", "Sartoria Bassi", "Occhiali Vento"];
const TITLES = ["Lookbook", "Campagna", "Editoriale", "Sfilata", "Catalogo", "Video prodotto", "Shooting e-commerce", "Presentazione stampa", "Evento in negozio", "Backstage", "Copertina", "Fitting collezione"];
const SEASONS = ["primavera", "estate", "autunno", "inverno", "resort", "uomo", "donna", "capsule", "natale", "saldi"];
const CALLS = ["07:00", "07:30", "08:00", "08:30", "09:00", "09:30", "10:00", "13:00", "14:00", "17:00"];

const busy = new Set(); // "personId|offset": nobody is booked twice on the same day
const free = (p, from, to) => { for (let d = from; d <= to; d++) if (busy.has(p.id + "|" + d)) return false; return true; };
const take = (pool, n, from, to) => { const r = []; for (const p of shuffle(pool)) { if (r.length >= n) break; if (free(p, from, to)) r.push(p); } for (const p of r) for (let d = from; d <= to; d++) busy.add(p.id + "|" + d); return r; };

const jobs = [];
for (let from = -42; from <= 30; from++) {
  const n = new Date(Date.now() + from * 864e5).getDay() === 0 ? (chance(0.3) ? 1 : 0) : int(0, 2) + (chance(0.25) ? 1 : 0);
  for (let k = 0; k < n; k++) {
    const len = chance(0.2) ? int(1, 2) : 0, to = from + len, title = pick(TITLES);
    const nm = title === "Sfilata" ? int(8, 14) : title === "Evento in negozio" ? int(3, 6) : int(1, 5), nt = title === "Sfilata" ? int(3, 6) : int(1, 4);
    const crew = [...take(models, nm, from, to), ...take(techs, nt, from, to)];
    if (crew.length < 2) continue;
    const flat = chance(0.7);
    jobs.push({ id: rid("j"), client: pick(CLIENTS), title: `${title} ${pick(SEASONS)}`, from, to, call: pick(CALLS), location: pick(PLACES), crew, billing: flat ? "flat" : "hourly",
      amount: flat ? Math.round(crew.length * int(450, 1100) * (len + 1) / 100) * 100 : int(12, 25) * 10 });
  }
}

// ---------- Hours, receipts, payments ----------
const payOf = (p, h) => p.payType === "day" ? (h < p.halfDayUnder ? p.halfDayRate : p.dayRate) : round2(p.otAfter && h > p.otAfter ? p.otAfter * p.rate + (h - p.otAfter) * p.rate * p.otMult : h * p.rate);
const endOf = (start, h) => { const [hh, mm] = start.split(":").map(Number); const t = hh * 60 + mm + Math.round(h * 60); return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`; };
const shifts = [], receipts = [], payments = [], earned = {};
const CATS = [["travel", "Taxi", 9, 38], ["travel", "Treno", 12, 64], ["meals", "Pranzo sul set", 9, 22], ["hair", "Prodotti trucco", 14, 70], ["equipment", "Gelatine e nastro", 8, 45], ["other", "Parcheggio", 6, 25]];
for (const j of jobs) {
  const lastDay = Math.min(j.to, -1); // hours are in for every day up to yesterday
  for (let d = j.from; d <= lastDay; d++) for (const p of j.crew) {
    const h = pick([4, 6, 7, 7.5, 8, 8, 8.5, 9, 10]);
    const { payType, rate, dayRate, halfDayRate, halfDayUnder, otAfter, otMult } = p;
    shifts.push({ c: "shifts", id: rid("s"), data: { personId: p.id, date: day(d), hours: h, payType, rate, dayRate, halfDayRate, halfDayUnder, otAfter, otMult,
      start: j.call, end: endOf(j.call, h), job: `${j.client} · ${j.title}`, location: j.location, jobId: j.id, ...(d >= -3 && chance(0.3) ? { approval: "pending" } : {}) } });
    (earned[j.id] ||= {})[p.id] = round2((earned[j.id][p.id] || 0) + payOf(p, h));
    if (chance(0.12)) { const [category, what, lo, hi] = pick(CATS); receipts.push({ c: "receipts", id: rid("r"), data: { personId: p.id, date: day(d), category, amount: round2(int(lo * 10, hi * 10) / 10), description: `${what} · ${j.client}`, jobId: j.id, status: "pending", hasPhoto: false } }); }
  }
  // Settle by age: over 3 weeks ago paid and archived, 1–3 weeks mostly paid, last week open.
  if (j.to > -1) { j.inv = "not invoiced"; continue; }
  const age = -j.to;
  j.inv = age > 21 ? "paid" : age > 7 ? pick(["paid", "invoiced", "invoiced"]) : pick(["invoiced", "not invoiced", "not invoiced"]);
  const payCrew = age > 21 || (age > 7 && chance(0.6));
  if (payCrew) for (const p of j.crew) {
    const recs = receipts.filter((r) => r.data.personId === p.id && r.data.jobId === j.id), recAmt = round2(recs.reduce((a, r) => a + r.data.amount, 0));
    const paidOn = day(Math.min(-1, j.to + int(3, 9)));
    payments.push({ c: "payments", id: rid("y"), data: { personId: p.id, date: paidOn, amount: earned[j.id][p.id], method: pick(["Bank transfer", "Bank transfer", "Bank transfer", "Cash"]), note: "", receiptIds: recs.map((r) => r.id), receiptsAmount: recAmt, jobId: j.id } });
    for (const r of recs) Object.assign(r.data, { status: "reimbursed", reimbursedAt: paidOn });
  }
  j.archived = age > 21 && payCrew && j.inv === "paid";
}

// ---------- Send ----------
const admin = await login(ADMIN_URL, ADMIN_USER, ADMIN_PASS);
console.log("signed in as", admin.me.name);
await push(admin, PLACES.map((name) => ({ c: "places", id: rid("pl"), data: { name } })));
const today = new Set(jobs.filter((j) => j.from <= 0 && 0 <= j.to).flatMap((j) => j.crew.map((p) => p.id)));
await push(admin, people.map(({ id, ...p }) => ({ c: "people", id, data: { ...p, ...(today.has(id) ? { location: jobs.find((j) => j.from <= 0 && 0 <= j.to && j.crew.some((x) => x.id === id)).location, locationAt: Date.now() } : chance(0.1) ? { location: HQ, locationAt: Date.now() - int(1, 5) * 36e5 } : {}) } })));
await push(admin, jobs.map((j) => ({ c: "jobs", id: j.id, data: {
  client: j.client, title: j.title, date: day(j.from), endDate: j.to > j.from ? day(j.to) : "", call: j.call, location: j.location, notes: "",
  people: j.crew.map((p) => p.id), billing: j.billing, fee: j.billing === "flat" ? j.amount : 0, clientRate: j.billing === "hourly" ? j.amount : 0,
  invoiceStatus: j.inv, clientPaidAt: j.inv === "paid" ? day(Math.min(-1, j.to + 14)) : "", ...(j.archived ? { archived: true, archivedAt: day(Math.min(-1, j.to + 20)) } : {}),
} })));
await push(admin, shifts);
await push(admin, receipts);
await push(admin, payments);
console.log(`done: ${models.length} models, ${techs.length} technicians, ${PLACES.length} places, ${jobs.length} jobs (${jobs.filter((j) => j.archived).length} archived, ${jobs.filter((j) => j.from > 0).length} upcoming), ${shifts.length} shifts, ${receipts.length} receipts, ${payments.length} payments`);
