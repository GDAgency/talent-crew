// End-to-end test of the whole flow: office setup, staff on a phone (offline too),
// approvals, payments, statements, staff privacy and the calendar.
//
// Needs playwright-core and a Chromium headless shell (not dependencies of the app):
//   npm i --no-save playwright-core && npx playwright install chromium-headless-shell
// Run it against a throwaway server, never the live one (it creates accounts and data):
//   docker build -t talent-crew:qa .
//   docker run -d --rm --name tc-qa -p 127.0.0.1:3931:3000 -e CLIENT_HOSTS=localhost -e ADMIN_HOSTS=127.0.0.1 -e SETUP_CODE=qa talent-crew:qa
//   ADMIN_URL=http://127.0.0.1:3931 TEAM_URL=http://localhost:3931 QA_SETUP_CODE=qa node test/e2e.mjs /tmp/tc-shots
// localhost and 127.0.0.1 count as secure origins, so the service worker runs over plain http.
import { chromium } from "playwright-core";
import fs from "node:fs";
const exe = process.env.CHROME || process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell";
const ADMIN = process.env.ADMIN_URL, TEAM = process.env.TEAM_URL, CODE = process.env.QA_SETUP_CODE;
if (!ADMIN || !TEAM || !CODE) { console.error("Set ADMIN_URL, TEAM_URL and QA_SETUP_CODE (see the top of this file)."); process.exit(2); }
const ADMIN_HOST = new URL(ADMIN).hostname, TEAM_HOST = new URL(TEAM).hostname;
const OUT = process.argv[2] || "e2e-shots"; fs.mkdirSync(OUT, { recursive: true });
const results = [];
const ok = (name, cond, got) => { results.push([cond ? "PASS" : "FAIL", name]); console.log(cond ? "PASS" : "FAIL", name, got === undefined ? "" : "→ " + JSON.stringify(got)); };
const errors = [];
const b = await chromium.launch({ executablePath: exe });
const hidden = { state: "hidden" };
const watch = (p, who) => {
  p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/401|403|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(`${who}: ${m.text()}`); });
};
const synced = (p, t = 30000) => p.waitForFunction(() => document.querySelector("#sync-txt").textContent.startsWith("Sincronizzato"), null, { timeout: t });
const step = async (name, fn) => { try { await fn(); } catch (e) { ok(name, false, e.message.split("\n")[0]); } };
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

// ---------- Office: first-run setup ----------
const ac = await b.newContext({ viewport: { width: 1360, height: 860 }, acceptDownloads: true });
const a = await ac.newPage(); watch(a, "admin");
let ids = {};
await step("office setup", async () => {
  await a.goto(ADMIN); await a.waitForSelector("#setup-form:not([hidden])");
  ok("office shows setup with code field", await a.isVisible("#su-code"));
  await a.fill("#su-code", "wrong-code"); await a.fill("#su-name", "QA Admin"); await a.fill("#su-user", "qa-admin"); await a.fill("#su-pass", "qa-admin-pass-1");
  await a.click("#su-btn"); await a.waitForSelector("#su-err:not([hidden])");
  ok("wrong setup code refused", (await a.textContent("#su-err")).includes("non è corretto"), await a.textContent("#su-err"));
  await a.fill("#su-code", CODE); await a.click("#su-btn"); await a.waitForSelector("#app:not([hidden])");
  ok("admin set up and signed in on office", true);
  ok("office lands on the calendar", await a.isVisible('[data-view="calendar"]'));
  await a.goto(ADMIN + "/#team"); await a.waitForSelector('[data-view="team"]:not([hidden])');
  for (const [n, r, rate] of [["Martina Rossi", "model", "65"], ["Luca Bianchi", "technician", "38"]]) {
    await a.click('.view-actions [data-act="add-person"]'); await a.fill("#pf-name", n); await a.selectOption("#pf-role", r); await a.fill("#pf-rate", rate);
    await a.click('#d-person [type="submit"]'); await a.waitForSelector("#d-person", hidden);
  }
  await synced(a);
  ids = await a.evaluate(async () => {
    const j = await (await fetch("/api/sync", { method: "POST", headers: { "x-tc": "1", "content-type": "application/json" }, body: '{"since":0,"changes":[]}' })).json();
    return Object.fromEntries(j.records.filter((r) => r.c === "people").map((r) => [r.data.name, r.id]));
  });
  ok("people saved on server", !!ids["Martina Rossi"] && !!ids["Luca Bianchi"]);
  const staff = await a.evaluate(async (pid) => {
    const h = { "x-tc": "1", "content-type": "application/json" };
    const r = await (await fetch("/api/users", { method: "POST", headers: h, body: JSON.stringify({ name: "Martina Rossi", username: "qa-martina", password: "qa-staff-pass-1", role: "staff" }) })).json();
    const l = await fetch("/api/users/" + r.id, { method: "POST", headers: h, body: JSON.stringify({ personId: pid }) });
    return { link: l.status };
  }, ids["Martina Rossi"]);
  ok("staff login created and linked to Martina", staff.link === 200, staff);
  await a.click('.comp:has-text("Luca") [data-act="add-shift"]'); await a.fill("#sf-hours", "6"); await a.fill("#sf-job", "Night shoot");
  await a.click('#d-shift [type="submit"]'); await a.waitForSelector("#d-shift", hidden);
  await a.waitForTimeout(800);
  await a.screenshot({ path: OUT + "/01-office-board.png" });
});

