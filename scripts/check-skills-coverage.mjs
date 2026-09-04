#!/usr/bin/env node
/**
 * Does .github/skills still describe the whole public surface?
 *
 * The skills' own README sets the rule: every API name, option key, event name and
 * indicator id in them is verified against the build rather than written from memory,
 * "because the agent will trust it". Nothing enforced that rule, and the references
 * drifted to 75% coverage across several releases before anyone noticed - including
 * seven sections still marked "(unreleased)" for features that had shipped.
 *
 * This checks the cheap, mechanical half: that every runtime export, indicator id,
 * chart type and drawing tool id is at least named somewhere in the skills. Being
 * named is not the same as being explained, so a pass here is a floor, not a ceiling.
 *
 * Usage: node scripts/check-skills-coverage.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS = join(ROOT, '.github', 'skills')

const TIERS = {
  base: 'openalgo-charts.mjs',
  indicators: 'openalgo-charts.indicators.mjs',
  draw: 'openalgo-charts.draw.mjs',
  transform: 'openalgo-charts.transform.mjs',
  profile: 'openalgo-charts.profile.mjs',
  trade: 'openalgo-charts.trade.mjs',
  webgl: 'openalgo-charts.webgl.mjs',
}

const mods = {}
for (const [tier, file] of Object.entries(TIERS)) {
  const p = join(ROOT, 'dist', file)
  try {
    mods[tier] = await import(pathToFileURL(p).href)
  } catch {
    console.error(`cannot read ${p}. Run \`npm run build\` first.`)
    process.exit(2)
  }
}
mods.draw.registerBuiltinDrawingTools?.()

const files = []
;(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p)
    else if (extname(entry) === '.md') files.push(p)
  }
})(SKILLS)
const text = files.map((f) => readFileSync(f, 'utf8')).join('\n')

/** An id counts as named however the prose happens to quote it. */
const namedId = (id) =>
  text.includes(`\`${id}\``) || text.includes(`'${id}'`) || text.includes(`| ${id} `)

const groups = []
for (const [tier, m] of Object.entries(mods)) {
  groups.push([`exports:${tier}`, Object.keys(m), (n) => text.includes(n)])
}
groups.push(['indicator ids', mods.base.registeredIndicators().map((d) => d.id), namedId])
groups.push(['chart types', mods.base.registeredChartTypes(), namedId])
groups.push(['drawing tools', mods.draw.registeredDrawingTools().map((t) => t.id ?? t), namedId])

let total = 0
let missing = 0
for (const [label, items, isNamed] of groups) {
  const gaps = items.filter((i) => !isNamed(i))
  total += items.length
  missing += gaps.length
  const pct = (((items.length - gaps.length) / items.length) * 100).toFixed(1)
  console.log(`${label.padEnd(20)} ${String(items.length - gaps.length).padStart(4)}/${String(items.length).padEnd(4)} ${pct}%`)
  if (gaps.length) console.log('   undocumented: ' + gaps.join(', '))
}

console.log(`\nTOTAL ${total - missing}/${total} (${(((total - missing) / total) * 100).toFixed(1)}%)`)
if (missing) {
  console.log(`\n${missing} name(s) exist in the build but appear nowhere in .github/skills.`)
  console.log('Document them in the matching references/ file, then re-run.')
}
process.exit(missing === 0 ? 0 : 1)
