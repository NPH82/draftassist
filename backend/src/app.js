const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const leaguesRoutes = require('./routes/leagues');
const playersRoutes = require('./routes/players');
const draftRoutes = require('./routes/draft');
const tradehubRoutes = require('./routes/tradehub');
const adminRoutes = require('./routes/admin');

const app = express();

// Trust one level of reverse-proxy (Render's load balancer).
// Required for express-rate-limit to read X-Forwarded-For correctly.
app.set('trust proxy', 1);

// Security
app.use(helmet());

// CORS: allow the Vercel frontend + localhost
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:5173',
  'http://localhost:3000',
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin || allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));

// Global rate limiter: 200 req/15min per IP
// keyGenerator uses req.ip (correctly populated via 'trust proxy' 1 above),
// which suppresses express-rate-limit's ERR_ERL_FORWARDED_HEADER validation.
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
}));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/leagues', leaguesRoutes);
app.use('/api/players', playersRoutes);
app.use('/api/draft', draftRoutes);
app.use('/api/tradehub', tradehubRoutes);
app.use('/api/admin', adminRoutes);

// Health check
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
