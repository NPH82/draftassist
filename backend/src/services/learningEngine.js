/**
 * Learning Engine
 * Updates ADP, manager tendency profiles, and availability predictions
 * from completed dynasty rookie drafts on Sleeper.
 */

const ManagerProfile = require('../models/ManagerProfile');
const Player = require('../models/Player');
const sleeperService = require('./sleeperService');

const LOOKBACK_YEARS = 4;

/**
 * Build a map of rosterId -> { userId, username } for a league.
 */
async function buildRosterUserMap(leagueId) {
  const [rosters, users] = await Promise.all([
    sleeperService.getRosters(leagueId),
    sleeperService.getLeagueUsers(leagueId),
  ]);
  const userMap = {};
  for (const u of users) userMap[u.user_id] = u.username || u.display_name || u.user_id;
  const rosterMap = {};
  for (const r of rosters) {
    rosterMap[r.roster_id] = {
      userId: r.owner_id,
      username: userMap[r.owner_id] || r.owner_id,
    };
  }
  return rosterMap;
}

function buildLookbackSeasons(yearsBack = LOOKBACK_YEARS) {
  const currentYear = new Date().getFullYear();
  const seasons = [];
  for (let i = 0; i < yearsBack; i++) {
    seasons.push(currentYear - i);
  }
  return seasons;
}

async function getDynastyLeaguesAcrossSeasons(userId, seasons = buildLookbackSeasons()) {
  const bySeason = await Promise.all(
    seasons.map((season) => sleeperService.getUserLeagues(userId, 'nfl', String(season)).catch(() => []))
  );
  return bySeason
    .flat()
    .filter((lg) => lg?.settings?.type === 2); // dynasty only
}

function deriveMarketRank(player = {}, pick) {
  if (Number.isFinite(player.fantasyProsRank) && player.fantasyProsRank > 0) return player.fantasyProsRank;
  if (Number.isFinite(player.ktcRank) && player.ktcRank > 0) return player.ktcRank;
  if (Number.isFinite(player.ktcValue) && player.ktcValue > 0) {
    // Rough value->rank proxy when explicit ranks are missing.
    return Math.max(1, Math.round(220 - (player.ktcValue / 45)));
  }
  // No market ranking available: use the pick itself as neutral expectation.
  return pick?.pick_no || null;
}

function qualityTierFromScore(score) {
  if (!Number.isFinite(score)) return 'unknown';
  if (score >= 66) return 'elite';
  if (score >= 56) return 'strong';
  if (score >= 44) return 'average';
  return 'weak';
}

function buildDraftQualityNote(tier, valueOverExpected) {
  if (tier === 'elite') return `Drafts above market expectation consistently (VOE ${valueOverExpected.toFixed(1)})`;
  if (tier === 'strong') return `Drafts strong value vs slot expectation (VOE ${valueOverExpected.toFixed(1)})`;
  if (tier === 'weak') return `Often reaches vs market expectation (VOE ${valueOverExpected.toFixed(1)})`;
  return null;
}

function evaluateDraftQuality(picks = [], playerValueMap = {}) {
  if (!Array.isArray(picks) || picks.length === 0) {
    return { score: 50, valueOverExpected: 0, hitRate: 0, tier: 'unknown' };
  }

  const contributions = [];

  for (const pick of picks) {
    const expectedRank = Number(pick.pick_no || 0);
    if (!expectedRank) continue;

    const player = playerValueMap[pick.player_id] || {};
    const marketRank = deriveMarketRank(player, pick);
    if (!marketRank) continue;

    // Positive means player market rank beat slot expectation (good value).
    const voe = expectedRank - marketRank;
    contributions.push(Math.max(-40, Math.min(40, voe)));
  }

  if (contributions.length === 0) {
    return { score: 50, valueOverExpected: 0, hitRate: 0, tier: 'unknown' };
  }

  const valueOverExpected = contributions.reduce((sum, v) => sum + v, 0) / contributions.length;
  const hitRate = contributions.filter(v => v >= 3).length / contributions.length;
  const score = Math.max(0, Math.min(100, Math.round(50 + valueOverExpected * 1.8 + (hitRate - 0.5) * 25)));

  return {
    score,
    valueOverExpected: Number(valueOverExpected.toFixed(2)),
    hitRate: Number(hitRate.toFixed(3)),
    tier: qualityTierFromScore(score),
  };
}