// ---------- Team site on a phone ----------
const sc = await b.newContext(phone);
const s = await sc.newPage(); watch(s, "staff");
await step("team site", async () => {
  await s.goto(ADMIN); await s.waitForSelector("#login-form:not([hidden])");
  await s.fill("#li-user", "qa-martina"); await s.fill("#li-pass", "qa-staff-pass-1"); await s.click("#li-btn"); await s.waitForSelector("#li-err:not([hidden])");
  ok("staff refused on office site", (await s.textContent("#li-err")).includes(TEAM_HOST), await s.textContent("#li-err"));
  await s.goto(TEAM); await s.waitForSelector("#login-form:not([hidden])");
  ok("team sign-in links to office", (await s.textContent("#li-other")).includes(ADMIN_HOST), await s.textContent("#li-other"));
  await s.screenshot({ path: OUT + "/02-team-login.png" });
  await s.fill("#li-user", "qa-martina"); await s.fill("#li-pass", "qa-staff-pass-1"); await s.click("#li-btn"); await s.waitForSelector("#app:not([hidden])");
  await s.waitForTimeout(1500);
  ok("staff lands on My page", await s.isVisible('[data-view="me"]'), await s.evaluate(() => location.hash));
  await s.screenshot({ path: OUT + "/03-team-mypage.png" });
  await s.click("#fab"); await s.click('#quick [data-act="add-shift"]');
  ok("shift form pre-filled with herself", (await s.$eval("#sf-person", (e) => e.selectedOptions[0].textContent)).includes("Martina"));
  await s.fill("#sf-start", "07:00"); await s.fill("#sf-end", "15:30"); await s.fill("#sf-job", "Spring lookbook");
  await s.click('#d-shift [type="submit"]'); await s.waitForSelector("#d-shift", hidden);
  await s.click("#fab"); await s.click('#quick [data-act="add-receipt"]');
  await s.setInputFiles("#rf-file-in", process.env.PHOTO || new URL("../public/icons/icon-512.png", import.meta.url).pathname); await s.waitForSelector("#rf-preview:not([hidden]) img");
  await s.fill("#rf-amount", "22.40"); await s.fill("#rf-desc", "Taxi to the studio"); await s.click('#d-receipt [type="submit"]'); await s.waitForSelector("#d-receipt", hidden);
  await synced(s);
  ok("hours and receipt photo sent", true, await s.textContent("#sync-txt"));
  const sw = await s.evaluate(async () => { await navigator.serviceWorker.ready; return true; });
  ok("offline support (service worker) installed", sw);
  await s.reload(); await s.waitForSelector("#app:not([hidden])"); await s.waitForTimeout(800);
  ok("service worker controls the page", await s.evaluate(() => !!navigator.serviceWorker.controller));
});
await step("offline", async () => {
  await sc.setOffline(true); await s.evaluate(() => window.dispatchEvent(new Event("offline")));
  await s.click("#fab"); await s.click('#quick [data-act="add-shift"]'); await s.fill("#sf-hours", "5"); await s.fill("#sf-job", "Fittings");
  await s.click('#d-shift [type="submit"]'); await s.waitForSelector("#d-shift", hidden);
  ok("offline: entry kept on phone", (await s.textContent("#sync-txt")).includes("Offline"), await s.textContent("#sync-txt"));
  await s.reload(); await s.waitForSelector("#app:not([hidden])", { timeout: 15000 });
  ok("offline: app reopens with no signal", true, await s.textContent("#sync-txt"));
  await s.screenshot({ path: OUT + "/04-team-offline.png" });
  await sc.setOffline(false); await s.evaluate(() => window.dispatchEvent(new Event("online")));
  await synced(s);
  ok("back online: offline entry sent", true, await s.textContent("#sync-txt"));
});

