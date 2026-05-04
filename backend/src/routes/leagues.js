/**
 * Leagues routes
 * Fetches and caches Sleeper league + roster data.
 */

const express = require('express');
const router = express.Router();

const sleeperService = require('../services/sleeperService');
const { requireAuth } = require('../middleware/auth');
const {
  computeLeagueOutlooks,
  analyzePositionalNeeds,
  buildRosterComposition,
  scoreDraftFit,
} = require('../services/winWindowService');
const { ingestCompletedDraftTrends } = require('../services/draftTrendService');
const { generateBuySellAlerts } = require('../services/alertService');
const { calcPersonalRankScore } = require('../services/scoringEngine');
const { ingestDevyDiscrepancyReport } = require('../services/learningEngine');
const { inferMissReason, sendDiscrepancyEmailWithTimeout } = require('../services/discrepancyReportService');
const League = require('../models/League');
const Player = require('../models/Player');
const ManagerProfile = require('../models/ManagerProfile');
const DevyOwnershipSnapshot = require('../models/DevyOwnershipSnapshot');
const DevyDiscrepancyReport = require('../models/DevyDiscrepancyReport');
const { extractDevyCandidatesFromAlias } = require('../utils/devyNoteParser');
const { normalizeComparableName, scoreComparableNameMatch } = require('../utils/devyNameMatcher');
const { shouldExcludeAvailableByDrafted } = require('../utils/devyPoolDraftExclusion');

const KTC_TO_FP = 68 / 9500;
const SKILL_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
const IDP_POSITIONS = new Set(['LB', 'LB/ED', 'DE', 'DE/ED', 'DL', 'DL/ED', 'DT', 'CB', 'S']);
const POSITION_FILTER_ORDER = ['QB', 'RB', 'WR', 'TE', 'LB', 'LB/ED', 'DE', 'DE/ED', 'DL', 'DL/ED', 'DT', 'CB', 'S'];

function fpEquivalentValue(player = {}, isDevy = false) {
  const fp = Number(player.fantasyProsValue || 0);
  const ktcRaw = isDevy ? Number(player.devyKtcValue || player.ktcValue || 0) : Number(player.ktcValue || 0);
  const ktcFp = ktcRaw > 0 ? ktcRaw * KTC_TO_FP : 0;

  if (fp > 0 && ktcFp > 0) return Math.round(((fp * 0.55) + (ktcFp * 0.45)) * 10) / 10;
  if (fp > 0) return Math.round(fp * 10) / 10;
  if (ktcFp > 0) return Math.round(ktcFp * 10) / 10;
  return 0;
}

function parseYearsExp(player = {}) {
  const value = Number(player.years_exp);
  return Number.isFinite(value) ? value : null;
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildDevyRosterDedupKey({ ownerId, associatedPlayerId, devyPlayerId, sleeperId, name }) {
  const ownerKey = String(ownerId || '').trim();
  const associatedKey = String(associatedPlayerId || '').trim();
  const devyPlayerKey = devyPlayerId ? String(devyPlayerId).trim() : '';
  const sleeperKey = String(sleeperId || '').trim();
  const nameKey = normalizeName(name);
  const identity = devyPlayerKey || sleeperKey || nameKey;
  return `${ownerKey}:${associatedKey}:${identity}`;
}

function isSleeperDevyPlayer(sp = {}) {
  if (!sp || typeof sp !== 'object') return false;
  // Sleeper's official devy flag.
  const yearsExp = parseYearsExp(sp);
  if (yearsExp === -1) return true;
  // Require player to be active in Sleeper — retired/inactive vets must never qualify.
  if (sp.active === false) return false;
  const statusLower = (sp.status || '').toLowerCase();
  if (statusLower === 'inactive' || statusLower === 'retired') return false;
  // Fallback: genuinely pre-NFL college prospect — years_exp exactly 0, no team, college present.
  return yearsExp === 0 && !sp.team && !!sp.college;
}

function isLikelyPlaceholderPlayer(sp = {}) {
  if (!sp || typeof sp !== 'object') return false;
  const pos = String(sp.position || '').toUpperCase();
  if (pos === 'K' || pos === 'DEF' || pos === 'DST') return true;
  const status = String(sp.status || '').toLowerCase();
  if (status === 'inactive' || status === 'retired') return true;
  if (sp.active === false) return true;
  return false;
}

function parseMetadataAliasMap(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null;
  }
}

function getAliasMapsFromMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== 'object') return [];
  const out = [];
  const pushMap = (value) => {
    const map = parseMetadataAliasMap(value);
    if (map) out.push(map);
  };

  pushMap(metadata.player_nicknames);
  pushMap(metadata.player_notes);
  pushMap(metadata.player_nickname);
  pushMap(metadata.player_note);

  for (const [key, value] of Object.entries(metadata)) {
    if (!/player|note|nick/i.test(key)) continue;
    pushMap(value);
  }

  return out;
}

function pickBestAlias(rawAliases = [], { preferDetailed = false } = {}) {
  if (!Array.isArray(rawAliases) || rawAliases.length === 0) return null;

  const score = (text) => {
    const value = String(text || '').trim();
    if (!value) return -1;
    let s = 0;
    if (/\([^)]{3,}\)/.test(value)) s += 8;
    if (/\b(QB|RB|WR|TE|LB|DL|DE|DT|CB|S|DB|EDGE|ED)\b/i.test(value)) s += 4;
    if (/[,;/+]|\band\b/i.test(value)) s += 1;
    if (preferDetailed) s += Math.min(6, Math.floor(value.length / 8));
    return s;
  };

  return rawAliases
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .sort((a, b) => score(b) - score(a))[0] || null;
}

function getPlayerAliasFromMetadata(metadata = {}, playerId) {
  if (!metadata || !playerId) return null;

  const possibleMaps = getAliasMapsFromMetadata(metadata);

  for (const map of possibleMaps) {
    if (map && typeof map === 'object' && !Array.isArray(map) && map[playerId]) {
      return String(map[playerId]).trim();
    }
  }

  // Fallback for uncommon direct-key layouts.
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== 'string') continue;
    if (key === playerId || key.endsWith(`:${playerId}`) || key.endsWith(`_${playerId}`)) {
      const alias = value.trim();
      if (alias) return alias;
    }
  }

  return null;
}

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function isRookieDraftContext(draftData = {}, league = {}) {
  const rounds = draftData.settings?.rounds || 0;
  const teams = draftData.settings?.teams || league.totalRosters || 12;
  if (rounds > 0 && rounds < teams) return true;

  const text = [draftData.metadata?.name, draftData.metadata?.description, league.name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return /rookie|devy/.test(text);
}

function isActiveLeagueStatus(status) {
  const normalized = String(status || '').toLowerCase();
  // Sleeper league statuses are typically: pre_draft, drafting, in_season, complete.
  return normalized === 'pre_draft' || normalized === 'drafting' || normalized === 'in_season';
}

function inferDevyEnabled(league, existingLeague = null) {
  if (typeof existingLeague?.devyEnabled === 'boolean') return existingLeague.devyEnabled;

  const text = [league?.name, ...(league?.roster_positions || league?.rosterPositions || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return /devy|campus|c2c/.test(text);
}

function inferIdpEnabled(rosterPositions = [], existingLeague = null) {
  if (typeof existingLeague?.idpEnabled === 'boolean') return existingLeague.idpEnabled;

  const normalized = (rosterPositions || []).map((pos) => String(pos || '').toUpperCase());
  return normalized.some((pos) => (
    pos === 'IDP_FLEX' || pos === 'FLEX_IDP' || pos === 'DL' || pos === 'DB' || pos === 'LB' ||
    pos === 'CB' || pos === 'S' || pos === 'DE' || pos === 'DT'
  ));
}

function allowsDevyPoolPosition(position, { devyEnabled, idpEnabled }) {
  const normalized = String(position || '').toUpperCase();
  if (!normalized) return false;
  if (devyEnabled && SKILL_POSITIONS.has(normalized)) return true;
  if (idpEnabled && IDP_POSITIONS.has(normalized)) return true;
  return false;
}

function getLeaguePositionFilters({ devyEnabled, idpEnabled }) {
  return POSITION_FILTER_ORDER.filter((position) => allowsDevyPoolPosition(position, { devyEnabled, idpEnabled }));
}

async function mapWithConcurrency(items, limit, mapper) {
  const out = new Array(items.length);
  let index = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = index;
      index += 1;
      if (i >= items.length) break;
      out[i] = await mapper(items[i], i);
    }
  });

  await Promise.all(workers);
  return out;
}

async function resolveDraftClassYear({ requestedYear, draftData, league }) {
  const currentYear = new Date().getFullYear();
  const explicit = toInt(requestedYear);
  if (explicit) return explicit;

  let season = toInt(draftData?.season) || toInt(league?.season) || currentYear;

  // Sleeper can still report previous season for offseason rookie drafts.
  if (season < currentYear) {
    const hasCurrentClass = await Player.exists({ nflDraftYear: currentYear });
    if (hasCurrentClass) season = currentYear;
  }

  return season;
}

function playerValueSignal(player) {
  if (player.ktcValue) return player.ktcValue;
  if (player.fantasyProsRank) return Math.max(0, 12000 - (player.fantasyProsRank * 120));
  return 0;
}

function buildTeamContext(players = []) {
  const ctx = {};

  for (const p of players) {
    if (!p.team || !p.position) continue;
    if (!ctx[p.team]) {
      ctx[p.team] = {
        rbValue: 0,
        wrTeValue: 0,
        totalSkillValue: 0,
        elitePassCatchers: 0,
      };
    }

    const value = playerValueSignal(p);
    if (p.position === 'RB') ctx[p.team].rbValue += value;
    if (p.position === 'WR' || p.position === 'TE') ctx[p.team].wrTeValue += value;
    if (['RB', 'WR', 'TE', 'QB'].includes(p.position)) ctx[p.team].totalSkillValue += value;

    const isElitePassCatcher = (p.position === 'WR' || p.position === 'TE') &&
      ((p.ktcValue || 0) >= 5000 || ((p.fantasyProsRank || 9999) <= 36));
    if (isElitePassCatcher) ctx[p.team].elitePassCatchers += 1;
  }

  for (const team of Object.keys(ctx)) {
    const t = ctx[team];
    t.passHeavy = t.wrTeValue > t.rbValue * 1.25;
    t.runHeavy = t.rbValue > t.wrTeValue * 1.1;
    if (t.totalSkillValue >= 24000) t.offenseTier = 'high';
    else if (t.totalSkillValue <= 9000) t.offenseTier = 'low';
    else t.offenseTier = 'neutral';
  }

  return ctx;
}

