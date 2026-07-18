import test from 'node:test';
import assert from 'node:assert/strict';

import {
  screenshotFilename,
  personalizedTitle,
  personalizedFilename,
  officialBracketTitle,
  officialBracketFilename,
  EXPORT_BRAND_HOST,
  buildPodiumExportNode,
} from '../src/js/exportImage.js';

/** Minimal DOM stub — enough for buildPodiumExportNode without jsdom. */
function fakeDoc() {
  const createEl = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      className: '',
      textContent: '',
      style: {},
      children: [],
      attrs: {},
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      querySelector(sel) {
        return query(this, sel);
      },
      querySelectorAll(sel) {
        return queryAll(this, sel);
      },
    };
    // Property mirrors used by the builder
    Object.defineProperty(el, 'src', {
      get() {
        return this.attrs.src || '';
      },
      set(v) {
        this.attrs.src = v;
      },
    });
    Object.defineProperty(el, 'alt', {
      get() {
        return this.attrs.alt || '';
      },
      set(v) {
        this.attrs.alt = v;
      },
    });
    Object.defineProperty(el, 'width', {
      get() {
        return this.attrs.width;
      },
      set(v) {
        this.attrs.width = v;
      },
    });
    Object.defineProperty(el, 'height', {
      get() {
        return this.attrs.height;
      },
      set(v) {
        this.attrs.height = v;
      },
    });
    return el;
  };

  function matches(el, sel) {
    if (sel.startsWith('.')) {
      const want = sel.slice(1).split('.').filter(Boolean);
      const have = String(el.className || '').split(/\s+/).filter(Boolean);
      return want.every((c) => have.includes(c));
    }
    return el.tagName === String(sel).toUpperCase();
  }

  function query(root, sel) {
    const parts = sel.trim().split(/\s+/);
    let nodes = [root];
    for (const part of parts) {
      const next = [];
      for (const n of nodes) {
        const walk = (node) => {
          for (const child of node.children || []) {
            if (matches(child, part)) next.push(child);
            walk(child);
          }
        };
        walk(n);
      }
      nodes = next;
    }
    return nodes[0] || null;
  }

  function queryAll(root, sel) {
    const parts = sel.trim().split(/\s+/);
    let nodes = [root];
    for (const part of parts) {
      const next = [];
      for (const n of nodes) {
        const walk = (node) => {
          for (const child of node.children || []) {
            if (matches(child, part)) next.push(child);
            walk(child);
          }
        };
        walk(n);
      }
      nodes = next;
    }
    return nodes;
  }

  return { createElement: createEl };
}

test('screenshotFilename zero-pads month and day', () => {
  assert.equal(screenshotFilename(new Date(2026, 0, 5)), 'wc-bracket-2026-01-05.png');
  assert.equal(screenshotFilename(new Date(2026, 11, 25)), 'wc-bracket-2026-12-25.png');
});

test('screenshotFilename defaults to today in the expected shape', () => {
  assert.match(screenshotFilename(), /^wc-bracket-\d{4}-\d{2}-\d{2}\.png$/);
});

test('personalizedTitle uses the name, with a neutral fallback when blank', () => {
  assert.equal(personalizedTitle('Kobe'), "Kobe's World Cup Bracket");
  assert.equal(personalizedTitle('  Amoh  '), "Amoh's World Cup Bracket");
  assert.equal(personalizedTitle('   '), 'My World Cup Bracket');
  assert.equal(personalizedTitle(), 'My World Cup Bracket');
});

test('personalizedFilename slugifies the name and prefixes the dated base', () => {
  assert.equal(personalizedFilename('amoh', new Date(2026, 5, 17)), 'amoh-wc-bracket-2026-06-17.png');
  assert.equal(personalizedFilename('Kobe Amoh', new Date(2026, 5, 17)), 'kobe-amoh-wc-bracket-2026-06-17.png');
  assert.equal(personalizedFilename('   ', new Date(2026, 5, 17)), 'wc-bracket-2026-06-17.png');
  assert.equal(personalizedFilename('', new Date(2026, 0, 5)), 'wc-bracket-2026-01-05.png');
});

test('officialBracketTitle uses the name, with a neutral fallback when blank', () => {
  assert.equal(officialBracketTitle('Kobe'), "Kobe's World Cup Finals Predictions");
  assert.equal(officialBracketTitle('   '), 'My World Cup Finals Predictions');
});

test('officialBracketFilename slugifies the name and prefixes the dated base', () => {
  assert.equal(officialBracketFilename('amoh', new Date(2026, 6, 6)), 'amoh-wc-finals-predictions-2026-07-06.png');
  assert.equal(officialBracketFilename('', new Date(2026, 6, 6)), 'wc-finals-predictions-2026-07-06.png');
});

test('export brand host is the public subdomain', () => {
  assert.equal(EXPORT_BRAND_HOST, 'worldcup.kobexamoh.me');
});

test('buildPodiumExportNode renders champion full-width then runner-up / third row', () => {
  const doc = fakeDoc();
  const bracket = {
    final: [{ id: 'M104', a: { team: 'Spain' }, b: { team: 'Argentina' } }],
    thirdPlace: [{ id: 'M103', a: { team: 'France' }, b: { team: 'England' } }],
  };
  const winners = { M104: 'B', M103: 'B' }; // Argentina champion, England third
  const node = buildPodiumExportNode(doc, bracket, winners, "Kobe's World Cup Finals Predictions");

  assert.equal(node.querySelector('.bracket-export__head span')?.textContent, 'worldcup.kobexamoh.me');
  const names = node
    .querySelectorAll('.podium-export__place .podium-export__name')
    .map((el) => el.textContent);
  assert.deepEqual(names, ['Argentina', 'Spain', 'England']);
  assert.ok(node.querySelector('.podium-export__place--first'));
  assert.ok(node.querySelector('.podium-export__lower-row'));
  assert.equal(node.querySelectorAll('.podium-export__sf').length, 0);
});
