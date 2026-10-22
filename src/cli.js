import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  VERSION,
  VibeError,
  fileExists,
  formatDuration,
  isGitRepo,
  nowIso,
  readStdin,
  readTextFile,
  timestampSlug,
  vgPath,
  writeFileAtomic
} from './util.js';
import {
  configForAgent,
  initProject,
  isInitialized,
  loadConfig,
  loadSpec,
  loadTasksFile,
  normalizeTask,
  saveSpec,
  taskCounts,
  taskSchedule
} from './store.js';
import { checkSpec, specTemplate } from './spec.js';
import {
  addTask,
  completeTask,
  failTask,
  getNextTask,
  listTasks,
  recordEvidence,
  startTask
} from './tasks.js';
import { summarizeVerificationResult, verifyTask } from './verify.js';
import { buildContextPack } from './context.js';
import {
  ensureAgentDocs,
  mcpConfigReport,
  writeMcpConfig
} from './agentdocs.js';
import { buildGraph, writeGraphCache } from './graph.js';
import { graphToMermaid, impactGraph, queryGraph } from './codegraph.js';

const HELP = `VibeGuard ${VERSION} — quality gate lokal untuk vibe coding

Usage:
  vibeguard <command> [options]

Perintah:
  init                  Inisialisasi .vibeguard, deteksi checks, siapkan AGENTS/MCP
  status                Ringkasan project, spec, task, dan verifikasi
  doctor                Diagnosa konfigurasi
  spec show             Tampilkan spec
  spec check            Validasi spec (exit 1 bila belum lengkap)
  spec edit             Buka spec di $EDITOR
  spec import <file>    Impor spec Markdown (backup spec lama)
  plan "<ide>"          Buat prompt perencanaan + brief untuk agent
  task add "<judul>"    Tambah task (wajib --criteria)
  task list             Daftar task
  task show <id>        Detail task
  task next             Task berikutnya + checkpoint
  task start <id>       Mulai task (--acknowledge untuk checkpoint)
  task verify <id>      Jalankan checks, slop scan, secret scan, scope guard
  task evidence <id> [A1] ["bukti"]  Lihat/catat bukti acceptance criterion
  task done <id>        Tandai selesai; wajib verifikasi + evidence lengkap
  task fail <id> "..."  Catat task gagal/blocked
  verify [id]           Alias task verify
  context [id]          Context pack untuk task
  graph stats           Statistik codegraph
  graph query <teks>    Cari file/simbol
  graph impact <target> Dampak perubahan file/simbol (reverse imports)
  graph build           Bangun dan cache codegraph
  graph export          Ekspor graph (json/mermaid)
  ui                    Dashboard lokal (default 127.0.0.1:4317)
  mcp                   Jalankan MCP server (stdio)
  agent-config          Cetak / tulis konfigurasi MCP
  version               Versi

Global:
  --project <dir>       Project root (default: cwd)
  --json                Output JSON
  --help                Bantuan

Contoh:
  vibeguard init
  vibeguard spec edit
  vibeguard task add "Login page" --criteria "Email+password valid" --criteria "Error state tampil" --layer frontend --files "src/app/login/**"
  vibeguard task next
  vibeguard task start T-001
  vibeguard task verify T-001
  vibeguard task done T-001
  vibeguard ui
`;

function extractGlobals(argv) {
  const rest = [];
  let project = process.cwd();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      project = argv[index + 1] || project;
      index += 1;
    } else if (arg.startsWith('--project=')) {
      project = arg.slice('--project='.length);
    } else if (arg === '--json') {
      json = true;
    } else {
      rest.push(arg);
    }
  }
  return { project: path.resolve(project), json, rest };
}

function out(text = '') {
  process.stdout.write(`${text}\n`);
}

function err(text = '') {
  process.stderr.write(`${text}\n`);
}

function jsonOut(value) {
  out(JSON.stringify(value, null, 2));
}

function statusLabel(status) {
  if (status === 'done') return '[x] done';
  if (status === 'in_progress') return '[>] in_progress';
  if (status === 'verifying') return '[~] verifying';
  if (status === 'failed') return '[!] failed';
  return '[ ] pending';
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : `${text}${' '.repeat(width - text.length)}`;
}

function verificationBadge(verification) {
  if (!verification) return '-';
  return verification.ok ? 'pass' : 'fail';
}