// ---------- Office: approve, pay, statement ----------
await step("office approvals and pay", async () => {
  await a.goto(ADMIN + "/#hours"); await a.reload(); await a.waitForSelector("#app:not([hidden])"); await synced(a); await a.waitForTimeout(1000);
  const waiting = await a.locator('[data-act="q-approve"]').count();
  ok("office sees 2 staff entries waiting for approval", waiting === 2, waiting);
  await a.screenshot({ path: OUT + "/05-office-approvals.png" });
  while (await a.locator('[data-act="q-approve"]').count()) { await a.locator('[data-act="q-approve"]').first().click(); await a.waitForTimeout(500); }
  await a.goto(ADMIN + "/#team"); await a.reload(); await a.waitForSelector("#app:not([hidden])"); await synced(a); await a.waitForTimeout(1000);
  const owed = await a.textContent('.comp:has-text("Martina") .figs .v.owed').catch(() => null);
  ok("Martina owed = 13.5 h × €65 + €22.40 receipt = €899.90", !!owed && owed.includes("899,90"), owed);
  const photo = await a.evaluate(async () => {
    const j = await (await fetch("/api/sync", { method: "POST", headers: { "x-tc": "1", "content-type": "application/json" }, body: '{"since":0,"changes":[]}' })).json();
    const r = j.records.find((x) => x.c === "receipts"); const res = await fetch("/api/photos/" + r.id); return [r.data.photoUploaded, res.status];
  });
  ok("receipt photo stored on server", photo[0] === true && photo[1] === 200, photo);
  await a.click('.comp:has-text("Martina") [data-act="add-payment"]'); await a.waitForSelector("#d-pay[open]");
  await a.click('#d-pay [type="submit"]'); await a.waitForSelector("#d-pay", hidden); await a.waitForTimeout(1200);
  const pill = await a.textContent('.comp:has-text("Martina") .pill');
  ok("after payment Martina is paid up", pill.includes("In regola"), pill);
  await a.click('.comp-name:has-text("Martina")'); await a.click('#d-detail [data-act="statement"]'); await a.waitForSelector("#d-statement[open]"); await a.waitForTimeout(800);
  const [dl] = await Promise.all([a.waitForEvent("download"), a.click("#st-csv")]);
  const csvPath = OUT + "/" + dl.suggestedFilename(); await dl.saveAs(csvPath);
  ok("statement CSV downloads", fs.statSync(csvPath).size > 50, dl.suggestedFilename());
  await a.screenshot({ path: OUT + "/06-office-statement.png" });
  await a.keyboard.press("Escape"); await a.keyboard.press("Escape");
});
await step("cross-site", async () => {
  const ap = await (await b.newContext()).newPage();
  await ap.goto(TEAM); await ap.waitForSelector("#login-form:not([hidden])");
  await ap.fill("#li-user", "qa-admin"); await ap.fill("#li-pass", "qa-admin-pass-1"); await ap.click("#li-btn"); await ap.waitForSelector("#li-err:not([hidden])");
  ok("admin refused on team site", (await ap.textContent("#li-err")).includes(ADMIN_HOST), await ap.textContent("#li-err"));
  await s.reload(); await s.waitForSelector("#app:not([hidden])"); await s.waitForTimeout(2500);
  await s.screenshot({ path: OUT + "/07-team-mypage-paid.png", fullPage: true });
  ok("her payment is on her own page", (await s.textContent("#mypage")).includes("Pagamenti ricevuti") && (await s.textContent("#mypage")).includes("877,50"));
  const names = await Promise.all([ADMIN, TEAM].map(async (u) => { const p = await (await b.newContext()).newPage(); await p.goto(u + "/manifest.webmanifest"); return JSON.parse(await p.innerText("body")).name; }));
  ok("each site installs under its own name", names[0] !== names[1], names);
  ok("phone page has no sideways scroll", (await s.evaluate(() => document.documentElement.scrollWidth)) <= 390);
});

