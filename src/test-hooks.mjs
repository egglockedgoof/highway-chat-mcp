// test-hooks.mjs — TEST-ONLY entry point. Registers the .js→.ts resolve hook so
// `node --test` can import the repo's TypeScript sources uncompiled (Node 24
// type stripping). Never imported by production code.
//
// Usage: node --test --import ./src/test-hooks.mjs src/blockers.test.ts

import { register } from 'node:module';

register('./test-resolve-hook.mjs', import.meta.url);
