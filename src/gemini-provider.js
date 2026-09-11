const screen = require('./gemini-screen');
const { createGeminiSettings, removeGeminiSettings } = require('./gemini-settings');

const geminiProvider = {
  id: 'gemini',
  command: 'gemini',
  supportsAsk: true,
  screen,
  streamsAgentTextFromScreen: false,
  requiresSessionStart: true,
  requiresResumeTranscript: true,
  finalText(payload) {
    return String(payload.prompt_response || '').trim();
  },
  resumeMetadata(payload) {
    return {
      handle: String(payload.session_id || '').trim(),
      transcriptPath: String(payload.transcript_path || '').trim(),
    };
  },
  createLaunch({
    command,
    port,
    sessionId,
    geminiSystemSettings,
    resumeHandle,
    skipTrust,
    agentGuide,
    serverUrl,
  }) {
    const settings = createGeminiSettings(port, sessionId, geminiSystemSettings, agentGuide, serverUrl);
    const args = skipTrust ? ['--skip-trust'] : [];
    if (resumeHandle) args.push('--resume', resumeHandle);
    return {
      command: command || this.command,
      args,
      env: {
        GEMINI_CLI_NO_RELAUNCH: 'true',
        GEMINI_CLI_SYSTEM_DEFAULTS_PATH: settings.defaultsPath,
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings.path,
      },
      cleanup: () => removeGeminiSettings(settings),
    };
  },
};

module.exports = { geminiProvider };
