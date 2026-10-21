import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const VERSION = '0.1.0';
export const VG_DIR = '.vibeguard';

export const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx',
  '.css', '.scss', '.sass', '.less', '.html', '.htm', '.vue', '.svelte',
  '.astro', '.sql', '.py', '.go', '.rs', '.java', '.kt', '.kts', '.rb',
  '.php', '.cs', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.toml',
  '.yaml', '.yml', '.env', '.sh', '.bash', '.zsh', '.fish', '.xml', '.txt',
  '.graphql', '.gql', '.prisma', '.dockerfile', '.ini', '.conf'
]);

export const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', '.vibeguard', 'node_modules', 'dist', 'build',
  '.next', '.nuxt', '.svelte-kit', '.output', 'coverage', '.nyc_output',
  'vendor', 'target', '.venv', 'venv', 'env', '__pycache__', '.turbo',
  '.cache', '.parcel-cache', '.turbo-cache', 'tmp', 'temp', '.idea', '.DS_Store'
]);

export class VibeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'VibeError';
    this.code = options.code || 'EUSER';
    this.hint = options.hint || '';
    this.exitCode = options.exitCode ?? 1;
    this.details = options.details;
  }
}

export function vgPath(project, ...parts) {
  return path.join(project, VG_DIR, ...parts);
}

export function toPosix(value) {
  return String(value).split(path.sep).join('/');
}

export function nowIso() {
  return new Date().toISOString();
}

export function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeFileAtomic(file, contents) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, contents);
  await fs.rename(tmp, file);
}

export async function writeJson(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonFile(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new VibeError(`File tidak ditemukan: ${file}`);
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new VibeError(`JSON tidak valid di ${file}: ${error.message}`);
  }
}

export async function readJsonIfExists(file, fallback = null) {
  try {
    return await readJsonFile(file);
  } catch (error) {
    if (error instanceof VibeError && error.message.startsWith('File tidak ditemukan')) return fallback;
    throw error;
  }
}

export async function readTextFile(file, fallback = null) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function shortHash(text, length = 10) {
  return hashText(text).slice(0, length);
}

export function contractHash(spec, task) {
  return hashText(JSON.stringify({
    spec: String(spec ?? ''),
    task: {
      id: task?.id,
      title: task?.title,
      description: task?.description,
      acceptance: task?.acceptance,
      files: task?.files,
      dependsOn: task?.dependsOn,
      layer: task?.layer,
      phase: task?.phase
    }
  }));
}

