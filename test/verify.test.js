import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { addTask, completeTask, startTask } from '../src/tasks.js';
import { verifyTask } from '../src/verify.js';
import { makeProject, proveTask, writeFile } from './helpers.js';

async function createTask(project, overrides = {}) {
  return addTask(project, {
    title: 'Implement the slice',
    acceptance: ['The behavior is implemented', 'Checks pass'],
    files: ['src/**'],
    layer: 'frontend',
    phase: '1',
    ...overrides
  });
}

test('passing verification allows completion', async () => {
  const { project, cleanup } = await makeProject();
  try {
    await writeFile(project, 'src/code.js', 'export const value = 1;\n');
    const task = await createTask(project);
    await startTask(project, task.id);
    const output = await verifyTask(project, task.id);
    assert.equal(output.result.ok, true, JSON.stringify(output.result, null, 2));
    assert.equal(output.result.criteriaOk, false);
    assert.ok(output.result.commands[0].ok);
    assert.ok(output.result.fingerprint);
    await assert.rejects(
      () => completeTask(project, task.id),
      /Bukti untuk .* acceptance criterion/i
    );
    await proveTask(project, task.id);
    const completed = await completeTask(project, task.id);
    assert.equal(completed.task.status, 'done');
    assert.ok(completed.task.completedAt);
  } finally {
    await cleanup();
  }
});

test('a failing command blocks verification and completion', async () => {
  const { project, cleanup } = await makeProject({
    commands: [{ name: 'failing', command: 'node -e "process.exit(1)"', required: true, timeoutMs: 20_000 }]
  });
  try {
    const task = await createTask(project);
    await startTask(project, task.id);
    const output = await verifyTask(project, task.id);
    assert.equal(output.result.ok, false);
    assert.deepEqual(output.result.failedCommands, ['failing']);
    assert.ok(output.result.commands[0].durationMs >= 0);
    const runDir = path.join(project, '.vibeguard', 'runs', output.result.runId);
    const files = await fs.readdir(runDir);
    assert.ok(files.some((file) => file.endsWith('.log')));
    await assert.rejects(
      () => completeTask(project, task.id),
      /belum punya verifikasi|verifikasi/i
    );
  } finally {
    await cleanup();
  }
});

test('editing after verification invalidates evidence', async () => {
  const { project, cleanup } = await makeProject();
  try {
    await writeFile(project, 'src/code.js', 'export const value = 1;\n');
    const task = await createTask(project);
    await startTask(project, task.id);
    await verifyTask(project, task.id);
    await writeFile(project, 'src/code.js', 'export const value = 2;\n');
    await assert.rejects(
      () => completeTask(project, task.id),
      /berubah setelah verifikasi|kedaluwarsa/i
    );
    const second = await verifyTask(project, task.id);
    assert.equal(second.result.ok, true);
    await proveTask(project, task.id);
    const completed = await completeTask(project, task.id);
    assert.equal(completed.task.status, 'done');
  } finally {
    await cleanup();
  }
});

test('slop errors block verification', async () => {
  const { project, cleanup } = await makeProject();
  try {
    const task = await createTask(project);
    await startTask(project, task.id);
    await writeFile(project, 'src/sloppy.js', 'export const message = "lorem ipsum dolor sit amet";\n');
    const output = await verifyTask(project, task.id);
    assert.equal(output.result.ok, false);
    assert.equal(output.result.slop.ok, false);
    assert.ok(output.result.slop.errors.some((finding) => finding.pattern === 'lorem ipsum'));
    await assert.rejects(
      () => completeTask(project, task.id),
      /verifikasi/i
    );
  } finally {
    await cleanup();
  }
});

test('slop warnings do not block verification', async () => {
  const { project, cleanup } = await makeProject();
  try {
    await writeFile(project, 'src/code.js', 'export const value = 1; // TODO: document\n');
    const task = await createTask(project);
    await startTask(project, task.id);
    const output = await verifyTask(project, task.id);
    assert.equal(output.result.ok, true, JSON.stringify(output.result.slop, null, 2));
    assert.ok(output.result.slop.warnings.length > 0);
  } finally {
    await cleanup();
  }
});

test('strict scope reports files outside the task scope', async () => {
  const { project, cleanup } = await makeProject({ git: true, strictScope: true });
  try {
    await writeFile(project, 'src/code.js', 'export const value = 1;\n');
    const task = await createTask(project);
    await startTask(project, task.id);
    await writeFile(project, 'outside.txt', 'unrelated change\n');
    const output = await verifyTask(project, task.id);
    assert.equal(output.result.scope.checked, true);
    assert.deepEqual(output.result.scope.violations, ['outside.txt']);
    assert.equal(output.result.ok, false);
    await assert.rejects(
      () => completeTask(project, task.id),
      /verifikasi/i
    );
  } finally {
    await cleanup();
  }
});

test('verification fails when no commands are configured', async () => {
  const { project, cleanup } = await makeProject({ commands: [] });
  try {
    const task = await createTask(project);
    await startTask(project, task.id);
    const output = await verifyTask(project, task.id);
    assert.equal(output.result.noCommands, true);
    assert.equal(output.result.ok, false);
    await assert.rejects(
      () => completeTask(project, task.id),
      /verifikasi/i
    );
  } finally {
    await cleanup();
  }
});

test('changing the spec after start blocks verification', async () => {
  const { project, cleanup } = await makeProject();
  try {
    const task = await createTask(project);
    await startTask(project, task.id);
    const { validSpec } = await import('./helpers.js');
    await fs.writeFile(path.join(project, '.vibeguard', 'spec.md'), `${validSpec()}\nAdditional valid requirement text.\n`);
    await assert.rejects(
      () => verifyTask(project, task.id),
      /kontrak task berubah|berubah sejak task dimulai/i
    );
  } finally {
    await cleanup();
  }
});

test('changing the spec after verification blocks completion', async () => {
  const { project, cleanup } = await makeProject();
  try {
    const task = await createTask(project);
    await startTask(project, task.id);
    const output = await verifyTask(project, task.id);
    assert.equal(output.result.ok, true);
    const { validSpec } = await import('./helpers.js');
    await fs.writeFile(path.join(project, '.vibeguard', 'spec.md'), `${validSpec()}\nAnother valid requirement sentence.\n`);
    await assert.rejects(
      () => completeTask(project, task.id),
      /Spec atau kontrak task berubah/i
    );
  } finally {
    await cleanup();
  }
});
