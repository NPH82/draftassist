# DraftAssist -- Setup & Deployment Guide

## Prerequisites
- Node.js 18+
- MongoDB Atlas account (free tier)
- Render account (free tier, for backend)
- Vercel account (free tier, for frontend)

---

## Local Development

### 1. Clone and install deps
```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### 2. Backend environment variables
Copy `.env.example` to `.env` and fill in:
```
MONGODB_URI=mongodb+srv://<user>:<pass>@cluster0.mongodb.net/draftassistant?retryWrites=true&w=majority
PORT=4000
FRONTEND_URL=http://localhost:5173
NODE_ENV=development
```

### 3. Run dev servers (two terminals)
```bash
# Terminal 1 -- backend
cd backend
npm run dev

# Terminal 2 -- frontend
cd frontend
npm run dev
```

Frontend: http://localhost:5173  
Backend API: http://localhost:4000  
Health check: http://localhost:4000/health

### 4. Local security gate (required)
To block pushes that contain high-severity vulnerabilities, install the repo-tracked pre-push hook once per clone:

```bash
cd ..
npm run hooks:install
```

What this does:
- Configures Git hooks path to `.githooks`
- Enforces a docs-update rule on commit: if app code changes, `spec.md` and/or `SETUP.md` must be updated in the same commit
- Runs backend and frontend unit tests after each commit (`post-commit`)
- Runs `npm audit --audit-level=high` in both `backend/` and `frontend/` before every push
- Runs backend and frontend unit tests with coverage thresholds before every push
- Runs docs-check before every push
- Blocks the push if any audit, test/coverage, or docs-check gate fails

Policy note:
- Local hooks can technically be skipped with Git's `--no-verify` flag. Do not use it.
- Non-bypass enforcement is handled by required GitHub checks (next section).

You can also run the same check manually anytime:

```bash
npm run security:audit
npm run coverage:all
```

### 5. GitHub non-bypass security rule (required)
Configure branch protection (or a ruleset) on `main` so merges are blocked unless security checks pass.

Required settings:
- Require a pull request before merging
- Require status checks to pass before merging
- Required checks:
   - `Backend -- Audit & Lint`
   - `Frontend -- Audit, Build & PWA check`
   - `Backend -- Unit Tests & Coverage`
   - `Frontend -- Unit Tests & Coverage`
   - `Docs -- Required Updates Check`
- Restrict who can push directly to `main`
- Do not allow bypass for administrators (if your org/repo settings support this toggle)

This makes vulnerability checks non-optional even if someone tries to skip local hooks.

Coverage target:
- Unit test coverage gates enforce >=95% for lines/functions/statements on unit-tested utility modules.
- Branch coverage is still reported and tracked, but not used as a blocking threshold.

---

## Database Seed

The startup sequence runs automatically on every server start:
1. Seeds 2025 rookie class from `backend/data/rookieSeed.json` if the DB is empty
2. Seeds 2026 rookie class from `backend/data/rookieSeed2026.json` if no 2026 players exist
3. Imports all Sleeper skill-position players (QB/RB/WR/TE) if DB has fewer than 500 players total
4. Back-fills `sleeperId` for any unmatched players

To manually force a reseed of a specific year, use the admin endpoint:
```bash
curl -X POST http://localhost:4000/api/admin/seed-rookies/2026 \
  -H "Authorization: Bearer <sleeper_user_token>"
```

---

## Player Data Load (College Stats + Combine)

After initial seed, run the one-time deep load to populate combine metrics and college stats (PFR + ESPN + RotoWire). This enriches rookie player cards with athletic testing and college production data used by the Draft Assistant Score.

```bash
curl -X POST http://localhost:4000/api/admin/load-player-data \
  -H "Authorization: Bearer <sleeper_user_token>"
```

Or use the **Refresh Player Data** button on the Dashboard.

This scrapes:
- **PFR combine**: 40 time, vertical jump for the current draft class
- **PFR college stats**: receiving (YPR, rec, yards, TDs) and rushing (YPC, att, yards) from sports-reference.com/cfb
- **ESPN**: current-year NFL draft results (round/pick)
- **RotoWire**: college injury history

Results are upserted onto all Player documents with `nflDraftYear >= 2025`. Safe to re-run.

---

## Deployment

### Backend (Render)

1. Push repo to GitHub
2. Create a new **Web Service** on Render, connected to your repo
3. Set:
   - **Root Directory**: `backend`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Runtime**: Node
4. Add environment variables in Render dashboard:
   - `MONGODB_URI` (from Atlas)
   - `FRONTEND_URL` (your Vercel URL, e.g. `https://draftassist.vercel.app`)
   - `NODE_ENV=production`
   - `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` — required for devy discrepancy report emails (Gmail: host=`smtp.gmail.com`, port=`587`, secure=`false`, user/from=Gmail address, pass=16-char App Password)
   - `DISCREPANCY_REPORT_TO_EMAIL` — address that receives devy discrepancy report notifications
   - Optional timeout tuning for slower hosts:
     - `DISCREPANCY_EMAIL_TIMEOUT_MS` (default `25000`)
     - `SMTP_CONNECTION_TIMEOUT_MS` (default `8000`)
     - `SMTP_GREETING_TIMEOUT_MS` (default `8000`)
     - `SMTP_SOCKET_TIMEOUT_MS` (default `20000`)
       - `SMTP_IP_FAMILY` (default `4`) to force IPv4 DNS resolution when host networking cannot reach IPv6 SMTP endpoints
    - Optional HTTPS fallback (recommended when SMTP egress is flaky/blocked):
       - `RESEND_API_KEY`
       - `RESEND_FROM_EMAIL` (must be a verified sender/domain in Resend)
       - `RESEND_TO_EMAIL` (optional override recipient; defaults to `DISCREPANCY_REPORT_TO_EMAIL`)
       - `RESEND_HTTP_TIMEOUT_MS` (default `12000`)

