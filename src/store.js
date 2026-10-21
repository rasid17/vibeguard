import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_EXCLUDED_DIRS,
  VibeError,
  ensureDir,
  fileExists,
  nowIso,
  readJsonIfExists,
  readTextFile,
  vgPath,
  writeFileAtomic,
  writeJson
} from './util.js';
import { specTemplate } from './spec.js';

const APP_VERSION = 1;

export const DEFAULT_CONFIG = {
  version: APP_VERSION,
  projectName: null,
  createdAt: null,
  verification: {
    commands: [],
    requireVerification: true,
    strictScope: false,
    commandTimeoutMs: 300_000
  },
  context: {
    maxChars: 24_000,
    maxFiles: 2000,
    exclude: []
  },
  slop: {
    enabled: true,
    includeExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.html', '.css', '.scss'],
    ignore: [
      '**/*.test.*',
      '**/*.spec.*',
      '**/__tests__/**',
      '**/fixtures/**',
      '**/mocks/**',
      '**/*.md',
      '**/docs/**'
    ],
    errors: [
      'lorem ipsum',
      'john doe',
      'jane doe',
      'placeholder text',
      'under construction',
      'coming soon'
    ],
    warnings: ['TODO', 'FIXME', 'HACK']
  }
};

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base;
  if (!base || typeof base !== 'object') return override ?? base;
  if (!override || typeof override !== 'object') return base;
  const output = { ...base };
  for (const [key, value] of Object.entries(override)) {
    output[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return output;
}

export function projectPaths(project) {
  return {
    project,
    dir: vgPath(project),
    config: vgPath(project, 'config.json'),
    spec: vgPath(project, 'spec.md'),
    tasks: vgPath(project, 'tasks.json'),
    runs: vgPath(project, 'runs'),
    context: vgPath(project, 'context'),
    protocol: vgPath(project, 'agent-protocol.md')
  };
}

export async function isInitialized(project) {
  return fileExists(vgPath(project, 'config.json'));
}

export async function loadConfig(project) {
  const file = vgPath(project, 'config.json');
  const raw = await readJsonIfExists(file, null);
  if (!raw) {
    throw new VibeError('Project belum diinisialisasi VibeGuard.', {
      hint: `Jalankan \`vibeguard init\` di ${project}`
    });
  }
  return deepMerge(DEFAULT_CONFIG, raw);
}

export async function saveConfig(project, config) {
  await writeJson(vgPath(project, 'config.json'), config);
}

export async function loadTasksFile(project) {
  const file = vgPath(project, 'tasks.json');
  const raw = await readJsonIfExists(file, null);
  if (!raw) return { version: 1, nextId: 1, tasks: [] };
  if (!Array.isArray(raw.tasks)) raw.tasks = [];
  raw.tasks = raw.tasks
    .filter((task) => task && typeof task === 'object' && task.id)
    .map(normalizeTask);
  if (!Number.isInteger(raw.nextId) || raw.nextId < 1) {
    const max = raw.tasks.reduce((acc, task) => {
      const number = Number(String(task.id || '').replace(/\D/g, ''));
      return Number.isFinite(number) ? Math.max(acc, number) : acc;
    }, 0);
    raw.nextId = max + 1;
  }
  return raw;
}

export async function saveTasksFile(project, data) {
  await writeJson(vgPath(project, 'tasks.json'), data);
}

export async function loadSpec(project) {
  return (await readTextFile(vgPath(project, 'spec.md'), '')) || '';
}

export async function saveSpec(project, content) {
  await writeFileAtomic(vgPath(project, 'spec.md'), String(content));
}

export async function loadTask(project, taskId) {
  const data = await loadTasksFile(project);
  const task = data.tasks.find((item) => item.id === taskId || item.id.toLowerCase() === String(taskId).toLowerCase());
  if (!task) throw new VibeError(`Task tidak ditemukan: ${taskId}`);
  return { data, task };
}

export async function saveTask(project, data, task) {
  const index = data.tasks.findIndex((item) => item.id === task.id);
  if (index === -1) throw new VibeError(`Task tidak ditemukan: ${task.id}`);
  task.updatedAt = nowIso();
  data.tasks[index] = task;
  await saveTasksFile(project, data);
}

function packageManagerFor(project, packageJson) {
  const declared = String(packageJson?.packageManager || '').split('@')[0];
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared;
  return null;
}

async function detectPackageManager(project, packageJson) {
  const declared = packageManagerFor(project, packageJson);
  if (declared) return declared;
  if (await fileExists(path.join(project, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await fileExists(path.join(project, 'bun.lock')) || await fileExists(path.join(project, 'bun.lockb'))) return 'bun';
  if (await fileExists(path.join(project, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function runCommandFor(packageManager, script) {
  if (packageManager === 'npm') return `npm run ${script}`;
  if (packageManager === 'pnpm') return `pnpm run ${script}`;
  if (packageManager === 'yarn') return `yarn run ${script}`;
  if (packageManager === 'bun') return `bun run ${script}`;
  return `npm run ${script}`;
}

export async function detectVerification(project) {
  const commands = [];
  const packageJsonPath = path.join(project, 'package.json');
  if (await fileExists(packageJsonPath)) {
    let packageJson = null;
    try {
      packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    } catch {
      packageJson = null;
    }
    const scripts = packageJson?.scripts || {};
    const packageManager = await detectPackageManager(project, packageJson);
    const scriptNames = ['typecheck', 'type-check', 'lint', 'test', 'build'];
    for (const name of scriptNames) {
      if (scripts[name]) {
        commands.push({
          name,
          command: runCommandFor(packageManager, name),
          required: true,
          timeoutMs: 300_000
        });
      }
    }
    if (commands.length === 0 && scripts.check) {
      commands.push({
        name: 'check',
        command: runCommandFor(packageManager, 'check'),
        required: true,
        timeoutMs: 300_000
      });
    }
  }

  if (await fileExists(path.join(project, 'Cargo.toml'))) {
    commands.push({ name: 'cargo-check', command: 'cargo check --quiet', required: true, timeoutMs: 300_000 });
    commands.push({ name: 'cargo-test', command: 'cargo test --quiet', required: true, timeoutMs: 300_000 });
  }
  if (await fileExists(path.join(project, 'go.mod'))) {
    commands.push({ name: 'go-test', command: 'go test ./...', required: true, timeoutMs: 300_000 });
  }
  const hasPythonTests = await fileExists(path.join(project, 'tests'))
    || await fileExists(path.join(project, 'test'))
    || await fileExists(path.join(project, 'pytest.ini'));
  if (hasPythonTests && (await fileExists(path.join(project, 'pyproject.toml')) || await fileExists(path.join(project, 'requirements.txt')))) {
    commands.push({ name: 'pytest', command: 'python -m pytest -q', required: true, timeoutMs: 300_000 });
  }

  const seen = new Set();
  return commands.filter((command) => {
    if (seen.has(command.name)) return false;
    seen.add(command.name);
    return true;
  });
}

function tasksTemplate() {
  return { version: 1, nextId: 1, tasks: [] };
}

export async function initProject(project, options = {}) {
  await ensureDir(project);
  const paths = projectPaths(project);
  await ensureDir(paths.dir);
  await ensureDir(paths.runs);
  await ensureDir(paths.context);

  const existing = await readJsonIfExists(paths.config, null);
  if (existing) {
    const config = deepMerge(DEFAULT_CONFIG, existing);
    const createdSpec = await writeFileAtomicIfMissing(paths.spec, specTemplate(config.projectName || path.basename(project)));
    const createdTasks = await writeJsonIfMissing(paths.tasks, tasksTemplate());
    await ensureDir(paths.runs);
    await ensureDir(paths.context);
    const ignoreFile = vgPath(project, '.gitignore');
    if (!(await fileExists(ignoreFile))) await writeFileAtomic(ignoreFile, 'runs/\ncontext/\nbackups/\n*.tmp\n');
    return { alreadyInitialized: true, config, createdSpec, createdTasks };
  }

  const projectName = options.name || path.basename(path.resolve(project));
  const commands = await detectVerification(project);
  const config = deepMerge(DEFAULT_CONFIG, {
    projectName,
    createdAt: nowIso(),
    verification: { commands }
  });

  await writeJson(paths.config, config);
  const createdSpec = await writeFileAtomicIfMissing(paths.spec, specTemplate(projectName));
  const createdTasks = await writeJsonIfMissing(paths.tasks, tasksTemplate());
  const ignoreFile = vgPath(project, '.gitignore');
  if (!(await fileExists(ignoreFile))) {
    await writeFileAtomic(ignoreFile, 'runs/\ncontext/\nbackups/\n*.tmp\n');
  }
  return { alreadyInitialized: false, config, createdSpec, createdTasks };
}

async function writeFileAtomicIfMissing(file, contents) {
  if (await fileExists(file)) return false;
  await writeFileAtomic(file, contents);
  return true;
}

async function writeJsonIfMissing(file, value) {
  if (await fileExists(file)) return false;
  await writeJson(file, value);
  return true;
}

export function normalizeTask(task) {
  const statuses = new Set(['pending', 'in_progress', 'verifying', 'done', 'failed']);
  return {
    id: task.id,
    title: task.title || 'Untitled task',
    description: task.description || '',
    acceptance: Array.isArray(task.acceptance) ? task.acceptance.filter(Boolean) : [],
    files: Array.isArray(task.files) ? task.files.filter(Boolean) : [],
    dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.filter(Boolean) : [],
    layer: task.layer || 'any',
    phase: String(task.phase ?? '1'),
    order: Number.isInteger(task.order) ? task.order : 0,
    status: statuses.has(task.status) ? task.status : 'pending',
    createdAt: task.createdAt || nowIso(),
    updatedAt: task.updatedAt || task.createdAt || nowIso(),
    startedAt: task.startedAt || null,
    completedAt: task.completedAt || null,
    failedAt: task.failedAt || null,
    attempts: Number.isInteger(task.attempts) ? task.attempts : 0,
    verification: task.verification || null,
    contract: task.contract || null,
    notes: Array.isArray(task.notes) ? task.notes : []
  };
}

export function taskCounts(tasks) {
  const counts = { total: tasks.length, pending: 0, in_progress: 0, verifying: 0, done: 0, failed: 0, blocked: 0 };
  for (const task of tasks) {
    if (counts[task.status] === undefined) counts[task.status] = 0;
    counts[task.status] += 1;
  }
  counts.open = counts.total - counts.done;
  return counts;
}

export function taskSchedule(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.map((task) => {
    const blockers = task.dependsOn.filter((id) => {
      const dependency = byId.get(id);
      return !dependency || dependency.status !== 'done';
    });
    const missing = task.dependsOn.filter((id) => !byId.has(id));
    return { ...task, blockers, missingDependencies: missing };
  });
}

export function configForAgent(config) {
  return {
    projectName: config.projectName,
    verification: config.verification,
    context: config.context,
    slop: config.slop
  };
}

export async function ensureInitialized(project) {
  if (!(await isInitialized(project))) {
    throw new VibeError('Project belum diinisialisasi VibeGuard.', {
      hint: `Jalankan \`vibeguard init\` di ${project}`
    });
  }
}

export function excludedDirsFor(config) {
  const set = new Set(DEFAULT_EXCLUDED_DIRS);
  return set;
}
