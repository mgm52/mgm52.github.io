// SFX play through WebAudio: each sample is fetched once with plain fetch()
// (small files, HTTP-cache friendly), decoded to an AudioBuffer up front, and
// played via throwaway AudioBufferSourceNodes.
//
// This replaced a 16-sounds × 4-element HTMLAudioElement pool. That design
// pushed 64 concurrent media fetches through iOS's media stack on page load,
// and its per-element autoplay unlock had to run a muted play() across all 64
// elements on a user gesture — re-running the whole sweep on EVERY tap until
// all 64 succeeded. Over a slow cellular link the sounds buffer for a long
// time, so every tap during that window did 64 synchronous media-session
// calls: multi-hundred-ms main-thread stalls that pinned phones to ~3fps
// while anything was still downloading (and the intro is exactly when the
// player is tapping around). WebAudio needs none of that: unlock is a single
// AudioContext.resume(), and playback never touches the network.

// Cap on simultaneous sources per sound, mirroring the old pool semantics:
// rapid retriggers overlap up to 4 deep, then the oldest voice is stolen.
const MAX_VOICES = 4;

let audioCtx: AudioContext | null = null;
const buffers = new Map<string, AudioBuffer>();
const activeVoices = new Map<string, AudioBufferSourceNode[]>();
// Set on the first user gesture. Before it, playSound stays silent (autoplay
// policy would block anyway); after it, a suspended context (page started
// without a gesture, or an iOS audio interruption) is nudged with resume().
let gestureSeen = false;

// Sound name → file URL. Paths are relative (no leading slash) so they resolve
// against the page URL — works for dev root and GH Pages subpath alike.
const REGISTRY = {
  click:        'audio/click.mp3',
  place:        'audio/place.mp3',
  build_done:   'audio/build_done.mp3',
  goblin_spawn: 'audio/goblin_spawn.mp3',
  destroy:      'audio/destroy.mp3',
  select:       'audio/select.mp3',
  error:        'audio/error.mp3',
  online:       'audio/online.mp3',
  command_3:    'audio/command_3.mp3',
  ritual:       'audio/ritual.mp3',
  goblin_death: 'audio/goblin_death.mp3',
  task_complete: 'audio/task_complete.mp3',
  water_splash: 'audio/water_splash.mp3',
  cash:         'audio/cash.mp3',
  // The Lightning Strike thunderclap — same sample as 'destroy', pitched way
  // down at the call site (rate 0.4 ≈ 2.5× longer). Shares the decoded
  // buffer but gets its own voice slots, so building smashes can't steal the
  // element mid-rumble the way a shared pool used to.
  lightning:    'audio/destroy.mp3',
} as const;

export type SoundName = keyof typeof REGISTRY;

// Every registered sample name — the dev menu's pick-list for the demons'
// per-letter voice sample.
export const SOUND_NAMES = Object.keys(REGISTRY) as SoundName[];

let masterVolume = 0.7;
let musicVolume = 0.7;
let muted = false;
// Set to true while the player is in the hell view. Used to suppress goblin
// spawn cries (the underworld stays quiet for new arrivals) while letting
// every other sound — including goblin_death — through unchanged.
let inHellView = false;
// How far into hell the player is, 0 (surface) → 1 (fully descended). Drives a
// playbackRate pitch-drop on the music quartet rather than muting it, so the
// piece keeps playing but sinks into a slowed, dreamlike register underground.
// Crackle is independent and stays present throughout.
let musicDepth = 0;
// Music playbackRate at full hell depth. 0.72 ≈ a major-third-ish drop — deep
// without turning to mud. Tempo follows pitch (we resample, not time-stretch),
// which suits the underworld's drag.
const HELL_MUSIC_RATE = 0.72;
function effectiveMusicRate(): number {
  return 1 + (HELL_MUSIC_RATE - 1) * musicDepth;
}

