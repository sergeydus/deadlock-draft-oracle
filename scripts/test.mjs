/**
 * Entry point for `npm test` — picks the flags this Node needs, then runs
 * `verify.mjs`.
 *
 * The harness imports `src/**` directly and relies on native TypeScript type
 * stripping. That is unflagged from Node 23.6 and available behind
 * `--experimental-strip-types` from 22.6. Below that it cannot run at all.
 *
 * This has to be a separate process rather than a check at the top of
 * verify.mjs: ESM links the whole module graph before evaluating any of it, so
 * verify.mjs's `.ts` imports fail with a bare ERR_UNKNOWN_FILE_EXTENSION before
 * a single line of its own code could report anything useful. That is exactly
 * the error this file exists to replace.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const UNFLAGGED = [23, 6];   // type stripping on by default
const FLAGGED = [22, 6];     // available behind --experimental-strip-types

const [major, minor] = process.versions.node.split('.').map(Number);
const atLeast = ([wantMajor, wantMinor]) => major > wantMajor || (major === wantMajor && minor >= wantMinor);

if (!atLeast(FLAGGED)) {
  console.error(`
This project's tests run TypeScript through Node directly, with no build step.
That needs Node ${UNFLAGGED.join('.')}+ (or ${FLAGGED.join('.')}+ with --experimental-strip-types).

  running: Node ${process.versions.node}

Install Node 24 — the version CI uses, and the one named in .nvmrc — then retry:

  nvm use            # or: nvm install 24
  npm test
`.trim());
  process.exit(1);
}

const verify = join(dirname(fileURLToPath(import.meta.url)), 'verify.mjs');
const flags = atLeast(UNFLAGGED)
  ? []
  // The warning is noise here: stripping is exactly what we are asking for.
  : ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

if (flags.length) {
  console.log(`Node ${process.versions.node}: running with --experimental-strip-types (unflagged from ${UNFLAGGED.join('.')}).`);
}

spawn(process.execPath, [...flags, verify, ...process.argv.slice(2)], { stdio: 'inherit' })
  .on('exit', (code) => { process.exitCode = code ?? 1; });
