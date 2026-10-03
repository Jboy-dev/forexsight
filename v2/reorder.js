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

const RO_THRESHOLD = 8;        // px before a press becomes a drag
const RO_HOLD_MS = 180;        // on touch, a brief hold also starts it

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
    if (e.target.closest('input, select, textarea, a')) return;

    drag = {
      item, startX: e.clientX, startY: e.clientY, active: false,
      pointerId: e.pointerId, holdTimer: null,
      rect: item.getBoundingClientRect(),
    };
    // On touch a deliberate hold starts the drag even without movement, which
    // is how a one-finger rearrange is meant to feel.
    if (e.pointerType === 'touch') {
      drag.holdTimer = setTimeout(() => { if (drag && !drag.active) begin(e); }, RO_HOLD_MS);
    }
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
    if (!drag.active) {
      const moved = axis === 'x' ? Math.abs(dx) : Math.abs(dy);
      const other = axis === 'x' ? Math.abs(dy) : Math.abs(dx);
      // Movement along the OTHER axis is a scroll, not a drag — let it through.
      if (moved < RO_THRESHOLD || other > moved) {
        if (other > RO_THRESHOLD) { clearTimeout(drag.holdTimer); cleanup(); }
        return;
      }
      begin(e);
    }
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
      it.classList.remove('ro-item-drag');
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
