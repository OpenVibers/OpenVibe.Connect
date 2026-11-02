'use strict';

let failures = 0;
async function check(name, fn) {
    try { await fn(); process.stdout.write(`  ✓ ${name}\n`); } catch (e) { failures++; process.stdout.write(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')}\n`); }
}
function done() { process.stdout.write(failures ? `\n${failures} failed\n` : '\nall passed\n'); process.exit(failures ? 1 : 0); }
function assert(cond, message) { if (!cond) throw new Error(message || 'assertion failed'); }
function equal(a, b, message) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${message || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
module.exports = { check, done, assert, equal };