// ---------- Staff see only their own money ----------
await step("privacy", async () => {
  const sync0 = (pg) => pg.evaluate(async () => (await (await fetch("/api/sync", { method: "POST", headers: { "x-tc": "1", "content-type": "application/json" }, body: '{"since":0,"changes":[]}' })).json()).records);
  const sr = await sync0(s), ar = await sync0(a);
  const live = (rs, c) => rs.filter((r) => r.c === c && !r.data.deleted);
  const luca = ids["Luca Bianchi"], martina = ids["Martina Rossi"];
  ok("office still sees Luca's hours and rate", live(ar, "shifts").some((r) => r.data.personId === luca) && live(ar, "people").find((r) => r.id === luca).data.rate > 0);
  ok("staff gets none of Luca's hours", !live(sr, "shifts").some((r) => r.data.personId === luca));
  ok("staff gets only her own payments", live(sr, "payments").length > 0 && live(sr, "payments").every((r) => r.data.personId === martina));
  const sl = live(sr, "people").find((r) => r.id === luca).data, sm = live(sr, "people").find((r) => r.id === martina).data;
  ok("staff sees Luca's name but not his rate", sl.name === "Luca Bianchi" && !("rate" in sl) && !("payType" in sl), Object.keys(sl));
  ok("staff still sees her own rate", sm.rate === 65, sm.rate);
  ok("agency address is a saved place", live(sr, "places").some((r) => r.data.name === "Piazza Duomo 20, Milano"));
  ok("staff has no Payments tab", await s.evaluate(() => !document.querySelector('.nav a[data-tab="payments"]').offsetParent));
  await s.goto(TEAM + "/#team"); await s.waitForSelector('[data-view="team"]:not([hidden])'); await s.waitForTimeout(1200);
  ok("board: no money on Luca's card", (await s.locator('.comp:has-text("Luca") .figs').count()) === 0 && (await s.locator('.comp:has-text("Luca") .pill').count()) === 0);
  ok("board: no team totals for staff", await s.isHidden("#summary"));
  ok("board: her own card still shows her money", (await s.locator('.comp:has-text("Martina") .figs').count()) === 1);
  await s.click('.comp-name:has-text("Luca")'); await s.waitForSelector("#d-detail[open]");
  const dt = await s.textContent("#dt-body");
  ok("Luca's detail shows no pay", !dt.includes("€") && dt.includes("solo all'ufficio"), dt.slice(0, 120));
  await s.keyboard.press("Escape");
});

