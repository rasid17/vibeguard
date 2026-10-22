import path from 'node:path';
import {
  DEFAULT_EXCLUDED_DIRS,
  VibeError,
  ensureDir,
  fileExists,
  formatBytes,
  matchGlob,
  readFileHead,
  readTextFile as readText,
  truncate,
  vgPath,
  walkFiles,
  writeFileAtomic
} from './util.js';
import { loadConfig, loadSpec, loadTask, loadTasksFile, normalizeTask } from './store.js';
import { checkSpec, parseSpec } from './spec.js';
import { graphFromIndex, impactGraph } from './codegraph.js';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'are', 'was', 'were', 'have', 'has',
  'will', 'should', 'must', 'can', 'could', 'would', 'your', 'you', 'our', 'their', 'they', 'them',
  'its', 'it', 'not', 'but', 'all', 'any', 'each', 'when', 'where', 'what', 'how', 'why', 'use',
  'used', 'using', 'make', 'makes', 'need', 'needs', 'add', 'adds', 'new', 'existing', 'also',
  'yang', 'dan', 'atau', 'untuk', 'dengan', 'dari', 'pada', 'akan', 'harus', 'bisa', 'tidak',
  'agar', 'serta', 'dalam', 'ini', 'itu', 'adalah', 'sebagai', 'oleh', 'sebuah', 'satu', 'perlu',
  'setiap', 'saat', 'setelah', 'sebelum', 'tanpa', 'hanya', 'juga', 'sudah', 'belum', 'lebih',
  'oleh', 'kepada', 'bagi', 'para', 'secara', 'bila', 'jika', 'maka', 'ada', 'buat', 'membuat',
  'supaya', 'dapat', 'masih', 'saja', 'telah', 'seperti', 'antara', 'sesuai', 'terhadap'
]);

const DEFAULT_CONTEXT_EXCLUDES = [
  '.env', '.env.*', '**/.env', '**/.env.*',
  '*.pem', '*.key', '*.p12', '*.pfx',
  '**/secrets/**', '**/.secrets/**',
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  '**/*.min.js', '**/*.map', '**/*.snap'
];

