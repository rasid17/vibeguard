import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DEFAULT_EXCLUDED_DIRS,
  VibeError,
  contractHash,
  escapeRegExp,
  formatDuration,
  gitChangedFiles,
  matchGlob,
  nowIso,
  readJsonFile,
  readTextFile,
  runShell,
  stripAnsi,
  timestampSlug,
  truncate,
  vgPath,
  walkFiles,
  workingTreeFingerprint,
  writeFileAtomic,
  writeJson,
  ensureDir
} from './util.js';
import { loadConfig, loadSpec, loadTask } from './store.js';
import { checkSpec } from './spec.js';
import { beginVerification, recordVerification } from './tasks.js';

function matcherFor(pattern) {
  const value = String(pattern);
  if (value.length > 2 && value.startsWith('/')) {
    const lastSlash = value.lastIndexOf('/');
    if (lastSlash > 0) {
      try {
        return new RegExp(value.slice(1, lastSlash), value.slice(lastSlash + 1));
      } catch {
        /* fall through to literal */
      }
    }
  }
  return new RegExp(escapeRegExp(value), 'i');
}

function relativeLogPath(project, file) {
  return path.relative(project, file).split(path.sep).join('/');
}

async function candidateFiles(project, config, changedFiles) {
  const ignoreGlobs = config.slop?.ignore || [];
  if (changedFiles.length > 0) {
    return changedFiles
      .map((entry) => entry.path)
      .filter((rel) => !ignoreGlobs.some((glob) => matchGlob(rel, glob)))
      .filter((rel) => rel !== '.vibeguard' && !rel.startsWith('.vibeguard/'));
  }
  const extensions = new Set(config.slop?.includeExtensions || []);
  const walked = await walkFiles(project, {
    excludedDirs: DEFAULT_EXCLUDED_DIRS,
    excludedGlobs: ignoreGlobs,
    extensions: extensions.size > 0 ? extensions : null,
    maxFiles: config.context?.maxFiles || 2000,
    maxSize: 512 * 1024
  });
  return walked.files.map((file) => file.rel);
}

export async function scanSlop(project, config, changedFiles = []) {
  if (!config.slop?.enabled) {
    return { ok: true, errors: [], warnings: [], scannedFiles: 0, skipped: true };
  }
  const files = await candidateFiles(project, config, changedFiles);
  const errorMatchers = (config.slop.errors || []).map((pattern) => ({ pattern, matcher: matcherFor(pattern) }));
  const warningMatchers = (config.slop.warnings || []).map((pattern) => ({ pattern, matcher: matcherFor(pattern) }));
  const extensions = new Set(config.slop.includeExtensions || []);
  const errors = [];
  const warnings = [];
  let scannedFiles = 0;

  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (extensions.size > 0 && !extensions.has(ext)) continue;
    const abs = path.join(project, rel);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 512 * 1024) continue;
    let content;
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\u0000')) continue;
    scannedFiles += 1;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.length > 2000) continue;
      for (const item of errorMatchers) {
        item.matcher.lastIndex = 0;
        if (item.matcher.test(line)) {
          errors.push({ file: rel, line: index + 1, pattern: item.pattern, severity: 'error', excerpt: line.trim().slice(0, 180) });
        }
      }
      for (const item of warningMatchers) {
        item.matcher.lastIndex = 0;
        if (item.matcher.test(line)) {
          warnings.push({ file: rel, line: index + 1, pattern: item.pattern, severity: 'warning', excerpt: line.trim().slice(0, 180) });
        }
      }
      if (errors.length + warnings.length >= 200) break;
    }
    if (errors.length + warnings.length >= 200) break;
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    scannedFiles,
    skipped: false
  };
}

