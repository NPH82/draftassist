/**
 * Draft routes
 * Live draft state, recommendations, queue, and trade suggestions during draft.
 */

const express = require('express');
const router = express.Router();

const sleeperService = require('../services/sleeperService');
const { requireAuth } = require('../middleware/auth');
const { detectValueGap, calcPersonalRankScore } = require('../services/scoringEngine');
const { predictAvailability, detectFallers } = require('../services/availabilityPredictor');
const { suggestTradeUp, suggestTradeDown, fpPickValue } = require('../services/tradeEngine');
const { enrichProfilesWithDraftClass } = require('../services/learningEngine');
const { analyzePositionalNeeds, buildRosterComposition, scoreDraftFit } = require('../services/winWindowService');
const Player = require('../models/Player');
const Draft = require('../models/Draft');
const League = require('../models/League');
const ManagerProfile = require('../models/ManagerProfile');

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
  const expected = Number(player.expectedAdp || 0);
  const observed = Number(player.sleeperObservedAdp || 0);
  const adp = Number(player.underdogAdp || 0);
  const fp = Number(player.fantasyProsRank || 0);
  if (expected > 0) return expected;
  if (observed > 0) return observed;
  if (adp > 0) return adp;
  // For devy/rookie players without ADP data, FP rank alone can be overoptimistic.
  // Use personal rank as a floor (pessimistic signal) — if user ranks a player later
  // than FP consensus, that's real signal that the player doesn't need to be reached for.
  if (fp > 0) {
    const personal = Number(player.personalRank || 0);
    return personal > fp ? Math.round((fp + personal) / 2) : fp;
  }
  return fallbackRank;
}

function isCompletedDraftStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'complete' || s === 'completed';
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function median(values = []) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function stdDev(values = []) {
  if (!values.length) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + ((v - mean) ** 2), 0) / values.length;
  return Math.sqrt(Math.max(variance, 0));
}