function printCheck(check) {
  if (check.ok) {
    out('[ok] Spec valid.');
  } else {
    out('[!] Spec belum valid.');
    for (const item of check.missing) out(`  missing: ${item.label}`);
    for (const item of check.empty) out(`  empty: ${item.label} (line ${item.line})`);
    for (const item of check.placeholders) out(`  line ${item.line}: ${item.reason} -> ${item.text}`);
  }
  for (const warning of check.warnings) out(`  warn: ${warning}`);
}

function printTask(task, { verbose = false } = {}) {
  out(`${task.id}  ${task.title}`);
  out(`  status: ${statusLabel(task.status)} | layer: ${task.layer} | phase: ${task.phase} | verify: ${verificationBadge(task.verification)}`);
  if (task.description) out(`  desc: ${task.description}`);
  if (task.acceptance.length) {
    out('  acceptance:');
    task.acceptance.forEach((item, index) => {
      const criterionId = `A${index + 1}`;
      const evidence = task.evidence?.[criterionId];
      out(`    [${criterionId}] ${item}  ${evidence?.note ? '[proven]' : '[unproven]'}`);
      if (evidence?.note) {
        out(`          ${evidence.type}: ${evidence.note}${evidence.ref ? ` (${evidence.ref})` : ''}`);
      }
    });
  }
  if (task.files.length) out(`  files: ${task.files.join(', ')}`);
  if (task.dependsOn.length) out(`  dependsOn: ${task.dependsOn.join(', ')}`);
  if (verbose && task.verification) {
    const v = task.verification;
    out(`  verification: ${v.ok ? 'PASS' : 'FAIL'} | run: ${v.runId} | at: ${v.finishedAt}`);
    if (v.summary?.failedCommands?.length) out(`  failed checks: ${v.summary.failedCommands.join(', ')}`);
    if (v.summary?.slopErrors) out(`  slop errors: ${v.summary.slopErrors}`);
    if (v.summary?.scopeViolations) out(`  scope violations: ${v.summary.scopeViolations}`);
  }
  if (verbose && task.notes.length) {
    out('  notes:');
    for (const note of task.notes.slice(-5)) out(`    - ${note.at}: ${note.text}`);
  }
}

function printCheckpoint(checkpoint) {
  if (!checkpoint?.needed) return;
  out('');
  out('[checkpoint] Berhenti sebelum task berikutnya.');
  out(`  ${checkpoint.reason}`);
  out(`  ${checkpoint.from.taskId} (${checkpoint.from.layer}, phase ${checkpoint.from.phase}) -> ${checkpoint.to.taskId} (${checkpoint.to.layer}, phase ${checkpoint.to.phase})`);
  out('  Uji hasil sebelumnya dulu. Setelah disetujui, jalankan dengan --acknowledge.');
}

function printNext(selection) {
  if (selection.task) {
    if (selection.resume) out('Melanjutkan task aktif:');
    printTask(selection.task);
    printCheckpoint(selection.checkpoint);
    return;
  }
  if (selection.blocked.length > 0) {
    out('[!] Tidak ada task yang siap; semua menunggu dependency:');
    for (const item of selection.blocked) {
      out(`  ${item.task.id} menunggu ${item.blockers.map((blocker) => blocker.id).join(', ') || 'dependency hilang'}`);
    }
    return;
  }
  if (selection.total === 0) {
    out('Belum ada task. Tambah dengan `vibeguard task add`.');
    return;
  }
  out('Semua task selesai.');
}

