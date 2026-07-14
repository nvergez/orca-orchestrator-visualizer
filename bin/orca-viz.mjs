#!/usr/bin/env node
// The `npx orca-viz` entry point.
//
// This file is plain JavaScript, and it is the only file in the package that a Node too old
// to run orca-viz can still load. That is the whole reason it exists: `main.js` imports
// `node:sqlite`, and on Node < 22.5 an ESM static import of a module that does not exist
// fails *before any of our code runs* — so the user's error would be
// `Cannot find module 'node:sqlite'` rather than a sentence telling them what to do.
//
// So: check the floor, then import the real thing.

import { nodeVersionError, suppressExperimentalWarning } from '../dist/server/node-support.js';

const problem = nodeVersionError();
if (problem) {
  console.error(problem);
  process.exit(1);
}

suppressExperimentalWarning();

await import('../dist/server/main.js');