/**
 * Ingest a completed Sleeper draft and update all learnings.
 * @param {string} draftId - Sleeper draft ID
 * @param {object[]} picks - array of pick objects from Sleeper
 * @param {object} rosterUserMap - { rosterId: { userId, username } }
 */
async function ingestDraft(draftId, picks, rosterUserMap = {}) {
  if (!picks || picks.length === 0) return;

  const pickPlayerIds = [...new Set(picks.map(p => p.player_id).filter(Boolean))];
  const playerDocs = pickPlayerIds.length
    ? await Player.find({ sleeperId: { $in: pickPlayerIds } })
      .select('sleeperId fantasyProsRank ktcRank ktcValue')
      .lean()
    : [];
  const playerValueMap = Object.fromEntries(playerDocs.map(p => [p.sleeperId, p]));

  // Group picks by manager
  const managerPicks = {};
  for (const pick of picks) {
    const rosterId = String(pick.roster_id);
    if (!managerPicks[rosterId]) managerPicks[rosterId] = [];
    managerPicks[rosterId].push(pick);
  }

  let managersUpdated = 0;
  for (const [rosterId, mPicks] of Object.entries(managerPicks)) {
    const owner = rosterUserMap[rosterId] || { userId: rosterId, username: null };
    const changed = await updateManagerProfile(owner.userId, owner.username, mPicks, draftId, playerValueMap);
    if (changed) managersUpdated++;
  }

  return managersUpdated;
}

async function updateManagerProfile(sleeperId, username, picks, draftId, playerValueMap = {}) {
  const profile = await ManagerProfile.findOneAndUpdate(
    { sleeperId },
    { $setOnInsert: { sleeperId } },
    { upsert: true, returnDocument: 'after' }
  );

  // If draft was already observed, only backfill quality metrics when missing.
  const alreadyObserved = profile.draftsObserved?.includes(draftId);
  if (alreadyObserved && profile.draftQualityTier && profile.draftQualityTier !== 'unknown') return false;

  const posCount = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const earlyPosCount = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const colleges = {};
  const nflTeams = {};
  const playerCounts = {};

  for (const pick of picks) {
    const pos = (pick.metadata?.position || '').toUpperCase();
    const isEarly = pick.pick_no <= picks.length * 0.35;

    if (posCount[pos] !== undefined) {
      posCount[pos]++;
      if (isEarly) earlyPosCount[pos]++;
    }

    const college = pick.metadata?.college;
    if (college) colleges[college] = (colleges[college] || 0) + 1;

    const team = pick.metadata?.team;
    if (team) nflTeams[team] = (nflTeams[team] || 0) + 1;

    // Track which specific players this manager drafts
    if (pick.player_id) playerCounts[pick.player_id] = (playerCounts[pick.player_id] || 0) + 1;
  }

  const totalPicks = picks.length;
  if (totalPicks === 0) return false;

  const weight = Math.min(1, profile.totalPicksObserved / 100 + 0.3);
  const blend = (newVal, oldVal) => oldVal * (1 - weight) + newVal * weight;

  const newPosWeights = {};
  const newEarlyWeights = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    newPosWeights[pos] = blend(posCount[pos] / totalPicks, profile.positionWeights?.[pos] || 0.25);
    newEarlyWeights[pos] = blend(earlyPosCount[pos] / Math.max(1, totalPicks * 0.35), profile.earlyRoundPositionWeights?.[pos] || 0.25);
  }

  const collegeMap = Object.fromEntries(profile.collegeAffinities || []);
  for (const [college, count] of Object.entries(colleges)) {
    collegeMap[college] = (collegeMap[college] || 0) + count;
  }
  const nflTeamMap = Object.fromEntries(profile.nflTeamAffinities || []);
  for (const [team, count] of Object.entries(nflTeams)) {
    nflTeamMap[team] = (nflTeamMap[team] || 0) + count;
  }
  const playerCountMap = Object.fromEntries(profile.playerPickCounts || []);
  for (const [pid, count] of Object.entries(playerCounts)) {
    playerCountMap[pid] = (playerCountMap[pid] || 0) + count;
  }

  const draftQuality = evaluateDraftQuality(picks, playerValueMap);
  const priorQualityScore = Number.isFinite(profile.draftQualityScore) ? profile.draftQualityScore : 50;
  const priorVoe = Number.isFinite(profile.draftValueOverExpected) ? profile.draftValueOverExpected : 0;
  const priorHitRate = Number.isFinite(profile.draftHitRate) ? profile.draftHitRate : 0;

  const blendedQualityScore = blend(draftQuality.score, priorQualityScore);
  const blendedVoe = blend(draftQuality.valueOverExpected, priorVoe);
  const blendedHitRate = blend(draftQuality.hitRate, priorHitRate);
  const qualityTier = qualityTierFromScore(blendedQualityScore);
  const qualityNote = buildDraftQualityNote(qualityTier, blendedVoe);

  if (alreadyObserved) {
    const priorNotes = Array.isArray(profile.scoutingNotes) ? profile.scoutingNotes : [];
    const cleaned = priorNotes.filter(n => !/market expectation|VOE/.test(n));
    if (qualityNote) cleaned.unshift(qualityNote);

    const backfillUpdate = {
      draftQualityScore: Number(blendedQualityScore.toFixed(1)),
      draftValueOverExpected: Number(blendedVoe.toFixed(2)),
      draftHitRate: Number(blendedHitRate.toFixed(3)),
      draftQualityTier: qualityTier,
      scoutingNotes: cleaned,
      lastUpdated: new Date(),
    };
    if (username) backfillUpdate.username = username;

    await ManagerProfile.findOneAndUpdate({ sleeperId }, backfillUpdate);
    return true;
  }

  const notes = generateScoutingNotes(newPosWeights, newEarlyWeights, collegeMap, nflTeamMap, {
    tier: qualityTier,
    valueOverExpected: blendedVoe,
    hitRate: blendedHitRate,
  });

  const update = {
    positionWeights: newPosWeights,
    earlyRoundPositionWeights: newEarlyWeights,
    collegeAffinities: collegeMap,
    nflTeamAffinities: nflTeamMap,
    playerPickCounts: playerCountMap,
    draftQualityScore: Number(blendedQualityScore.toFixed(1)),
    draftValueOverExpected: Number(blendedVoe.toFixed(2)),
    draftHitRate: Number(blendedHitRate.toFixed(3)),
    draftQualityTier: qualityTier,
    scoutingNotes: notes,
    $addToSet: { draftsObserved: draftId },
    $inc: { totalPicksObserved: totalPicks },
    lastUpdated: new Date(),
  };
  if (username) update.username = username;

  await ManagerProfile.findOneAndUpdate({ sleeperId }, update);
  return true;
}