Note: Free tier Render instances spin down after 15 min of inactivity. The first request after sleep takes ~30s.

### Frontend (Vercel)

1. Import your repo on Vercel
2. Set:
   - **Root Directory**: `frontend`
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
3. Add environment variable:
   - `VITE_API_URL` (your Render backend URL, e.g. `https://draft-assistant-backend.onrender.com`)
4. In `vercel.json`, replace the `/api/(.*)` destination with your Render URL

### MongoDB Atlas

1. Create a free M0 cluster
2. Create a database user
3. Allow access from anywhere (0.0.0.0/0) for Render's dynamic IPs
4. Copy the connection string to `MONGODB_URI`

---

## Scheduled Jobs

The backend runs three cron jobs automatically:
- **Daily 3am UTC**: Scrapes FantasyPros, KTC, and Underdog for updated rankings/ADPs
- **Monday 4am UTC**: Scrapes OurLads for NFL depth chart updates
- **Sunday 2am UTC**: Re-imports all Sleeper skill-position players (refreshes team/age/injury) and back-fills any new `sleeperId` gaps

Render free tier may miss these jobs if the instance is asleep. Consider upgrading to Starter ($7/month) for always-on instances if consistent data freshness is needed.

All jobs can also be triggered manually from the Dashboard or via admin endpoints under `/api/admin/*`.

---

## Data Sources

| Source | Data | Schedule |
|--------|------|----------|
| Sleeper API | Leagues, rosters, live draft | Real-time (polled) |
| FantasyPros | Dynasty rankings | Daily |
| KTC (KeepTradeCut) | Dynasty values | Daily |
| Underdog | ADP | Daily |
| OurLabs | NFL depth charts | Weekly |
| Pro Football Reference | Combine metrics (40 time, vertical); college receiving/rushing stats via sports-reference.com/cfb; NFL injury history | On-demand (`/api/admin/load-player-data`) |
| ESPN | NFL Draft results (round/pick) | On-demand |
| RotoWire | College injury history | On-demand |

---

## PWA / Offline

The frontend is a Progressive Web App. Users can:
- Install it to their home screen on iOS/Android
- Access cached draft board data while offline (Sleeper API cached with Workbox NetworkFirst, 5min TTL)

---

## Troubleshooting

**"No players found" on draft board**: The seed didn't run. Check backend logs for seed errors, or manually POST to `/api/players/import` with JSON data.

**Login fails with 404**: Verify the Sleeper username is correct (case-insensitive, no spaces).

**Scraper returns stale data**: Scrapers fall back to last cached DB data. If a scraper consistently fails, check if the source site changed its HTML structure.

**Draft not showing**: Sleeper draft must be in `drafting` status. Mocks and completed drafts are filtered out.

**Wrong rookie class in draft targets**: Rookie/Devy recommendations now auto-detect class year, but Sleeper offseason season labels can lag. Use `classYear` override when needed:

```bash
GET /api/leagues/:leagueId/draft-targets?classYear=2026
GET /api/draft/:draftId?classYear=2026
```

If position need tags feel stale, refresh league cache by reloading the Dashboard (`/api/leagues` recomputes needs from current roster, SuperFlex, and TE premium scoring context).

**Devy Drafted tab missing prospects from League Notes**: Devy pool now parses commissioner-managed player notes/nicknames for parenthetical prospects (for example, `Elliott Fry (Ahmad Hardy RB Missouri)`) and cross-references all leaguemate rosters. If names still do not appear under Drafted Devy, confirm the note is attached to a rostered player and includes the devy name in parentheses.

The backend also persists discovered drafted devy mappings into `DevyOwnershipSnapshot` (manager + team + league scoped). This cache is reused by future devy-pool calls to speed up cross-league note resolution for all users.

No per-league spreadsheet is required. Devy mapping is inferred directly from Sleeper league metadata notes/nicknames across all managers in that league, with extra weighting for placeholder roster slots (K/DEF/inactive or retired players) where commissioners commonly store devy notes.
