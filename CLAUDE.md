# CLAUDE.md

Guidance for Claude Code working in openalgo-charts. This file carries what is **not
discoverable by reading the code**: conventions, invariants, and the standard any UI built
against this engine is held to. Structure and commands are discoverable, read them from
the repo.

## What this project is

A from-scratch, dependency-free HTML5 canvas charting engine. Eight lazy ESM tiers (base,
trade, transform, profile, indicators, draw, webgl, widget), zero runtime dependencies,
enforced Brotli budgets. It is a **general library that ships an Indian default**, not an Indian library:
IST is the default timezone, never an assumption baked into behaviour.

**The engine ships no DOM.** The base and the seven engine tiers contain no toolbar,
dialog, menu or picker; those live in the host. `openalgo-charts/widget` is the one tier
that does ship them: a packaged host that drives the engine only through its public API,
kept out of every other bundle by the ESLint tier ACL and `npm run shake`. The yfinance
demo (`examples/yfinance/index.html`) is the reference host and the place to prove a
feature is usable, not just present.

## Writing rules

- No emoji or icons anywhere: code, comments, log messages, commit messages, docs, tests,
  or terminal output. Plain text labels only.
- No em dashes or en dashes anywhere. Use a comma, colon, parentheses or a full stop. A
  plain hyphen inside a compound word like read-only is fine.
- Comments explain **why**, not what. Match the density and voice of the surrounding file.
- Conventional Commits.

## UI standard for host chrome

**Borrow the craft, not the design.** Professional terminals set the bar for density,
crispness and finish, and that bar is the one to clear. They do not set the layout, the
grouping, or the words. Do not reproduce another product's tab taxonomy, its panel
arrangement, or its label phrasing: openalgo-charts has its own identity and copying
someone else's chrome forfeits it, quite apart from being someone else's work.

Standard domain vocabulary is shared property and should be used plainly: logarithmic,
percent, indexed to 100, precision, timezone, invert. Product-specific phrasings are not,
and neither is a particular way of carving settings into tabs. Where a competitor's label
is the obvious industry term, use it. Where it is their turn of phrase, write our own.

The rest of this section is about craft, and applies whatever the layout ends up being.
Each rule is written down because it was got wrong once:

**Scrollbars.** Never leave a default scrollbar on a dark surface. A white OS scrollbar
against a dark panel is the single most obvious tell that a UI was not finished. Style
`::-webkit-scrollbar` (track, thumb, thumb:hover) and set `scrollbar-color` and
`scrollbar-width: thin` for Firefox. The thumb belongs a step lighter than the panel, not
white, and the track should read as part of the panel.

**Colour controls are small square swatches, not blocks.** A colour input is roughly a
26 to 28 px rounded square. It is NOT a full-width bar: a 140 px colour block is a bug,
not a style choice. `.swatch` already exists at 20 px with a 5 px radius; reuse that
vocabulary rather than inventing a second one.

**Up and down colours share one row.** A property with a bullish and a bearish colour is
one labelled row carrying its checkbox and both swatches side by side:

    [x] Body      [green] [red]
    [x] Borders   [green] [red]
    [x] Wick      [green] [red]

Not a BODY section header followed by separate Up and Down rows. The stacked form triples
the height of every panel and is what forces a scrollbar to appear at all. The settings
schema must therefore be able to express a **paired colour control**, not only single
colours, or the host cannot render this shape.

**Controls are crisp and compact.** Prefer a dense panel that fits without scrolling over
a roomy one that does not. Section headers are small, uppercase and muted. Rows are tight.

**No browser-default form controls on a dark panel.** A native blue checkbox and a native
`<select>` chevron both break the theme. Style checkboxes (dark fill, subtle border, a
clear tick when checked) and selects (panel background, custom chevron, no OS styling).

**Tab lists carry icons.** A settings dialog's left rail pairs each tab with a small
glyph. The demo has an inline SVG icon helper; use it rather than an icon font.

**Dialog furniture.** Title left, close affordance top right, actions bottom right with
the confirming action last, and any secondary control (a template picker) bottom left.

## Shipping a change: every surface that repeats a fact

