// One host-owned audio channel for sandboxed plugin clients. A Worker transfers synthesized bytes here; it
// never gains DOM access. Starting new audio replaces the old clip, and unloading its plugin always stops it.
import { toast } from "./toast.js";
import { realtimeMediaOwner } from "./plugin-media.js";
import { startReadAlong, updateReadAlong, stopReadAlong, readAlongEnabled, setReadAlongEnabled } from "./read-along.js";

const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const PLAYBACK_RATES = [1, 1.1, 1.25, 1.5];
let current = null;
let clockFrame = 0;
// A READ is a run of clips one plugin plays back to back, tied together by an id IT mints (`options.sequence`).
// `live` is the read still going — it outlives each clip, because a read is still a read in the gap between
// parts while the next one is being prepared. A read ends when the plugin says so (it calls stopAudio() after
// its last part), which is why no clip has to declare whether another follows it.
//
// Cancelled reads are TOMBSTONED, and three things about that are load-bearing:
//   • the key is the PLUGIN and the id together — two plugins may mint the same id and neither may silence
//     the other;
//   • any new non-continuation ends the live read even when nothing is playing, or a clip prefetched before
//     the user moved on would come back and replace whatever is playing now;
//   • we keep a LINEAGE, not one tombstone — A ends, B starts, C starts, and a late clip of A must still be
//     refused. Bounded, because it is a cache of the dead: the oldest goes first.
const CANCELLED_MAX = 16;
let live = null;
const cancelled = new Set();
const readKey = (pluginId, id) => String(pluginId) + "\u0000" + String(id);
function cancelRead(pluginId, id) {
  if (id) {
    const key = readKey(pluginId, id);
    cancelled.delete(key); cancelled.add(key);
    while (cancelled.size > CANCELLED_MAX) cancelled.delete(cancelled.values().next().value);
  }
  if (live && live.pluginId === pluginId && (!id || live.id === id)) live = null;
}
// ── ONE TIMELINE PER READ ──────────────────────────────────────────────────────────────────────────
// A slider that measures the CLIP restarts at every part of a long reading — which a listener sees as the
// reading starting over, six times. The timeline makes the READING the unit instead.
//
// ⚠️ THE SCALE IS CHARACTERS OF THE SOURCE, NOT SECONDS. The total number of seconds is not known until the
// last passage has been synthesised, so a seconds-based slider has to either rescale as parts arrive — the
// thumb jumping backwards, which is the same bug wearing a hat — or invent an estimate and be wrong. The
// document's length is known from the FIRST part and never changes. Inside a part the position is
// interpolated by that part's own clock so the thumb moves smoothly, and that interpolation is an
// APPROXIMATION of where the voice is in the text, not a per-word truth. Nothing in the UI claims otherwise.
//
// ELAPSED is cumulative and true: measured durations of the parts before this one, plus this one's clock. A
// part that has been EVICTED keeps its duration, so elapsed stays correct even when its audio is gone.
//
// Retention is bounded. Beyond the budget the OLDEST parts lose their audio; seeking into one clamps, exactly
// like the unbuffered part of a video. Nothing is ever concatenated and nothing waits for the whole document.
//
// A read WITHOUT `options.timeline` behaves exactly as it always did — one clip, one slider. The timeline is
// additive, so a plugin that has not opted in cannot be changed by it.
const RETAINED_BYTES = 64 * 1024 * 1024;
let timeline = null;
let player = null, titleEl = null, timeEl = null, playBtn = null, rateBtn = null, markBtn = null, seekEl = null, rateIndex = 0;

