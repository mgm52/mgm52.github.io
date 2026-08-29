// Tiny DOM-free helpers shared across modules.

// Promise that resolves after `ms`. Cutscene scripts chain these to pace
// beats; intro.ts keeps its own abortable variant.
export const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

// Wait for the player to advance a click-wall: a click on `target`, or Enter /
// Space from the keyboard so cutscene text can be paged without reaching for
// the mouse. `cancel` detaches both listeners and settles the promise early
// (used when a cutscene is aborted mid-beat).
export function waitForAdvance(target: HTMLElement): { done: Promise<void>; cancel: () => void } {
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => { settle = resolve; });
  const onClick = () => finish();
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    finish();
  };
  const finish = () => {
    target.removeEventListener('click', onClick);
    window.removeEventListener('keydown', onKey);
    settle();
  };
  target.addEventListener('click', onClick);
  window.addEventListener('keydown', onKey);
  return { done, cancel: finish };
}
