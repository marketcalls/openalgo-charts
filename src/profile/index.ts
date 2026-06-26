// Profile tier (opt-in: "openalgo-charts/profile").
// Family C: Volume Profile + TPO (from OHLCV) and Footprint + Orderflow (which
// need classified trade data — see footprint.ts data-dependency note).

export const PROFILE_TIER = 'profile' as const;

export type { VolumeProfileResult, TpoResult, FootprintBar, FootprintCell } from './profile-model';
export { bucketPrice, priceBuckets } from './profile-model';
export { computeVolumeProfile, type VolumeProfileOptions } from './volume-profile';
export { computeTpo } from './tpo';
export {
  computeFootprint,
  diagonalImbalances,
  cumulativeDelta,
  stackedImbalances,
  type ClassifiedTrade,
  type Imbalance,
  type StackedImbalance,
} from './footprint';
export {
  HorizontalProfile,
  Footprint,
  type ProfileLevel,
  type HorizontalProfileOptions,
  type FootprintOptions,
} from './profile-primitive';
export {
  FootprintAggregator,
  type FootprintTick,
  type FootprintUpdate,
} from './footprint-aggregator';
