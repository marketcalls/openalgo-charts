/** Library version string. Matches package.json (published npm release). */
export const VERSION = '1.0.1';

/** Returns the current library version. */
export function version(): string {
  return VERSION;
}
