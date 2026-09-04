/**
 * The indicator picker: everything the indicator registry holds, grouped by
 * category, with a search box that filters as you type. Built from
 * `registeredIndicators()` rather than a list of names, so a descriptor a host
 * registers itself appears beside the built-ins, and a widget loaded without
 * the indicators tier says so instead of showing an empty box.
 *
 * Picking a row adds an instance and leaves the picker up: a trader building
 * a layout adds three studies in a row, and closing after each would make
 * that three round trips through the menu.
 */
import { registeredIndicators } from 'openalgo-charts';
import type { IndicatorApi, IndicatorDescriptor } from 'openalgo-charts';
import type { WidgetContext } from '../context';
import { button, dialogFrame, el, openPanel, type PanelHandle } from '../form';

export interface IndicatorPickerOptions {
  /** Runs after each instance is added, with its handle. */
  onAdd?(inst: IndicatorApi): void;
  /** Close the picker after the first add. Default false. */
  closeOnAdd?: boolean;
}

/** Descriptors matching `query` (name, id or category, case-insensitive), sorted by name. */
export function filterIndicators(all: readonly IndicatorDescriptor[], query: string): IndicatorDescriptor[] {
  const q = query.trim().toLowerCase();
  const hit = (d: IndicatorDescriptor): boolean => q === ''
    || d.name.toLowerCase().includes(q)
    || d.id.toLowerCase().includes(q)
    || (d.category ?? '').toLowerCase().includes(q);
  return all.filter(hit).sort((a, b) => a.name.localeCompare(b.name));
}

/** Descriptors grouped by category, categories in alphabetical order, `Other` for the unfiled. */
export function groupIndicators(list: readonly IndicatorDescriptor[]): Array<[string, IndicatorDescriptor[]]> {
  const byCat = new Map<string, IndicatorDescriptor[]>();
  for (const d of list) {
    const cat = d.category ?? 'Other';
    const bucket = byCat.get(cat);
    if (bucket === undefined) byCat.set(cat, [d]); else bucket.push(d);
  }
  return Array.from(byCat.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * Open the picker below `anchor` (the toolbar's Indicators button), or centred
 * when there is none.
 */
export function mountIndicatorPicker(
  ctx: WidgetContext, anchor?: HTMLElement, opts: IndicatorPickerOptions = {},
): PanelHandle {
  const { chart } = ctx;
  const doc = ctx.document;
  const all = registeredIndicators();

  const frame = dialogFrame(doc, { title: 'Indicators', className: 'oac-pick', onClose: () => handle.close() });
  const find = el(doc, 'input', 'oac-pick__find');
  find.type = 'search';
  find.placeholder = 'Search indicators';
  find.setAttribute('aria-label', 'Search indicators');
  find.setAttribute('spellcheck', 'false');
  const findWrap = el(doc, 'div', 'oac-pick__findwrap');
  findWrap.appendChild(find);
  const list = el(doc, 'div', 'oac-pick__list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Indicators');
  frame.body.appendChild(findWrap);
  frame.body.appendChild(list);
  frame.actions.appendChild(button(doc, { label: 'Done', variant: 'primary', onClick: () => handle.close() }));

  let rows: HTMLButtonElement[] = [];
  let active = -1;

  const onChart = (id: string): number => chart.indicators().filter((i) => i.indicatorId === id).length;

  const setActive = (i: number): void => {
    if (rows.length === 0) { active = -1; return; }
    active = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach((r, k) => {
      r.classList.toggle('is-active', k === active);
      r.setAttribute('aria-selected', k === active ? 'true' : 'false');
    });
  };

  const add = (d: IndicatorDescriptor): void => {
    const inst = chart.addIndicator(d.id);
    ctx.toast(`Added ${inst.name}`, 'success');
    opts.onAdd?.(inst);
    if (opts.closeOnAdd === true) { handle.close(); return; }
    paint();
    find.focus();
  };

  function paint(): void {
    const query = find.value;
    list.innerHTML = '';
    rows = [];
    if (all.length === 0) {
      list.appendChild(el(doc, 'div', 'oac-empty',
        'No indicators are registered. Import the indicators tier to fill this list.'));
      return;
    }
    const shown = filterIndicators(all, query);
    if (shown.length === 0) {
      list.appendChild(el(doc, 'div', 'oac-empty', 'No match'));
      return;
    }
    for (const [cat, items] of groupIndicators(shown)) {
      list.appendChild(el(doc, 'div', 'oac-head', cat));
      for (const d of items) {
        const row = el(doc, 'button', 'oac-pick__row');
        row.type = 'button';
        row.setAttribute('role', 'option');
        row.dataset.id = d.id;
        row.appendChild(el(doc, 'span', 'oac-pick__name', d.name));
        const n = onChart(d.id);
        if (n > 0) {
          const badge = el(doc, 'span', 'oac-pick__count', n === 1 ? 'on chart' : `on chart x${n}`);
          badge.setAttribute('aria-label', n === 1 ? 'one instance on the chart' : `${n} instances on the chart`);
          row.appendChild(badge);
        }
        row.addEventListener('click', (e) => { e.stopPropagation(); add(d); });
        list.appendChild(row);
        rows.push(row);
      }
    }
    setActive(active < 0 ? 0 : active);
  }

  find.addEventListener('input', () => { active = 0; paint(); });
  find.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (k === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (k === 'Enter') {
      e.preventDefault();
      const row = rows[active];
      const id = row?.dataset.id;
      const d = all.find((x) => x.id === id);
      if (d !== undefined) add(d);
    }
  });
  paint();

  const handle = openPanel(
    ctx, frame.el,
    anchor === undefined ? { placement: 'center', modal: true, initialFocus: find } : { anchor, placement: 'below', initialFocus: find },
    () => {},
  );
  return handle;
}
