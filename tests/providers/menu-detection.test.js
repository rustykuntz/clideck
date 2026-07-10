// Menu/approval detection is the one lifecycle piece that is client-coupled: in
// the real app the browser captures the visible terminal grid and posts the
// lines back, and only then does the server run transcript.detectMenu(). A
// headless smoke run has no grid, so we cover this surface cheaply and reliably
// by unit-testing detectMenu() against representative menu frames per provider.
//
// When a provider changes its approval-menu layout, these fixtures break first —
// which is exactly the regression we want to catch. Refresh the fixtures (and
// add new providers) by capturing a real menu frame from the app.
//
//   node tests/providers/menu-detection.test.js

const assert = require('assert');
const { detectMenu } = require('../../transcript');

// A Claude tool-permission prompt: arrow on the selected row, numbered choices,
// an (esc) footer.
const claudeMenu = [
  '⏺ Bash(rm -rf build)',
  '',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again this session",
  '  3. No, and tell Claude what to do differently (esc)',
];

// A Codex approval menu uses › as the selection marker.
const codexMenu = [
  '• Running command',
  'Allow Codex to run this command?',
  '› 1. Yes, allow',
  '  2. No, keep working (esc)',
];

// A Gemini confirmation menu uses ● as the selection marker.
const geminiMenu = [
  '✦ I will edit the file.',
  'Apply this change?',
  '● 1. Yes, allow once',
  '  2. No (esc)',
];

// Plain agent output — no menu present.
const notAMenu = [
  '⏺ Here is the answer you asked for.',
  'READY',
  '',
];

const cases = [
  ['claude-code', claudeMenu, 3, '1'],
  // antigravity is a claude-code fork: same menu chrome, detected via lineage.
  // Locks the contract that antigravity keeps inheriting claude-code parsing.
  ['antigravity', claudeMenu, 3, '1'],
  ['codex', codexMenu, 2, '1'],
  ['gemini-cli', geminiMenu, 2, '1'],
];

let failed = 0;
for (const [presetId, lines, expectedCount, selectedValue] of cases) {
  try {
    const choices = detectMenu(lines, presetId);
    assert(Array.isArray(choices), `${presetId}: expected choices array, got ${choices}`);
    assert.strictEqual(choices.length, expectedCount, `${presetId}: expected ${expectedCount} choices, got ${choices.length}`);
    const selected = choices.find((c) => c.selected);
    assert(selected, `${presetId}: no choice marked selected`);
    assert.strictEqual(selected.value, selectedValue, `${presetId}: expected choice ${selectedValue} selected, got ${selected.value}`);
    console.log(`  \x1b[32mPASS\x1b[0m  ${presetId}  (${choices.length} choices, selected ${selected.value}: "${selected.label}")`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${presetId}  ${e.message}`);
  }
}

// Negative case: non-menu output must not be detected as a menu.
try {
  for (const presetId of ['claude-code', 'codex', 'gemini-cli']) {
    assert.strictEqual(detectMenu(notAMenu, presetId), null, `${presetId}: false-positive menu on plain output`);
  }
  console.log('  \x1b[32mPASS\x1b[0m  negative (plain output → no menu)');
} catch (e) {
  failed++;
  console.log(`  \x1b[31mFAIL\x1b[0m  negative  ${e.message}`);
}

console.log('');
process.exit(failed ? 1 : 0);
