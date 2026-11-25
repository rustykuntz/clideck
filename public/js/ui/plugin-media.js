// A live conversation reserves both channels, including while permission/SDP is pending.
// Existing dictation and clip players keep their own lifecycles; they only need this guard.
let reservation = null;
export function realtimeMediaOwner() { return reservation?.pluginId || ""; }
export function reserveRealtimeMedia(pluginId) {
  if (reservation) throw new Error("Live audio is already in use.");
  const token = { pluginId }; reservation = token;
  return () => { if (reservation === token) reservation = null; };
}
