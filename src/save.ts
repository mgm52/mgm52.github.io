import { GameState, rebuildWalls } from './state';

const STORAGE_KEY = 'rts.savegame.v1';
const VERSION = 1;

// Tagged-object replacer/reviver pair so JSON round-trips can carry Maps and
// Sets — GameState uses both (occupancy/buildings as Maps, walls/dugDirections
// as Sets) and the default JSON serialiser drops them silently.
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return { __t: 'Map', v: Array.from(value.entries()) };
  if (value instanceof Set) return { __t: 'Set', v: Array.from(value) };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && '__t' in (value as Record<string, unknown>)) {
    const v = value as { __t: string; v: unknown };
    if (v.__t === 'Map') return new Map(v.v as [unknown, unknown][]);
    if (v.__t === 'Set') return new Set(v.v as unknown[]);
  }
  return value;
}

type SaveEnvelope = {
  version: number;
  savedAt: number;
  state: GameState;
};

export function saveGame(state: GameState): void {
  try {
    const env: SaveEnvelope = { version: VERSION, savedAt: Date.now(), state };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(env, replacer));
  } catch { /* storage full / unavailable — silently skip */ }
}

export function loadGame(): { state: GameState; savedAt: number } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const env = JSON.parse(raw, reviver) as SaveEnvelope;
    if (!env || env.version !== VERSION || !env.state) return null;
    // Walls are deterministic from playArea; rebuild after load so any future
    // schema drift in the persisted Set doesn't desync rendering / pathing.
    env.state.walls = rebuildWalls(env.state);
    env.state.wallsVersion = (env.state.wallsVersion ?? 0) + 1;
    return { state: env.state, savedAt: env.savedAt };
  } catch { return null; }
}

export function clearSave(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* no-op */ }
}

export function hasSave(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== null; } catch { return false; }
}

// Coarse human-readable "X ago" — used on the title screen's resume button.
export function formatRelativeTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 90) return '1 minute ago';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}
