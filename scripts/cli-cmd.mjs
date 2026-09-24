// How tests launch the CLI. Defaults to the TypeScript source on the current
// Node; CI points these at the compiled dist/ and an older Node to check
// compatibility (TUI2WEB_CLI_NODE, TUI2WEB_CLI_ENTRY).
export const CLI_NODE = process.env.TUI2WEB_CLI_NODE || process.execPath;
export const CLI_ENTRY = process.env.TUI2WEB_CLI_ENTRY || 'packages/cli/src/index.ts';
