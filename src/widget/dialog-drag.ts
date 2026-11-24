/**
 * Moving a centred dialog by its title bar. A dialog opens over the middle of
 * the chart, which is where the study or the candles being tuned usually are,
 * and its edits preview live: the reader has to be able to slide it aside to
 * see what a setting does.
 *
 * The move is an offset on top of wherever the dialog was placed, through the
 * `translate` property, so the centring transform, a panel placed at a point
 * and a dialog that grows with its tab all keep working as they did. Nothing
 * is remembered: a dialog that is closed and opened again is centred again.
 */

/** Width of the title bar that always stays inside the widget, so it can be caught again. */
const KEEP = 64;

export interface DialogRest {
  /** The dialog's left edge inside the widget, before any offset. */
  left: number;
  /** Its top edge inside the widget, before any offset. */
  top: number;
  width: number;
  /** Height of its title bar. */
  head: number;
}

/**
 * The offset nearest the one asked for that leaves the title bar reachable:
 * all of its height inside the widget, and `KEEP` of its width. The body may
 * leave the widget, which is the point when the dialog is nearly as large as
 * the chart. A widget smaller than the bar pins it to the top left.
 */
export function clampDialogOffset(rest: DialogRest, bounds: { width: number; height: number }, x: number, y: number): { x: number; y: number } {
  const keep = Math.min(KEEP, rest.width, bounds.width);
  const within = (value: number, low: number, high: number): number => Math.max(low, Math.min(value, Math.max(low, high)));
  return {
    x: within(rest.left + x, keep - rest.width, bounds.width - keep) - rest.left,
    y: within(rest.top + y, 0, bounds.height - rest.head) - rest.top,
  };
}

/** Let `dialog` be dragged inside `root` by its `.oac-dialog__head`. A press on a control in the bar is that control's. */
export function dragDialog(root: HTMLElement, dialog: HTMLElement): void {
  let x = 0;
  let y = 0;
  dialog.addEventListener('pointerdown', (e) => {
    const down = e as PointerEvent;
    const target = down.target as Element | null;
    const head = target?.closest<HTMLElement>('.oac-dialog__head') ?? null;
    // A bottom sheet is pinned to the screen edge by its own rule.
    if (head === null || target === null || down.button !== 0 || dialog.classList.contains('oac-mobile-sheet')) return;
    if (target.closest('button, input, select, textarea, a') !== null) return;
    const bounds = root.getBoundingClientRect();
    const box = dialog.getBoundingClientRect();
    const rest: DialogRest = { left: box.left - bounds.left - x, top: box.top - bounds.top - y, width: box.width, head: head.offsetHeight };
    const from = { x: down.clientX - x, y: down.clientY - y };
    const move = (ev: Event): void => {
      const at = ev as PointerEvent;
      ({ x, y } = clampDialogOffset(rest, bounds, at.clientX - from.x, at.clientY - from.y));
      dialog.style.translate = `${x}px ${y}px`;
    };
    const end = (): void => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', end);
      head.removeEventListener('pointercancel', end);
    };
    // Capture keeps the drag alive when the pointer outruns the bar. A
    // scripted press has no live pointer to capture, and still moves the
    // dialog while it stays over the bar.
    try { head.setPointerCapture(down.pointerId); } catch { /* no live pointer */ }
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  });
}
