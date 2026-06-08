// The list of demon sprite sheets available under assets/demons/, fetched
// from the manifest the vite demon-manifest plugin publishes (a static host
// can't list a directory). Shared by the renderer (which loads the sheets)
// and the options panel (which builds the per-demon sprite dropdowns), so it
// lives in its own module with no deps on either.

export type DemonSheetEntry = { id: string; label: string };

// "kings_demon_wilson" → "Kings Demon Wilson".
function labelFor(id: string): string {
  return id
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

let entries: DemonSheetEntry[] = [];
let promise: Promise<DemonSheetEntry[]> | null = null;

// Fetch + cache the manifest. Safe to call from multiple places — everyone
// shares the one fetch. A missing/broken manifest resolves to [] (the
// renderer falls back to the minotaur sheet; the dropdowns just list it).
export function loadDemonSheetList(): Promise<DemonSheetEntry[]> {
  promise ??= fetch('assets/demons/manifest.json')
    .then((r) => r.json() as Promise<string[]>)
    .then((ids) => {
      entries = ids.map((id) => ({ id, label: labelFor(id) }));
      return entries;
    })
    .catch((err) => {
      console.warn('demon sheet manifest failed to load', err);
      return entries;
    });
  return promise;
}

// Synchronous view of whatever has loaded so far — for callers that build UI
// before the fetch lands (they re-render via loadDemonSheetList().then).
export function getDemonSheetList(): DemonSheetEntry[] {
  return entries;
}