function generateScoutingNotes(posWeights, earlyWeights, colleges, nflTeams = {}, draftQuality = null) {
  const notes = [];

  if (draftQuality?.tier === 'elite') {
    notes.push(`Drafts above market expectation consistently (elite hit profile)`);
  } else if (draftQuality?.tier === 'strong') {
    notes.push(`Drafts strong value vs slot expectation`);
  } else if (draftQuality?.tier === 'weak') {
    notes.push(`Often reaches vs market expectation`);
  }

  const topPos = Object.entries(posWeights).sort(([, a], [, b]) => b - a)[0];
  if (topPos && topPos[1] > 0.35) notes.push(`Tends to overdraft ${topPos[0]}s`);

  const earlyTopPos = Object.entries(earlyWeights).sort(([, a], [, b]) => b - a)[0];
  if (earlyTopPos && earlyTopPos[1] > 0.4) notes.push(`Favors ${earlyTopPos[0]}s in early rounds`);

  const sortedColleges = Object.entries(colleges).sort(([, a], [, b]) => b - a);
  if (sortedColleges[0] && sortedColleges[0][1] >= 2) {
    notes.push(`Consistently targets ${sortedColleges[0][0]} players`);
  }

  const sortedTeams = Object.entries(nflTeams).sort(([, a], [, b]) => b - a);
  if (sortedTeams[0] && sortedTeams[0][1] >= 2) {
    const teamStr = sortedTeams.slice(0, 2).map(([t]) => t).join(' and ');
    notes.push(`Frequently targets ${teamStr} players`);
  }

  return notes;
}

/**
 * Batch-enrich an array of profile objects with favoriteDraftClassPlayers.
 * Does a single DB query per call. Returns a new array (does not mutate).
 * @param {object[]} profiles - lean ManagerProfile objects or API-shaped objects
 * @param {number} draftYear - draft year to filter by (default 2026)
 */
