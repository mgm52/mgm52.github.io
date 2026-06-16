// ─── The dev World Designer ──────────────────────────────────────────
// A dev-only tool to hand-author game worlds and save them to the manual-
// world database (shared with cards.ts), where they become the dominant
// trading-card source. A designed world is a SANDBOX: tasks are disabled and
// every sidebar ability is unlocked (makeSandboxWorld), so the dev places
// buildings / digs / summons with the standard game UI while a fixed designer
// bar across the top sets name / tier / resources and saves or exits.
//
// It boots by mirroring cards.ts's WORLD-HOP PATTERN: launching the designer
// stashes the current save into a designer-owned key, writes the world to be
// edited into the regular save slot, sets the designer flags, and reloads —
// so the entire existing boot pipeline does the heavy lifting. main.ts's boot
// branch treats an active designer like a card world for save-loading + title-
// skip, but mounts setupDesignerChrome (this file) instead of the card chrome.
//
// This module owns its OWN localStorage keys (it does NOT touch cards.ts's
// private OUTER_KEY / hop plumbing internals) but reuses cards.ts's exported
// manual-world DB accessors and the shared markCardHop hop guard.

import { clearSave, getRawSave, saveGame, setRawSave } from './save';
import { GameState, markBuildingsChanged, removeAllUnits } from './state';
import { spawnGoldGoblinNow } from './sim';
import { ALL_TASK_IDS } from './ui';
import {
  CardTier, ManualWorld, cardPower, decodeWorld, encodeWorld, makeSandboxWorld,
} from './cards-core';
import { loadManualWorlds, markCardHop, saveManualWorlds, saveWorldsToFile } from './cards';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Designer localStorage keys ──────────────────────────────────────
// Distinct from cards.ts's keys so the two boot modes never collide.
//  - DESIGNER_KEY:      active flag — the next boot is a designer session.
//  - DESIGNER_EDIT_KEY: the manual-world id being edited (empty for a new
//                       world), so SAVE upserts rather than spawning dupes.
//  - DESIGNER_OUTER_KEY: verbatim stash of the outer save while designing
//                       (the regular slot holds the sandbox world meanwhile).
const DESIGNER_KEY = 'rts.designer.v1';
const DESIGNER_EDIT_KEY = 'rts.designeredit.v1';
const DESIGNER_OUTER_KEY = 'rts.designerouter.v1';

export function designerActive(): boolean {
  try { return localStorage.getItem(DESIGNER_KEY) === '1'; } catch { return false; }
}

