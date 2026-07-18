/**
 * Bracket image export.
 *
 * Builds a purpose-made, off-screen "branded card" and downloads it as a PNG.
 * Cards are rendered fresh from state rather than screenshotting the live UI,
 * so the export never picks up sticky chrome, scroll position, or viewport size.
 *
 * Final Round export is a podium share card (champion full-width, then
 * runner-up | third) — not a full bracket dump.
 *
 * Dependencies (the html2canvas loader and `document`) are injected with
 * call-time defaults, so importing this module never touches the DOM or pulls
 * in html2canvas — keeping it unit-test friendly and out of the initial bundle.
 */

import { getFlagCode, renderBracket } from './bracketData.js';
import { getPodiumPlacements } from './knockout.js';

const EXPORT_WIDTH = 1024;
const PODIUM_EXPORT_WIDTH = 720;

/** Public share-card host shown in the export header. */
export const EXPORT_BRAND_HOST = 'worldcup.kobexamoh.me';

/** Dated, collision-resistant filename, e.g. `wc-bracket-2026-06-17.png`. */
export function screenshotFilename(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `wc-bracket-${year}-${month}-${day}.png`;
}

/** Slug for filenames: lowercase, keep [a-z0-9], collapse the rest to single dashes, trim. */
function nameSlug(name = '') {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Card title, e.g. "Kobe's World Cup Bracket" (neutral fallback when blank). */
export function personalizedTitle(name = '') {
  const trimmed = String(name).trim();
  return trimmed ? `${trimmed}'s World Cup Bracket` : 'My World Cup Bracket';
}

/** Filename, name-prefixed when given, e.g. `amoh-wc-bracket-2026-06-17.png`. */
export function personalizedFilename(name = '', date = new Date()) {
  const base = screenshotFilename(date);
  const slug = nameSlug(name);
  return slug ? `${slug}-${base}` : base;
}

/** Card title for the official Final Round export. */
export function officialBracketTitle(name = '') {
  const trimmed = String(name).trim();
  return trimmed ? `${trimmed}'s World Cup Finals Predictions` : 'My World Cup Finals Predictions';
}

/** Dated filename for the official Final Round PNG. */
export function officialBracketFilename(name = '', date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const base = `wc-finals-predictions-${year}-${month}-${day}.png`;
  const slug = nameSlug(name);
  return slug ? `${slug}-${base}` : base;
}

// Lazy-load html2canvas only when an export actually happens, so it stays out
// of the initial bundle (Vite code-splits it into its own chunk).
async function defaultLoadHtml2canvas() {
  const mod = await import('html2canvas');
  return mod.default || mod;
}

function appendBrandHead(doc, node, title) {
  const head = doc.createElement('div');
  head.className = 'bracket-export__head';
  const heading = doc.createElement('h2');
  heading.textContent = title;
  const brand = doc.createElement('span');
  brand.textContent = EXPORT_BRAND_HOST;
  head.appendChild(heading);
  head.appendChild(brand);
  node.appendChild(head);
}

function appendFlaggedTeam(doc, parent, teamName, className = 'podium-export__team', flagSize = { w: 28, h: 21 }) {
  const row = doc.createElement('div');
  row.className = className;

  const code = teamName ? getFlagCode(teamName) : null;
  if (code) {
    const img = doc.createElement('img');
    img.src = `/flags/${code}.png`;
    img.alt = '';
    img.className = 'podium-export__flag';
    img.width = flagSize.w;
    img.height = flagSize.h;
    row.appendChild(img);
  }

  const name = doc.createElement('span');
  name.className = 'podium-export__name';
  name.textContent = teamName || '—';
  row.appendChild(name);
  parent.appendChild(row);
}

function appendPlace(doc, parent, placeLabel, medal, teamName, modifier) {
  const block = doc.createElement('div');
  block.className = `podium-export__place podium-export__place--${modifier}`;
  const label = doc.createElement('p');
  label.className = 'podium-export__place-label';
  label.textContent = `${medal} ${placeLabel}`;
  block.appendChild(label);
  const flagSize = modifier === 'first' ? { w: 40, h: 30 } : { w: 28, h: 21 };
  appendFlaggedTeam(doc, block, teamName, 'podium-export__team podium-export__team--hero', flagSize);
  parent.appendChild(block);
}

/**
 * Build the Final Round share card:
 *   [ champion — full width ]
 *   [ runner-up | third ]
 */
export function buildPodiumExportNode(doc, bracket, winners, title, width = PODIUM_EXPORT_WIDTH) {
  const node = doc.createElement('div');
  node.className = 'bracket-export bracket-export--podium';
  node.style.width = `${width}px`;
  appendBrandHead(doc, node, title);

  const podium = getPodiumPlacements(bracket, winners);

  const body = doc.createElement('div');
  body.className = 'podium-export';

  appendPlace(doc, body, 'Champion', '🥇', podium.first, 'first');

  const lower = doc.createElement('div');
  lower.className = 'podium-export__lower-row';
  appendPlace(doc, lower, 'Runner-up', '🥈', podium.second, 'second');
  appendPlace(doc, lower, 'Third place', '🥉', podium.third, 'third');
  body.appendChild(lower);

  node.appendChild(body);
  return node;
}

function buildExportNode(doc, picks, width, title) {
  const node = doc.createElement('div');
  node.className = 'bracket-export';
  node.style.width = `${width}px`;
  appendBrandHead(doc, node, title);

  // renderBracket() returns trusted markup built from the known team list.
  // Hide the per-group Clear control (useless in a static screenshot) and use
  // PNG flags (flagExt:'png') — html2canvas can't reliably rasterize SVG flags
  // on iOS/iPadOS WebKit, but PNGs render identically on every engine.
  node.insertAdjacentHTML('beforeend', renderBracket(picks, { showClearButtons: false, flagExt: 'png' }));
  return node;
}

/**
 * Resolve once every <img> in the node has finished loading (or errored), so the
 * off-screen flag images are actually painted before html2canvas rasterizes the
 * card. The flags are same-origin (served from /flags), so this is a timing
 * guard, not a CORS one. A per-image timeout makes sure a stuck request can
 * never block the download forever.
 */
function waitForImages(node, timeoutMs = 5000) {
  const imgs = Array.from(node.querySelectorAll('img'));
  return Promise.all(
    imgs.map((img) => {
      if (img.complete) return Promise.resolve();
      return new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, timeoutMs);
      });
    })
  );
}

