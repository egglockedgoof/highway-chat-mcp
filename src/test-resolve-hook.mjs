// test-resolve-hook.mjs — TEST-ONLY module resolution hook.
//
// Node 24 type stripping does not map `./foo.js` → `./foo.ts`, but the repo's
// source uses `.js` import specifiers (required for the compiled `dist/` build).
// This hook lets the uncompiled test suite (`node --test src/*.test.ts`) resolve
// those specifiers to their `.ts` sources. Never imported by production code.
//
// Usage: node --test --import ./src/test-hooks.mjs src/blockers.test.ts

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export async function resolve(specifier, context, nextResolve) {
  if (typeof specifier === 'string' && specifier.endsWith('.js')) {
    const parentPath = context.parentURL?.startsWith('file:')
      ? fileURLToPath(context.parentURL)
      : null;
    const base = parentPath ? path.dirname(parentPath) : process.cwd();
    const tsCandidate = path.resolve(base, specifier.slice(0, -3) + '.ts');
    if (existsSync(tsCandidate)) {
      return { url: pathToFileURL(tsCandidate).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
