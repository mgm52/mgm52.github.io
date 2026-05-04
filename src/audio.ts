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
} as const;

export type SoundName = keyof typeof REGISTRY;

let masterVolume = 0.7;
let musicVolume = 0.7;
let muted = false;

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

// ─── Looping background music ───────────────────────────────────────
// One persistent <audio> element, lazy-started after first user gesture so
// the browser's autoplay policy lets it through. The source mp3 is
// loudness-normalised offline (-14 LUFS); the music slider attenuates it
// further on top of the master volume.
let musicEl: HTMLAudioElement | null = null;
function effectiveMusicVolume(): number {
  return Math.max(0, Math.min(1, masterVolume * musicVolume));
}
export function startBackgroundMusic(url: string): void {
  if (musicEl) return;
  const a = new Audio(url);
  a.loop = true;
  a.preload = 'auto';
  a.volume = effectiveMusicVolume();
  a.play().catch(() => {/* gated until next gesture; caller should retry */});
  musicEl = a;
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
