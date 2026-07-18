/**
 * Main Application Logic — public Final Round bracket (browser-only persistence).
 */

import { inject } from '@vercel/analytics';
import { renderBracket, getGroupOrder, getGroupTeamNames, getFlagCode, randomPicks, fillBlankRanks, randomizeGroups, ADVANCE_COUNT } from './bracketData.js';
import { downloadBracketImage, downloadOfficialKnockoutImage } from './exportImage.js';
import { celebrate } from './celebrate.js';
import { getThirdPlaceCandidates, buildKnockoutBracket, applyWinnerPick, getPodiumPlacements } from './knockout.js';
import { renderKnockoutTree } from './knockoutRender.js';
import { drawBracketConnectors } from './bracketConnectors.js';
import {
  buildRealResultsBracket,
  applyRealWinnerPick,
  getLockedMatchIds,
} from './realKnockout.js';
import {
  allGroupsRanked,
  isThirdPlaceComplete,
  getStageNavState,
  STAGE_HEADER_LABELS,
  STAGE_HEADER_TAGLINES,
  OFFICIAL_ONLY_MODE,
} from './stageNav.js';
import { saveDraft, readDraft } from './draftStore.js';
import {
  isGroupStageSubmitLocked,
  GROUP_STAGE_LOCK_BANNER,
  GROUP_STAGE_LOCK_SUBMIT_ALERT,
} from './groupStageLock.js';

inject();

// State
let picks = {}; // { [groupCode]: [teamName, ...] } ordered 1st -> 4th
let savedSnapshot = '{}';
let savedKnockoutSnapshot = '{"winners":{},"thirdGroups":[]}';

// Draft autosave: a guarded localStorage handle (private mode can throw on the
// very access) and a debounce timer so we persist shortly after the user stops
// clicking rather than on every single click.
const draftStorage = (() => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
})();
const DRAFT_DEBOUNCE_MS = 500;
const KNOCKOUT_DEBOUNCE_MS = 1200;
let draftTimer = null;
let knockoutTimer = null;

const NAME_STORAGE_KEY = 'wc-bracket:name';

