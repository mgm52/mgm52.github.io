// Brief cursor-twist effect at the given viewport coordinates. Only
// fires on right-click "give a command" actions. CSS in index.html
// drives the rotation; the sprite is always the gothic arrow since
// right-clicks happen over the world canvas.
export function flashCursor(clientX: number, clientY: number): void {
  const el = document.createElement('div');
  el.className = 'cursor-flash';
  el.style.left = clientX + 'px';
  el.style.top = clientY + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 320);
}
