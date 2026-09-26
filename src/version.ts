/** Library version string. Matches package.json (including locally prepared releases). */
export const VERSION = '2.5.6';

/** Returns the current library version. */
export function version(): string {
  return VERSION;
}
