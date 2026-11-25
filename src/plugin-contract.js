const CORE_PLUGIN_EVENTS = Object.freeze([
  'session.created',
  'session.closed',
  'turn.user',
  'agent.final',
  'status',
  'menu',
  'content.show',
  'config',
  'output',
  'session.reply',
  'user.notice',
]);

const CORE_PLUGIN_EVENT_SET = new Set(CORE_PLUGIN_EVENTS);
const MAX_PLUGIN_MESSAGE_BYTES = 1024 * 1024;

function serializePluginValue(value, limit = MAX_PLUGIN_MESSAGE_BYTES) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new TypeError('Plugin messages must be JSON-serializable.');
  }
  if (json === undefined) throw new TypeError('Plugin messages must be JSON-serializable.');
  if (Buffer.byteLength(json) > limit) throw new RangeError('Plugin message exceeds the 1MB limit.');
  return json;
}

module.exports = {
  CORE_PLUGIN_EVENTS,
  CORE_PLUGIN_EVENT_SET,
  MAX_PLUGIN_MESSAGE_BYTES,
  serializePluginValue,
};
