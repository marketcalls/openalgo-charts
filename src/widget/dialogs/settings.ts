/**
 * The chart settings dialog, generated from `chartSettingsSchema`.
 *
 * Nothing here names a control. The engine describes its tabs and inputs,
 * `readChartSettings` reports what the chart is drawing now, and
 * `applyChartSettings` takes a one-key patch back, so a control the engine
 * adds appears here on its own and a control the engine has no backing for
 * cannot appear at all. Edits apply live, which is the only honest preview of
 * a colour; Cancel and Escape put back the keys this session touched, and
 * only those, so an axis the user dragged while the dialog was open stays
 * where they left it.
 */
import { applyChartSettings, chartSettingsSchema, readChartSettings } from 'openalgo-charts';
import type { ChartSettingsTab, ChartSettingsTabId, ChartSettingsValues } from 'openalgo-charts';
import type { WidgetContext } from '../context';
import {
  button, controlsFromInputs, dialogFrame, el, glyphSvg, openPanel, renderForm, tabList,
  type FormHandle, type PanelHandle,
} from '../form';

export interface SettingsDialogOptions {
  /** The tab to open on. Default: the first tab with a control in it. */
  tab?: ChartSettingsTabId;
  /**
   * Why a control, or one option of a select, cannot act in this host right
   * now, or null. A host that draws its own trade chrome knows whether there
   * is a position to recolour; the engine does not.
   */
  unavailable?(key: string, option?: string): string | null;
  /** Runs after every write, including a revert, for state a host keeps outside the schema. */
  onApply?(patch: Readonly<Partial<ChartSettingsValues>>): void;
  /** Runs once when the dialog is gone; `committed` is false after Cancel or Escape. */
  onClose?(committed: boolean): void;
}

/**
 * A glyph per tab, keyed by the schema's tab id rather than by position so a
 * reordering in the engine cannot shuffle the pictures; a tab this table does
 * not know draws none.
 */
const TAB_GLYPH: Readonly<Record<string, string>> = {
  price: 'M5 2v12M3 5h4v6H3zM11 2v12M9 4h4v7H9z',
  readout: 'M2 4h8M2 8h12M2 12h9',
  axes: 'M3 2v11h11M3 6h2M3 10h2M7 13v-2M11 13v-2',
  appearance: 'M2 3h12v10H2zM2 8h12M7 3v10',
  trading: 'M2 12l4-4 3 2 5-6M11 4h3v3M2 14h12',
};

/** The defaults of one tab as a patch: both halves and the switch of a paired colour included. */
export function tabDefaults(tab: ChartSettingsTab): ChartSettingsValues {
  const patch: ChartSettingsValues = {};
  for (const input of tab.inputs) {
    if (input.type === 'colorPair') {
      patch[input.up.key] = input.up.default;
      patch[input.down.key] = input.down.default;
      if (input.enabled !== undefined) patch[input.enabled.key] = input.enabled.default;
    } else {
      patch[input.key] = input.default;
    }
  }
  return patch;
}

/**
 * Open the chart settings dialog, centred over the widget. `anchor` is
 * accepted for the registry's uniform signature and not used: a dialog this
 * size is not a popover.
 */
export function mountSettingsDialog(
  ctx: WidgetContext, _anchor?: HTMLElement, opts: SettingsDialogOptions = {},
): PanelHandle {
  const { chart } = ctx;
  const doc = ctx.document;
  // An empty tab is hidden rather than shown bare: the Price tab has no
  // controls before a series exists, and a tab of nothing reads as broken.
  const tabs = chartSettingsSchema(chart).filter((t) => t.inputs.length > 0);
  const before = readChartSettings(chart);
  const dirty = new Set<string>();
  let activeTab: string = tabs.some((t) => t.id === opts.tab) ? (opts.tab as string) : (tabs[0]?.id ?? 'price');
  let form: FormHandle | null = null;
  let committed = false;

  const write = (patch: ChartSettingsValues): void => {
    for (const k of Object.keys(patch)) dirty.add(k);
    applyChartSettings(chart, patch);
    opts.onApply?.(patch);
  };

  const frame = dialogFrame(doc, { title: 'Chart settings', className: 'oac-settings', onClose: () => cancel() });
  const main = el(doc, 'div', 'oac-settings__main');
  const pane = el(doc, 'div', 'oac-settings__pane');
  frame.body.appendChild(main);
  const nav = tabList(doc, tabs.map((t) => ({ id: t.id, label: t.label, icon: glyphSvg(TAB_GLYPH[t.id] ?? '') })),
    activeTab, 'rail', (id) => { activeTab = id; renderPane(); });
  main.appendChild(nav.el);

  function renderPane(): void {
    const tab = tabs.find((t) => t.id === activeTab);
    pane.innerHTML = '';
    form = null;
    if (tab === undefined) {
      pane.appendChild(el(doc, 'div', 'oac-empty', 'Nothing to configure on this chart yet.'));
      return;
    }
    // Re-read on every paint: edits apply live, so a tab left and returned to
    // has to show what the chart is drawing now, not what it drew when opened.
    form = renderForm(pane, controlsFromInputs(tab.inputs), {
      values: readChartSettings(chart),
      idPrefix: 'oac-cset',
      live: true,
      unavailable: opts.unavailable,
      onChange: (key, value) => {
        write({ [key]: value as ChartSettingsValues[string] });
        // One write can move a neighbour (a scale mode changes what auto-fit
        // reads), so every other control re-reads the chart.
        form?.sync(readChartSettings(chart));
      },
    });
  }

  main.appendChild(pane);
  renderPane();

  frame.lead.appendChild(button(doc, {
    label: 'Restore this tab',
    onClick: () => {
      const tab = tabs.find((t) => t.id === activeTab);
      if (tab === undefined) return;
      // Marked dirty like any edit, so Cancel still undoes a restore.
      write(tabDefaults(tab));
      renderPane();
    },
  }));
  frame.actions.appendChild(button(doc, { label: 'Cancel', onClick: () => cancel() }));
  frame.actions.appendChild(button(doc, { label: 'OK', variant: 'primary', onClick: () => ok() }));

  // Escape and the scrim are the shell's, and both mean Cancel.
  const handle = openPanel(ctx, frame.el, { placement: 'center', modal: true }, () => cancel());

  function revert(): void {
    if (committed || dirty.size === 0) return;
    const back: ChartSettingsValues = {};
    for (const key of dirty) {
      const v = before[key];
      if (v !== undefined) back[key] = v;
    }
    dirty.clear();
    applyChartSettings(chart, back);
    opts.onApply?.(back);
  }
  function cancel(): void {
    if (!handle.isOpen()) return;
    revert();
    handle.close();
    opts.onClose?.(false);
  }
  function ok(): void {
    if (!handle.isOpen()) return;
    committed = true;
    handle.close();
    opts.onClose?.(true);
  }

  return {
    el: frame.el,
    isOpen: handle.isOpen,
    // A programmatic close (the widget being destroyed) keeps what was applied,
    // the way OK does: the edits are already on the chart.
    close: () => ok(),
  };
}