export function truncate(text, maxLength = 12000) {
  const value = String(text ?? '');
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n\n... [truncated ${value.length - maxLength} chars]`;
}

export function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).find((line) => line.trim()) || '';
}

export function stripAnsi(text) {
  return String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '');
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function collectStream(stream, maxOutput) {
  return new Promise((resolve) => {
    let text = '';
    let truncated = false;
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      if (text.length >= maxOutput) {
        truncated = true;
        return;
      }
      const remaining = maxOutput - text.length;
      if (chunk.length > remaining) {
        text += chunk.slice(0, remaining);
        truncated = true;
      } else {
        text += chunk;
      }
    });
    stream.on('end', () => resolve({ text, truncated }));
    stream.on('error', () => resolve({ text, truncated }));
  });
}

async function runSpawn(command, args, options = {}) {
  const {
    cwd,
    shell = false,
    timeoutMs = 300_000,
    maxOutput = 2_000_000,
    env = {}
  } = options;
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        shell,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env, VIBEGUARD: '1' }
      });
    } catch (error) {
      resolve({
        code: -1,
        signal: null,
        stdout: '',
        stderr: error.message,
        durationMs: Date.now() - started,
        timedOut: false,
        truncated: false
      });
      return;
    }

    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }
        }, timeoutMs)
      : null;

    const stdoutPromise = collectStream(child.stdout, maxOutput);
    const stderrPromise = collectStream(child.stderr, maxOutput);

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: -1,
        signal: null,
        stdout: '',
        stderr: error.message,
        durationMs: Date.now() - started,
        timedOut,
        truncated: false
      });
    });

    child.on('close', async (code, signal) => {
      if (timer) clearTimeout(timer);
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      resolve({
        code: code ?? -1,
        signal,
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs: Date.now() - started,
        timedOut,
        truncated: stdout.truncated || stderr.truncated
      });
    });
  });
}

export function runShell(command, options = {}) {
  return runSpawn(command, [], { ...options, shell: true });
}

export function runFile(file, args, options = {}) {
  return runSpawn(file, args, { ...options, shell: false });
}

export async function runGit(project, args, options = {}) {
  return runFile('git', ['-C', project, ...args], {
    timeoutMs: 30_000,
    maxOutput: 8_000_000,
    ...options,
    cwd: project
  });
}

export async function isGitRepo(project) {
  const result = await runGit(project, ['rev-parse', '--is-inside-work-tree']);
  return result.code === 0 && result.stdout.trim() === 'true';
}

export async function gitHead(project) {
  const result = await runGit(project, ['rev-parse', 'HEAD']);
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function gitChangedFiles(project) {
  if (!(await isGitRepo(project))) return [];
  const result = await runGit(project, ['status', '--porcelain=v1', '-z', '-uall']);
  if (result.code !== 0) return [];
  const parts = result.stdout.split('\0');
  const files = [];
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const rel = toPosix(record.slice(3));
    if (!rel || rel.startsWith(`${VG_DIR}/`) || rel === VG_DIR) continue;
    files.push({ status, path: rel });
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return files;
}

async function fingerprintFromFiles(project, options = {}) {
  const { excludedDirs = DEFAULT_EXCLUDED_DIRS, maxFiles = 5000, maxFileBytes = 512 * 1024 } = options;
  const files = await walkFiles(project, { excludedDirs, maxFiles, allExtensions: true });
  const hash = crypto.createHash('sha256');
  hash.update('vibeguard-tree-v1\0');
  for (const file of files.files) {
    hash.update(`F:${file.rel}\0${file.size}\0`);
    if (file.size <= maxFileBytes) {
      try {
        hash.update(await fs.readFile(file.abs));
      } catch {
        hash.update('unreadable');
      }
    } else {
      hash.update(`${file.mtimeMs}`);
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function workingTreeFingerprint(project) {
  if (!(await isGitRepo(project))) return fingerprintFromFiles(project);

  const tracked = await runGit(project, ['ls-files', '-z']);
  const untracked = await runGit(project, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (tracked.code !== 0 && untracked.code !== 0) return fingerprintFromFiles(project);

  const relFiles = [...new Set([
    ...(tracked.code === 0 ? tracked.stdout.split('\0') : []),
    ...(untracked.code === 0 ? untracked.stdout.split('\0') : [])
  ].filter(Boolean).map(toPosix))]
    .filter((rel) => rel !== VG_DIR && !rel.startsWith(`${VG_DIR}/`))
    .sort();

  const hash = crypto.createHash('sha256');
  hash.update('vibeguard-git-content-v1\0');
  let processed = 0;
  for (const rel of relFiles) {
    if (processed >= 5000) break;
    processed += 1;
    const abs = path.join(project, rel);
    try {
      const stat = await fs.lstat(abs);
      if (stat.isSymbolicLink()) {
        hash.update(`L:${rel}\0${await fs.readlink(abs)}\0`);
        continue;
      }
      hash.update(`F:${rel}\0${stat.size}\0`);
      if (stat.size <= 1024 * 1024) hash.update(await fs.readFile(abs));
      else hash.update(String(stat.mtimeMs));
    } catch {
      hash.update(`M:${rel}\0missing\0`);
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function walkFiles(project, options = {}) {
  const {
    excludedDirs = DEFAULT_EXCLUDED_DIRS,
    excludedGlobs = [],
    extensions = null,
    maxFiles = 5000,
    maxSize = 1024 * 1024,
    allExtensions = false
  } = options;
  const files = [];
  let truncated = false;

  async function visit(dir, relDir) {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (excludedDirs.has(entry.name)) continue;
        if (excludedGlobs.some((glob) => matchGlob(`${rel}/`, glob))) continue;
        await visit(path.join(dir, entry.name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (excludedGlobs.some((glob) => matchGlob(rel, glob))) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const isNamedTextFile = entry.name === 'Dockerfile' || entry.name === 'Makefile';
      if (!allExtensions) {
        const allowed = extensions || TEXT_EXTENSIONS;
        if (!allowed.has(ext) && !isNamedTextFile) continue;
      }
      const abs = path.join(dir, entry.name);
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (stat.size > maxSize) continue;
      if (excludedGlobs.some((glob) => matchGlob(rel, glob))) continue;
      files.push({ abs, rel, size: stat.size, mtimeMs: stat.mtimeMs, ext });
    }
  }

  await visit(project, '');
  return { files, truncated };
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegex(glob) {
  let source = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      const end = glob.indexOf('}', index + 1);
      if (end > index) {
        const choices = glob.slice(index + 1, end).split(',').map((part) => escapeRegExp(part));
        source += `(?:${choices.join('|')})`;
        index = end;
      } else {
        source += '\\{';
      }
    } else {
      source += escapeRegExp(char);
    }
  }
  source += '$';
  return new RegExp(source);
}

export function matchGlob(relPath, pattern) {
  const value = toPosix(relPath).replace(/^\.\//, '');
  let glob = toPosix(String(pattern ?? '')).trim().replace(/^\.\//, '').replace(/^\//, '');
  if (!glob) return false;
  if (glob.endsWith('/')) glob += '**';
  const hasGlob = /[*?{]/.test(glob);
  const looksLikeFile = /\.[A-Za-z0-9]+$/.test(glob) || hasGlob;
  const candidates = new Set([glob]);
  if (!glob.includes('/') && hasGlob) candidates.add(`**/${glob}`);
  if (!glob.includes('/') && !looksLikeFile) {
    candidates.add(`${glob}/**`);
    candidates.add(`**/${glob}/**`);
  }
  for (const candidate of candidates) {
    try {
      if (globToRegex(candidate).test(value)) return true;
    } catch {
      /* ignore malformed glob */
    }
  }
  return false;
}

export function ensureInside(project, candidate) {
  const resolved = path.resolve(project, candidate);
  const root = path.resolve(project);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new VibeError(`Path keluar dari project: ${candidate}`);
  }
  return resolved;
}

export async function readFileHead(file, bytes = 4096) {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

export function splitList(value) {
  if (Array.isArray(value)) return value.flatMap(splitList);
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

export function openSyncExists(file) {
  try {
    fssync.accessSync(file);
    return true;
  } catch {
    return false;
  }
}
