import * as devalue from 'devalue';
import { compressToUTF16, decompressFromUTF16 } from 'lz-string';
import { GameState, pruneAllAssignedGoblins, rebuildWalls } from './state';

const STORAGE_KEY = 'rts.savegame.v1';
const VERSION = 2;

// v2 wraps devalue.stringify in LZString.compressToUTF16. devalue handles
// Maps/Sets/Dates natively (no more __t tags) and emits a denser payload than
// JSON.stringify; LZString gives another ~80% on top because the state is
// dominated by repeating cell coordinates and goblin IDs.
//
// Detection on load: the new format is binary-ish UTF-16. The old v1 format
// is JSON, so it always starts with '{'. We probe the first character and
// route to the right decoder.

type SaveEnvelope = {
  version: number;
  savedAt: number;
  state: GameState;
};

// ─── Legacy v1 (JSON + __t tag) — read-only path for migration. ─────────
function v1Reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && '__t' in (value as Record<string, unknown>)) {
    const v = value as { __t: string; v: unknown };
    if (v.__t === 'Map') return new Map(v.v as [unknown, unknown][]);
    if (v.__t === 'Set') return new Set(v.v as unknown[]);
  }
  return value;
}

function tryDecodeV2(raw: string): SaveEnvelope | null {
  try {
    const decoded = decompressFromUTF16(raw);
    if (!decoded) return null;
    return devalue.parse(decoded) as SaveEnvelope;
  } catch { return null; }
}

function tryDecodeV1(raw: string): SaveEnvelope | null {
  try {
    return JSON.parse(raw, v1Reviver) as SaveEnvelope;
  } catch { return null; }
}

export function saveGame(state: GameState): void {
  try {
    const env: SaveEnvelope = { version: VERSION, savedAt: Date.now(), state };
    const serialized = devalue.stringify(env);
    const compressed = compressToUTF16(serialized);
    localStorage.setItem(STORAGE_KEY, compressed);
  } catch { /* storage full / unavailable — silently skip */ }
}

export function loadGame(): { state: GameState; savedAt: number } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    // Try the current format first; on any failure (corruption, wrong
    // codec, schema drift) fall back to the legacy v1 JSON decoder. Both
    // paths return null silently so a corrupt save just degrades to "no
    // resume available" rather than throwing.
    const env = tryDecodeV2(raw) ?? tryDecodeV1(raw);
    if (!env || !env.state) return null;

    // Walls are deterministic from playArea; rebuild after load so any future
    // schema drift in the persisted Set doesn't desync rendering / pathing.
    env.state.walls = rebuildWalls(env.state);
    env.state.wallsVersion = (env.state.wallsVersion ?? 0) + 1;
    // Migration: pre-fix saves accumulated duplicate / dangling IDs in
    // assignedGoblins (water-carrier reassignments leaked refs). Sweep once
    // on load so the first tick after resume sees a clean slate.
    pruneAllAssignedGoblins(env.state);
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
