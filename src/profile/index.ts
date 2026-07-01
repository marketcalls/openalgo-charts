// Profile tier (opt-in: "openalgo-charts/profile").
// Family C: Volume Profile + TPO (from OHLCV) and Footprint + Orderflow (which
// need classified trade data — see footprint.ts data-dependency note).

export const PROFILE_TIER = 'profile' as const;

export type { VolumeProfileResult, TpoResult, FootprintBar, FootprintCell } from './profile-model';
export { bucketPrice, priceBuckets } from './profile-model';
export { computeVolumeProfile, type VolumeProfileOptions } from './volume-profile';
export {
  computeVolumeProfileSessions,
  DEFAULT_VOLUME_PROFILE_FAMILY_OPTIONS,
  type VolumeProfileFamilyOptions,
  type VolumeProfileSession,
  type VolumeProfileLevel,
  type VolumeProfileSessionResult,
  type VolumeProfileFamilyResult,
} from './volume-profile-family';
export {
  VolumeProfile,
  DEFAULT_VOLUME_PROFILE_PRIMITIVE_OPTIONS,
  type VolumeProfilePrimitiveOptions,
  type VolumeDisplayMode,
  type VolumeProfileSide,
} from './volume-profile-primitive';
export { computeTpo } from './tpo';
export {
  computeMarketProfile,
  tpoLetter,
  DEFAULT_MARKET_PROFILE_OPTIONS,
  type MarketProfileOptions,
  type MarketProfileSession,
  type MarketProfileLevel,
  type MarketProfileSessionResult,
  type MarketProfileResult,
} from './market-profile';
export {
  MarketProfile,
  DEFAULT_MARKET_PROFILE_PRIMITIVE_OPTIONS,
  type MarketProfilePrimitiveOptions,
  type MpColorMode,
} from './market-profile-primitive';
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
