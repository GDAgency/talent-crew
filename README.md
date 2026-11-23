# Talent & Crew

A ledger for the agency: where each model and technician is, the hours they've worked, what each is owed, who has been paid, and photos of the receipts they need reimbursed.

It's one web address that works two ways:

- **Website**: open it in any browser on a computer.
- **App**: on a phone, "Add to Home Screen" (iPhone) or "Install app" (Android). It then opens full-screen like a normal app and **works without signal**. Hours, location check-ins and receipt photos are saved on the phone and sent to the server automatically when it's back online.

## Deploy on a server (Docker)

```
git clone https://github.com/GDAgency/talent-crew.git lumia && cd lumia
cp .env.example .env        # set CLIENT_HOSTS, ADMIN_PATH (or ADMIN_HOSTS) and SETUP_CODE
docker compose up -d --build
```

- The app listens on port 3000. Put it behind an HTTPS reverse proxy or tunnel and point the address(es) at it. A one-off `data-owner` step hands `./data` to the app's user before it starts.
- Open the office (`https://<your address>/admin/`, or the `ADMIN_HOSTS` address) and create the first administrator with the setup code.
- There is no separate database to install: everything is in `./data` (`ledger.db`, receipt photos, daily backups). To move an existing installation, stop the app and copy its `data` folder.
- Update: `git pull && docker compose up -d --build`. Older databases are upgraded on start.
- No Docker: `DATA_DIR=./data ADMIN_HOSTS=… CLIENT_HOSTS=… node server/server.js` with Node 22.5 or newer; there are no dependencies to install.

## Sign-up, customers and requests

- On the public site anyone can register (`SIGNUPS=off` closes it), as someone who works with the agency or as a customer.
- **People who work with the agency** wait for the office: until an administrator approves them in Impostazioni → Accessi della squadra, they see nothing. Approving adds them to Persone and links their login.
- **Customers** can ask for people straight away (what for, when, where, how many models and technicians). Requests arrive in Calendario → Lavori → Richieste; "Crea lavoro" turns one into a job, and the customer then sees who is sent, when and where, and whether the job is paid.
- A customer sees jobs created from their own requests. To also show them the other jobs under a client name, an administrator confirms which client the account belongs to (Accessi della squadra). Customers never see rates, hours or the rest of the ledger.
- The office marks a customer's payment on the job ("Il cliente ci ha pagato?" → Ha pagato).

## Android and iPhone apps

`mobile/app` is a small Capacitor app for both phones. It has no address built in for good: every time it opens it asks the last server it knew (`/api/app-config`) where Lumia lives now, then opens that site. To move the apps to a new server, an admin writes the new address in **Impostazioni → App per telefono** on the old server before switching it off. If no server answers, the app asks for the address; inside the app, Impostazioni also has **Cambia server**. Addresses must be https.

- **Android:** `mobile/app/prepare.sh android <version> <build>` then `mobile/app/build-android.sh <version>` (JDK 21, Android SDK, and the signing keystore in `KEYSTORE`/`KEYSTORE_PASSWORD`). Keep the keystore safe: every update must be signed with it. The `.apk` installs on any Android 6+ phone.
- **iPhone:** iOS apps can only be compiled with Xcode on a Mac, so GitHub builds it: Actions → **iPhone app** → Run workflow (or `gh workflow run ios.yml -f version=1.0.0 -f build=1 -f tag=ios-v1.0.0`). It attaches an unsigned `.ipa` to the release. Apple only installs signed apps: sign it with Sideloadly/AltStore (free Apple ID, every 7 days) or, with an Apple Developer account, distribute through TestFlight / the App Store.

## Who can do what

| | Staff | Admin |
|---|---|---|
| Log hours (call, wrap, job, location) | ✓ | ✓ |
| Photograph and add receipts | ✓ | ✓ |
| Update anyone's location | ✓ | ✓ |
| Edit or delete their own entries | ✓ | ✓ |
| Add people, set pay terms (hourly or day rate, half day, overtime) | | ✓ |
| Record payments, mark receipts reimbursed | | ✓ |
| See jobs and log hours from a booking | ✓ | ✓ |
| Book jobs, client fees and rates, invoice status, margins | | ✓ |
| View and download statements (CSV, printable HTML) | ✓ | ✓ |
| Create logins, reset passwords | | ✓ |

The server checks these rules itself, so a staff account can't change rates or payments, even from an old or modified copy of the app.

**Amount owed** = pay for the hours worked − wages paid + receipts not yet reimbursed. Pay is hours × hourly rate, or a day rate per shift (optionally a half-day rate for short shifts), plus any overtime past a set number of hours in one shift at a multiplier of the hourly rate. Each shift keeps the terms it was logged under, so changing a rate never rewrites past pay.

**Statements**: from a person's page or Payments → Statements, pick a month or dates to see the opening balance, each shift with its pay, receipts, payments and the closing balance. Download it as CSV or as a printable HTML file, or print it (A4). "Everyone · CSV" gives one row per person for the period, for the accountant.

## Staff pages, approvals and history

