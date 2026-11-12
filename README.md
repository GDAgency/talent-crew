# Talent & Crew

A ledger for the agency: where each model and technician is, the hours they've worked, what each is owed, who has been paid, and photos of the receipts they need reimbursed.

It's one web address that works two ways:

- **Website**: open it in any browser on a computer.
- **App**: on a phone, "Add to Home Screen" (iPhone) or "Install app" (Android). It then opens full-screen like a normal app and **works without signal**. Hours, location check-ins and receipt photos are saved on the phone and sent to the server automatically when it's back online.

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