async function commandInit(project, args, globals) {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      'no-mcp': { type: 'boolean' },
      'no-agents': { type: 'boolean' },
      'mcp-target': { type: 'string' }
    }
  });
  const result = await initProject(project, { name: values.name });
  let docs = null;
  if (!values['no-agents']) docs = await ensureAgentDocs(project);

  let mcpFiles = [];
  if (!values['no-mcp']) {
    let targets = values['mcp-target']
      ? values['mcp-target'].split(',').map((item) => item.trim()).filter(Boolean)
      : ['claude'];
    if (!values['mcp-target'] && await fileExists(path.join(project, '.cursor'))) targets.push('cursor');
    mcpFiles = await writeMcpConfig(project, targets);
  }

  const config = await loadConfig(project);
  const spec = await loadSpec(project);
  const check = checkSpec(spec);
  const tasks = (await loadTasksFile(project)).tasks.map(normalizeTask);

  if (globals.json) {
    jsonOut({
      project,
      alreadyInitialized: result.alreadyInitialized,
      config: configForAgent(config),
      specCheck: check,
      tasks: tasks.length,
      agentDocs: docs,
      mcpFiles
    });
    return;
  }

  out(`VibeGuard ${result.alreadyInitialized ? 'sudah ada' : 'diinisialisasi'} di ${project}`);
  out(`  project: ${config.projectName}`);
  out(`  checks: ${config.verification.commands.length ? config.verification.commands.map((command) => command.name).join(', ') : '(belum ada; isi .vibeguard/config.json)'}`);
  if (config.verification.commands.length === 0) {
    out('  [warn] Tanpa checks, verifikasi akan selalu gagal. Tambahkan command nyata sebelum mulai task.');
  }
  out(`  spec: ${check.ok ? 'valid' : 'perlu dilengkapi (.vibeguard/spec.md)'}`);
  out(`  tasks: ${tasks.length}`);
  if (docs) {
    out(`  agent docs: AGENTS.md (${docs.agents.action}), CLAUDE.md (${docs.claude.action})`);
    out(`  protocol: ${path.relative(project, docs.protocolFile)}`);
  }
  if (mcpFiles.length) {
    out(`  MCP: ${mcpFiles.map((file) => path.relative(project, file)).join(', ')}`);
  } else {
    out('  MCP: belum ditulis (--no-mcp). Jalankan `vibeguard agent-config --write`.');
  }
  if (!check.ok) {
    out('');
    out('Langkah berikutnya: lengkapi spec, lalu tambah task dengan acceptance criteria.');
    out('  vibeguard spec edit');
    out('  vibeguard plan "ide aplikasi kamu"');
    out('  vibeguard ui');
  }
}

async function commandStatus(project, args, globals) {
  parseArgs({ args, allowPositionals: true, options: {} });
  const config = await loadConfig(project);
  const spec = await loadSpec(project);
  const check = checkSpec(spec);
  const tasks = (await loadTasksFile(project)).tasks.map(normalizeTask);
  const counts = taskCounts(tasks);
  const next = await getNextTask(project);
  const schedule = taskSchedule(tasks);

  if (globals.json) {
    jsonOut({
      project,
      config: configForAgent(config),
      spec: { ok: check.ok, title: check.title, missing: check.missing, warnings: check.warnings },
      counts,
      next: next.task ? { task: next.task, resume: next.resume, checkpoint: next.checkpoint } : { task: null, blocked: next.blocked },
      tasks: schedule
    });
    return;
  }

  out(`Project: ${config.projectName} (${project})`);
  const specIssues = check.missing.length + check.empty.length + check.placeholders.length;
  out(`Spec: ${check.ok ? 'valid' : `BELUM VALID (${specIssues} masalah; jalankan \`vibeguard spec check\`)`}`);
  out(`Tasks: ${counts.total} total | ${counts.done} done | ${counts.in_progress} active | ${counts.pending} pending | ${counts.failed} failed`);
  out(`Checks: ${config.verification.commands.length ? config.verification.commands.map((command) => command.name).join(', ') : 'belum dikonfigurasi'}`);
  out(`Strict scope: ${config.verification.strictScope ? 'ya' : 'tidak'}`);
  out('');
  printNext(next);
}

async function commandDoctor(project, args, globals) {
  parseArgs({ args, allowPositionals: true, options: {} });
  const checks = [];
  const add = (ok, label, hint = '') => checks.push({ ok, label, hint });
  add(Number(process.versions.node.split('.')[0]) >= 20, `Node ${process.versions.node}`, 'Butuh Node >= 20');
  const initialized = await isInitialized(project);
  add(initialized, 'Project VibeGuard terinisialisasi', 'Jalankan `vibeguard init`');
  let config = null;
  let specCheck = null;
  let tasks = [];
  if (initialized) {
    config = await loadConfig(project);
    specCheck = checkSpec(await loadSpec(project));
    tasks = (await loadTasksFile(project)).tasks.map(normalizeTask);
    add(specCheck.ok, 'Spec valid', 'Lengkapi .vibeguard/spec.md');
    add(config.verification.commands.length > 0, 'Perintah verifikasi tersedia', 'Tambahkan checks di .vibeguard/config.json');
    add(config.verification.requireVerification !== false, 'Verifikasi wajib untuk complete', 'Jangan matikan requireVerification');
    const git = await isGitRepo(project);
    add(git, 'Git repo (disarankan)', 'Tidak terdeteksi; strict scope membutuhkan git.');
    const mcpExists = await fileExists(path.join(project, '.mcp.json')) || await fileExists(path.join(project, '.cursor', 'mcp.json'));
    add(mcpExists, 'Konfigurasi MCP ada', 'Jalankan `vibeguard agent-config --write`');
    const missingDeps = tasks.flatMap((task) => task.dependsOn.filter((id) => !tasks.some((item) => item.id === id)).map((id) => `${task.id}->${id}`));
    add(missingDeps.length === 0, 'Dependency task konsisten', missingDeps.join(', '));
  }

  if (globals.json) {
    jsonOut({ project, checks, tasks: tasks.length, spec: specCheck });
    if (!initialized) process.exitCode = 1;
    return;
  }
  for (const check of checks) {
    out(`${check.ok ? '[ok]' : '[!]'} ${check.label}${check.hint && !check.ok ? ` — ${check.hint}` : ''}`);
  }
  if (!initialized) process.exitCode = 1;
}

async function commandSpec(project, args, globals) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      editor: { type: 'string' }
    }
  });
  const sub = positionals[0] || 'show';
  const specText = await loadSpec(project);

  if (sub === 'show') {
    const check = checkSpec(specText);
    if (globals.json) {
      jsonOut({ content: specText, check });
    } else {
      process.stdout.write(specText.endsWith('\n') ? specText : `${specText}\n`);
      if (!check.ok) {
        err('');
        printCheck(check);
      }
    }
    return;
  }

  if (sub === 'check') {
    const check = checkSpec(specText);
    if (globals.json) jsonOut(check);
    else printCheck(check);
    if (!check.ok) process.exitCode = 1;
    return;
  }

  if (sub === 'template') {
    process.stdout.write(specTemplate(path.basename(project)));
    return;
  }

  if (sub === 'edit') {
    const editor = values.editor || process.env.VISUAL || process.env.EDITOR || 'vi';
    const file = vgPath(project, 'spec.md');
    const quotedFile = '"' + file.replace(/(["\\$`])/g, '\\$1') + '"';
    const result = spawnSync(`${editor} ${quotedFile}`, { stdio: 'inherit', shell: true });
    if (result.status !== 0) {
      err(`Editor keluar dengan status ${result.status ?? result.signal ?? 'unknown'}.`);
      process.exitCode = 1;
      return;
    }
    printCheck(checkSpec(await loadSpec(project)));
    return;
  }

  if (sub === 'import') {
    const source = positionals[1];
    if (!source) throw new VibeError('Usage: vibeguard spec import <file>');
    const content = await readTextFile(path.resolve(source), null);
    if (content === null) throw new VibeError(`File tidak ditemukan: ${source}`);
    if (!content.trim()) throw new VibeError('File spec kosong.');
    const target = vgPath(project, 'spec.md');
    if (await fileExists(target)) {
      const backupDir = vgPath(project, 'backups');
      await fs.mkdir(backupDir, { recursive: true });
      await fs.copyFile(target, path.join(backupDir, `spec.${timestampSlug()}.bak`));
    }
    await saveSpec(project, content);
    const check = checkSpec(content);
    if (globals.json) jsonOut({ imported: source, check });
    else {
      out(`Spec diimpor dari ${source}.`);
      printCheck(check);
    }
    if (!check.ok) process.exitCode = 1;
    return;
  }

  throw new VibeError(`Subcommand spec tidak dikenal: ${sub}`, {
    hint: 'Gunakan: show, check, edit, import, template'
  });
}

