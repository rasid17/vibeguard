import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { addTask } from '../src/tasks.js';
import { buildContextPack } from '../src/context.js';
import { makeProject } from './helpers.js';

test('context pack selects relevant files and excludes secrets', async () => {
  const { project, cleanup } = await makeProject({
    files: {
      'src/auth/login.ts': 'import { hash } from "../util/crypto";\nexport function login(email: string) { return hash(email); }\n',
      'src/util/crypto.ts': 'export function hash(value: string) { return value.length; }\n',
      'src/unrelated.ts': 'export const unrelated = true;\n',
      'docs/guide.md': '# Guide\n\nLogin documentation.\n',
      '.env': 'SECRET_TOKEN=super-secret-value\n',
      'README.md': '# Test project\n\nLocal quality gate demo.\n'
    }
  });
  try {
    const task = await addTask(project, {
      title: 'Build login page',
      description: 'Use the existing crypto helper for the login flow.',
      acceptance: ['Login form validates email', 'Password hashing reuses the existing helper'],
      files: ['src/auth/**'],
      layer: 'frontend',
      phase: '1'
    });
    const pack = await buildContextPack(project, task.id);
    assert.match(pack.markdown, /Build login page/);
    assert.match(pack.markdown, /## Acceptance criteria/);
    assert.match(pack.markdown, /src\/auth\/login\.ts/);
    assert.match(pack.markdown, /src\/util\/crypto\.ts/);
    assert.match(pack.markdown, /The current workflow lets coding agents/);
    assert.doesNotMatch(pack.markdown, /super-secret-value/);
    assert.ok(pack.files.includes('src/auth/login.ts'));
    const stat = await fs.stat(pack.outputFile);
    assert.ok(stat.size > 0);
    assert.equal(path.basename(pack.outputFile), `${task.id}.md`);
  } finally {
    await cleanup();
  }
});

test('context pack respects the character budget', async () => {
  const files = {};
  for (let index = 0; index < 30; index += 1) {
    files[`src/feature-${index}.ts`] = `export const value${index} = "${'x'.repeat(800)}";\n`;
  }
  const { project, cleanup } = await makeProject({ files });
  try {
    const task = await addTask(project, {
      title: 'Work on feature files',
      acceptance: ['Relevant files are selected'],
      files: ['src/**'],
      layer: 'frontend',
      phase: '1'
    });
    const pack = await buildContextPack(project, task.id, { maxChars: 5000 });
    assert.ok(pack.used <= 5000, `used=${pack.used}`);
    assert.ok(pack.markdown.length <= 5000, `length=${pack.markdown.length}`);
  } finally {
    await cleanup();
  }
});