const segmentsOf = () => (timeline ? timeline.segments : []);
function playingSegment() { return timeline && timeline.playing >= 0 ? timeline.segments[timeline.playing] || null : null; }
// Seconds before a part begins. Uses measured durations only, so it is unaffected by eviction.
function elapsedBefore(index) {
  let total = 0;
  for (let i = 0; i < index && i < segmentsOf().length; i++) total += segmentsOf()[i].duration || 0;
  return total;
}
// The whole reading's duration, but ONLY once the last part has arrived and every part has been measured.
// Until then there is no honest total and the readout shows none.
function knownTotal() {
  const segments = segmentsOf();
  if (!segments.length || !segments[segments.length - 1].last) return 0;
  let total = 0;
  for (const segment of segments) { if (!(segment.duration > 0)) return 0; total += segment.duration; }
  return total;
}
// Fraction of the DOCUMENT that has been spoken, interpolating inside the playing part by its own clock.
function documentFraction(audio) {
  const segment = playingSegment();
  if (!segment || !(segment.sourceTotal > 0)) return 0;
  const span = Math.max(0, segment.sourceEnd - segment.sourceStart);
  const within = segment.duration > 0 ? Math.min(1, Math.max(0, audio.currentTime / segment.duration)) : 0;
  return Math.min(1, (segment.sourceStart + span * within) / segment.sourceTotal);
}
// How far the retained audio reaches, as a fraction of the document — the buffered extent under the thumb.
function retainedFraction() {
  const segments = segmentsOf();
  if (!segments.length) return 0;
  const last = segments[segments.length - 1];
  return last.sourceTotal > 0 ? Math.min(1, last.sourceEnd / last.sourceTotal) : 0;
}
// Audio is released oldest-first, and never for a part that is playing. Durations are kept: the elapsed
// readout must not change because memory was reclaimed behind it.
// ⚠️ TWO PARTS ARE NEVER EVICTABLE: the one PLAYING, and the NEWEST one. The newest matters because
// eviction runs as it is appended, while `playing` still names the part that just ended — so without this
// the frontier could evict ITSELF, `playSegment` would decline to play a part with no audio, and the promise
// the plugin is waiting on would never be settled. A reading that stalls forever is far worse than a budget
// briefly exceeded, which is what happens if a single part is larger than the whole budget.
function evictOverBudget() {
  if (!timeline) return;
  const newest = timeline.segments.length - 1;
  for (const segment of timeline.segments) {
    if (timeline.bytes <= RETAINED_BYTES) break;
    if (segment.evicted || segment.index === timeline.playing || segment.index === newest) continue;
    timeline.bytes -= segment.bytes;
    try { URL.revokeObjectURL(segment.url); } catch {}
    segment.url = ""; segment.evicted = true;
  }
}
function dropTimeline() {
  if (!timeline) return;
  for (const segment of timeline.segments) { if (segment.url) { try { URL.revokeObjectURL(segment.url); } catch {} } }
  timeline = null;
}

