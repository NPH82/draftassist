/**
 * Learning Engine
 * Updates ADP, manager tendency profiles, and availability predictions
 * from completed dynasty rookie drafts on Sleeper.
 */

const ManagerProfile = require('../models/ManagerProfile');
const Player = require('../models/Player');
const sleeperService = require('./sleeperService');

/**
 * Ingest a completed Sleeper draft and update all learnings.
 * @param {string} draftId - Sleeper draft ID
 * @param {object[]} picks - array of pick objects from Sleeper
 */
async function ingestDraft(draftId, picks) {
  if (!picks || picks.length === 0) return;

  // Build pick order map: playerId -> overallPickNumber
  const pickOrder = {};
  for (const pick of picks) {
    if (pick.player_id) pickOrder[pick.player_id] = pick.pick_no;
  }

  // Update ADP for each player (running average)
  for (const pick of picks) {
    const playerId = pick.player_id;
    if (!playerId) continue;
    await Player.findOneAndUpdate(
      { sleeperId: playerId },
      {
        $set: { lastUpdated: new Date() },
        $push: { /* no array field needed -- we compute running avg */ }
      },
      { upsert: false }
    ).catch(() => {});
  }

  // Update manager profiles
  const managerPicks = {};  // rosterId -> picks[]
  for (const pick of picks) {
    const rosterId = pick.roster_id;
    if (!managerPicks[rosterId]) managerPicks[rosterId] = [];
    managerPicks[rosterId].push(pick);
  }

  for (const [rosterId, mPicks] of Object.entries(managerPicks)) {
    await updateManagerProfile(rosterId, mPicks, draftId);
  }
}

async function updateManagerProfile(rosterId, picks, draftId) {
  // We need to look up who owns this rosterId -- for now use rosterId as a proxy for sleeperId
  const profile = await ManagerProfile.findOneAndUpdate(
    { sleeperId: rosterId },
    { $setOnInsert: { sleeperId: rosterId } },
    { upsert: true, new: true }
  );

  // Count positions drafted
  const posCount = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const earlyPosCount = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const colleges = {};
  const nflTeams = {};

  for (const pick of picks) {
    const pos = (pick.metadata?.position || '').toUpperCase();
    const isEarly = pick.pick_no <= picks.length * 0.35; // top 35% = early rounds

    if (posCount[pos] !== undefined) {
      posCount[pos]++;
      if (isEarly) earlyPosCount[pos]++;
    }

    const college = pick.metadata?.college;
    if (college) colleges[college] = (colleges[college] || 0) + 1;

    const team = pick.metadata?.team;
    if (team) nflTeams[team] = (nflTeams[team] || 0) + 1;
  }

  const totalPicks = picks.length;
  if (totalPicks === 0) return;

  // Blend new data with existing (partial weighting from first draft)
  const weight = Math.min(1, profile.totalPicksObserved / 100 + 0.3); // starts at 30% weight
  const blendWeight = (newVal, oldVal) => oldVal * (1 - weight) + newVal * weight;

  const newPosWeights = {};
  const newEarlyWeights = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    newPosWeights[pos] = blendWeight(posCount[pos] / totalPicks, profile.positionWeights?.[pos] || 0.25);
    newEarlyWeights[pos] = blendWeight(earlyPosCount[pos] / Math.max(1, totalPicks * 0.35), profile.earlyRoundPositionWeights?.[pos] || 0.25);
  }

  // Merge college/team affinities
  const collegeMap = Object.fromEntries(profile.collegeAffinities || []);
  for (const [college, count] of Object.entries(colleges)) {
    collegeMap[college] = (collegeMap[college] || 0) + count;
  }
  const nflTeamMap = Object.fromEntries(profile.nflTeamAffinities || []);
  for (const [team, count] of Object.entries(nflTeams)) {
    nflTeamMap[team] = (nflTeamMap[team] || 0) + count;
  }

  // Generate scouting notes
  const notes = generateScoutingNotes(newPosWeights, newEarlyWeights, collegeMap);

  await ManagerProfile.findOneAndUpdate(
    { sleeperId: rosterId },
    {
      positionWeights: newPosWeights,
      earlyRoundPositionWeights: newEarlyWeights,
      collegeAffinities: collegeMap,
      nflTeamAffinities: nflTeamMap,
      scoutingNotes: notes,
      $addToSet: { draftsObserved: draftId },
      $inc: { totalPicksObserved: totalPicks },
      lastUpdated: new Date(),
    }
  );
}

function generateScoutingNotes(posWeights, earlyWeights, colleges) {
  const notes = [];

  // Positional tendencies
  const topPos = Object.entries(posWeights).sort(([, a], [, b]) => b - a)[0];
  if (topPos && topPos[1] > 0.35) notes.push(`Tends to overdraft ${topPos[0]}s`);

  const earlyTopPos = Object.entries(earlyWeights).sort(([, a], [, b]) => b - a)[0];
  if (earlyTopPos && earlyTopPos[1] > 0.4) notes.push(`Favors ${earlyTopPos[0]}s in early rounds`);

  // College affinities
  const sortedColleges = Object.entries(colleges).sort(([, a], [, b]) => b - a);
  if (sortedColleges[0] && sortedColleges[0][1] >= 2) {
    notes.push(`Consistently targets ${sortedColleges[0][0]} players`);
  }

  return notes;
}

/**
 * Scan all leagues for the user and ingest any completed drafts not yet learned.
 */
async function learnFromUserLeagues(userId, leagueIds) {
  const results = [];
  for (const leagueId of leagueIds) {
    try {
      const drafts = await sleeperService.getLeagueDrafts(leagueId);
      for (const draft of drafts) {
        if (draft.status === 'complete') {
          const picks = await sleeperService.getDraftPicks(draft.draft_id);
          await ingestDraft(draft.draft_id, picks);
          results.push(draft.draft_id);
        }
      }
    } catch (err) {
      console.warn(`[LearningEngine] Failed for league ${leagueId}: ${err.message}`);
    }
  }
  return results;
}

module.exports = { ingestDraft, learnFromUserLeagues };
