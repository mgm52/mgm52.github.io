// Tiny pooled audio player. One pool per sound so rapid retriggers don't
// cut off in-flight playback (a single Audio element can only play once at
// a time).

const POOL_SIZE = 4;
const pools = new Map<string, HTMLAudioElement[]>();

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
} as const;

export type SoundName = keyof typeof REGISTRY;

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
  for (const [name, url] of Object.entries(REGISTRY)) {
    const pool: HTMLAudioElement[] = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const a = new Audio(url);
      a.preload = 'auto';
      // Default is true → playbackRate time-stretches instead of resampling.
      // We want pitch to follow rate (resampling), so disable preservation.
      a.preservesPitch = false;
      pool.push(a);
    }
    pools.set(name, pool);
  }
}

export function playSound(name: SoundName, volume = 1, playbackRate?: number) {
  if (muted) return;
  if (inHellView && name === 'goblin_spawn') return;
  const pool = pools.get(name);
  if (!pool) return;
  const free = pool.find((a) => a.paused || a.ended) ?? pool[0];
  free.currentTime = 0;
  free.volume = Math.max(0, Math.min(1, masterVolume * volume));
  free.preservesPitch = false;
  free.playbackRate = Math.max(0.25, Math.min(4, playbackRate ?? 1));
  free.play().catch(() => { /* autoplay may be blocked until first interaction */ });
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
export function isMuted() { return muted; }
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
// This pulls it back up by 50%; the result is still clamped to 1.
const MUSIC_GAIN = 1.5;
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
