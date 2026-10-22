import test from 'node:test';
import assert from 'node:assert/strict';
import { createUiServer } from '../src/server.js';
import { makeProject } from './helpers.js';

test('dashboard requires a token and serves state', async (t) => {
  const { project, cleanup } = await makeProject({
    files: {
      'src/lib/auth.ts': 'export function login(email) { return email.length; }\n',
      'src/app.ts': 'import { login } from "./lib/auth";\nexport const run = () => login("a@b.c");\n'
    }
  });
  const server = await createUiServer(project, { port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await server.close();
    await cleanup();
  });

  const root = await fetch(`http://127.0.0.1:${server.port}/`);
  assert.equal(root.status, 401);

  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /VibeGuard/);
  assert.match(html, /__VG__/);

  const unauthorized = await fetch(`http://127.0.0.1:${server.port}/api/state`);
  assert.equal(unauthorized.status, 401);

  const headers = { 'x-vibeguard-token': server.token };
  const stateResponse = await fetch(`http://127.0.0.1:${server.port}/api/state`, { headers });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.project.path, project);
  assert.equal(state.tasks.length, 0);
  assert.equal(state.spec.check.ok, true);

  const graphResponse = await fetch(`http://127.0.0.1:${server.port}/api/graph`, { headers });
  assert.equal(graphResponse.status, 200);
  const graphData = await graphResponse.json();
  assert.ok(graphData.stats.files >= 2);

  const graphQueryResponse = await fetch(`http://127.0.0.1:${server.port}/api/graph?q=auth`, { headers });
  const graphQueryData = await graphQueryResponse.json();
  assert.ok(graphQueryData.query.matches.some((match) => match.path === 'src/lib/auth.ts'));

  const graphImpactResponse = await fetch(`http://127.0.0.1:${server.port}/api/graph?target=src/lib/auth.ts`, { headers });
  const graphImpactData = await graphImpactResponse.json();
  assert.equal(graphImpactData.impact.found, true);
  assert.ok(graphImpactData.impact.directDependents.some((item) => item.path === 'src/app.ts'));

  const addResponse = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Dashboard-created task',
      acceptance: ['Task appears in the dashboard'],
      files: ['src/**'],
      layer: 'frontend',
      phase: '1'
    })
  });
  assert.equal(addResponse.status, 201);
  const added = await addResponse.json();
  assert.equal(added.task.id, 'T-001');

  const stateAgain = await fetch(`http://127.0.0.1:${server.port}/api/state`, { headers });
  const stateData = await stateAgain.json();
  assert.equal(stateData.tasks.length, 1);

  const startResponse = await fetch(`http://127.0.0.1:${server.port}/api/tasks/T-001/start`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(startResponse.status, 200);
  const started = await startResponse.json();
  assert.equal(started.task.status, 'in_progress');

  const verifyResponse = await fetch(`http://127.0.0.1:${server.port}/api/tasks/T-001/verify`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(verifyResponse.status, 200);
  const verified = await verifyResponse.json();
  assert.equal(verified.ok, true, JSON.stringify(verified.result?.failedCommands));
  assert.equal(verified.task.status, 'in_progress');
  assert.equal(verified.result.criteriaOk, false);

  const evidenceResponse = await fetch(`http://127.0.0.1:${server.port}/api/tasks/T-001/evidence`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      criterion: 'A1',
      note: 'Task is visible in the dashboard state after creation',
      type: 'test',
      ref: 'server.test.js'
    })
  });
  assert.equal(evidenceResponse.status, 200);
  const evidence = await evidenceResponse.json();
  assert.equal(evidence.criterion.proven, true);

  const completeResponse = await fetch(`http://127.0.0.1:${server.port}/api/tasks/T-001/complete`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(completeResponse.status, 200);
  const completed = await completeResponse.json();
  assert.equal(completed.task.status, 'done');
});

test('dashboard refuses non-loopback binds', async () => {
  const { project, cleanup } = await makeProject();
  try {
    await assert.rejects(
      () => createUiServer(project, { port: 0, host: '0.0.0.0' }),
      /loopback/i
    );
  } finally {
    await cleanup();
  }
});
