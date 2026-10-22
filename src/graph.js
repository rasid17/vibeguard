import { buildRepoIndex } from './context.js';
import { loadConfig } from './store.js';
import { graphFromIndex } from './codegraph.js';
import { ensureDir, nowIso, readJsonIfExists, vgPath, writeJson } from './util.js';

export async function buildGraph(project, config = null) {
  const resolvedConfig = config || await loadConfig(project);
  const index = await buildRepoIndex(project, resolvedConfig);
  return graphFromIndex(index);
}

export function graphCachePath(project) {
  return vgPath(project, 'context', 'graph.json');
}

export async function writeGraphCache(project, graph) {
  const file = graphCachePath(project);
  await ensureDir(vgPath(project, 'context'));
  await writeJson(file, graph);
  return file;
}

export async function readGraphCache(project) {
  const graph = await readJsonIfExists(graphCachePath(project), null);
  if (!graph) return null;
  return {
    ...graph,
    cache: {
      readAt: nowIso(),
      generatedAt: graph.generatedAt || null
    }
  };
}
