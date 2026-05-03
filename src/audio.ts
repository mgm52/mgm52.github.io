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
} as const;

export type SoundName = keyof typeof REGISTRY;

let masterVolume = 0.7;
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

export function setMasterVolume(v: number) { masterVolume = Math.max(0, Math.min(1, v)); }
export function setMuted(m: boolean) { muted = m; }
export function isMuted() { return muted; }
