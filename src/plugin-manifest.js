const { existsSync, readFileSync, realpathSync, statSync } = require('fs');
const { basename, join } = require('path');

const PLUGIN_API_VERSION = 1;
const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
const COMMAND_NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
const SETTING_TYPES = new Set([
  'text', 'textarea', 'secret', 'toggle', 'number', 'select',
  'dynamic-select', 'path', 'color', 'shortcut',
]);
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_COMMANDS = 64;
const MAX_SETTINGS = 100;
const MAX_VIEWERS = 32;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

class PluginManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PluginManifestError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PluginManifestError(code, message);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function string(value, max, allowEmpty = false) {
  return typeof value === 'string'
    && value.length <= max
    && !value.includes('\0')
    && (allowEmpty || value.trim().length > 0);
}

function validateCommands(commands, pluginId) {
  if (commands === undefined) return [];
  if (!Array.isArray(commands) || commands.length > MAX_COMMANDS) {
    fail('invalid_commands', `commands must contain at most ${MAX_COMMANDS} entries.`);
  }
  const names = new Set();
  return commands.map((command) => {
    if (!object(command)
      || !COMMAND_NAME_RE.test(command.name || '')
      || !string(command.description, 500)
      || !string(command.usage, 500)) {
      fail('invalid_command', 'Every command needs a safe name, description, and usage.');
    }
    if (names.has(command.name)) fail('duplicate_command', `Duplicate command: ${command.name}`);
    const address = `${pluginId}/${command.name}`;
    if (command.usage !== address && !command.usage.startsWith(`${address} `)) {
      fail('invalid_command_usage', `Command usage must start with "${address}".`);
    }
    if (/[\r\n]/.test(command.usage)) {
      fail('invalid_command_usage', 'Command usage must fit on one line.');
    }
    names.add(command.name);
    return {
      name: command.name,
      description: command.description.trim(),
      usage: command.usage.trim(),
    };
  });
}

function validSettingDefault(setting) {
  const { type, default: value } = setting;
  if (value === undefined) return true;
  if (type === 'toggle') return typeof value === 'boolean';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'shortcut') return typeof value === 'string'
    && value.length <= 100 && !/[\0\r\n]/.test(value);
  return typeof value === 'string' && value.length <= 16 * 1024 && !value.includes('\0');
}