const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 9 6-9 6z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12M16 6v12"/></svg>';
// Ending a reading also closes the bar, so the control says what you SEE happen: a close mark, not a media stop.
const CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';
function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds); return Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0");
}
function rateLabel() { return PLAYBACK_RATES[rateIndex] + "×"; }
function paintRate() {
  if (!rateBtn) return;
  const label = rateLabel(); rateBtn.textContent = label;
  rateBtn.setAttribute("aria-label", "Playback speed " + label + "; activate to change");
  rateBtn.title = "Playback speed: " + label;
}
// A highlighter, struck through when off: the switch shows the state you are in, like the mark it controls.
const HIGHLIGHTER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/><path class="plugin-audio-slash" d="M4 4l16 16"/></svg>';
function paintMark() {
  if (!markBtn) return;
  const on = readAlongEnabled();
  markBtn.setAttribute("aria-pressed", String(on));
  markBtn.title = on ? "Text marking on" : "Text marking off";
}
// Only a clip that brought a timeline can be marked; without one the switch would do nothing, so it is not shown.
function showMarkFor(options) { if (markBtn) markBtn.hidden = !(options && options.readAlong); }
function ensurePlayer() {
  if (player) return;
  player = document.createElement("aside"); player.className = "plugin-audio"; player.hidden = true; player.setAttribute("aria-label", "Plugin audio player");
  const mark = document.createElement("span"); mark.className = "plugin-audio-mark"; mark.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13h2l2-6 3 11 3-13 3 8h3"/></svg>';
  const copy = document.createElement("div"); copy.className = "plugin-audio-copy";
  titleEl = document.createElement("strong"); titleEl.textContent = "Plugin audio";
  timeEl = document.createElement("span"); timeEl.textContent = "0:00"; copy.append(titleEl, timeEl);
  seekEl = document.createElement("input"); seekEl.className = "plugin-audio-seek"; seekEl.type = "range"; seekEl.min = "0"; seekEl.max = "1000"; seekEl.value = "0"; seekEl.setAttribute("aria-label", "Audio position");
  seekEl.addEventListener("input", () => {
    if (timeline) { seekDocument(Number(seekEl.value) / 1000); return; }
    const a = current && current.audio;
    if (a && Number.isFinite(a.duration) && a.duration > 0) a.currentTime = a.duration * Number(seekEl.value) / 1000;
  });
  playBtn = document.createElement("button"); playBtn.type = "button"; playBtn.className = "plugin-audio-play"; playBtn.innerHTML = PAUSE; playBtn.setAttribute("aria-label", "Pause");
  playBtn.addEventListener("click", async () => {
    const a = current && current.audio; if (!a) return;
    if (a.paused) { try { await a.play(); } catch {} } else a.pause();
    paintPlayback();
  });
  rateBtn = document.createElement("button"); rateBtn.type = "button"; rateBtn.className = "plugin-audio-rate";
  rateBtn.addEventListener("click", () => {
    rateIndex = (rateIndex + 1) % PLAYBACK_RATES.length;
    if (current) current.audio.playbackRate = PLAYBACK_RATES[rateIndex];
    paintRate();
  });
  paintRate();
  markBtn = document.createElement("button"); markBtn.type = "button"; markBtn.className = "plugin-audio-follow"; markBtn.innerHTML = HIGHLIGHTER; markBtn.hidden = true;
  markBtn.setAttribute("aria-label", "Mark the text being read");
  markBtn.addEventListener("click", () => {
    setReadAlongEnabled(!readAlongEnabled()); paintMark();
    if (current) updateReadAlong(current.audio.currentTime, !current.audio.paused);
  });
  paintMark();
  const stop = document.createElement("button"); stop.type = "button"; stop.className = "plugin-audio-stop"; stop.innerHTML = CLOSE; stop.setAttribute("aria-label", "Stop and close"); stop.title = "Stop and close"; stop.addEventListener("click", () => stopPluginAudio());
  player.append(mark, copy, seekEl, markBtn, rateBtn, playBtn, stop); document.body.appendChild(player);
}
function paintPlayback() {
  if (!current || !player) return;
  const a = current.audio, duration = Number.isFinite(a.duration) ? a.duration : 0;
  if (timeline) {
    // Elapsed never resets, because it belongs to the reading. No total is claimed until the last part has
    // arrived AND every part has been measured — an incomplete reading has no honest duration to show.
    const segment = playingSegment();
    const elapsed = elapsedBefore(timeline.playing) + (segment ? a.currentTime : 0);
    const total = knownTotal();
    timeEl.textContent = clock(elapsed) + (total ? " / " + clock(total) : "");
    const fraction = documentFraction(a);
    seekEl.value = String(Math.round(fraction * 1000));
    seekEl.style.setProperty("--buffered", (retainedFraction() * 100).toFixed(2) + "%");
    seekEl.setAttribute("aria-label", "Approximate position in the reading");
    seekEl.setAttribute("aria-valuetext", Math.round(fraction * 100) + "% through the text, " + clock(elapsed) + " elapsed");
  } else {
  timeEl.textContent = clock(a.currentTime) + (duration ? " / " + clock(duration) : "");
  seekEl.value = String(duration ? Math.round(a.currentTime / duration * 1000) : 0);
  }
  playBtn.innerHTML = a.paused ? PLAY : PAUSE; playBtn.setAttribute("aria-label", a.paused ? "Play" : "Pause");
  // One place drives the highlight, and it reads the CLOCK — so scrubbing, resuming and a rate change all
  // land on the right chunk without any of them knowing read-along exists. The player says nothing about it:
  // no label, no current-word readout, nothing that would imply a precision we do not have.
  updateReadAlong(a.currentTime, !a.paused);
  followClock();
}

// `timeupdate` fires about four times a second — coarse next to a highlight that advances with every spoken
// word. The CLOCK is still the only input; this only reads it as often as the screen repaints, and only
// while something is playing. Nothing here knows what a cue is.
function followClock() {
  if (clockFrame || !current || current.audio.paused || typeof requestAnimationFrame !== "function") return;
  clockFrame = requestAnimationFrame(function step() {
    clockFrame = 0;
    if (!current) return;
    const audio = current.audio;
    updateReadAlong(audio.currentTime, !audio.paused);
    if (!audio.paused) clockFrame = requestAnimationFrame(step);
  });
}

