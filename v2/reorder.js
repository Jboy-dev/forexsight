/* ============================================================================
   v2/reorder.js — drag to rearrange.

   Pointer events, not HTML5 drag-and-drop. The HTML5 API does not fire on iOS
   at all, so a drag built on it works on a desktop and silently does nothing on
   the phone — which is where this is most wanted.

   THE RULE THAT MAKES IT USABLE: a press is not a drag until the pointer has
   moved past a threshold. Below it the gesture is still a tap, so tapping a tab
   still switches pane and tapping a price still copies it. Above it, the browser
   stops scrolling and the item follows your finger.

   Order is persisted by the caller through onSave, so a rearrangement survives
   a reload like every other preference here.
   ========================================================================== */
'use strict';

/* A drag must be DELIBERATE. The first version started one as soon as the
   pointer moved 8px, which meant brushing past a heading while scrolling or
   reading could pick a section up — it felt like the page was glitching rather
   than responding. Now nothing moves until you have held still for two full
   seconds, with a visible fill showing the hold building, and any real movement
   during that time cancels it as a scroll. */
const RO_HOLD_MS = 2000;       // how long to hold before a drag arms
const RO_SLOP = 10;            // movement during the hold that cancels it
/**
 * makeReorderable(container, { itemSelector, handleSelector, axis, onSave })
 *   onSave(idsInNewOrder) is called once, after the drop.
 */
function makeReorderable(container, opts) {
  if (!container || container._roBound) return;
  container._roBound = true;

  const itemSel = opts.itemSelector;
  const axis = opts.axis === 'x' ? 'x' : 'y';
  const onSave = opts.onSave || (() => {});
  const handleSel = opts.handleSelector || null;

  let drag = null;

  const items = () => [...container.querySelectorAll(itemSel)];

  const start = (e) => {
    if (e.button != null && e.button !== 0) return;          // left button only
    const item = e.target.closest(itemSel);
    if (!item || !container.contains(item)) return;
    if (handleSel && !e.target.closest(handleSel)) return;
    // Never hijack a press on something the person is trying to use.
    if (e.target.closest('input, select, textarea, a, .lvl, details, .cmd-chip')) return;

    drag = {
      item, startX: e.clientX, startY: e.clientY, active: false,
      pointerId: e.pointerId, holdTimer: null, armed: false,
      rect: item.getBoundingClientRect(),
    };

    // Show the hold building, so a press that is going somewhere looks like it
    // is going somewhere, and a press that is not can simply be released.
    item.classList.add('ro-holding');
    item.style.setProperty('--ro-hold', RO_HOLD_MS + 'ms');
    drag.holdTimer = setTimeout(() => {
      if (!drag) return;
      drag.armed = true;
      drag.item.classList.remove('ro-holding');
      drag.item.classList.add('ro-armed');
      try { navigator.vibrate && navigator.vibrate(12); } catch (_) {}
      begin(e);
    }, RO_HOLD_MS);

    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
  };

  const begin = () => {
    if (!drag || drag.active) return;
    drag.active = true;
    clearTimeout(drag.holdTimer);
    try { drag.item.setPointerCapture(drag.pointerId); } catch (_) {}
    container.classList.add('ro-dragging');
    drag.item.classList.add('ro-item-drag');
    // A placeholder keeps the layout from collapsing as the item lifts out.
    const ph = document.createElement(drag.item.tagName);
    ph.className = 'ro-placeholder';
    ph.style.width = drag.rect.width + 'px';
    ph.style.height = drag.rect.height + 'px';
    drag.ph = ph;
    drag.item.parentNode.insertBefore(ph, drag.item.nextSibling);
    drag.item.style.position = 'fixed';
    drag.item.style.zIndex = '200';
    drag.item.style.width = drag.rect.width + 'px';
    drag.item.style.left = drag.rect.left + 'px';
    drag.item.style.top = drag.rect.top + 'px';
    drag.item.style.pointerEvents = 'none';
    try { navigator.vibrate && navigator.vibrate(8); } catch (_) {}
  };

  const move = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;

    if (!drag.armed) {
      // Moving before the hold completes means this was a scroll or a swipe,
      // not an attempt to rearrange. Abandon quietly.
      if (Math.abs(dx) > RO_SLOP || Math.abs(dy) > RO_SLOP) cleanup();
      return;
    }

    if (!drag.active) begin(e);
    e.preventDefault();                                       // stop the page scrolling
    drag.item.style.left = (drag.rect.left + dx) + 'px';
    drag.item.style.top = (drag.rect.top + dy) + 'px';

    // Find the item the pointer is currently over and move the placeholder.
    const others = items().filter(x => x !== drag.item);
    for (const o of others) {
      const r = o.getBoundingClientRect();
      const mid = axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2;
      const p = axis === 'x' ? e.clientX : e.clientY;
      const within = axis === 'x'
        ? (e.clientY >= r.top && e.clientY <= r.bottom)
        : (e.clientX >= r.left && e.clientX <= r.right);
      if (!within) continue;
      if (p < mid && o.previousElementSibling !== drag.ph) { o.parentNode.insertBefore(drag.ph, o); break; }
      if (p >= mid && o.nextElementSibling !== drag.ph) { o.parentNode.insertBefore(drag.ph, o.nextSibling); break; }
    }
  };

  const end = () => {
    if (!drag) return;
    clearTimeout(drag.holdTimer);
    if (drag.active) {
      const it = drag.item;
      drag.ph.parentNode.insertBefore(it, drag.ph);
      drag.ph.remove();
      it.classList.remove('ro-item-drag', 'ro-holding', 'ro-armed');
      for (const k of ['position', 'zIndex', 'width', 'left', 'top', 'pointerEvents']) it.style[k] = '';
      container.classList.remove('ro-dragging');
      try { it.releasePointerCapture(drag.pointerId); } catch (_) {}
      const ids = items().map(x => x.dataset.roid).filter(Boolean);
      drag = null;
      cleanup();
      onSave(ids);
      return;
    }
    cleanup();
  };

  const cleanup = () => {
    if (drag && drag.item) {
      drag.item.classList.remove('ro-holding', 'ro-armed');
      drag.item.style.removeProperty('--ro-hold');
    }
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', end);
    document.removeEventListener('pointercancel', end);
    if (drag) { clearTimeout(drag.holdTimer); drag = null; }
  };

  container.addEventListener('pointerdown', start);
}

/** Applies a saved order to a container, leaving anything unknown at the end. */
function applyOrder(container, itemSelector, order) {
  if (!container || !Array.isArray(order) || !order.length) return;
  const items = [...container.querySelectorAll(itemSelector)];
  const byId = new Map(items.map(x => [x.dataset.roid, x]));
  for (const id of order) {
    const el = byId.get(id);
    if (el) container.appendChild(el);
  }
  // Anything saved order does not mention keeps its original relative place,
  // appended after — so adding a new section never makes it disappear.
  for (const it of items) if (!order.includes(it.dataset.roid)) container.appendChild(it);
}

window.FSREORDER = { make: makeReorderable, apply: applyOrder };