function validPreviewPath(value) {
  return string(value, 500)
    && value.startsWith('public/')
    && !value.includes('\\')
    && value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function validateSettings(settings) {
  if (settings === undefined) return [];
  if (!Array.isArray(settings) || settings.length > MAX_SETTINGS) {
    fail('invalid_settings', `settings must contain at most ${MAX_SETTINGS} entries.`);
  }
  const keys = new Set();
  return settings.map((setting) => {
    if (!object(setting)
      || !PLUGIN_ID_RE.test(setting.key || '')
      || !string(setting.label, 200)
      || !SETTING_TYPES.has(setting.type)
      || (setting.description !== undefined && !string(setting.description, 500, true))
      || (setting.group !== undefined && !string(setting.group, 80))
      || !validSettingDefault(setting)) {
      fail('invalid_setting', 'Every setting needs a safe key, label, type, and default.');
    }
    if (keys.has(setting.key)) fail('duplicate_setting', `Duplicate setting: ${setting.key}`);
    keys.add(setting.key);
    const normalized = {
      key: setting.key,
      label: setting.label.trim(),
      type: setting.type,
      ...(setting.description !== undefined && { description: setting.description.trim() }),
      ...(setting.group !== undefined && { group: setting.group.trim() }),
      ...(setting.default !== undefined && { default: setting.default }),
    };
    if (setting.type === 'number') {
      if (setting.min !== undefined && !Number.isFinite(setting.min)) {
        fail('invalid_setting', `Invalid minimum for ${setting.key}.`);
      }
      if (setting.max !== undefined && !Number.isFinite(setting.max)) {
        fail('invalid_setting', `Invalid maximum for ${setting.key}.`);
      }
      if (setting.min !== undefined) normalized.min = setting.min;
      if (setting.max !== undefined) normalized.max = setting.max;
    }
    if (setting.type === 'select' || setting.type === 'dynamic-select') {
      if (setting.options !== undefined && (!Array.isArray(setting.options)
        || setting.options.length > 200
        || setting.options.some((option) => !object(option)
          || !string(option.value, 500, true) || !string(option.label, 200)))) {
        fail('invalid_setting', `Invalid options for ${setting.key}.`);
      }
      if (setting.options) normalized.options = setting.options.map((option) => ({
        value: option.value,
        label: option.label.trim(),
        ...(option.preview !== undefined && { preview: option.preview }),
      }));
      if (setting.options?.some((option) => (
        option.preview !== undefined && !validPreviewPath(option.preview)
      ))) {
        fail('invalid_setting', `Invalid preview path for ${setting.key}.`);
      }
    }
    return normalized;
  });
}

function validateViewers(viewers, pluginId) {
  if (viewers === undefined) return [];
  if (!Array.isArray(viewers) || viewers.length > MAX_VIEWERS) {
    fail('invalid_viewers', `viewers must contain at most ${MAX_VIEWERS} entries.`);
  }
  const ids = new Set();
  return viewers.map((viewer) => {
    if (!object(viewer) || !COMMAND_NAME_RE.test(viewer.id || '')
      || !MIME_RE.test(String(viewer.mime || '').toLowerCase())) {
      fail('invalid_viewer', 'Every viewer needs a safe id and MIME type.');
    }
    if (ids.has(viewer.id)) fail('duplicate_viewer', `Duplicate viewer: ${viewer.id}`);
    ids.add(viewer.id);
    return {
      id: viewer.id,
      kind: `${pluginId}/${viewer.id}`,
      mime: viewer.mime.toLowerCase(),
    };
  });
}

function readPluginManifest(directory, options = {}) {
  let root;
  try {
    root = realpathSync(directory);
  } catch {
    fail('missing_plugin', 'Plugin folder does not exist.');
  }
  if (!statSync(root).isDirectory()) fail('invalid_plugin_folder', 'Plugin path is not a folder.');
  const path = join(root, 'clideck-plugin.json');
  if (!existsSync(path)) fail('missing_manifest', 'clideck-plugin.json is missing.');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    fail('manifest_unreadable', 'Could not read clideck-plugin.json.');
  }
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) {
    fail('manifest_too_large', 'Plugin manifest is too large.');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('invalid_manifest_json', 'Plugin manifest is not valid JSON.');
  }
  if (!object(value)
    || !PLUGIN_ID_RE.test(value.id || '')
    || !string(value.name, 200)
    || !string(value.version, 100)
    || !Number.isInteger(value.apiVersion)
    || (value.enabledByDefault !== undefined && typeof value.enabledByDefault !== 'boolean')
    || (value.description !== undefined && !string(value.description, 1000, true))
    || (value.icon !== undefined && !string(value.icon, 500))) {
    fail('invalid_manifest', 'Plugin identity fields are invalid.');
  }
  if (options.requireFolderName !== false && basename(root) !== value.id) {
    fail('folder_id_mismatch', `Plugin folder must be named "${value.id}".`);
  }
  const commands = validateCommands(value.commands, value.id);
  const settings = validateSettings(value.settings);
  const viewers = validateViewers(value.viewers, value.id);
  return Object.freeze({
    id: value.id,
    name: value.name.trim(),
    version: value.version.trim(),
    apiVersion: value.apiVersion,
    enabledByDefault: value.enabledByDefault !== false,
    description: String(value.description || '').trim(),
    icon: String(value.icon || '').trim(),
    commands,
    settings,
    viewers,
    directory: root,
    manifestPath: path,
    hasServer: existsSync(join(root, 'server.js')),
    hasClient: existsSync(join(root, 'client.js')),
    hasPublic: existsSync(join(root, 'public')),
  });
}

function validateSettingValue(definition, value) {
  if (!definition) return false;
  if (definition.type === 'toggle') return typeof value === 'boolean';
  if (definition.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
      && (definition.min === undefined || value >= definition.min)
      && (definition.max === undefined || value <= definition.max);
  }
  if (typeof value !== 'string' || value.length > 16 * 1024 || value.includes('\0')) return false;
  if (definition.type === 'shortcut') return value.length <= 100 && !/[\r\n]/.test(value);
  if (definition.type === 'select' && definition.options?.length) {
    return definition.options.some((option) => option.value === value);
  }
  return true;
}

function defaultSettings(manifest, stored = {}) {
  const source = object(stored) ? stored : {};
  return Object.fromEntries(manifest.settings.map((definition) => {
    const value = validateSettingValue(definition, source[definition.key])
      ? source[definition.key]
      : definition.default;
    return [definition.key, value === undefined
      ? (definition.type === 'toggle' ? false : definition.type === 'number' ? 0 : '')
      : value];
  }));
}

module.exports = {
  COMMAND_NAME_RE,
  PLUGIN_API_VERSION,
  PLUGIN_ID_RE,
  PluginManifestError,
  defaultSettings,
  readPluginManifest,
  validateSettingValue,
};