function marketRankSignal(player = {}, fallbackRank = 999) {
  const adp = Number(player.underdogAdp || 0);
  const fp = Number(player.fantasyProsRank || 0);
  if (adp > 0) return adp;
  if (fp > 0) return fp;
  return fallbackRank;
}

// ── Draft grading helpers ────────────────────────────────────────────────────
function gradingMedian(values = []) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function gradingStdDev(values = []) {
  if (!values.length) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + ((v - mean) ** 2), 0) / values.length;
  return Math.sqrt(Math.max(variance, 0));
}

function draftGradeFromZScore(z) {
  if (z >= 1.8) return 'A+';
  if (z >= 1.4) return 'A';
  if (z >= 1.1) return 'A-';
  if (z >= 0.8) return 'B+';
  if (z >= 0.5) return 'B';
  if (z >= 0.25) return 'B-';
  if (z >= 0.1) return 'C+';
  if (z > -0.1) return 'C';
  if (z >= -0.35) return 'C-';
  if (z >= -0.65) return 'D+';
  if (z >= -0.95) return 'D';
  if (z >= -1.25) return 'D-';
  return 'F';
}

function consensusAdpForGrade(player = {}, { rookieDraft = false } = {}) {
  const rookieObserved = Number(player.sleeperRookieObservedAdp || 0);
  const observed = Number(player.sleeperObservedAdp || 0);
  const expected = Number(player.expectedAdp || 0);
  const adp = Number(player.underdogAdp || 0);
  const fp = Number(player.fantasyProsRank || 0);
  if (rookieDraft && rookieObserved > 0) return rookieObserved;
  if (observed > 0) return observed;
  if (expected > 0) return expected;
  if (adp > 0) return adp;
  if (fp > 0) return fp;
  return null;
}

function computeDraftGradesForLeague({ draftData, picks, rosters, userMap, playerBySleeperId }) {
  const rookieDraft = isRookieDraftContext(draftData, {});
  const ownerByRosterId = Object.fromEntries((rosters || []).map((r) => [String(r.roster_id), r.owner_id]));

  const byManager = {};
  for (const ownerId of Object.keys(draftData?.draft_order || {})) {
    byManager[ownerId] = { ownerId, ownerUsername: userMap?.[ownerId]?.username || ownerId, picks: 0, picksWithConsensus: 0, weightedScoreSum: 0, weightSum: 0, deltaSum: 0 };
  }

  for (let i = 0; i < (picks || []).length; i++) {
    const pick = picks[i] || {};
    const playerId = String(pick.player_id || '').trim();
    if (!playerId) continue;
    const ownerId = pick.picked_by || ownerByRosterId[String(pick.roster_id || '')];
    if (!ownerId) continue;
    if (!byManager[ownerId]) {
      byManager[ownerId] = { ownerId, ownerUsername: userMap?.[ownerId]?.username || ownerId, picks: 0, picksWithConsensus: 0, weightedScoreSum: 0, weightSum: 0, deltaSum: 0 };
    }
    byManager[ownerId].picks += 1;
    const player = playerBySleeperId[playerId];
    if (!player) continue;
    const consensusAdp = consensusAdpForGrade(player, { rookieDraft });
    if (!(consensusAdp > 0)) continue;
    const actualPick = Number(pick.pick_no || (i + 1));
    if (!(actualPick > 0)) continue;
    const delta = consensusAdp - actualPick;
    const scale = Math.max(6, consensusAdp * 0.16);
    let normalized = delta / scale;
    if (normalized < 0) normalized *= 0.8;
    const weight = 1 / Math.sqrt(actualPick);
    byManager[ownerId].picksWithConsensus += 1;
    byManager[ownerId].weightedScoreSum += normalized * weight;
    byManager[ownerId].weightSum += weight;
    byManager[ownerId].deltaSum += delta;
  }

  const baseRows = Object.values(byManager).map((m) => ({
    ownerId: m.ownerId,
    ownerUsername: m.ownerUsername,
    picks: m.picks,
    picksWithConsensus: m.picksWithConsensus,
    avgPickDelta: m.picksWithConsensus > 0 ? Math.round((m.deltaSum / m.picksWithConsensus) * 100) / 100 : null,
    rawScore: m.weightSum > 0 ? m.weightedScoreSum / m.weightSum : null,
  }));

  const validRaw = baseRows.map((r) => r.rawScore).filter((v) => Number.isFinite(v));
  const med = gradingMedian(validRaw);
  const spread = Math.max(0.12, gradingStdDev(validRaw));

  const graded = baseRows.map((row) => {
    if (!Number.isFinite(row.rawScore)) return { ...row, rawScore: null, zScore: null, grade: 'C' };
    const z = (row.rawScore - med) / spread;
    return { ...row, rawScore: Math.round(row.rawScore * 100) / 100, zScore: Math.round(z * 100) / 100, grade: draftGradeFromZScore(z) };
  });

  graded.sort((a, b) => {
    const az = Number.isFinite(a.zScore) ? a.zScore : -999;
    const bz = Number.isFinite(b.zScore) ? b.zScore : -999;
    return bz !== az ? bz - az : (a.ownerUsername || '').localeCompare(b.ownerUsername || '');
  });
  graded.forEach((row, i) => { row.rank = i + 1; });
  return graded;
}

function reachPenaltyFromMarket({ player, currentPick, needTier = 'low', reachDiscipline = 1, fallbackRank = 999 }) {
  const marketRank = marketRankSignal(player, fallbackRank);
  const gap = marketRank - currentPick; // positive means likely available after current slot
  const earlyPick = currentPick <= 12;
  const threshold = earlyPick ? 2 : 4;
  if (gap <= threshold) return { penalty: 0, marketRank, gap };

  let penalty = Math.min(earlyPick ? 34 : 24, (gap - threshold) * (earlyPick ? 2.05 : 1.35));

  // Preserve need-based flexibility.
  if (needTier === 'high') penalty *= 0.55;
  else if (needTier === 'medium') penalty *= 0.8;

  penalty *= Math.max(0.8, Math.min(1.6, reachDiscipline || 1));
  return { penalty: Math.round(penalty * 100) / 100, marketRank, gap };
}

async function estimateReachDiscipline(profile) {
  const feedback = Array.isArray(profile?.targetFeedback) ? profile.targetFeedback : [];
  const samples = feedback
    .filter(f => f && f.agreed === false && f.recommendedPlayerId && f.preferredPlayerId)
    .slice(-30);

  if (samples.length < 4) return 1;

  const ids = new Set();
  for (const s of samples) {
    ids.add(String(s.recommendedPlayerId));
    ids.add(String(s.preferredPlayerId));
  }

  const idList = [...ids];
  const objectIds = idList.filter(id => /^[a-f\d]{24}$/i.test(id));
  const playerDocs = await Player.find({
    $or: [
      { sleeperId: { $in: idList } },
      ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
    ],
  })
    .select('_id sleeperId underdogAdp fantasyProsRank dasScore')
    .lean();

  const byAnyId = {};
  for (const p of playerDocs) {
    byAnyId[String(p._id)] = p;
    if (p.sleeperId) byAnyId[String(p.sleeperId)] = p;
  }

  let preferenceForMarket = 0;
  let valid = 0;

  for (const s of samples) {
    const rec = byAnyId[String(s.recommendedPlayerId)];
    const pref = byAnyId[String(s.preferredPlayerId)];
    if (!rec || !pref) continue;
    const recRank = marketRankSignal(rec, rec.dasScore ? 200 - (rec.dasScore / 2) : 999);
    const prefRank = marketRankSignal(pref, pref.dasScore ? 200 - (pref.dasScore / 2) : 999);
    valid += 1;
    if (prefRank + 4 < recRank) preferenceForMarket += 1;
  }

  if (!valid) return 1;
  const ratio = preferenceForMarket / valid;
  return 1 + (ratio * 0.5); // 1.0 to 1.5
}

