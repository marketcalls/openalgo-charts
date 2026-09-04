# OpenAlgo Charts agent skills

Agent Skills that teach an AI coding assistant how to use `openalgo-charts` correctly - the real API surface, the eight-tier bundle model, and the foot-guns that are not obvious from the type signatures.

## Install

```sh
npx skills add https://github.com/marketcalls/openalgo-charts
```

Install a single skill instead of all of them:

```sh
npx skills add https://github.com/marketcalls/openalgo-charts --skill openalgo-charts
```

Works with Claude Code, Cursor, Codex, Copilot, Gemini CLI, Windsurf, Zed and the other agents the `skills` CLI supports.

## What is installed

| Skill | Kind | Use it for |
|---|---|---|
| `openalgo-charts` | Reference hub | The always-on skill. Mental model, tiers, core API, triage table, and 22 deep reference files under `references/`. |
| `openalgo-chart-setup` | Task | Scaffold a first chart into an existing project, host detection included. |
| `openalgo-chart-indicator` | Task | Add one of the 102 built-in indicators, restyle it, or author a custom or Tier-2 one. |
| `openalgo-chart-terminal` | Task | Build a full trading terminal: live data, indicators, drawings, order lines, depth, layout persistence. |
| `openalgo-chart-plugin` | Task | Author a primitive, drawing tool, chart type, or indicator descriptor. |
| `openalgo-chart-debug` | Task | Diagnose a chart that renders wrong, will not repaint, or throws. |

The hub skill loads on its own when the agent recognises an openalgo-charts task. The task skills are meant to be invoked by name.

## Reference files

`openalgo-charts/references/` holds the depth, kept out of the always-loaded hub so the hub stays cheap to read:

`core-api`, `chart-types`, `scales-and-panes`, `themes-and-styling`, `data-and-time`, `feeds-and-live`, `events-and-state`, `indicators`, `transforms`, `drawing-tools`, `primitives-and-plugins`, `replay-and-compare`, `chart-linking`, `settings-and-menus`, `trading`, `trade-tier`, `profiles-and-orderflow`, `react-integration`, `bundling-and-tiers`, `widget`, `interactions`, `pitfalls`.

## Maintaining these

Every API name, option key, event name, indicator id and default in these files is verified against `src/` and `dist/*.d.ts` rather than written from memory. When the library's public surface changes, update the reference file in the same pull request - a skill that describes an API that no longer exists is worse than no skill, because the agent will trust it.

The library's own docs live at https://marketcalls.github.io/openalgo-charts/ and in `website/`. These skills are not a replacement for them; they are the compressed, assertion-shaped form an agent needs in context.
