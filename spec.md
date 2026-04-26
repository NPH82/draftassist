# Dynasty Draft Assistant -- Product Specification

## Purpose

A web-based dynasty fantasy football draft assistant that integrates with Sleeper to provide real-time, personalized draft recommendations. The app guides the user on which players to draft based on their team's roster construction, win window, positional needs, and a proprietary scoring system. It also suggests trades to move up or down in the draft order, and transitions into a Trade Hub in the off-season for buy/sell analysis.

---

## Implementation Status

**Fully implemented and deployed as of April 26, 2026.**

| Layer | Status | URL |
|---|---|---|
| Frontend (React PWA) | Live | https://draftassist-chi.vercel.app |
| Backend (Node/Express) | Live | https://draftassist.onrender.com |
| Database (MongoDB Atlas) | Live | M0 free tier cluster |

### Key Post-Spec Changes Made During Build

- **`vite-plugin-pwa`** upgraded from `0.19.8` → `^1.2.0` to support Vite 6; `serialize-javascript` pinned via `overrides` to `>=7.0.5` to fix two high CVEs (GHSA-5c6j-r48x-rmvq, GHSA-qj8w-gfj5-8c6v)
- **GitHub Actions CI** added (`.github/workflows/audit.yml`): runs `npm audit --audit-level=high` and `npm run build` on every push/PR to `main` for both backend and frontend
- **`frontend/vercel.json`** created inside the `frontend/` directory (Vercel reads config relative to Root Directory); rewrites `/api/*` to Render and all other paths to `index.html` for React Router
- **Admin routes** (`/api/admin/*`) added: manual scraper trigger endpoints and data freshness status, protected by `requireAuth`
- **Dashboard data panel** added: shows per-source last-updated timestamps (FantasyPros, KTC, Underdog) and a **Refresh Rankings Now** button to trigger scrapers on-demand without waiting for the 3am cron
- **`.gitattributes`** added with `* text=auto eol=lf` to normalize all line endings to LF in the repository
- **Win Window labels** confirmed as: Rebuilding (score 0–24), Transitioning (25–49), Contending (50–74), Win Now (75–100) -- based on avg roster age, KTC value, established-starter ratio, and future-picks penalty
- **Render free tier note**: instances spin down after 15 min; first request after sleep takes ~30s. `FRONTEND_URL` env var must be set to the Vercel URL to pass CORS. `MONGODB_URI` must be set manually (not synced from render.yaml). Atlas Network Access must allow `0.0.0.0/0` due to Render's dynamic IPs.
- **Seed data**: 48 2025 rookies pre-loaded in `backend/data/rookieSeed.json` as starting point; scrapers merge live data on top once source sites publish post-draft dynasty rankings (typically within days of the NFL Draft)
- **Mongoose deprecation fixes**: All `findOneAndUpdate` calls updated from `{ new: true }` → `{ returnDocument: 'after' }` across `auth.js`, `leagues.js`, and `learningEngine.js` (×2) -- committed `08a0e17`
- **2026 rookie class seeded**: `backend/data/rookieSeed2026.json` added with the dynasty Top 48 age/opportunity-adjusted SF rookie board (Carnell Tate #1 overall). Startup guard updated from a global `count === 0` check to a year-specific `countDocuments({ nflDraftYear: 2026 }) === 0` so new draft-year classes seed alongside existing data without wiping the DB -- committed `1a31815`
- **`POST /api/admin/seed-rookies/:year`** endpoint added: manually seeds a draft class from `rookieSeed{year}.json` if the year is not yet in the DB; skips with a message if already seeded. Dashboard has a **Seed 2026 Rookie Class** button as a manual override
- **Sleeper player ID sync**: `POST /api/admin/sync-sleeper-ids` endpoint added -- back-fills any missing `sleeperId` values on Player documents using name+position matching (handles `Jr.`/`Sr.`/`II`/`III`/`IV` suffix variants). Dashboard has a **Sync Sleeper Player IDs** button as a manual override. This runs automatically on every startup -- committed `71da687`
- **Veteran player import**: `POST /api/admin/import-sleeper-players` endpoint added -- upserts all QB/RB/WR/TE players from Sleeper's `/players/nfl` into the DB. On insert: sets `name`, `position`, `sleeperId`, `team`, `age`, `injuryStatus`. On update: only refreshes `team`/`age`/`injuryStatus`, never overwrites `ktcValue`/`fantasyProsValue`/`dasScore` from scrapers. Dashboard has an **Import All Sleeper Players** button as a manual override. Runs automatically at startup when DB has fewer than 500 players and weekly every Sunday at 2am via the scheduler
- **`learningEngine.js` SyntaxError fix**: 149 lines of stale duplicate code (containing bare top-level `await` calls) were removed from after the `module.exports` block. This code was unreachable and caused a `SyntaxError: await is only valid in async functions` crash on Render (Node v24, CommonJS) -- committed `ed3f5fc`
- **`playerMap` veteran fallback in `leagues.js`**: After building the primary DB-keyed map, the `GET /api/leagues` handler also fetches the Sleeper player map (from 24h in-memory cache) and fills in any skill-position player IDs not yet in our DB. This is a safety net for players added mid-season between weekly sync runs
- **`sleeperService.getAllPlayers()` cached**: Added 24h in-memory cache to avoid repeated ~2MB Sleeper API fetches within the same process. Cache is invalidated on Render restart
- **`sleeperSync.js` service created**: `backend/src/services/sleeperSync.js` centralises `importSleeperPlayers()` and `syncSleeperIds()`. Both admin endpoints and the scheduler delegate to this service -- no duplicated logic
- **Automated startup sequence** (`server.js`): (1) seed 2025 rookies if DB empty, (2) seed 2026 rookies if none present, (3) import all Sleeper skill-position players if DB has fewer than 500 total, (4) sync `sleeperId` for any unmatched players, (5) start scheduler
- **Weekly Sleeper sync job** added to `scheduler.js`: runs every Sunday at 2am -- re-imports to refresh team/age/injury and back-fills any new ID gaps
- **`POST /api/admin/load-player-data`** endpoint wired up: triggers the one-time deep-load scrapers (PFR combine stats, ESPN draft results, RotoWire college injuries) on demand. Previously `loadPlayerData()` was exported from `scrapers/index.js` but not reachable via any route

---

## Core Fantasy Football Principles (Scoring Engine Inputs)

The app's recommendations are grounded in the following positional evaluation criteria:

**Wide Receivers**
- Yards per route run (YPRR) is the primary production metric
- Draft capital (NFL round) is a strong indicator of long-term opportunity
- Target competition on the NFL team affects opportunity ceiling
- Athletic testing (40 time, vertical, RAS/SPARQ) predicts route separation and YAC ability

**Running Backs**
- Draft capital and target competition are key value drivers
- 20+ receptions in a college season is a strong indicator of a pass-game role in the NFL
- Age is critical -- RB production drops sharply after age 27
- Athletic testing predicts elusiveness and open-field ability

**Quarterbacks**
- Draft capital is the strongest predictor of opportunity
- College success against top-tier competition (Power 5 / CFP) matters
- SuperFlex leagues create premium QB value regardless of depth chart position

**Tight Ends**
- Pass-catching TEs are more valuable than blocking-first TEs for fantasy
- Blocking TEs see the field earlier but have limited target share
- Draft capital and pass-catcher classification are primary inputs

**All Positions**
- 1st, 2nd, and 3rd round NFL draft picks have the highest long-term success probability
- Injury history (college and NFL) is a negative signal and penalizes the Draft Assistant Score
- Dynasty age windows: RBs decline post-27, WRs post-29

---

## Backend Architecture

### Directory Layout (`backend/src/`)

```
server.js           Entry point: DB connect → seed → Sleeper import → sync IDs → start scheduler
app.js              Express app: middleware, route mounting, CORS
config/db.js        Mongoose connection
jobs/scheduler.js   node-cron registered jobs (daily rankings, weekly depth charts, weekly Sleeper sync)
middleware/auth.js  requireAuth middleware (Bearer token → req.user)
models/             Mongoose schemas (Player, League, ManagerProfile, RankingSnapshot, DraftSession, User)
routes/             Express routers (one file per domain)
  admin.js          Protected management endpoints
  auth.js           Login / logout / session check
  draft.js          Live draft board, polling, queue
  leagues.js        League + roster fetch, win window, alerts
  players.js        Player search, detail, DAS
  tradehub.js       Off-season trade suggestions
scrapers/
  index.js          Orchestrator: refreshDailyRankings(), refreshDepthCharts(), loadPlayerData()
  fantasyProsScraper.js
  keepTradeCutScraper.js
  underdogScraper.js
  ourLadsScraper.js
  pfrScraper.js
  espnScraper.js
  rotowireScraper.js
services/
  sleeperService.js   All Sleeper API calls; getAllPlayers() has 24h in-memory cache
  sleeperSync.js      importSleeperPlayers() + syncSleeperIds() — used by startup, scheduler, and admin routes
  scoringEngine.js    calculateDAS() — Draft Assistant Score
  winWindowService.js computeRosterMaturity() + analyzePositionalNeeds()
  alertService.js     generateBuySellAlerts()
  learningEngine.js   ingestDraft() + learnFromUserLeagues() + generateScoutingNotes()
  tradeEngine.js      Trade suggestion logic
  availabilityPredictor.js  Pick-by-pick availability probability
```

### Startup Sequence (`server.js`)

1. Connect to MongoDB Atlas
2. Seed 2025 rookie class (`rookieSeed.json`) if DB is empty
3. Seed 2026 rookie class (`rookieSeed2026.json`) if no 2026 players present
4. **Auto-import all skill-position veterans** from Sleeper `/players/nfl` if DB has fewer than 500 players (`importSleeperPlayers()`)
5. **Back-fill `sleeperId`** for any players missing one (`syncSleeperIds()`) — no-op when all IDs set
6. Start node-cron scheduler

### Scheduled Jobs (`jobs/scheduler.js`)

| Schedule | Job |
|---|---|
| Daily 3:00 AM | `refreshDailyRankings()` — FantasyPros, KTC, Underdog ADP |
| Monday 4:00 AM | `refreshDepthCharts()` — OurLads |
| Sunday 2:00 AM | `importSleeperPlayers()` + `syncSleeperIds()` — keeps team/age/injury current, fills new ID gaps |

### Admin Endpoints (`/api/admin/*`, all require auth)

| Method | Path | Purpose |
|---|---|---|
| POST | `/refresh/rankings` | Trigger daily rankings scrape now |
| POST | `/refresh/depth-charts` | Trigger depth chart scrape now |
| POST | `/load-player-data` | Trigger one-time deep load: PFR + ESPN + RotoWire |
| POST | `/seed-rookies/:year` | Seed a draft class from `rookieSeed{year}.json` (skips if already present) |
| POST | `/import-sleeper-players` | Upsert all skill-position players from Sleeper (safe to re-run) |
| POST | `/sync-sleeper-ids` | Back-fill `sleeperId` on unmatched players |
| POST | `/learn` | Scan user leagues + leaguemate leagues for completed drafts |
| GET | `/data-status` | Last-updated timestamps per data source |
| GET | `/manager-profiles` | Scouting summaries for all leaguemates |

### Player Data Flow

```
Sleeper /players/nfl (weekly sync)
        │
        ▼
sleeperSync.importSleeperPlayers()
  → upserts QB/RB/WR/TE with team/age/injuryStatus
  → never overwrites ktcValue/fantasyProsValue/dasScore
        │
        ▼
MongoDB Player collection  ◄── scrapers attach KTC/FP/ADP/depth chart values by name match
        │
        ▼
leagues.js GET /  → builds playerMap (DB primary, Sleeper in-memory fallback)
        │
        ▼
winWindowService.computeRosterMaturity()  → Roster Maturity Score + win window label
winWindowService.analyzePositionalNeeds() → positional need gaps
```

---



### Stack
- **Frontend:** React (MERN), deployed to **Vercel** (free tier)
- **Backend:** Node.js + Express, deployed to **Render** (free tier)
- **Database:** MongoDB, hosted on **MongoDB Atlas** (free tier)
- **App type:** Progressive Web App (PWA) -- installable to phone home screen, mobile-first design

### Authentication
- Users log in with their **Sleeper username** (no password -- uses the public Sleeper API)
- Multi-user supported -- each user's data is scoped to their username
- No separate app account or email/password required

### Hosting & Deployment
- Full cloud deployment required (must be accessible from phone in real time)
- Accounts needed: MongoDB Atlas, Vercel, Render (all free tier -- setup guide will be provided)

---

## Data Sources

| Source | Data | Refresh Frequency |
|---|---|---|
| [Sleeper Public API](https://docs.sleeper.com/) | Leagues, rosters, draft picks, live draft state, weekly player stats | Real-time during draft; daily otherwise |
| [FantasyPros](https://www.fantasypros.com/) | Dynasty rankings, trade value chart | Daily |
| [KeepTradeCut](https://keeptradecut.com/dynasty-rankings) | Dynasty trade values | Daily |
| [Underdog ADP](https://underdogfantasy.com/) | Average draft position | Daily |
| [OurLads](https://www.ourlads.com/nfldepthcharts/) | NFL depth charts (scrape) | Weekly |
| [Pro Football Reference](https://www.pro-football-reference.com/) | College stats, combine data, NFL injury history (scrape) | On player data load |
| [ESPN](https://www.espn.com/nfl/draft/rounds) | 2026 NFL Draft results (scrape) | On load / as needed |
| [RotoWire](https://www.rotowire.com/cfootball/news.php?view=injuries) | College injury history (scrape) | On player data load |
| [Sleeper Player Endpoint](https://docs.sleeper.com/) | Current NFL injury status for rostered veterans | Daily |

**Injury history strategy:** Pro Football Reference is used for historical injury patterns (chronic vs. one-time); Sleeper's player endpoint provides current injury status. Both are used together for the most comprehensive picture.

**Scraping fallback:** If a site blocks scraping, the last successfully retrieved data is stored in MongoDB and used as the fallback. A manual CSV/JSON import option is available as a last resort.

**Stale data indicator:** All data panels display a "last updated: X hours ago" timestamp. Prominently visible during live drafts.

---

## Draft Assistant Score

A proprietary numeric score displayed on every player card. Calculated from position-specific weighted inputs. Weights are fixed -- not user-adjustable.

### Score Inputs

**All positions receive weight for:**
- NFL draft capital (round + pick number)
- Injury history -- college sourced from RotoWire, NFL historical from Pro Football Reference, current status from Sleeper
- Combine / athletic testing: 40 time, vertical jump, RAS/SPARQ (sourced from Pro Football Reference)
- Age / dynasty runway (penalizes older players; RBs penalized most aggressively approaching age 27)

**WR-specific weights:**
- YPRR (primary metric)
- Target competition on landing NFL team
- Depth chart opportunity

**RB-specific weights:**
- Target share / pass-catching role
- College reception count (20+ in a season is a strong positive signal)
- Age (most heavily penalized position for age)

**QB-specific weights:**
- Draft capital (primary metric)
- College competition level (Power 5 / CFP schedule strength)
- Depth chart clarity (starting role probability)

**TE-specific weights:**
- Pass-catcher vs. blocker classification
- Draft capital
- Depth chart opportunity

### Score Display
- Shown alongside FantasyPros value and KTC value on each player card
- When FantasyPros and KTC diverge by a meaningful margin, the player is flagged as a **"Value Gap Opportunity"** with an indicator showing which site ranks the player higher

---

## Initial Rankings Seed

The starting dynasty board is seeded from a Claude-generated Top 48 dynasty rookie list (age/opportunity-adjusted, SuperFlex format, depth-chart-corrected) and cross-referenced against FantasyPros and KTC. The final blended board also applies the app's own Draft Assistant Score criteria, producing a ranking that is intentionally distinct from generic public boards.

**2026 class seed file:** `backend/data/rookieSeed2026.json` — 48 players, ranked by dynasty value (Carnell Tate WR/TEN #1, Jeremiyah Love RB/ARI #2, Fernando Mendoza QB/LV #3). Fields include `nflDraftYear`, `nflDraftRound`, `nflDraftPick`, `age`, `college`, `ktcValue`, and `fantasyProsRank`. Seeded on startup if no 2026 players exist in the DB; can also be triggered via `POST /api/admin/seed-rookies/2026`.

---

## League & Roster Integration

### League Loading
- On login, the app fetches all dynasty leagues for the user's Sleeper username
- Also fetches completed 2026 rookie drafts from leagues where the user's **leaguemates** participated (even leagues the user is not in), for broader draft tendency data

### Roster Evaluation
- The user's current dynasty roster is pulled from Sleeper for each league
- The app evaluates whether an available draft prospect is an upgrade over existing rostered players at the same position
- Recommendations factor in current positional needs per league

### Win Window Detection
- Automatically inferred from roster construction -- no manual mode setting required
- Signals combined into a **Roster Maturity Score:**
  - Average age of rostered skill players
  - Current KTC/FantasyPros trade value of the full roster
  - Ratio of developmental vs. established starters
  - Whether the team holds future first-round picks (rebuild indicator)
- A one-line reason is shown to the user (e.g., "Rebuilding -- young roster with limited established starters")

---

## Draft Mode (Live Draft Experience)

### Draft Selection
- On load, active drafts are sorted by **time until the user's next pick** (soonest first)
- If the user is on the clock in multiple drafts simultaneously, those are sorted **alphabetically**

### Live Board
- Polls Sleeper's draft API in real-time, updating as picks are made by all managers
- Displays the user's upcoming pick slot prominently
- Shows the full available player board with Draft Assistant Score, FantasyPros value, KTC value, and value gap flags

### Recommendation Modes (toggle during draft)
- **Team Need (default on load):** Best available player that fills a positional gap given roster construction and win window
- **Best Player Available (BPA):** Highest-scored player remaining regardless of positional need

### Auto-Generated Draft Queue
- The app automatically generates and maintains a prioritized list of target players
- The user can **manually reorder** players in the queue via drag-and-drop
- The queue updates in real-time as players are drafted off the board

### Availability Predictions
- For each player remaining, the app predicts the probability they will still be available at the user's next pick
- Predictions update pick-by-pick based on who has been selected and each manager's tendency profile

### Faller Alerts
- In-app toast/banner alert fires when a target player falls **3 or more picks** past their projected draft position
- In-app only -- no push notifications

### Opponent Targeting Predictions
- Tracks all 12 teams' rosters (from Sleeper) to predict what each manager is likely to draft next
- Kept lightweight -- position need inference based on roster gaps, weighted by manager tendency profile

---

## Trade Suggestions

### During Draft (Move Up / Move Down)
- When a target player risks being taken before the user's pick: suggests a **trade-up**
- When a target player is projected to still be available later: suggests a **trade-down**
- Each suggestion names a **specific manager** to target, based on their roster needs and tendency profile
- Suggests an **acceptable value package** including players and/or picks (current-year and future picks)
- Assesses trade fairness for **both sides** using KTC and FantasyPros values to maximize acceptance probability

### Trade Value Reference
- Primary: [FantasyPros Dynasty Trade Value Chart](https://www.fantasypros.com/2026/03/fantasy-football-rankings-dynasty-trade-value-chart-APRIL-2026-update/)
- Secondary: [KeepTradeCut Dynasty Rankings](https://keeptradecut.com/dynasty-rankings)
- Multi-year pick valuation supported (e.g., 2027 1st, 2028 2nd)
- Value gaps between FantasyPros and KTC are flagged as trade exploitation opportunities

---

## Trade Hub (Off-Season Mode)

### Mode Switch
- App automatically switches from Draft Mode to Trade Hub Mode when the **NFL pre-season begins in August**

### Trade Hub Features
- Dedicated Trade Hub screen for browsing suggested trades across all leagues
- Each suggestion names a specific target manager and displays their **full Sleeper roster** alongside the proposed offer
- The app verifies the deal is fair for both sides before surfacing it

### Buy/Sell Alerts
- Monitors player value using:
  - KTC and FantasyPros value vs. 30/60/90-day trend
  - In-season NFL performance (weekly stats via Sleeper API)
  - Depth chart changes (injury, promotion/demotion via OurLads)
- Fires an **in-app alert** when a notable buy or sell window is detected (e.g., "Sell high: Player X's value up 15% in 30 days")
- Alerts are in-app only -- no push notifications or email digests
- Alerts are scoped to leagues where the player is relevant to the user's specific roster situation

---

## Manager Tendency & Learning System

### Scouting Reports
- Each leaguemate has a visible **Scouting Report card** showing:
  - Position preferences (e.g., "tends to overdraft QBs early")
  - College program preferences (e.g., "favors SEC players")
  - NFL team preferences (e.g., "consistently targets Chiefs players")
  - Historical draft patterns by round

### Learning Engine
- Learns from all completed 2026 rookie drafts accessible via Sleeper (user's leagues + leaguemates' other leagues)
- Applies **partial weighting from the very first completed draft** -- no minimum data threshold required
- Learning data is **shared/crowdsourced across all app users** for better ADP accuracy
- Updates:
  - **ADP adjustments** -- players being drafted earlier/later than their board ranking
  - **Manager tendency profiles** -- consistent positional, college, and NFL team preferences
  - **Availability predictions** -- probability a player is still on the board at a given pick
  - **Roster construction patterns** -- which player types a manager targets based on their current roster state

---

## UX & Design

- **Mobile-first PWA** -- optimized for phone use during live drafts; desktop is a secondary, wider layout
- **Installable** to phone home screen via PWA manifest and service worker
- **Offline resilience** -- caches last known board state; displays "offline -- using cached data" warning if connectivity is lost mid-draft
- **Stale data indicator** -- all data panels show "last updated: X time ago"; prominently displayed during live drafts
- **In-app alerts** -- toast/banner notifications for faller alerts and buy/sell signals (no push notifications, no email)