function loadStoredName() {
  if (!draftStorage) return '';
  try {
    return draftStorage.getItem(NAME_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function persistName(name) {
  if (!draftStorage) return;
  try {
    if (name) draftStorage.setItem(NAME_STORAGE_KEY, name);
    else draftStorage.removeItem(NAME_STORAGE_KEY);
  } catch {
    /* private mode / quota - ignore */
  }
}

// ============================================
// UI Helpers
// ============================================

// One in-place status message at a time — never stack. A new message replaces
// whatever's showing (in the bracket's side rail, or the sign-in screen's own
// area). Transient messages auto-clear; errors persist until the next message.
const ALERT_DEFAULT_MS = 6000;
let alertTimer = null;

// Containers a message can live in: the sign-in screen, the desktop rail, and
// the mobile bottom-bar status. CSS shows whichever fits the current breakpoint.
const ALERT_CONTAINER_IDS = ['alerts', 'alertsMobile', 'alertsToolbar'];

function alertTargets() {
  const ids = ['alerts', 'alertsToolbar', 'alertsMobile'];
  return ids.map((id) => document.getElementById(id)).filter(Boolean);
}

function clearAllAlerts() {
  if (alertTimer) {
    clearTimeout(alertTimer);
    alertTimer = null;
  }
  ALERT_CONTAINER_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.replaceChildren();
  });
}

function showAlert(message, type = 'info', options = {}) {
  const targets = alertTargets();
  if (!targets.length) return;
  // Clear any current message everywhere so only one ever shows.
  clearAllAlerts();

  targets.forEach((target) => {
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert ${type}`;
    alertDiv.textContent = message;
    target.replaceChildren(alertDiv);
  });

  // Errors stay until the next action replaces them; everything else fades out.
  const persist = options.persist ?? (type === 'error');
  if (!persist) {
    const ms = options.duration ?? ALERT_DEFAULT_MS;
    alertTimer = setTimeout(() => {
      targets.forEach((target) => target.replaceChildren());
    }, ms);
  }
}

const LAST_STAGE_KEY = 'wc-bracket:last-stage';

function loadLastStage() {
  if (!draftStorage) return '';
  try {
    return String(draftStorage.getItem(LAST_STAGE_KEY) || '');
  } catch {
    return '';
  }
}

function saveLastStage(stage) {
  if (!draftStorage) return;
  try {
    draftStorage.setItem(LAST_STAGE_KEY, stage);
  } catch {
    // ignore
  }
}

function showBracketSection() {
  wasAllGroupsRanked = allGroupsRanked(picks);
  if (!bracketSectionInitialized) {
    // Final week: only Official / Final Round is open — skip remembered group/third/knockout.
    if (OFFICIAL_ONLY_MODE) {
      setActiveStage('officialBracket');
    } else {
      const last = loadLastStage();
      if (last === 'third' && allGroupsRanked(picks)) {
        setActiveStage('third');
      } else if (last === 'knockout' && isThirdPlaceComplete(selectedThirdGroups)) {
        setActiveStage('knockout');
      } else if (last === 'officialBracket') {
        setActiveStage('officialBracket');
      } else if (last === 'groups') {
        setActiveStage('groups');
      } else if (isGroupStageSubmitLocked()) {
        setActiveStage('officialBracket');
      } else {
        setActiveStage('groups');
      }
    }
    bracketSectionInitialized = true;
  }
  refreshSubmitLockUI();
  maybeAutoOpenHelp(); // first-time onboarding overlay (once per browser)
}

// ============================================
// Modals (shared): the how-it-works onboarding overlay and the "Select for me"
// chooser share one accessible open/close + focus-trap implementation.
// ============================================
const helpModal = document.getElementById('helpModal');
const helpBtn = document.getElementById('helpBtn');
const selectModal = document.getElementById('selectModal');
const selectApplyBtn = document.getElementById('selectApplyBtn');
const selectGroupsFieldset = document.getElementById('selectGroupsFieldset');
const selectGroupsGrid = document.getElementById('selectGroupsGrid');
const selectRememberCheckbox = document.getElementById('selectRemember');
const successModal = document.getElementById('successModal');
const successScreenshotBtn = document.getElementById('successScreenshotBtn');
const championModal = document.getElementById('championModal');
const podiumList = document.getElementById('podiumList');
const championScreenshotBtn = document.getElementById('championScreenshotBtn');
const qfHelpModal = document.getElementById('qfHelpModal');
const HELP_SEEN_KEY = 'wc-bracket:seen-help-final-round';

// "Select for me" chooser: the choice remembered for this session
// (only 'blanks' or 'all'; the one-off 'selected' is never remembered).
let sessionSelectMode = null;

// Only one modal is open at a time; track it for the shared Esc/Tab handler.
let activeModal = null;
let activeModalDialog = null;
let lastFocusedBeforeModal = null;

// Generic seen-once flags live in the same guarded localStorage handle as the
// draft (private mode can throw on access).
function flagSeen(key) {
  if (!draftStorage) return false;
  try {
    return draftStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function markFlagSeen(key) {
  if (!draftStorage) return;
  try {
    draftStorage.setItem(key, '1');
  } catch {
    /* private mode / quota - ignore */
  }
}

// Visible, focusable controls inside a container (for the Tab focus-trap).
function getFocusable(container) {
  return Array.from(
    container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.offsetParent !== null);
}

// Esc closes the open modal; Tab cycles within its dialog so focus can't slip behind.
function onModalKeydown(e) {
  if (!activeModal) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal(activeModal);
    return;
  }
  if (e.key !== 'Tab' || !activeModalDialog) return;
  const focusable = getFocusable(activeModalDialog);
  if (!focusable.length) {
    e.preventDefault();
    activeModalDialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === activeModalDialog)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function openModal(modalEl) {
  if (!modalEl) return;
  lastFocusedBeforeModal = document.activeElement;
  activeModal = modalEl;
  activeModalDialog = modalEl.querySelector('.modal__dialog');
  modalEl.hidden = false;
  document.body.style.overflow = 'hidden'; // lock background scroll
  document.addEventListener('keydown', onModalKeydown, true);
  if (activeModalDialog) activeModalDialog.focus(); // move focus in for Esc + screen readers
}

function closeModal(modalEl) {
  if (!modalEl || modalEl.hidden) return;
  modalEl.hidden = true;
  document.body.style.overflow = '';
  document.removeEventListener('keydown', onModalKeydown, true);
  if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === 'function') {
    lastFocusedBeforeModal.focus(); // restore focus to the trigger
  }
  lastFocusedBeforeModal = null;
  activeModal = null;
  activeModalDialog = null;
}

// Auto-open the how-it-works explainer once per browser, the first time the
// bracket appears.
function maybeAutoOpenHelp() {
  if (!helpModal || flagSeen(HELP_SEEN_KEY)) return;
  markFlagSeen(HELP_SEEN_KEY);
  openModal(helpModal);
}

// ============================================
// Bracket UI (interactive ranking)
// ============================================

const bracketEl = document.getElementById('bracket');
const knockoutEl = document.getElementById('knockout');
const saveBtn = document.getElementById('saveBtn');
const deselectBtn = document.getElementById('deselectBtn');
const randomBtn = document.getElementById('randomBtn');
const exportBtn = document.getElementById('exportBtn');
const nameInput = document.getElementById('displayNameInput');
const saveStatusEl = document.getElementById('saveStatus');
const progressTextEl = document.getElementById('progressText');
const progressBarEl = document.getElementById('progressBar');
// Mobile-only mirror controls (the sticky bottom Submit bar)
const saveBtnMobile = document.getElementById('saveBtnMobile');
const progressTextElMobile = document.getElementById('progressTextMobile');

// Multi-screen stage flow: Group Stage → Third Place → Knockout (OG-style tabs).
const bracketSection = document.getElementById('bracketSection');
const bracketLayout = document.getElementById('bracketLayout');
const stageNav = document.getElementById('stageNav');
const headerStageLabel = document.getElementById('headerStageLabel');
const thirdPlaceGrid = document.getElementById('thirdPlaceGrid');
const thirdPlaceCounter = document.getElementById('thirdPlaceCounter');
const groupStageLockBanner = document.getElementById('groupStageLockBanner');
const officialBracketEl = document.getElementById('officialBracket');
const officialBracketTree = document.getElementById('officialBracketTree');
const officialExportBtn = document.getElementById('officialExportBtn');
const officialSubmitBtn = document.getElementById('officialSubmitBtn');
const viewOfficialPodiumBtn = document.getElementById('viewOfficialPodiumBtn');
const officialSaveStatusEl = document.getElementById('officialSaveStatus');

const SUBMIT_LABEL_OPEN = 'Submit bracket';
const SUBMIT_LABEL_LOCKED = 'Submissions closed';
const SUBMIT_TITLE_OPEN = 'Submit your bracket (needs at least 2 picks in every group)';
const SUBMIT_TITLE_LOCKED = 'Group-stage submissions are closed — the real group stage has finished';

const STAGE_AUTO_MS = 600;
let activeStage = 'groups'; // 'groups' | 'third' | 'knockout'
let selectedThirdGroups = []; // 8 group letters
let knockoutWinners = {}; // { [matchId]: 'A'|'B' }
let wasAllGroupsRanked = false;
let stageAutoTimer = null;

// Official Bracket (real-results) state
let officialWinners = {};      // user's own picks for unlocked real-bracket matches
let officialSubmittedAt = '';
let savedOfficialSnapshot = '{"winners":{},"submittedAt":""}';
let officialSaveTimer = null;
let officialSubmitting = false;
const OFFICIAL_DEBOUNCE_MS = 1200;
const OFFICIAL_SUBMIT_LABEL = 'Submit Final Round picks';
const OFFICIAL_RESUBMIT_LABEL = 'Update Final Round picks';

// Only set the initial stage tab once — must not yank the user back on reload.
// but must not yank the user back to Group Stage / Official Bracket.
let bracketSectionInitialized = false;
let championModalContext = 'knockout';

function currentKnockoutMeta() {
  return { winners: knockoutWinners, thirdGroups: selectedThirdGroups };
}

function applyKnockoutMeta(meta = {}) {
  knockoutWinners = meta.winners ? { ...meta.winners } : {};
  selectedThirdGroups = Array.isArray(meta.thirdGroups) ? [...meta.thirdGroups] : [];
  savedKnockoutSnapshot = JSON.stringify(currentKnockoutMeta());
}

function currentOfficialMeta() {
  return { winners: officialWinners, submittedAt: officialSubmittedAt };
}

function applyOfficialMeta(meta = {}) {
  officialWinners = meta?.winners ? { ...meta.winners } : {};
  officialSubmittedAt = typeof meta?.submittedAt === 'string' ? meta.submittedAt : '';
  savedOfficialSnapshot = JSON.stringify(currentOfficialMeta());
}

function hasUnsavedOfficialChanges() {
  return JSON.stringify(currentOfficialMeta()) !== savedOfficialSnapshot;
}

function hasUnsavedKnockoutChanges() {
  return JSON.stringify(currentKnockoutMeta()) !== savedKnockoutSnapshot;
}

function setSaveStatus(text) {
  if (saveStatusEl) saveStatusEl.textContent = text;
}

function setOfficialSaveStatus(text) {
  if (officialSaveStatusEl) officialSaveStatusEl.textContent = text;
}

function isOfficialPodiumComplete() {
  try {
    const { bracket, mergedWinners } = buildRealResultsBracket(officialWinners);
    const podium = getPodiumPlacements(bracket, mergedWinners);
    return Boolean(podium.first && podium.second && podium.third && podium.fourth);
  } catch {
    return false;
  }
}

function refreshOfficialSubmitUI() {
  if (!officialSubmitBtn) return;
  const complete = isOfficialPodiumComplete();
  officialSubmitBtn.hidden = !complete && !officialSubmitting;
  if (viewOfficialPodiumBtn) {
    viewOfficialPodiumBtn.hidden = !complete;
  }
  if (officialSubmitting) {
    officialSubmitBtn.disabled = true;
    officialSubmitBtn.textContent = 'Submitting…';
    return;
  }
  const alreadySubmitted = Boolean(officialSubmittedAt);
  officialSubmitBtn.disabled = !complete;
  officialSubmitBtn.textContent = alreadySubmitted ? OFFICIAL_RESUBMIT_LABEL : OFFICIAL_SUBMIT_LABEL;
  officialSubmitBtn.title = alreadySubmitted
    ? 'Save an updated Official Bracket submission (re-submits are allowed)'
    : 'Submit your official bracket picks (needs champion through 4th place)';
}

// Submit appears twice (desktop toolbar + mobile bottom bar); toggle both together.
function setSubmitButtons(disabled, label) {
  [saveBtn, saveBtnMobile].forEach((btn) => {
    if (!btn) return;
    btn.disabled = disabled;
    btn.textContent = label;
  });
}

/** Reflect env lock: read-only groups, disabled submit + bulk randomizers. */
function refreshSubmitLockUI() {
  const locked = isGroupStageSubmitLocked();

  if (bracketSection) bracketSection.classList.toggle('is-group-stage-locked', locked);
  if (groupStageLockBanner) groupStageLockBanner.hidden = !(locked && activeStage === 'groups');

  if (randomBtn) randomBtn.disabled = locked;
  if (deselectBtn) deselectBtn.disabled = locked;

  const isSubmitting = saveBtn?.textContent === 'Submitting…';
  if (isSubmitting) return;

  [saveBtn, saveBtnMobile].forEach((btn) => {
    if (!btn) return;
    btn.disabled = locked;
    btn.textContent = locked ? SUBMIT_LABEL_LOCKED : SUBMIT_LABEL_OPEN;
    btn.title = locked ? SUBMIT_TITLE_LOCKED : SUBMIT_TITLE_OPEN;
  });
}

function updateProgress() {
  const groups = getGroupOrder();
  const done = groups.filter((code) => (picks[code]?.length || 0) >= ADVANCE_COUNT).length;
  const label = `${done} / ${groups.length} groups set`;
  if (progressTextEl) progressTextEl.textContent = label;
  if (progressTextElMobile) progressTextElMobile.textContent = label;
  if (progressBarEl) progressBarEl.style.transform = `scaleX(${done / groups.length})`;
}

function renderBracketUI() {
  if (!bracketEl) return;
  const locked = isGroupStageSubmitLocked();
  bracketEl.innerHTML = renderBracket(picks, { showClearButtons: !locked });
  updateProgress();
}

function clearStageAutoTimer() {
  if (stageAutoTimer) {
    clearTimeout(stageAutoTimer);
    stageAutoTimer = null;
  }
}

function scheduleStageAdvance(nextStage) {
  clearStageAutoTimer();
  stageAutoTimer = setTimeout(() => {
    stageAutoTimer = null;
    setActiveStage(nextStage);
  }, STAGE_AUTO_MS);
}

function reconcileActiveStage() {
  if (OFFICIAL_ONLY_MODE) {
    if (activeStage !== 'officialBracket') setActiveStage('officialBracket');
    return;
  }
  if (activeStage === 'third' && !allGroupsRanked(picks)) {
    setActiveStage('groups');
    return;
  }
  if (activeStage === 'knockout' && !isThirdPlaceComplete(selectedThirdGroups)) {
    setActiveStage(allGroupsRanked(picks) ? 'third' : 'groups');
  }
}

function updateStageNav() {
  if (!stageNav) return;
  const state = getStageNavState(picks, selectedThirdGroups, activeStage);
  let visibleCount = 0;
  for (const btn of stageNav.querySelectorAll('[data-stage]')) {
    const key = btn.dataset.stage;
    const entry = state[key];
    if (!entry) continue;
    const hidden = !!entry.hidden;
    btn.hidden = hidden;
    if (!hidden) visibleCount += 1;
    btn.classList.toggle('stage-btn--active', entry.active);
    btn.classList.toggle('stage-btn--completed', entry.completed && !entry.active);
    btn.classList.toggle('stage-btn--disabled', !!entry.disabled);
    btn.disabled = !!entry.disabled;
    btn.setAttribute('aria-current', entry.active ? 'step' : 'false');
    if (key === 'officialBracket' && STAGE_HEADER_LABELS.officialBracket) {
      btn.textContent = STAGE_HEADER_LABELS.officialBracket;
    }
  }
  // One usable stage left (or final-week official-only) — hide the tab strip.
  stageNav.hidden = OFFICIAL_ONLY_MODE || visibleCount <= 1;
}

function setActiveStage(stage) {
  if (OFFICIAL_ONLY_MODE) {
    stage = 'officialBracket';
  } else {
    if (stage === 'third' && !allGroupsRanked(picks)) return;
    if (stage === 'knockout' && !isThirdPlaceComplete(selectedThirdGroups)) return;
  }

  clearStageAutoTimer();
  const valid = ['groups', 'third', 'knockout', 'officialBracket'];
  activeStage = valid.includes(stage) ? stage : 'groups';
  saveLastStage(activeStage);

  if (bracketSection) {
    bracketSection.classList.remove(
      'is-stage-groups',
      'is-stage-third',
      'is-stage-knockout',
      'is-stage-officialBracket',
    );
    bracketSection.classList.add(`is-stage-${activeStage}`);
  }
  if (bracketLayout) {
    bracketLayout.classList.toggle('bracket-layout--full', activeStage !== 'groups');
  }
  if (headerStageLabel) {
    headerStageLabel.textContent = STAGE_HEADER_LABELS[activeStage] || STAGE_HEADER_LABELS.groups;
  }
  const headerTagline = document.getElementById('headerTagline');
  if (headerTagline) {
    headerTagline.textContent =
      STAGE_HEADER_TAGLINES[activeStage] || STAGE_HEADER_TAGLINES.groups;
  }
  // Lift the Report-a-bug FAB only when the mobile group-stage submit bar is up.
  document.body.classList.toggle('has-submit-bar-mobile', activeStage === 'groups');

  for (const panel of document.querySelectorAll('[data-stage-panel]')) {
    panel.hidden = panel.dataset.stagePanel !== activeStage;
  }

  updateStageNav();

  if (activeStage === 'third') renderThirdPlaceGrid();
  if (activeStage === 'knockout') renderKnockoutUI();
  if (activeStage === 'officialBracket') renderOfficialBracketUI();

  refreshSubmitLockUI();
  window.scrollTo(0, 0);
}

function updateThirdPlaceCounter() {
  if (!thirdPlaceCounter) return;
  thirdPlaceCounter.textContent = `${selectedThirdGroups.length} / 8 selected`;
}

function escHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderThirdPlaceGrid() {
  if (!thirdPlaceGrid) return;
  const candidates = getThirdPlaceCandidates(picks);
  const chosenSet = new Set(selectedThirdGroups);
  thirdPlaceGrid.innerHTML = candidates
    .map(({ group, team }) => {
      if (!team) return '';
      const selected = chosenSet.has(group);
      const code = getFlagCode(team);
      const flag = code
        ? `<img class="third-place-card__flag team-flag" src="/flags/${code}.svg" alt="" width="28" height="21">`
        : '';
      return `
        <button
          type="button"
          class="third-place-card${selected ? ' is-selected' : ''}"
          data-third-group="${group}"
        >
          ${flag}
          <span class="third-place-card__name">${escHtml(team)}</span>
          <span class="third-place-card__meta">Group ${group} · 3rd</span>
          ${selected ? '<span class="third-place-card__check" aria-hidden="true">✓</span>' : ''}
        </button>
      `;
    })
    .join('');
  updateThirdPlaceCounter();
}

function toggleThirdPlace(group) {
  const prevLen = selectedThirdGroups.length;
  const idx = selectedThirdGroups.indexOf(group);
  if (idx > -1) {
    selectedThirdGroups = selectedThirdGroups.filter((g) => g !== group);
  } else if (selectedThirdGroups.length < 8) {
    selectedThirdGroups = [...selectedThirdGroups, group];
  } else {
    return;
  }

  renderThirdPlaceGrid();
  updateStageNav();
  afterKnockoutChanged();

  if (selectedThirdGroups.length === 8 && prevLen === 7) {
    scheduleStageAdvance('knockout');
  }
}

function renderKnockoutUI() {
  if (!knockoutEl) return;
  const scrollEl = knockoutEl.querySelector('.knockout-scroll');
  const savedScrollLeft = scrollEl ? scrollEl.scrollLeft : 0;

  if (selectedThirdGroups.length !== 8) {
    knockoutEl.innerHTML = `
      <div class="alert info">Select exactly 8 third-place teams on the <strong>Third Place</strong> tab to build the Round of 32.</div>
    `;
    return;
  }
  try {
    const bracket = buildKnockoutBracket(picks, selectedThirdGroups, knockoutWinners);
    knockoutEl.innerHTML = renderKnockoutTree(bracket, knockoutWinners);
  } catch (err) {
    knockoutEl.innerHTML = `<div class="alert error">${err.message}</div>`;
  }

  polishKnockoutViewport(knockoutEl, savedScrollLeft);
}

/**
 * After a knockout tree paint: restore (or auto-center) scroll, draw SVG arms,
 * and surface a swipe/scroll hint when the tree overflows the viewport.
 */
function polishKnockoutViewport(root, savedScrollLeft = 0) {
  if (!root) return;
  const bracketRoot = root.querySelector('.knockout-bracket');
  const scrollEl = root.querySelector('.knockout-scroll');
  const hint = root.querySelector('.knockout-scroll-hint');
  const isEndgame = Boolean(bracketRoot?.classList.contains('knockout-bracket--endgame'));

  const paint = () => {
    // Endgame is center-only (SF/Final/third) — no arms, no sideways scroll choreography.
    if (!isEndgame) {
      drawBracketConnectors(bracketRoot);
    }
    if (!scrollEl) return;

    if (isEndgame) {
      scrollEl.scrollLeft = 0;
      if (hint) hint.hidden = true;
      return;
    }

    if (savedScrollLeft > 0) {
      scrollEl.scrollLeft = savedScrollLeft;
    } else {
      centerKnockoutScroll(scrollEl);
    }

    syncKnockoutScrollHint(scrollEl, hint);
  };

  // Double rAF: wait until layout (and font/flags) settle before measuring arms.
  requestAnimationFrame(() => requestAnimationFrame(paint));
}

function centerKnockoutScroll(scrollEl) {
  const maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth;
  if (maxScroll <= 0) return;
  const center = scrollEl.querySelector('.bracket-center');
  if (!center) {
    scrollEl.scrollLeft = Math.round(maxScroll / 2);
    return;
  }
  const target = center.offsetLeft + center.offsetWidth / 2 - scrollEl.clientWidth / 2;
  scrollEl.scrollLeft = Math.max(0, Math.min(maxScroll, Math.round(target)));
}

function syncKnockoutScrollHint(scrollEl, hint) {
  if (!hint || !scrollEl) return;
  const overflows = scrollEl.scrollWidth > scrollEl.clientWidth + 24;
  if (!overflows) {
    hint.hidden = true;
    return;
  }
  hint.hidden = false;
  if (hint.dataset.bound === '1') return;
  hint.dataset.bound = '1';
  const dismiss = () => {
    hint.hidden = true;
    scrollEl.removeEventListener('scroll', dismiss);
  };
  scrollEl.addEventListener('scroll', dismiss, { passive: true });
}

function openChampionModal() {
  if (!championModal || !podiumList) return;
  championModalContext = 'knockout';
  const championTitle = document.getElementById('championTitle');
  if (championTitle) championTitle.textContent = 'Your knockout podium';
  if (championScreenshotBtn) {
    championScreenshotBtn.disabled = true;
    championScreenshotBtn.title = 'Screenshot export available from the Official Bracket tab';
  }
  const bracket = buildKnockoutBracket(picks, selectedThirdGroups, knockoutWinners);
  const podium = getPodiumPlacements(bracket, knockoutWinners);
  const rows = [
    ['1st place', podium.first],
    ['2nd place', podium.second],
    ['3rd place', podium.third],
    ['4th place', podium.fourth],
  ];
  podiumList.innerHTML = rows
    .map(([label, team]) => {
      const value = team || '— (not picked yet)';
      return `<li class="podium-list__item"><span class="podium-list__place">${label}</span><span class="podium-list__team">${value}</span></li>`;
    })
    .join('');
  openModal(championModal);
  celebrate();
}

// Click a team to assign the next finishing position; click a ranked team to
// clear it (the remaining ranks reflow). Mirrors the original app's UX.
function togglePick(group, teamName) {
  const list = picks[group] ? [...picks[group]] : [];
  const at = list.indexOf(teamName);
  if (at >= 0) {
    list.splice(at, 1);
  } else if (list.length < 4) {
    list.push(teamName);
  }
  if (list.length) picks[group] = list;
  else delete picks[group];
}

function hasUnsavedChanges() {
  return JSON.stringify(picks) !== savedSnapshot;
}

// Persist the in-progress bracket to localStorage so a refresh can't lose it.
// Debounced on each click; drafts may be incomplete (the gated DB Save is the
// real submission). When the picks match the DB again we drop the draft instead.
function scheduleDraftSave() {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, DRAFT_DEBOUNCE_MS);
}

function persistBracketToStorage() {
  const ok = saveDraft(
    draftStorage,
    picks,
    currentKnockoutMeta(),
    currentOfficialMeta(),
  );
  if (ok) {
    savedSnapshot = JSON.stringify(picks);
    savedKnockoutSnapshot = JSON.stringify(currentKnockoutMeta());
    savedOfficialSnapshot = JSON.stringify(currentOfficialMeta());
  }
  return ok;
}

function flushDraft() {
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }

  if (hasUnsavedChanges() || hasUnsavedKnockoutChanges() || hasUnsavedOfficialChanges()) {
    const ok = persistBracketToStorage();
    if (hasUnsavedChanges() || hasUnsavedKnockoutChanges()) {
      setSaveStatus(ok ? 'Saved in this browser' : 'Could not save');
    }
    if (hasUnsavedOfficialChanges()) {
      setOfficialSaveStatus(ok ? 'Saved in this browser' : 'Could not save');
    }
  } else {
    setSaveStatus('');
    setOfficialSaveStatus('');
  }
}

function scheduleKnockoutSave() {
  if (knockoutTimer) clearTimeout(knockoutTimer);
  knockoutTimer = setTimeout(flushKnockoutSave, KNOCKOUT_DEBOUNCE_MS);
}

function flushKnockoutSave() {
  if (knockoutTimer) {
    clearTimeout(knockoutTimer);
    knockoutTimer = null;
  }
  if (hasUnsavedChanges()) return;
  if (!hasUnsavedKnockoutChanges() && !hasUnsavedOfficialChanges()) return;
  flushDraft();
  if (!hasUnsavedKnockoutChanges()) {
    setSaveStatus('Saved ✓');
  }
}

function afterKnockoutChanged() {
  renderKnockoutUI();
  updateStageNav();
  reconcileActiveStage();
  if (hasUnsavedChanges()) {
    setSaveStatus('Saving…');
    scheduleDraftSave();
    return;
  }
  setSaveStatus('Saving…');
  scheduleKnockoutSave();
}

// ── Official Bracket (real results) ──────────────────────────────────────────

function renderOfficialBracketUI() {
  if (!officialBracketTree) return;
  const scrollEl = officialBracketTree.querySelector('.knockout-scroll');
  const savedScrollLeft = scrollEl ? scrollEl.scrollLeft : 0;

  try {
    const { bracket, mergedWinners, lockedSet } = buildRealResultsBracket(officialWinners);
    officialBracketTree.innerHTML = renderKnockoutTree(bracket, mergedWinners, {
      lockedMatches: lockedSet,
      startRound: 'sf',
      hidePodiumCta: true,
    });
  } catch (err) {
    officialBracketTree.innerHTML = `<div class="alert error">${err.message}</div>`;
  }

  polishKnockoutViewport(officialBracketTree, savedScrollLeft);
  refreshOfficialSubmitUI();
}

function scheduleOfficialSave() {
  if (officialSaveTimer) clearTimeout(officialSaveTimer);
  officialSaveTimer = setTimeout(flushOfficialSave, OFFICIAL_DEBOUNCE_MS);
}

function flushOfficialSave() {
  if (officialSaveTimer) {
    clearTimeout(officialSaveTimer);
    officialSaveTimer = null;
  }
  if (!hasUnsavedOfficialChanges()) return;
  flushDraft();
  if (!hasUnsavedOfficialChanges()) {
    setOfficialSaveStatus('Saved ✓');
  }
}

function afterOfficialChanged() {
  renderOfficialBracketUI();
  setOfficialSaveStatus('Saving…');
  scheduleOfficialSave();
}

// Shared post-change routine: re-render, reflect draft status, and autosave.
function afterPicksChanged() {
  renderBracketUI();
  if (!isGroupStageSubmitLocked()) {
    setSaveStatus(hasUnsavedChanges() ? 'Saving…' : '');
    scheduleDraftSave();
  }

  const nowAllRanked = allGroupsRanked(picks);
  if (nowAllRanked && !wasAllGroupsRanked && activeStage === 'groups') {
    scheduleStageAdvance('third');
  }
  wasAllGroupsRanked = nowAllRanked;

  updateStageNav();
  reconcileActiveStage();

  if (activeStage === 'third') renderThirdPlaceGrid();
  if (activeStage === 'knockout') renderKnockoutUI();
}

function onBracketClick(e) {
  if (isGroupStageSubmitLocked()) return;

  // Per-group reset takes priority: it has no data-index, so it isn't a team.
  const clearBtn = e.target.closest('button[data-clear-group]');
  if (clearBtn) {
    clearGroup(clearBtn.dataset.clearGroup);
    return;
  }

  const btn = e.target.closest('button[data-group]');
  if (!btn) return;
  const group = btn.dataset.group;
  const index = Number(btn.dataset.index);
  const teamName = getGroupTeamNames(group)[index];
  if (!teamName) return;

  togglePick(group, teamName);
  afterPicksChanged();
}

// Clear one group's picks; the rest of the bracket is untouched. Single-group
// clears are low-stakes and quickly re-entered, so no confirm (the global
// Deselect all keeps its confirm because it wipes everything).
function clearGroup(group) {
  if (isGroupStageSubmitLocked()) return;
  if (!group || !picks[group]) return; // nothing to clear
  delete picks[group];
  afterPicksChanged();
  // The Clear control just unmounted; move focus to this group's first team so
  // keyboard users aren't dropped to the top of the document.
  const firstTeam = bracketEl?.querySelector(`.group-card[data-group="${group}"] .team-row`);
  if (firstTeam) firstTeam.focus();
}

// Clear every pick at once (with a quick confirm), then autosave the empty draft.
function handleDeselectAll() {
  if (isGroupStageSubmitLocked()) return;
  if (!Object.keys(picks).length) return;
  if (!window.confirm('Clear all your picks?')) return;
  picks = {};
  applyKnockoutMeta({});
  wasAllGroupsRanked = false;
  if (activeStage !== 'groups') setActiveStage('groups');
  afterPicksChanged();
}

// "Select for me" — non-destructive by default. An empty bracket has nothing to
// protect, so just fill all 12; otherwise open the chooser (or apply the choice
// remembered for this session) so the user controls exactly what gets touched.
function handleSelectForMe() {
  if (isGroupStageSubmitLocked()) return;
  const hasPicks = getGroupOrder().some((code) => picks[code]?.length);
  if (!hasPicks) {
    picks = randomPicks();
    afterPicksChanged();
    showAlert('🎲 Filled all 12 groups for you — tweak, then submit.', 'info');
    return;
  }
  if (sessionSelectMode) {
    applySelectForMe(sessionSelectMode);
    return;
  }
  openSelectChooser();
}

// Run a chosen fill mode. `codes` only applies to 'selected'.
function applySelectForMe(mode, codes = []) {
  if (mode === 'all') {
    picks = randomPicks();
    afterPicksChanged();
    showAlert('🎲 Replaced your whole bracket with a fresh random one — tweak, then submit.', 'info');
    return;
  }
  if (mode === 'selected') {
    if (!codes.length) return;
    picks = randomizeGroups(picks, codes);
    afterPicksChanged();
    const n = codes.length;
    showAlert(`🎲 Re-rolled ${n} group${n === 1 ? '' : 's'} (${codes.join(', ')}) — tweak, then submit.`, 'info');
    return;
  }
  // 'blanks' (default, safe): keep every placed team, fill only the empty ranks.
  picks = fillBlankRanks(picks);
  afterPicksChanged();
  showAlert('🎲 Filled the blanks — the teams you already placed stayed put. Tweak, then submit.', 'info');
}

// --- "Select for me" chooser modal ---------------------------------------
// Build the per-group checkboxes once (the group set is static).
function buildSelectGroupChecks() {
  if (!selectGroupsGrid || selectGroupsGrid.childElementCount) return;
  for (const code of getGroupOrder()) {
    const label = document.createElement('label');
    label.className = 'select-groups__item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = code;
    const span = document.createElement('span');
    span.textContent = `Group ${code}`;
    label.append(cb, span);
    selectGroupsGrid.append(label);
  }
}

function selectedChooserMode() {
  const checked = selectModal?.querySelector('input[name="selectMode"]:checked');
  return checked ? checked.value : 'blanks';
}

function checkedGroupCodes() {
  if (!selectGroupsGrid) return [];
  return Array.from(selectGroupsGrid.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => cb.value);
}

// Reflect the chosen radio: reveal the group checklist for 'selected' (and
// disable "don't ask again" there, since a one-off selection can't be
// remembered), label the Apply button, and disable Apply while 'selected' has
// nothing ticked.
function syncChooserState() {
  const mode = selectedChooserMode();
  const isSelected = mode === 'selected';
  if (selectGroupsFieldset) selectGroupsFieldset.hidden = !isSelected;
  if (selectRememberCheckbox) {
    selectRememberCheckbox.disabled = isSelected;
    if (isSelected) selectRememberCheckbox.checked = false;
  }
  if (selectApplyBtn) {
    const labels = { blanks: 'Fill in the blanks', selected: 'Re-roll selected', all: 'Replace everything' };
    selectApplyBtn.textContent = labels[mode] || 'Apply';
    selectApplyBtn.disabled = isSelected && checkedGroupCodes().length === 0;
  }
}

function openSelectChooser() {
  if (!selectModal) {
    applySelectForMe('blanks'); // modal missing (shouldn't happen) — safe default
    return;
  }
  buildSelectGroupChecks();
  const blanksRadio = selectModal.querySelector('input[name="selectMode"][value="blanks"]');
  if (blanksRadio) blanksRadio.checked = true; // reset to the safe default each open
  if (selectGroupsGrid) {
    selectGroupsGrid.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
  }
  if (selectRememberCheckbox) selectRememberCheckbox.checked = false;
  syncChooserState();
  openModal(selectModal);
}

function applyChooserAndClose() {
  const mode = selectedChooserMode();
  const codes = mode === 'selected' ? checkedGroupCodes() : [];
  if (mode === 'selected' && !codes.length) return; // Apply is disabled anyway; guard
  if (selectRememberCheckbox?.checked && mode !== 'selected') sessionSelectMode = mode;
  closeModal(selectModal);
  applySelectForMe(mode, codes);
}

async function handleExport() {
  if (!Object.keys(picks).length) {
    showAlert('Pick at least one team before downloading an image', 'info');
    return;
  }
  if (exportBtn) {
    exportBtn.disabled = true;
    exportBtn.textContent = 'Generating…';
  }
  try {
    const name = nameInput ? nameInput.value : '';
    await downloadBracketImage(picks, { name });
    showAlert('🖼️ Image downloaded', 'success');
  } catch (err) {
    console.error('Export error:', err);
    showAlert(`❌ Could not export image: ${err.message}`, 'error');
  } finally {
    if (exportBtn) {
      exportBtn.disabled = false;
      exportBtn.textContent = 'Screenshot bracket (PNG)';
    }
  }
}

async function handleOfficialExport() {
  if (officialExportBtn) {
    officialExportBtn.disabled = true;
    officialExportBtn.textContent = 'Generating…';
  }
  try {
    const { bracket, mergedWinners, lockedSet } = buildRealResultsBracket(officialWinners);
    const name = nameInput ? nameInput.value : '';
    await downloadOfficialKnockoutImage(bracket, mergedWinners, lockedSet, { name });
    showAlert('🖼️ Image downloaded', 'success');
  } catch (err) {
    console.error('Official export error:', err);
    showAlert(`❌ Could not export image: ${err.message}`, 'error');
  } finally {
    if (officialExportBtn) {
      officialExportBtn.disabled = false;
      officialExportBtn.textContent = 'Screenshot bracket (PNG)';
    }
  }
}

async function handleOfficialSubmit() {
  if (!isOfficialPodiumComplete()) {
    showAlert('❌ Pick champion, runner-up, 3rd, and 4th before submitting', 'error');
    return;
  }
  if (officialSaveTimer) {
    clearTimeout(officialSaveTimer);
    officialSaveTimer = null;
  }
  officialSubmitting = true;
  officialSubmittedAt = new Date().toISOString();
  refreshOfficialSubmitUI();
  setOfficialSaveStatus('Saving…');
  const ok = persistBracketToStorage();
  if (!ok) {
    officialSubmitting = false;
    refreshOfficialSubmitUI();
    setOfficialSaveStatus('Not saved');
    showAlert('❌ Could not save your picks in this browser', 'error');
    return;
  }
  setOfficialSaveStatus('Submitted ✓');
  clearAllAlerts();
  openOfficialChampionModal();
  officialSubmitting = false;
  refreshOfficialSubmitUI();
}

async function handleSave() {
  if (isGroupStageSubmitLocked()) {
    showAlert(GROUP_STAGE_LOCK_SUBMIT_ALERT, 'info', { persist: true });
    return;
  }
  const incomplete = getGroupOrder().filter((code) => (picks[code]?.length || 0) < ADVANCE_COUNT);
  if (incomplete.length) {
    const list = incomplete.slice(0, 4).map((code) => `Group ${code}`).join(', ');
    const more = incomplete.length > 4 ? `, +${incomplete.length - 4} more` : '';
    showAlert(`❌ Pick ${ADVANCE_COUNT} teams in every group before submitting — still need: ${list}${more}`, 'error');
    return;
  }
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }
  setSubmitButtons(true, 'Submitting…');
  setSaveStatus('Submitting…');
  const ok = persistBracketToStorage();
  if (!ok) {
    setSaveStatus('Not saved');
    showAlert('❌ Could not save your bracket in this browser', 'error');
    refreshSubmitLockUI();
    return;
  }
  renderBracketUI();
  setSaveStatus('Submitted ✓');
  if (successModal) {
    clearAllAlerts();
    openModal(successModal);
    celebrate();
  } else {
    showAlert(
      '✅ Bracket saved in this browser — screenshot it or keep tweaking anytime.',
      'success',
      { duration: 9000 },
    );
  }
  refreshSubmitLockUI();
}

// OG-style stage tabs + third-place card grid
if (stageNav) {
  stageNav.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-stage]');
    if (!btn || btn.disabled) return;
    setActiveStage(btn.dataset.stage);
  });
}
if (thirdPlaceGrid) {
  thirdPlaceGrid.addEventListener('click', (e) => {
    const card = e.target.closest('[data-third-group]');
    if (!card) return;
    toggleThirdPlace(card.dataset.thirdGroup);
  });
}

if (knockoutEl) {
  knockoutEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-qf-help]')) {
      openModal(qfHelpModal);
      return;
    }

    if (e.target.closest('#viewPodiumBtn')) {
      openChampionModal();
      return;
    }

    const btn = e.target.closest('button[data-match][data-side]');
    if (!btn) return;
    const matchId = btn.dataset.match;
    const side = btn.dataset.side;
    if (matchId === 'M103' && (!knockoutWinners.M101 || !knockoutWinners.M102)) return;

    const prevChampion = buildKnockoutBracket(picks, selectedThirdGroups, knockoutWinners)?.championTeam || null;
    knockoutWinners = applyWinnerPick(
      knockoutWinners,
      matchId,
      side,
      picks,
      selectedThirdGroups,
    );
    afterKnockoutChanged();

    const nextChampion = buildKnockoutBracket(picks, selectedThirdGroups, knockoutWinners)?.championTeam || null;
    if (!prevChampion && nextChampion) {
      openChampionModal();
    }
  });
}

// Official Bracket click handler: same pick UX but respects locked matches.
if (officialBracketTree) {
  officialBracketTree.addEventListener('click', (e) => {
    if (e.target.closest('#viewPodiumBtn')) {
      openOfficialChampionModal();
      return;
    }

    const btn = e.target.closest('button[data-match][data-side]');
    if (!btn || btn.disabled) return;
    const matchId = btn.dataset.match;
    const side = btn.dataset.side;

    const lockedSet = getLockedMatchIds();
    if (lockedSet.has(matchId)) return;

    if (matchId === 'M103') {
      const { mergedWinners } = buildRealResultsBracket(officialWinners);
      if (!mergedWinners.M101 || !mergedWinners.M102) return;
    }

    const prevBracket = buildRealResultsBracket(officialWinners);
    const prevChampion = prevBracket.bracket.championTeam || null;

    officialWinners = applyRealWinnerPick(officialWinners, matchId, side);
    afterOfficialChanged();

    const nextBracket = buildRealResultsBracket(officialWinners);
    const nextChampion = nextBracket.bracket.championTeam || null;
    if (!prevChampion && nextChampion) {
      openOfficialChampionModal();
    }
  });
}

function openOfficialChampionModal() {
  if (!championModal || !podiumList) return;
  championModalContext = 'official';
  const championTitle = document.getElementById('championTitle');
  if (championTitle) championTitle.textContent = 'Your official bracket podium';
  if (championScreenshotBtn) {
    championScreenshotBtn.disabled = false;
    championScreenshotBtn.title = 'Download your official bracket as an image';
  }
  const { bracket, mergedWinners } = buildRealResultsBracket(officialWinners);
  const podium = getPodiumPlacements(bracket, mergedWinners);
  const rows = [
    ['1st place', podium.first],
    ['2nd place', podium.second],
    ['3rd place', podium.third],
    ['4th place', podium.fourth],
  ];
  podiumList.innerHTML = rows
    .map(([label, team]) => {
      const value = team || '— (not picked yet)';
      return `<li class="podium-list__item"><span class="podium-list__place">${label}</span><span class="podium-list__team">${value}</span></li>`;
    })
    .join('');
  openModal(championModal);
  celebrate();
}

// ============================================
// Bracket Data
// ============================================

function loadBracketFromStorage() {
  renderBracketUI();

  const saved = readDraft(draftStorage);
  const lockActive = isGroupStageSubmitLocked();

  if (saved) {
    picks = saved.picks;
    applyKnockoutMeta(saved.knockout);
    applyOfficialMeta(saved.official);
    savedSnapshot = JSON.stringify(picks);
    savedKnockoutSnapshot = JSON.stringify(currentKnockoutMeta());
    savedOfficialSnapshot = JSON.stringify(currentOfficialMeta());
    renderBracketUI();
    wasAllGroupsRanked = allGroupsRanked(picks);
    updateStageNav();
    if (activeStage === 'third') renderThirdPlaceGrid();
    if (activeStage === 'knockout') renderKnockoutUI();
    if (activeStage === 'officialBracket') renderOfficialBracketUI();
    setSaveStatus('Loaded your saved picks');
    if (lockActive) {
      showAlert(GROUP_STAGE_LOCK_BANNER, 'info', { persist: true });
    }
  } else if (lockActive) {
    showAlert(GROUP_STAGE_LOCK_BANNER, 'info', { persist: true });
  }

  refreshSubmitLockUI();
}

function initApp() {
  if (nameInput) nameInput.value = loadStoredName();
  loadBracketFromStorage();
  showBracketSection();
}

// ============================================
// Event Listeners
// ============================================

if (saveBtn) saveBtn.addEventListener('click', handleSave);
if (saveBtnMobile) saveBtnMobile.addEventListener('click', handleSave);
if (deselectBtn) deselectBtn.addEventListener('click', handleDeselectAll);
if (randomBtn) randomBtn.addEventListener('click', handleSelectForMe);
if (exportBtn) exportBtn.addEventListener('click', handleExport);
if (officialExportBtn) officialExportBtn.addEventListener('click', handleOfficialExport);
if (officialSubmitBtn) officialSubmitBtn.addEventListener('click', handleOfficialSubmit);
if (viewOfficialPodiumBtn) {
  viewOfficialPodiumBtn.addEventListener('click', () => openOfficialChampionModal());
}
if (nameInput) nameInput.addEventListener('input', () => {
  persistName(nameInput.value.trim());
});
if (bracketEl) bracketEl.addEventListener('click', onBracketClick);

// How-it-works modal: open from the header button; close via ×, "Got it", or backdrop.
if (helpBtn) helpBtn.addEventListener('click', () => openModal(helpModal));
const helpBtnOfficial = document.getElementById('helpBtnOfficial');
if (helpBtnOfficial) helpBtnOfficial.addEventListener('click', () => openModal(helpModal));
if (helpModal) {
  helpModal.querySelectorAll('[data-close-help]').forEach((el) => {
    el.addEventListener('click', () => closeModal(helpModal));
  });
}

// "Select for me" chooser: radios re-sync the dialog (reveal group checklist,
// toggle remember + Apply label), the checklist enables/disables Apply, close
// controls dismiss, and Apply runs the chosen fill.
if (selectModal) {
  selectModal.querySelectorAll('[data-close-select]').forEach((el) => {
    el.addEventListener('click', () => closeModal(selectModal));
  });
  selectModal.querySelectorAll('input[name="selectMode"]').forEach((radio) => {
    radio.addEventListener('change', syncChooserState);
  });
}
if (selectGroupsGrid) selectGroupsGrid.addEventListener('change', syncChooserState);
if (selectApplyBtn) selectApplyBtn.addEventListener('click', applyChooserAndClose);

// Submit-success modal: close via ×, Done, or backdrop; "Screenshot my bracket"
// closes the celebration and reuses the existing export handler.
if (successModal) {
  successModal.querySelectorAll('[data-close-success]').forEach((el) => {
    el.addEventListener('click', () => closeModal(successModal));
  });
}
if (successScreenshotBtn) {
  successScreenshotBtn.addEventListener('click', () => {
    closeModal(successModal);
    handleExport();
  });
}

if (championScreenshotBtn) {
  championScreenshotBtn.addEventListener('click', () => {
    closeModal(championModal);
    if (championModalContext === 'official') {
      handleOfficialExport();
    }
  });
}

if (championModal) {
  championModal.querySelectorAll('[data-close-champion]').forEach((el) => {
    el.addEventListener('click', () => closeModal(championModal));
  });
}

if (qfHelpModal) {
  qfHelpModal.querySelectorAll('[data-close-qf-help]').forEach((el) => {
    el.addEventListener('click', () => closeModal(qfHelpModal));
  });
}

// Flush a pending draft synchronously before the page is hidden or unloaded, so
// a refresh inside the debounce window still persists the latest picks.
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (draftTimer) flushDraft();
    if (knockoutTimer) flushKnockoutSave();
    if (officialSaveTimer) flushOfficialSave();
  }
});
window.addEventListener('pagehide', () => {
  if (draftTimer) flushDraft();
  if (knockoutTimer) flushKnockoutSave();
  if (officialSaveTimer) flushOfficialSave();
});

// Keep SVG connector arms aligned after orientation / window resize.
let connectorResizeTimer = null;
window.addEventListener('resize', () => {
  if (connectorResizeTimer) clearTimeout(connectorResizeTimer);
  connectorResizeTimer = setTimeout(() => {
    for (const root of [knockoutEl, officialBracketTree]) {
      if (!root) continue;
      const bracketRoot = root.querySelector('.knockout-bracket');
      if (bracketRoot) drawBracketConnectors(bracketRoot);
      const scrollEl = root.querySelector('.knockout-scroll');
      const hint = root.querySelector('.knockout-scroll-hint');
      if (scrollEl && hint) syncKnockoutScrollHint(scrollEl, hint);
    }
  }, 120);
});

// "Your name" help tip (?): click to toggle; Esc / outside click to close.
const nameFieldHelpBtn = document.getElementById('nameFieldHelpBtn');
const nameFieldTip = document.getElementById('nameFieldTip');
function setNameFieldTipOpen(open) {
  if (!nameFieldTip || !nameFieldHelpBtn) return;
  nameFieldTip.hidden = !open;
  nameFieldHelpBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
if (nameFieldHelpBtn && nameFieldTip) {
  nameFieldHelpBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setNameFieldTipOpen(nameFieldTip.hidden);
  });
  document.addEventListener('click', (e) => {
    if (nameFieldTip.hidden) return;
    if (e.target.closest('.name-field')) return;
    setNameFieldTipOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setNameFieldTipOpen(false);
  });
}

document.addEventListener('DOMContentLoaded', initApp);
