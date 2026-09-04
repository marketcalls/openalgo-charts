/**
 * Settings for one indicator instance: the descriptor's own `inputs` on one
 * tab and the generated per-plot appearance (`indicatorStyleInputs`) on the
 * other. The same two tabs serve MACD, a Bollinger band and a host's own
 * descriptor, because nothing here is specific to any of them: a descriptor
 * declares a key, a type, a label and a default, and that is a form.
 *
 * Edits apply live through `setSettings` (a colour change restyles without
 * a recompute, a period change recomputes), and Cancel puts back the keys
 * this session touched.
 */
import { getIndicator, indicatorDefaults, indicatorStyleInputs } from 'openalgo-charts';
import type { IndicatorApi, IndicatorDescriptor, IndicatorInput, IndicatorSettings } from 'openalgo-charts';
import { chromeIconSvg } from 'openalgo-charts/draw';
import type { WidgetContext } from '../context';
import {
  button, controlsFromInputs, dialogFrame, el, glyphSvg, openPanel, renderForm, tabList,
  type FormHandle, type PanelHandle,
} from '../form';

export type IndicatorSettingsTab = 'inputs' | 'style';

export interface IndicatorSettingsOptions {
  /**
   * The instance to edit. Without it the dialog reads `data-instance-id` off
   * the anchor (a legend row's gear), and failing that edits the chart's only
   * indicator; with several and no id it declines with a toast.
   */
  instanceId?: string;
  tab?: IndicatorSettingsTab;
  /** Runs after every write, including a revert. */
  onChange?(inst: IndicatorApi): void;
  /** Runs once when the dialog is gone; `committed` is false after Cancel or Escape. */
  onClose?(committed: boolean): void;
}

const STYLE_GLYPH = 'M3 13c2.5 0 3.5-1.5 4-3.5M7.5 9.5 13 4a1.4 1.4 0 0 1 2 2l-5.5 5.5';

/** The defaults of a list of inputs, as a settings patch. */
export function inputDefaults(inputs: readonly IndicatorInput[]): IndicatorSettings {
  const out: IndicatorSettings = {};
  for (const i of inputs) out[i.key] = i.default;
  return out;
}

/** Which instance a mount call means; null with a reason when it cannot tell. */
export function resolveInstance(
  ctx: WidgetContext, anchor: HTMLElement | undefined, opts: IndicatorSettingsOptions,
): { inst: IndicatorApi | null; why: string | null } {
  const all = ctx.chart.indicators();
  const id = opts.instanceId ?? anchor?.dataset.instanceId;
  if (id !== undefined) {
    const inst = all.find((i) => i.id === id) ?? null;
    return inst === null ? { inst: null, why: 'That indicator is no longer on the chart' } : { inst, why: null };
  }
  if (all.length === 1) return { inst: all[0], why: null };
  return { inst: null, why: all.length === 0 ? 'No indicator on the chart to configure' : 'Pick an indicator from the legend first' };
}

/** A handle for a dialog that never opened, so a caller can `close()` it regardless. */
function declined(ctx: WidgetContext, why: string): PanelHandle {
  ctx.toast(why, 'info');
  return { el: ctx.document.createElement('div'), close: () => {}, isOpen: () => false };
}

export function mountIndicatorSettings(
  ctx: WidgetContext, anchor?: HTMLElement, opts: IndicatorSettingsOptions = {},
): PanelHandle {
  const doc = ctx.document;
  const resolved = resolveInstance(ctx, anchor, opts);
  if (resolved.inst === null) return declined(ctx, resolved.why ?? 'No indicator to configure');
  const inst: IndicatorApi = resolved.inst;
  const descriptor: IndicatorDescriptor = getIndicator(inst.indicatorId);

  const tabs: Array<{ id: IndicatorSettingsTab; label: string; icon: string; inputs: readonly IndicatorInput[] }> = [];
  if (descriptor.inputs.length > 0) tabs.push({ id: 'inputs', label: 'Inputs', icon: chromeIconSvg('settings'), inputs: descriptor.inputs });
  const style = indicatorStyleInputs(descriptor);
  if (style.length > 0) tabs.push({ id: 'style', label: 'Style', icon: glyphSvg(STYLE_GLYPH), inputs: style });
  if (tabs.length === 0) return declined(ctx, `${inst.name} has nothing to configure`);

  const before = inst.settings();
  const dirty = new Set<string>();
  let activeTab: IndicatorSettingsTab = tabs.some((t) => t.id === opts.tab) ? (opts.tab as IndicatorSettingsTab) : tabs[0].id;
  let form: FormHandle | null = null;
  let committed = false;

  /** What the form shows: the instance's settings over every declared default. */
  const values = (): IndicatorSettings => ({
    ...indicatorDefaults(descriptor), ...inputDefaults(style), ...inst.settings(),
  });
  const write = (patch: IndicatorSettings): void => {
    for (const k of Object.keys(patch)) dirty.add(k);
    inst.setSettings(patch);
    opts.onChange?.(inst);
  };

  const frame = dialogFrame(doc, { title: `${inst.name} settings`, className: 'oac-indset', onClose: () => cancel() });
  const body = el(doc, 'div', 'oac-indset__pane');
  // One tab needs no tab list: the form alone says what it is.
  if (tabs.length > 1) {
    const nav = tabList(doc, tabs.map((t) => ({ id: t.id, label: t.label, icon: t.icon })), activeTab, 'row',
      (id) => { activeTab = id as IndicatorSettingsTab; renderPane(); });
    frame.body.appendChild(nav.el);
  }

  function renderPane(): void {
    const tab = tabs.find((t) => t.id === activeTab) ?? tabs[0];
    body.innerHTML = '';
    form = renderForm(body, controlsFromInputs(tab.inputs), {
      values: values(),
      idPrefix: `oac-ind-${inst.id}`,
      live: true,
      onChange: (key, value) => {
        write({ [key]: value });
        form?.sync(values());
      },
    });
  }

  frame.body.appendChild(body);
  renderPane();

  frame.lead.appendChild(button(doc, {
    label: 'Defaults',
    onClick: () => {
      const tab = tabs.find((t) => t.id === activeTab) ?? tabs[0];
      write(inputDefaults(tab.inputs));
      renderPane();
    },
  }));
  frame.actions.appendChild(button(doc, { label: 'Cancel', onClick: () => cancel() }));
  frame.actions.appendChild(button(doc, { label: 'OK', variant: 'primary', onClick: () => ok() }));

  // Escape and the scrim are the shell's, and both mean Cancel.
  const handle = openPanel(ctx, frame.el, { placement: 'center', modal: true }, () => cancel());

  function revert(): void {
    if (committed || dirty.size === 0) return;
    const back: IndicatorSettings = {};
    for (const key of dirty) back[key] = before[key];
    dirty.clear();
    inst.setSettings(back);
    opts.onChange?.(inst);
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

  return { el: frame.el, isOpen: handle.isOpen, close: () => ok() };
}