// ---------- Calendar ----------
await step("calendar", async () => {
  // Martina reports where she is; the office books Luca on a job for today from the calendar.
  await s.goto(TEAM + "/#me"); await s.waitForSelector('[data-view="me"]:not([hidden])'); await s.waitForTimeout(600);
  await s.click('.me-quick [data-act="loc"]'); await s.waitForSelector("#d-loc[open]");
  await s.click('#lf-places button:has-text("Piazza Duomo 20, Milano")'); // one tap checks in
  await s.waitForSelector("#d-loc", hidden); await synced(s);
  ok("one tap on the saved place checks in", (await s.textContent(".me-quick")).includes("Piazza Duomo 20, Milano"));

  await a.goto(ADMIN + "/#calendar"); await a.reload(); await a.waitForSelector('[data-view="calendar"]:not([hidden])'); await synced(a); await a.waitForTimeout(800);
  ok("desktop opens on the week time grid", (await a.locator(".tg-head").count()) === 7 && (await a.getAttribute('#cal-seg [data-cv="week"]', "aria-pressed")) === "true");
  // Tap a free hour (17:00) in today's column to book.
  const top = await a.evaluate(() => Number(document.querySelector(".tg-axis span").textContent.slice(0, 2)));
  await a.click(".tg-col.today", { position: { x: 30, y: (17 - top) * 48 + 8 } }); await a.waitForSelector("#d-jobform[open]");
  const today = await a.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
  ok("tapping a free hour starts a booking there", (await a.inputValue("#jf-date")) === today && (await a.inputValue("#jf-call")) === "17:00", [await a.inputValue("#jf-date"), await a.inputValue("#jf-call")]);
  await a.fill("#jf-client", "Maison Verdi"); await a.fill("#jf-name", "Campagna inverno"); await a.fill("#jf-loc", "Studio Tortona 27");
  await a.fill("#jf-call", "16:00"); await a.fill("#jf-wrap", "19:30");
  await a.check(`#jf-people input[value="${ids["Luca Bianchi"]}"]`);
  await a.click('#d-jobform [type="submit"]'); await a.waitForSelector("#d-jobform", hidden); await a.waitForTimeout(1500);
  const job = a.locator('.tg-col.today .ev.k-job:has-text("Campagna inverno")');
  const jobTxt = await job.textContent().catch(() => "");
  ok("week: job block with time, crew and place", jobTxt.includes("16:00–19:30") && jobTxt.includes("Luca") && jobTxt.includes("Studio Tortona 27"), jobTxt);
  const box = await job.boundingBox();
  ok("week: block height matches 3.5 hours", !!box && Math.abs(box.height - 3.5 * 48) < 6, box && box.height);
  ok("week: Martina's logged hours are a block", (await a.locator('.tg-col.today .ev.k-shift:has-text("07:00–15:30")').count()) === 1);
  ok("week: reported position shown for the day", (await a.locator('.tg-all.today .ev.k-here:has-text("Piazza Duomo 20")').count()) === 1);
  await a.screenshot({ path: OUT + "/08-office-calendar-week.png", fullPage: true });
  await a.click('#cal-seg [data-cv="day"]'); await a.waitForTimeout(300);
  const heads = await a.$$eval(".tg-head", (els) => els.map((e) => e.textContent));
  ok("day: one column per person, with where they are", heads.length === 2 && heads.some((h) => h.includes("Martina") && h.includes("Piazza Duomo 20")), heads);
  ok("day: Luca's column has his booking", (await a.locator(`.tg-col[data-pid="${ids["Luca Bianchi"]}"] .ev.k-job`).count()) === 1);
  ok("day: Martina's column has her hours and a position pin", (await a.locator(`.tg-col[data-pid="${ids["Martina Rossi"]}"] .ev.k-shift`).count()) === 1 && (await a.locator(`.tg-col[data-pid="${ids["Martina Rossi"]}"] .tg-pin`).count()) >= 1);
  await a.screenshot({ path: OUT + "/09-office-calendar-day.png", fullPage: true });
  await a.click('#cal-seg [data-cv="month"]'); await a.waitForTimeout(300);
  ok("month: today shows both people", (await a.locator(".cal-mday.today .ml").count()) === 2);
  await a.screenshot({ path: OUT + "/10-office-calendar-month.png", fullPage: true });
  await a.click('[data-cal="next"]'); await a.click('[data-cal="today"]');
  ok("month: back to today", (await a.locator(".cal-mday.today").count()) === 1);
  await a.click('#cal-seg [data-cv="list"]'); await a.waitForTimeout(300);
  ok("jobs list still there", (await a.locator('.jcard:has-text("Campagna inverno")').count()) === 1);

  await s.goto(TEAM + "/#calendar"); await s.reload(); await s.waitForSelector('[data-view="calendar"]:not([hidden])'); await s.waitForTimeout(1500);
  ok("phone opens on the day view, staff sees one column", (await s.locator(".tg-head").count()) === 1 && (await s.textContent(".tg-head")).includes("Martina"));
  await s.screenshot({ path: OUT + "/11-team-calendar-day.png", fullPage: true });
  await s.click('#cal-seg [data-cv="week"]'); await s.waitForTimeout(300);
  ok("staff week shows only her own things", !(await s.textContent("#cal")).includes("Luca") && (await s.locator(".tg-col.today .ev.k-shift").count()) >= 1);
  ok("phone week view has no sideways page scroll", (await s.evaluate(() => document.documentElement.scrollWidth)) <= 390);
  await s.screenshot({ path: OUT + "/12-team-calendar-week.png", fullPage: true });
  await s.click('#cal-seg [data-cv="month"]'); await s.waitForTimeout(300);
  ok("phone month view has no sideways page scroll", (await s.evaluate(() => document.documentElement.scrollWidth)) <= 390);
  const mob = await (await b.newContext({ ...phone, storageState: await ac.storageState() })).newPage(); watch(mob, "admin-phone");
  await mob.goto(ADMIN + "/#calendar"); await mob.waitForSelector('[data-view="calendar"]:not([hidden])'); await mob.waitForTimeout(1500);
  ok("office calendar on a phone: no sideways page scroll", (await mob.evaluate(() => document.documentElement.scrollWidth)) <= 390);
  await mob.screenshot({ path: OUT + "/13-office-calendar-phone.png", fullPage: true });
});

console.log("errors:", errors.length ? errors : "none");
const passed = results.filter((r) => r[0] === "PASS").length;
console.log(`${passed}/${results.length} passed`);
await b.close();
process.exit(passed === results.length && !errors.length ? 0 : 1);
