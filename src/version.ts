/** Library version string. Matches package.json (including locally prepared releases). */
export const VERSION = '2.5.7';

/** Returns the current library version. */
export function version(): string {
  return VERSION;
}
