const sleeperService = require('./sleeperService');
const Player = require('../models/Player');
const DraftPickObservation = require('../models/DraftPickObservation');
const DraftAdpIngestRun = require('../models/DraftAdpIngestRun');

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function blendExpectedAdp({ sleeperObservedAdp, underdogAdp, fantasyProsRank }) {
  const sleeper = Number(sleeperObservedAdp || 0);
  const ud = Number(underdogAdp || 0);
  const fp = Number(fantasyProsRank || 0);

  if (sleeper > 0 && ud > 0) return Math.round(((sleeper * 0.65) + (ud * 0.35)) * 10) / 10;
  if (sleeper > 0 && fp > 0) return Math.round(((sleeper * 0.75) + (fp * 0.25)) * 10) / 10;
  if (sleeper > 0) return sleeper;
  if (ud > 0) return ud;
  if (fp > 0) return fp;
  return null;
}

async function recomputePlayerAdpFromObservations(playerSleeperIds = []) {
  const ids = [...new Set((playerSleeperIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return { updated: 0 };

  const grouped = await DraftPickObservation.aggregate([
    { $match: { playerSleeperId: { $in: ids } } },
    {
      $group: {
        _id: '$playerSleeperId',
        avgPick: { $avg: '$pickNo' },
        count: { $sum: 1 },
        rookieAvgPick: { $avg: { $cond: ['$isRookie', '$pickNo', null] } },
        rookieCount: { $sum: { $cond: ['$isRookie', 1, 0] } },
      },
    },
  ]);

  if (!grouped.length) return { updated: 0 };

  const playerMap = new Map((await Player.find({ sleeperId: { $in: ids } })
    .select('sleeperId underdogAdp fantasyProsRank')
    .lean()).map((p) => [p.sleeperId, p]));

  const ops = [];
  for (const row of grouped) {
    const sleeperId = String(row._id || '');
    if (!sleeperId) continue;

    const player = playerMap.get(sleeperId) || {};
    const sleeperObservedAdp = Math.round((Number(row.avgPick || 0)) * 10) / 10;
    const sleeperObservedAdpCount = Number(row.count || 0);
    const sleeperRookieObservedAdp = Number(row.rookieCount || 0) > 0
      ? Math.round((Number(row.rookieAvgPick || 0)) * 10) / 10
      : null;
    const sleeperRookieObservedAdpCount = Number(row.rookieCount || 0);
    const expectedAdp = blendExpectedAdp({
      sleeperObservedAdp,
      underdogAdp: player.underdogAdp,
      fantasyProsRank: player.fantasyProsRank,
    });
    const adpTrendDelta = (expectedAdp != null && Number(player.underdogAdp || 0) > 0)
      ? Math.round((expectedAdp - Number(player.underdogAdp)) * 10) / 10
      : null;

    ops.push({
      updateOne: {
        filter: { sleeperId },
        update: {
          $set: {
            sleeperObservedAdp,
            sleeperObservedAdpCount,
            sleeperRookieObservedAdp,
            sleeperRookieObservedAdpCount,
            expectedAdp,
            adpTrendDelta,
            lastUpdated: new Date(),
          },
        },
      },
    });
  }

  if (!ops.length) return { updated: 0 };
  const result = await Player.bulkWrite(ops, { ordered: false });
  return { updated: result.modifiedCount || 0 };
}

async function ingestCompletedDraftTrends({ leagueId, draftId, season, force = false }) {
  if (!draftId) return { ok: false, skipped: true, reason: 'missing_draft_id' };

  if (!force) {
    const existing = await DraftAdpIngestRun.findOne({ draftId, status: 'processed' }).lean();
    if (existing) return { ok: true, skipped: true, reason: 'already_processed' };
  }

  try {
    const [draftData, picks] = await Promise.all([
      sleeperService.getDraft(draftId),
      sleeperService.getDraftPicks(draftId),
    ]);

    const draftStatus = String(draftData?.status || '').toLowerCase();
    if (draftStatus !== 'complete') {
      await DraftAdpIngestRun.findOneAndUpdate(
        { draftId },
        {
          $set: {
            draftId,
            leagueId: leagueId || null,
            season: toInt(season) || toInt(draftData?.season) || null,
            status: 'skipped',
            reason: `draft_status_${draftStatus || 'unknown'}`,
            pickCount: Array.isArray(picks) ? picks.length : 0,
            processedAt: new Date(),
          },
        },
        { upsert: true }
      );
      return { ok: true, skipped: true, reason: 'draft_not_complete' };
    }

    const pickRows = (picks || [])
      .map((pick) => {
        const pickNo = Number(pick?.pick_no || 0);
        const playerSleeperId = String(pick?.player_id || '').trim();
        if (!pickNo || !playerSleeperId) return null;
        return {
          draftId,
          leagueId: leagueId || null,
          season: toInt(season) || toInt(draftData?.season) || null,
          pickNo,
          round: Number(pick?.round || 0) || null,
          rosterId: Number(pick?.roster_id || 0) || null,
          managerSleeperId: pick?.picked_by ? String(pick.picked_by) : null,
          playerSleeperId,
          observedAt: new Date(),
        };
      })
      .filter(Boolean);

    if (!pickRows.length) {
      await DraftAdpIngestRun.findOneAndUpdate(
        { draftId },
        {
          $set: {
            draftId,
            leagueId: leagueId || null,
            season: toInt(season) || toInt(draftData?.season) || null,
            status: 'skipped',
            reason: 'no_picks',
            pickCount: 0,
            processedAt: new Date(),
          },
        },
        { upsert: true }
      );
      return { ok: true, skipped: true, reason: 'no_picks' };
    }

    const pickedIds = [...new Set(pickRows.map((p) => p.playerSleeperId))];
    const playerDocs = await Player.find({ sleeperId: { $in: pickedIds } })
      .select('sleeperId name position isRookie')
      .lean();
    const playerById = Object.fromEntries(playerDocs.map((p) => [p.sleeperId, p]));

    const ops = pickRows.map((row) => {
      const player = playerById[row.playerSleeperId] || {};
      return {
        updateOne: {
          filter: { draftId: row.draftId, pickNo: row.pickNo },
          update: {
            $set: {
              ...row,
              playerName: player.name || null,
              position: player.position || null,
              isRookie: !!player.isRookie,
            },
          },
          upsert: true,
        },
      };
    });

    if (ops.length) {
      await DraftPickObservation.bulkWrite(ops, { ordered: false });
    }

    await recomputePlayerAdpFromObservations(pickedIds);

    await DraftAdpIngestRun.findOneAndUpdate(
      { draftId },
      {
        $set: {
          draftId,
          leagueId: leagueId || null,
          season: toInt(season) || toInt(draftData?.season) || null,
          status: 'processed',
          reason: null,
          pickCount: pickRows.length,
          processedAt: new Date(),
        },
      },
      { upsert: true }
    );

    return { ok: true, processed: true, picks: pickRows.length };
  } catch (err) {
    await DraftAdpIngestRun.findOneAndUpdate(
      { draftId },
      {
        $set: {
          draftId,
          leagueId: leagueId || null,
          season: toInt(season) || null,
          status: 'failed',
          reason: err.message,
          processedAt: new Date(),
        },
      },
      { upsert: true }
    );
    return { ok: false, error: err.message };
  }
}

module.exports = {
  ingestCompletedDraftTrends,
  recomputePlayerAdpFromObservations,
};