// GET /api/leagues -- all leagues for logged-in user
router.get('/', requireAuth, async (req, res) => {
  try {
    const { sleeperId } = req.user;
    const year = (req.query.year || '').toString().trim();
    const activeOnly = String(req.query.activeOnly || 'true').toLowerCase() !== 'false';
    const includeRostersRequested = String(req.query.includeRosters || 'false').toLowerCase() === 'true';

    // Fetch fresh from Sleeper.
    // If year is not provided, scan recent seasons so users don't see an empty
    // league list simply because the frontend queried an outdated default year.
    let sleeperLeagues = [];
    if (year) {
      sleeperLeagues = await sleeperService.getUserLeagues(sleeperId, 'nfl', year);
    } else {
      const currentYear = new Date().getFullYear();
      const seasons = [currentYear + 1, currentYear, currentYear - 1].map(String);
      const perSeason = await Promise.all(
        seasons.map((season) => sleeperService.getUserLeagues(sleeperId, 'nfl', season).catch(() => []))
      );
      const byId = new Map();
      for (const league of perSeason.flat()) {
        if (league?.league_id && !byId.has(league.league_id)) byId.set(league.league_id, league);
      }
      sleeperLeagues = [...byId.values()];
    }

    if (activeOnly) {
      sleeperLeagues = sleeperLeagues.filter((league) => isActiveLeagueStatus(league?.status));
    }

    // For managers with a smaller number of leagues, return full roster detail
    // automatically so league cards can show complete roster context.
    const includeRosters = includeRostersRequested || sleeperLeagues.length <= 24;
    const existingLeagues = await League.find({ sleeperId: { $in: sleeperLeagues.map((league) => league.league_id).filter(Boolean) } })
      .select('sleeperId devyEnabled idpEnabled')
      .lean();
    const existingLeagueById = Object.fromEntries(existingLeagues.map((league) => [league.sleeperId, league]));

    // Build player map for win window calculations.
    // Primary: our DB (has DAS scores, KTC/FP values, etc.), keyed by sleeperId.
    // Fallback: Sleeper's full player list for any roster player IDs not in our DB.
    const allPlayers = await Player.find({}).lean();
    const playerMap = Object.fromEntries(
      allPlayers.filter(p => p.sleeperId).map(p => [p.sleeperId, p])
    );

    // Augment with Sleeper's own player data so veterans on the roster
    // are recognised even before our scraper / sync has run.
    let sleeperPlayerMap = {};
    try {
      sleeperPlayerMap = await sleeperService.getAllPlayers('nfl');
    } catch (e) {
      console.warn('[Leagues] Could not fetch Sleeper player map:', e.message);
    }
    // For each Sleeper player not already in our map, add a minimal entry
    // so win-window age/position maths work for established veterans.
    for (const [id, sp] of Object.entries(sleeperPlayerMap)) {
      if (!playerMap[id] && sp.position && ['QB', 'RB', 'WR', 'TE'].includes(sp.position)) {
        playerMap[id] = {
          sleeperId: id,
          name: sp.full_name || sp.first_name + ' ' + sp.last_name,
          position: sp.position,
          team: sp.team,
          age: sp.age || null,
          ktcValue: 0,
          fantasyProsValue: 0,
        };
      }
    }

    const leagueData = await mapWithConcurrency(sleeperLeagues, 8, async (sl) => {
      try {
        const existingLeague = existingLeagueById[sl.league_id] || null;
        const devyEnabled = inferDevyEnabled(sl, existingLeague);
        const idpEnabled = inferIdpEnabled(sl.roster_positions, existingLeague);
        const rosters = await sleeperService.getRosters(sl.league_id);
        const users = await sleeperService.buildUserMap(sl.league_id);

        const baseRosters = rosters.map(r => {
          const playerIds = r.players || [];
          const taxiPlayerIds = r.taxi || [];
          const allPlayerIds = [...new Set([...playerIds, ...taxiPlayerIds])];
          const settings = r.settings || {};
          const pointsFor = Number(settings.fpts || 0) + (Number(settings.fpts_decimal || 0) / 100);
          return {
            rosterId: r.roster_id,
            ownerId: r.owner_id,
            ownerUsername: users[r.owner_id]?.username || 'Unknown',
            ownerTeamName: users[r.owner_id]?.teamName || null,
            playerIds,
            taxiPlayerIds,
            allPlayerIds,
            picks: r.picks,
            wins: Number(settings.wins || 0),
            losses: Number(settings.losses || 0),
            ties: Number(settings.ties || 0),
            pointsFor,
          };
        });

        const leagueOutlooks = computeLeagueOutlooks(baseRosters, playerMap, sl.roster_positions, sl.scoring_settings);
        const outlookByRosterId = Object.fromEntries(
          leagueOutlooks.map(o => [o.rosterId, o])
        );

        const processedRosters = baseRosters.map((r) => {
          const outlook = outlookByRosterId[r.rosterId] || {};
          return {
            ...r,
            rosterMaturityScore: outlook.rosterMaturityScore,
            winWindowLabel: outlook.winWindowLabel,
            winWindowReason: outlook.winWindowReason,
            positionalNeeds: outlook.positionalNeeds || analyzePositionalNeeds(r.allPlayerIds, playerMap, sl.roster_positions, sl.scoring_settings),
            standingRank: outlook.outlookMeta?.standingRank || null,
            scoreRank: outlook.outlookMeta?.scoreRank || null,
            outlookMeta: outlook.outlookMeta || null,
          };
        });

        // Cache in DB
        await League.findOneAndUpdate(
          { sleeperId: sl.league_id },
          {
            sleeperId: sl.league_id,
            name: sl.name,
            season: sl.season,
            status: sl.status,
            totalRosters: sl.total_rosters,
            scoringSettings: sl.scoring_settings,
            rosterPositions: sl.roster_positions,
            isSuperFlex: sleeperService.detectSuperFlex(sl.roster_positions),
            isPpr: sleeperService.detectPpr(sl.scoring_settings),
            devyEnabled,
            idpEnabled,
            draftId: sl.draft_id,
            rosters: processedRosters,
            lastUpdated: new Date(),
          },
          { upsert: true, returnDocument: 'after' }
        );

        return {
          leagueId: sl.league_id,
          name: sl.name,
          season: sl.season,
          status: sl.status,
          isSuperFlex: sleeperService.detectSuperFlex(sl.roster_positions),
          isPpr: sleeperService.detectPpr(sl.scoring_settings),
          devyEnabled,
          idpEnabled,
          draftId: sl.draft_id,
          draftStatus: sl.status,
          totalRosters: sl.total_rosters,
          myRoster: processedRosters.find(r => r.ownerId === sleeperId) || null,
          ...(includeRosters ? { rosters: processedRosters } : {}),
        };
      } catch (leagueErr) {
        console.warn(`[Leagues] Skipping league ${sl.league_id}: ${leagueErr.message}`);
        return null;
      }
    });

    // Background trend ingest for drafts that have completed. This keeps ADP
    // expectations updated over time without blocking league list responses.
    const completedDrafts = leagueData
      .filter(Boolean)
      .filter((lg) => lg.draftId)
      .map((lg) => ({ draftId: lg.draftId, leagueId: lg.leagueId, season: lg.season }));
    if (completedDrafts.length > 0) {
      setImmediate(async () => {
        try {
          await mapWithConcurrency(completedDrafts, 3, async (d) => {
            await ingestCompletedDraftTrends({
              leagueId: d.leagueId,
              draftId: d.draftId,
              season: d.season,
              force: false,
            });
          });
        } catch (e) {
          console.warn('[Leagues] Draft trend ingest background run failed:', e.message);
        }
      });
    }

    res.json({ leagues: leagueData.filter(Boolean) });
  } catch (err) {
    console.error('[Leagues]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leagues/:leagueId -- single league detail
router.get('/:leagueId', requireAuth, async (req, res) => {
  try {
    const cached = await League.findOne({ sleeperId: req.params.leagueId }).lean();
    if (!cached) return res.status(404).json({ error: 'League not found' });
    res.json(cached);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leagues/:leagueId/preferences -- persist league-specific devy/idp toggles
router.post('/:leagueId/preferences', requireAuth, async (req, res) => {
  try {
    const { leagueId } = req.params;
    const updates = {};

    if (typeof req.body?.devyEnabled === 'boolean') updates.devyEnabled = req.body.devyEnabled;
    if (typeof req.body?.idpEnabled === 'boolean') updates.idpEnabled = req.body.idpEnabled;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'At least one boolean preference is required' });
    }

    const league = await League.findOne({ sleeperId: leagueId }).lean();
    if (!league) return res.status(404).json({ error: 'League not found' });
    const userIsInLeague = (league.rosters || []).some((roster) => roster.ownerId === req.user.sleeperId);
    if (!userIsInLeague) return res.status(403).json({ error: 'You do not have access to this league' });

    const updated = await League.findOneAndUpdate(
      { sleeperId: leagueId },
      { $set: { ...updates, lastUpdated: new Date() } },
      { returnDocument: 'after' }
    ).lean();

    res.json({
      ok: true,
      leagueId,
      devyEnabled: !!updated?.devyEnabled,
      idpEnabled: !!updated?.idpEnabled,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leagues/:leagueId/adp-trends-sync -- force ADP ingest for completed league draft
router.post('/:leagueId/adp-trends-sync', requireAuth, async (req, res) => {
  try {
    const { leagueId } = req.params;
    const league = await League.findOne({ sleeperId: leagueId }).lean();
    if (!league) return res.status(404).json({ error: 'League not found' });
    const userIsInLeague = (league.rosters || []).some((roster) => roster.ownerId === req.user.sleeperId);
    if (!userIsInLeague) return res.status(403).json({ error: 'You do not have access to this league' });
    if (!league.draftId) return res.status(400).json({ error: 'No draft found for this league' });

    const result = await ingestCompletedDraftTrends({
      leagueId: league.sleeperId,
      draftId: league.draftId,
      season: league.season,
      force: true,
    });

    res.json({
      ok: !!result?.ok,
      leagueId: league.sleeperId,
      draftId: league.draftId,
      result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leagues/:leagueId/alerts -- buy/sell alerts for user's roster in this league
router.get('/:leagueId/alerts', requireAuth, async (req, res) => {
  try {
    const league = await League.findOne({ sleeperId: req.params.leagueId }).lean();
    if (!league) return res.status(404).json({ error: 'League not found' });

    const myRoster = league.rosters.find(r => r.ownerId === req.user.sleeperId);
    if (!myRoster) return res.json({ alerts: [] });

    const allPlayers = await Player.find({}).lean();
    const playerMap = Object.fromEntries(
      allPlayers.filter(p => p.sleeperId).map(p => [p.sleeperId, p])
    );

    const lookback = parseInt(req.query.days) || 30;
    const alerts = await generateBuySellAlerts(myRoster.playerIds, playerMap, lookback);
    res.json({ alerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── helpers ────────────────────────────────────────────────────────────────────
function slimPlayer(p) {
  return {
    _id: p._id,
    sleeperId: p.sleeperId,
    name: p.name,
    position: p.position,
    team: p.team,
    age: p.age,
    dasScore: p.dasScore,
    ktcValue: p.ktcValue,
    fantasyProsRank: p.fantasyProsRank,
    underdogAdp: p.underdogAdp,
    nflDraftRound: p.nflDraftRound,
    nflDraftPick: p.nflDraftPick,
    college: p.college,
  };
}

// GET /api/leagues/:leagueId/draft-targets
// Returns per-pick target recommendations for the user's upcoming picks in this league's draft.
router.get('/:leagueId/draft-targets', requireAuth, async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { sleeperId } = req.user;

    const league = await League.findOne({ sleeperId: leagueId }).lean();
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (!league.draftId) return res.status(404).json({ error: 'No draft found for this league' });
    if ((league.totalRosters || 0) >= 32) {
      return res.json({ leagueId, draftId: league.draftId, noRecommendations: true, picks: [] });
    }

    const [draftData, picks] = await Promise.all([
      sleeperService.getDraft(league.draftId),
      sleeperService.getDraftPicks(league.draftId),
    ]);

    const totalTeams = draftData.settings?.teams || league.totalRosters || 12;
    const rounds = draftData.settings?.rounds || 5;
    const draftType = draftData.type || 'linear';
    const mySlot = draftData.draft_order?.[sleeperId];

    if (!mySlot) return res.status(400).json({ error: 'User not found in draft order' });

    // Calculate all of user's pick numbers
    const myPickNumbers = [];
    for (let round = 1; round <= rounds; round++) {
      let slotInRound;
      if (draftType === 'snake' && round % 2 === 0) {
        slotInRound = totalTeams - mySlot + 1;
      } else {
        slotInRound = mySlot;
      }
      const pickNumber = (round - 1) * totalTeams + slotInRound;
      myPickNumbers.push({ pickNumber, round, slotInRound });
    }

    // Players already drafted in this draft
    const draftedIds = new Set(picks.map(p => p.player_id).filter(Boolean));
    // Players already on any roster in this league (covers carried devy/rookie players)
    const rosteredIds = new Set(
      (league.rosters || []).flatMap(r => [...(r.allPlayerIds || []), ...(r.playerIds || [])])
    );
    const picksMade = picks.length;

    // All players sorted by DAS score — rookie/devy drafts should only show a single class year.
    const isRookieDraft = isRookieDraftContext(draftData, league);
    const draftSeason = isRookieDraft
      ? await resolveDraftClassYear({ requestedYear: req.query.classYear, draftData, league })
      : null;
    const playerFilter = isRookieDraft ? { nflDraftYear: draftSeason } : {};
    const allPlayers = await Player.find(playerFilter).sort({ personalRank: 1, dasScore: -1 }).lean();
    const teamContextPlayers = await Player.find({ position: { $in: ['QB', 'RB', 'WR', 'TE'] } })
      .select('team position ktcValue fantasyProsRank')
      .lean();
    const teamContext = buildTeamContext(teamContextPlayers);

    // Assign an ADP rank to each player (lower = more in-demand)
    const sortedByDemand = allPlayers.slice().sort((a, b) => {
      const aAdp = a.underdogAdp || a.fantasyProsRank || 9999;
      const bAdp = b.underdogAdp || b.fantasyProsRank || 9999;
      return aAdp - bAdp;
    });
    const adpRankMap = new Map(sortedByDemand.map((p, i) => [String(p._id), i + 1]));

    // Positional needs for the user's roster
    const myRoster = league.rosters.find(r => r.ownerId === sleeperId);

    const rosterPoolIds = myRoster?.allPlayerIds || myRoster?.playerIds || [];

    const rosterPlayerDocs = await Player.find({ sleeperId: { $in: rosterPoolIds } })
      .select('sleeperId position age isPassCatcher depthChartPosition ktcValue fantasyProsRank nflDraftRound')
      .lean();
    const rosterPlayerMap = Object.fromEntries(rosterPlayerDocs.map(p => [p.sleeperId, p]));

    let sleeperPlayerMap = {};
    try {
      sleeperPlayerMap = await sleeperService.getAllPlayers('nfl');
    } catch (e) {
      console.warn('[Draft Targets] Sleeper fallback map unavailable:', e.message);
    }
    for (const id of rosterPoolIds) {
      if (rosterPlayerMap[id]) continue;
      const sp = sleeperPlayerMap[id];
      if (!sp || !['QB', 'RB', 'WR', 'TE'].includes(sp.position)) continue;
      rosterPlayerMap[id] = {
        sleeperId: id,
        position: sp.position,
        age: sp.age || null,
      };
    }

    const rosterComposition = buildRosterComposition(
      rosterPoolIds,
      rosterPlayerMap,
      league.rosterPositions || [],
      league.scoringSettings || {}
    );
    const positionalNeeds = analyzePositionalNeeds(
      rosterPoolIds,
      rosterPlayerMap,
      league.rosterPositions || [],
      league.scoringSettings || {}
    );
    const needOrder = { high: 0, medium: 1, low: 2 };

    // Load any existing feedback
    const profile = await ManagerProfile.findOne({ sleeperId }).lean();
    const feedbackMap = {};
    for (const fb of (profile?.targetFeedback || [])) {
      if (fb.leagueId === leagueId) feedbackMap[fb.pickNumber] = fb;
    }
    const reachDiscipline = await estimateReachDiscipline(profile);

    const myPicks = [];
    for (const { pickNumber, round, slotInRound } of myPickNumbers) {
      // Skip picks that have already been made
      if (pickNumber <= picksMade) continue;

      // Players available at this pick: not yet drafted + ADP rank >= pickNumber
      // (i.e., we expect players ranked higher by ADP to be gone)
      const available = allPlayers.filter(p => {
          if (p.sleeperId && (draftedIds.has(p.sleeperId) || rosteredIds.has(p.sleeperId))) return false;
        const adpRank = adpRankMap.get(String(p._id)) || 9999;
        return adpRank >= pickNumber;
      });

      const scored = available.map((p) => {
        const needTier = positionalNeeds[p.position] || 'low';
        const needValue = needOrder[needTier];
        const fallbackRank = adpRankMap.get(String(p._id)) || 999;
        const { penalty, marketRank, gap } = reachPenaltyFromMarket({
          player: p,
          currentPick: pickNumber,
          needTier,
          reachDiscipline,
          fallbackRank,
        });

        const personal = calcPersonalRankScore(p.personalRank);
        const base = personal != null ? (p.dasScore || 0) * 0.4 + personal * 0.6 : (p.dasScore || 0);
        const fit = scoreDraftFit(p, rosterComposition, teamContext);
        const needBonus = needTier === 'high' ? 12 : needTier === 'medium' ? 5 : 0;
        const recScore = base + fit + needBonus - penalty;

        return {
          ...p,
          needTier,
          needValue,
          marketRank,
          marketReachGap: gap,
          reachPenalty: penalty,
          recScore,
          tradeBackCandidate: gap >= 8 && needTier !== 'high',
        };
      });

      // Primary sort: blended score (need bonus included) so severe reaches can still be faded.
      const byTeamNeed = scored.slice().sort((a, b) => {
        return (b.recScore || 0) - (a.recScore || 0);
      });

      // BPA alternatives use same reach-aware score to avoid obvious reaches.
      const byDas = scored.slice().sort((a, b) => (b.recScore || 0) - (a.recScore || 0));

      const recommendation = byTeamNeed[0] || null;
      const recId = recommendation ? String(recommendation._id) : null;
      const alternatives = byDas.filter(p => String(p._id) !== recId).slice(0, 4);
      const strategyHint = recommendation?.tradeBackCandidate
        ? {
            type: 'trade_back_or_pivot',
            message: `${recommendation.name} projects later than pick ${pickNumber}. Trade back or pivot BPA.`,
            marketRank: Math.round(recommendation.marketRank || pickNumber),
            reachGap: Math.round(recommendation.marketReachGap || 0),
          }
        : null;

      myPicks.push({
        pickNumber,
        round,
        pickInRound: slotInRound,
        recommendation: recommendation ? slimPlayer(recommendation) : null,
        alternatives: alternatives.map(slimPlayer),
        strategyHint,
        feedback: feedbackMap[pickNumber] || null,
      });
    }

    res.json({
      leagueId,
      draftId: league.draftId,
      draftStatus: draftData.status,
      myPickSlot: mySlot,
      totalTeams,
      rounds,
      myPicks,
    });
  } catch (err) {
    console.error('[Draft Targets]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leagues/:leagueId/draft-feedback
// Records agree/disagree feedback for a recommended target. Feeds into learning engine.
router.post('/:leagueId/draft-feedback', requireAuth, async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { sleeperId } = req.user;
    const { pickNumber, recommendedPlayerId, agreed, preferredPlayerId } = req.body;

    if (pickNumber == null || agreed == null) {
      return res.status(400).json({ error: 'pickNumber and agreed are required' });
    }

    let profile = await ManagerProfile.findOne({ sleeperId });
    if (!profile) {
      profile = new ManagerProfile({ sleeperId });
    }
    if (!profile.targetFeedback) profile.targetFeedback = [];

    // Upsert feedback entry for this league+pick
    const idx = profile.targetFeedback.findIndex(
      f => f.leagueId === leagueId && f.pickNumber === pickNumber
    );
    const entry = {
      leagueId,
      pickNumber,
      recommendedPlayerId: recommendedPlayerId || null,
      agreed: Boolean(agreed),
      preferredPlayerId: preferredPlayerId || null,
      createdAt: new Date(),
    };
    if (idx >= 0) {
      profile.targetFeedback[idx] = entry;
    } else {
      profile.targetFeedback.push(entry);
    }

    // Learning: nudge position weights when user disagrees and picks a different player
    if (!agreed && preferredPlayerId) {
      const preferredPlayer = await Player.findOne({
        $or: [
          { _id: preferredPlayerId.match(/^[a-f\d]{24}$/i) ? preferredPlayerId : null },
          { sleeperId: preferredPlayerId },
        ],
      }).lean();

      if (preferredPlayer?.position && ['QB', 'RB', 'WR', 'TE'].includes(preferredPlayer.position)) {
        const pos = preferredPlayer.position;
        const weights = { ...profile.positionWeights?.toObject?.() || profile.positionWeights || {} };
        const positions = ['QB', 'RB', 'WR', 'TE'];
        // Nudge +5% toward chosen position, spread the loss across others
        for (const p of positions) {
          const cur = weights[p] ?? 0.25;
          weights[p] = p === pos
            ? Math.min(0.7, cur + 0.05)
            : Math.max(0.05, cur - 0.017);
        }
        profile.set('positionWeights', weights);
      }
    }

    profile.lastUpdated = new Date();
    await profile.save();

    res.json({ ok: true });
  } catch (err) {
    console.error('[Draft Feedback]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leagues/:leagueId/devy-discrepancy
// Lets users report "player already drafted" misses in devy availability.
// Stores report reason in DB, emails maintainer, and feeds report into learning.
router.post('/:leagueId/devy-discrepancy', requireAuth, async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { sleeperId, username } = req.user;
    const {
      playerName,
      playerSleeperId,
      associatedPlayerId,
      associatedPlayerName,
      sourceTab,
      note,
      suspectedMissReason,
    } = req.body || {};

    if (!playerName || !String(playerName).trim()) {
      return res.status(400).json({ error: 'playerName is required' });
    }

    const league = await League.findOne({ sleeperId: leagueId }).lean();
    if (!league) return res.status(404).json({ error: 'League not found' });
    const userIsInLeague = (league.rosters || []).some((roster) => roster.ownerId === sleeperId);
    if (!userIsInLeague) return res.status(403).json({ error: 'You do not have access to this league' });

    const normalizedReason = inferMissReason({
      suspectedMissReason,
      playerSleeperId,
      associatedPlayerId,
      playerName,
    });

    const report = await DevyDiscrepancyReport.create({
      leagueId,
      leagueName: league.name || null,
      reporterSleeperId: sleeperId,
      reporterUsername: username || sleeperId,
      playerName: String(playerName).trim(),
      playerSleeperId: playerSleeperId ? String(playerSleeperId).trim() : null,
      associatedPlayerId: associatedPlayerId ? String(associatedPlayerId).trim() : null,
      associatedPlayerName: associatedPlayerName ? String(associatedPlayerName).trim() : null,
      sourceTab: ['available', 'rostered', 'graduated', 'unknown', 'compare', 'other'].includes(sourceTab)
        ? sourceTab
        : 'available',
      note: note ? String(note).trim().slice(0, 800) : null,
      suspectedMissReason: normalizedReason,
    });

    let learning = { learned: false, reason: 'learning_failed' };
    try {
      learning = await ingestDevyDiscrepancyReport({
        sleeperId,
        username,
        reportId: report._id,
        leagueId,
        playerName: report.playerName,
        playerSleeperId: report.playerSleeperId,
        sourceTab: report.sourceTab,
        suspectedMissReason: report.suspectedMissReason,
        note: report.note,
      });
    } catch (learningErr) {
      console.warn('[Devy Discrepancy] Learning update failed:', learningErr.message);
    }

    let emailResult = { sent: false, error: 'email_failed' };
    try {
      emailResult = await sendDiscrepancyEmailWithTimeout({ report, leagueName: league.name, timeoutMs: 12000 });
    } catch (emailErr) {
      emailResult = { sent: false, error: emailErr.message || 'email_send_failed' };
      console.warn('[Devy Discrepancy] Email send failed:', emailErr.message);
    }

    if (emailResult?.sent) {
      console.info('[Devy Discrepancy] Email notification sent', {
        reportId: String(report._id),
        leagueId,
        playerName: report.playerName,
        durationMs: emailResult?.durationMs || null,
      });
    } else {
      console.warn('[Devy Discrepancy] Email notification not sent', {
        reportId: String(report._id),
        leagueId,
        playerName: report.playerName,
        reason: emailResult?.error || 'email_send_failed',
        durationMs: emailResult?.durationMs || null,
      });
    }

    await DevyDiscrepancyReport.updateOne(
      { _id: report._id },
      {
        $set: {
          learningApplied: !!learning?.learned,
          learningNote: learning?.learned
            ? `learning_reason=${learning.reason}; reason_count=${learning.count}`
            : `learning_skipped=${learning?.reason || 'unknown'}`,
          emailSent: !!emailResult?.sent,
          emailError: emailResult?.sent ? null : (emailResult?.error || 'email_send_failed'),
        },
      }
    );

    res.json({
      ok: true,
      reportId: String(report._id),
      suspectedMissReason: normalizedReason,
      learningApplied: !!learning?.learned,
      emailSent: !!emailResult?.sent,
      emailStatus: emailResult?.sent ? 'sent' : (emailResult?.error || 'failed'),
    });
  } catch (err) {
    console.error('[Devy Discrepancy]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leagues/:leagueId/draft-grade
// Returns completed-draft letter grades relative to league median (C = median).
router.get('/:leagueId/draft-grade', requireAuth, async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { sleeperId } = req.user;

    const league = await League.findOne({ sleeperId: leagueId }).lean();
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (!league.draftId) return res.json({ complete: false, draftStatus: 'pre_draft' });

    const [draftData, picks] = await Promise.all([
      sleeperService.getDraft(league.draftId),
      sleeperService.getDraftPicks(league.draftId),
    ]);

    const draftStatus = String(draftData?.status || 'unknown').toLowerCase();
    if (draftStatus !== 'complete' && draftStatus !== 'completed') {
      return res.json({ complete: false, draftStatus });
    }

    let userMap = {};
    let liveRosters = [];
    try {
      [liveRosters, userMap] = await Promise.all([
        sleeperService.getRosters(leagueId),
        sleeperService.buildUserMap(leagueId),
      ]);
    } catch (e) {
      console.warn('[Draft Grade] Roster/user lookup failed:', e.message);
    }

    const gradingRosters = liveRosters.length
      ? liveRosters
      : (league.rosters || []).map((r) => ({ roster_id: r.rosterId, owner_id: r.ownerId }));

    const pickedPlayerIds = [...new Set((picks || []).map((p) => p.player_id).filter(Boolean))];
    const pickedPlayers = pickedPlayerIds.length
      ? await Player.find({ sleeperId: { $in: pickedPlayerIds } })
        .select('sleeperId sleeperObservedAdp sleeperRookieObservedAdp expectedAdp underdogAdp fantasyProsRank')
        .lean()
      : [];
    const playerBySleeperId = Object.fromEntries(pickedPlayers.map((p) => [String(p.sleeperId), p]));

    const graded = computeDraftGradesForLeague({ draftData, picks, rosters: gradingRosters, userMap, playerBySleeperId });
    const myGrade = graded.find((m) => m.ownerId === sleeperId) || null;

    // Count how many saved targets the user actually landed
    const ownerByRosterId = Object.fromEntries(gradingRosters.map((r) => [String(r.roster_id), r.owner_id]));
    const myPickedIds = new Set(
      (picks || [])
        .filter((p) => (p.picked_by || ownerByRosterId[String(p.roster_id || '')]) === sleeperId)
        .map((p) => String(p.player_id || '')).filter(Boolean)
    );

    const profile = await ManagerProfile.findOne({ sleeperId }).lean();
    const myFeedback = (profile?.targetFeedback || []).filter((f) => f?.leagueId === leagueId);
    let targetsTotal = 0;
    let targetsHit = 0;
    for (const fb of myFeedback) {
      const targetId = fb.agreed ? String(fb.recommendedPlayerId || '') : String(fb.preferredPlayerId || '');
      if (!targetId) continue;
      targetsTotal += 1;
      if (myPickedIds.has(targetId)) targetsHit += 1;
    }

    return res.json({ complete: true, draftStatus, myGrade, totalManagers: graded.length, leagueGrades: graded, targetsHit, targetsTotal });
  } catch (err) {
    console.error('[Draft Grade]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leagues/:leagueId/devy-pool
// Returns the available devy prospect pool and per-manager rostered devy players.
// Only meaningful for devy leagues (name contains "devy" or has devy roster slots).
router.get('/:leagueId/devy-pool', requireAuth, async (req, res) => {
  try {
    const { leagueId } = req.params;
    const league = await League.findOne({ sleeperId: leagueId }).lean();
    if (!league) return res.status(404).json({ error: 'League not found' });
    const devyEnabled = inferDevyEnabled(league, league);
    const idpEnabled = inferIdpEnabled(league.rosterPositions, league);
    const positionFilters = getLeaguePositionFilters({ devyEnabled, idpEnabled });
    const positionAllowed = (position) => allowsDevyPoolPosition(position, { devyEnabled, idpEnabled });

    // Fetch Sleeper data in parallel to minimize response latency. League users
    // and rosters are now short-TTL cached in sleeperService to reduce load.
    let sleeperPlayerMap = {};
    let userMetaById = {};
    let ownerUsernameById = {};
    let ownerTeamNameById = {};
    let sleeperRosterMetaByOwnerId = {};
    let liveRosters = [];
    const [playersRes, usersRes, rostersRes] = await Promise.allSettled([
      sleeperService.getAllPlayers('nfl'),
      sleeperService.getLeagueUsers(leagueId),
      sleeperService.getRosters(leagueId),
    ]);

    if (playersRes.status === 'fulfilled') {
      sleeperPlayerMap = playersRes.value || {};
    } else {
      console.warn('[DevyPool] Sleeper player map unavailable:', playersRes.reason?.message || playersRes.reason);
    }

    if (usersRes.status === 'fulfilled') {
      const users = usersRes.value || [];
      userMetaById = Object.fromEntries(users.map(u => [u.user_id, u.metadata || {}]));
      ownerUsernameById = Object.fromEntries(
        users.map((u) => [u.user_id, u.display_name || u.username || u.user_id])
      );
      ownerTeamNameById = Object.fromEntries(
        users.map((u) => [u.user_id, u.metadata?.team_name || null])
      );
    } else {
      console.warn('[DevyPool] League user metadata unavailable:', usersRes.reason?.message || usersRes.reason);
    }

    if (rostersRes.status === 'fulfilled') {
      liveRosters = rostersRes.value || [];
      for (const r of liveRosters) {
        if (r.owner_id && r.metadata) {
          sleeperRosterMetaByOwnerId[r.owner_id] = r.metadata;
        }
      }
    } else {
      console.warn('[DevyPool] Live roster metadata unavailable:', rostersRes.reason?.message || rostersRes.reason);
    }

    // Exclude players picked in the league draft — covers both in-progress and recently
    // completed drafts (Sleeper roster sync lags behind pick data after completion).
    const draftedPlayerIds = new Set();
    const draftedPlayerNames = new Set();
    if (league.draftId) {
      try {
        const draftPicks = await sleeperService.getDraftPicks(league.draftId);
        for (const pick of (draftPicks || [])) {
          const playerId = String(pick?.player_id || '').trim();
          if (playerId) draftedPlayerIds.add(playerId);

          const sp = playerId ? sleeperPlayerMap[playerId] : null;
          const sleeperName = sp
            ? (sp.full_name || `${sp.first_name || ''} ${sp.last_name || ''}`.trim())
            : '';
          const metaName = [pick?.metadata?.first_name, pick?.metadata?.last_name]
            .filter(Boolean)
            .join(' ')
            .trim();
          const pickName = sleeperName || metaName || String(pick?.metadata?.player || '').trim();
          const normalizedPickName = normalizeName(pickName);
          if (normalizedPickName) draftedPlayerNames.add(normalizedPickName);
        }
      } catch (e) {
        console.warn('[DevyPool] Draft picks unavailable:', e.message);
      }
    }

    // Also exclude players manually reported as already drafted in this league.
    try {
      const openReports = await DevyDiscrepancyReport.find({
        leagueId,
        status: 'open',
      })
        .select('playerName playerSleeperId')
        .lean();

      for (const report of (openReports || [])) {
        const reportId = String(report?.playerSleeperId || '').trim();
        if (reportId) draftedPlayerIds.add(reportId);

        const reportName = normalizeName(report?.playerName || '');
        if (reportName) draftedPlayerNames.add(reportName);
      }
    } catch (e) {
      console.warn('[DevyPool] Discrepancy report exclusions unavailable:', e.message);
    }

    // Fallback exclusion from persisted ownership snapshots for this league.
    // This prevents known drafted devy players from reappearing when live note
    // metadata parsing misses a run.
    try {
      const snapshotRows = await DevyOwnershipSnapshot.find({ sourceLeagueId: leagueId })
        .select('devyName devySleeperId normalizedDevyName')
        .lean();

      for (const row of (snapshotRows || [])) {
        const snapshotSleeperId = String(row?.devySleeperId || '').trim();
        if (snapshotSleeperId) draftedPlayerIds.add(snapshotSleeperId);

        const normalizedSnapshotName = normalizeName(row?.devyName || row?.normalizedDevyName || '');
        if (normalizedSnapshotName) draftedPlayerNames.add(normalizedSnapshotName);
      }
    } catch (e) {
      console.warn('[DevyPool] Snapshot exclusion fallback unavailable:', e.message);
    }

    const aliasByPlayerId = new Map(); // playerId -> [alias1, alias2, ...]
    const pushAliasesFromMeta = (metadata) => {
      const maps = getAliasMapsFromMetadata(metadata || {});
      for (const map of maps) {
        for (const [playerId, raw] of Object.entries(map)) {
          const alias = String(raw || '').trim();
          if (!playerId || !alias) continue;
          if (!aliasByPlayerId.has(playerId)) aliasByPlayerId.set(playerId, []);
          // Avoid exact duplicates
          if (!aliasByPlayerId.get(playerId).includes(alias)) {
            aliasByPlayerId.get(playerId).push(alias);
          }
        }
      }
    };
    for (const metadata of Object.values(userMetaById)) pushAliasesFromMeta(metadata);
    for (const metadata of Object.values(sleeperRosterMetaByOwnerId)) pushAliasesFromMeta(metadata);

    const dbRosterByOwner = new Map();
    for (const roster of (league.rosters || [])) {
      if (!roster?.ownerId) continue;
      dbRosterByOwner.set(roster.ownerId, {
        ownerId: roster.ownerId,
        ownerUsername: roster.ownerUsername || ownerUsernameById[roster.ownerId] || roster.ownerId,
        ownerTeamName: roster.ownerTeamName || ownerTeamNameById[roster.ownerId] || null,
        playerIds: roster.playerIds || [],
        taxiPlayerIds: roster.taxiPlayerIds || [],
      });
    }

    // Overlay DB rosters with live Sleeper roster player/taxi lists so the devy
    // pool reflects in-progress draft picks immediately.
    if (liveRosters.length > 0) {
      for (const r of liveRosters) {
        const ownerId = r?.owner_id ? String(r.owner_id) : null;
        if (!ownerId) continue;
        const existing = dbRosterByOwner.get(ownerId) || {
          ownerId,
          ownerUsername: ownerUsernameById[ownerId] || ownerId,
          ownerTeamName: ownerTeamNameById[ownerId] || null,
          playerIds: [],
          taxiPlayerIds: [],
        };
        dbRosterByOwner.set(ownerId, {
          ...existing,
          ownerId,
          ownerUsername: existing.ownerUsername || ownerUsernameById[ownerId] || ownerId,
          ownerTeamName: existing.ownerTeamName || ownerTeamNameById[ownerId] || null,
          playerIds: Array.isArray(r.players) ? r.players : existing.playerIds,
          taxiPlayerIds: Array.isArray(r.taxi) ? r.taxi : existing.taxiPlayerIds,
        });
      }
    }

    const effectiveRosters = [...dbRosterByOwner.values()];

    // Collect every player ID across all rosters (active + taxi).
    // Also parse commissioner-managed player notes to discover attached devy prospects
    // stored as aliases (often inside parentheses).
    const allRosterIds = new Set();
    const idToRoster = {};  // sleeperId -> { ownerId, username, onTaxi }
    const noteDerivedDevyEntries = [];
    const seenNoteDerived = new Set();
    for (const roster of effectiveRosters) {
      const active = roster.playerIds || [];
      const taxi = roster.taxiPlayerIds || [];
      // Merge user metadata with live roster metadata for this owner
      const ownerMeta = { ...(userMetaById[roster.ownerId] || {}), ...(sleeperRosterMetaByOwnerId[roster.ownerId] || {}) };
      const pushRosterId = (id, onTaxi) => {
        allRosterIds.add(id);
        const sp = sleeperPlayerMap[id] || {};
        const ownerAlias = getPlayerAliasFromMetadata(ownerMeta, id);
        const globalAliases = aliasByPlayerId.get(id) || [];
        const combinedAliases = [ownerAlias, ...globalAliases]
          .map((v) => String(v || '').trim())
          .filter(Boolean);
        const rawAlias = pickBestAlias(combinedAliases, { preferDetailed: isLikelyPlaceholderPlayer(sp) });

        const aliasCandidates = [];
        const seenAliasCandidate = new Set();
        for (const aliasText of combinedAliases) {
          for (const candidate of extractDevyCandidatesFromAlias(aliasText)) {
            const key = normalizeName(candidate.name);
            if (!key || seenAliasCandidate.has(key)) continue;
            seenAliasCandidate.add(key);
            aliasCandidates.push(candidate);
          }
        }
        const primaryAlias = aliasCandidates[0]?.name || rawAlias || null;

        const primaryPositionHint = aliasCandidates[0]?.positionHint || null;

        if (!idToRoster[id]) {
          idToRoster[id] = {
            ownerId: roster.ownerId,
            username: roster.ownerUsername,
            ownerTeamName: roster.ownerTeamName || null,
            onTaxi: !!onTaxi,
            devyAlias: primaryAlias || null,
            devyPositionHint: primaryPositionHint,
          };
        } else {
          if (!idToRoster[id].devyAlias && primaryAlias) idToRoster[id].devyAlias = primaryAlias;
          if (!idToRoster[id].devyPositionHint && primaryPositionHint) idToRoster[id].devyPositionHint = primaryPositionHint;
          if (!idToRoster[id].ownerTeamName && roster.ownerTeamName) idToRoster[id].ownerTeamName = roster.ownerTeamName;
        }

        const associatedPlayer = sp;
        const associatedPlayerName = associatedPlayer.full_name
          || `${associatedPlayer.first_name || ''} ${associatedPlayer.last_name || ''}`.trim()
          || id;

        for (const candidate of aliasCandidates) {
          const key = `${roster.ownerId}:${id}:${normalizeName(candidate.name)}`;
          if (seenNoteDerived.has(key)) continue;
          seenNoteDerived.add(key);
          noteDerivedDevyEntries.push({
            associatedPlayerId: id,
            associatedPlayerName,
            ownerId: roster.ownerId,
            ownerUsername: roster.ownerUsername,
            ownerTeamName: roster.ownerTeamName || null,
            onTaxi: !!onTaxi,
            candidateName: candidate.name,
            positionHint: candidate.positionHint || null,
            rawAlias: rawAlias || null,
          });
        }
      };

      for (const id of active) {
        pushRosterId(id, false);
      }
      for (const id of taxi) {
        pushRosterId(id, true);
      }
    }

    // Identify which roster IDs are devy players (years_exp === -1 in Sleeper)
    // Also track players who were devy but just got drafted to an NFL team ("graduated")
    const devyRosteredIds = new Set();
    const graduatedIds = new Set();  // had/have NFL team — recently drafted from devy pool

    for (const id of allRosterIds) {
      const sp = sleeperPlayerMap[id];
      const owner = idToRoster[id] || {};
      const yearsExp = parseYearsExp(sp || {});
      const officialName = sp
        ? (sp.full_name || `${sp.first_name || ''} ${sp.last_name || ''}`.trim())
        : '';
      const alias = owner.devyAlias ? String(owner.devyAlias).trim() : null;
      const hasDistinctAlias = !!(alias && (!officialName || alias.toLowerCase() !== officialName.toLowerCase()));

      if (isSleeperDevyPlayer(sp) || hasDistinctAlias) {
        devyRosteredIds.add(id);
      } else if (yearsExp === 0 && sp && sp.team) {
        // years_exp: 0 + has a team = just drafted into NFL this year
        graduatedIds.add(id);
      }
    }
    // Load devy players from our DB
    const devyDbPlayers = await Player.find({ isDevy: true })
      .select('sleeperId name position college devyClass devyKtcValue devyKtcRank ktcValue fantasyProsValue fantasyProsRank underdogAdp dasScore age nflDraftYear sheetRank sheetRating sheetAvgOvrRank')
      .lean();

    const devyBySleeperID = Object.fromEntries(devyDbPlayers.map(p => [p.sleeperId, p]));
    const devyById = new Map(devyDbPlayers.map((p) => [String(p._id), p]));
    const devyByNormalizedName = new Map();
    const devyByComparableName = new Map();
    for (const player of devyDbPlayers) {
      const key = normalizeName(player.name);
      if (!key) continue;
      if (!devyByNormalizedName.has(key)) devyByNormalizedName.set(key, []);
      devyByNormalizedName.get(key).push(player);

      const comparableKey = normalizeComparableName(player.name);
      if (comparableKey) {
        if (!devyByComparableName.has(comparableKey)) devyByComparableName.set(comparableKey, []);
        devyByComparableName.get(comparableKey).push(player);
      }
    }

    const noteCandidateNames = [...new Set(
      noteDerivedDevyEntries
        .map((entry) => normalizeName(entry.candidateName))
        .filter(Boolean)
    )];
    const recentSnapshotCutoff = new Date(Date.now() - (180 * 24 * 60 * 60 * 1000));
    let cachedSnapshotByName = new Map();
    if (noteCandidateNames.length > 0) {
      try {
        const cachedSnapshots = await DevyOwnershipSnapshot.find({
          normalizedDevyName: { $in: noteCandidateNames },
          lastSeenAt: { $gte: recentSnapshotCutoff },
        })
          .sort({ lastSeenAt: -1 })
          .lean();
        cachedSnapshotByName = new Map();
        for (const snap of cachedSnapshots) {
          if (!cachedSnapshotByName.has(snap.normalizedDevyName)) {
            cachedSnapshotByName.set(snap.normalizedDevyName, snap);
          }
        }
      } catch (e) {
        console.warn('[DevyPool] Snapshot cache read unavailable:', e.message);
      }
    }

    const resolveDevyByName = (candidateName) => {
      const candidateNorm = normalizeName(candidateName);
      if (!candidateNorm) return null;

      const cached = cachedSnapshotByName.get(candidateNorm);
      if (cached?.devyPlayerId && devyById.has(String(cached.devyPlayerId))) {
        return devyById.get(String(cached.devyPlayerId));
      }
      if (cached?.devySleeperId && devyBySleeperID[cached.devySleeperId]) {
        return devyBySleeperID[cached.devySleeperId];
      }
      if (cached?.devyName) {
        const cachedNorm = normalizeName(cached.devyName);
        const cachedExact = devyByNormalizedName.get(cachedNorm);
        if (cachedExact && cachedExact.length) return cachedExact[0];
      }

      const exact = devyByNormalizedName.get(candidateNorm);
      if (exact && exact.length) return exact[0];

      const comparableNorm = normalizeComparableName(candidateName);
      const comparableExact = devyByComparableName.get(comparableNorm);
      if (comparableExact && comparableExact.length) return comparableExact[0];

      let best = null;
      let bestLen = 0;
      for (const [nameNorm, players] of devyByNormalizedName.entries()) {
        const contains = candidateNorm.startsWith(`${nameNorm} `)
          || candidateNorm.includes(` ${nameNorm} `)
          || nameNorm.startsWith(`${candidateNorm} `);
        if (!contains) continue;
        if (nameNorm.length > bestLen) {
          best = players[0];
          bestLen = nameNorm.length;
        }
      }

      if (best) return best;

      // Final fallback: fuzzy comparable matching for nickname/suffix/typo cases.
      // Examples: Nate Fraizer -> Nathan Frazier, Bryant Wesco Clemson -> Bryant Wesco Jr.
      let bestFuzzy = null;
      let bestScore = 0;
      for (const player of devyDbPlayers) {
        const score = scoreComparableNameMatch(candidateName, player.name);
        if (score > bestScore) {
          bestFuzzy = player;
          bestScore = score;
        }
      }

      return bestScore >= 70 ? bestFuzzy : null;
    };

    // Name-based roster map helps when local DB sleeperIds are stale/incorrect.
    const rosteredNames = new Set(
      [...allRosterIds]
        .map((id) => {
          const sp = sleeperPlayerMap[id];
          const fullName = sp
            ? (sp.full_name || `${sp.first_name || ''} ${sp.last_name || ''}`.trim())
            : '';
          return normalizeName(fullName);
        })
        .filter(Boolean)
    );

    // Build rostered devy list: DB record + owner info + Sleeper data
    const rosterList = [];
    for (const id of devyRosteredIds) {
      const sp = sleeperPlayerMap[id] || {};
      // For alias-based entries (placeholder players), try to resolve the devy DB
      // record by the alias name rather than by the placeholder's sleeperId.
      const owner = idToRoster[id] || {};
      const officialName = sp.full_name || `${sp.first_name || ''} ${sp.last_name || ''}`.trim() || id;
      const alias = owner.devyAlias ? String(owner.devyAlias).trim() : null;
      const isAliasName = !!(alias && alias.toLowerCase() !== officialName.toLowerCase());
      const name = isAliasName ? alias : officialName;

      // When alias-based, look up the devy DB by alias name for correct stats/position.
      // Fall back to the placeholder's DB entry only for genuine devy roster IDs.
      const dbById = devyBySleeperID[id];
      const dbByAlias = isAliasName ? resolveDevyByName(alias) : null;
      const db = dbByAlias || dbById;

      // Determine position: prefer resolved devy record, then stored hint, then
      // the placeholder's own position only when it is an allowed devy position.
      const spPosition = String(sp.position || '').toUpperCase();
      const placeholderPosAllowed = positionAllowed(spPosition);
      const position = db?.position
        || (owner.devyPositionHint && positionAllowed(owner.devyPositionHint) ? owner.devyPositionHint : null)
        || (placeholderPosAllowed ? spPosition : null)
        || '?';

      // Skip only when there is genuinely no positional information and the
      // placeholder position is not an allowed devy position.
      if (!positionAllowed(position)) continue;

      const college = db?.college || sp.college || null;

      rosterList.push({
        sleeperId: isAliasName ? (db?.sleeperId || null) : id,
        devyPlayerId: db?._id || null,
        name,
        associatedPlayerId: id,
        associatedPlayerName: isAliasName ? officialName : null,
        fromPlayerNote: isAliasName,
        position,
        college,
        devyClass: db?.devyClass || null,
        devyKtcValue: db?.devyKtcValue || 0,
        devyKtcRank: db?.devyKtcRank || null,
        ktcValue: db?.ktcValue || 0,
        fantasyProsValue: db?.fantasyProsValue || 0,
        fantasyProsRank: db?.fantasyProsRank || null,
        dasScore: db?.dasScore || null,
        sheetRank: db?.sheetRank || null,
        sheetRating: db?.sheetRating || null,
        sheetAvgOvrRank: db?.sheetAvgOvrRank || null,
        sheetVsKtcDelta: (db?.sheetRank && db?.devyKtcRank) ? (db.devyKtcRank - db.sheetRank) : null,
        ownerId: owner.ownerId || null,
        ownerUsername: owner.username || null,
        ownerTeamName: owner.ownerTeamName || null,
        onTaxi: !!owner.onTaxi,
        inOurDb: !!db,
      });
    }

    const existingRosteredKeys = new Set(
      rosterList.map((row) => buildDevyRosterDedupKey({
        ownerId: row.ownerId,
        associatedPlayerId: row.associatedPlayerId,
        devyPlayerId: row.devyPlayerId,
        sleeperId: row.sleeperId,
        name: row.name,
      }))
    );
    const rosteredDevyNames = new Set(
      rosterList.map((row) => normalizeName(row.name)).filter(Boolean)
    );
    // Track resolved DB identities so available pool can exclude by ID even when
    // the candidate name and DB name differ (e.g. "Nathan Fraizer" vs "Nate Frazier").
    const rosteredDevyDbIds = new Set(
      rosterList.map((row) => row.devyPlayerId ? String(row.devyPlayerId) : null).filter(Boolean)
    );
    const rosteredDevySleeperIds = new Set(
      rosterList.map((row) => row.sleeperId || null).filter(Boolean)
    );
    // Also track raw note candidate names for a second-pass fuzzy check.
    const rosteredCandidateNames = new Set(
      rosterList.map((row) => normalizeName(row.name)).filter(Boolean)
    );

    for (const noteEntry of noteDerivedDevyEntries) {
      const matchedDb = resolveDevyByName(noteEntry.candidateName);
      const candidateNorm = normalizeName(noteEntry.candidateName);
      const cached = cachedSnapshotByName.get(candidateNorm);
      // Ignore generic notes/slogans unless they map to a known devy player
      // or provide a usable position hint.
      if (!matchedDb && !cached && !noteEntry.positionHint) continue;
      const matchedSleeper = matchedDb?.sleeperId ? (sleeperPlayerMap[matchedDb.sleeperId] || {}) : {};
      const resolvedName = matchedDb?.name || cached?.devyName || noteEntry.candidateName;
      const position = matchedDb?.position || cached?.position || matchedSleeper.position || noteEntry.positionHint || '?';
      if (position !== '?' && !positionAllowed(position)) continue;

      const dedupeKey = buildDevyRosterDedupKey({
        ownerId: noteEntry.ownerId,
        associatedPlayerId: noteEntry.associatedPlayerId,
        devyPlayerId: matchedDb?._id || cached?.devyPlayerId || null,
        sleeperId: matchedDb?.sleeperId || cached?.devySleeperId || null,
        name: resolvedName,
      });
      if (existingRosteredKeys.has(dedupeKey)) continue;
      existingRosteredKeys.add(dedupeKey);
      rosteredDevyNames.add(normalizeName(resolvedName));
      // Always add the candidate name too — so if resolvedName differs from the DB
      // record name (e.g. alias "Nathan Fraizer" vs DB "Nate Frazier") the candidate
      // itself is also in the exclusion set for the available pool reverse-fuzzy check.
      rosteredCandidateNames.add(normalizeName(noteEntry.candidateName));
      if (matchedDb) {
        if (matchedDb._id) rosteredDevyDbIds.add(String(matchedDb._id));
        if (matchedDb.sleeperId) rosteredDevySleeperIds.add(matchedDb.sleeperId);
      }

      rosterList.push({
        sleeperId: matchedDb?.sleeperId || cached?.devySleeperId || null,
        devyPlayerId: matchedDb?._id || (cached?.devyPlayerId || null),
        name: resolvedName,
        associatedPlayerId: noteEntry.associatedPlayerId,
        associatedPlayerName: noteEntry.associatedPlayerName,
        fromPlayerNote: true,
        position,
        college: matchedDb?.college || cached?.college || matchedSleeper.college || null,
        devyClass: matchedDb?.devyClass || cached?.devyClass || null,
        devyKtcValue: matchedDb?.devyKtcValue || 0,
        devyKtcRank: matchedDb?.devyKtcRank || null,
        ktcValue: matchedDb?.ktcValue || 0,
        fantasyProsValue: matchedDb?.fantasyProsValue || 0,
        fantasyProsRank: matchedDb?.fantasyProsRank || null,
        dasScore: matchedDb?.dasScore || null,
        sheetRank: matchedDb?.sheetRank || null,
        sheetRating: matchedDb?.sheetRating || null,
        sheetAvgOvrRank: matchedDb?.sheetAvgOvrRank || null,
        sheetVsKtcDelta: (matchedDb?.sheetRank && matchedDb?.devyKtcRank) ? (matchedDb.devyKtcRank - matchedDb.sheetRank) : null,
        ownerId: noteEntry.ownerId || null,
        ownerUsername: noteEntry.ownerUsername || null,
        ownerTeamName: noteEntry.ownerTeamName || null,
        rawAlias: noteEntry.rawAlias || null,
        onTaxi: !!noteEntry.onTaxi,
        inOurDb: !!matchedDb,
      });
    }

    const rosterBestByKey = new Map();
    const rosterPriority = (row) => {
      let score = 0;
      if (row.inOurDb) score += 8;
      if (row.devyPlayerId) score += 5;
      if (row.sleeperId) score += 3;
      if (!row.fromPlayerNote) score += 2;
      if (Number.isFinite(row.devyKtcRank)) score += 1;
      return score;
    };

    for (const row of rosterList) {
      const canonicalId = row.devyPlayerId || row.sleeperId || normalizeName(row.name || '');
      const dedupeKey = `${row.ownerId || 'na'}:${canonicalId || row.associatedPlayerId || 'unknown'}`;
      const existing = rosterBestByKey.get(dedupeKey);
      if (!existing || rosterPriority(row) > rosterPriority(existing)) {
        rosterBestByKey.set(dedupeKey, row);
      }
    }

    const dedupedRosterList = [...rosterBestByKey.values()];

    // Build graduated list — devy players who are now on NFL rosters
    const graduatedList = [];
    for (const id of graduatedIds) {
      const sp = sleeperPlayerMap[id] || {};
      const name = sp.full_name || `${sp.first_name || ''} ${sp.last_name || ''}`.trim() || id;
      const owner = idToRoster[id];
      if (!positionAllowed(sp.position || '?')) continue;
      graduatedList.push({
        sleeperId: id,
        name,
        position: sp.position || '?',
        team: sp.team || null,  // now has an NFL team
        college: sp.college || null,
        ownerId: owner?.ownerId,
        ownerUsername: owner?.username,
        onTaxi: owner?.onTaxi,
      });
    }

    // Build available pool: all devy players in our DB NOT on any roster in this league
    const currentYear = new Date().getFullYear();
    const availableCandidates = devyDbPlayers
      .filter(p => {
        // Exclude players already picked in the current draft (live or complete),
        // including stale-id and name-variant fallback matching.
        if (shouldExcludeAvailableByDrafted({
          playerName: p.name,
          playerSleeperId: p.sleeperId,
          draftedPlayerIds,
          draftedPlayerNames,
        })) return false;
        // Exclude any player already rostered/taxi in this league.
        if (p.sleeperId && allRosterIds.has(p.sleeperId)) return false;
        // Exclude players currently rostered in this league (by sleeperId or name).
        if (p.sleeperId && devyRosteredIds.has(p.sleeperId)) return false;
        // Exclude by resolved DB identity (covers note-alias mismatches like "Nathan Fraizer" -> "Nate Frazier").
        if (p._id && rosteredDevyDbIds.has(String(p._id))) return false;
        if (p.sleeperId && rosteredDevySleeperIds.has(p.sleeperId)) return false;
        // Name-based exclusions.
        const pNorm = normalizeName(p.name);
        if (rosteredNames.has(pNorm)) return false;
        if (rosteredDevyNames.has(pNorm)) return false;
        if (draftedPlayerNames.has(pNorm)) return false;

        // Reverse fuzzy: if any rostered candidate name resolves back to this player, exclude.
        for (const candidateNorm of rosteredCandidateNames) {
          if (candidateNorm === pNorm) continue; // already caught above
          const score = scoreComparableNameMatch(candidateNorm, p.name);
          if (score >= 70) return false;
        }

        // If the player already has an NFL draft year at or before current year,
        // they have graduated from devy availability.
        if (Number.isFinite(Number(p.nflDraftYear)) && Number(p.nflDraftYear) <= currentYear) return false;
        return true;
      })
      .map(p => {
        const sp = p.sleeperId ? (sleeperPlayerMap[p.sleeperId] || {}) : {};
        const hasSleeperRecord = p.sleeperId && Object.keys(sp).length > 0;

        // For Sleeper-sourced records: validate they're still devy-eligible.
        // For scraper-sourced records (no sleeperId): trust the source data.
        if (hasSleeperRecord && !isSleeperDevyPlayer(sp)) return null;

        // Skip if Sleeper says this player now has an NFL team (graduated)
        if (hasSleeperRecord && sp.team) return null;

        if (!positionAllowed(p.position)) return null;

        return {
          sleeperId: p.sleeperId || null,
          name: p.name,
          position: p.position,
          college: p.college || sp.college || null,
          devyClass: p.devyClass || null,
          devyKtcValue: p.devyKtcValue || 0,
          devyKtcRank: p.devyKtcRank || null,
          ktcValue: p.ktcValue || 0,
          fantasyProsValue: p.fantasyProsValue || 0,
          fantasyProsRank: p.fantasyProsRank || null,
          dasScore: p.dasScore || null,
          sheetRank: p.sheetRank || null,
          sheetRating: p.sheetRating || null,
          sheetAvgOvrRank: p.sheetAvgOvrRank || null,
          sheetVsKtcDelta: (p.sheetRank && p.devyKtcRank) ? (p.devyKtcRank - p.sheetRank) : null,
          fpEquivalent: fpEquivalentValue(p, true),
        };
      })
      .filter(Boolean)
      ;

    const availableBestByKey = new Map();
    const availablePriority = (row) => {
      const sheetBonus = Number.isFinite(row.sheetRank) ? Math.max(0, 5000 - row.sheetRank) : 0;
      const ktcBonus = Number.isFinite(row.devyKtcRank) ? Math.max(0, 3000 - row.devyKtcRank) : 0;
      const valueBonus = Number(row.devyKtcValue || row.ktcValue || 0) / 10;
      return sheetBonus + ktcBonus + valueBonus;
    };

    for (const row of availableCandidates) {
      const canonicalName = normalizeComparableName(row.name || '');
      const dedupeKey = row.sleeperId || `${canonicalName}|${row.position || '?'}`;
      const existing = availableBestByKey.get(dedupeKey);
      if (!existing || availablePriority(row) > availablePriority(existing)) {
        availableBestByKey.set(dedupeKey, row);
      }
    }

    const availablePool = [...availableBestByKey.values()]
      .sort((a, b) => {
        const aSheet = Number.isFinite(a.sheetRank) ? a.sheetRank : null;
        const bSheet = Number.isFinite(b.sheetRank) ? b.sheetRank : null;
        if (aSheet != null && bSheet != null && aSheet !== bSheet) return aSheet - bSheet;
        if (aSheet != null && bSheet == null) return -1;
        if (aSheet == null && bSheet != null) return 1;

        const aKtcRank = Number.isFinite(a.devyKtcRank) ? a.devyKtcRank : null;
        const bKtcRank = Number.isFinite(b.devyKtcRank) ? b.devyKtcRank : null;
        if (aKtcRank != null && bKtcRank != null && aKtcRank !== bKtcRank) return aKtcRank - bKtcRank;
        if (aKtcRank != null && bKtcRank == null) return -1;
        if (aKtcRank == null && bKtcRank != null) return 1;

        const aVal = a.devyKtcValue || a.ktcValue || 0;
        const bVal = b.devyKtcValue || b.ktcValue || 0;
        return bVal - aVal;
      });

    // Build current rookie availability pool in this league (non-devy rookies not rostered).
    const rookieDbPlayers = await Player.find({
      isDevy: { $ne: true },
      $or: [
        { isRookie: true },
        { nflDraftYear: currentYear },
      ],
    })
      .select('sleeperId name position team college nflDraftYear fantasyProsValue fantasyProsRank ktcValue ktcRank underdogAdp dasScore isRookie')
      .lean();

    const availableRookies = (devyEnabled ? rookieDbPlayers : [])
      .filter((p) => {
        // Exclude rookies already selected in the current live draft.
        if (p.sleeperId && draftedPlayerIds.has(p.sleeperId)) return false;
        // If tied to a Sleeper ID and already rostered/taxi, it's not available in this league.
        if (p.sleeperId && allRosterIds.has(p.sleeperId)) return false;

        // Fallback to name matching when sleeperId in DB is stale or wrong.
        if (rosteredNames.has(normalizeName(p.name))) return false;

        const sp = p.sleeperId ? sleeperPlayerMap[p.sleeperId] : null;
        const yearsExp = parseYearsExp(sp || {});
        // Exclude players that are still devy in Sleeper data.
        if (isSleeperDevyPlayer(sp || {})) return false;
        // Rookie pool should focus on incoming/first-year NFL players only.
        if (yearsExp !== null) return yearsExp === 0;
        // If Sleeper lacks years_exp, require this year's draft class explicitly.
        return Number(p.nflDraftYear) === currentYear;
      })
      .map((p) => ({
        sleeperId: p.sleeperId || null,
        name: p.name,
        position: p.position,
        team: p.team || null,
        college: p.college || null,
        nflDraftYear: p.nflDraftYear || null,
        fantasyProsValue: p.fantasyProsValue || 0,
        fantasyProsRank: p.fantasyProsRank || null,
        ktcValue: p.ktcValue || 0,
        ktcRank: p.ktcRank || null,
        underdogAdp: p.underdogAdp || null,
        dasScore: p.dasScore || null,
        fpEquivalent: fpEquivalentValue(p, false),
      }))
      .sort((a, b) => {
        if (b.fpEquivalent !== a.fpEquivalent) return b.fpEquivalent - a.fpEquivalent;
        const aVal = a.ktcValue || 0;
        const bVal = b.ktcValue || 0;
        return bVal - aVal;
      });

    const comparisonRows = availablePool.slice(0, 15).map((devy, idx) => {
      const rookie = availableRookies[idx] || null;
      return {
        devy,
        rookie,
        fpGap: rookie ? Math.round((devy.fpEquivalent - rookie.fpEquivalent) * 10) / 10 : null,
      };
    });

    // Augment: for any rostered devy IDs not yet in our DB, pull from Sleeper map only
    const unknownIds = [...devyRosteredIds].filter(id => !devyBySleeperID[id]);
    const unknownPlayers = unknownIds.map(id => {
      const sp = sleeperPlayerMap[id] || {};
      const owner = idToRoster[id] || {};
      const name = sp.full_name || `${sp.first_name || ''} ${sp.last_name || ''}`.trim() || id;
      if (!positionAllowed(sp.position || '?')) return null;
      return {
        sleeperId: id,
        name,
        associatedPlayerId: id,
        position: sp.position || '?',
        college: sp.college || null,
        devyClass: null,
        devyKtcValue: 0,
        ktcValue: 0,
        fantasyProsValue: 0,
        fantasyProsRank: null,
        dasScore: null,
        ownerId: owner.ownerId || null,
        ownerUsername: owner.username || null,
        ownerTeamName: owner.ownerTeamName || null,
        onTaxi: !!owner.onTaxi,
        inOurDb: false,
      };
    }).filter(Boolean);

    // Persist observed devy ownership rows to a cross-league cache so future
    // note lookups can resolve faster and with better attribution.
    const snapshotRows = [...dedupedRosterList, ...unknownPlayers];
    const snapshotOps = [];
    const now = new Date();
    for (const row of snapshotRows) {
      const normalizedDevyName = normalizeName(row.name);
      if (!normalizedDevyName || !row.ownerId) continue;
      const sourceType = row.fromPlayerNote ? 'note' : 'roster';
      const associatedPlayerId = row.associatedPlayerId || (sourceType === 'roster' ? row.sleeperId : null);
      const associatedPlayerName = row.associatedPlayerName || null;

      snapshotOps.push({
        updateOne: {
          filter: {
            sourceLeagueId: leagueId,
            managerSleeperId: row.ownerId,
            associatedPlayerId: associatedPlayerId || null,
            normalizedDevyName,
          },
          update: {
            $set: {
              normalizedDevyName,
              devyName: row.name,
              devySleeperId: row.sleeperId || null,
              devyPlayerId: row.devyPlayerId || null,
              position: row.position || null,
              college: row.college || null,
              devyClass: row.devyClass || null,
              sourceType,
              managerSleeperId: row.ownerId,
              managerUsername: row.ownerUsername || null,
              managerTeamName: row.ownerTeamName || null,
              sourceLeagueId: leagueId,
              associatedPlayerId: associatedPlayerId || null,
              associatedPlayerName,
              rawAlias: row.rawAlias || null,
              onTaxi: !!row.onTaxi,
              lastSeenAt: now,
            },
            $setOnInsert: {
              firstSeenAt: now,
            },
          },
          upsert: true,
        },
      });
    }

    if (snapshotOps.length > 0) {
      try {
        await DevyOwnershipSnapshot.bulkWrite(snapshotOps, { ordered: false });
      } catch (e) {
        console.warn('[DevyPool] Snapshot cache write unavailable:', e.message);
      }
    }

    res.json({
      leagueId,
      leagueName: league.name,
      isDevyLeague: devyEnabled,
      isIdpLeague: idpEnabled,
      positionFilters,
      rostered: dedupedRosterList,
      unknown: unknownPlayers,   // devy players Sleeper knows about but we haven't imported yet
      graduated: graduatedList,  // recently NFL-drafted — were in devy pool
      available: availablePool,
      availableRookies,
      comparisonRows,
      counts: {
        rostered: dedupedRosterList.length,
        unknown: unknownPlayers.length,
        graduated: graduatedList.length,
        available: availablePool.length,
        availableRookies: availableRookies.length,
      },
    });
  } catch (err) {
    console.error('[DevyPool]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
