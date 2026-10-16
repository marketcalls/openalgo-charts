import { chromeIconSvg, registeredDrawingTools, type DrawingTool } from 'openalgo-charts/draw';
import { glyph, h, type WidgetContext } from './context';
import { selectBox } from './form';
import { widgetText } from './localization';
import { RAIL_GROUPS, toolGlyph, type RailHandle } from './rail';
import { token as v } from './tokens';

type MakeAction = (name: string, label: string, run: (button: HTMLButtonElement) => void) => HTMLButtonElement;

interface DrawingSheetOptions {
  rail: RailHandle;
  tools: readonly string[] | undefined;
  makeAction: MakeAction;
  historyActions(): HTMLButtonElement[];
  refresh(): void;
  close(): void;
}

const normalized = (value: string): string => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');

function drawingRow(ctx: WidgetContext, tool: DrawingTool, label: string, opts: DrawingSheetOptions): HTMLElement {
  const doc = ctx.document;
  const row = h(doc, 'div', 'oac-mobile-drawings__row');
  const button = opts.makeAction('tool', '', () => { ctx.draw.setTool(tool.id); opts.close(); });
  button.classList.add('oac-mobile__tool');
  button.dataset.tool = tool.id;
  button.setAttribute('aria-pressed', String(ctx.draw.activeTool() === tool.id));
  const name = h(doc, 'span');
  name.textContent = label;
  button.append(toolGlyph(doc, tool.id), name);
  const pinned = opts.rail.isFavorite(tool.id);
  const pin = opts.makeAction('favorite', '', () => { opts.rail.toggleFavorite(tool.id); opts.refresh(); });
  pin.classList.add('oac-mobile-drawings__pin');
  pin.dataset.tool = tool.id;
  pin.setAttribute('aria-pressed', String(pinned));
  pin.setAttribute('aria-label', widgetText(ctx, 'schema.ui.mobile.drawings.pin', { name: label }, 'Pin {name} to rail'));
  pin.appendChild(glyph(doc, chromeIconSvg(pinned ? 'star-filled' : 'star'), 'chrome'));
  row.append(button, pin);
  return row;
}

function drawingControls(ctx: WidgetContext, opts: DrawingSheetOptions): HTMLButtonElement[] {
  if (ctx.draw.activeTool() === null) return [];
  const rail = opts.rail;
  return [
    opts.makeAction('finish', widgetText(ctx, 'Finish'), () => { ctx.draw.finish(); opts.refresh(); }),
    opts.makeAction('cancel', widgetText(ctx, 'Cancel'), () => { ctx.draw.cancel(); opts.refresh(); }),
    ...opts.historyActions(),
    opts.makeAction('magnet', widgetText(ctx, 'Magnet: {mode}', { mode: widgetText(ctx, `schema.magnet.${rail.magnetMode()}`, {}, rail.magnetMode()) }), () => { rail.cycleMagnet(); opts.refresh(); }),
    opts.makeAction('stay', widgetText(ctx, 'Keep tool active: {mode}', { mode: rail.stayMode() ? widgetText(ctx, 'on') : widgetText(ctx, 'off') }), () => {
      rail.setStayMode(!rail.stayMode());
      opts.refresh();
    }),
  ];
}

