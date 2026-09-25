import { registeredIndicators, getIndicator, indicatorDefaults, indicatorStyleInputs, INDICATOR_SOURCES } from '/dist/openalgo-charts.mjs';
import { el, esc, currentTheme, chartTheme, toast, closeOverlay } from './ui.js';
import { autosave } from './persist.js';
import { capturePaneTarget } from './pane-target.js';
import { createColorPicker, applyTokens, widgetTokens } from '/dist/openalgo-charts.widget.mjs';
import { bindTypedField, typedFieldValue, typedFieldError, validateTypedRows, mountReferenceInputControls } from './indicator-input-controls.js';
import { studyAllows } from './host-study.js';

let app;

// ── indicator picker ───────────────────────────────────────────────────
// The picker is built from the registry, not a hardcoded list: anything
// registered (built-in or your own descriptor) shows up here automatically.
export function fillIndicatorPicker() {
  const pick = el('indpick');
  const byCat = new Map();
  for (const d of registeredIndicators().sort((a, b) => a.name.localeCompare(b.name))) {
    const cat = d.category || 'Other';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(d);
  }
  pick.innerHTML = '';
  for (const [cat, list] of [...byCat].sort((a, b) => a[0].localeCompare(b[0]))) {
    const g = document.createElement('optgroup');
    g.label = cat;
    for (const d of list) {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.name;
      g.appendChild(o);
    }
    pick.appendChild(g);
  }
  pick.value = 'macd';
}

// One chip per live instance, reading chart.indicators(), the same handles
// an objects panel would drive.
export function renderIndicatorChips() {
  const host = el('indlist');
  host.innerHTML = '';
  const target = capturePaneTarget(app);
  const chart = target?.chart;
  if (!chart) return;
  // A study its host keeps out of the inventory stays out of the chips too.
  for (const inst of chart.indicators().filter((study) => studyAllows(study, 'listed'))) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const first = inst.series(Object.keys(inst.values())[0]);
    const color = (inst.settings().color) || '#8892a6';
    chip.innerHTML = `<span class="sw" style="background:${esc(String(color))}"></span><b>${esc(inst.name)}</b>`;
    // No remove button on a study the host keeps; the chip says why instead.
    if (!studyAllows(inst, 'removable')) {
      chip.title = `${inst.name} is protected by the host`;
      chip.classList.add('is-protected');
      host.appendChild(chip);
      continue;
    }
    const x = document.createElement('button');
    x.textContent = '×';
    x.title = 'remove';
    x.addEventListener('click', () => {
      if (!target.current()) return;
      chart.removeIndicator(inst.id);
      renderIndicatorChips();
      el('status').textContent = `removed ${inst.name}`;
    });
    chip.appendChild(x);
    host.appendChild(chip);
    void first;
  }
  if (!chart.indicators().length) host.innerHTML = '<span style="color:var(--faint);font-size:12px">none</span>';
}

export function addIndicator(id, target = capturePaneTarget(app)) {
  if (!target?.current()) { el('status').textContent = 'chart changed; open the indicator menu again'; return; }
  if ((target.pane === 2 ? app.loading2 || app.loadFailed2 : app.loading || app.loadFailed)
    || !target.chart.primaryBars().length) { el('status').textContent = 'load chart history before adding a study'; return; }
  const inst = target.chart.addIndicator(id);
  if (target.pane === 1) rememberIndicators();
  renderIndicatorChips();
  autosave();
  el('status').textContent = `added ${inst.name} on chart ${target.pane}`;
  return inst;
}

// ── generated indicator settings ───────────────────────────────────────
// Nothing here is indicator-specific: the descriptor's `inputs` declare a
// key, a type, a label, and a default, which is everything a form needs.
// The same 40 lines render MACD, Bollinger, or your own custom descriptor.
let settingsFor = null; // the IndicatorApi handle being edited
let settingsTarget = null;
let disposeSettings = null;
const formPickers = new WeakMap();
const sourceReferences = new WeakMap();
const formDrafts = new WeakMap();

function studySource(value) {
  return value !== null && typeof value === 'object' && value.kind === 'indicator'
    && typeof value.instanceId === 'string' && typeof value.plotKey === 'string';
}

let settingsTab = 'inputs';
export function openSettings(instanceId, target = capturePaneTarget(app)) {
  if (!target?.current()) return;
  const inst = target.chart.indicators().find((i) => i.id === instanceId);
  if (!inst) return;
  // Every write would be refused, so the dialog says why instead of opening.
  if (!studyAllows(inst, 'configurable')) { el('status').textContent = `${inst.name} settings are protected by the host`; return; }
  disposeSettings?.();
  settingsTarget = target;
  settingsFor = inst;
  const offDestroy = target.chart.on('destroy', closeSettings);
  const offRemoved = target.chart.on('indicatorRemoved', () => {
    if (currentSettings() && validateTypedRows(el('set-body'))) renderSettingsTab(collectInputRows(el('set-body')));
  });
  disposeSettings = () => { offDestroy(); offRemoved(); };
  el('set-title').textContent = getIndicator(inst.indicatorId).name + ' settings';
  renderSettingsTab();
  el('setmodal').hidden = false;
}

