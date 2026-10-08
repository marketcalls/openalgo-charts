/** Exchange is part of an instrument's identity on both grid and dock layouts. */
export const instrument = (symbol: string, exchange: string): string => JSON.stringify([symbol, exchange]);