The same handful of facts (tier count, tier sizes, indicator count, tool count,
chart-type count, test count) is written out by hand in eight places. There is no
single source for them, so a release that updates one and not the rest leaves the
project contradicting itself. That is not hypothetical: the architecture diagram
advertised "under 50 KB" and four tiers for several releases while the base engine
measured 59 KB across six, the site footer said "under 30 KB", the API reference
omitted the two largest tiers outright, and the skills carried seven sections still
marked "(unreleased)" for features that had shipped.

**Never quote these numbers from memory or from another doc.** Measure them:

```sh
npm run size              # tier sizes, Brotli, enforced in CI
npm test                  # test and file counts
npm run skills:coverage   # every export named in .github/skills
node -e "import('./dist/openalgo-charts.mjs').then(m=>console.log(m.registeredIndicators().length, m.registeredChartTypes().length))"
```

Counts come from the registry at runtime, never from a config label. `.size-limit.json`
called the draw tier 34 tools while `registeredDrawingTools()` returned 43.

### What to update, by kind of change

| Changed | Also update |
| --- | --- |
| Any public export added or removed | `.github/skills/openalgo-charts/references/` (the matching file), then `npm run skills:coverage` |
| A new type appearing in a public signature | Export it from its tier entry point, or `npx typedoc` warns and the reference has a dead link |
| A **new tier** | `typedoc.json` `entryPoints`, `.size-limit.json`, `package.json` exports, README tier table, `ARCHITECTURE.md` section 2, website Getting Started, the architecture diagram |
| Indicators, chart types or drawing tools | Their counts in README, `pages/index.mdx` and `theme.config.tsx` meta descriptions, `components/landing.tsx` stats and feature cards, the diagram |
| Anything that moves a bundle size | README badge and both size tables, `components/landing.tsx` `STATS`, website Getting Started, `theme.config.tsx` footer and meta description, the diagram subtitle and tier legend |
| A new descriptor hook or capability | `references/indicators.md`, the website docs page, a live example in `website/pages/examples.mdx` |
| A release | `CHANGELOG.md`, `website/pages/docs/release-notes.mdx`, and drop every "(unreleased)" marker for what just shipped |

### Before every npm publish

**Do this before the commit, not after the publish.** Once a version is on the
registry the docs shipped with it are wrong for good, and a follow-up commit
does not change what a reader of that release sees. Every item is mandatory:

1. `package.json` and `src/version.ts` carry the new version, and they agree.
2. `CHANGELOG.md` has the entry.
3. `website/pages/docs/release-notes.mdx` has the entry, and the website builds.
4. `README.md`: the version line, the test and file counts, and **both size
   tables**.
5. **The bundle sizes, measured on the build that is about to ship.**
6. `examples/yfinance/` still describes what it does. It is the reference host,
   so a count or a claim that has drifted there is a claim the first-time reader
   meets first.
7. `.github/skills/` for anything a downstream author would now do differently.
8. `npm run verify`, then the registry counts, then `npm run skills:coverage`.

**Measure the sizes last, and substitute them by row label.** They move by
hundredths whenever the bundle changes at all, including from the version string
itself, so a figure copied from the previous release is already wrong. Worse, a
`sed` keyed on the *old* number silently does nothing once that number has
drifted, and reports success: the README's base-engine row sat two releases stale
exactly that way, through three "successful" release runs. Read `npm run size`,
match on the row name, and fail loudly when a row cannot be found.

### The API reference

`typedoc.json` `entryPoints` must list **every** tier. It listed four for a long time,
so `/api/` documented neither the 91 indicators nor the 43 drawing tools. Treat a
typedoc warning as a failure: each one names a type that is reachable from the public
API but has no page, which is a dead link for whoever follows it.

### The architecture diagram

`docs/architecture-diagram.svg`, shown in README and `ARCHITECTURE.md`. It is SVG
precisely so a number can be corrected by editing text; the PNG it replaced drifted
because fixing it meant redrawing it. `docs/openalgo-charts-architecture-diagram-brief.md`
records what each element must say and why.

### The website