async function enrichProfilesWithDraftClass(profiles, draftYear = 2026) {
  // Collect every player ID seen across all profiles
  const allPlayerIds = new Set();
  for (const p of profiles) {
    const counts = p.playerPickCounts instanceof Map
      ? Object.fromEntries(p.playerPickCounts)
      : (p.playerPickCounts || {});
    for (const pid of Object.keys(counts)) allPlayerIds.add(pid);
  }

  if (allPlayerIds.size === 0) {
    return profiles.map(p => ({ ...p, favoriteDraftClassPlayers: [] }));
  }

  // Single DB query -- only current draft class
  const classPlayers = await Player.find({
    sleeperId: { $in: [...allPlayerIds] },
    nflDraftYear: draftYear,
  }).lean();
  const classPlayerMap = Object.fromEntries(classPlayers.map(cp => [cp.sleeperId, cp]));

  return profiles.map(p => {
    const counts = p.playerPickCounts instanceof Map
      ? Object.fromEntries(p.playerPickCounts)
      : (p.playerPickCounts || {});

    const favoriteDraftClassPlayers = Object.entries(counts)
      .filter(([pid]) => classPlayerMap[pid])
      .sort(([, a], [, b]) => b - a)
      .slice(0, 6)
      .map(([pid, timesDrafted]) => {
        const cp = classPlayerMap[pid];
        return { name: cp.name, position: cp.position, team: cp.team || null, timesDrafted };
      });

    return { ...p, favoriteDraftClassPlayers };
  });
}

/**
 * Scan all leagues for the user and ingest any completed drafts not yet learned.
 * Also scans leaguemates' other leagues for broader tendency data.
 * Returns a summary of what was processed.
 */
async function learnFromUserLeagues(userId, leagueIds) {
  const summary = { draftsProcessed: 0, draftsSkipped: 0, managersUpdated: new Set(), errors: [] };
  const lookbackSeasons = buildLookbackSeasons();

  // Collect all league IDs: user's leagues + leaguemates' other leagues
  const allLeagueIds = new Set(leagueIds);

  // Expand with user's own dynasty leagues from previous seasons.
  const myHistoricalLeagues = await getDynastyLeaguesAcrossSeasons(userId, lookbackSeasons).catch(() => []);
  for (const lg of myHistoricalLeagues) {
    if (lg?.league_id) allLeagueIds.add(lg.league_id);
  }

  for (const leagueId of leagueIds) {
    try {
      const rosters = await sleeperService.getRosters(leagueId);
      for (const roster of rosters) {
        if (!roster.owner_id || roster.owner_id === userId) continue;
        try {
          const theirLeagues = await getDynastyLeaguesAcrossSeasons(roster.owner_id, lookbackSeasons);
          for (const lg of (theirLeagues || [])) {
            if (lg?.league_id) allLeagueIds.add(lg.league_id);
          }
        } catch { /* non-fatal */ }
      }
    } catch (err) {
      summary.errors.push(`League ${leagueId} rosters: ${err.message}`);
    }
  }

  // Process all collected leagues
  for (const leagueId of allLeagueIds) {
    try {
      const [drafts, rosterUserMap] = await Promise.all([
        sleeperService.getLeagueDrafts(leagueId),
        buildRosterUserMap(leagueId).catch(() => ({})),
      ]);

      for (const draft of drafts) {
        if (draft.status !== 'complete') continue;
        const picks = await sleeperService.getDraftPicks(draft.draft_id);
        const changedManagers = await ingestDraft(draft.draft_id, picks, rosterUserMap);
        if (changedManagers > 0) summary.draftsProcessed++;
        else summary.draftsSkipped++;

        for (const owner of Object.values(rosterUserMap)) {
          if (owner.username) summary.managersUpdated.add(owner.username);
        }
      }
    } catch (err) {
      summary.errors.push(`League ${leagueId}: ${err.message}`);
    }
  }

  return {
    draftsProcessed: summary.draftsProcessed,
    draftsSkipped: summary.draftsSkipped,
    managersUpdated: summary.managersUpdated.size,
    errors: summary.errors,
  };
}

module.exports = { ingestDraft, learnFromUserLeagues, generateScoutingNotes, enrichProfilesWithDraftClass };

