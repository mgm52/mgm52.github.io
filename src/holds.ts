// Body-class "hold" flags. Whoever owns the screen for a beat (a cutscene, a
// parlay, the task-complete ceremony) tags <body> with its class; the frame
// loop stops ticking the sim while any of them is set, and CSS keys off the
// same names to dim or lock the chrome. Keeping the list here means the frame
// loop, quick travel and the input layer can't drift out of agreement.

// Scripted beats: the world is frozen AND the player is a spectator of the
// moment — no travel, no orders.
export const CUTSCENE_HOLD_CLASSES = [
  'intro-cutscene-hold',   // the opening summon cutscene (intro.ts)
  'bob-cutscene-hold',     // Bob's arrival / the Gabbonsaw ritual (intro.ts)
  'demon-parlay-hold',     // a demon dialogue overlay (main.ts)
  'bob-spawn-hold',        // the beat of stillness after Bob emerges (input.ts)
  'unlock-reveal-hold',    // WORK COMPLETE + staged unlock reveal (ui.ts)
  'finale-hold',           // the closing confrontation + shatter (main.ts)
] as const;

export function cutsceneHoldActive(): boolean {
  const cl = document.body.classList;
  return CUTSCENE_HOLD_CLASSES.some((c) => cl.contains(c));
}

// Spectating a trader's card world (cards.ts sets the class for the whole
// visit): looking and selecting are fine, but the world takes no orders and
// time stands still.
export function spectatingNow(): boolean {
  return document.body.classList.contains('spectate-hold');
}

// The dev World Designer (designer.ts tags the body): every building is free,
// placed straight to active, and drag-paintable like a wall.
export function designerNow(): boolean {
  return document.body.classList.contains('world-designer-active');
}

// The designer's PAUSE toggle: freezes the sim while leaving the world fully
// interactive for authoring — no overlay, unlike the player-facing pause.
export function designerTimeFrozen(): boolean {
  return document.body.classList.contains('designer-time-frozen');
}