/** Keep the fields mounted while drawing events replace only stateful rows. */
export function mountMobileDrawings(ctx: WidgetContext, body: HTMLElement, opts: DrawingSheetOptions): () => void {
  const doc = ctx.document;
  const allowed = opts.tools === undefined ? null : new Set(opts.tools);
  const catalog = (): DrawingTool[] => registeredDrawingTools().filter(tool => allowed === null || allowed.has(tool.id));
  const filters = h(doc, 'div', 'oac-mobile-drawings__filters');
  const searchLabel = widgetText(ctx, 'schema.ui.mobile.drawings.search', {}, 'Search drawings');
  const search = h(doc, 'input', 'oac-mobile-drawings__search', {
    type: 'search', 'aria-label': searchLabel, placeholder: searchLabel, autocomplete: 'off', spellcheck: 'false',
  });
  search.dataset.mobileAction = 'drawing-search';
  const { wrap, select } = selectBox(doc);
  select.classList.add('oac-mobile-drawings__groups');
  select.dataset.mobileAction = 'drawing-group';
  select.setAttribute('aria-label', widgetText(ctx, 'schema.ui.mobile.drawings.group', {}, 'Drawing group'));
  const available = new Set(catalog().map(tool => tool.id));
  const groups = RAIL_GROUPS.filter(group => group.id !== undefined && (group.items ?? []).some(item => item.tool !== undefined && available.has(item.tool)));
  const choices = [
    ['all', widgetText(ctx, 'schema.ui.mobile.drawings.all', {}, 'All tools')],
    ['favorites', widgetText(ctx, 'schema.ui.mobile.drawings.favorites', {}, 'Favorites')],
    ...groups.map(group => [group.id!, widgetText(ctx, `schema.rail.${group.id}.title`, {}, group.title ?? group.id!)]),
  ];
  for (const [id, label] of choices) {
    const option = h(doc, 'option', '', { value: id! });
    option.textContent = label!;
    select.appendChild(option);
  }
  select.value = 'all';
  filters.append(search, wrap);
  const controls = h(doc, 'div', 'oac-mobile-sheet__controls');
  const cursor = opts.makeAction('cursor', widgetText(ctx, 'Cursor'), () => { ctx.draw.setTool(null); opts.close(); });
  cursor.classList.add('oac-mobile-drawings__cursor');
  cursor.prepend(toolGlyph(doc, 'cursor'));
  const list = h(doc, 'div', 'oac-mobile-drawings__list', { role: 'group', 'aria-label': widgetText(ctx, 'Drawing tools') });
  const empty = h(doc, 'div', 'oac-mobile-drawings__empty', { role: 'status', 'aria-live': 'polite' });
  empty.textContent = widgetText(ctx, 'schema.ui.mobile.drawings.empty', {}, 'No drawing tools found');
  body.append(filters, controls, cursor, list, empty);
  const repaint = (): void => {
    controls.textContent = '';
    controls.append(...drawingControls(ctx, opts));
    controls.hidden = controls.children.length === 0;
    cursor.setAttribute('aria-pressed', String(ctx.draw.activeTool() === null));
    const query = normalized(search.value);
    const selectedGroup = groups.find(group => group.id === select.value);
    const groupTools = selectedGroup === undefined ? null : new Set(selectedGroup.items?.map(item => item.tool));
    list.textContent = '';
    for (const tool of catalog()) {
      if (select.value === 'favorites' && !opts.rail.isFavorite(tool.id)) continue;
      if (groupTools !== null && !groupTools.has(tool.id)) continue;
      const label = widgetText(ctx, `schema.drawing.${tool.id}.name`, {}, tool.name);
      if (query !== '' && ![tool.id, tool.name, label].some(text => normalized(text).includes(query))) continue;
      list.appendChild(drawingRow(ctx, tool, label, opts));
    }
    empty.hidden = list.children.length > 0;
  };
  for (const [element, event] of [[search, 'input'], [select, 'change']] as const) {
    element.addEventListener(event, () => { body.scrollTop = 0; opts.refresh(); });
  }
  repaint();
  return repaint;
}

export const MOBILE_DRAWINGS_CSS = `
.oac-widget .oac-mobile-drawings__filters { grid-column: 1 / -1; display: grid; gap: 8px; margin-bottom: 8px; }
.oac-widget .oac-mobile-drawings__filters > input, .oac-widget .oac-mobile-drawings__groups { width: 100%; min-width: 0; height: 44px; }
.oac-widget .oac-mobile-drawings__filters > .oac-select { min-width: 0; }
.oac-widget .oac-mobile-drawings__cursor, .oac-widget .oac-mobile-drawings__list,
.oac-widget .oac-mobile-drawings__empty { grid-column: 1 / -1; }
.oac-widget .oac-mobile-drawings__cursor { text-align: left; }
.oac-widget .oac-mobile-drawings__row { display: grid; grid-template-columns: minmax(0, 1fr) 44px; border-top: 1px solid ${v('bd-soft')}; }
.oac-widget .oac-mobile-drawings__row > .oac-mobile__tool { display: flex; align-items: center; gap: 10px; text-align: left; }
.oac-widget .oac-mobile-drawings__row > .oac-mobile__tool > .oac-glyph { margin: 0; }
.oac-widget .oac-mobile-drawings__pin { min-width: 44px; }
.oac-widget .oac-mobile-sheet .oac-mobile-drawings__pin > .oac-glyph { margin: 0; }
.oac-widget .oac-mobile-drawings__empty { min-height: 44px; padding: 13px 10px; color: ${v('mut')}; }
`;
