import test from 'node:test';
import assert from 'node:assert/strict';
import { addTask, startTask } from '../src/tasks.js';
import { verifyTask } from '../src/verify.js';
import { makeProject, writeFile } from './helpers.js';

const fakeGithubToken = `ghp_${'A'.repeat(30)}`;

test('secret findings block verification and are masked', async () => {
  const { project, cleanup } = await makeProject();
  try {
    await writeFile(project, 'src/leak.js', `export const token = "${fakeGithubToken}";\n`);
    const task = await addTask(project, {
      title: 'Leak a token',
      acceptance: ['The token is handled safely'],
      files: ['src/**'],
      layer: 'backend',
      phase: '1'
    });
    await startTask(project, task.id);
    const output = await verifyTask(project, task.id);
    assert.equal(output.result.ok, false);
    assert.equal(output.result.secrets.ok, false);
    assert.ok(output.result.secrets.findings.some((finding) => finding.type === 'github-token'));
    assert.ok(output.result.secrets.findings.every((finding) => !finding.excerpt.includes(fakeGithubToken)));
    assert.doesNotMatch(JSON.stringify(output.result.secrets), new RegExp(fakeGithubToken));
  } finally {
    await cleanup();
  }
});

test('test files are ignored by the default secret scan', async () => {
  const { project, cleanup } = await makeProject();
  try {
    await writeFile(project, 'src/leak.test.js', `export const token = "${fakeGithubToken}";\n`);
    const task = await addTask(project, {
      title: 'Use a fixture token',
      acceptance: ['The fixture is present'],
      files: ['src/**'],
      layer: 'backend',
      phase: '1'
    });
    await startTask(project, task.id);
    const output = await verifyTask(project, task.id);
    assert.equal(output.result.secrets.ok, true, JSON.stringify(output.result.secrets, null, 2));
    assert.equal(output.result.ok, true, JSON.stringify(output.result, null, 2));
  } finally {
    await cleanup();
  }
});

test('custom secret patterns are supported', async () => {
  const { project, cleanup } = await makeProject();
  try {
    await writeFile(project, 'src/custom.js', 'export const code = "ACME-1234";\n');
    const { loadConfig, saveConfig } = await import('../src/store.js');
    const config = await loadConfig(project);
    config.secrets.patterns = ['/ACME-[0-9]{4}/g'];
    await saveConfig(project, config);
    const task = await addTask(project, {
      title: 'Add a custom secret',
      acceptance: ['Custom pattern is detected'],
      files: ['src/**'],
      layer: 'backend',
      phase: '1'
    });
    await startTask(project, task.id);
    const output = await verifyTask(project, task.id);
    assert.equal(output.result.secrets.ok, false);
    assert.ok(output.result.secrets.findings.some((finding) => finding.type === 'custom-1'));
  } finally {
    await cleanup();
  }
});