// The id of the manual world being edited (null for a brand-new world).
function designerEditId(): number | null {
  try {
    const raw = localStorage.getItem(DESIGNER_EDIT_KEY);
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

// ─── The white bridge (mirrors cards.ts hopWhite) ────────────────────
// A full-screen white that bridges every designer reload, lazily created at
// body level so it sits above everything. Same id cards.ts uses — there's
// only ever one hop in flight, and sharing it keeps the fade language uniform.
function hopWhite(): HTMLElement {
  let el = document.getElementById('card-hop-white');
  if (!el) {
    el = document.createElement('div');
    el.id = 'card-hop-white';
    document.body.appendChild(el);
  }
  return el;
}

async function fadeToWhiteAndReload(): Promise<void> {
  markCardHop();
  const white = hopWhite();
  white.style.transition = 'opacity 700ms ease-in';
  requestAnimationFrame(() => { white.style.opacity = '1'; });
  await sleep(800);
  location.reload();
}

// ─── Boot the designer ───────────────────────────────────────────────
// Stash the current save, build the world to edit (a fresh sandbox for a new
// world, or the decoded manual world for an edit), write it into the regular
// slot, set the designer flags, and fade-reload into it. The next boot lands
// in the sandbox with setupDesignerChrome mounted.
export function launchDesigner(editId?: number): void {
  const outer = getRawSave();
  try {
    if (outer !== null) localStorage.setItem(DESIGNER_OUTER_KEY, outer);
    else localStorage.removeItem(DESIGNER_OUTER_KEY);
  } catch { /* storage full — exit will just clear the (empty) slot */ }

  let world: GameState | null = null;
  if (editId !== undefined) {
    const existing = loadManualWorlds().find((m) => m.id === editId);
    if (existing) world = decodeWorld(existing.data);
  }
  if (!world) world = makeSandboxWorld(ALL_TASK_IDS);

  saveGame(world);
  try {
    localStorage.setItem(DESIGNER_KEY, '1');
    localStorage.setItem(DESIGNER_EDIT_KEY, editId !== undefined ? String(editId) : '');
  } catch { /* storage full — the session just won't flag; bail quietly */ }
  void fadeToWhiteAndReload();
}

// Leave the designer: restore the stashed outer save into the slot (or clear
// it if there was none), drop the designer flags, and fade-reload back to the
// normal game.
export function exitDesigner(): void {
  void (async () => {
    markCardHop();
    const white = hopWhite();
    white.style.transition = 'opacity 700ms ease-in';
    requestAnimationFrame(() => { white.style.opacity = '1'; });
    await sleep(800);
    const outer = (() => {
      try { return localStorage.getItem(DESIGNER_OUTER_KEY); } catch { return null; }
    })();
    if (outer !== null) setRawSave(outer);
    else clearSave();
    try {
      localStorage.removeItem(DESIGNER_KEY);
      localStorage.removeItem(DESIGNER_EDIT_KEY);
      localStorage.removeItem(DESIGNER_OUTER_KEY);
    } catch { /* no-op */ }
    location.reload();
  })();
}

// ─── Saving the authored world ───────────────────────────────────────
// Build a ManualWorld from the live sandbox state and upsert it into the DB by
// id. The state keeps its sandbox flags (tasksDisabled + every unlock) — they
// ride along into the saved card, so re-entering one as a card stays a
// sandbox. A fresh world gets a unique id; an edited one keeps its id.
export function saveCurrentWorld(state: GameState, name: string, tier: CardTier): ManualWorld {
  const list = loadManualWorlds();
  const editId = designerEditId();
  // A fresh id that can't collide with anything already in the DB (or the one
  // being edited). Date.now() base keeps it monotonic across sessions.
  const id = editId ?? (() => {
    let next = Date.now();
    const taken = new Set(list.map((m) => m.id));
    while (taken.has(next)) next++;
    return next;
  })();
  const world: ManualWorld = {
    id,
    name: name.trim() || 'untitled world',
    tier,
    data: encodeWorld(state),
    resources: {
      money: state.money,
      blood: state.blood,
      dragonBone: state.dragonBone,
      power: cardPower(state),
      goblins: state.goblins.size,
    },
  };
  const idx = list.findIndex((m) => m.id === id);
  if (idx >= 0) list[idx] = world;
  else list.push(world);
  saveManualWorlds(list);
  // Pin the edit id so subsequent saves in this same session upsert instead
  // of spawning a second copy of a world that started life "new".
  try { localStorage.setItem(DESIGNER_EDIT_KEY, String(id)); } catch { /* no-op */ }
  return world;
}

// ─── In-designer chrome ──────────────────────────────────────────────
// A fixed bar across the top (its own DOM, high z-index, distinct from the
// game's #leave-world-btn) holding: NAME input, TIER select, resource setters
// (money / blood / bones, which write straight into state and seed the
// matching *Earned / *Unlocked so the sidebar rows show), and SAVE / EXIT.
// Power is derived from buildings (cardPower) — placed in the world itself —
// so it gets no setter.
export function setupDesignerChrome(state: GameState): void {
  document.body.classList.add('world-designer-active');

  const editId = designerEditId();
  const existing = editId !== null
    ? loadManualWorlds().find((m) => m.id === editId) ?? null
    : null;

  const bar = document.createElement('div');
  bar.id = 'wd-bar';

  const title = document.createElement('span');
  title.className = 'wd-bar-title';
  title.textContent = existing ? 'WORLD DESIGNER · editing' : 'WORLD DESIGNER · new world';
  bar.appendChild(title);

  // NAME.
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'wd-name';
  nameInput.placeholder = 'world name';
  nameInput.value = existing?.name ?? '';
  bar.appendChild(labelled('name', nameInput));

  // TIER.
  const tierSelect = document.createElement('select');
  tierSelect.className = 'wd-tier';
  for (const t of ['common', 'uncommon', 'rare'] as CardTier[]) {
    const opt = document.createElement('option');
    opt.value = t; opt.textContent = t;
    if ((existing?.tier ?? 'common') === t) opt.selected = true;
    tierSelect.appendChild(opt);
  }
  bar.appendChild(labelled('tier', tierSelect));

  // Resource setters. Each writes the live value AND seeds the *Earned /
  // *Unlocked flags so the sidebar's row appears (the game hides rows for
  // resources never earned).
  bar.appendChild(resourceSetter('Ƶ money', state.money, (v) => {
    state.money = v;
    if (v > state.moneyEarned) state.moneyEarned = v;
  }));
  bar.appendChild(resourceSetter('blood', state.blood, (v) => {
    state.blood = v;
    if (v > state.bloodEarned) state.bloodEarned = v;
    if (v > 0) state.bloodUnlocked = true;
  }));
  bar.appendChild(resourceSetter('bones', state.dragonBone, (v) => {
    state.dragonBone = v;
    if (v > state.dragonBoneEarned) state.dragonBoneEarned = v;
    if (v > 0) state.dragonBoneUnlocked = true;
  }));

  // Realm access — three checkboxes gating which views the authored world can
  // reach. earth maps to the inverse of groundLocked; space/hell to the
  // existing unlock flags. These ride into the saved card via encodeWorld.
  const realms = document.createElement('div');
  realms.className = 'wd-realms';
  realms.appendChild(realmToggle('earth', !state.groundLocked, (on) => { state.groundLocked = !on; }));
  realms.appendChild(realmToggle('space', state.spaceUnlocked, (on) => { state.spaceUnlocked = on; }));
  realms.appendChild(realmToggle('hell', state.hellUnlocked, (on) => { state.hellUnlocked = on; }));
  bar.appendChild(realms);

  // PAUSE / PLAY — freezes the sim (sprites + state.now) so the world holds
  // still while authoring, without the player-facing pause overlay. main.ts's
  // frame loop checks the 'designer-time-frozen' body class. Leaving the
  // designer can't strand the flag: the class lives on the body that the exit
  // reload replaces. Starts running so the world behaves normally until paused.
  const timeBtn = document.createElement('button');
  timeBtn.type = 'button';
  timeBtn.className = 'wd-time';
  const syncTimeBtn = () => {
    const frozen = document.body.classList.contains('designer-time-frozen');
    timeBtn.textContent = frozen ? '▶ PLAY' : '⏸ PAUSE';
    timeBtn.classList.toggle('frozen', frozen);
  };
  timeBtn.addEventListener('click', () => {
    document.body.classList.toggle('designer-time-frozen');
    syncTimeBtn();
  });
  syncTimeBtn();
  bar.appendChild(timeBtn);

  // CLEAR UNITS — wipe every mobile unit (goblins, minotaurs, dragons, …) so
  // the dev can re-stage a world without hand-killing each one. Buildings and
  // terrain stay put.
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'wd-clear';
  clearBtn.textContent = 'REMOVE ALL UNITS';
  clearBtn.addEventListener('click', () => {
    removeAllUnits(state);
    markBuildingsChanged(state);
  });
  bar.appendChild(clearBtn);

  // PLACE ORIGINAL HOLE — arms a one-shot placement: the next ground click
  // (re)positions the world's original Goblin Hole and un-destroys it, free.
  // Lets a dev relocate the spawn point or restore it after deleting it from
  // the hole's info panel.
  const holeBtn = document.createElement('button');
  holeBtn.type = 'button';
  holeBtn.className = 'wd-hole';
  holeBtn.textContent = 'ORIGINAL HOLE';
  holeBtn.addEventListener('click', () => {
    state.pendingBuild = null;
    state.pendingOriginalHole = true;
  });
  bar.appendChild(holeBtn);

  // SPAWN GOLDBLIN — hatch a gold goblin immediately at a hole, free and
  // queue-free, for staging a world.
  const goldBtn = document.createElement('button');
  goldBtn.type = 'button';
  goldBtn.className = 'wd-gold';
  goldBtn.textContent = '+ GOLDBLIN';
  goldBtn.addEventListener('click', () => spawnGoldGoblinNow(state));
  bar.appendChild(goldBtn);

  // SAVE / EXIT.
  const actions = document.createElement('div');
  actions.className = 'wd-actions';

  const toast = document.createElement('span');
  toast.className = 'wd-toast';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'wd-save';
  saveBtn.textContent = 'SAVE WORLD';
  saveBtn.addEventListener('click', () => {
    const tier = tierSelect.value as CardTier;
    const saved = saveCurrentWorld(state, nameInput.value, tier);
    nameInput.value = saved.name;
    title.textContent = 'WORLD DESIGNER · editing';
    toast.textContent = `saved "${saved.name}" (${saved.tier})`;
    toast.classList.remove('show');
    void toast.offsetWidth;
    toast.classList.add('show');
  });
  actions.appendChild(saveBtn);

  const exitBtn = document.createElement('button');
  exitBtn.type = 'button';
  exitBtn.className = 'wd-exit';
  exitBtn.textContent = 'EXIT';
  exitBtn.addEventListener('click', () => {
    exitBtn.disabled = true;
    exitDesigner();
  });
  actions.appendChild(exitBtn);
  actions.appendChild(toast);

  bar.appendChild(actions);
  document.body.appendChild(bar);
}

// A label + control pair for the bar.
function labelled(label: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'wd-field';
  const span = document.createElement('span');
  span.className = 'wd-field-label';
  span.textContent = label;
  wrap.appendChild(span);
  wrap.appendChild(control);
  return wrap;
}

// A realm-access checkbox: a labelled toggle whose change writes straight into
// the live state via `onChange(checked)`.
function realmToggle(label: string, initial: boolean, onChange: (on: boolean) => void): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'wd-realm';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = initial;
  box.addEventListener('change', () => onChange(box.checked));
  const span = document.createElement('span');
  span.textContent = label;
  wrap.appendChild(box);
  wrap.appendChild(span);
  return wrap;
}

// A resource setter: a number input plus quick +/- steppers. `onSet` writes
// the new value into the live state; the input reflects whatever the dev types
// or steps to.
function resourceSetter(label: string, initial: number, onSet: (v: number) => void): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'wd-res';
  const lbl = document.createElement('span');
  lbl.className = 'wd-field-label';
  lbl.textContent = label;
  wrap.appendChild(lbl);

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'wd-res-input';
  input.min = '0';
  input.value = String(Math.floor(initial));
  const commit = () => {
    const v = Math.max(0, Math.floor(Number(input.value) || 0));
    input.value = String(v);
    onSet(v);
  };
  input.addEventListener('change', commit);
  input.addEventListener('input', commit);

  wrap.appendChild(input);
  return wrap;
}

