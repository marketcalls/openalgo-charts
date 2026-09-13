/** Library version string. Matches package.json (including locally prepared releases). */
export const VERSION = '2.1.8';

/** Returns the current library version. */
export function version(): string {
  return VERSION;
}
