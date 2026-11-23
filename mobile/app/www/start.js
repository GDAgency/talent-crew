// Start page of the Lumia app. Every time the app opens it asks the last known server where
// Lumia lives now (GET /api/app-config, set by an admin in Impostazioni → App per telefono),
// remembers the answer and opens it. If no server answers, the person can type the address.
(function () {
  var KEY = "lumia.server";
  var $ = function (id) { return document.getElementById(id); };
  var get = function () { try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; } };
  var put = function (v) { try { localStorage.setItem(KEY, v); } catch (e) {} };
  function norm(raw) {
    raw = String(raw || "").trim();
    if (!raw) return "";
    try { var u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : "https://" + raw); return u.protocol === "https:" ? u.origin : ""; }
    catch (e) { return ""; }
  }
  function ask(base, ms) {
    return new Promise(function (resolve) {
      var done = false, t = setTimeout(function () { done = true; resolve(null); }, ms);
      fetch(base + "/api/app-config", { cache: "no-store", credentials: "omit" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (!done) { clearTimeout(t); resolve(j); } })
        .catch(function () { if (!done) { clearTimeout(t); resolve(null); } });
    });
  }
  // Follow the server's answer, at most a few hops (old server → new server).
  async function resolve(base) {
    for (var hop = 0; hop < 4; hop++) {
      var j = await ask(base, 8000);
      if (!j) return hop ? base : null;
      var next = norm(j.server);
      if (!next || next === base) return base;
      base = next;
    }
    return base;
  }
  function showForm(msg, value) {
    $("msg").textContent = msg;
    $("form").hidden = false;
    $("addr").value = (value || "").replace(/^https:\/\//, "");
  }
  async function go(base, typed) {
    $("form").hidden = true;
    $("msg").textContent = "Connessione…";
    var where = await resolve(base);
    if (!where) return showForm(typed ? "Nessun server Lumia a questo indirizzo. Controllalo e riprova." : "Il server non risponde. Controlla la connessione, oppure scrivi il nuovo indirizzo.", base);
    put(where);
    location.replace(where + "/");
  }
  $("form").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = norm($("addr").value);
    if (!v) return showForm("Scrivi un indirizzo valido, per esempio app.agenzia.it (serve https).", $("addr").value);
    go(v, true);
  });
  var start = get() || norm(window.LUMIA_DEFAULT);
  if (/[?&]cambia=1/.test(location.search)) showForm("Scrivi l'indirizzo del server Lumia.", start);
  else go(start, false);
})();
