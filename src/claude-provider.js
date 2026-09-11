const { basename } = require('path');
const { AGENT_SESSION_GUIDE, hasClaudeSystemPrompt } = require('./agent-session-guide');
const screen = require('./claude-screen');
const { createClaudeSettings, removeClaudeSettings } = require('./claude-settings');
const { claudeContextUsage } = require('./context-usage');

const claudeProvider = {
  id: 'claude-code',
  command: 'claude',
  supportsAsk: true,
  closeInput: '\x04\x04',
  interruptInput: '\x1b',
  // Stop supplies the canonical reply; the screen remains preview/menu input, never final-message truth.
  finalizeOnStop: true,
  screenFinalFallback: false,
  requiresResumeTranscript: true,
  screen,
  requiresSessionStart: true,
  contextUsage: claudeContextUsage,
  model: (payload) => payload.model?.display_name || payload.model?.id,
  finalText(payload) {
    return String(payload.last_assistant_message || '').trim();
  },
  resumeMetadata(payload) {
    const transcriptPath = String(payload.transcript_path || '').trim();
    const transcriptId = transcriptPath ? basename(transcriptPath, '.jsonl') : '';
    return {
      handle: transcriptId || String(payload.session_id || '').trim(),
      transcriptPath,
    };
  },
  createLaunch({ command, port, sessionId, resumeHandle, agentGuide, extraArgs = [], serverUrl }) {
    const settingsPath = createClaudeSettings(port, sessionId, serverUrl);
    const args = ['--settings', settingsPath];
    if (!hasClaudeSystemPrompt(command, extraArgs)) {
      args.push('--append-system-prompt', agentGuide || AGENT_SESSION_GUIDE);
    }
    if (resumeHandle) args.push('--resume', resumeHandle);
    return {
      command: command || this.command,
      args,
      cleanup: () => removeClaudeSettings(settingsPath),
    };
  },
};

module.exports = { claudeProvider };
