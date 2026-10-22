import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, readGraphCache, writeGraphCache } from '../src/graph.js';
import { graphStats, graphToMermaid, impactGraph, queryGraph } from '../src/codegraph.js';
import { addTask } from '../src/tasks.js';
import { buildContextPack } from '../src/context.js';
import { makeProject, writeFile } from './helpers.js';

async function seedGraph(project) {
  await writeFile(project, 'src/lib/auth.ts', 'export function login(email: string) { return email.length; }\n');
  await writeFile(project, 'src/lib/util.ts', 'export const slug = (value: string) => value.toLowerCase();\n');
  await writeFile(project, 'src/app.ts', 'import { login } from "./lib/auth";\nexport function run() { return login("a@b.c"); }\n');
  await writeFile(project, 'src/app.test.ts', 'import { run } from "./app";\nrun();\n');
  await writeFile(project, 'docs/guide.md', '# Guide\n\nDocumentation is not a codegraph node.\n');
}

test('codegraph builds files, symbols, imports, tests and queries', async () => {
  const { project, cleanup } = await makeProject();
  try {
    await seedGraph(project);
    const graph = await buildGraph(project);
    const stats = graphStats(graph);
    assert.equal(stats.files, 4);
    assert.ok(stats.symbols >= 3);
    assert.equal(stats.tests, 1);
    assert.ok(stats.edges >= 5);
    assert.ok(stats.topHubs.some((hub) => hub.path === 'src/lib/auth.ts'));

    const fileQuery = queryGraph(graph, 'auth');
    assert.ok(fileQuery.matches.some((match) => match.path === 'src/lib/auth.ts' && match.type === 'file'));
    const symbolQuery = queryGraph(graph, 'login');
    assert.ok(symbolQuery.matches.some((match) => match.name === 'login' && match.path === 'src/lib/auth.ts'));
    assert.ok(!queryGraph(graph, 'guide').matches.some((match) => match.path.endsWith('.md')));
  } finally {
    await cleanup();
  }
});

test('impact analysis follows reverse imports and finds tests', async () => {
  const { project, cleanup } = await makeProject();
  try {
    await seedGraph(project);
    const graph = await buildGraph(project);
    const impact = impactGraph(graph, 'src/lib/auth.ts', { depth: 2 });
    assert.equal(impact.found, true);
    assert.equal(impact.target, 'src/lib/auth.ts');
    assert.ok(impact.directDependents.some((item) => item.path === 'src/app.ts'));
    assert.ok(impact.impacted.some((item) => item.path === 'src/app.test.ts' && item.test));
    assert.ok(impact.tests.includes('src/app.test.ts'));
    assert.equal(impact.risk, 'low');
    assert.ok(impact.ego.nodes.some((node) => node.path === 'src/app.ts'));

    const bySymbol = impactGraph(graph, 'login');
    assert.equal(bySymbol.found, true);
    assert.equal(bySymbol.target, 'src/lib/auth.ts');
    assert.equal(bySymbol.targetSymbol, 'login');

    const mermaid = graphToMermaid(graph, { target: 'src/lib/auth.ts' });
    assert.match(mermaid, /^flowchart LR/m);
    assert.match(mermaid, /src\/lib\/auth\.ts/);
  } finally {
    await cleanup();
  }
});

test('ambiguous symbol targets return candidates', async () => {
  const { project, cleanup } = await makeProject();
  try {
    await writeFile(project, 'src/a.ts', 'export function login() { return "a"; }\n');
    await writeFile(project, 'src/b.ts', 'export function login() { return "b"; }\n');
    const graph = await buildGraph(project);
    const impact = impactGraph(graph, 'login');
    assert.equal(impact.found, false);
    assert.equal(impact.ambiguous, true);
    assert.ok(impact.candidates.some((candidate) => candidate.path === 'src/a.ts'));
    assert.ok(impact.candidates.some((candidate) => candidate.path === 'src/b.ts'));
  } finally {
    await cleanup();
  }
});

test('graph cache is written and readable', async () => {
  const { project, cleanup } = await makeProject();
  try {
    await seedGraph(project);
    const graph = await buildGraph(project);
    const file = await writeGraphCache(project, graph);
    assert.match(file, /\.vibeguard\/context\/graph\.json$/);
    const cached = await readGraphCache(project);
    assert.equal(cached.stats.files, graph.stats.files);
    assert.equal(cached.stats.edges, graph.stats.edges);
  } finally {
    await cleanup();
  }
});

test('context pack includes codegraph impact and dependent files', async () => {
  const { project, cleanup } = await makeProject();
  try {
    await seedGraph(project);
    const task = await addTask(project, {
      title: 'Change login behavior',
      acceptance: ['Login returns the expected value'],
      files: ['src/lib/auth.ts'],
      layer: 'backend',
      phase: '1'
    });
    const pack = await buildContextPack(project, task.id);
    assert.match(pack.markdown, /## Codegraph impact/);
    assert.match(pack.markdown, /src\/lib\/auth\.ts/);
    assert.match(pack.markdown, /src\/app\.ts/);
    assert.match(pack.markdown, /src\/app\.test\.ts/);
    assert.ok(pack.files.includes('src/lib/auth.ts'));
    assert.ok(pack.files.includes('src/app.ts'));
  } finally {
    await cleanup();
  }
});
