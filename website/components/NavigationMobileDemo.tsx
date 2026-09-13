import RunnableExample from './RunnableExample';

const code = `el.style.display = 'flex';
el.style.flexDirection = 'column';
const controls = document.createElement('div');
controls.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:8px;flex-shrink:0';
const stageWrap = document.createElement('div');
stageWrap.style.cssText = 'flex:1;min-height:0;display:flex;justify-content:center;overflow:hidden;padding:0 8px 8px';
const stage = document.createElement('div');
stage.style.cssText = 'width:360px;max-width:100%;height:100%;min-height:0';
stageWrap.appendChild(stage);
el.append(controls, stageWrap);

const bars = Array.from({ length: 180 }, (_, index) => {
  const close = 100 + Math.sin(index / 9) * 3 + index * 0.025;
  const bar = { time: 1700000000 + index * 3600, open: close - 0.35,
    high: close + 0.9, low: close - 0.9, close, volume: 500 + index * 4 };
  if (index === 94) bar.high = 130;
  if (index === 97) bar.low = 74;
  return bar;
});

let widget;
let animated = true;
let narrow = true;
let extrema = false;
const listeners = new AbortController();
const listen = (node, event, handler) => node.addEventListener(event, handler, { signal: listeners.signal });

function button(label, action) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.style.cssText = 'min-height:34px;padding:5px 9px;border:1px solid var(--oac-card-border);border-radius:5px;background:var(--oac-card);color:inherit;font:12px system-ui;cursor:pointer';
  listen(node, 'click', action);
  controls.appendChild(node);
  return node;
}

const status = document.createElement('span');
status.setAttribute('role', 'status');
status.style.cssText = 'font:12px system-ui;color:var(--oac-muted);padding:5px';

function showLatest() {
  widget.chart.resetScale();
  extrema = false;
  extremaButton.textContent = 'Show extrema';
  extremaButton.setAttribute('aria-pressed', 'false');
  status.textContent = 'Latest 80 bars';
}

function build(saved, selected = [], activeTool = null) {
  widget?.destroy();
  stage.replaceChildren();
  widget = lib.createWidget(stage, {
    symbol: 'NAV SIM', exchange: 'NSE', interval: '1h', intervals: ['15m', '1h', '1d'],
    mobile: 'auto', statusline: false, indicators: false,
    rail: { tools: ['trend-line', 'horizontal-line', 'rectangle'] },
    navigation: { defaultVisibleBars: 80 },
    animZoom: animated,
    animAutoscale: animated,
  });
  widget.series.setData(bars);
  if (saved) {
    widget.restoreState(saved);
    widget.draw.select(selected);
    if (activeTool) widget.draw.setTool(activeTool);
  }
}

const widthButton = button('Width: 360 px', () => {
  narrow = !narrow;
  stage.style.width = narrow ? '360px' : '760px';
  widthButton.textContent = narrow ? 'Width: 360 px' : 'Width: 760 px';
  widthButton.setAttribute('aria-pressed', String(narrow));
});
widthButton.setAttribute('aria-pressed', 'true');

const extremaButton = button('Show extrema', () => {
  extrema = !extrema;
  if (extrema) {
    const plot = widget.root.querySelector('.oac-chart');
    const rect = plot.getBoundingClientRect();
    plot.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 300,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      clientX: Math.max(rect.left + 1, rect.right - 58),
      clientY: rect.top + rect.height / 2,
      bubbles: true,
      cancelable: true,
    }));
    extremaButton.textContent = 'Show latest';
    status.textContent = 'Zooming out to the earlier high and low';
  } else showLatest();
  extremaButton.setAttribute('aria-pressed', String(extrema));
});
extremaButton.setAttribute('aria-pressed', 'false');

const animationButton = button('Animation: on', () => {
  const saved = widget.getState();
  const selected = Array.from(widget.draw.selection());
  const activeTool = widget.draw.activeTool();
  animated = !animated;
  animationButton.textContent = 'Animation: ' + (animated ? 'on' : 'off');
  animationButton.setAttribute('aria-pressed', String(animated));
  build(saved, selected, activeTool);
});
animationButton.setAttribute('aria-pressed', 'true');

button('Reset view', showLatest);
controls.appendChild(status);
build();
status.textContent = 'Latest 80 bars';

return {
  destroy() {
    listeners.abort();
    widget?.destroy();
  },
};`;

export default function NavigationMobileDemo() {
  return <RunnableExample height={560} tiers={['widget']} code={code} watermark={false}
    caption="Synthetic hourly bars. Start at 360 px to use the mobile header and Draw sheet. On a fine-pointer device, change width to compare the packaged layouts. A coarse pointer keeps mobile controls at either width. Show extrema sends a real wheel zoom through the chart, so Animation changes both the time zoom and price autoscale transition. The switch restores the widget layout and drawings; Reset view returns to the latest 80 bars." />;
}