/**
 * The one form renderer. It takes a list of `IndicatorInput`s and the values
 * to seed them with, and knows nothing about where they came from, which is
 * why the chart-settings dialog can hand it `chartSettingsSchema()` output
 * and get the same widgets the indicator dialog has always drawn.
 * `onChange` is optional: the chart dialog previews live, the indicator
 * dialog collects on Apply.
 *
 * `unavailable(key, optionValue)` is optional too, and returns a reason a
 * control (or one option of a select) cannot act in the current context, or
 * null when it can. A control with nothing behind it is drawn disabled with
 * its value still readable rather than left live and inert.
 */
export function renderInputRows(host, inputs, values, onChange, unavailable) {
  destroyInputRows(host);
  formPickers.set(host, []);
  formDrafts.set(host, {});
  host.classList.add('oac-widget', 'host-form-widget');
  applyTokens(host, widgetTokens(chartTheme(), currentTheme()));
  host.innerHTML = '';
  let group = null;
  for (const input of inputs) {
    if (input.group && input.group !== group) {
      group = input.group;
      const h = document.createElement('div');
      h.className = 'set-group';
      h.textContent = group;
      host.appendChild(h);
    }
    host.appendChild(input.type === 'colorPair'
      ? colorPairRow(host, input, values, onChange, unavailable)
      : simpleRow(host, input, values, onChange, unavailable));
  }
}

export function destroyInputRows(host) {
  for (const picker of formPickers.get(host) || []) picker.destroy();
  formPickers.delete(host);
  formDrafts.delete(host);
}

/**
 * One widget, tagged with the flat key it writes so `collectInputRows` can
 * read the whole form back without knowing which row a field came from. A
 * paired-colour row therefore contributes three ordinary fields, and nothing
 * downstream has to know the pair exists.
 *
 * `spec` carries the widget's own extras: select options, number bounds.
 */
function inputField(host, key, kind, spec, value, onChange, unavailable) {
  const off = unavailable ? unavailable(key) : null;
  let field;
  if (kind === 'select' || kind === 'source') {
    field = document.createElement('select');
    const options = [...(kind === 'source' ? INDICATOR_SOURCES : spec.options)];
    const references = new Map();
    if (kind === 'source') {
      for (const output of spec.studyOutputs ?? []) {
        const token = `study-output:${references.size}`;
        references.set(token, { ...output.reference });
        options.push({ value: token, label: output.label });
      }
      if (studySource(value)) {
        let token = [...references].find(([, reference]) => reference.instanceId === value.instanceId && reference.plotKey === value.plotKey)?.[0];
        if (token === undefined) {
          token = `study-output:${references.size}`;
          references.set(token, { ...value });
          options.push({ value: token, label: `Unavailable study output: ${value.instanceId} / ${value.plotKey}` });
        }
        value = token;
      }
      sourceReferences.set(field, references);
    }
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value; opt.textContent = o.label;
      // One option of a select can be the part with nothing behind it: the
      // title can always show a symbol, and shows a description only when
      // the host has one.
      const why = unavailable ? unavailable(key, o.value) : null;
      if (why) { opt.disabled = true; opt.title = why; }
      field.appendChild(opt);
    }
    field.value = String(value);
  } else if (kind === 'boolean') {
    field = document.createElement('input');
    field.type = 'checkbox';
    field.checked = Boolean(value);
  } else if (kind === 'color') {
    const picker = createColorPicker(document, {
      id: host.id + '_' + key, label: spec.label || key, value,
      disabledReason: off,
      openOverlay: app?.['alertUi' + (app.focusPane === 2 ? '2' : '')]?.context.openOverlay,
      onChange: next => onChange?.(key, next),
    });
    formPickers.get(host).push(picker);
    field = picker.input;
    field._colorPicker = picker;
  } else {
    field = document.createElement(kind === 'multiline' ? 'textarea' : 'input');
    if (kind !== 'multiline') field.type = kind === 'number' ? 'number' : 'text';
    if (kind === 'price' || kind === 'timestamp') field.inputMode = 'decimal';
    if (kind === 'multiline') field.rows = 4;
    if (kind === 'number') {
      if (spec.min !== undefined) field.min = spec.min;
      if (spec.max !== undefined) field.max = spec.max;
      if (spec.step !== undefined) field.step = spec.step;
    }
    field.value = String(value ?? '');
  }
  // Namespaced by host, so both dialogs can exist in the document at once
  // without two fields claiming the same id.
  field.id = host.id + '_' + key;
  field.dataset.key = key;
  field.dataset.kind = kind;
  if (off) { field.disabled = true; field.title = off; }
  if (onChange && kind !== 'color') {
    for (const ev of ['input', 'change']) {
      field.addEventListener(ev, () => onChange(key, fieldValue(field)));
    }
  }
  return field;
}