async function commandPlan(project, args, globals) {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  let idea = positionals.join(' ').trim();
  if (!idea) {
    const stdin = await readStdin();
    idea = stdin.trim();
  }
  if (!idea) throw new VibeError('Tulis ide: vibeguard plan "aplikasi ..."');
  const config = await loadConfig(project);
  const check = checkSpec(await loadSpec(project));
  const brief = `# Planning brief

Project: ${config.projectName}
Created: ${nowIso()}

## Idea
${idea}

## Current spec status
${check.ok ? 'Spec sudah valid; perbarui hanya jika ide menambah/mengubah scope.' : `Spec belum valid. Missing: ${check.missing.map((item) => item.label).join(', ') || 'placeholder/empty'}.`}

## Instruksi untuk planning agent
1. Baca AGENTS.md, .vibeguard/agent-protocol.md, dan .vibeguard/spec.md.
2. Ubah .vibeguard/spec.md menjadi spec lengkap: problem, goals, non-goals, users, requirements, acceptance criteria, technical notes, risks, open questions. Hapus semua komentar template/TODO.
3. Pastikan acceptance criteria bisa diuji dan non-goals jelas.
4. Pecah pekerjaan menjadi task kecil. Setiap task wajib punya minimal satu acceptance criterion dan scope file yang masuk akal.
5. Urutkan frontend-first dengan mock data, baru backend; isi layer dan phase agar checkpoint antar-layer aktif.
6. Tambahkan task lewat MCP \`vibeguard_add_task\` (atau CLI). Jangan menulis kode produksi pada tahap ini.
7. Jalankan \`vibeguard spec check\` dan laporkan hasilnya ke manusia sebelum implementasi.
`;
  const file = vgPath(project, 'brief.md');
  await writeFileAtomic(file, brief);
  const prompt = `You are the planning agent for ${config.projectName} at ${project}.

Read AGENTS.md and .vibeguard/agent-protocol.md first. Then plan only; do not write production code yet.

Idea:
${idea}

Do this:
1. Fill .vibeguard/spec.md with: Problem, Goals, Non-goals, Users, Requirements, Acceptance criteria, Technical notes, Risks, Open questions. Remove all template comments and placeholders. Make acceptance criteria testable.
2. Run \`vibeguard spec check\` and fix any missing/empty sections.
3. Decompose the work into small, vertical-slice tasks with mandatory acceptance criteria and a file scope. Prefer frontend tasks with mock data first, then backend tasks. Set layer and phase for each task so checkpoints trigger between layers/phases.
4. Add each task using MCP tool \`vibeguard_add_task\` (fallback CLI: \`vibeguard task add\`). Do not create tasks without acceptance criteria.
5. Do not implement any task. Stop and ask the human to review the spec and task list.

The full brief is also saved at .vibeguard/brief.md.`;
  if (globals.json) {
    jsonOut({ briefFile: file, prompt, specCheck: check });
  } else {
    out(`Brief disimpan di ${path.relative(project, file)}.`);
    out('');
    out(prompt);
  }
}