export function preloadSounds() {
  const Ctor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  audioCtx = new Ctor();
  // Fetch each distinct URL once (lightning aliases destroy.mp3) and fan the
  // decoded buffer out to every registry name that uses it. Decode works fine
  // on a still-suspended context, so all of this completes behind the title
  // screen; failures (offline, decode error) just leave that sound silent.
  const byUrl = new Map<string, Promise<AudioBuffer | null>>();
  for (const [name, url] of Object.entries(REGISTRY)) {
    let p = byUrl.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => r.arrayBuffer())
        .then((ab) => audioCtx!.decodeAudioData(ab))
        .catch(() => null);
      byUrl.set(url, p);
    }
    void p.then((buf) => { if (buf) buffers.set(name, buf); });
  }
  // Autoplay policies start the context suspended until a user gesture; the
  // listeners stay installed (resume is cheap + idempotent) so an iOS audio
  // interruption mid-session also recovers on the next tap.
  window.addEventListener('pointerdown', unlockAudio, { capture: true, passive: true });
  window.addEventListener('keydown', unlockAudio, { capture: true, passive: true });
}

function unlockAudio(): void {
  gestureSeen = true;
  if (audioCtx && audioCtx.state !== 'running') void audioCtx.resume();
}

// ─── Ghostly reverb send ────────────────────────────────────────────
// A shared effects bus for sounds that should read as coming from somewhere
// far off in the underworld: input → lowpass (distance eats the highs) →
// convolver reverb (synthetic cavern impulse, so no extra asset to fetch),
// with a small dry tap so attacks aren't completely washed out. Built lazily
// on first use; per-voice gains still carry masterVolume, this bus only adds
// the distance/space colouring on top.
// Gain on the send. The original 0.45 "far away" attenuation read as too
// quiet in practice — the cries got lost under the music — so the default
// rides 3× hotter; the convolver+lowpass still carry the distance feel.
// Runtime-tunable via the dev menu (see setGhostSendGain).
const GHOST_SEND_GAIN_DEFAULT = 1.35;
const GHOST_LOWPASS_HZ = 1100;  // muffle: roughly "heard through a cavern"
const GHOST_IR_SECONDS = 2.8;   // long tail — hell is a big room
const GHOST_DRY_TAP = 0.25;     // just enough direct signal to keep the attack
let ghostSendGain = GHOST_SEND_GAIN_DEFAULT;
let ghostBusInput: GainNode | null = null;

// Dev-menu dial for the hell command cries: sets the ghostly send's input
// gain, applied live to the bus if it's already been built.
export function setGhostSendGain(v: number): void {
  ghostSendGain = Math.max(0, v);
  if (ghostBusInput) ghostBusInput.gain.value = ghostSendGain;
}

// Exponentially decaying stereo noise — the classic synthetic reverb impulse.
// pow(3) on the envelope gives a fast early drop with a long whispering tail.
function buildGhostImpulse(ctx: AudioContext): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * GHOST_IR_SECONDS));
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
  }
  return ir;
}

function getGhostBus(ctx: AudioContext): GainNode {
  if (ghostBusInput) return ghostBusInput;
  const input = ctx.createGain();
  input.gain.value = ghostSendGain;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = GHOST_LOWPASS_HZ;
  input.connect(lowpass);
  const convolver = ctx.createConvolver();
  convolver.buffer = buildGhostImpulse(ctx);
  lowpass.connect(convolver);
  convolver.connect(ctx.destination);
  const dry = ctx.createGain();
  dry.gain.value = GHOST_DRY_TAP;
  lowpass.connect(dry);
  dry.connect(ctx.destination);
  ghostBusInput = input;
  return input;
}

