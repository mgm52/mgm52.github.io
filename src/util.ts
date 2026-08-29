// Tiny DOM-free helpers shared across modules.

// Promise that resolves after `ms`. Cutscene scripts chain these to pace
// beats; intro.ts keeps its own abortable variant.
export const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