// Resolves TRUE only when the clip reached its natural end. Stop, replacement, unload and error all resolve
// FALSE, and so does a clip whose read was already cancelled — including cancelled in the gap while the plugin
// was preparing this very clip, which is the case a completion promise alone cannot see.
export function playPluginAudioAndWait(pluginId, buffer, options = {}) {
  const id = String(options.sequence || "");
  if (id && cancelled.has(readKey(pluginId, id))) return Promise.resolve(false);
  return new Promise((resolve, reject) => { playPluginAudio(pluginId, buffer, options, resolve).catch(reject); });
}

function release(active, ended) {
  if (clockFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(clockFrame);
  clockFrame = 0;
  stopReadAlong();
  try { active.audio.pause(); active.audio.removeAttribute("src"); active.audio.load(); } catch {}
  // A timeline part's blob belongs to the SEGMENT, not to the element playing it — seeking away from a part
  // must leave it playable, and only eviction or the end of the read revokes it.
  if (!active.keepUrl) { try { URL.revokeObjectURL(active.url); } catch {} }
  if (active.done) { const done = active.done; active.done = null; done(ended === true); }
}

// A part's completion promise is settled EXACTLY ONCE, and only the newest part can have one: the plugin
// waits on the part it just handed over, and it only hands over the next after that one resolves. So
// finishing an earlier part — which is what happens after the user seeks backwards — settles nothing, and
// cannot resolve the promise belonging to the part still being awaited.
function settle(segment, value) {
  if (!segment || !segment.done) return false;
  const done = segment.done; segment.done = null; done(value === true);
  return true;
}
function settleFrontier(value) {
  const segments = segmentsOf();
  return segments.length ? settle(segments[segments.length - 1], value) : false;
}

function appendSegment(url, bytes, meta, options, done) {
  const total = Number(meta.sourceTotal) > 0 ? Math.floor(meta.sourceTotal) : 0;
  const start = Math.max(0, Math.floor(Number(meta.sourceStart) || 0));
  const end = Math.max(start, Math.floor(Number(meta.sourceEnd) || start));
  const segment = {
    index: timeline.segments.length, url, bytes, options, done,
    sourceStart: start, sourceEnd: Math.min(end, total || end), sourceTotal: total,
    duration: Number(meta.seconds) > 0 ? Number(meta.seconds) : 0,
    last: meta.last === true, evicted: false,
  };
  timeline.segments.push(segment);
  timeline.bytes += bytes;
  return segment;
}

// Swap the element to another part WITHOUT settling anything: a seek is not a completion.
function playSegment(index, at = 0, start = true) {
  if (!timeline) return Promise.resolve(false);
  const segment = timeline.segments[index];
  if (!segment || segment.evicted || !segment.url) return Promise.resolve(false);
  if (current) { const active = current; current = null; release(active, false); }
  const audio = new Audio(segment.url);
  audio.playbackRate = PLAYBACK_RATES[rateIndex];
  current = { pluginId: timeline.pluginId, audio, url: segment.url, id: timeline.id, done: null, keepUrl: true, segment: index, auto: timeline.auto };
  timeline.playing = index;
  // Evict only now that the channel has MOVED. Doing it as a part is appended protects the wrong one: at
  // that moment `playing` still names the part that just ended, which is exactly the audio worth releasing.
  evictOverBudget();
  let pending = at > 0 ? at : 0;
  audio.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) segment.duration = audio.duration;
    if (pending > 0) { try { audio.currentTime = Math.min(pending, Math.max(0, audio.duration - 0.05)); } catch {} pending = 0; }
    paintPlayback();
  });
  audio.addEventListener("ended", () => { if (current && current.audio === audio) advanceTimeline(); }, { once: true });
  audio.addEventListener("error", () => {
    if (current && current.audio === audio) { stopPluginAudio(); toast.error({ title: titleEl ? titleEl.textContent : "Plugin audio", body: "Couldn’t play this audio." }); }
  }, { once: true });
  for (const event of ["play", "pause", "loadedmetadata", "durationchange", "timeupdate", "seeked"]) audio.addEventListener(event, paintPlayback);
  if (segment.options && segment.options.readAlong) startReadAlong(segment.options.readAlong); else stopReadAlong();
  showMarkFor(segment.options);
  player.hidden = false; paintPlayback();
  // A seek across parts must not RESUME a reading the user paused — dragging the thumb is a request to move,
  // not to play. An advance to the next part is the opposite: the reading is running and must keep running.
  if (!start) { paintPlayback(); return Promise.resolve(false); }
  // ⚠️ A REJECTED play() IS NOT SWALLOWED. Autoplay can be refused, and on the single-clip path that has
  // always thrown out of playPluginAudio so the plugin's promise rejects rather than waiting forever. The
  // timeline path has more callers, so the rejection is passed to whoever asked and each decides — but no
  // caller may drop it, or a reading stalls with a transport on screen and a plugin blocked on a promise
  // nobody will ever settle.
  return Promise.resolve(audio.play()).then(() => { paintPlayback(); return true; });
}

