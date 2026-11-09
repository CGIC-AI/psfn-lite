// Donor tests read config/ seeds, README.md and src/ paths relative to
// process.cwd(), which in the donor is the repository root. Here that root is
// this package.
process.chdir(new URL('.', import.meta.url).pathname);
