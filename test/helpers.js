import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initProject, loadConfig, saveConfig, saveSpec } from '../src/store.js';

export function validSpec(name = 'Test Project') {
  return `# Spec — ${name}

## Problem

The current workflow lets coding agents write code without a testable definition of done, so regressions and placeholder UI slip through.

## Goals

- Make each task small enough to verify.
- Require evidence before a task is marked complete.

## Non-goals

- Building a hosted service, billing, or a general chat UI.
- Supporting more than one stack in the first iteration.

## Users

A developer using a local coding agent who wants a fast quality gate.

## Requirements

- The spec must include acceptance criteria and non-goals.
- Tasks must declare a file scope.
- Verification must run the configured project checks.

## Acceptance criteria

- A task with passing checks can be completed.
- A task with failing checks cannot be completed.
- Editing code after verification invalidates the evidence.

## Technical notes

- Node.js ESM, no external runtime dependencies.
- Verification commands are configured per project.

## Risks

- Simple checks can create false confidence; a human still reviews the spec.

## Open questions

- Which secondary stacks should be supported after the MVP?
`;
}

export async function makeProject(options = {}) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeguard-test-'));
  const packageJson = Object.hasOwn(options, 'packageJson')
    ? options.packageJson
    : { name: 'test-project', private: true, scripts: { build: 'node -e "process.exit(0)"' } };
  if (packageJson) {
    await fs.writeFile(path.join(project, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  }
  const files = options.files || {};
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(project, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  await initProject(project, { name: options.name || 'Test Project' });
  if (options.spec !== null) {
    await saveSpec(project, options.spec ?? validSpec(options.name || 'Test Project'));
  }
  const config = await loadConfig(project);
  config.verification.commands = Object.hasOwn(options, 'commands')
    ? options.commands
    : [{ name: 'ok', command: 'node -e "process.exit(0)"', required: true, timeoutMs: 20_000 }];
  config.verification.commandTimeoutMs = 20_000;
  config.verification.strictScope = options.strictScope === true;
  if (options.slop) config.slop = { ...config.slop, ...options.slop };
  await saveConfig(project, config);

  if (options.git) {
    execFileSync('git', ['-C', project, 'init', '-q']);
    execFileSync('git', ['-C', project, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', project, 'config', 'user.name', 'VibeGuard Test']);
    execFileSync('git', ['-C', project, 'add', '-A']);
    execFileSync('git', ['-C', project, 'commit', '-q', '-m', 'initial']);
  }

  return {
    project,
    config,
    async cleanup() {
      await fs.rm(project, { recursive: true, force: true });
    }
  };
}

export async function writeFile(project, rel, content) {
  const abs = path.join(project, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}
