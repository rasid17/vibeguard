#!/usr/bin/env node
import { run } from '../src/cli.js';

run(process.argv.slice(2)).catch((error) => {
  const message = error?.message || String(error);
  process.stderr.write(`vibeguard: ${message}\n`);
  if (error?.hint) process.stderr.write(`hint: ${error.hint}\n`);
  process.exitCode = typeof error?.exitCode === 'number' ? error.exitCode : 1;
});
