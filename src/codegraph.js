import path from 'node:path';
import { nowIso, toPosix } from './util.js';

export const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro',
  '.py', '.go', '.rs', '.sql', '.java', '.kt', '.kts', '.rb', '.php', '.cs',
  '.swift', '.c', '.h', '.cc', '.cpp', '.hpp'
]);

export function isTestFile(rel) {
  const value = toPosix(rel);
  return /(^|\/)(test|tests|__tests__|spec|specs)\//i.test(value)
    || /\.(test|spec)\.[^.]+$/i.test(value)
    || /(^|\/)test_[^/]+\.py$/i.test(value);
}

function symbolLine(file, symbol) {
  if (!file.head || symbol.startsWith('route:')) return null;
  const needle = String(symbol).trim();
  if (!needle) return null;
  const index = file.head.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return null;
  return file.head.slice(0, index).split('\n').length;
}

function addEdge(edges, seen, from, to, type, extra = {}) {
  const key = `${type}:${from}->${to}`;
  if (seen.has(key) || from === to) return;
  seen.add(key);
  edges.push({ from, to, type, ...extra });
}

export function graphFromIndex(index) {
  const nodes = [];
  const nodeById = new Map();
  const edges = [];
  const edgeSeen = new Set();
  const files = [];
  const codeFiles = index.files.filter((file) => CODE_EXTENSIONS.has(file.ext));
  const codePaths = new Set(codeFiles.map((file) => file.rel));

  const addNode = (node) => {
    if (nodeById.has(node.id)) return;
    nodes.push(node);
    nodeById.set(node.id, node);
  };

  for (const file of codeFiles) {
    addNode({
      id: `file:${file.rel}`,
      type: 'file',
      name: path.posix.basename(file.rel),
      path: file.rel,
      language: file.ext.replace(/^\./, ''),
      test: isTestFile(file.rel)
    });
    files.push({
      path: file.rel,
      language: file.ext.replace(/^\./, ''),
      test: isTestFile(file.rel),
      symbols: file.symbols.slice(0, 200),
      imports: file.imports.filter((rel) => codePaths.has(rel)),
      externalImports: [...new Set(file.rawImports.filter((spec) => !spec.startsWith('.') && !path.isAbsolute(spec)))].slice(0, 100)
    });
  }

  for (const file of codeFiles) {
    const fileId = `file:${file.rel}`;
    for (const symbol of file.symbols.slice(0, 200)) {
      const symbolId = `symbol:${file.rel}#${symbol}`;
      const kind = symbol.startsWith('route:') ? 'route' : 'symbol';
      addNode({
        id: symbolId,
        type: 'symbol',
        name: symbol,
        path: file.rel,
        line: symbolLine(file, symbol),
        kind
      });
      addEdge(edges, edgeSeen, fileId, symbolId, 'defines');
    }
    for (const imported of file.imports) {
      if (!codePaths.has(imported)) continue;
      addEdge(
        edges,
        edgeSeen,
        fileId,
        `file:${imported}`,
        'imports',
        { test: isTestFile(file.rel) }
      );
    }
  }

  const graph = {
    version: 1,
    generatedAt: nowIso(),
    nodes,
    edges,
    files
  };
  graph.stats = graphStats(graph);
  return graph;
}

function degrees(graph) {
  const map = new Map();
  const ensure = (id) => {
    if (!map.has(id)) map.set(id, { incoming: 0, outgoing: 0 });
    return map.get(id);
  };
  for (const node of graph.nodes) ensure(node.id);
  for (const edge of graph.edges) {
    ensure(edge.from).outgoing += 1;
    ensure(edge.to).incoming += 1;
  }
  return map;
}

export function graphStats(graph) {
  const nodeTypes = { file: 0, symbol: 0 };
  const languages = {};
  let tests = 0;
  for (const node of graph.nodes) {
    nodeTypes[node.type] = (nodeTypes[node.type] || 0) + 1;
    if (node.type === 'file' && node.test) tests += 1;
  }
  for (const file of graph.files) {
    languages[file.language] = (languages[file.language] || 0) + 1;
  }
  const degree = degrees(graph);
  const topHubs = graph.files
    .map((file) => {
      const value = degree.get(`file:${file.path}`) || { incoming: 0, outgoing: 0 };
      return { path: file.path, incoming: value.incoming, outgoing: value.outgoing, test: file.test };
    })
    .sort((a, b) => b.incoming - a.incoming || b.outgoing - a.outgoing || a.path.localeCompare(b.path))
    .slice(0, 12);
  const externalImports = graph.files.reduce((total, file) => total + file.externalImports.length, 0);
  return {
    files: nodeTypes.file || 0,
    symbols: nodeTypes.symbol || 0,
    edges: graph.edges.length,
    tests,
    externalImports,
    languages,
    topHubs,
    generatedAt: graph.generatedAt
  };
}

