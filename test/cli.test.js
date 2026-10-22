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

  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'index.ts'), 'export function main() { return 1; }\n');
  const graph = await runCli(project, ['graph', 'stats']);
  assert.equal(graph.code, 0, graph.stderr);
  assert.match(graph.stdout, /Codegraph:/);
  assert.match(graph.stdout, /src\/index\.ts/);
  const graphImpact = await runCli(project, ['graph', 'impact', 'src/index.ts']);
  assert.equal(graphImpact.code, 0, graphImpact.stderr);
  assert.match(graphImpact.stdout, /Target: src\/index\.ts/);

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

  const evidenceList = await runCli(project, ['task', 'evidence', 'T-001']);
  assert.equal(evidenceList.code, 0);
  assert.match(evidenceList.stdout, /A1/);
  assert.match(evidenceList.stdout, /unproven/);

  const start = await runCli(project, ['task', 'start', 'T-001']);
  assert.equal(start.code, 0, start.stderr);

  const evidence = await runCli(project, ['task', 'evidence', 'T-001', 'A1', 'Observed the build check pass', '--type', 'manual']);
  assert.equal(evidence.code, 0, evidence.stderr);
  assert.match(evidence.stdout, /1\/1 criteria proven/);

  const verify = await runCli(project, ['task', 'verify', 'T-001']);
  assert.equal(verify.code, 0, verify.stderr);
  assert.match(verify.stdout, /VERIFIKASI LULUS/);

  const done = await runCli(project, ['task', 'done', 'T-001']);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /selesai/);

  const state = JSON.parse(await fs.readFile(path.join(project, '.vibeguard', 'tasks.json'), 'utf8'));
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].status, 'done');
  assert.equal(state.tasks[0].evidence.A1.type, 'manual');
});
