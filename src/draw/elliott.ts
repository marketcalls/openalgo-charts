/**
 * Elliott wave counts: the labels of the five wave tools in a degree's
 * notation, and the origin the impulse and the correction gained in 2.7.1.
 *
 * A wave count is labelled by degree. Each of the nine degrees names its waves
 * with one of three numeral families (upper Roman, Arabic, lower Roman) in one
 * of three forms (circled, in parentheses, plain), largest degree first, so a
 * count of one degree reads apart from the count it subdivides. The default
 * degree is Intermediate, Arabic numerals and capital letters in parentheses:
 * a count reads (1) to (5) or (A) to (C) until it is given another.
 *
 * Every wave starts where the one before it ended, so a count starts at an
 * origin: the first point placed, the start of wave 1 or of wave A. It is a
 * point, not a wave, so it carries no label, and the count is numbered from
 * the second point on. Through 2.7.0 the impulse and the correction had no
 * origin: their first anchor was the end of wave 1 or of wave A, and that
 * wave was never drawn. {@link withWaveOrigin} gives an older drawing an
 * origin on its first anchor, where it adds no leg, so the origin can then be
 * dragged out to draw the first wave.
 */
import type { DrawingPoint, SettingsField } from './types';

type Family = 'upper' | 'arabic' | 'lower';
type Form = 'circled' | 'parentheses' | 'plain';

/** The degrees from largest to smallest, each with the notation it labels waves in. */
const DEGREES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'grand-supercycle', label: 'Grand Supercycle' }, { value: 'supercycle', label: 'Supercycle' },
  { value: 'cycle', label: 'Cycle' }, { value: 'primary', label: 'Primary' },
  { value: 'intermediate', label: 'Intermediate' }, { value: 'minor', label: 'Minor' },
  { value: 'minute', label: 'Minute' }, { value: 'minuette', label: 'Minuette' },
  { value: 'subminuette', label: 'Subminuette' },
];
const FAMILIES: readonly Family[] = ['upper', 'arabic', 'lower'];
const FORMS: readonly Form[] = ['circled', 'parentheses', 'plain'];
const DEFAULT_DEGREE = 'intermediate';
/** `degree` follows the degree's own form; the others override it. */
const LABEL_STYLES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'degree', label: 'By degree' }, { value: 'plain', label: 'Plain' },
  { value: 'parentheses', label: 'Parentheses' }, { value: 'circled', label: 'Circled' },
];

/** The two settings every wave tool adds to the pattern fields. */
export const ELLIOTT_FIELDS: readonly SettingsField[] = [
  { path: 'props.degree', label: 'Degree', kind: 'select', group: 'behavior', defaultValue: DEFAULT_DEGREE, options: DEGREES },
  { path: 'props.labelStyle', label: 'Label style', kind: 'select', group: 'behavior', defaultValue: 'degree', options: LABEL_STYLES },
];

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];

/** One wave label as painted: its text, and whether a ring is drawn round it. */
export interface ElliottLabel { text: string; ring: boolean }

/**
 * The labels of a count, from its tokens (`''` for the origin, which is not
 * labelled, digits for an impulse's waves, letters for a corrective one's)
 * and the drawing's degree and label style. An unknown degree or style reads
 * as the default, so a value a later build wrote never leaves a count
 * unlabelled.
 */
export function elliottLabels(tokens: readonly string[], props: Readonly<Record<string, unknown>> | undefined): ElliottLabel[] {
  const found = DEGREES.findIndex(d => d.value === props?.degree);
  const degree = found < 0 ? DEGREES.findIndex(d => d.value === DEFAULT_DEGREE) : found;
  const family = FAMILIES[Math.floor(degree / 3)]!; // nine degrees, three families of three
  const style = props?.labelStyle;
  const form: Form = style === 'plain' || style === 'parentheses' || style === 'circled' ? style : FORMS[degree % 3]!;
  return tokens.map(token => {
    if (token === '') return { text: '', ring: false };
    const digit = /^[1-5]$/.test(token) ? Number(token) : 0;
    const word = digit === 0 ? (family === 'lower' ? token.toLowerCase() : token)
      : family === 'arabic' ? token : family === 'upper' ? ROMAN[digit]! : ROMAN[digit]!.toLowerCase();
    return { text: form === 'parentheses' ? `(${word})` : word, ring: form === 'circled' };
  });
}

/** Anchors each wave tool drew before it had an origin, through 2.7.0. */
const BEFORE_ORIGIN: ReadonlyMap<string, number> = new Map([['elliott-impulse', 5], ['elliott-correction', 3]]);

/**
 * A wave drawing's anchors with its origin: an impulse or a correction saved
 * with the anchor count it had through 2.7.0 gains one on its first anchor,
 * and anything else comes back as it was. Idempotent, and pure, so the
 * migration can run it on every load.
 */
export function withWaveOrigin(tool: string, points: DrawingPoint[]): DrawingPoint[] {
  const before = BEFORE_ORIGIN.get(tool);
  const first = points[0];
  return before !== undefined && points.length === before && first !== undefined ? [{ ...first }, ...points] : points;
}

/**
 * Whether a count's origin is the one {@link withWaveOrigin} gave it, not yet
 * moved: a tool that had no origin through 2.7.0, with the origin still on its
 * first wave's end, where the leg to it has no length to draw.
 */
export function upgradedOrigin(tool: string, points: readonly DrawingPoint[]): boolean {
  const origin = points[0], first = points[1];
  return BEFORE_ORIGIN.has(tool) && origin !== undefined && first !== undefined
    && origin.time === first.time && origin.price === first.price;
}
