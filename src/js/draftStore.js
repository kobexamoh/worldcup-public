/**
 * Browser-only bracket persistence (localStorage).
 *
 * All picks — group stage, personal knockout, and official Final Round — live
 * in one validated payload per browser. No server sync.
 */

import {
  validatePicks,
  validateKnockoutMeta,
  validateRealKnockoutMeta,
  buildStoredPicks,
  extractBracketPayload,
} from './bracketStore.js';

export const BRACKET_STORAGE_KEY = 'wc-bracket-public';

/** @deprecated Kept for tests that assert key shape. */
export function draftKey(userId = 'public') {
  return userId === 'public' ? BRACKET_STORAGE_KEY : `wc-bracket-draft:${userId}`;
}

/**
 * Persist the full bracket state. Returns false when storage is unavailable.
 */
export function saveDraft(
  storage,
  picks,
  knockout = null,
  official = null,
  now = Date.now(),
) {
  if (!storage) return false;
  try {
    const stored = buildStoredPicks(picks, knockout, official);
    storage.setItem(
      BRACKET_STORAGE_KEY,
      JSON.stringify({ stored, updatedAt: now }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Read saved bracket state. Returns null when missing or invalid.
 */
export function readDraft(storage) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(BRACKET_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const { picks, knockout, knockoutReal } = extractBracketPayload(parsed?.stored ?? parsed);
    if (
      Object.keys(picks).length === 0
      && Object.keys(knockout.winners).length === 0
      && knockout.thirdGroups.length === 0
      && Object.keys(knockoutReal.winners).length === 0
      && !knockoutReal.submittedAt
    ) {
      return null;
    }

    return {
      picks,
      knockout,
      official: knockoutReal,
      updatedAt: parsed?.updatedAt ?? null,
    };
  } catch {
    return null;
  }
}

export function clearDraft(storage) {
  if (!storage) return;
  try {
    storage.removeItem(BRACKET_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** @deprecated No DB sync in the public app — always restore when a draft exists. */
export function shouldRestoreDraft(draft) {
  return Boolean(draft);
}
