// Preset lineage — some agents are forks of another agent's CLI and render an
// (essentially) identical TUI, so they can reuse the parent's transcript, menu,
// and turn-marker logic instead of duplicating it.
//
// antigravity (Google's `agy` CLI) is a Claude Code fork: same output marker (⏺),
// same menu chrome (❯ ›), same interactive-prompt rendering. Declaring its lineage
// as 'claude-code' lets the transcript/marker subsystem treat it as claude-code
// WITHOUT collapsing its identity (tile, icon, resume command stay antigravity).
//
// The mapping is derived from the `lineage` field on each preset in
// agent-presets.json — that file is the single source of truth. Read directly
// (not via config.js) to avoid a require cycle, since the transcript modules that
// consume lineageOf are themselves required by config's dependency graph.
//
// NOTE: lineage covers only *rendering/parsing* reuse. It deliberately does NOT
// extend to claude-code's push-status mechanisms (hook patching of ~/.claude, OTEL
// telemetry) — agy exposes neither, so those paths stay claude-code-only and agy
// falls back to clideck's generic PTY heuristics for working/idle.
const { readFileSync } = require('fs');
const { join } = require('path');

const LINEAGE = {};
try {
  const presets = JSON.parse(readFileSync(join(__dirname, 'agent-presets.json'), 'utf8'));
  for (const p of presets) {
    if (p && p.presetId && p.lineage) LINEAGE[p.presetId] = p.lineage;
  }
} catch { /* fall back to identity mapping if presets can't be read */ }

function lineageOf(presetId) {
  return LINEAGE[presetId] || presetId;
}

module.exports = { lineageOf, LINEAGE };