// ─── List / edit overlay ─────────────────────────────────────────────
// A DOM overlay listing every saved manual world (name / tier / key
// resources) with EDIT + DELETE per row, plus NEW WORLD and CLOSE. Opened
// from the dev options menu while in the normal game.
export function openDesignerList(): void {
  // Single instance — clicking the menu twice just re-renders.
  document.getElementById('wd-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'wd-overlay';

  const panel = document.createElement('div');
  panel.className = 'wd-panel';

  const header = document.createElement('div');
  header.className = 'wd-panel-head';
  const h = document.createElement('span');
  h.className = 'wd-panel-title';
  h.textContent = 'WORLD DESIGNER';
  header.appendChild(h);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'wd-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'wd-newworld';
  newBtn.textContent = '+ NEW WORLD';
  newBtn.addEventListener('click', () => launchDesigner());
  panel.appendChild(newBtn);

  // SAVE TO FILE — snapshot the whole library to the committed repo file
  // (public/worlds.json) via the dev server, making it permanent + shareable
  // rather than living only in this browser's localStorage.
  const fileRow = document.createElement('div');
  fileRow.className = 'wd-filerow';
  const fileBtn = document.createElement('button');
  fileBtn.type = 'button';
  fileBtn.className = 'wd-tofile';
  fileBtn.textContent = '💾 SAVE ALL TO FILE';
  const fileStatus = document.createElement('span');
  fileStatus.className = 'wd-filestatus';
  fileBtn.addEventListener('click', () => {
    void (async () => {
      fileBtn.disabled = true;
      fileStatus.textContent = 'saving…';
      const list = loadManualWorlds();
      const ok = await saveWorldsToFile(list);
      fileStatus.textContent = ok
        ? `saved ${list.length} world${list.length === 1 ? '' : 's'} to public/worlds.json`
        : 'save failed — is the dev server running? (no file write in a static build)';
      fileBtn.disabled = false;
    })();
  });
  fileRow.appendChild(fileBtn);
  fileRow.appendChild(fileStatus);
  panel.appendChild(fileRow);

  const listWrap = document.createElement('div');
  listWrap.className = 'wd-list';
  panel.appendChild(listWrap);

  const renderList = () => {
    listWrap.innerHTML = '';
    const worlds = loadManualWorlds();
    if (worlds.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'wd-empty';
      empty.textContent = 'no saved worlds yet — make one with NEW WORLD.';
      listWrap.appendChild(empty);
      return;
    }
    for (const w of worlds) {
      const row = document.createElement('div');
      row.className = `wd-row t-${w.tier}`;

      const info = document.createElement('div');
      info.className = 'wd-row-info';
      const name = document.createElement('div');
      name.className = 'wd-row-name';
      name.textContent = w.name;
      const meta = document.createElement('div');
      meta.className = 'wd-row-meta';
      meta.textContent = `${w.tier} · ${describeResources(w)}`;
      info.appendChild(name);
      info.appendChild(meta);
      row.appendChild(info);

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'wd-row-edit';
      editBtn.textContent = 'EDIT';
      editBtn.addEventListener('click', () => launchDesigner(w.id));
      row.appendChild(editBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'wd-row-del';
      delBtn.textContent = 'DELETE';
      delBtn.addEventListener('click', () => {
        if (delBtn.dataset.armed !== '1') {
          delBtn.dataset.armed = '1';
          delBtn.textContent = 'SURE?';
          window.setTimeout(() => {
            if (delBtn.dataset.armed === '1') {
              delBtn.dataset.armed = '';
              delBtn.textContent = 'DELETE';
            }
          }, 2500);
          return;
        }
        const remaining = loadManualWorlds().filter((m) => m.id !== w.id);
        saveManualWorlds(remaining);
        // Also rewrite the committed file so a file-backed world doesn't just
        // reappear on the next reload (the boot merge would re-add it). Best
        // effort — in a static build the localStorage delete still holds for
        // the session. Updates the in-memory cache so the list refresh agrees.
        void saveWorldsToFile(remaining);
        renderList();
      });
      row.appendChild(delBtn);

      listWrap.appendChild(row);
    }
  };
  renderList();

  overlay.appendChild(panel);
  // Click on the backdrop (outside the panel) closes the overlay.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
}

function describeResources(w: ManualWorld): string {
  const r = w.resources;
  const fmt = (n: number) => Math.floor(n).toLocaleString('en-US');
  const parts: string[] = [];
  if (r.money > 0) parts.push(`Ƶ${fmt(r.money)}`);
  if (r.blood > 0) parts.push(`${fmt(r.blood)} blood`);
  if (r.dragonBone > 0) parts.push(`${fmt(r.dragonBone)} bones`);
  if ((r.goblins ?? 0) > 0) parts.push(`${fmt(r.goblins ?? 0)} goblins`);
  return parts.length ? parts.join(' · ') : 'empty';
}
