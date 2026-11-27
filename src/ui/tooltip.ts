/**
 * Tooltips for every `title` in the editor, sooner than the browser's own (which waits a second or more and can't be
 * changed). While the pointer rests on an element with a title, the title moves into one shared tooltip and comes
 * back when the pointer leaves, so screen readers and the markup still have it. Touch has no hover: it keeps nothing.
 */

/** The first tooltip waits this long; moving to a neighbour within GRACE of the last one shows it at once. */
const DELAY = 400;
const GRACE = 600;
const GAP = 6;
const MARGIN = 8;

let tip: HTMLDivElement | null = null;
let owner: HTMLElement | null = null;
let text = '';
let timer = 0;
let hiddenAt = 0;
let watch: MutationObserver | null = null;

function element(): HTMLDivElement {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  return tip;
}

/** Take the owner's title (again, if React wrote a new one while it was hovered), so the browser's never shows. */
function adopt() {
  if (!owner) return;
  const title = owner.getAttribute('title');
  if (title === null) return;
  owner.removeAttribute('title');
  text = title;
  if (tip && !tip.hidden) {
    if (title) place();
    else hide();
  }
}

function place() {
  if (!owner) return;
  const box = element();
  box.textContent = text;
  box.hidden = false;
  const at = owner.getBoundingClientRect();
  const size = box.getBoundingClientRect();
  const below = at.bottom + GAP + size.height <= innerHeight - MARGIN;
  const top = below ? at.bottom + GAP : Math.max(MARGIN, at.top - GAP - size.height);
  const left = Math.min(Math.max(MARGIN, at.left + at.width / 2 - size.width / 2), innerWidth - MARGIN - size.width);
  box.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function hide() {
  clearTimeout(timer);
  if (tip && !tip.hidden) {
    tip.hidden = true;
    hiddenAt = performance.now();
  }
}

function release() {
  hide();
  watch?.disconnect();
  if (owner && text && !owner.hasAttribute('title')) owner.setAttribute('title', text);
  owner = null;
  text = '';
}

function enter(target: HTMLElement) {
  release();
  owner = target;
  adopt();
  if (!text) return;
  watch ??= new MutationObserver(adopt);
  watch.observe(owner, { attributes: true, attributeFilter: ['title'] });
  const soon = performance.now() - hiddenAt < GRACE;
  timer = window.setTimeout(place, soon ? 0 : DELAY);
}

export function installTooltips() {
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const target = (e.target as Element | null)?.closest?.<HTMLElement>('[title]');
    // Still inside the element that owns the tooltip (its title is with us, so closest() misses it): keep it.
    if (owner && owner.contains(e.target as Node) && (!target || !owner.contains(target) || target === owner)) return;
    if (target) enter(target);
    else release();
  });
  document.addEventListener('pointerout', (e) => {
    if (owner && !owner.contains(e.relatedTarget as Node | null)) release();
  });
  // Pressing, scrolling (anything, since the tooltip doesn't follow) or typing puts it away; it comes back on the next
  // element the pointer rests on.
  for (const type of ['pointerdown', 'wheel', 'scroll', 'keydown'] as const) document.addEventListener(type, hide, { capture: true, passive: true });
  addEventListener('blur', release);
}