/**
 * The `?` after a label. Attached to the label rather than the row so it stays
 * with the words it explains when a long label wraps, and reachable by tab so a
 * keyboard user is not the only one who cannot read the help.
 */
function helpMark(tooltip) {
  const mark = document.createElement('span');
  mark.className = 'set-help';
  mark.textContent = '?';
  mark.title = tooltip;
  mark.tabIndex = 0;
  mark.setAttribute('role', 'note');
  mark.setAttribute('aria-label', tooltip);
  return mark;
}

/** A row carrying one control. Booleans sit in the switch column, in front
 *  of their label; everything else sits in the control column on the right. */
function simpleRow(host, input, values, onChange, unavailable) {
  const row = document.createElement('div');
  row.className = 'set-row';
  const off = unavailable ? unavailable(input.key) : null;
  if (off) { row.classList.add('set-row--off'); row.title = off; }
  const label = document.createElement('label');
  label.textContent = input.type === 'timestamp' ? input.label + ' (UTC seconds)' : input.label;
  label.htmlFor = host.id + '_' + input.key;
  if (input.tooltip) label.appendChild(helpMark(input.tooltip));
  const field = inputField(host, input.key, input.type, input, values[input.key], onChange, unavailable);
  if (input.type === 'boolean') {
    field.classList.add('set-sw');
    row.append(field, label);
  } else {
    const ctl = document.createElement('div');
    ctl.className = 'set-ctl';
    ctl.appendChild(field._colorPicker?.el || field);
    row.append(label, ctl);
  }
  bindTypedField(field, input, row);
  return row;
}

/**
 * A paired-colour row: the property's switch, its label, and both swatches
 * on one line. `enabled` is absent when no flag backs the pair (a candle
 * body is always drawn), and then the switch column is simply left empty
 * rather than filled with a checkbox that would do nothing.
 */
function colorPairRow(host, input, values, onChange, unavailable) {
  const row = document.createElement('div');
  row.className = 'set-row';
  // The row reads as inert only when BOTH halves are: a long position with
  // no short one leaves the pair live and dims the half with nothing to paint.
  const offUp = unavailable ? unavailable(input.up.key) : null;
  const offDown = unavailable ? unavailable(input.down.key) : null;
  if (offUp && offDown) { row.classList.add('set-row--off'); row.title = offUp; }
  if (input.enabled) {
    const sw = inputField(host, input.enabled.key, 'boolean', input.enabled, values[input.enabled.key], onChange, unavailable);
    sw.classList.add('set-sw');
    row.appendChild(sw);
  }
  const label = document.createElement('label');
  label.textContent = input.label;
  label.htmlFor = host.id + '_' + (input.enabled ? input.enabled.key : input.up.key);
  const ctl = document.createElement('div');
  ctl.className = 'set-ctl';
  // A disabled input takes no pointer events, so the reason has to live on
  // the container the hover actually lands on.
  if (offUp || offDown) ctl.title = offUp || offDown;
  for (const half of [input.up, input.down]) {
    const sw = inputField(host, half.key, 'color', half, values[half.key], onChange, unavailable);
    // Which swatch is which is not obvious at 26px, and the pair is too
    // tight for two more labels: the name goes on the control itself, and
    // keeps the reason alongside it when this half has nothing to paint.
    sw.title = sw.disabled ? half.label + ' - ' + sw.title : half.label;
    ctl.appendChild(sw._colorPicker?.el || sw);
  }
  row.append(label, ctl);
  return row;
}

/** A field's value in the type its input declared. */
export function fieldValue(field) {
  const reference = sourceReferences.get(field)?.get(field.value);
  if (reference) return { ...reference };
  const kind = field.dataset.kind;
  return kind === 'number' ? Number(field.value) : kind === 'boolean' ? field.checked
    : kind === 'color' && field._colorPicker ? field._colorPicker.read() : typedFieldValue(field);
}

/** Every field in a generated form, as a flat patch keyed by input key. */
export function collectInputRows(host) {
  return { ...formDrafts.get(host), ...Object.fromEntries(
    [...host.querySelectorAll('[data-key]')].map(field => [field.dataset.key, fieldValue(field)]),
  ) };
}

