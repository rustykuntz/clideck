// @vitest-environment node
//
// Terminal-display-sizing phase — config DEFAULTS contract.
//
// Both `terminalFontSize` (PLAN-fontsize) and `sidebarWidth` (PLAN-sidebar)
// must appear in config.js DEFAULTS so they:
//   - auto-backfill into existing config.json files on first load
//     (via `{ ...deepCopy(DEFAULTS), ...JSON.parse(...) }` at config.js:201)
//   - have a documented default value pinned by a test that can't drift
//
// Isolated via mkdtempSync + CLIDECK_DATA_DIR so the test never touches
// the developer's real config. Mirrors tests/session-reorder.test.js
// setup/teardown.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { mkdtempSync, rmSync } from 'fs';

let TEST_DATA_DIR;

function freshConfig() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(`${sep}clideck${sep}`) && !k.includes('node_modules')) {
      delete require.cache[k];
    }
  }
  return require('../config.js');
}

beforeEach(() => {
  TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'clideck-config-defaults-'));
  process.env.CLIDECK_DATA_DIR = TEST_DATA_DIR;
});

afterEach(() => {
  delete process.env.CLIDECK_DATA_DIR;
  try { rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
});

describe('config DEFAULTS — terminal display sizing', () => {
  it('terminalFontSize defaults to 13', () => {
    const { load } = freshConfig();
    const cfg = load();
    expect(cfg.terminalFontSize).toBe(13);
  });

  it('sidebarWidth defaults to 354', () => {
    const { load } = freshConfig();
    const cfg = load();
    expect(cfg.sidebarWidth).toBe(354);
  });
});