`website/` is a separate build. Run `npm run build` there after touching it: a colon in
MDX frontmatter is a YAML parse error and fails the whole site, and the failure does not
show up in the library's own tests.

It deploys under `basePath: '/openalgo-charts'`. Next rewrites `<Link href>` but **not a
raw `src` or `href` in MDX or JSX**, so an asset written `/thing.svg` builds fine, passes
every check, and 404s only on Pages. Spell out `/openalgo-charts/thing.svg`, the way
`LOGO_SRC` does in `components/`. Grep the built `out/` for the emitted path rather than
trusting the source.

Examples are not decoration, they are the proof a feature is usable. An example that
throws is worse than a missing one. Anything overlaid on the chart as HTML must stop
`pointerdown`, or the chart's pointer capture eats the click.

## Testing traps that have already cost real time

**A Chart built without `applySize(w, h)` and a synchronous raf is not measured.** Every
price scale sits on its `0..1` placeholder, so assertions about ranges pass while
comparing zero to zero. Copy the `makeChart` helper in `tests/compare.test.ts`.

**Write the regression test, then revert the fix and watch it fail.** A test that passes
against the old code is worthless. This has caught vacuous tests more than once.

**Green unit tests do not prove a renderer works.** Two shipped defects passed a fully
green suite and were only caught by looking at pixels: `drawColumns` discarded per-bar
colour, and a comparison overlay labelled its axis from the previous frame's range.
Anything that draws needs a real browser check.

**Trace every new option end to end.** Declared, threaded, consumed, and actually changing
output. Options that were stored and persisted but read by nothing, and styles copied into
no renderer, have both shipped here. "Declared but not consumed" is a defect, not a
follow-up.

**Never ship a control with nothing behind it.** A checkbox that does nothing is worse
than an absent one. If a reference terminal has a control this engine cannot back, leave
it out. A control that exists but has no data in the current context is different: render
it disabled with its state visible, the way the reference greys "previous day close" when
there is no previous session.

## Never cache the forming bar

A "forming bar" is the one that has not closed yet. On a 5-minute chart at 10:07, the bar
covering 10:05 to 10:10 is still being built: its close moves with every tick and is not
final until 10:10.

Bars therefore fall into two categories, and they are not the same kind of data:

- **Closed bars are immutable.** Yesterday's daily candle will never change again, and
  neither will the 10:00 to 10:05 bar once 10:05 has passed. Cache these freely.
- **The last bar is alive** until its interval ends. It must never be served from cache.

**A cache that serves a stale forming bar is worse than no cache at all.** Concretely:

    10:07  Open INFY.  Fetch, last bar close 1120.  Cached.
    10:08  Switch to RELIANCE to check something.
    10:09  Switch back to INFY.  Cache hit, last bar close 1120.

INFY actually traded to 1135 while the user was away. That one wrong number then reaches
the last-price line, the price-axis tag, the header LTP, and every indicator computed off
that close: RSI, VWAP, the moving average, a Supertrend flip. With no cache the user waits
600ms and sees 1135, which is slower and correct. With a naive cache they get an instant
chart that is confidently wrong, with no spinner and no staleness badge to warn them.

This library draws Buy and Sell buttons on the chart. A fast wrong price is a worse
failure here than a slow right one.

So the rule is not "cache less". Keep the completed history and re-fetch only the tail,
either by dropping the last bar from a cached set or by expiring the entry at that bar's
close time. Anything that computes off `bars[bars.length - 1]` inherits this rule.

## Concurrency

When fanning out agents over this repo, **file ownership must be exclusive**, and
`src/core/chart.ts` and `src/core/pane.ts` need a single writer per run. Working-tree
corruption here comes from parallel agents, not from any other process.

## Timezone

IST (`Asia/Kolkata`) is the default and must stay byte-identical for a caller who
configures nothing. Everything else is configurable by IANA zone name. Use IANA names,
never fixed offsets: a fixed offset is silently wrong for half the year anywhere that
observes DST, which is the same class of defect as the IST session anchor fixed in 1.2.0.

`src/feed/openalgo-rest.ts` is the exception and is correct as it stands: OpenAlgo's
history API genuinely requires IST date strings, so that adapter converts at the edge.
