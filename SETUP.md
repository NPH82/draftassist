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

---

## Database Seed

On first startup, if the Player collection is empty, the backend auto-seeds from `backend/data/rookieSeed.json` (48 2025 rookies with initial rankings). To manually force a reseed, drop the `players` collection in MongoDB Atlas and restart the server.

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

The backend runs two cron jobs automatically:
- **Daily 3am UTC**: Scrapes FantasyPros, KTC, and Underdog for updated rankings/ADPs
- **Monday 4am UTC**: Scrapes OurLabs for NFL depth chart updates

Render free tier may miss these jobs if the instance is asleep. Consider upgrading to Starter ($7/month) for always-on instances if consistent data freshness is needed.

---

## Data Sources

| Source | Data | Schedule |
|--------|------|----------|
| Sleeper API | Leagues, rosters, live draft | Real-time (polled) |
| FantasyPros | Dynasty rankings | Daily |
| KTC (KeepTradeCut) | Dynasty values | Daily |
| Underdog | ADP | Daily |
| OurLabs | NFL depth charts | Weekly |
| Pro Football Reference | Combine metrics, injuries | On-demand |
| ESPN | Current injury status | On-demand |
| RotoWire | Injury news | On-demand |

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
