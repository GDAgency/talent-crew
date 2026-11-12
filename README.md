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
| Add people, set hourly rates | | ✓ |
| Record payments, mark receipts reimbursed | | ✓ |
| Create logins, reset passwords | | ✓ |

The server checks these rules itself, so a staff account can't change rates or payments, even from an old or modified copy of the app.

**Amount owed** = hours × rate − wages paid + receipts not yet reimbursed.

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
