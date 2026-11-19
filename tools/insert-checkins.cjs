// Reads the CHECKINS line printed by seed-demo.mjs on stdin and adds those past
// check-ins to the audit history (where the calendar reads them). Run inside the app container:
//   grep '^CHECKINS ' out.txt | docker exec -i <container> node /app/tools/insert-checkins.cjs
const { DatabaseSync } = require("node:sqlite");
let input = ""; process.stdin.on("data", (d) => (input += d)).on("end", () => {
  const { userId, actor, rows } = JSON.parse(input.replace(/^CHECKINS /, ""));
  const db = new DatabaseSync((process.env.DATA_DIR || "/data") + "/ledger.db");
  db.exec("PRAGMA busy_timeout = 5000");
  const ins = db.prepare("INSERT INTO audit (at, user_id, actor, verb, c, rec_id, person_id, person_name, info) VALUES (?, ?, ?, 'person.checkin', 'people', ?, ?, ?, ?)");
  db.exec("BEGIN IMMEDIATE");
  for (const r of rows) ins.run(r.at, userId, actor, r.personId, r.personId, r.personName, JSON.stringify({ location: r.location }));
  db.exec("COMMIT");
  console.log(`added ${rows.length} past check-ins`);
});