// Advancing and seeking have no promise of their own to reject into: if the element refuses to play, the
// reading is over, and ending it settles the part the plugin is waiting on.
function playSegmentOrStop(index, at = 0, start = true) {
  // ⚠️ A play() rejection can arrive LATE — after the user started another reading, or another plugin took
  // the channel. Identity is captured before the attempt and checked after it: tearing down what is playing
  // NOW because an element nobody is listening to refused would settle the wrong promise and stop the wrong
  // read. If it is no longer ours, the failure is already irrelevant and is dropped in silence.
  const owner = timeline;
  const attempt = playSegment(index, at, start);
  const mine = current && current.audio;      // captured synchronously: this IS the element just created
  return attempt.catch((error) => {
    if (timeline !== owner || !current || current.audio !== mine) return false;
    stopPluginAudio(owner.pluginId);
    toast.error({ title: titleEl ? titleEl.textContent : "Plugin audio", body: error && error.message ? error.message : "Couldn’t play this audio." });
    return false;
  });
}

// A part ended. Settle it if it was the one being awaited, then continue through whatever is retained; at the
// frontier, hold with the transport up so the plugin's next part starts the moment it arrives.
function advanceTimeline() {
  if (!timeline) return;
  const finished = timeline.segments[timeline.playing];
  settle(finished, true);
  const next = timeline.segments.find((segment) => segment.index > (finished ? finished.index : -1) && !segment.evicted);
  if (next) { playSegmentOrStop(next.index, 0); return; }
  if (finished && finished.last) { if (current) current.ended = true; stopPluginAudio(); return; }
  paintPlayback();                       // waiting on the plugin: keep the transport, and Stop, on screen
}

// The slider is the DOCUMENT. Map the fraction to a character, the character to its part, and the part to a
// time inside it. A part whose audio has been evicted is not seekable, so this clamps to the nearest retained
// one — the same thing a video does when you drag past what it has buffered.
function seekDocument(fraction) {
  if (!timeline) return;
  const segments = timeline.segments;
  if (!segments.length) return;
  const total = segments[0].sourceTotal || 0;
  if (!total) return;
  const chars = Math.max(0, Math.min(total, fraction * total));
  let target = segments.find((segment) => chars < segment.sourceEnd) || segments[segments.length - 1];
  if (target.evicted) target = segments.find((segment) => !segment.evicted && segment.index > target.index)
    || [...segments].reverse().find((segment) => !segment.evicted) || null;
  if (!target) return;
  const span = Math.max(0, target.sourceEnd - target.sourceStart);
  const within = span > 0 ? Math.min(1, Math.max(0, (chars - target.sourceStart) / span)) : 0;
  const at = (target.duration || 0) * within;
  const playing = !!(current && !current.audio.paused);
  if (target.index === timeline.playing && current) {
    try { current.audio.currentTime = at; } catch {}
    paintPlayback();
    return;
  }
  playSegmentOrStop(target.index, at, playing);
}
function hidePlayer() { if (player) { player.hidden = true; seekEl.value = "0"; } if (autoHooks) queueMicrotask(() => autoHooks && autoHooks.idle()); }

