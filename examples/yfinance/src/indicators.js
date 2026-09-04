import { registeredIndicators, getIndicator, indicatorStyleInputs, INDICATOR_SOURCES } from '/dist/openalgo-charts.mjs';
import { el, esc } from './ui.js';
import { placeWatermark } from './watermark.js';
import { autosave } from './persist.js';

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
  for (const inst of app.chart.indicators()) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const first = inst.series(Object.keys(inst.values())[0]);
    const color = (inst.settings().color) || '#8892a6';
    chip.innerHTML = `<span class="sw" style="background:${esc(String(color))}"></span><b>${esc(inst.name)}</b>`;
    const x = document.createElement('button');
    x.textContent = '×';
    x.title = 'remove';
    x.addEventListener('click', () => {
      app.chart.removeIndicator(inst.id);
      app.activeIndicators = app.activeIndicators.filter((s) => s.indicatorId !== inst.indicatorId);
      renderIndicatorChips();
      el('status').textContent = `removed ${inst.name}`;
    });
    chip.appendChild(x);
    host.appendChild(chip);
    void first;
  }
  if (!app.chart.indicators().length) host.innerHTML = '<span style="color:var(--faint);font-size:12px">none</span>';
}

// ── generated indicator settings ───────────────────────────────────────
// Nothing here is indicator-specific: the descriptor's `inputs` declare a
// key, a type, a label, and a default, which is everything a form needs.
// The same 40 lines render MACD, Bollinger, or your own custom descriptor.
let settingsFor = null; // the IndicatorApi handle being edited

let settingsTab = 'inputs';
export function openSettings(instanceId) {
  const inst = app.chart.indicators().find((i) => i.id === instanceId);
  if (!inst) return;
  settingsFor = inst;
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
    for (const o of (kind === 'source' ? INDICATOR_SOURCES : spec.options)) {
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
    field = document.createElement('input');
    field.type = 'color';
    field.className = 'swatch';        // a 26px square, not a 140px block
    field.value = String(value ?? '#000000');
  } else {
    field = document.createElement('input');
    field.type = kind === 'number' ? 'number' : 'text';
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
  if (onChange) {
    for (const ev of ['input', 'change']) {
      field.addEventListener(ev, () => onChange(key, fieldValue(field)));
    }
  }
  return field;
}

/** A row carrying one control. Booleans sit in the switch column, in front
 *  of their label; everything else sits in the control column on the right. */
function simpleRow(host, input, values, onChange, unavailable) {
  const row = document.createElement('div');
  row.className = 'set-row';
  const off = unavailable ? unavailable(input.key) : null;
  if (off) { row.classList.add('set-row--off'); row.title = off; }
  const label = document.createElement('label');
  label.textContent = input.label;
  label.htmlFor = host.id + '_' + input.key;
  const field = inputField(host, input.key, input.type, input, values[input.key], onChange, unavailable);
  if (input.type === 'boolean') {
    field.classList.add('set-sw');
    row.append(field, label);
  } else {
    const ctl = document.createElement('div');
    ctl.className = 'set-ctl';
    ctl.appendChild(field);
    row.append(label, ctl);
  }
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
    ctl.appendChild(sw);
  }
  row.append(label, ctl);
  return row;
}

/** A field's value in the type its input declared. */
export function fieldValue(field) {
  const kind = field.dataset.kind;
  return kind === 'number' ? Number(field.value) : kind === 'boolean' ? field.checked : field.value;
}

/** Every field in a generated form, as a flat patch keyed by input key. */
export function collectInputRows(host) {
  const patch = {};
  for (const field of host.querySelectorAll('[data-key]')) patch[field.dataset.key] = fieldValue(field);
  return patch;
}

// Inputs = the descriptor's own `inputs`. Style = `indicatorStyleInputs()`,
// generated per plot (colour, opacity, thickness, line style) so every
// indicator gets the same controls without declaring them.
export function renderSettingsTab() {
  const inst = settingsFor;
  if (!inst) return;
  const descriptor = getIndicator(inst.indicatorId);
  const inputs = settingsTab === 'style' ? indicatorStyleInputs(descriptor) : descriptor.inputs;
  renderInputRows(el('set-body'), inputs, inst.settings());
}

export function collectSettings() {
  if (!settingsFor) return;
  settingsFor.setSettings(collectInputRows(el('set-body')));  // recomputes + restyles
  const spec = app.activeIndicators.find((s) => s.indicatorId === settingsFor.indicatorId);
  if (spec) spec.settings = settingsFor.settings();      // survives a chart rebuild
}

export function applySettings() {
  if (!settingsFor) return;
  const name = settingsFor.name;
  collectSettings();
  renderIndicatorChips();
  el('status').textContent = `${name} updated`;
  closeSettings();
}

export function closeSettings() {
  el('setmodal').hidden = true;
  settingsFor = null;
  settingsTab = 'inputs';
  for (const t of document.querySelectorAll('.set-tab')) t.classList.toggle('is-on', t.dataset.tab === 'inputs');
}

export function initIndicators(a) {
  app = a;
  // Add an indicator live: no chart rebuild, no refetch. The handle it returns
  // is what a settings dialog or an objects panel would drive.
  el('indadd').addEventListener('click', () => {
    const id = el('indpick').value;
    if (!app.chart || !app.currentBars.length) return;
    if (app.activeIndicators.some((s) => s.indicatorId === id)) { el('status').textContent = `${id} already added`; return; }
    const inst = app.chart.addIndicator(id);
    app.activeIndicators.push({ indicatorId: id, settings: inst.settings() });
    renderIndicatorChips();
    placeWatermark(); // a new pane may now be the bottom one
    autosave();
    el('status').textContent = `added ${inst.name} on pane ${inst.paneIndex}`;
  });

  for (const tab of document.querySelectorAll('.set-tab')) {
    tab.addEventListener('click', () => {
      if (!settingsFor) return;
      collectSettings();                       // keep edits made on this tab
      settingsTab = tab.dataset.tab;
      for (const t of document.querySelectorAll('.set-tab')) t.classList.toggle('is-on', t === tab);
      renderSettingsTab();
    });
  }
  el('set-ok').addEventListener('click', applySettings);
  el('set-x').addEventListener('click', closeSettings);
  el('set-reset').addEventListener('click', () => {
    if (!settingsFor) return;
    const d = getIndicator(settingsFor.indicatorId);
    const defaults = {};
    for (const i of d.inputs) defaults[i.key] = i.default;
    settingsFor.setSettings(defaults);
    const spec = app.activeIndicators.find((s) => s.indicatorId === settingsFor.indicatorId);
    if (spec) spec.settings = settingsFor.settings();
    renderIndicatorChips();
    closeSettings();
  });
  el('setmodal').addEventListener('click', (e) => { if (e.target.id === 'setmodal') closeSettings(); });
}
