import test from 'node:test';
import assert from 'node:assert/strict';
import { addTask, completeTask, failTask, getNextTask, listTasks, recordEvidence, startTask } from '../src/tasks.js';
import { verifyTask } from '../src/verify.js';
import { makeProject, proveTask } from './helpers.js';

test('task requires acceptance criteria', async () => {
  const { project, cleanup } = await makeProject();
  try {
    await assert.rejects(
      () => addTask(project, { title: 'A vague task', acceptance: [] }),
      /acceptance criterion/i
    );
  } finally {
    await cleanup();
  }
});

test('task cannot be created while the spec is invalid', async () => {
  const { project, cleanup } = await makeProject({ spec: null });
  try {
    await assert.rejects(
      () => addTask(project, { title: 'Task on invalid spec', acceptance: ['Something testable'] }),
      /Spec belum lengkap/i
    );
  } finally {
    await cleanup();
  }
});

test('next task respects dependencies and layer checkpoint', async () => {
  const { project, cleanup } = await makeProject();
  try {
    const first = await addTask(project, {
      title: 'Frontend slice',
      acceptance: ['UI renders with mock data'],
      files: ['src/**'],
      layer: 'frontend',
      phase: '1'
    });
    const second = await addTask(project, {
      title: 'Backend slice',
      acceptance: ['API returns persisted data'],
      files: ['src/**'],
      layer: 'backend',
      phase: '2',
      dependsOn: [first.id]
    });

    let next = await getNextTask(project);
    assert.equal(next.task.id, first.id);
    assert.equal(next.checkpoint, null);
    assert.equal(next.total, 2);

    await startTask(project, first.id);
    const verified = await verifyTask(project, first.id);
    assert.equal(verified.result.ok, true);
    assert.equal(verified.result.criteriaOk, false);
    await proveTask(project, first.id);
    await completeTask(project, first.id);

    next = await getNextTask(project);
    assert.equal(next.task.id, second.id);
    assert.equal(next.checkpoint.needed, true);
    assert.match(next.checkpoint.reason, /Layer berubah/);

    await assert.rejects(
      () => startTask(project, second.id),
      (error) => error.code === 'ECHECKPOINT'
    );

    const started = await startTask(project, second.id, { acknowledgeCheckpoint: true });
    assert.equal(started.task.status, 'in_progress');
  } finally {
    await cleanup();
  }
});

test('only one task can be active at a time', async () => {
  const { project, cleanup } = await makeProject();
  try {
    const first = await addTask(project, {
      title: 'Task one',
      acceptance: ['One works'],
      files: ['src/**']
    });
    const second = await addTask(project, {
      title: 'Task two',
      acceptance: ['Two works'],
      files: ['src/**']
    });
    await startTask(project, first.id);
    await assert.rejects(
      () => startTask(project, second.id),
      /task aktif/i
    );
  } finally {
    await cleanup();
  }
});

test('complete without verification is rejected', async () => {
  const { project, cleanup } = await makeProject();
  try {
    const task = await addTask(project, {
      title: 'Unverified task',
      acceptance: ['Should not complete'],
      files: ['src/**']
    });
    await startTask(project, task.id);
    await assert.rejects(
      () => completeTask(project, task.id),
      /belum punya verifikasi/i
    );
  } finally {
    await cleanup();
  }
});

test('evidence validates criterion id, note, and task state', async () => {
  const { project, cleanup } = await makeProject();
  try {
    const task = await addTask(project, {
      title: 'Evidence task',
      acceptance: ['The login form works'],
      files: ['src/**']
    });
    await assert.rejects(
      () => recordEvidence(project, task.id, { criterion: 'A1', note: 'Valid note' }),
      /harus aktif/i
    );
    await startTask(project, task.id);
    await assert.rejects(
      () => recordEvidence(project, task.id, { criterion: 'A9', note: 'A valid note' }),
      /tidak ada/i
    );
    await assert.rejects(
      () => recordEvidence(project, task.id, { criterion: 'A1', note: 'no' }),
      /minimal 5/i
    );
    await assert.rejects(
      () => recordEvidence(project, task.id, { criterion: 'A1', note: `token is ghp_${'A'.repeat(30)}`, type: 'test' }),
      /pola secret/i
    );
    const result = await recordEvidence(project, task.id, {
      criterion: '1',
      note: 'Observed the form submit and redirect',
      type: 'manual',
      ref: 'manual browser check'
    });
    assert.equal(result.criterion.id, 'A1');
    assert.equal(result.criterion.proven, true);
    assert.equal(result.task.evidenceProgress.proven, 1);
    const tasks = await listTasks(project);
    assert.equal(tasks[0].criteria[0].proven, true);
  } finally {
    await cleanup();
  }
});

test('a new attempt clears evidence and verification', async () => {
  const { project, cleanup } = await makeProject();
  try {
    const task = await addTask(project, {
      title: 'Retry task',
      acceptance: ['The feature works'],
      files: ['src/**']
    });
    await startTask(project, task.id);
    await recordEvidence(project, task.id, { criterion: 'A1', note: 'First attempt proof', type: 'test' });
    await failTask(project, task.id, 'First attempt blocked');
    await startTask(project, task.id);
    const refreshed = (await listTasks(project))[0];
    assert.equal(refreshed.evidenceProgress.proven, 0);
    assert.equal(refreshed.verification, null);
  } finally {
    await cleanup();
  }
});