async function commandTask(project, args, globals) {
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === 'add') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        title: { type: 'string' },
        desc: { type: 'string' },
        description: { type: 'string' },
        criteria: { type: 'string', multiple: true },
        files: { type: 'string', multiple: true },
        layer: { type: 'string' },
        phase: { type: 'string' },
        depends: { type: 'string', multiple: true },
        order: { type: 'string' }
      }
    });
    const title = values.title || positionals.join(' ').trim();
    if (!title) throw new VibeError('Judul task wajib diisi.');
    const task = await addTask(project, {
      title,
      description: values.description || values.desc,
      acceptance: values.criteria,
      files: values.files,
      layer: values.layer,
      phase: values.phase,
      dependsOn: values.depends,
      order: values.order ? Number(values.order) : undefined
    });
    if (globals.json) jsonOut(task);
    else {
      out(`Task dibuat: ${task.id}`);
      printTask(task);
    }
    return;
  }

  if (sub === 'list') {
    const tasks = await listTasks(project);
    if (globals.json) {
      jsonOut(tasks);
      return;
    }
    if (tasks.length === 0) {
      out('Belum ada task. Tambah dengan `vibeguard task add`.');
      return;
    }
    out(`${pad('ID', 8)} ${pad('STATUS', 15)} ${pad('LAYER', 10)} ${pad('PHASE', 6)} ${pad('VERIFY', 6)} ${pad('EVID', 7)} TITLE`);
    for (const task of tasks) {
      const proven = (task.criteria || []).filter((criterion) => criterion.proven).length;
      const total = (task.criteria || []).length;
      out(`${pad(task.id, 8)} ${pad(statusLabel(task.status), 15)} ${pad(task.layer, 10)} ${pad(task.phase, 6)} ${pad(verificationBadge(task.verification), 6)} ${pad(`${proven}/${total}`, 7)} ${task.title}${task.blockers.length ? ` (blocked by ${task.blockers.join(', ')})` : ''}`);
    }
    return;
  }

  if (sub === 'show') {
    const id = rest[0];
    if (!id) throw new VibeError('Usage: vibeguard task show <id>');
    const tasks = await listTasks(project);
    const task = tasks.find((item) => item.id.toLowerCase() === id.toLowerCase());
    if (!task) throw new VibeError(`Task tidak ditemukan: ${id}`);
    if (globals.json) jsonOut(task);
    else printTask(task, { verbose: true });
    return;
  }

  if (sub === 'next') {
    const next = await getNextTask(project);
    if (globals.json) jsonOut(next);
    else printNext(next);
    return;
  }

  if (sub === 'start') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { acknowledge: { type: 'boolean' } }
    });
    const id = positionals[0];
    if (!id) throw new VibeError('Usage: vibeguard task start <id> [--acknowledge]');
    try {
      const result = await startTask(project, id, { acknowledgeCheckpoint: Boolean(values.acknowledge) });
      if (globals.json) jsonOut(result);
      else {
        out(`${result.resumed ? 'Melanjutkan' : 'Memulai'} ${result.task.id}.`);
        printTask(result.task);
        if (result.checkpoint) {
          if (values.acknowledge) out(`Checkpoint disetujui: ${result.checkpoint.reason}`);
          else printCheckpoint(result.checkpoint);
        }
      }
    } catch (error) {
      if (error?.code === 'ECHECKPOINT' && error.details) {
        if (globals.json) jsonOut({ checkpoint: error.details, message: error.message });
        else {
          out(error.message);
          printCheckpoint(error.details);
          if (error.hint) err(`hint: ${error.hint}`);
        }
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    return;
  }

  if (sub === 'verify') {
    const id = rest[0];
    if (!id) throw new VibeError('Usage: vibeguard task verify <id>');
    await runVerification(project, id, globals);
    return;
  }

  if (sub === 'evidence') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        type: { type: 'string' },
        ref: { type: 'string' },
        note: { type: 'string' }
      }
    });
    const id = positionals[0];
    if (!id) throw new VibeError('Usage: vibeguard task evidence <id> [A1] ["bukti"]');
    const criterion = positionals[1];
    if (!criterion) {
      const tasks = await listTasks(project);
      const task = tasks.find((item) => item.id.toLowerCase() === id.toLowerCase());
      if (!task) throw new VibeError(`Task tidak ditemukan: ${id}`);
      if (globals.json) jsonOut({ task: task.id, criteria: task.criteria });
      else {
        out(`Evidence ${task.id}: ${task.criteria.filter((item) => item.proven).length}/${task.criteria.length} proven`);
        for (const item of task.criteria) {
          out(`  [${item.id}] ${item.proven ? 'proven' : 'unproven'} — ${item.text}`);
          if (item.evidence) out(`        ${item.evidence.type}: ${item.evidence.note}${item.evidence.ref ? ` (${item.evidence.ref})` : ''}`);
        }
      }
      return;
    }
    const note = values.note || positionals.slice(2).join(' ').trim();
    const result = await recordEvidence(project, id, {
      criterion,
      note,
      type: values.type,
      ref: values.ref
    });
    if (globals.json) jsonOut(result);
    else {
      out(`Bukti dicatat untuk ${result.criterion.id} (${result.task.id}).`);
      out(`  ${result.criterion.evidence.type}: ${result.criterion.evidence.note}`);
      const progress = result.task.evidenceProgress;
      out(`  Evidence: ${progress.proven}/${progress.total} criteria proven.`);
    }
    return;
  }

  if (sub === 'done') {
    const id = rest[0];
    if (!id) throw new VibeError('Usage: vibeguard task done <id>');
    const result = await completeTask(project, id);
    if (globals.json) jsonOut(result);
    else {
      out(`Task ${result.task.id} selesai.`);
      printNext(result.next);
    }
    return;
  }

  if (sub === 'fail') {
    const id = rest[0];
    const reason = rest.slice(1).join(' ').trim();
    if (!id) throw new VibeError('Usage: vibeguard task fail <id> "alasan"');
    const task = await failTask(project, id, reason);
    if (globals.json) jsonOut(task);
    else {
      out(`Task ${task.id} ditandai failed.`);
      if (task.notes.length) out(`  alasan: ${task.notes[task.notes.length - 1].text}`);
    }
    return;
  }

  throw new VibeError(`Subcommand task tidak dikenal: ${sub || '(kosong)'}`, {
    hint: 'Gunakan: add, list, show, next, start, verify, done, fail'
  });
}