async function rasterizeAndDownload(node, options) {
  const {
    loadHtml2canvas = defaultLoadHtml2canvas,
    doc = document,
    filename,
    width,
  } = options;

  doc.body.appendChild(node);

  try {
    await waitForImages(node);
    const html2canvas = await loadHtml2canvas();
    const canvas = await html2canvas(node, {
      scale: 2,
      backgroundColor: '#ffffff',
      windowWidth: width,
      width,
      useCORS: true,
      logging: false,
    });

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not render the bracket image');

    const url = URL.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = filename;
    doc.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    return filename;
  } finally {
    node.remove();
  }
}

/**
 * Render the branded group-stage card off-screen and trigger a PNG download.
 * Returns the filename used. Throws if the canvas can't be produced.
 */
export async function downloadBracketImage(picks, options = {}) {
  const {
    loadHtml2canvas = defaultLoadHtml2canvas,
    doc = document,
    name = '',
    title = personalizedTitle(name),
    filename = personalizedFilename(name),
    width = EXPORT_WIDTH,
  } = options;

  const node = buildExportNode(doc, picks, width, title);
  return rasterizeAndDownload(node, { loadHtml2canvas, doc, filename, width });
}

/**
 * Render the Final Round podium share card and trigger a PNG download.
 * Signature keeps (bracket, winners, lockedMatches, options) for call-site
 * compatibility; lockedMatches is unused (podium card doesn't need the tree).
 */
export async function downloadOfficialKnockoutImage(bracket, winners, _lockedMatches, options = {}) {
  const {
    loadHtml2canvas = defaultLoadHtml2canvas,
    doc = document,
    name = '',
    title = officialBracketTitle(name),
    filename = officialBracketFilename(name),
    width = PODIUM_EXPORT_WIDTH,
  } = options;

  const node = buildPodiumExportNode(doc, bracket, winners, title, width);
  return rasterizeAndDownload(node, { loadHtml2canvas, doc, filename, width });
}
