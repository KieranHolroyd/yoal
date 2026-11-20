#!/usr/bin/env bun
/**
 * Scenario: kill node-b (the W1 exit of HA-PLAN §4). Kept for its name and its CI history; it is
 * `kill-node.ts --node lab-b` (see that file for every flag, the checks and the verdicts).
 *
 *   bun tests/ha/scenarios/kill-node-b.ts [--method kill|stop|partition] [--target edge|direct] …
 */
if (!process.argv.includes('--node')) process.argv.splice(2, 0, '--node', 'lab-b');
await import('./kill-node.ts');
export {};
