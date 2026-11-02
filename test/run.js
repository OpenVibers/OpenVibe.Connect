#!/usr/bin/env node
/**
 * Runs every test/*.test.js in its own process and fails if any fails. They use temp PGlite databases, an
 * in-process mock of OpenVibe.Network, and in-process Chat/Live/Video fixtures; none needs the network.
 *
 *   npm test                 # everything
 *   npm test -- importer     # only files whose name contains one of the words
 *   npm test -- --strict     # a skipped test fails the run too
 */
'use strict';
const { run } = require('openvibe-shared/test-runner');

// VERBOSE=1 also prints every file's output, then the summary again.
run({ dir: __dirname, timeoutMs: 90000, pad: 34, parallel: 1 }).then((r) => {
    if (process.env.VERBOSE) {
        for (const t of r.results) console.log(`\n── ${t.file} ──\n${t.output.trimEnd()}`);
        console.log(`\n${r.summary}`);
    }
    process.exit(r.exitCode);
}, (err) => { console.error(err); process.exit(1); });
