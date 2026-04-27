/**
 * Sleeper sync service
 *
 * Two operations, both safe to re-run at any time:
 *
 *  importSleeperPlayers()
 *    Upserts every QB/RB/WR/TE player from Sleeper's /players/nfl into our DB.
 *    On insert: sets name, position, sleeperId, team, age, injuryStatus.
 *    On update: only refreshes team, age, injuryStatus — never overwrites
 *    ktcValue / fantasyProsValue / dasScore already set by scrapers.
 *
 *  syncSleeperIds()
 *    For players already in our DB that are missing a sleeperId (e.g. manually
 *    seeded rookies), looks them up by name+position in the Sleeper map and
 *    back-fills the ID.
 */

const Player = require('../models/Player');
const { getAllPlayers } = require('./sleeperService');

const SKILL_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

function parseYearsExp(player = {}) {
  const value = Number(player.years_exp);
  return Number.isFinite(value) ? value : null;
}

function isHeuristicDevyCandidate(sp = {}) {
  const yearsExp = parseYearsExp(sp);
  // Sleeper no longer consistently marks devy as years_exp === -1.
  // Fallback: no NFL team, has college, and not yet accrued NFL experience.
  return yearsExp !== null && yearsExp <= 0 && !sp.team && !!sp.college;
}

// ---------------------------------------------------------------------------
// importSleeperPlayers
// ---------------------------------------------------------------------------
async function importSleeperPlayers() {
  const sleeperMap = await getAllPlayers('nfl');

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const [id, sp] of Object.entries(sleeperMap)) {
    if (!sp.position || !SKILL_POSITIONS.has(sp.position)) { skipped++; continue; }

    const fullName = (sp.full_name || `${sp.first_name || ''} ${sp.last_name || ''}`).trim();
    if (!fullName) { skipped++; continue; }

    const existing = await Player.findOne({ sleeperId: id }).lean();

    if (existing) {
      // Only refresh fields that change during the season
      await Player.updateOne(
        { sleeperId: id },
        {
          $set: {
            team: sp.team || null,
            age: sp.age || null,
            currentInjuryStatus: sp.injury_status || 'Active',
          },
        }
      );
      updated++;
    } else {
      // New player — full insert (won't overwrite an existing doc)
      await Player.create({
        sleeperId: id,
        name: fullName,
        position: sp.position,
        team: sp.team || null,
        age: sp.age || null,
        currentInjuryStatus: sp.injury_status || 'Active',
        ktcValue: 0,
        fantasyProsValue: 0,
      });
      created++;
    }
  }

  const summary = { created, updated, skipped };
  console.log(`[SleeperSync] importSleeperPlayers: ${created} created, ${updated} updated, ${skipped} skipped`);
  return summary;
}

// ---------------------------------------------------------------------------
// syncSleeperIds
// ---------------------------------------------------------------------------
async function syncSleeperIds() {
  const sleeperMap = await getAllPlayers('nfl');

  // Build lookup: "full_name|POSITION" -> sleeperId (with suffix-stripped variant)
  const lookup = {};
  for (const [id, p] of Object.entries(sleeperMap)) {
    if (!p.full_name || !p.position) continue;
    const key = `${p.full_name.toLowerCase().trim()}|${p.position.toUpperCase()}`;
    lookup[key] = id;
    const bare = p.full_name.toLowerCase().replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/i, '').trim();
    if (bare !== p.full_name.toLowerCase().trim()) {
      lookup[`${bare}|${p.position.toUpperCase()}`] = id;
    }
  }

  // Only look at players missing a sleeperId
  const players = await Player.find({
    $or: [{ sleeperId: null }, { sleeperId: '' }, { sleeperId: { $exists: false } }],
  }).lean();

  let updated = 0;
  let notFound = 0;
  const missed = [];

  for (const player of players) {
    const key = `${player.name.toLowerCase().trim()}|${player.position.toUpperCase()}`;
    const bare = `${player.name.toLowerCase().replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/i, '').trim()}|${player.position.toUpperCase()}`;
    const sid = lookup[key] || lookup[bare];
    if (sid) {
      await Player.updateOne({ _id: player._id }, { sleeperId: sid });
      updated++;
    } else {
      notFound++;
      missed.push(`${player.name} (${player.position})`);
    }
  }

  const summary = { updated, notFound, unmatched: missed.slice(0, 20) };
  console.log(`[SleeperSync] syncSleeperIds: ${updated} matched, ${notFound} unmatched`);
  return summary;
}

module.exports = { importSleeperPlayers, syncSleeperIds, importDevyPlayers };

// ---------------------------------------------------------------------------
// importDevyPlayers
// ---------------------------------------------------------------------------
/**
 * Imports college/devy players from Sleeper's player list into our DB.
 * Devy players are identified by years_exp === -1 (never played in NFL).
 * Existing records are updated with isDevy=true; new records are created.
 *
 * Run this once to seed the devy pool, then re-run after each NFL draft to
 * pick up any newly enrolled college prospects Sleeper has added.
 */
async function importDevyPlayers() {
  const sleeperMap = await getAllPlayers('nfl');

  const SKILL_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
  let created = 0, updated = 0, skipped = 0;

  const allEntries = Object.entries(sleeperMap);
  const strictCount = allEntries.reduce((acc, [, sp]) => {
    return parseYearsExp(sp) === -1 ? acc + 1 : acc;
  }, 0);
  const useFallbackHeuristic = strictCount === 0;

  for (const [id, sp] of allEntries) {
    // Primary rule: years_exp === -1.
    // Fallback rule: when Sleeper no longer provides -1 records, use no-team + college + years_exp <= 0.
    const yearsExp = parseYearsExp(sp);
    const isDevy = yearsExp === -1 || (useFallbackHeuristic && isHeuristicDevyCandidate(sp));
    if (!isDevy) { skipped++; continue; }

    const pos = sp.position;
    if (!pos || !SKILL_POSITIONS.has(pos)) { skipped++; continue; }

    const fullName = (sp.full_name || `${sp.first_name || ''} ${sp.last_name || ''}`).trim();
    if (!fullName) { skipped++; continue; }

    const existing = await Player.findOne({ sleeperId: id }).lean();
    if (existing) {
      await Player.updateOne(
        { sleeperId: id },
        {
          $set: {
            isDevy: true,
            team: null,  // devy players have no NFL team
            college: sp.college || existing.college || null,
            currentInjuryStatus: sp.injury_status || 'Active',
          },
        }
      );
      updated++;
    } else {
      await Player.create({
        sleeperId: id,
        name: fullName,
        position: pos,
        team: null,
        age: sp.age || null,
        college: sp.college || null,
        isDevy: true,
        isRookie: false,  // not a current-year rookie — still in college
        ktcValue: 0,
        fantasyProsValue: 0,
        devyKtcValue: 0,
      });
      created++;
    }
  }

  console.log(`[SleeperSync] importDevyPlayers: ${created} created, ${updated} updated, ${skipped} skipped`);
  return { created, updated, skipped };
}