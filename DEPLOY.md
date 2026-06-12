# PWA-RCA — deploy as a team web app (one VM, always on)

This app is **Express** (`server/server.js`) + **React** (`client/`). In production, build the client once; the server serves `client/dist` and the API on **the same port** (default **8080**). Teammates open a URL in a browser — they do **not** run Node.

---

## What was added in the repo

| Piece | Purpose |
|--------|--------|
| `server/server.js` | If `../client/dist` exists, serves static files + `index.html` for SPA routes; `POST /analyze` unchanged. Listens on `PORT` (default 8080) and **0.0.0.0** so the VM accepts remote browsers. |
| `client/src/App.jsx` | Calls **`/analyze`** by default (same host as the page). Optional **`VITE_API_BASE_URL`** at build time if API is on another origin. |
| `client/vite.config.js` | **Dev proxy**: `npm run dev` forwards `/analyze` to `http://localhost:8080`. |
| Root `package.json` | `build:client`, `start:prod`. |
| `server/package.json` | `"start": "node server.js"`. |

---

## One-time setup on the VM

### 1) Install Node.js

Install **Node.js LTS** (same major you use locally). Reboot or open a new shell so `node` and `npm` work.

### 2) Copy the project

Copy the whole `PWA-RCA` folder to the VM (Git clone, zip, or pipeline artifact). Paths below assume the project root is e.g. `C:\Tools\PWA-RCA`.

### 3) Install dependencies

From the **repository root** (folder that contains `server/` and `client/`):

```bash
cd C:\Tools\PWA-RCA
npm run setup
```

### 4) Configure secrets on the VM only

```bash
copy server\.env.example server\.env
```

Edit `server\.env` and set at least:

- `HELIXGPT_API_URL`
- `HELIXGPT_API_KEY`

Never commit `server\.env`. Restrict who can read it on the VM.

Optional:

- `PORT=8080` (or another port; default is 8080 if unset)

### 5) Build the React app (production assets)

```bash
cd C:\Tools\PWA-RCA
npm run build:client
```

This creates `client\dist\`. After this exists, **starting the server** will log `Serving static UI from: ...` and the UI is available at `http://VM:PORT/`.

### 6) Open the Windows firewall (or cloud NSG)

Allow **inbound TCP** on the port you use (e.g. **8080**) so teammates on the network can reach `http://YOUR-VM-NAME:8080`.

### 7) Smoke test manually

From the repo root:

```bash
node server\server.js
```

On the **VM**, open a browser: `http://localhost:8080` — you should see the RCA UI and be able to analyze a report.

From **another machine**: `http://YOUR-VM-IP-OR-HOSTNAME:8080`.

Stop with Ctrl+C when done testing.

---

## Keep the server running (no manual “start” every day)

### Option A — PM2 (works on Windows; good for teams)

Install once:

```bash
npm install -g pm2
```

From repo root:

```bash
cd C:\Tools\PWA-RCA
pm2 start server\server.js --name pwa-rca
pm2 save
pm2 startup
```

Follow the command PM2 prints so it restarts at OS boot. Useful commands:

- `pm2 status`
- `pm2 logs pwa-rca`
- `pm2 restart pwa-rca` (after you `npm run build:client` or change `server.js` / `.env`)

### Option B — Windows Task Scheduler

Create a task that runs at startup:

- Program: `C:\Program Files\nodejs\node.exe` (or full path to `node.exe`)
- Arguments: `C:\Tools\PWA-RCA\server\server.js`
- Start in: `C:\Tools\PWA-RCA`

### Option C — NSSM (Non-Sucking Service Manager)

Wrap `node` as a Windows service pointing at `server\server.js` with working directory = repo root.

---

## What teammates do

1. Open **`http://YOUR-VM-HOSTNAME:8080`** (or the port you set).
2. Upload Playwright reports as today. No install, no `npm start` on their PCs.

---

## Updating after you change code

On the VM, from repo root:

```bash
git pull
npm run setup
npm run build:client
pm2 restart pwa-rca
```

(Or restart whatever service you use.)

---

## Optional: API on a different host

If the UI is ever built to call another origin, set at **build** time:

```bash
set VITE_API_BASE_URL=http://other-host:8080
npm run build --prefix client
```

Normally leave it unset so the browser uses **same-origin** `/analyze`.

---

## Security (strongly recommended)

- Do not expose this to the **public internet** without **VPN**, **firewall IP allow list**, or **reverse proxy + auth** (IIS, nginx, Caddy).
- Helix keys in `server\.env` are as sensitive as production API keys.

---

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Browser shows “Cannot reach /analyze” | Server not running, firewall, or wrong URL. |
| UI is old after deploy | Run `npm run build:client` again and restart the process. |
| No UI, only API | `client\dist` missing — run `npm run build:client`. |
| `Serving static UI from` never logs | Same — `dist` does not exist. |