export async function checkScope(task, config, changedFiles = []) {
  const patterns = Array.isArray(task.files) ? task.files.filter(Boolean) : [];
  if (patterns.length === 0) {
    return { ok: true, checked: false, violations: [], patterns, changedFiles: changedFiles.map((item) => item.path) };
  }
  const changed = changedFiles
    .map((entry) => entry.path)
    .filter((rel) => rel !== '.vibeguard' && !rel.startsWith('.vibeguard/'));
  if (changed.length === 0) {
    return {
      ok: true,
      checked: false,
      violations: [],
      patterns,
      changedFiles: [],
      note: 'Tidak ada perubahan git yang terdeteksi; scope tidak dapat diverifikasi.'
    };
  }
  const violations = changed.filter((rel) => !patterns.some((pattern) => matchGlob(rel, pattern)));
  return {
    ok: violations.length === 0,
    checked: true,
    strict: Boolean(config.verification?.strictScope),
    violations,
    patterns,
    changedFiles: changed
  };
}

function commandLogName(command, index) {
  const base = String(command.name || `command-${index + 1}`)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || `command-${index + 1}`;
  return `${String(index + 1).padStart(2, '0')}-${base}.log`;
}

function combinedOutput(stdout, stderr) {
  const parts = [];
  if (stdout) parts.push(stdout.trimEnd());
  if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`);
  return stripAnsi(parts.join('\n\n'));
}

export async function verifyTask(project, taskId, options = {}) {
  if (!taskId) throw new VibeError('taskId wajib diisi untuk verifikasi.');
  const config = await loadConfig(project);
  const { task } = await loadTask(project, taskId);
  const spec = await loadSpec(project);
  const specCheck = checkSpec(spec);
  if (!specCheck.ok) {
    throw new VibeError('Spec belum valid; verifikasi tidak dijalankan.', {
      hint: 'Perbaiki .vibeguard/spec.md lalu jalankan verifikasi lagi.'
    });
  }
  const currentContract = contractHash(spec, task);
  if (task.contract && task.contract !== currentContract) {
    throw new VibeError('Spec atau kontrak task berubah sejak task dimulai.', {
      hint: 'Minta manusia meninjau perubahan, lalu start ulang task ini sebelum verifikasi.'
    });
  }
  const activeTask = await beginVerification(project, task.id);
  const runId = `${timestampSlug()}-${activeTask.id}-${crypto.randomBytes(3).toString('hex')}`;
  const runDir = vgPath(project, 'runs', runId);
  await ensureDir(runDir);
  await writeJson(path.join(runDir, 'task.json'), activeTask);

  const changedFiles = await gitChangedFiles(project);
  const startedAt = nowIso();
  const commandResults = [];
  const slop = await scanSlop(project, config, changedFiles);
  const scope = await checkScope(activeTask, config, changedFiles);
  const commands = Array.isArray(config.verification?.commands) ? config.verification.commands : [];

  options.onProgress?.({ type: 'scan', slop, scope });

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    const name = command.name || `command-${index + 1}`;
    const logName = commandLogName(command, index);
    const logPath = path.join(runDir, logName);
    options.onProgress?.({ type: 'command-start', name, command: command.command, index, total: commands.length });
    const timeoutMs = Number(command.timeoutMs) > 0
      ? Number(command.timeoutMs)
      : Number(config.verification?.commandTimeoutMs) || 300_000;
    const result = await runShell(command.command, {
      cwd: project,
      timeoutMs,
      maxOutput: 3_000_000,
      env: { CI: '1', ...(command.env || {}) }
    });
    const output = combinedOutput(result.stdout, result.stderr);
    const header = [
      `$ ${command.command}`,
      `timeout: ${timeoutMs}ms`,
      `exit: ${result.code}${result.signal ? ` signal=${result.signal}` : ''}${result.timedOut ? ' (TIMEOUT)' : ''}`,
      `duration: ${formatDuration(result.durationMs)}`,
      ''
    ].join('\n');
    await writeFileAtomic(logPath, `${header}\n${output}\n`);
    const entry = {
      name,
      command: command.command,
      required: command.required !== false,
      exitCode: result.code,
      signal: result.signal,
      ok: result.code === 0,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      log: relativeLogPath(project, logPath),
      outputTail: truncate(output, 4000)
    };
    commandResults.push(entry);
    options.onProgress?.({ type: 'command-end', result: entry, index, total: commands.length });
  }

  const requiredCommands = commandResults.filter((entry) => entry.required);
  const failedCommands = requiredCommands.filter((entry) => !entry.ok);
  const fingerprint = await workingTreeFingerprint(project);
  const finishedAt = nowIso();
  const noCommands = commands.length === 0;
  const ok = !noCommands
    && failedCommands.length === 0
    && slop.ok
    && specCheck.ok
    && (!config.verification?.strictScope || scope.ok);

  const result = {
    version: 1,
    taskId: activeTask.id,
    taskTitle: activeTask.title,
    runId,
    startedAt,
    finishedAt,
    ok,
    noCommands,
    fingerprint,
    commands: commandResults,
    failedCommands: failedCommands.map((entry) => entry.name),
    slop,
    scope,
    spec: {
      ok: specCheck.ok,
      missing: specCheck.missing,
      empty: specCheck.empty,
      placeholders: specCheck.placeholders,
      warnings: specCheck.warnings
    },
    changedFiles: changedFiles.map((entry) => ({ status: entry.status, path: entry.path })),
    project: config.projectName || path.basename(project)
  };
  await writeJson(path.join(runDir, 'result.json'), result);

  const verification = {
    ok,
    runId,
    finishedAt,
    fingerprint,
    contractHash: currentContract,
    summary: {
      commands: commandResults.length,
      failedCommands: failedCommands.map((entry) => entry.name),
      slopErrors: slop.errors.length,
      slopWarnings: slop.warnings.length,
      scopeViolations: scope.violations.length,
      specOk: specCheck.ok,
      strictScope: Boolean(config.verification?.strictScope)
    }
  };
  const updatedTask = await recordVerification(project, activeTask.id, verification);
  return { result, task: updatedTask, runDir };
}

export async function readRun(project, runId) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(runId)) || runId === '.' || runId === '..') throw new VibeError('runId tidak valid.');
  const file = vgPath(project, 'runs', runId, 'result.json');
  return readJsonFile(file);
}

export async function readRunLog(project, runId, logName) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(runId)) || runId === '.' || runId === '..') throw new VibeError('runId tidak valid.');
  if (!/^[A-Za-z0-9._-]+\.log$/.test(String(logName))) throw new VibeError('Nama log tidak valid.');
  const file = vgPath(project, 'runs', runId, logName);
  const content = await readTextFile(file, null);
  if (content === null) throw new VibeError(`Log tidak ditemukan: ${logName}`);
  return content;
}

export function verificationLabel(verification) {
  if (!verification) return 'belum diverifikasi';
  return verification.ok ? 'verifikasi lulus' : 'verifikasi gagal';
}

export function summarizeVerificationResult(result) {
  if (!result) return 'Tidak ada hasil verifikasi.';
  const lines = [];
  lines.push(result.ok ? 'VERIFIKASI LULUS' : 'VERIFIKASI GAGAL');
  if (result.noCommands) lines.push('Tidak ada perintah verifikasi yang dikonfigurasi.');
  if (result.spec && !result.spec.ok) {
    lines.push('Spec tidak valid: ' + [
      ...result.spec.missing.map((item) => `missing ${item.label}`),
      ...result.spec.empty.map((item) => `empty ${item.label}`),
      ...result.spec.placeholders.map((item) => `line ${item.line}: ${item.reason}`)
    ].join('; '));
  }
  for (const command of result.commands || []) {
    lines.push(`${command.ok ? 'PASS' : 'FAIL'} ${command.name}: ${command.command} (exit ${command.exitCode}, ${formatDuration(command.durationMs)})`);
  }
  if (!result.slop?.ok) {
    lines.push(`Slop errors: ${result.slop.errors.length}`);
    for (const finding of result.slop.errors.slice(0, 10)) {
      lines.push(`  ${finding.file}:${finding.line} [${finding.pattern}] ${finding.excerpt}`);
    }
  }
  if (result.scope?.violations?.length) {
    lines.push(`Scope violations: ${result.scope.violations.join(', ')}`);
  }
  if (result.slop?.warnings?.length) {
    lines.push(`Slop warnings: ${result.slop.warnings.length}`);
  }
  return lines.join('\n');
}