async function runVerification(project, id, globals) {
  const result = await verifyTask(project, id, {
    onProgress: (event) => {
      if (globals.json) return;
      if (event.type === 'command-start') err(`[${event.index + 1}/${event.total}] ${event.name}: ${event.command}`);
      if (event.type === 'command-end') {
        const entry = event.result;
        err(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name} (${formatDuration(entry.durationMs)})${entry.timedOut ? ' [timeout]' : ''}`);
      }
    }
  });
  if (globals.json) jsonOut(result);
  else {
    out('');
    out(summarizeVerificationResult(result.result));
    if (!result.result.ok) {
      out('');
      out('Perbaiki kegagalan lalu jalankan verify lagi. Jangan complete.');
      process.exitCode = 1;
    }
  }
}

async function commandVerify(project, args, globals) {
  let id = args[0];
  if (!id) {
    const next = await getNextTask(project);
    if (!next.task) throw new VibeError('Tidak ada task aktif untuk diverifikasi.');
    id = next.task.id;
    if (!next.task.status || next.task.status === 'pending') {
      throw new VibeError(`Task ${id} belum dimulai. Jalankan start dulu.`);
    }
  }
  await runVerification(project, id, globals);
}

function printGraphStats(stats) {
  out(`Codegraph: ${stats.files} files | ${stats.symbols} symbols | ${stats.edges} edges | ${stats.tests} tests`);
  const languages = Object.entries(stats.languages || {}).map(([lang, count]) => `${lang} ${count}`).join(', ');
  if (languages) out(`Languages: ${languages}`);
  if (stats.externalImports) out(`External imports: ${stats.externalImports}`);
  if (stats.topHubs?.length) {
    out('Top hubs (paling banyak di-import):');
    for (const hub of stats.topHubs.slice(0, 10)) {
      out(`  ${hub.path}  in:${hub.incoming} out:${hub.outgoing}${hub.test ? ' [test]' : ''}`);
    }
  }
}

async function commandGraph(project, args, globals) {
  const sub = args[0] || 'stats';
  const rest = args.slice(1);
  if (!['stats', 'build', 'query', 'impact', 'export'].includes(sub)) {
    throw new VibeError(`Subcommand graph tidak dikenal: ${sub}`, {
      hint: 'Gunakan: stats, build, query, impact, export'
    });
  }
  if (!globals.json) err('Membangun codegraph...');
  const graph = await buildGraph(project);

  if (sub === 'build') {
    const file = await writeGraphCache(project, graph);
    if (globals.json) {
      jsonOut({ file, stats: graph.stats });
    } else {
      out(`Codegraph disimpan di ${path.relative(project, file)}`);
      printGraphStats(graph.stats);
    }
    return;
  }

  if (sub === 'stats') {
    if (globals.json) jsonOut(graph.stats);
    else printGraphStats(graph.stats);
    return;
  }

  if (sub === 'query') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { limit: { type: 'string' } }
    });
    const query = positionals.join(' ').trim();
    if (!query) throw new VibeError('Usage: vibeguard graph query <teks> [--limit 20]');
    const result = queryGraph(graph, query, { limit: values.limit ? Number(values.limit) : undefined });
    if (globals.json) {
      jsonOut(result);
    } else {
      out(`${result.total} hasil untuk "${result.query}":`);
      for (const match of result.matches) {
        out(`  [${match.type}] ${match.path}${match.line ? `:${match.line}` : ''}${match.kind === 'test' ? ' [test]' : ''}  in:${match.incoming} out:${match.outgoing}${match.name !== path.basename(match.path) ? `  ${match.name}` : ''}`);
      }
      if (result.total === 0) out('Tidak ada node yang cocok.');
    }
    return;
  }

  if (sub === 'impact') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { depth: { type: 'string' } }
    });
    const target = positionals.join(' ').trim();
    if (!target) throw new VibeError('Usage: vibeguard graph impact <path|symbol> [--depth 2]');
    const impact = impactGraph(graph, target, { depth: values.depth ? Number(values.depth) : 2 });
    if (!impact.found) {
      if (globals.json) jsonOut(impact);
      else {
        out(impact.ambiguous ? 'Target ambigu; pilih salah satu:' : `Target tidak ditemukan: ${target}`);
        for (const candidate of impact.candidates) out(`  ${candidate.path}${candidate.test ? ' [test]' : ''}`);
      }
      process.exitCode = 1;
      return;
    }
    if (globals.json) {
      jsonOut(impact);
    } else {
      out(`Target: ${impact.target}${impact.targetSymbol ? ` (symbol: ${impact.targetSymbol})` : ''}`);
      out(`Risk: ${impact.risk} | Direct dependents: ${impact.directDependents.length} | Impacted: ${impact.totalImpacted}`);
      if (impact.symbols.length) out(`Symbols: ${impact.symbols.slice(0, 12).join(', ')}`);
      out('Direct dependents:');
      for (const item of impact.directDependents) out(`  ${item.path}${item.test ? ' [test]' : ''}`);
      if (impact.directDependents.length === 0) out('  (none)');
      out('Tests:');
      for (const test of impact.tests) out(`  ${test}`);
      if (impact.tests.length === 0) out('  (none)');
      if (impact.dependencies.length) {
        out('Direct imports:');
        for (const dep of impact.dependencies) out(`  ${dep.path}${dep.test ? ' [test]' : ''}`);
      }
      if (impact.notes.length) {
        out('Notes:');
        for (const note of impact.notes) out(`  ${note}`);
      }
    }
    return;
  }

  if (sub === 'export') {
    const { values } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        format: { type: 'string' },
        target: { type: 'string' },
        depth: { type: 'string' },
        out: { type: 'string' }
      }
    });
    const format = (values.format || 'json').toLowerCase();
    let output;
    if (format === 'json') output = `${JSON.stringify(graph, null, 2)}\n`;
    else if (format === 'mermaid') output = `${graphToMermaid(graph, { target: values.target, depth: values.depth ? Number(values.depth) : 2 })}\n`;
    else throw new VibeError(`Format graph tidak dikenal: ${format}`, { hint: 'Gunakan json atau mermaid.' });
    if (values.out) {
      const targetFile = path.resolve(values.out);
      await writeFileAtomic(targetFile, output);
      if (globals.json) jsonOut({ format, file: targetFile });
      else out(`Graph ${format} ditulis ke ${targetFile}`);
    } else {
      process.stdout.write(output);
    }
    return;
  }
}

async function commandContext(project, args, globals) {
  const id = args[0];
  const pack = await buildContextPack(project, id);
  if (globals.json) {
    jsonOut({
      task: pack.task,
      files: pack.files,
      keywords: pack.keywords,
      outputFile: pack.outputFile,
      markdown: pack.markdown
    });
  } else {
    err(`Context pack: ${path.relative(project, pack.outputFile)} (${pack.used}/${pack.maxChars} chars, ${pack.files.length} files)`);
    process.stdout.write(pack.markdown.endsWith('\n') ? pack.markdown : `${pack.markdown}\n`);
  }
}

async function commandUi(project, args) {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string' }
    }
  });
  const port = values.port ? Number(values.port) : 4317;
  const host = values.host || '127.0.0.1';
  const { createUiServer } = await import('./server.js');
  const server = await createUiServer(project, { port, host });
  out(`VibeGuard dashboard: ${server.url}`);
  out('Tekan Ctrl+C untuk berhenti. Dashboard hanya mendengarkan di localhost.');
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
}

async function commandMcp(project) {
  const { startMcpServer } = await import('./mcp.js');
  await startMcpServer(project);
}

async function commandAgentConfig(project, args, globals) {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      write: { type: 'boolean' },
      target: { type: 'string' }
    }
  });
  const targets = values.target ? values.target.split(',').map((item) => item.trim()).filter(Boolean) : ['claude'];
  if (values.write) {
    const files = await writeMcpConfig(project, targets);
    if (globals.json) jsonOut({ files });
    else {
      out('MCP config ditulis:');
      for (const file of files) out(`  ${path.relative(project, file)}`);
    }
    return;
  }
  const report = mcpConfigReport(project);
  if (globals.json) {
    jsonOut(report);
    return;
  }
  out('Claude Code / Cursor (.mcp.json):');
  out(report.claude);
  out('');
  out('Codex (.codex/config.toml):');
  out(report.codex);
  out('');
  out('Tulis otomatis: vibeguard agent-config --write --target claude,cursor');
}

export async function run(argv) {
  const globals = extractGlobals(argv);
  const [command, ...args] = globals.rest;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    out(HELP);
    return;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    out(`vibeguard ${VERSION}`);
    return;
  }

  const project = globals.project;
  const needsInit = !['init', 'help', 'version'].includes(command);
  if (needsInit) {
    if (!(await isInitialized(project))) {
      throw new VibeError(`Project belum diinisialisasi VibeGuard: ${project}`, {
        hint: 'Jalankan `vibeguard init` di root project.'
      });
    }
  }

  switch (command) {
    case 'init':
      await commandInit(project, args, globals);
      break;
    case 'status':
      await commandStatus(project, args, globals);
      break;
    case 'doctor':
      await commandDoctor(project, args, globals);
      break;
    case 'spec':
      await commandSpec(project, args, globals);
      break;
    case 'plan':
      await commandPlan(project, args, globals);
      break;
    case 'task':
      await commandTask(project, args, globals);
      break;
    case 'verify':
      await commandVerify(project, args, globals);
      break;
    case 'context':
      await commandContext(project, args, globals);
      break;
    case 'graph':
      await commandGraph(project, args, globals);
      break;
    case 'ui':
      await commandUi(project, args);
      break;
    case 'mcp':
      await commandMcp(project);
      break;
    case 'agent-config':
      await commandAgentConfig(project, args, globals);
      break;
    default:
      throw new VibeError(`Perintah tidak dikenal: ${command}`, { hint: 'Jalankan `vibeguard --help`' });
  }
}