function nodeView(node, degree) {
  const value = degree.get(node.id) || { incoming: 0, outgoing: 0 };
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    path: node.path,
    line: node.line ?? null,
    kind: node.kind || (node.test ? 'test' : 'file'),
    test: Boolean(node.test),
    incoming: value.incoming,
    outgoing: value.outgoing
  };
}

export function queryGraph(graph, query, options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
  const q = String(query ?? '').trim().toLowerCase();
  const degree = degrees(graph);
  if (!q) {
    const matches = graph.nodes
      .filter((node) => node.type === 'file')
      .map((node) => nodeView(node, degree))
      .sort((a, b) => b.incoming - a.incoming || a.path.localeCompare(b.path))
      .slice(0, limit);
    return { query: '', total: matches.length, matches };
  }

  const scored = [];
  for (const node of graph.nodes) {
    const name = node.type === 'symbol' ? node.name : node.path;
    const nameLower = name.toLowerCase();
    const pathLower = node.type === 'symbol' ? node.path.toLowerCase() : nameLower;
    const basename = path.posix.basename(pathLower);
    let score = 0;
    if (nameLower === q) score = 120;
    else if (basename === q) score = 100;
    else if (nameLower.startsWith(q)) score = 80;
    else if (basename.startsWith(q)) score = 70;
    else if (nameLower.includes(q)) score = 50;
    else if (pathLower.includes(q)) score = 35;
    if (!score) continue;
    scored.push({ ...nodeView(node, degree), score });
  }
  scored.sort((a, b) => b.score - a.score || b.incoming - a.incoming || a.path.localeCompare(b.path));
  return {
    query: q,
    total: scored.length,
    matches: scored.slice(0, limit).map(({ score, ...match }) => match)
  };
}