export function playSound(name: SoundName, volume = 1, playbackRate?: number, ghostly = false) {
  if (muted) return;
  if (inHellView && name === 'goblin_spawn') return;
  const ctx = audioCtx;
  const buffer = buffers.get(name);
  if (!ctx || !buffer) return;
  if (ctx.state !== 'running') {
    // No gesture yet → autoplay policy blocks us regardless; stay silent
    // (matches the old pool's swallowed play() rejection). With a gesture on
    // record, nudge the context and schedule anyway — the source starts the
    // moment the resume lands, a few ms later.
    if (!gestureSeen) return;
    void ctx.resume();
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  // Rate resamples (pitch follows speed), matching the old elements'
  // preservesPitch = false.
  src.playbackRate.value = Math.max(0.25, Math.min(4, playbackRate ?? 1));
  const gain = ctx.createGain();
  gain.gain.value = Math.max(0, Math.min(1, masterVolume * volume));
  src.connect(gain);
  gain.connect(ghostly ? getGhostBus(ctx) : ctx.destination);
  let voices = activeVoices.get(name);
  if (!voices) { voices = []; activeVoices.set(name, voices); }
  if (voices.length >= MAX_VOICES) {
    const oldest = voices.shift()!;
    try { oldest.stop(); } catch { /* already ended */ }
  }
  voices.push(src);
  src.onended = () => {
    const arr = activeVoices.get(name);
    const i = arr ? arr.indexOf(src) : -1;
    if (arr && i >= 0) arr.splice(i, 1);
    src.disconnect();
    gain.disconnect();
  };
  src.start();
}

// ─── Decaying spawn / death volumes ─────────────────────────────────
// Late-game spam can spawn dozens of goblins per second. Each successive
// goblin_spawn / goblin_death plays a hair quieter than the last so the
// audio doesn't pile up into a roar; clamps at GOBLIN_*_FLOOR.
let goblinSpawnVolume = 0.325;
const GOBLIN_SPAWN_VOLUME_FLOOR = 0.015;
const GOBLIN_SPAWN_VOLUME_DECAY = 0.002;
export function playDecayingGoblinSpawn(rate?: number): void {
  playSound('goblin_spawn', goblinSpawnVolume, rate);
  goblinSpawnVolume = Math.max(
    GOBLIN_SPAWN_VOLUME_FLOOR,
    goblinSpawnVolume - GOBLIN_SPAWN_VOLUME_DECAY,
  );
}

let goblinDeathVolume = 0.56;
const GOBLIN_DEATH_VOLUME_FLOOR = 0.02;
const GOBLIN_DEATH_VOLUME_DECAY = 0.002;
export function playDecayingGoblinDeath(rate?: number): void {
  playSound('goblin_death', goblinDeathVolume, rate);
  goblinDeathVolume = Math.max(
    GOBLIN_DEATH_VOLUME_FLOOR,
    goblinDeathVolume - GOBLIN_DEATH_VOLUME_DECAY,
  );
}
// Cash sample is a touch louder than the death sound at full fidelity (0.7 vs
// 0.56). Riding the same decay keeps spammy minotaur kills tonally balanced —
// the cha-ching softens in proportion rather than blasting over the deaths.
const CASH_TO_DEATH_RATIO = 0.7 / 0.56;
export function playDecayingGoldKillCash(rate?: number): void {
  playSound('cash', goblinDeathVolume * CASH_TO_DEATH_RATIO, rate);
}

// Minotaur command bellow — the command_3 grunt pitched well down so it reads
// as a deeper, beastlier roar than the goblin grunt. Staggered ~140ms apart so
// a commanded group choruses instead of overlapping into one blob.
export function playMinotaurCommand(count = 1): void {
  for (let i = 0; i < count; i++) {
    const delay = i * 140;
    setTimeout(() => {
      const rate = 0.28 + Math.random() * 0.16;
      playSound('command_3', 1, rate);
    }, delay);
  }
}

// Commanding a soul in hell — the unit's living command cry, heard from far
// away. Same staggers and pitch ranges as the surface bursts (playGruntBurst /
// playDragonRoarBurst in input.ts and playMinotaurCommand above), but routed
// through the ghostly reverb send so the cries arrive distant and cavernous.
export function playGhostCommand(kind: 'goblin' | 'minotaur' | 'dragon', count = 1): void {
  const stagger = kind === 'dragon' ? 160 : kind === 'minotaur' ? 140 : 100;
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      if (kind === 'dragon') playSound('ritual', 0.6, 0.4 + Math.random() * 0.1, true);
      else if (kind === 'minotaur') playSound('command_3', 1, 0.28 + Math.random() * 0.16, true);
      else playSound('command_3', 1, 0.5 + Math.random(), true);
    }, i * stagger);
  }
}

export function setMasterVolume(v: number) {
  masterVolume = Math.max(0, Math.min(1, v));
  if (musicEl) musicEl.volume = effectiveMusicVolume();
  if (crackleEl) crackleEl.volume = effectiveCrackleVolume();
}
export function setMusicVolume(v: number) {
  musicVolume = Math.max(0, Math.min(1, v));
  if (musicEl) musicEl.volume = effectiveMusicVolume();
  if (crackleEl) crackleEl.volume = effectiveCrackleVolume();
}
export function setMuted(m: boolean) { muted = m; }
export function setInHellView(b: boolean) { inHellView = b; }