// Automatic read-aloud (read-aloud.js) marks its clips with options.autoToken. The host decides at play time
// whether that token may still sound (its session on screen, enabled, tab visible) — a clip synthesised before
// the person moved away is refused here rather than trusted to the plugin. Untokened audio is manual.
let autoHooks = null;
export function setAutoAudioHooks(hooks) { autoHooks = hooks || null; }
// Who owns the channel: "" when silent, an auto token, or "manual".
export function audioOwner() { if (realtimeMediaOwner()) return "realtime"; const a = current || live || timeline; return !a ? "" : a.auto || "manual"; }

// Stop pressed while nothing is playing: the transport is still up because the read is not over, so this is
// the user cancelling the READ, and the part being prepared must never start.
function endSequence(pluginId) {
  if (!live || (pluginId && live.pluginId !== pluginId)) return false;
  cancelRead(live.pluginId, live.id);
  if (timeline) { settleFrontier(false); dropTimeline(); }
  hidePlayer();
  return true;
}

export async function playPluginAudio(pluginId, buffer, options = {}, done = null) {
  if (realtimeMediaOwner()) throw new Error("Stop live voice before playing another audio clip.");
  if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || buffer.byteLength > MAX_AUDIO_BYTES) throw new Error("Plugin audio payload is invalid or too large.");
  const auto = options.autoToken == null ? "" : String(options.autoToken);
  if (auto && !(autoHooks && autoHooks.allow(auto))) { if (typeof done === "function") done(false); return; }
  if (!auto && autoHooks) autoHooks.manualStarted();
  const id = String(options.sequence || "");
  // Retiring the clip we are replacing is NOT the same as the user stopping: the next part of the same read,
  // from the same plugin, is a continuation and leaves the read alive. Anything else ENDS the live read — and
  // it has to end it even when nothing is playing, because a read in the gap still owns the channel and a
  // clip prefetched before the user moved on must never come back and replace what is playing now.
  const continuation = !!id && !!live && live.pluginId === pluginId && live.id === id;
  // A plugin's default speed applies when a NEW reading starts; later parts keep whatever the listener chose.
  const startRate = continuation ? -1 : PLAYBACK_RATES.indexOf(Number(options.playbackRate));
  if (startRate >= 0) { rateIndex = startRate; paintRate(); }
  // A part of a reading that already has a timeline JOINS it — it does not replace what is playing. That is
  // the whole point: after seeking backwards the listener is somewhere earlier, and the next part arriving
  // must queue behind them rather than yank them to the end.
  const meta = options.timeline && typeof options.timeline === "object" ? options.timeline : null;
  const joins = !!(meta && continuation && timeline && timeline.pluginId === pluginId && timeline.id === id);
  if (!joins && current) {
    const active = current; current = null;
    release(active, false);
    if (!active.ended && !continuation) cancelRead(active.pluginId, active.id);
  }
  if (!joins) {
    if (!continuation && live) cancelRead(live.pluginId, live.id);
    if (!continuation || !meta) { settleFrontier(false); dropTimeline(); }
  }
  if (typeof Audio !== "function") throw new Error("Audio playback is unavailable in this browser.");
  ensurePlayer();
  const mime = /^audio\/[a-z0-9.+-]+$/i.test(String(options.mime || "")) ? options.mime : "audio/wav";
  const url = URL.createObjectURL(new Blob([buffer], { type: mime }));
  if (meta) {
    if (!timeline) timeline = { pluginId, id, segments: [], bytes: 0, playing: -1, auto };
    const segment = appendSegment(url, buffer.byteLength, meta, options, typeof done === "function" ? done : null);
    live = id ? { pluginId, id, auto } : null;
    titleEl.textContent = String(options.title || "Plugin audio").slice(0, 100);
    // Only take the channel if nobody is listening to an earlier part. `ended` is the tell: the previous part
    // finished and we are holding at the frontier waiting for exactly this.
    const listening = current && current.audio && !current.audio.ended && current.segment < segment.index;
    if (listening) { evictOverBudget(); paintPlayback(); return; }
    // Same rule on arrival: only clean up if this reading is still the one on the channel. The promise is
    // still rejected either way, because the plugin that handed us this part is owed an answer.
    const owner = timeline;
    const attempt = playSegment(segment.index, 0);
    const mine = current && current.audio;
    try { await attempt; if (auto && autoHooks) autoHooks.started(auto); }
    catch (error) {
      if (auto && autoHooks) autoHooks.blocked(auto, error);
      if (timeline === owner && current && current.audio === mine) stopPluginAudio(pluginId);
      throw error;
    }
    return;
  }
  const audio = new Audio(url); audio.playbackRate = PLAYBACK_RATES[rateIndex]; current = { pluginId, audio, url, auto };
  audio.addEventListener("ended", () => { if (current && current.audio === audio) { current.ended = true; stopPluginAudio(); } }, { once: true });
  audio.addEventListener("error", () => { if (current && current.audio === audio) { stopPluginAudio(); toast.error({ title: options.title || "Plugin audio", body: "Couldn’t play this audio." }); } }, { once: true });
  // Resolve the source against the terminal as it is NOW, before the first sound: the highlight must never
  // chase a buffer that has moved on. Unresolvable is a normal outcome — playback simply carries no highlight.
  current.id = id; current.done = typeof done === "function" ? done : null;
  // A clip that belongs to a read keeps the transport — and its Stop — on screen after it ends, so the user
  // can still stop between parts and the player does not flicker away at every batch boundary.
  live = id ? { pluginId, id, auto } : null;
  if (options.readAlong) startReadAlong(options.readAlong);
  showMarkFor(options);
  for (const event of ["play", "pause", "loadedmetadata", "durationchange", "timeupdate", "seeked"]) audio.addEventListener(event, paintPlayback);
  titleEl.textContent = String(options.title || "Plugin audio").slice(0, 100); player.hidden = false; paintPlayback();
  try { await audio.play(); if (auto && autoHooks) autoHooks.started(auto); if (current && current.audio === audio) paintPlayback(); }
  catch (error) {
    if (auto && autoHooks) autoHooks.blocked(auto, error);
    // A late rejection belongs to THIS clip only — never stop whatever replaced it meanwhile.
    if (current && current.audio === audio) stopPluginAudio(pluginId);
    throw error;
  }
}

