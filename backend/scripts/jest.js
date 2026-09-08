/**
 * Locate the Jest CLI wherever npm put it.
 *
 * The repository uses npm workspaces, so `jest` is normally hoisted to the root
 * `node_modules` and a hard-coded `node_modules/jest/bin/jest.js` inside this
 * package does not exist. Resolving it instead works under both a hoisted and a
 * nested install, and on every platform, without adding a cross-env dependency
 * just to set NODE_OPTIONS.
 *
 * Jest's ESM support requires `--experimental-vm-modules`, which has to be on
 * the node command line, so the package script stays
 * `node --experimental-vm-modules ./scripts/jest.js …` and this file only has
 * to find the CLI and hand the arguments over.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

function resolveJestCli() {
  const candidates = ['jest/bin/jest', 'jest/bin/jest.js'];
  const failures = [];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch (error) {
      failures.push(`${candidate}: ${error.code ?? error.message}`);
    }
  }
  throw new Error(
    `Unable to locate the Jest CLI. Run \`npm install\` from the repository root.\n  ${failures.join('\n  ')}`,
  );
}

const cliPath = resolveJestCli();

// Jest reads process.argv; replace the shim's own path with the CLI's so that
// argv[1] is what Jest expects while every user argument is preserved.
process.argv[1] = cliPath;

await import(pathToFileURL(cliPath).href);