// ─── Looping background music ───────────────────────────────────────
// One persistent <audio> element, lazy-started after first user gesture so
// the browser's autoplay policy lets it through. The source mp3 is
// loudness-normalised offline (-14 LUFS); the music slider attenuates it
// further on top of the master volume.
let musicEl: HTMLAudioElement | null = null;
// Flat boost on the music quartet only (not the crackle). The music had been
// riding at master×music = 0.49 since the music slider was split out from
// master, which read noticeably softer than the older master-only default.
// This pulls it back up by 80%; the result is still clamped to 1.
const MUSIC_GAIN = 1.8;
function effectiveMusicVolume(): number {
  return Math.max(0, Math.min(1, masterVolume * musicVolume * MUSIC_GAIN));
}

// Drive the hell pitch-drop. Pass the player's descent depth (0 surface → 1
// fully in hell); the music slows + deepens in place rather than muting.
export function setMusicDepth(depth: number): void {
  const clamped = Math.max(0, Math.min(1, depth));
  if (clamped === musicDepth) return;
  musicDepth = clamped;
  if (musicEl) {
    musicEl.preservesPitch = false;
    musicEl.playbackRate = effectiveMusicRate();
  }
}
export function startBackgroundMusic(url: string): void {
  if (musicEl) return;
  const a = new Audio(url);
  a.loop = true;
  a.preload = 'auto';
  // Pitch follows playbackRate (resampling) so the hell descent can deepen the
  // music; preservesPitch would otherwise time-stretch and hold the pitch.
  a.preservesPitch = false;
  a.playbackRate = effectiveMusicRate();
  a.volume = effectiveMusicVolume();
  // Safety net: the element loops, but if a browser ever fires `ended` (e.g. a
  // loop hiccup at the track's end — "music stops at a certain point"), kick it
  // straight back to the start so the quartet never falls silent mid-session.
  a.addEventListener('ended', () => {
    a.currentTime = 0;
    a.play().catch(() => {});
  });
  a.play().catch(() => {/* gated until next gesture; caller should retry */});
  musicEl = a;
  ensurePlaybackWatchdog();
}

// ─── Playback watchdog ──────────────────────────────────────────────
// The `ended` listener above only catches a loop hiccup at the track's end —
// but that's the rare case. The common way background audio "disappears"
// mid-session is the OS/browser silently *pausing* the element, which never
// fires `ended`: headphones or a Bluetooth device unplugged (OS pauses media
// to avoid blasting the speakers), an interruption grabbing audio focus (a
// call, another tab), or the tab being backgrounded / the device sleeping on a
// long session. None of these restart on their own. A cheap heartbeat re-kicks
// any background layer that *should* be playing but has fallen paused, and we
// also resume the moment a backgrounded tab becomes visible again rather than
// waiting out the next tick.
const WATCHDOG_MS = 1000;
let watchdogInterval: number | null = null;
function resumeStalledAudio(): void {
  // We never intentionally pause the music, so any paused state is a stall to
  // recover from. Crackle, by contrast, is paused on purpose when disabled —
  // only resume it while it's meant to be on.
  if (musicEl && musicEl.paused) musicEl.play().catch(() => {});
  if (crackleEl && crackleEnabled && crackleEl.paused) crackleEl.play().catch(() => {});
  // The SFX context can land in 'interrupted' after a call/Siri/another app
  // grabs audio focus on iOS — re-kick it alongside the music layers.
  if (gestureSeen && audioCtx && audioCtx.state !== 'running') void audioCtx.resume();
}
function ensurePlaybackWatchdog(): void {
  if (watchdogInterval !== null) return;
  watchdogInterval = window.setInterval(resumeStalledAudio, WATCHDOG_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resumeStalledAudio();
  });
}