export function tokenize(text) {
  const tokens = String(text ?? '')
    .toLowerCase()
    .replace(/[`~!@#$%^&*()+=[\]{};:'",<>/?\\|]/g, ' ')
    .replace(/[._-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && token.length <= 40 && !STOPWORDS.has(token));
  return [...new Set(tokens)].slice(0, 30);
}

function extractImports(content, ext) {
  const imports = new Set();
  const add = (value) => { if (value) imports.add(value.trim()); };
  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro'].includes(ext)) {
    const patterns = [
      /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) add(match[1]);
    }
  } else if (ext === '.py') {
    const patterns = [/^\s*from\s+([A-Za-z0-9_.]+)\s+import\b/gm, /^\s*import\s+([A-Za-z0-9_.]+)/gm];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) add(match[1]);
    }
  } else if (ext === '.go') {
    const single = /^\s*import\s+"([^"]+)"/gm;
    const block = /^\s*import\s*\(([\s\S]*?)\)/gm;
    let match;
    while ((match = single.exec(content)) !== null) add(match[1]);
    while ((match = block.exec(content)) !== null) {
      for (const line of match[1].split('\n')) {
        const quoted = line.match(/"([^"]+)"/);
        if (quoted) add(quoted[1]);
      }
    }
  }
  return [...imports].slice(0, 24);
}

function extractSymbols(content, ext) {
  const symbols = new Set();
  const add = (value) => {
    const symbol = String(value || '').trim();
    if (symbol && symbol.length <= 80) symbols.add(symbol);
  };
  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte'].includes(ext)) {
    const patterns = [
      /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/g,
      /\bexport\s*\{([^}]+)\}/g,
      /\b(?:function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/g,
      /\b(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g
    ];
    let match;
    while ((match = patterns[0].exec(content)) !== null) add(match[1]);
    while ((match = patterns[1].exec(content)) !== null) {
      for (const part of match[1].split(',')) {
        add(part.split(/\s+as\s+/).pop().trim());
      }
    }
    while ((match = patterns[2].exec(content)) !== null) add(match[1]);
    while ((match = patterns[3].exec(content)) !== null) add(`route:${match[1].toUpperCase()} ${match[2]}`);
  } else if (ext === '.py') {
    const pattern = /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)|^\s*class\s+([A-Za-z0-9_]+)/gm;
    let match;
    while ((match = pattern.exec(content)) !== null) add(match[1] || match[2]);
  } else if (ext === '.go') {
    const pattern = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)|^\s*type\s+([A-Za-z0-9_]+)/gm;
    let match;
    while ((match = pattern.exec(content)) !== null) add(match[1] || match[2]);
  } else if (ext === '.sql') {
    const pattern = /CREATE\s+(?:TABLE|VIEW|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z0-9_.]+)/gi;
    let match;
    while ((match = pattern.exec(content)) !== null) add(match[1]);
  } else if (ext === '.md' || ext === '.mdx') {
    const pattern = /^(#{1,4})\s+(.+)$/gm;
    let match;
    while ((match = pattern.exec(content)) !== null) add(match[2].trim());
  }
  return [...symbols].slice(0, 30);
}

function resolveImports(fromRel, imports, byRel) {
  const resolved = new Set();
  const directory = path.posix.dirname(fromRel);
  const candidates = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.py', '.go'];
  for (const spec of imports) {
    if (!spec.startsWith('.')) continue;
    const base = path.posix.normalize(path.posix.join(directory, spec));
    const possible = [base];
    if (!path.posix.extname(base)) {
      for (const ext of candidates) possible.push(`${base}${ext}`);
      for (const ext of candidates) possible.push(`${base}/index${ext}`);
    }
    for (const candidate of possible) {
      if (byRel.has(candidate)) {
        resolved.add(candidate);
        break;
      }
    }
  }
  return [...resolved];
}

async function readHeadSafe(abs, bytes = 8192) {
  const content = await readFileHead(abs, bytes);
  if (content.includes('\u0000')) return null;
  return content;
}

export async function buildRepoIndex(project, config) {
  const contextConfig = config.context || {};
  const extraExcludes = Array.isArray(contextConfig.exclude) ? contextConfig.exclude : [];
  const excludedGlobs = [...DEFAULT_CONTEXT_EXCLUDES, ...extraExcludes];
  const walked = await walkFiles(project, {
    excludedDirs: DEFAULT_EXCLUDED_DIRS,
    excludedGlobs,
    maxFiles: contextConfig.maxFiles || 2000,
    maxSize: 512 * 1024
  });
  const files = [];
  const byRel = new Map();
  const batchSize = 40;
  for (let index = 0; index < walked.files.length; index += batchSize) {
    const batch = walked.files.slice(index, index + batchSize);
    const entries = await Promise.all(batch.map(async (file) => {
      const head = await readHeadSafe(file.abs);
      if (head === null) return null;
      const imports = extractImports(head, file.ext);
      const symbols = extractSymbols(head, file.ext);
      return {
        ...file,
        head,
        headLower: head.toLowerCase(),
        symbols,
        symbolsLower: symbols.join(' ').toLowerCase(),
        imports: [],
        rawImports: imports
      };
    }));
    for (const entry of entries) {
      if (!entry) continue;
      files.push(entry);
      byRel.set(entry.rel, entry);
    }
  }
  for (const file of files) {
    file.imports = resolveImports(file.rel, file.rawImports, byRel);
  }
  return { files, byRel, truncated: walked.truncated };
}

function baseScore(file) {
  let score = 0;
  if (['AGENTS.md', 'CLAUDE.md', 'README.md', 'agent.md'].includes(path.posix.basename(file.rel))) score += 35;
  if (['package.json', 'tsconfig.json', 'vite.config.ts', 'next.config.js', 'next.config.mjs', 'turbo.json'].includes(path.posix.basename(file.rel))) score += 20;
  if (/(^|\/)(docs|\.agents|\.cursor)\//.test(file.rel)) score += 8;
  if (/\.(test|spec)\.[^.]+$/.test(file.rel) || file.rel.includes('__tests__')) score -= 8;
  return score;
}

function scoreFile(file, keywords, task, explicitPatterns, topFiles) {
  let score = baseScore(file);
  const lowerRel = file.rel.toLowerCase();
  for (const keyword of keywords) {
    if (lowerRel.includes(keyword)) score += 18;
    if (file.symbolsLower.includes(keyword)) score += 16;
    if (file.headLower.includes(keyword)) score += Math.min(8, (file.headLower.split(keyword).length - 1) * 2);
    if (file.rawImports.some((item) => item.toLowerCase().includes(keyword))) score += 4;
  }
  for (const pattern of explicitPatterns) {
    if (matchGlob(file.rel, pattern)) {
      score += 500;
      if (file.size < 20_000) score += 50;
    }
  }
  if (explicitPatterns.length > 0) {
    const dirs = explicitPatterns
      .filter((pattern) => matchGlob(file.rel, pattern) || pattern.startsWith(path.posix.dirname(file.rel)))
      .map((pattern) => path.posix.dirname(pattern));
    if (dirs.some((dir) => dir !== '.' && file.rel.startsWith(`${dir}/`))) score += 12;
  }
  for (const top of topFiles) {
    if (top.rel === file.rel) continue;
    if (file.imports.includes(top.rel) || top.imports.includes(file.rel)) score += 22;
  }
  if (task.layer === 'frontend' && /\.(tsx|jsx|vue|svelte|css|scss|html)$/.test(file.rel)) score += 6;
  if (task.layer === 'backend' && /(^|\/)(api|server|services?|routes?|db|schema|migrations?)\//.test(file.rel)) score += 6;
  return score;
}

function specExcerpt(markdown, budget = 5000) {
  const parsed = parseSpec(markdown);
  if (parsed.sections.length === 0) return truncate(markdown, budget);
  const wanted = ['problem', 'goals', 'nonGoals', 'users', 'requirements', 'acceptance', 'tech'];
  const parts = [];
  for (const key of wanted) {
    const section = parsed.sections.find((item) => item.key === key);
    if (!section) continue;
    parts.push(`### ${section.heading}\n${truncate(section.content, 900)}`);
  }
  return truncate(parts.join('\n\n'), budget);
}

function graphTargetsForTask(graph, task, ranked) {
  const patterns = task.files || [];
  const codePaths = new Set(graph.files.map((file) => file.path));
  const targets = [];
  if (patterns.length > 0) {
    for (const file of graph.files) {
      if (patterns.some((pattern) => matchGlob(file.path, pattern))) targets.push(file.path);
    }
  } else {
    for (const entry of ranked) {
      if (!codePaths.has(entry.file.rel)) continue;
      targets.push(entry.file.rel);
      if (targets.length >= 3) break;
    }
  }
  return [...new Set(targets)].slice(0, 6);
}

function graphImpactForTask(graph, targets) {
  const impacts = [];
  const hints = new Map();
  const tests = new Set();
  let riskRank = 0;
  for (const target of targets) {
    const impact = impactGraph(graph, target, { depth: 2 });
    if (!impact.found) continue;
    impacts.push({ target, impact });
    for (const item of impact.impacted) {
      const boost = item.test ? 12 : item.depth === 1 ? 18 : 8;
      const current = hints.get(item.path);
      if (!current || boost > current.boost) {
        hints.set(item.path, {
          ...item,
          target,
          boost,
          role: item.test ? 'test' : item.depth === 1 ? 'dependent' : 'impacted'
        });
      }
    }
    for (const test of impact.tests) {
      tests.add(test);
      if (!hints.has(test)) {
        hints.set(test, { path: test, depth: 1, test: true, target, boost: 12, role: 'test' });
      }
    }
    if (impact.risk === 'high') riskRank = Math.max(riskRank, 3);
    else if (impact.risk === 'medium') riskRank = Math.max(riskRank, 2);
    else riskRank = Math.max(riskRank, 1);
  }
  const risk = riskRank === 3 ? 'high' : riskRank === 2 ? 'medium' : riskRank === 1 ? 'low' : 'none';
  return { impacts, hints, tests, risk };
}

function graphImpactSection(impacts) {
  if (impacts.length === 0) return '';
  const lines = ['## Codegraph impact'];
  for (const { target, impact } of impacts.slice(0, 6)) {
    lines.push(`### ${target}`);
    lines.push(`Risk: ${impact.risk} | Direct dependents: ${impact.directDependents.length} | Impacted: ${impact.totalImpacted} | Tests: ${impact.tests.length}`);
    if (impact.directDependents.length > 0) {
      lines.push('Direct dependents:');
      for (const item of impact.directDependents.slice(0, 8)) lines.push(`- ${item.path}${item.test ? ' (test)' : ''}`);
    } else {
      lines.push('Direct dependents: none');
    }
    if (impact.tests.length > 0) {
      lines.push('Tests touching target:');
      for (const test of impact.tests.slice(0, 8)) lines.push(`- ${test}`);
    } else {
      lines.push('Tests touching target: none');
    }
  }
  lines.push('Impact ini struktural (import graph), bukan jaminan runtime. Baca dependensi sebelum mengubah kontrak.');
  return `${lines.join('\n')}\n`;
}

function commandList(config) {
  const commands = config.verification?.commands || [];
  if (commands.length === 0) return '- (belum ada perintah verifikasi dikonfigurasi)';
  return commands.map((command) => `- ${command.name}: \`${command.command}\`${command.required === false ? ' (opsional)' : ''}`).join('\n');
}

export async function buildContextPack(project, taskId, options = {}) {
  const config = await loadConfig(project);
  const spec = await loadSpec(project);
  let task;
  if (taskId) {
    const loaded = await loadTask(project, taskId);
    task = normalizeTask(loaded.task);
  } else {
    const data = await loadTasksFile(project);
    task = data.tasks.map(normalizeTask).find((item) => item.status === 'in_progress')
      || data.tasks.map(normalizeTask).find((item) => item.status === 'pending');
    if (!task) throw new VibeError('Tidak ada task untuk dibuatkan context pack.');
  }

  const index = await buildRepoIndex(project, config);
  const keywords = tokenize([
    task.title,
    task.description,
    task.acceptance.join(' '),
    task.files.join(' '),
    task.layer
  ].join(' '));
  const explicitPatterns = task.files || [];
  let ranked = index.files
    .map((file) => ({ file, score: scoreFile(file, keywords, task, explicitPatterns, []) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.rel.localeCompare(b.file.rel));
  const topForGraph = ranked.slice(0, 8).map((entry) => entry.file);
  ranked = ranked
    .map((entry) => ({
      ...entry,
      score: scoreFile(entry.file, keywords, task, explicitPatterns, topForGraph)
    }))
    .sort((a, b) => b.score - a.score || a.file.rel.localeCompare(b.file.rel));

  const graph = graphFromIndex(index);
  const graphTargets = graphTargetsForTask(graph, task, ranked);
  const graphImpact = graphImpactForTask(graph, graphTargets);
  if (graphImpact.hints.size > 0) {
    const byRel = new Map(ranked.map((entry) => [entry.file.rel, entry]));
    for (const hint of graphImpact.hints.values()) {
      const entry = byRel.get(hint.path);
      if (entry) {
        entry.score += hint.boost;
      } else if (index.byRel.has(hint.path)) {
        ranked.push({ file: index.byRel.get(hint.path), score: hint.boost + 4, graph: hint });
      }
    }
    ranked = ranked.sort((a, b) => b.score - a.score || a.file.rel.localeCompare(b.file.rel));
  }

  const maxChars = Number(options.maxChars) || Number(config.context?.maxChars) || 24_000;
  const parts = [];
  let used = 0;
  const add = (text) => {
    if (used + text.length > maxChars) return false;
    parts.push(text);
    used += text.length;
    return true;
  };

  const specCheck = checkSpec(spec);
  add(`# VibeGuard Context Pack

Project: ${config.projectName || path.basename(project)}
Task: ${task.id} — ${task.title}
Layer: ${task.layer} | Phase: ${task.phase} | Status: ${task.status}

## Aturan kerja
- Implementasikan HANYA task ini. Jangan menyentuh task lain.
- Baca file relevan di bawah sebelum mengubah apa pun.
- Mulai task lewat \`start_task\` sebelum menulis kode.
- Jalankan \`verify_task\` setelah selesai. Jangan mengklaim selesai jika verifikasi gagal.
- File yang berubah harus berada dalam scope: ${task.files.length ? task.files.join(', ') : '(belum dibatasi)'}.
- Jangan mengubah spec atau task untuk membuat verifikasi lulus.

## Acceptance criteria
${task.acceptance.map((item) => `- [ ] ${item}`).join('\n') || '- (tidak ada)'}

## Spec
${specCheck.ok ? '' : `PERINGATAN: spec belum valid (${specCheck.missing.map((item) => item.label).join(', ') || 'placeholder/empty'}). Jangan implementasi sebelum diperbaiki.\n\n`}${specExcerpt(spec, 5000)}

## Verification commands
${commandList(config)}

${graphImpactSection(graphImpact.impacts)}

## Conventions
`);

  const conventions = [];
  const conventionFiles = new Set();
  for (const name of ['AGENTS.md', 'README.md', 'agent.md']) {
    const file = path.join(project, name);
    if (await fileExists(file)) {
      const content = await readText(file, '');
      if (content) {
        conventions.push(`### ${name}\n${truncate(content, 2500)}`);
        conventionFiles.add(name);
      }
    }
    if (conventions.length >= 2) break;
  }
  add(conventions.length ? `${conventions.join('\n\n')}\n` : '(Tidak ada AGENTS.md/README.md. Ikuti pola kode yang ada.)\n');

  add('\n## Relevant files\n');
  const included = [];
  for (const entry of ranked) {
    if (conventionFiles.has(entry.file.rel)) continue;
    const remaining = maxChars - used;
    if (remaining < 600) break;
    const includeFull = entry.file.size <= 6000 && remaining > entry.file.size;
    let snippet;
    try {
      const raw = await readText(entry.file.abs, '');
      snippet = `### ${entry.file.rel}\nSize: ${formatBytes(entry.file.size)} | Symbols: ${entry.file.symbols.length ? entry.file.symbols.slice(0, 12).join(', ') : '-'}${entry.file.imports.length ? `\nImports: ${entry.file.imports.slice(0, 10).join(', ')}` : ''}\n\n\`\`\`${entry.file.ext.replace(/^\./, '') || 'text'}\n${truncate(raw, includeFull ? 6000 : 3000)}\n\`\`\`\n`;
    } catch {
      continue;
    }
    if (!add(`\n${snippet}`)) break;
    included.push(entry.file.rel);
  }

  if (included.length === 0) add('(Tidak ada file yang cocok dengan kata kunci task. Baca struktur repo terlebih dahulu.)\n');
  const notIncluded = ranked.filter((entry) => !included.includes(entry.file.rel)).slice(0, 20).map((entry) => entry.file.rel);
  if (notIncluded.length > 0) {
    add(`\n## File lain yang mungkin relevan\n${notIncluded.map((rel) => `- ${rel}`).join('\n')}\n`);
  }
  add(`\n## Index stats\n- Files indexed: ${index.files.length}${index.truncated ? ' (truncated)' : ''}\n- Keywords: ${keywords.join(', ') || '-'}\n- Context budget: ${maxChars} chars; used: ${used} chars\n`);

  const markdown = parts.join('');
  const outputFile = vgPath(project, 'context', `${task.id}.md`);
  await ensureDir(path.dirname(outputFile));
  await writeFileAtomic(outputFile, markdown);
  return { markdown, task, files: included, keywords, outputFile, used, maxChars, specCheck };
}
