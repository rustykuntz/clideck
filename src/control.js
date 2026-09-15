const { isValidConfigPatch } = require('./config-store');
const { MAX_RESOLVE_PATHS } = require('./content-store');

const MAX_CONTROL_TEXT = 1024 * 1024;
const MAX_CONTROL_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_ID = 200;
const CONTROL_TYPES = new Set([
  'session.create',
  'prompt',
  'prompt.answer',
  'input',
  'resize',
  'session.close',
  'session.rename',
  'session.resume',
  'session.restart',
  'session.mute',
  'session.setProject',
  'project.delete',
  'project.open',
  'dirs.list',
  'dirs.mkdir',
  'content.open',
  'content.close',
  'content.resolve',
  'transcript.page',
  'config.get',
  'config.update',
  'checkAvailability',
  'plugins.refresh',
  'plugin.install',
  'plugin.remove',
  'plugin.openFolder',
  'plugin.setEnabled',
  'plugin.settings.update',
  'plugin.message',
]);

function isString(value, max, allowEmpty = false) {
  return typeof value === 'string'
    && value.length <= max
    && !value.includes('\0')
    && (allowEmpty || value.trim().length > 0);
}

function isDimension(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function isTheme(value) {
  return value === 'light' || value === 'dark';
}

function isProjectId(value) {
  return value === null || isString(value, 100);
}

function hasValidRequestId(message) {
  return message.requestId === undefined || isString(message.requestId, 100);
}

function isKnownControlType(type) {
  return CONTROL_TYPES.has(type);
}

function hasValidControlFields(message) {
  if (message.type === 'config.get') return hasValidRequestId(message);
  if (message.type === 'checkAvailability') return true;
  if (message.type === 'plugins.refresh' || message.type === 'plugin.openFolder') {
    return hasValidRequestId(message);
  }
  if (message.type === 'plugin.install') {
    return hasValidRequestId(message) && isString(message.path, 4096);
  }
  if (message.type === 'plugin.remove') {
    return hasValidRequestId(message) && isString(message.pluginId, 63);
  }
  if (message.type === 'plugin.setEnabled') {
    return hasValidRequestId(message)
      && isString(message.pluginId, 63) && typeof message.enabled === 'boolean';
  }
  if (message.type === 'plugin.settings.update') {
    return hasValidRequestId(message) && isString(message.pluginId, 63)
      && message.settings && typeof message.settings === 'object'
      && !Array.isArray(message.settings)
      && Object.keys(message.settings).length <= 100
      && Buffer.byteLength(JSON.stringify(message.settings)) <= MAX_CONTROL_TEXT;
  }
  if (message.type === 'plugin.message') {
    return hasValidRequestId(message) && isString(message.pluginId, 63)
      && isString(message.event, 63)
      && Buffer.byteLength(JSON.stringify(message.data ?? null)) <= MAX_CONTROL_TEXT;
  }
  if (message.type === 'prompt.answer') {
    return isString(message.promptId, 200)
      && isString(message.value, MAX_CONTROL_TEXT, true);
  }
  if (message.type === 'config.update') return isValidConfigPatch(message.config);
  if (message.type === 'project.delete') return isString(message.id, 100);
  if (message.type === 'project.open') return isString(message.cwd, 4096);
  if (message.type === 'dirs.list') {
    return isString(message.path, 4096) && typeof message.showHidden === 'boolean';
  }
  if (message.type === 'dirs.mkdir') {
    return isString(message.parent, 4096) && isString(message.name, 255, true);
  }
  if (message.type === 'session.create') {
    return (message.provider === undefined || isString(message.provider, 100))
      && (message.commandId === undefined || isString(message.commandId, 100))
      && (message.name === undefined || isString(message.name, 200, true))
      && (message.cwd === undefined || isString(message.cwd, 4096))
      && (message.cols === undefined || isDimension(message.cols, 20, 1000))
      && (message.rows === undefined || isDimension(message.rows, 5, 500))
      && (message.theme === undefined || isTheme(message.theme))
      && (message.projectId === undefined || isProjectId(message.projectId));
  }
  if (!isString(message.sessionId, MAX_SESSION_ID)) return false;
  if (message.type === 'transcript.page') {
    return (message.before === undefined
      || (Number.isSafeInteger(message.before) && message.before >= 0))
      && (message.limit === undefined || isDimension(message.limit, 1, 100));
  }
  if (message.type === 'content.open') {
    const path = isString(message.path, 4096)
      && message.name === undefined && message.kind === undefined && message.data === undefined;
    const payload = message.path === undefined
      && isString(message.name, 255)
      && isString(message.kind, 32)
      && typeof message.data === 'string'
      && message.data.length <= MAX_CONTROL_BYTES - 1024;
    return path || payload;
  }
  if (message.type === 'content.resolve') {
    return Array.isArray(message.paths)
      && message.paths.slice(0, MAX_RESOLVE_PATHS).every((path) => isString(path, 4096));
  }
  if (message.type === 'content.close') return isString(message.contentId, MAX_SESSION_ID);
  if (message.type === 'prompt') return isString(message.text, MAX_CONTROL_TEXT);
  if (message.type === 'input') {
    return typeof message.data === 'string' && message.data.length <= MAX_CONTROL_TEXT;
  }
  if (message.type === 'resize') {
    return isDimension(message.cols, 20, 1000) && isDimension(message.rows, 5, 500);
  }
  if (message.type === 'session.rename') return isString(message.name, 200, true);
  if (message.type === 'session.resume') {
    return message.theme === undefined || isTheme(message.theme);
  }
  if (message.type === 'session.restart') {
    return (message.theme === undefined || isTheme(message.theme))
      && (message.cols === undefined || isDimension(message.cols, 20, 1000))
      && (message.rows === undefined || isDimension(message.rows, 5, 500));
  }
  if (message.type === 'session.mute') return typeof message.muted === 'boolean';
  if (message.type === 'session.setProject') return isProjectId(message.projectId);
  return message.type === 'session.close';
}

module.exports = {
  MAX_CONTROL_BYTES,
  MAX_CONTROL_TEXT,
  hasValidControlFields,
  isKnownControlType,
};
