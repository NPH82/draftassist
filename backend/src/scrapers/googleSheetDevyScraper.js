/**
 * Google Sheets devy scraper
 * Fetches the publicly shared devy rankings sheet (CSV export) and returns
 * every ranked prospect row so offensive devy and IDP leagues can share one
 * source of truth.
 *
 * Sheet columns: Rank, Player, Position, Forty, AvgPosRank, AvgOvrRank, Rating
 */

const axios = require('axios');

const SHEET_CSV_URL =
  'https://docs.google.com/spreadsheets/d/1BCju7HvBz-SUce6ge9DHUYdvSTB1T2LKUd8BahDncW8/export?format=csv&gid=0';

/**
 * Parses a raw CSV string into an array of row objects.
 * Handles quoted fields (including those containing commas).
 */
function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (!lines.length) return [];

  const parseRow = (line) => {
    const fields = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        fields.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur.trim());
    return fields;
  };

  const headers = parseRow(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = parseRow(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] ?? ''; });
    rows.push(row);
  }
  return rows;
}

async function fetchDevyRankingsSheet() {
  const res = await axios.get(SHEET_CSV_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 15000,
    responseType: 'text',
  });

  const rows = parseCsv(res.data);
  const players = [];

  for (const row of rows) {
    const position = (row['position'] || '').trim().toUpperCase();
    const rankRaw = parseInt(row['rank'], 10);
    if (!row['player'] || !position || isNaN(rankRaw)) continue;

    players.push({
      name: row['player'].trim(),
      position,
      sheetRank: rankRaw,
      rating: parseFloat(row['rating']) || null,
      avgPosRank: parseFloat(row['avgposrank']) || null,
      avgOvrRank: parseFloat(row['avgovrrank']) || null,
      fortyTime: parseFloat(row['forty']) || null,
    });
  }

  return players;
}

module.exports = { fetchDevyRankingsSheet };