// Inputs = the descriptor's own `inputs`. Style = `indicatorStyleInputs()`,
// generated per plot (colour, opacity, thickness, line style) so every
// indicator gets the same controls without declaring them.
export function renderSettingsTab(draft) {
  const inst = settingsFor;
  if (!inst) return;
  const descriptor = getIndicator(inst.indicatorId);
  const inputs = settingsTab === 'style' ? indicatorStyleInputs(descriptor) : descriptor.inputs.map(input => {
    if (input.type !== 'source' || !input.allowStudyOutputs) return input;
    const studyOutputs = settingsTarget.chart.indicators().flatMap(producer => producer.id === inst.id ? []
      : getIndicator(producer.indicatorId).plots.filter(plot => !plot.ohlc).map(plot => ({
        reference: { kind: 'indicator', instanceId: producer.id, plotKey: plot.key },
        label: `${producer.name} [${producer.id}] / ${plot.title ?? plot.key}`,
      })));
    return { ...input, studyOutputs };
  });
  renderInputRows(el('set-body'), inputs, draft ?? inst.settings());
  const target = settingsTarget, host = el('set-body');
  const current = () => settingsFor === inst && settingsTarget === target && target.current()
    && target.chart.indicators().includes(inst);
  const controls = mountReferenceInputControls(app, target, inst, inputs, host, el('setmodal'), patch => {
    if (!current()) return false;
    formDrafts.set(host, { ...formDrafts.get(host), ...patch });
    for (const field of host.querySelectorAll('[data-key]')) {
      if (!Object.prototype.hasOwnProperty.call(patch, field.dataset.key)) continue;
      field.value = String(patch[field.dataset.key]); typedFieldError(field, null);
    }
    return true;
  }, current);
  if (controls) formPickers.get(host).push(controls);
}

export function collectSettings() {
  if (!currentSettings()) return false;
  if (!validateTypedRows(el('set-body'))) return false;
  try { settingsFor.setSettings(collectInputRows(el('set-body'))); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'The study settings could not be applied';
    el('status').textContent = message;
    toast('error', message);
    for (const field of el('set-body').querySelectorAll('[data-key]')) {
      if (message.includes(`"${field.dataset.key}"`)) typedFieldError(field, message);
    }
    return false;
  }
  rememberSettings();
  return true;
}

function currentSettings() {
  if (settingsTarget?.current() && settingsTarget.chart.indicators().includes(settingsFor)) return true;
  closeSettings();
  el('status').textContent = 'study changed; open its settings again';
  return false;
}

export function rememberIndicators() {
  if (!app.applyingTemplate && app.chart) app.activeIndicators = (app.chart.getState().indicators || [])
    .map(study => ({ ...study, settings: { ...study.settings } }));
}

function rememberSettings() {
  if (settingsTarget?.pane === 1) rememberIndicators();
  autosave();
}

export function applySettings() {
  if (!settingsFor) return;
  const name = settingsFor.name;
  if (!collectSettings()) return;
  renderIndicatorChips();
  el('status').textContent = `${name} updated`;
  closeSettings();
}

export function closeSettings() {
  settingsFor = null;
  settingsTarget = null;
  destroyInputRows(el('set-body'));
  disposeSettings?.();
  disposeSettings = null;
  el('setmodal').hidden = true;
  closeOverlay(el('setmodal'));
  settingsTab = 'inputs';
  for (const t of document.querySelectorAll('.set-tab')) t.classList.toggle('is-on', t.dataset.tab === 'inputs');
}

export function initIndicators(a) {
  app = a;
  document.addEventListener('oac:theme', () => {
    for (const id of ['set-body', 'cset-body']) {
      const host = el(id);
      if (host?.classList.contains('host-form-widget')) applyTokens(host, widgetTokens(chartTheme(), currentTheme()));
    }
  });
  // Add an indicator live: no chart rebuild, no refetch. The handle it returns
  // is what a settings dialog or an objects panel would drive.
  el('indadd').addEventListener('click', () => {
    addIndicator(el('indpick').value);
  });

  for (const tab of document.querySelectorAll('.set-tab')) {
    tab.addEventListener('click', () => {
      if (!settingsFor) return;
      if (!collectSettings()) return;
      settingsTab = tab.dataset.tab;
      for (const t of document.querySelectorAll('.set-tab')) t.classList.toggle('is-on', t === tab);
      renderSettingsTab();
    });
  }
  el('set-ok').addEventListener('click', applySettings);
  el('set-x').addEventListener('click', closeSettings);
  el('set-reset').addEventListener('click', () => {
    if (!currentSettings()) return;
    const d = getIndicator(settingsFor.indicatorId);
    const defaults = indicatorDefaults(d);
    settingsFor.setSettings(defaults);
    rememberSettings();
    renderIndicatorChips();
    closeSettings();
  });
  el('setmodal').addEventListener('click', (e) => { if (e.target.id === 'setmodal') closeSettings(); });
}
