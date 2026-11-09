/** Types for build.mjs (the Desktop half's build), for the tests that rebuild it. */
export const ENTRY: string;
export const OUTFILE: string;
export const EXTERNALS: readonly string[];
export function bundleText(): Promise<string>;