export function togglePluginAudio(pluginId) {
  if (!current || current.pluginId !== pluginId) return false;
  const audio = current.audio;
  if (audio.paused) {
    if (timeline && audio.ended && timeline.playing > 0) { seekDocument(0); return true; }
    if (Number.isFinite(audio.duration) && audio.currentTime >= audio.duration) audio.currentTime = 0;
    Promise.resolve(audio.play()).then(paintPlayback, () => {});
  } else {
    audio.pause();
    paintPlayback();
  }
  return true;
}

export function stopPluginAudio(pluginId) {
  if (!current) return endSequence(pluginId);
  if (pluginId && current.pluginId !== pluginId) return false;
  const active = current; current = null;
  const ended = active.ended === true;
  // The part the plugin is still awaiting has to be answered, or its loop waits for a reading that is over.
  if (timeline) { settleFrontier(ended); dropTimeline(); }
  release(active, ended);
  // Anything but a natural end ends the read it belonged to. A natural end leaves it alive, and the transport
  // with it, until the plugin closes the read itself.
  if (!ended) cancelRead(active.pluginId, active.id);
  if (!ended || !active.id) hidePlayer();
  return true;
}

export function __audioStateForTest() {
  return { clip: current ? { pluginId: current.pluginId, paused: !!current.audio.paused } : null,
    timeline: timeline ? {
      playing: timeline.playing, bytes: timeline.bytes,
      segments: timeline.segments.map((s) => ({ index: s.index, sourceStart: s.sourceStart, sourceEnd: s.sourceEnd,
        sourceTotal: s.sourceTotal, duration: s.duration, last: s.last, evicted: s.evicted, awaited: !!s.done })),
      elapsed: current ? elapsedBefore(timeline.playing) + (current.audio.currentTime || 0) : elapsedBefore(timeline.playing),
      total: knownTotal(), fraction: current ? documentFraction(current.audio) : 0, retained: retainedFraction(),
    } : null,
    sequence: live ? live.id : "", live, cancelled: [...cancelled].map((key) => key.split("\u0000")),
    playerHidden: player ? player.hidden : true };
}