// ─── Vinyl crackle (second background layer) ───────────────────────
// Treated as music for volume purposes (rides the music slider). The user-
// facing control is just a checkbox; behind the scenes the layer plays at
// CRACKLE_HOLD for the first CRACKLE_HOLD_MS after spawn, then ramps over
// CRACKLE_RAMP_MS down to CRACKLE_STEADY. Toggling off pauses the element
// rather than destroying it so re-enabling resumes without buffering.
const CRACKLE_HOLD = 1.0;
const CRACKLE_STEADY = 0.5;
const CRACKLE_HOLD_MS = 5000;
const CRACKLE_RAMP_MS = 5000;
let crackleEl: HTMLAudioElement | null = null;
let crackleEnabled = true;
let crackleUrl: string | null = null;
let crackleStartedAt: number | null = null;
let crackleRampInterval: number | null = null;
function currentCrackleGain(): number {
  if (crackleStartedAt === null) return CRACKLE_STEADY;
  const elapsed = Date.now() - crackleStartedAt;
  if (elapsed < CRACKLE_HOLD_MS) return CRACKLE_HOLD;
  if (elapsed < CRACKLE_HOLD_MS + CRACKLE_RAMP_MS) {
    const t = (elapsed - CRACKLE_HOLD_MS) / CRACKLE_RAMP_MS;
    return CRACKLE_HOLD + t * (CRACKLE_STEADY - CRACKLE_HOLD);
  }
  return CRACKLE_STEADY;
}
function effectiveCrackleVolume(): number {
  if (!crackleEnabled) return 0;
  // The vinyl crackle is ambient — it stays at full pitch and presence even as
  // the music quartet pitches down for the hell descent.
  return Math.max(0, Math.min(1, masterVolume * musicVolume * currentCrackleGain()));
}
function tickCrackleRamp(): void {
  if (crackleEl) crackleEl.volume = effectiveCrackleVolume();
  if (crackleStartedAt !== null && Date.now() - crackleStartedAt >= CRACKLE_HOLD_MS + CRACKLE_RAMP_MS) {
    if (crackleRampInterval !== null) {
      clearInterval(crackleRampInterval);
      crackleRampInterval = null;
    }
  }
}
// One-line audio/network status for the ?fps HUD, to pin down lag that
// correlates with a slow connection. `sfx 16/16 running` = every effect
// decoded + context live. For the streaming layers: r = readyState (0 nothing
// … 4 enough to play through), n = networkState (2 = actively loading — over
// cellular expect n2 for a while on the 6MB quartet; sustained n2 with a low
// r is a stall).
export function getAudioDebugInfo(): string {
  const total = new Set(Object.keys(REGISTRY)).size;
  const ctxState = audioCtx ? audioCtx.state : 'no-ctx';
  const media = (el: HTMLAudioElement | null) =>
    el ? `r${el.readyState}n${el.networkState}${el.paused ? '·p' : ''}` : '—';
  return `sfx ${buffers.size}/${total} ${ctxState} · mus ${media(musicEl)} · crk ${media(crackleEl)}`;
}

export function startBackgroundCrackle(url: string): void {
  crackleUrl = url;
  if (!crackleEnabled) return;
  if (crackleEl) {
    if (crackleEl.paused) crackleEl.play().catch(() => {});
    return;
  }
  const a = new Audio(url);
  a.loop = true;
  a.preload = 'auto';
  if (crackleStartedAt === null) crackleStartedAt = Date.now();
  a.volume = effectiveCrackleVolume();
  a.play().catch(() => {/* gated until next gesture; caller should retry */});
  crackleEl = a;
  // 50ms is fine-grained enough that the linear ramp reads as smooth — at
  // 0.5 step over 5s that's a 0.005 increment per tick.
  if (crackleRampInterval === null) {
    crackleRampInterval = window.setInterval(tickCrackleRamp, 50);
  }
  ensurePlaybackWatchdog();
}
export function setCrackleEnabled(enabled: boolean): void {
  crackleEnabled = enabled;
  if (!enabled) {
    if (crackleEl) crackleEl.pause();
    return;
  }
  if (!crackleEl && crackleUrl) {
    startBackgroundCrackle(crackleUrl);
    return;
  }
  if (crackleEl) {
    if (crackleEl.paused) crackleEl.play().catch(() => {});
    crackleEl.volume = effectiveCrackleVolume();
  }
}