function gradeFromZScore(z) {
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

function consensusAdpSignalForGrading(player = {}, { rookieDraft = false } = {}) {
  const rookieObserved = Number(player.sleeperRookieObservedAdp || 0);
  const observed = Number(player.sleeperObservedAdp || 0);
  const expected = Number(player.expectedAdp || 0);
  const adp = Number(player.underdogAdp || 0);
  const fp = Number(player.fantasyProsRank || 0);

  // Prefer Sleeper-derived ADP signals for post-draft grading.
  if (rookieDraft && rookieObserved > 0) return rookieObserved;
  if (observed > 0) return observed;
  if (expected > 0) return expected;
  if (adp > 0) return adp;
  if (fp > 0) return fp;
  return null;
}

function computeCompletedDraftGrades({
  draftData,
  picks,
  rosters,
  userMap,
  playerBySleeperId,
}) {
  const rookieDraft = isRookieDraftContext(draftData, {});
  const ownerByRosterId = Object.fromEntries((rosters || []).map((r) => [String(r.roster_id), r.owner_id]));

  const managerIds = new Set();
  for (const ownerId of Object.keys(draftData?.draft_order || {})) managerIds.add(ownerId);
  for (const r of (rosters || [])) {
    if (r?.owner_id) managerIds.add(r.owner_id);
  }

  const byManager = {};
  for (const managerId of managerIds) {
    byManager[managerId] = {
      ownerId: managerId,
      ownerUsername: userMap?.[managerId]?.username || managerId,
      picks: 0,
      picksWithConsensus: 0,
      weightedScoreSum: 0,
      weightSum: 0,
      deltaSum: 0,
    };
  }

  for (let i = 0; i < (picks || []).length; i += 1) {
    const pick = picks[i] || {};
    const playerId = String(pick.player_id || '').trim();
    if (!playerId) continue;

    const ownerId = pick.picked_by || ownerByRosterId[String(pick.roster_id || '')];
    if (!ownerId) continue;
    if (!byManager[ownerId]) {
      byManager[ownerId] = {
        ownerId,
        ownerUsername: userMap?.[ownerId]?.username || ownerId,
        picks: 0,
        picksWithConsensus: 0,
        weightedScoreSum: 0,
        weightSum: 0,
        deltaSum: 0,
      };
    }

    byManager[ownerId].picks += 1;

    const player = playerBySleeperId[playerId];
    if (!player) continue;

    const consensusAdp = consensusAdpSignalForGrading(player, { rookieDraft });
    if (!(consensusAdp > 0)) continue;

    const actualPick = Number(pick.pick_no || (i + 1));
    if (!(actualPick > 0)) continue;

    // Positive delta means value (picked later than consensus), negative means a reach.
    const delta = consensusAdp - actualPick;
    const scale = Math.max(6, consensusAdp * 0.16);
    let normalized = delta / scale;
    if (normalized < 0) normalized *= 0.8; // So reaches hurt, but only slightly.

    // Earlier rounds carry more impact than late dart throws.
    const weight = 1 / Math.sqrt(actualPick);

    byManager[ownerId].picksWithConsensus += 1;
    byManager[ownerId].weightedScoreSum += normalized * weight;
    byManager[ownerId].weightSum += weight;
    byManager[ownerId].deltaSum += delta;
  }

  const baseRows = Object.values(byManager).map((m) => {
    const rawScore = m.weightSum > 0 ? (m.weightedScoreSum / m.weightSum) : null;
    const avgPickDelta = m.picksWithConsensus > 0 ? (m.deltaSum / m.picksWithConsensus) : null;
    return {
      ownerId: m.ownerId,
      ownerUsername: m.ownerUsername,
      picks: m.picks,
      picksWithConsensus: m.picksWithConsensus,
      avgPickDelta: avgPickDelta == null ? null : round2(avgPickDelta),
      rawScore,
    };
  });

  const validRaw = baseRows.map((r) => r.rawScore).filter((v) => Number.isFinite(v));
  const med = median(validRaw);
  const spread = Math.max(0.12, stdDev(validRaw));

  const graded = baseRows.map((row) => {
    if (!Number.isFinite(row.rawScore)) {
      return {
        ...row,
        rawScore: null,
        zScore: null,
        grade: 'C',
      };
    }
    const z = (row.rawScore - med) / spread;
    return {
      ...row,
      rawScore: round2(row.rawScore),
      zScore: round2(z),
      grade: gradeFromZScore(z),
    };
  });

  graded.sort((a, b) => {
    const az = Number.isFinite(a.zScore) ? a.zScore : -999;
    const bz = Number.isFinite(b.zScore) ? b.zScore : -999;
    if (bz !== az) return bz - az;
    return (a.ownerUsername || '').localeCompare(b.ownerUsername || '');
  });

  for (let i = 0; i < graded.length; i += 1) {
    graded[i].rank = i + 1;
  }

  return {
    managers: graded,
    baseline: {
      medianRawScore: round2(med),
      spread: round2(spread),
      medianGrade: 'C',
      note: 'Positive avgPickDelta means manager drafted players later than consensus ADP (better value).',
    },
  };
}

function currentRoundForPick(pickNumber, totalRosters) {
  return Math.max(1, Math.ceil((Number(pickNumber || 1)) / Math.max(1, Number(totalRosters || 12))));
}

function needTierWeight(tier) {
  const normalized = String(tier || '').toLowerCase();
  if (normalized === 'high') return 1;
  if (normalized === 'medium') return 0.55;
  return 0.2;
}

function buildAcquisitionOutlook({ player, currentOverallPick, myNextPickNumber, totalRosters, pressureContext }) {
  const expectedAdp = Number(player.expectedAdp || player.sleeperObservedAdp || player.underdogAdp || player.fantasyProsRank || 0);
  const trendDelta = Number(player.adpTrendDelta || 0);
  const nextWindow = Math.max(0, (myNextPickNumber - currentOverallPick) - 1);
  const beforeMyPick = pressureContext.beforeMyPickOwners || [];

  const contributors = [];
  let pressure = 0;
  for (const ownerId of beforeMyPick) {
    const profile = pressureContext.profileByOwner[ownerId] || {};
    const rosterNeed = pressureContext.rosterNeedsByOwner[ownerId] || {};
    const earlyWeights = profile.earlyRoundPositionWeights || {};
    const allWeights = profile.positionWeights || {};
    const round = currentRoundForPick(myNextPickNumber, totalRosters);
    const positionWeight = Number((round <= 2 ? earlyWeights[player.position] : allWeights[player.position]) || allWeights[player.position] || 0.25);
    const needWeight = needTierWeight(rosterNeed[player.position]);
    const ownerPressure = (positionWeight * 0.65) + (needWeight * 0.35);
    pressure += ownerPressure;
    contributors.push({
      ownerId,
      username: pressureContext.ownerNameById[ownerId] || ownerId,
      pick: pressureContext.nextPickByOwner[ownerId] || null,
      pressure: Math.round(ownerPressure * 100) / 100,
      needTier: rosterNeed[player.position] || 'low',
    });
  }

  contributors.sort((a, b) => b.pressure - a.pressure);
  const pressureScore = Math.round((pressure / Math.max(1, nextWindow)) * 100) / 100;
  const targetPick = expectedAdp > 0 ? Math.round(expectedAdp) : null;
  const impliedAvailability = targetPick != null ? (targetPick >= myNextPickNumber ? 'likely' : 'at_risk') : 'unknown';

  return {
    expectedAdp: expectedAdp > 0 ? expectedAdp : null,
    adpTrendDelta: Number.isFinite(trendDelta) ? trendDelta : null,
    targetPick,
    picksUntilMyNext: nextWindow,
    leaguematePressure: pressureScore,
    impliedAvailability,
    topThreats: contributors.slice(0, 3),
  };
}

function estimateTradeTargetPick(player = {}, { myNextPickNumber, totalRosters = 12, isRookieDraft = false }) {
  const signals = [];
  const adp = Number(player.underdogAdp || 0);
  const fp = Number(player.fantasyProsRank || 0);
  const personal = Number(player.personalRank || 0);
  const ktc = Number(player.ktcRank || 0);

  if (adp > 0) signals.push(adp);
  if (fp > 0) signals.push(fp);
  if (personal > 0) signals.push(personal);
  if (ktc > 0) signals.push(ktc);

  // Rookie/devy boards often let "name" players slide later than pure FP rank,
  // especially when no Underdog ADP is available.
  if (isRookieDraft && adp <= 0 && fp > 0) {
    const drift = Math.max(3, Math.round(totalRosters * 0.35));
    signals.push(fp + drift);
  }

  if (!signals.length) return myNextPickNumber;
  const sorted = signals.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  return Math.max(1, Math.round(median));
}

function reachPenaltyFromMarket({ player, currentPick, needTier = 'low', availabilityProb = null, reachDiscipline = 1, fallbackRank = 999 }) {
  const marketRank = marketRankSignal(player, fallbackRank);
  const gap = marketRank - currentPick; // positive means likely available later
  // Top-6 picks: even 1 pick of gap is meaningful — that's real draft capital.
  // Picks 7-12: allow 2 pick buffer. Later: 4 pick buffer.
  const topPick = currentPick <= 6;
  const earlyPick = currentPick <= 12;
  const threshold = topPick ? 1 : earlyPick ? 2 : 4;
  if (gap <= threshold) return { penalty: 0, marketRank, gap };

  let penalty = Math.min(earlyPick ? 34 : 24, (gap - threshold) * (earlyPick ? 2.05 : 1.35));

  // Preserve need-based flexibility.
  if (needTier === 'high') penalty *= 0.55;
  else if (needTier === 'medium') penalty *= 0.8;

  // If model already thinks player survives, penalize reaches more.
  if (availabilityProb != null) {
    if (availabilityProb >= 0.72) penalty *= 1.22;
    else if (availabilityProb >= 0.55) penalty *= 1.08;
  }

  penalty *= Math.max(0.8, Math.min(1.6, reachDiscipline || 1));
  return { penalty: Math.round(penalty * 100) / 100, marketRank, gap };
}

/**
 * Find managers whose next pick falls in the "safe window" between the user's current pick
 * and the expected market pick number of the target player.  These managers can be traded
 * WITH (give them your earlier pick, receive their later pick + assets) so you still land
 * the target while gaining draft capital.
 *
 * @param {object[]} rosters        - All league rosters (excluding user's)
 * @param {object}   draftOrder     - Sleeper draft_order map { sleeperId -> slotNumber }
 * @param {number}   currentPick    - Current overall pick number
 * @param {number}   safeUntilPick  - Last pick number where target is still expected available
 * @param {number}   totalRosters   - Teams in the league
 * @returns {Array<{ownerId, username, nextPick}>}
 */
function findTradeBackPartners({ rosters, draftOrder, currentPick, safeUntilPick, totalRosters }) {
  // Invert draft_order: slotNumber -> sleeperId
  const slotToOwner = {};
  for (const [ownerId, slot] of Object.entries(draftOrder || {})) {
    slotToOwner[slot] = ownerId;
  }

  // Determine the slot that picks next after currentPick
  const currentSlot = ((currentPick - 1) % totalRosters) + 1;

  const partners = [];
  for (let pickNum = currentPick + 1; pickNum <= safeUntilPick; pickNum++) {
    const slot = ((pickNum - 1) % totalRosters) + 1;
    const ownerId = slotToOwner[slot];
    if (!ownerId) continue;
    const roster = rosters.find(r => r.ownerId === ownerId);
    if (!roster) continue;
    // Avoid duplicates (same manager can have multiple picks in range for multi-round drafts)
    if (partners.some(p => p.ownerId === ownerId)) continue;
    partners.push({
      ownerId,
      username: roster.ownerUsername || roster.ownerName || ownerId,
      nextPick: pickNum,
      picksBackFromUs: pickNum - currentPick,
    });
  }

  return partners;
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

// GET /api/draft/active -- list active drafts for user, sorted by next pick time
router.get('/active', requireAuth, async (req, res) => {
  try {
    const { sleeperId } = req.user;
    const isLiveDraftStatus = (status) => {
      const s = String(status || '').toLowerCase();
      return s === 'drafting' || s === 'paused';
    };

    // Prefer cached leagues from DB, but fall back to Sleeper directly if cache is empty.
    let leagues = await League.find({ 'rosters.ownerId': sleeperId }).lean();
    if (!leagues.length) {
      const currentYear = String(new Date().getFullYear());
      const sleeperLeagues = await sleeperService.getUserLeagues(sleeperId, 'nfl', currentYear).catch(() => []);
      leagues = sleeperLeagues.map((sl) => ({
        sleeperId: sl.league_id,
        name: sl.name,
        draftId: sl.draft_id,
        totalRosters: sl.total_rosters,
        rosters: null,
      }));
    }
    const draftCandidates = leagues.filter((league) => league.draftId && (league.totalRosters || 0) < 32);

    const activeDrafts = (await mapWithConcurrency(draftCandidates, 8, async (league) => {
      try {
        const draftData = await sleeperService.getDraft(league.draftId);

        if (!isLiveDraftStatus(draftData.status)) return null;

        // Ensure roster ownership metadata is present when league came from Sleeper fallback.
        let leagueRosters = Array.isArray(league.rosters) ? league.rosters : null;
        if (!leagueRosters || leagueRosters.length === 0) {
          const [rawRosters, users] = await Promise.all([
            sleeperService.getRosters(league.sleeperId),
            sleeperService.buildUserMap(league.sleeperId),
          ]);
          leagueRosters = (rawRosters || []).map((r) => ({
            rosterId: r.roster_id,
            ownerId: r.owner_id,
            ownerUsername: users[r.owner_id]?.username || 'Unknown',
            playerIds: r.players || [],
            taxiPlayerIds: r.taxi || [],
          }));
        }

        const [picks, tradedPicks] = await Promise.all([
          sleeperService.getDraftPicks(league.draftId),
          sleeperService.getTradedPicks(league.draftId).catch(() => []),
        ]);
        const myRoster = leagueRosters.find(r => r.ownerId === sleeperId);
        const myPickSlot = draftData.draft_order?.[sleeperId];

        // Compute next pick for the user
        const picksMade = picks.length;
        const totalRosters = draftData.settings?.teams || 12;
        const rounds = draftData.settings?.rounds || 5;
        const currentRound = Math.ceil((picksMade + 1) / totalRosters);
        const currentSlot  = (picksMade % totalRosters) + 1;

        // Build roster_id <-> userId maps so we can apply traded picks
        const rosterIdByOwner = Object.fromEntries((leagueRosters || []).map(r => [r.ownerId, r.rosterId]));
        const ownerByRosterId = Object.fromEntries((leagueRosters || []).map(r => [r.rosterId, r.ownerId]));
        const myRosterId = rosterIdByOwner[sleeperId];

        // For a given draft slot + round, return the userId who currently owns that pick
        // (accounting for trades). draft_order maps userId -> slot.
        const slotToOriginalOwner = {};
        for (const [uid, slot] of Object.entries(draftData.draft_order || {})) {
          slotToOriginalOwner[slot] = uid;
        }
        function effectiveSlotOwner(slot, round) {
          const originalOwnerId = slotToOriginalOwner[slot];
          if (!originalOwnerId) return null;
          const originalRosterId = rosterIdByOwner[originalOwnerId];
          const trade = tradedPicks.find(tp => tp.round === round && tp.roster_id === originalRosterId);
          if (trade) return ownerByRosterId[trade.owner_id] ?? originalOwnerId;
          return originalOwnerId;
        }

        const onTheClock = effectiveSlotOwner(currentSlot, currentRound) === sleeperId;

        // Find user's next pick across all remaining rounds (handling traded picks)
        let nextPickNumber = null;
        for (let round = currentRound; round <= rounds; round++) {
          // Collect slots the user owns in this round
          const mySlots = [];

          // Original slot — include unless traded away
          if (myPickSlot) {
            const tradedAway = tradedPicks.find(
              tp => tp.round === round && tp.roster_id === myRosterId && tp.owner_id !== myRosterId
            );
            if (!tradedAway) mySlots.push(myPickSlot);
          }

          // Picks received from others this round
          for (const tp of tradedPicks) {
            if (tp.round !== round || tp.owner_id !== myRosterId) continue;
            const origOwner = ownerByRosterId[tp.roster_id];
            const origSlot = origOwner ? draftData.draft_order?.[origOwner] : null;
            if (origSlot) mySlots.push(origSlot);
          }

          for (const slot of mySlots) {
            const pickNum = (round - 1) * totalRosters + slot;
            if (pickNum > picksMade && (nextPickNumber === null || pickNum < nextPickNumber)) {
              nextPickNumber = pickNum;
            }
          }
          if (nextPickNumber !== null) break;
        }

        // Seconds per pick for eta
        const secondsPerPick = draftData.settings?.pick_timer || 60;
        const eta = nextPickNumber ? new Date(Date.now() + (nextPickNumber - picksMade - 1) * secondsPerPick * 1000) : null;

        return {
          draftId: league.draftId,
          leagueId: league.sleeperId,
          leagueName: league.name,
          status: draftData.status,
          currentPick: picksMade + 1,
          myNextPick: nextPickNumber,
          etaMs: eta?.getTime() || null,
          totalRosters,
          rounds,
          myPickSlot,
          onTheClock,
        };
      } catch {
        return null;
      }
    })).filter(Boolean);

    // Sort: on-the-clock first, then by soonest ETA
    activeDrafts.sort((a, b) => {
      if (a.onTheClock && !b.onTheClock) return -1;
      if (!a.onTheClock && b.onTheClock) return 1;
      if (a.etaMs && b.etaMs) return a.etaMs - b.etaMs;
      return (a.leagueName || '').localeCompare(b.leagueName || '');
    });

    res.json({ drafts: activeDrafts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/draft/:draftId -- full live draft state with recommendations
router.get('/:draftId', requireAuth, async (req, res) => {
  try {
    const { draftId } = req.params;
    const { sleeperId } = req.user;
    const mode = req.query.mode || 'team_need'; // 'team_need' | 'bpa'

    // Get live picks from Sleeper
    const [draftData, picks, league] = await Promise.all([
      sleeperService.getDraft(draftId),
      sleeperService.getDraftPicks(draftId),
      League.findOne({ draftId }).lean(),
    ]);

    // Fetch live rosters from Sleeper so need analysis reflects any mid-draft trades.
    // Falls back to DB rosters if unavailable.
    let liveRosters = null;
    if (league?.sleeperId) {
      try {
        liveRosters = await sleeperService.getRosters(league.sleeperId);
      } catch (e) {
        console.warn('[Draft] Live roster fetch failed, using DB rosters:', e.message);
      }
    }
    // Merge live roster player lists into the DB league rosters (DB has metadata, live has current players)
    const effectiveRosters = (league?.rosters || []).map(dbRoster => {
      const live = liveRosters?.find(lr => String(lr.roster_id) === String(dbRoster.rosterId));
      if (!live) return dbRoster;
      return {
        ...dbRoster,
        playerIds: live.players || dbRoster.playerIds || [],
        allPlayerIds: live.players || dbRoster.allPlayerIds || [],
      };
    });

    const draftedIds = new Set(picks.map(p => p.player_id).filter(Boolean));
    // Also treat every player already on a league roster as unavailable (covers prior devy/rookie drafts and waivers)
    const rosteredIds = new Set(
      effectiveRosters.flatMap(r => [...(r.allPlayerIds || []), ...(r.playerIds || [])])
    );
    const totalRosters = draftData.settings?.teams || 12;

    if (isCompletedDraftStatus(draftData.status)) {
      const leagueId = league?.sleeperId || draftData?.league_id || null;
      let userMap = {};
      if (leagueId) {
        try {
          userMap = await sleeperService.buildUserMap(leagueId);
        } catch (e) {
          console.warn('[Draft] Completed draft user map lookup failed:', e.message);
        }
      }

      const gradingRosters = effectiveRosters.length
        ? effectiveRosters.map((r) => ({ roster_id: r.rosterId, owner_id: r.ownerId }))
        : (liveRosters || []);

      const pickedPlayerIds = [...new Set((picks || []).map((p) => p.player_id).filter(Boolean))];
      const pickedPlayers = pickedPlayerIds.length
        ? await Player.find({ sleeperId: { $in: pickedPlayerIds } })
          .select('sleeperId sleeperObservedAdp sleeperRookieObservedAdp expectedAdp underdogAdp fantasyProsRank')
          .lean()
        : [];
      const playerBySleeperId = Object.fromEntries(
        pickedPlayers.map((p) => [String(p.sleeperId), p])
      );

      const draftGrades = computeCompletedDraftGrades({
        draftData,
        picks,
        rosters: gradingRosters,
        userMap,
        playerBySleeperId,
      });
      const myDraftGrade = draftGrades.managers.find((m) => m.ownerId === sleeperId) || null;

      return res.json({
        draftId,
        leagueId,
        leagueName: league?.name || draftData.metadata?.name || null,
        status: draftData.status,
        currentPick: picks.length,
        myNextPick: null,
        onTheClock: false,
        mode,
        available: [],
        recommended: [],
        strategyHint: null,
        recentPicks: picks.slice(-5).reverse(),
        fallerAlerts: [],
        positionalNeeds: null,
        winWindow: null,
        myDraftGrade,
        draftGrades,
      });
    }

    // No recommendations for 32-team leagues — return board-only state
    if (totalRosters >= 32) {
      return res.json({
        draftId,
        status: draftData.status,
        totalRosters,
        noRecommendations: true,
        noRecommendationsReason: '32-team leagues are not supported for draft recommendations',
        picks: picks.slice(-20),
      });
    }

    const myPickSlot = draftData.draft_order?.[sleeperId];
    const picksMade = picks.length;
    const currentOverallPick = picksMade + 1;

    // My next pick
    const picksUntilMe = myPickSlot
      ? (() => {
          const currentSlot = (picksMade % totalRosters) + 1;
          return myPickSlot >= currentSlot
            ? myPickSlot - currentSlot
            : totalRosters - currentSlot + myPickSlot;
        })()
      : 999;
    const myNextPickNumber = picksMade + picksUntilMe + 1;

    // Load players — rookie/devy drafts should only show one class year.
    const isRookieDraft = isRookieDraftContext(draftData, league || {});
    const draftSeason = isRookieDraft
      ? await resolveDraftClassYear({ requestedYear: req.query.classYear, draftData, league: league || {} })
      : null;
    const playerFilter = isRookieDraft ? { nflDraftYear: draftSeason } : {};
    const allPlayers = await Player.find(playerFilter).sort({ personalRank: 1, dasScore: -1 }).lean();
    const teamContextPlayers = await Player.find({ position: { $in: ['QB', 'RB', 'WR', 'TE'] } })
      .select('team position ktcValue fantasyProsRank')
      .lean();
    const teamContext = buildTeamContext(teamContextPlayers);
    const availablePlayers = allPlayers
      .filter(p => !p.sleeperId || (!draftedIds.has(p.sleeperId) && !rosteredIds.has(p.sleeperId)))
      .map((p, i) => ({ ...p, dasRank: i + 1, valueGap: detectValueGap(p) }));

    // Get my roster from live data (reflects mid-draft trades)
    const myRoster = effectiveRosters.find(r => r.ownerId === sleeperId);

    const rosterPoolIds = myRoster?.allPlayerIds || myRoster?.playerIds || [];

    const rosterPlayerDocs = await Player.find({ sleeperId: { $in: rosterPoolIds } })
      .select('sleeperId position age isPassCatcher depthChartPosition ktcValue fantasyProsRank nflDraftRound')
      .lean();
    const rosterPlayerMap = Object.fromEntries(rosterPlayerDocs.map(p => [p.sleeperId, p]));

    let sleeperPlayerMap = {};
    try {
      sleeperPlayerMap = await sleeperService.getAllPlayers('nfl');
    } catch (e) {
      console.warn('[Draft] Sleeper fallback map unavailable:', e.message);
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
      league?.rosterPositions || [],
      league?.scoringSettings || {}
    );
    const positionalNeeds = analyzePositionalNeeds(
      rosterPoolIds,
      rosterPlayerMap,
      league?.rosterPositions || [],
      league?.scoringSettings || {}
    );

    // Learn from past agree/disagree feedback to tune reach aversion.
    const myProfile = await ManagerProfile.findOne({ sleeperId }).lean();
    const reachDiscipline = await estimateReachDiscipline(myProfile);

    // Availability context used for reach-aware sorting.
    const remainingRosters = league?.rosters
      .filter(r => r.ownerId !== sleeperId)
      .map(r => ({ ...r, nextPickNumber: myNextPickNumber - picksUntilMe })) || [];

    const slotToOwner = {};
    for (const [ownerId, slot] of Object.entries(draftData.draft_order || {})) {
      slotToOwner[slot] = ownerId;
    }
    const beforeMyPickOwners = [];
    const seenBefore = new Set();
    const ownerNameById = Object.fromEntries((league?.rosters || []).map((r) => [r.ownerId, r.ownerUsername || r.ownerId]));
    const nextPickByOwner = {};
    for (let pickNum = currentOverallPick + 1; pickNum < myNextPickNumber; pickNum += 1) {
      const slot = ((pickNum - 1) % totalRosters) + 1;
      const ownerId = slotToOwner[slot];
      if (!ownerId || ownerId === sleeperId) continue;
      if (!nextPickByOwner[ownerId]) nextPickByOwner[ownerId] = pickNum;
      if (seenBefore.has(ownerId)) continue;
      seenBefore.add(ownerId);
      beforeMyPickOwners.push(ownerId);
    }
    const beforeProfiles = await ManagerProfile.find({ sleeperId: { $in: beforeMyPickOwners } })
      .select('sleeperId positionWeights earlyRoundPositionWeights')
      .lean();
    const profileByOwner = Object.fromEntries(beforeProfiles.map((p) => [p.sleeperId, p]));
    const rosterNeedsByOwner = Object.fromEntries((league?.rosters || []).map((r) => [r.ownerId, r.positionalNeeds || {}]));
    const pressureContext = {
      beforeMyPickOwners,
      profileByOwner,
      rosterNeedsByOwner,
      ownerNameById,
      nextPickByOwner,
    };

    const availabilitySeed = await predictAvailability(
      availablePlayers.slice(0, 120), myNextPickNumber, currentOverallPick, remainingRosters
    );
    const availabilityMap = Object.fromEntries(
      availabilitySeed.map(p => [String(p.sleeperId || p._id), p.availabilityProb])
    );

    // Sort by recommendation mode
    let recommended;
    if (mode === 'bpa') {
      recommended = availablePlayers.slice().map((p) => {
        const key = String(p.sleeperId || p._id);
        const availabilityProb = availabilityMap[key] ?? null;
        const fallbackRank = p.dasRank || 999;
        const { penalty, marketRank, gap } = reachPenaltyFromMarket({
          player: p,
          currentPick: currentOverallPick,
          needTier: positionalNeeds[p.position] || 'low',
          availabilityProb,
          reachDiscipline,
          fallbackRank,
        });
        const personal = calcPersonalRankScore(p.personalRank);
        const base = personal != null ? (p.dasScore || 0) * 0.4 + personal * 0.6 : (p.dasScore || 0);
        const fit = scoreDraftFit(p, rosterComposition, teamContext);
        const needBonus = (positionalNeeds[p.position] || 'low') === 'high'
          ? 12
          : (positionalNeeds[p.position] || 'low') === 'medium' ? 5 : 0;
        const recScore = base + fit + needBonus - penalty;
        // Gap threshold to flag trade-back: tighter at premium picks.
        const tbGapThreshold = currentOverallPick <= 6 ? 3 : currentOverallPick <= 12 ? 5 : 8;
        return {
          ...p,
          availabilityProb,
          marketRank,
          marketReachGap: gap,
          reachPenalty: penalty,
          acquisitionOutlook: buildAcquisitionOutlook({
            player: p,
            currentOverallPick,
            myNextPickNumber,
            totalRosters,
            pressureContext,
          }),
          recScore,
          tradeBackCandidate: gap >= tbGapThreshold && (availabilityProb == null || availabilityProb >= 0.5),
        };
      }).sort((a, b) => (b.recScore || 0) - (a.recScore || 0));
    } else {
      // Team need: sort by positional need, then DAS
      const needOrder = { high: 0, medium: 1, low: 2 };
      recommended = availablePlayers.slice().map((p) => {
        const needTier = positionalNeeds[p.position] || 'low';
        const key = String(p.sleeperId || p._id);
        const availabilityProb = availabilityMap[key] ?? null;
        const fallbackRank = p.dasRank || 999;
        const { penalty, marketRank, gap } = reachPenaltyFromMarket({
          player: p,
          currentPick: currentOverallPick,
          needTier,
          availabilityProb,
          reachDiscipline,
          fallbackRank,
        });
        const personal = calcPersonalRankScore(p.personalRank);
        const base = personal != null ? (p.dasScore || 0) * 0.4 + personal * 0.6 : (p.dasScore || 0);
        const fit = scoreDraftFit(p, rosterComposition, teamContext);
        const needBonus = needTier === 'high' ? 12 : needTier === 'medium' ? 5 : 0;
        const recScore = base + fit + needBonus - penalty;
        // Gap threshold to flag trade-back: tighter at premium picks.
        const tbGapThreshold = currentOverallPick <= 6 ? 3 : currentOverallPick <= 12 ? 5 : 8;
        return {
          ...p,
          availabilityProb,
          marketRank,
          marketReachGap: gap,
          reachPenalty: penalty,
          acquisitionOutlook: buildAcquisitionOutlook({
            player: p,
            currentOverallPick,
            myNextPickNumber,
            totalRosters,
            pressureContext,
          }),
          needTier,
          needOrder: needOrder[needTier],
          recScore,
          tradeBackCandidate: gap >= tbGapThreshold && (availabilityProb == null || availabilityProb >= 0.5),
        };
      }).sort((a, b) => (b.recScore || 0) - (a.recScore || 0));
    }

    // Availability predictions
    const withAvailability = await predictAvailability(
      recommended.slice(0, 50), myNextPickNumber, currentOverallPick, remainingRosters
    );

    // Faller alerts (from queue -- user's target list, placeholder: top 10)
    const targetIds = recommended.slice(0, 10).map(p => p.sleeperId).filter(Boolean);
    const fallers = detectFallers(availablePlayers, picks, targetIds);

    // Scan top-5 for trade-back signal — the reach player might not rank #1 after penalty
    // but could still be the consensus 'obvious' pick that the community will reach for.
    const top5 = withAvailability.slice(0, 5);
    const tradeBackRec = top5.find(p => p.tradeBackCandidate) || null;

    let strategyHint = null;
    if (tradeBackRec) {
      const safeUntil = Math.max(
        currentOverallPick + 1,
        Math.floor((tradeBackRec.marketRank || currentOverallPick) - 1)
      );

      // Find managers with picks in the gap — they're your trade-back partners.
      // Use myNextPickNumber as the base so we only include picks AFTER the user's own slot.
      const partners = findTradeBackPartners({
        rosters: league?.rosters.filter(r => r.ownerId !== sleeperId) || [],
        draftOrder: draftData.draft_order || {},
        currentPick: myNextPickNumber,
        safeUntilPick: safeUntil,
        totalRosters,
      });

      const betterNowOptions = top5
        .filter(p => !p.tradeBackCandidate)
        .slice(0, 2);

      // Compute expected return FP value when trading back to first partner
      const myPickFp = fpPickValue(myNextPickNumber);
      const firstPartnerFp = partners.length > 0 ? fpPickValue(partners[0].nextPick) : 0;
      const surplusFp = Math.max(0, myPickFp - firstPartnerFp);
      const returnFp = Math.round(surplusFp * 0.88 * 10) / 10;

      let message;
      if (partners.length > 0) {
        const partnerNames = partners.slice(0, 2).map(p =>
          `${p.username} (pick ${p.nextPick}, ${p.picksBackFromUs} back)`
        ).join(' or ');
        const returnNote = returnFp > 0
          ? ` Expect ~${returnFp} FP in return assets — see packages below.`
          : '';
        message = `${tradeBackRec.name} projects around pick ${Math.round(tradeBackRec.marketRank || myNextPickNumber)} — market says they'll fall. ` +
          `Trade back with ${partnerNames}: give them your pick ${myNextPickNumber}, drop ${partners[0].picksBackFromUs} spot${partners[0].picksBackFromUs !== 1 ? 's' : ''}, ` +
          `still land ${tradeBackRec.name} + gain draft capital.${returnNote}` +
          (betterNowOptions.length ? ` Or take better value now: ${betterNowOptions.map(p => p.name).join(', ')}.` : '');
      } else {
        message = `${tradeBackRec.name} projects around pick ${Math.round(tradeBackRec.marketRank || myNextPickNumber)} — no easy trade-back window found. ` +
          `Taking better value now is recommended` +
          (betterNowOptions.length ? `: ${betterNowOptions.map(p => p.name).join(', ')}.` : '.');
      }

      strategyHint = {
        type: 'trade_back_or_pivot',
        message,
        playerId: tradeBackRec.sleeperId || tradeBackRec._id,
        marketRank: Math.round(tradeBackRec.marketRank || myNextPickNumber),
        currentPick: myNextPickNumber,
        reachGap: Math.round(tradeBackRec.marketReachGap || 0),
        availabilityProb: tradeBackRec.availabilityProb,
        tradeBackPartners: partners,
        betterValueNow: betterNowOptions.map(p => ({
          name: p.name,
          id: p.sleeperId || String(p._id),
        })),
      };
    }

    res.json({
      draftId,
      leagueId: league?.sleeperId || null,
      leagueName: league?.name || draftData.metadata?.name || null,
      status: draftData.status,
      currentPick: currentOverallPick,
      myNextPick: myNextPickNumber,
      onTheClock: picksUntilMe === 0,
      mode,
      available: withAvailability.slice(0, 48),
      recommended: withAvailability.slice(0, 10),
      strategyHint,
      recentPicks: picks.slice(-5).reverse(),
      fallerAlerts: fallers,
      positionalNeeds,
      winWindow: myRoster ? { label: myRoster.winWindowLabel, reason: myRoster.winWindowReason } : null,
    });
  } catch (err) {
    console.error('[Draft]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/draft/:draftId/trades -- trade suggestions for current pick situation
router.get('/:draftId/trades', requireAuth, async (req, res) => {
  try {
    const { draftId } = req.params;
    const { sleeperId } = req.user;
    const targetPlayerId = req.query.player;

    const [draftData, picks] = await Promise.all([
      sleeperService.getDraft(draftId),
      sleeperService.getDraftPicks(draftId),
    ]);

    const totalRosters = draftData.settings?.teams || 12;
    const myPickSlot = draftData.draft_order?.[sleeperId];
    const picksMade = picks.length;
    const currentSlot = (picksMade % totalRosters) + 1;
    const picksUntilMe = myPickSlot >= currentSlot
      ? myPickSlot - currentSlot
      : totalRosters - currentSlot + myPickSlot;
    const myNextPickNumber = picksMade + picksUntilMe + 1;

    const allPlayers = await Player.find({}).lean();
    const playerMap = Object.fromEntries(allPlayers.map(p => [p.sleeperId, p]));

    const league = await League.findOne({ draftId }).lean();
    const nextPickForSlot = (slot) => {
      if (!slot) return null;
      const distance = slot >= currentSlot
        ? (slot - currentSlot)
        : (totalRosters - currentSlot + slot);
      return picksMade + distance + 1;
    };

    const allRosters = (league?.rosters || []).map(r => {
      const slot = draftData.draft_order?.[r.ownerId];
      return {
        ...r,
        nextPickNumber: nextPickForSlot(slot),
      };
    });

    // Build a list of the user's tradeable players for package generation
    const myRoster = allRosters.find(r => r.ownerId === sleeperId);
    const myPlayerIds = (myRoster?.allPlayerIds?.length ? myRoster.allPlayerIds : myRoster?.playerIds || []);
    const myTradablePlayers = myPlayerIds
      .map(id => playerMap[id])
      .filter(p => p && p.name)  // include all known players; 0-value ones are handled in the engine
      // Sort by best available value: prefer FP consensus, fall back to KTC-normalized
      .sort((a, b) => {
        const aVal = (a.fantasyProsValue || 0) > 0 ? (a.fantasyProsValue || 0)
          : Math.round((a.ktcValue || 0) / 140);
        const bVal = (b.fantasyProsValue || 0) > 0 ? (b.fantasyProsValue || 0)
          : Math.round((b.ktcValue || 0) / 140);
        return bVal - aVal;
      });

    // Determine our own positional need (for trade-down returns)
    const { analyzePositionalNeeds, buildRosterComposition } = require('../services/winWindowService');
    const rosterPlayerMap = Object.fromEntries(myTradablePlayers.map(p => [p.sleeperId, p]));
    const positionalNeeds = analyzePositionalNeeds(
      myPlayerIds,
      rosterPlayerMap,
      league?.rosterPositions || [],
      league?.scoringSettings || {}
    );
    const ourPositionalNeed = positionalNeeds?.biggestNeed || 'WR';

    let tradeUp = [], tradeDown = [];
    let targetExpectedPick = null;

    if (targetPlayerId) {
      const targetPlayer = playerMap[targetPlayerId] || allPlayers.find(p => p._id.toString() === targetPlayerId);
      if (targetPlayer) {
        const isRookieDraft = isRookieDraftContext(draftData, league || {});
        const marketRank = estimateTradeTargetPick(targetPlayer, {
          myNextPickNumber,
          totalRosters,
          isRookieDraft,
        });
        targetExpectedPick = marketRank;

        // Always offer trade-up options for any manager who picks before us.
        // Also offer trade-down options when the player is expected to fall past our slot.
        const safeUntil = Math.max(myNextPickNumber + 1, Math.round(marketRank - 1));

        [tradeUp, tradeDown] = await Promise.all([
          suggestTradeUp({
            targetPlayer,
            ourPickNumber: myNextPickNumber,
            targetPicksAt: null,
            allRosters,
            playerMap,
            userId: sleeperId,
            ourPlayers: myTradablePlayers,
            teams: totalRosters,
          }),
          suggestTradeDown({
            targetPlayer,
            ourPickNumber: myNextPickNumber,
            availableUntilPick: safeUntil,
            allRosters,
            playerMap,
            userId: sleeperId,
            ourPositionalNeed,
            teams: totalRosters,
          }),
        ]);
      }
    }

    res.json({
      tradeUp,
      tradeDown,
      context: {
        myNextPickNumber,
        myNextPickLabel: (() => {
          const round = Math.ceil(myNextPickNumber / totalRosters);
          const slot  = ((myNextPickNumber - 1) % totalRosters) + 1;
          return `${round}.${String(slot).padStart(2, '0')}`;
        })(),
        targetExpectedPick,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/draft/:draftId/scouting/:managerId -- scouting report for a manager
router.get('/:draftId/scouting/:managerId', requireAuth, async (req, res) => {
  try {
    const profile = await ManagerProfile.findOne({ sleeperId: req.params.managerId }).lean();
    if (!profile) return res.json({ noData: true, message: 'No draft history available yet for this manager' });

    const [enriched] = await enrichProfilesWithDraftClass([profile]);
    const result = {
      ...enriched,
      topColleges: Object.entries(enriched.collegeAffinities || {})
        .sort(([, a], [, b]) => b - a).slice(0, 3).map(([name, count]) => ({ name, count })),
      topNflTeams: Object.entries(enriched.nflTeamAffinities || {})
        .sort(([, a], [, b]) => b - a).slice(0, 3).map(([team, count]) => ({ team, count })),
    };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
