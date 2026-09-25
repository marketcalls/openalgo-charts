// A study the host places and protects. It shows the study policies working
// together: the user keeps the view of it (hide and show it, read its
// values, raise an alert on it), but no legend button, Objects dock row,
// menu, chip or settings dialog removes it, changes its settings or moves
// it off its pane or out of its place in the stack. It is listed, so the
// dock shows exactly which actions the policy withholds. The policy is
// saved with the layout, so a reload brings the study back protected.
// Only the host takes it away again, through its own "Remove Protected
// VWAP" row, which is the one place `force` is passed.

/** The policy the host study carries. */
export const HOST_STUDY_POLICY = Object.freeze({ removable: false, configurable: false, movable: false });

/** The host's protected study on `chart`, if it holds one. */
export function hostStudy(chart) {
  if (!chart) return undefined;
  return chart.indicators().find((study) => study.indicatorId === 'vwap' && typeof study.policy === 'function'
    && Object.keys(HOST_STUDY_POLICY).every((flag) => study.policy()[flag] === false));
}

/** Add the protected study, or return the one already there. */
export function addHostStudy(chart) {
  return hostStudy(chart) ?? chart.addIndicator('vwap', {}, { policy: { ...HOST_STUDY_POLICY } });
}

/** Take the protected study away: the host's act, so it passes `force`. */
export function removeHostStudy(chart) {
  const study = hostStudy(chart);
  return study !== undefined && chart.removeIndicator(study.id, { force: true });
}

/** What a user control may do with a study: a missing `policy` (an older engine) allows everything. */
export function studyAllows(study, flag) {
  return typeof study?.policy !== 'function' || study.policy()[flag] !== false;
}
