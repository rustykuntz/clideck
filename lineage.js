// Preset lineage — some agents are forks of another agent's CLI and render an
// (essentially) identical TUI, so they can reuse the parent's transcript, menu,
// and turn-marker logic instead of duplicating it.
//
// antigravity (Google's `agy` CLI) is a Claude Code fork: same output marker (⏺),
// same menu chrome (❯ ›), same interactive-prompt rendering. Declaring its lineage
// as 'claude-code' lets the transcript/marker subsystem treat it as claude-code
// WITHOUT collapsing its identity (tile, icon, resume command stay antigravity).
//
// NOTE: lineage covers only *rendering/parsing* reuse. It deliberately does NOT
// extend to claude-code's push-status mechanisms (hook patching of ~/.claude, OTEL
// telemetry) — agy exposes neither, so those paths stay claude-code-only and agy
// falls back to clideck's generic PTY heuristics for working/idle.
const LINEAGE = { antigravity: 'claude-code' };

function lineageOf(presetId) {
  return LINEAGE[presetId] || presetId;
}

module.exports = { lineageOf, LINEAGE };