function resolveTarget(graph, target) {
  const raw = String(target ?? '').trim();
  if (!raw) return { found: false, ambiguous: false, candidates: [] };
  const normalized = toPosix(raw).replace(/^\.\//, '').replace(/^\/+/, '');
  const lower = normalized.toLowerCase();
  const candidates = new Map();
  for (const node of graph.nodes) {
    let matches = false;
    if (node.type === 'file') {
      const value = node.path.toLowerCase();
      matches = value === lower
        || path.posix.basename(value) === lower
        || value.endsWith(`/${lower}`);
    } else if (node.type === 'symbol') {
      matches = node.name.toLowerCase() === lower
        || node.id.toLowerCase() === lower;
    }
    if (!matches) continue;
    const key = node.path;
    if (!candidates.has(key)) {
      const file = graph.files.find((item) => item.path === node.path);
      candidates.set(key, {
        path: node.path,
        test: Boolean(file?.test),
        symbol: node.type === 'symbol' ? node.name : null
      });
    } else if (node.type === 'symbol') {
      candidates.get(key).symbol = candidates.get(key).symbol || node.name;
    }
  }
  const list = [...candidates.values()];
  if (list.length === 0) return { found: false, ambiguous: false, candidates: [] };
  if (list.length === 1) return { found: true, ambiguous: false, candidate: list[0], candidates: list };
  const exact = list.find((item) => item.path.toLowerCase() === lower);
  if (exact) return { found: true, ambiguous: false, candidate: exact, candidates: list };
  return { found: false, ambiguous: true, candidates: list.slice(0, 12) };
}

export function impactGraph(graph, target, options = {}) {
  const maxDepth = Math.max(1, Math.min(5, Number(options.depth) || 2));
  const maxNodes = Math.max(10, Math.min(500, Number(options.maxNodes) || 200));
  const resolution = resolveTarget(graph, target);
  if (!resolution.found) {
    return {
      found: false,
      ambiguous: resolution.ambiguous,
      target: String(target ?? ''),
      candidates: resolution.candidates,
      depth: maxDepth
    };
  }
  const targetFile = resolution.candidate.path;
  const reverse = new Map();
  for (const edge of graph.edges) {
    if (edge.type !== 'imports') continue;
    if (!reverse.has(edge.to)) reverse.set(edge.to, []);
    reverse.get(edge.to).push(edge);
  }
  const fileByPath = new Map(graph.files.map((file) => [file.path, file]));
  const impacted = new Map();
  const tests = new Set();
  const queue = [{ path: targetFile, depth: 0, via: null }];
  const visited = new Set([targetFile]);
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth >= maxDepth) continue;
    for (const edge of reverse.get(`file:${current.path}`) || []) {
      const importer = edge.from.slice('file:'.length);
      if (visited.has(importer)) continue;
      visited.add(importer);
      if (impacted.size >= maxNodes) {
        truncated = true;
        break;
      }
      const file = fileByPath.get(importer);
      const entry = {
        path: importer,
        depth: current.depth + 1,
        via: current.path,
        test: Boolean(file?.test),
        direct: current.depth === 0
      };
      impacted.set(importer, entry);
      if (entry.test) tests.add(importer);
      queue.push({ path: importer, depth: entry.depth, via: current.path });
    }
    if (truncated) break;
  }

  const directDependents = [...impacted.values()]
    .filter((entry) => entry.depth === 1)
    .sort((a, b) => a.path.localeCompare(b.path));
  const allImpacted = [...impacted.values()].sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  const dependencies = graph.edges
    .filter((edge) => edge.type === 'imports' && edge.from === `file:${targetFile}`)
    .map((edge) => {
      const dep = edge.to.slice('file:'.length);
      return { path: dep, test: Boolean(fileByPath.get(dep)?.test) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const targetInfo = fileByPath.get(targetFile);
  const risk = directDependents.length >= 8 || allImpacted.length >= 20
    ? 'high'
    : directDependents.length >= 3 || allImpacted.length >= 8
      ? 'medium'
      : 'low';
  const notes = [];
  if (tests.size === 0) notes.push('Tidak ada test file yang mengimpor target secara langsung/tidak langsung.');
  if (truncated) notes.push(`Impact dibatasi pada ${maxNodes} node.`);
  if (resolution.candidate.symbol) notes.push(`Target diresolusi dari simbol "${resolution.candidate.symbol}".`);

  const egoNodes = new Map();
  const egoEdges = [];
  egoNodes.set(targetFile, { id: targetFile, path: targetFile, role: 'target', test: Boolean(targetInfo?.test) });
  for (const dep of dependencies.slice(0, 8)) {
    if (!egoNodes.has(dep.path)) {
      egoNodes.set(dep.path, { id: dep.path, path: dep.path, role: 'dependency', test: dep.test });
    }
    egoEdges.push({ from: targetFile, to: dep.path, type: 'imports' });
  }
  for (const dependent of directDependents.slice(0, 12)) {
    if (!egoNodes.has(dependent.path)) {
      egoNodes.set(dependent.path, { id: dependent.path, path: dependent.path, role: dependent.test ? 'test' : 'dependent', test: dependent.test });
    }
    egoEdges.push({ from: dependent.path, to: targetFile, type: dependent.test ? 'test' : 'imports' });
  }

  return {
    found: true,
    ambiguous: false,
    target: targetFile,
    targetSymbol: resolution.candidate.symbol || null,
    depth: maxDepth,
    risk,
    notes,
    symbols: targetInfo?.symbols || [],
    tests: [...tests].sort(),
    dependencies,
    directDependents,
    impacted: allImpacted,
    totalImpacted: allImpacted.length,
    truncated,
    ego: { nodes: [...egoNodes.values()], edges: egoEdges }
  };
}

export function graphToMermaid(graph, options = {}) {
  const limit = Math.max(1, Math.min(200, Number(options.maxEdges) || 80));
  let files;
  let edges;
  if (options.target) {
    const impact = impactGraph(graph, options.target, { depth: options.depth });
    if (!impact.found) return `%% target not found or ambiguous: ${String(options.target)}`;
    const paths = new Set([impact.target, ...impact.dependencies.map((item) => item.path), ...impact.directDependents.map((item) => item.path)]);
    files = graph.files.filter((file) => paths.has(file.path));
    edges = graph.edges.filter((edge) => edge.type === 'imports' && paths.has(edge.from.slice('file:'.length)) && paths.has(edge.to.slice('file:'.length)));
  } else {
    const stats = graphStats(graph);
    const hubs = new Set(stats.topHubs.map((hub) => hub.path));
    files = graph.files.filter((file) => hubs.has(file.path)).slice(0, 40);
    const paths = new Set(files.map((file) => file.path));
    edges = graph.edges.filter((edge) => edge.type === 'imports' && paths.has(edge.from.slice('file:'.length)) && paths.has(edge.to.slice('file:'.length)));
  }
  const ids = new Map(files.map((file, index) => [file.path, `n${index}`]));
  const lines = ['flowchart LR'];
  for (const file of files) {
    const label = file.path.replace(/"/g, '\'');
    lines.push(`  ${ids.get(file.path)}["${label}"]`);
  }
  for (const edge of edges.slice(0, limit)) {
    const from = ids.get(edge.from.slice('file:'.length));
    const to = ids.get(edge.to.slice('file:'.length));
    if (from && to) lines.push(`  ${from} --> ${to}`);
  }
  return lines.join('\n');
}
