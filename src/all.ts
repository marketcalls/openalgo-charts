/**
 * Combined bundle: base + transform + profile in a single module instance, so
 * the transform tier's custom chart-type renderers (Point & Figure, Kagi) are
 * registered in the SAME registry that `createChart` reads. This is built for
 * the documentation site's live demos only — it is NOT a published package
 * entry point (apps should import the individual tiers they use).
 *
 * The trade tier is intentionally excluded (it shares some type names with the
 * base feed types, and the trade demos use only base APIs).
 */
export * from './index';
export * from './transform/index'; // side effect: registers 'point-figure' and 'kagi'
export * from './profile/index';
