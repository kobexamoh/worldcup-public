import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRACKET_STORAGE_KEY,
  draftKey,
  saveDraft,
  readDraft,
  clearDraft,
  shouldRestoreDraft,
} from '../src/js/draftStore.js';

function makeStorage(overrides = {}) {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    map,
    ...overrides,
  };
}

test('draftKey uses the public storage key', () => {
  assert.equal(draftKey('public'), BRACKET_STORAGE_KEY);
});

test('saveDraft + readDraft round-trips picks and metadata', () => {
  const storage = makeStorage();
  const ok = saveDraft(
    storage,
    { A: ['Mexico', 'South Africa'] },
    { winners: { M101: 'A' }, thirdGroups: ['E'] },
    { winners: { M104: 'B' }, submittedAt: '2026-07-18T12:00:00.000Z' },
    1234,
  );

  assert.equal(ok, true);
  const draft = readDraft(storage);
  assert.deepEqual(draft.picks, { A: ['Mexico', 'South Africa'] });
  assert.deepEqual(draft.knockout.winners, { M101: 'A' });
  assert.deepEqual(draft.knockout.thirdGroups, ['E']);
  assert.deepEqual(draft.official.winners, { M104: 'B' });
  assert.equal(draft.official.submittedAt, '2026-07-18T12:00:00.000Z');
  assert.equal(draft.updatedAt, 1234);
});

test('saveDraft validates before storing (drops unknown teams and duplicates)', () => {
  const storage = makeStorage();
  saveDraft(storage, { A: ['Mexico', 'Mexico', 'Atlantis', 'South Africa'] });

  assert.deepEqual(readDraft(storage).picks, { A: ['Mexico', 'South Africa'] });
});

test('readDraft returns null when there is no draft', () => {
  assert.equal(readDraft(makeStorage()), null);
});

test('readDraft returns null when the draft is empty after validation', () => {
  const storage = makeStorage();
  storage.setItem(BRACKET_STORAGE_KEY, JSON.stringify({ stored: { A: ['Atlantis'] } }));

  assert.equal(readDraft(storage), null);
});

test('readDraft returns null on malformed JSON instead of throwing', () => {
  const storage = makeStorage();
  storage.setItem(BRACKET_STORAGE_KEY, 'not-json{');

  assert.doesNotThrow(() => readDraft(storage));
  assert.equal(readDraft(storage), null);
});

test('clearDraft removes the stored draft', () => {
  const storage = makeStorage();
  saveDraft(storage, { A: ['Mexico', 'South Africa'] });
  clearDraft(storage);

  assert.equal(readDraft(storage), null);
});

test('saveDraft / readDraft fail quietly when storage is missing', () => {
  assert.equal(saveDraft(null, { A: ['Mexico'] }), false);
  assert.equal(readDraft(null), null);
});

test('saveDraft returns false and never throws when storage rejects writes', () => {
  const throwing = makeStorage({ setItem: () => { throw new Error('QuotaExceeded'); } });

  assert.doesNotThrow(() => saveDraft(throwing, { A: ['Mexico', 'South Africa'] }));
  assert.equal(saveDraft(throwing, { A: ['Mexico', 'South Africa'] }), false);
});

test('shouldRestoreDraft is true when a draft exists', () => {
  assert.equal(shouldRestoreDraft(null), false);
  assert.equal(shouldRestoreDraft({ picks: {} }), true);
});
