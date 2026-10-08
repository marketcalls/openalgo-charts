import type * as Terminal from './terminal';

/** Loads docking, depth ladders and their styles without increasing widget startup work. */
export function loadTerminal(): Promise<typeof Terminal> {
  return import('./terminal');
}