- **My page**: in **Settings → Team logins**, set who each login *is* on the board. That person's login then opens on their own page: what they're owed, what's been paid, receipts waiting, this month's hours, and one-tap buttons to log hours, add a receipt or check in.
- **Approving hours**: hours logged by staff wait for an admin and don't count toward what's owed until approved. Admins see them at the top of **Hours** (the count shows on the tab) and approve or reject them, one at a time or several at once. Rejecting asks for a short note the person sees. If someone changes hours that were already approved, they go back to waiting. Hours logged by an admin, and everything logged before this feature, count straight away.
- **Activity**: admins see who did what, newest first, at the bottom of **Settings**. The server writes it; nobody can edit or delete it.
- **Saved places**: admins keep a list of studios and venues in **Settings**; they show as one-tap buttons when checking in, with recently used places after them.
- **Receipt categories**: Travel, Meals, Wardrobe, Hair & make-up, Equipment or Other. Filter by category in **Receipts**, see totals per category, and find the category in the CSV export.

## Run it on this computer

You need Node.js 22.5 or newer. There's nothing else to install.

```bash
npm start
```

Open http://localhost:3000. The first visit asks you to create the admin account. Then go to **Settings → Team logins** to create a login for each person.

All data lives in the `data/` folder: `ledger.db` holds the records and `photos/` holds the receipt images. **To back up, copy that folder.**

Settings (all optional):

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Where the database and photos are kept |
| `COOKIE_SECURE` | off | Set to `1` to force secure cookies (normally detected automatically behind HTTPS) |
| `ADMIN_PATH` | – | Put the office under this path of the public site, e.g. `/admin` → `https://lumia.rogatski.com/admin/`. It has its own sign-in, so the same browser can be in both. `ADMIN_HOSTS`, if also set, then just redirect there. |
| `ADMIN_HOSTS` | – | Office site host name(s), comma-separated. Only admin accounts can sign in there. |
| `CLIENT_HOSTS` | – | Team site host name(s). Only staff accounts can sign in there. With neither set, any address serves everyone. |
| `SETUP_CODE` | – | One-time code required to create the first admin account. |

The server also writes a copy of the database to `data/backups/` once a day and keeps the last 14.

## Live: lumia.rogatski.com

| Site | Address | Who signs in |
|---|---|---|
| Team | https://lumia.rogatski.com | Models and technicians (staff accounts) |
| Office | https://lumia.rogatski.com/admin/ | Agency admins |

Both sites are the same server. Each one turns away the other kind of account and points to the right address. They install on phones as separate apps ("Lumia" and "Lumia Ufficio"). The old office address, adminlumia.rogatski.com, redirects to `/admin/`.

It runs on the agency's server (the `pc-lumia` machine) with Docker and its own Cloudflare Tunnel named `lumia`, so no ports are open on the router. Plain `http://` visits are redirected to `https://`.

```bash
docker compose -f deploy/docker-compose.yml up -d --build   # start, or deploy an update
docker compose -f deploy/docker-compose.yml logs -f         # watch logs
docker compose -f deploy/docker-compose.yml down            # stop
```

Both containers restart by themselves after a reboot. The files that aren't in this repo live in `LUMIA_HOME` (on the server `/home/pc-lumia/lumia-home`, set in `deploy/.env`):
- `data/`: the database, receipt photos and daily backups. **Copy this folder off the machine regularly.**
- `lumia.env`: `SETUP_CODE`, needed once to create the first admin on the office site.
- `tunnel/`: the tunnel's settings and secret credentials.

## Put it online for the team

To be installed on phones and to work offline, the app must be served over **HTTPS** (an address starting `https://`). Any host that runs Docker or Node and gives you a **persistent disk** will do.

**Option A: a small server (VPS) with Docker**

```bash
docker build -t talent-crew .
docker run -d --name talent-crew --restart unless-stopped -p 3000:3000 -v talent-crew-data:/data talent-crew
```

Put an HTTPS proxy in front of it, such as Caddy, which gets the certificate for you automatically:

```
ledger.youragency.com {
    reverse_proxy localhost:3000
}
```

**Option B: a hosting platform** (Render, Railway, Fly.io, etc.). Deploy this folder using the Dockerfile, attach a persistent volume mounted at `/data`, and use the HTTPS address the platform gives you. Without a persistent volume, data is lost when the service restarts.

## How offline works

- The first sign-in on each device must be online. After that the app opens with no connection.
- Everything added offline is marked **On this device** and counted in the sync badge ("Offline · 3 saved here"). It's sent as soon as the device reconnects, or when you tap the badge.
- Receipt photos are shrunk on the phone (about 2000 px, which stays readable) before they're stored, so uploads are quick on weak signal.
- If two people edit the same entry, the most recent edit wins.
- Signing out clears the app's data from that device. If unsent changes are waiting, it warns you first.

## Files

```
server/server.js   API, accounts, sync rules, photo storage (no dependencies)
public/            the app: index.html, app.js, styles.css, sw.js (offline), icons, fonts
Dockerfile         container for hosting
data/              created on first run: the database and photos (back this up)
```


## End-to-end test

`test/e2e.mjs` drives the whole flow in a headless browser (setup, staff on a phone offline, approvals, payments, statements, staff privacy, calendar). It needs `playwright-core` installed separately; the header of the file has the exact commands. Run it against a throwaway container, never the live site.
