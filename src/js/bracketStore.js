/**
 * Bracket validation helpers (shared by localStorage persistence and tests).
 * Picks shape: { [groupCode]: [teamName, ...] } where array order is the
 * predicted finishing position (index 0 = 1st). The top 2 advance.
 */

import { getGroupOrder, getGroupTeamNames, MAX_RANK } from './bracketData.js';

/** Reserved key inside the `picks` jsonb column for knockout-stage metadata. */
export const KNOCKOUT_META_KEY = '__knockout';

/** Reserved key for real-results knockout picks (separate from personal sim). */
export const KNOCKOUT_REAL_KEY = '__knockout_real';

const KNOCKOUT_MATCH_RE = /^M(7[3-9]|8[0-9]|9[0-9]|10[0-4])$/;

/**
 * Validate knockout metadata stored alongside group picks.
 * Shape: { winners: { [matchId]: 'A'|'B' }, thirdGroups: [groupCode, ...] }
 */
export function validateKnockoutMeta(meta) {
  const out = { winners: {}, thirdGroups: [] };
  if (!meta || typeof meta !== 'object') return out;

  if (meta.winners && typeof meta.winners === 'object') {
    for (const [matchId, side] of Object.entries(meta.winners)) {
      if (KNOCKOUT_MATCH_RE.test(matchId) && (side === 'A' || side === 'B')) {
        out.winners[matchId] = side;
      }
    }
  }

  if (Array.isArray(meta.thirdGroups)) {
    const seen = new Set();
    for (const code of meta.thirdGroups) {
      const group = String(code).toUpperCase();
      if (!getGroupOrder().includes(group) || seen.has(group)) continue;
      seen.add(group);
      out.thirdGroups.push(group);
      if (out.thirdGroups.length >= 8) break;
    }
  }

  return out;
}

/**
 * Validate real-results knockout metadata.
 * Shape: { winners: { [matchId]: 'A'|'B' }, submittedAt?: string }.
 * (No thirdGroups — those are fixed.)
 */
export function validateRealKnockoutMeta(meta) {
  const out = { winners: {}, submittedAt: '' };
  if (!meta || typeof meta !== 'object') return out;

  if (meta.winners && typeof meta.winners === 'object') {
    for (const [matchId, side] of Object.entries(meta.winners)) {
      if (KNOCKOUT_MATCH_RE.test(matchId) && (side === 'A' || side === 'B')) {
        out.winners[matchId] = side;
      }
    }
  }

  if (typeof meta.submittedAt === 'string') {
    const trimmed = meta.submittedAt.trim();
    // Only accept ISO-ish timestamps (e.g. "2026-07-09T06:00:00.000Z").
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) out.submittedAt = trimmed.slice(0, 64);
  }

  return out;
}

/**
 * Split a raw `picks` jsonb payload into validated group picks + knockout meta.
 */
export function extractBracketPayload(raw) {
  const picks = validatePicks(raw);
  const knockout = validateKnockoutMeta(raw?.[KNOCKOUT_META_KEY]);
  const knockoutReal = validateRealKnockoutMeta(raw?.[KNOCKOUT_REAL_KEY]);
  return { picks, knockout, knockoutReal };
}

/**
 * Merge group picks and knockout meta into the shape stored in `picks` jsonb.
 */
export function buildStoredPicks(picks, knockout = null, knockoutReal = null) {
  const clean = validatePicks(picks);
  const meta = validateKnockoutMeta(knockout);
  const hasWinners = Object.keys(meta.winners).length > 0;
  const hasThirds = meta.thirdGroups.length > 0;

  const stored = { ...clean };

  if (hasWinners || hasThirds) {
    stored[KNOCKOUT_META_KEY] = {};
    if (hasWinners) stored[KNOCKOUT_META_KEY].winners = meta.winners;
    if (hasThirds) stored[KNOCKOUT_META_KEY].thirdGroups = meta.thirdGroups;
  }

  const realMeta = validateRealKnockoutMeta(knockoutReal);
  if (Object.keys(realMeta.winners).length > 0 || realMeta.submittedAt) {
    stored[KNOCKOUT_REAL_KEY] = { winners: realMeta.winners };
    if (realMeta.submittedAt) stored[KNOCKOUT_REAL_KEY].submittedAt = realMeta.submittedAt;
  }

  return stored;
}

/**
 * Keep only legitimate picks: real teams for that group, no duplicates, capped
 * at MAX_RANK, original order preserved. Anything else is silently dropped so a
 * tampered or stale payload can never poison the UI or the database.
 */
export function validatePicks(picks) {
  const clean = {};
  if (!picks || typeof picks !== 'object') return clean;

  for (const code of getGroupOrder()) {
    const validTeams = getGroupTeamNames(code);
    const raw = Array.isArray(picks[code]) ? picks[code] : [];
    const seen = new Set();
    const ordered = [];

    for (const name of raw) {
      if (validTeams.includes(name) && !seen.has(name)) {
        seen.add(name);
        ordered.push(name);
        if (ordered.length >= MAX_RANK) break;
      }
    }

    if (ordered.length > 0) clean[code] = ordered;
  }

  return clean;
}
