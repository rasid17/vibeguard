import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { validSpec } from './helpers.js';

const bin = path.resolve('bin', 'vibeguard.js');

function runCli(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timeout: ${args.join(' ')}`));
    }, 20_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('CLI init, spec validation and task creation', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeguard-cli-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'cli-demo', scripts: { build: 'node -e "process.exit(0)"' } }));

  const init = await runCli(project, ['init', '--name', 'CLI Demo']);
  assert.equal(init.code, 0, init.stderr);
  assert.match(init.stdout, /diinisialisasi/);
  assert.match(init.stdout, /MCP: \.mcp\.json/);
  for (const rel of ['.vibeguard/config.json', '.vibeguard/spec.md', '.vibeguard/tasks.json', '.mcp.json', 'AGENTS.md', 'CLAUDE.md']) {
    await fs.access(path.join(project, rel));
  }

  const badSpec = await runCli(project, ['spec', 'check']);
  assert.equal(badSpec.code, 1);
  assert.match(badSpec.stdout, /belum valid/i);

  await fs.writeFile(path.join(project, '.vibeguard', 'spec.md'), validSpec('CLI Demo'));
  const goodSpec = await runCli(project, ['spec', 'check']);
  assert.equal(goodSpec.code, 0, goodSpec.stdout);
  assert.match(goodSpec.stdout, /Spec valid/);

  const emptyStatus = await runCli(project, ['status']);
  assert.equal(emptyStatus.code, 0);
  assert.match(emptyStatus.stdout, /Belum ada task/);

  const noCriteria = await runCli(project, ['task', 'add', 'A task without criteria']);
  assert.equal(noCriteria.code, 1);
  assert.match(noCriteria.stderr, /acceptance criterion/i);

  const add = await runCli(project, [
    'task', 'add', 'CLI task',
    '--criteria', 'The task is created',
    '--files', 'src/**',
    '--layer', 'frontend',
    '--phase', '1'
  ]);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /T-001/);

  const next = await runCli(project, ['task', 'next']);
  assert.equal(next.code, 0);
  assert.match(next.stdout, /T-001/);
  assert.match(next.stdout, /CLI task/);

  const state = JSON.parse(await fs.readFile(path.join(project, '.vibeguard', 'tasks.json'), 'utf8'));
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].status, 'pending');
});
