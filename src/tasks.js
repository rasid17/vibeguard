import { VibeError, contractHash, nowIso, workingTreeFingerprint } from './util.js';
import {
  loadConfig,
  loadSpec,
  loadTask,
  loadTasksFile,
  normalizeTask,
  saveTask,
  saveTasksFile
} from './store.js';
import { checkSpec } from './spec.js';
import { containsSecretValue } from './secrets.js';

function toStringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

export function criteriaFor(task) {
  const evidence = task?.evidence && typeof task.evidence === 'object' ? task.evidence : {};
  return (task?.acceptance || []).map((text, index) => {
    const id = `A${index + 1}`;
    const entry = evidence[id];
    const proven = Boolean(entry && typeof entry.note === 'string' && entry.note.trim());
    return { id, text, proven, evidence: proven ? entry : null };
  });
}

export function evidenceProgress(task) {
  const criteria = criteriaFor(task);
  return {
    proven: criteria.filter((criterion) => criterion.proven).length,
    total: criteria.length
  };
}

function decorateTask(task) {
  return {
    ...task,
    criteria: criteriaFor(task),
    evidenceProgress: evidenceProgress(task)
  };
}

export function isReady(task, byId) {
  if (!['pending', 'failed', 'in_progress', 'verifying'].includes(task.status)) return false;
  return task.dependsOn.every((id) => byId.get(id)?.status === 'done');
}

export function blockersFor(task, byId) {
  return task.dependsOn.filter((id) => byId.get(id)?.status !== 'done');
}

export function lastCompletedTask(tasks) {
  return tasks
    .filter((task) => task.status === 'done' && task.completedAt)
    .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))[0] || null;
}

export function checkpointBetween(previous, next) {
  if (!previous || !next) return null;
  const layerChanged = String(previous.layer) !== String(next.layer);
  const phaseChanged = String(previous.phase) !== String(next.phase);
  if (!layerChanged && !phaseChanged) return null;
  return {
    needed: true,
    from: { taskId: previous.id, title: previous.title, layer: previous.layer, phase: previous.phase },
    to: { taskId: next.id, title: next.title, layer: next.layer, phase: next.phase },
    reason: layerChanged && phaseChanged
      ? `Layer berubah (${previous.layer} -> ${next.layer}) dan fase berubah (${previous.phase} -> ${next.phase}).`
      : layerChanged
        ? `Layer berubah (${previous.layer} -> ${next.layer}).`
        : `Fase berubah (${previous.phase} -> ${next.phase}).`,
    instruction: 'Berhenti. Minta manusia menguji hasil sebelumnya, lalu mulai task ini setelah disetujui.'
  };
}

export function nextSelection(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const active = tasks.find((task) => task.status === 'in_progress' || task.status === 'verifying');
  if (active) {
    return { task: active, resume: true, checkpoint: null, blocked: [], total: tasks.length };
  }
  const previous = lastCompletedTask(tasks);
  const ready = tasks
    .filter((task) => ['pending', 'failed'].includes(task.status) && task.dependsOn.every((id) => byId.get(id)?.status === 'done'))
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
  if (ready.length > 0) {
    const task = ready[0];
    return { task, resume: false, checkpoint: checkpointBetween(previous, task), blocked: [], total: tasks.length };
  }
  const blocked = tasks
    .filter((task) => ['pending', 'failed'].includes(task.status))
    .map((task) => ({
      task,
      blockers: blockersFor(task, byId).map((id) => ({ id, title: byId.get(id)?.title || 'missing' }))
    }));
  return { task: null, resume: false, checkpoint: null, blocked, total: tasks.length };
}

export async function getNextTask(project) {
  const data = await loadTasksFile(project);
  const tasks = data.tasks.map(normalizeTask);
  const selection = nextSelection(tasks);
  if (selection.task) selection.task = decorateTask(selection.task);
  return selection;
}

export async function listTasks(project) {
  const data = await loadTasksFile(project);
  const tasks = data.tasks.map(normalizeTask);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks
    .map((task) => decorateTask({
      ...task,
      blockers: blockersFor(task, byId),
      ready: task.status === 'pending' || task.status === 'failed' ? blockersFor(task, byId).length === 0 : false
    }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export async function addTask(project, input = {}) {
  const title = String(input.title ?? '').trim();
  if (title.length < 3) throw new VibeError('Judul task minimal 3 karakter.');
  if (title.length > 200) throw new VibeError('Judul task maksimal 200 karakter.');
  const acceptance = toStringList(input.acceptance ?? input.criteria ?? input.acceptanceCriteria);
  if (acceptance.length === 0) {
    throw new VibeError('Task harus punya minimal satu acceptance criterion.', {
      hint: 'Tanpa kriteria yang bisa diuji, task hanya menjadi instruksi vibe. Tambahkan --criteria.'
    });
  }
  const acceptanceTooLong = acceptance.find((item) => item.length > 500);
  if (acceptanceTooLong) throw new VibeError('Satu acceptance criterion maksimal 500 karakter.');

  const spec = await loadSpec(project);
  const specCheck = checkSpec(spec);
  if (!specCheck.ok) {
    throw new VibeError('Spec belum lengkap; task tidak boleh dibuat sebelum spec siap.', {
      hint: 'Lengkapi .vibeguard/spec.md lalu jalankan `vibeguard spec check`.'
    });
  }

  const data = await loadTasksFile(project);
  const tasks = data.tasks.map(normalizeTask);
  const existingIds = new Set(tasks.map((task) => task.id));
  const dependsOn = toStringList(input.dependsOn).flatMap((item) => item.split(',')).map((id) => id.trim().toUpperCase()).filter(Boolean);
  const missingDependency = dependsOn.find((id) => !existingIds.has(id));
  if (missingDependency) throw new VibeError(`Dependency task tidak ditemukan: ${missingDependency}`);

  let nextId = Number.isInteger(data.nextId) ? data.nextId : 1;
  let id = `T-${String(nextId).padStart(3, '0')}`;
  while (existingIds.has(id)) {
    nextId += 1;
    id = `T-${String(nextId).padStart(3, '0')}`;
  }

  const files = toStringList(input.files).flatMap((item) => item.split(',')).map((file) => file.trim().replaceAll('\\', '/').replace(/^\.\//, '')).filter(Boolean);
  const order = Number.isInteger(input.order)
    ? input.order
    : tasks.reduce((max, task) => Math.max(max, task.order || 0), 0) + 1;

  const task = normalizeTask({
    id,
    title,
    description: String(input.description ?? input.desc ?? '').trim(),
    acceptance,
    files,
    dependsOn,
    layer: String(input.layer ?? 'any').trim().toLowerCase() || 'any',
    phase: String(input.phase ?? '1').trim() || '1',
    order,
    status: 'pending',
    createdAt: nowIso()
  });

  data.tasks.push(task);
  data.nextId = nextId + 1;
  await saveTasksFile(project, data);
  return task;
}

export async function startTask(project, taskId, options = {}) {
  const { data, task } = await loadTask(project, taskId);
  const tasks = data.tasks.map(normalizeTask);
  const current = tasks.find((item) => item.id === task.id);

  if (current.status === 'done') throw new VibeError(`Task ${current.id} sudah selesai.`);
  if (current.status === 'in_progress' || current.status === 'verifying') {
    if (current.status === 'verifying') current.status = 'in_progress';
    current.updatedAt = nowIso();
    await saveTask(project, data, current);
    return { task: decorateTask(current), checkpoint: null, resumed: true };
  }

  const byId = new Map(tasks.map((item) => [item.id, item]));
  const blockers = blockersFor(current, byId);
  if (blockers.length > 0) {
    throw new VibeError(`Task ${current.id} masih menunggu dependency: ${blockers.join(', ')}.`);
  }
  const otherActive = tasks.find((item) => item.id !== current.id && ['in_progress', 'verifying'].includes(item.status));
  if (otherActive) {
    throw new VibeError(`Masih ada task aktif: ${otherActive.id} (${otherActive.title}).`, {
      hint: 'Selesaikan atau gagalkan task itu dulu. VibeGuard hanya mengizinkan satu task aktif.'
    });
  }

  const previous = lastCompletedTask(tasks);
  const checkpoint = checkpointBetween(previous, current);
  if (checkpoint && !options.acknowledgeCheckpoint) {
    throw new VibeError(`Checkpoint manusia diperlukan sebelum ${current.id}.`, {
      code: 'ECHECKPOINT',
      hint: `${checkpoint.reason} Uji hasil ${previous.id} dulu. Setelah disetujui: \`vibeguard task start ${current.id} --acknowledge\` atau MCP start_task { acknowledgeCheckpoint: true }.`,
      details: checkpoint
    });
  }

  current.contract = contractHash(await loadSpec(project), current);
  current.evidence = {};
  current.verification = null;
  current.status = 'in_progress';
  current.startedAt = current.startedAt || nowIso();
  current.attempts += 1;
  current.updatedAt = nowIso();
  await saveTask(project, data, current);
  return { task: decorateTask(current), checkpoint, resumed: false };
}

export async function completeTask(project, taskId) {
  const config = await loadConfig(project);
  const { data, task } = await loadTask(project, taskId);
  const current = normalizeTask(task);
  if (current.status === 'done') {
    return { task: current, alreadyDone: true, next: await getNextTask(project) };
  }
  if (!['in_progress', 'verifying'].includes(current.status)) {
    throw new VibeError(`Task ${current.id} belum dimulai. Jalankan start_task dulu.`, {
      exitCode: 1
    });
  }

  const spec = await loadSpec(project);
  const specCheck = checkSpec(spec);
  if (!specCheck.ok) {
    throw new VibeError('Spec berubah menjadi tidak valid; task tidak boleh di-complete.', {
      hint: 'Perbaiki .vibeguard/spec.md lalu verifikasi ulang.'
    });
  }

  if (config.verification.requireVerification) {
    if (!current.verification?.ok) {
      throw new VibeError(`Task ${current.id} belum punya verifikasi yang lulus.`, {
        hint: 'Jalankan verify_task / `vibeguard task verify` dan perbaiki semua kegagalan.'
      });
    }
    const currentFingerprint = await workingTreeFingerprint(project);
    if (currentFingerprint !== current.verification.fingerprint) {
      throw new VibeError('Kode berubah setelah verifikasi terakhir; bukti verifikasi sudah kedaluwarsa.', {
        hint: 'Jalankan verifikasi lagi pada working tree saat ini, lalu complete. Jangan complete setelah mengubah file tanpa verify ulang.'
      });
    }
    if (current.verification.contractHash && current.verification.contractHash !== contractHash(spec, current)) {
      throw new VibeError('Spec atau kontrak task berubah setelah verifikasi; bukti verifikasi tidak berlaku.', {
        hint: 'Kembalikan spec/task seperti saat verifikasi, atau jalankan start ulang + verifikasi ulang.'
      });
    }
  }

  if (config.verification.requireEvidence !== false) {
    const missing = criteriaFor(current).filter((criterion) => !criterion.proven);
    if (missing.length > 0) {
      throw new VibeError(`Bukti untuk ${missing.length} acceptance criterion belum dicatat.`, {
        hint: `Catat bukti per criterion: ${missing.map((criterion) => `${criterion.id} (${criterion.text})`).join('; ')}`
      });
    }
  }

  current.status = 'done';
  current.completedAt = nowIso();
  current.updatedAt = nowIso();
  await saveTask(project, data, current);
  return { task: current, alreadyDone: false, next: await getNextTask(project) };
}

export async function failTask(project, taskId, reason) {
  const message = String(reason ?? '').trim();
  if (message.length < 3) throw new VibeError('Alasan fail minimal 3 karakter.');
  const { data, task } = await loadTask(project, taskId);
  const current = normalizeTask(task);
  if (current.status === 'done') throw new VibeError(`Task ${current.id} sudah selesai.`);
  if (!['in_progress', 'verifying', 'failed'].includes(current.status)) {
    throw new VibeError(`Task ${current.id} belum dimulai.`);
  }
  current.status = 'failed';
  current.failedAt = nowIso();
  current.updatedAt = nowIso();
  current.notes.push({ at: nowIso(), type: 'fail', text: message });
  await saveTask(project, data, current);
  return current;
}

export async function recordEvidence(project, taskId, input = {}) {
  const rawCriterion = String(input.criterion ?? input.criterionId ?? '').trim();
  const match = rawCriterion.match(/^(?:A)?(\d+)$/i);
  if (!match) throw new VibeError('Criterion tidak valid. Gunakan ID seperti A1 atau angka 1.');
  const index = Number(match[1]) - 1;
  const note = String(input.note ?? input.evidence ?? '').trim();
  if (note.length < 5) throw new VibeError('Bukti minimal 5 karakter; tulis test, observasi, atau referensi yang spesifik.');
  if (note.length > 2000) throw new VibeError('Bukti maksimal 2000 karakter.');
  const type = String(input.type ?? 'manual').trim().toLowerCase() || 'manual';
  const allowedTypes = new Set(['test', 'manual', 'screenshot', 'command', 'review', 'other']);
  if (!allowedTypes.has(type)) {
    throw new VibeError(`Tipe bukti tidak valid: ${type}`, {
      hint: `Gunakan salah satu: ${[...allowedTypes].join(', ')}`
    });
  }
  const ref = String(input.ref ?? '').trim();
  if (ref.length > 500) throw new VibeError('Referensi bukti maksimal 500 karakter.');
  if (containsSecretValue(note) || containsSecretValue(ref)) {
    throw new VibeError('Bukti mengandung pola secret. Jangan menyalin token, key, atau credential ke evidence.', {
      hint: 'Tulis nama test/command atau lokasi bukti, bukan nilai rahasianya.'
    });
  }

  const { data, task } = await loadTask(project, taskId);
  const current = normalizeTask(task);
  if (!['in_progress', 'verifying'].includes(current.status)) {
    throw new VibeError(`Task ${current.id} harus aktif sebelum mencatat bukti.`, {
      hint: 'Jalankan start_task / `vibeguard task start <id>` dulu.'
    });
  }
  const criteria = criteriaFor(current);
  const criterion = criteria[index];
  if (!criterion) throw new VibeError(`Criterion ${rawCriterion} tidak ada; task punya ${criteria.length} criteria (A1-A${criteria.length}).`);

  current.evidence = {
    ...(current.evidence || {}),
    [criterion.id]: {
      note,
      type,
      ref: ref || null,
      recordedAt: nowIso()
    }
  };
  current.updatedAt = nowIso();
  await saveTask(project, data, current);
  return {
    task: decorateTask(current),
    criterion: criteriaFor(current)[index]
  };
}

export async function recordVerification(project, taskId, verification) {
  const { data, task } = await loadTask(project, taskId);
  const current = normalizeTask(task);
  current.verification = verification;
  if (current.status === 'verifying') current.status = 'in_progress';
  current.updatedAt = nowIso();
  await saveTask(project, data, current);
  return current;
}

export async function beginVerification(project, taskId) {
  const { data, task } = await loadTask(project, taskId);
  const current = normalizeTask(task);
  if (!['in_progress', 'verifying'].includes(current.status)) {
    throw new VibeError(`Task ${current.id} harus dimulai sebelum diverifikasi.`, {
      hint: 'Panggil start_task / `vibeguard task start <id>` dulu.'
    });
  }
  current.status = 'verifying';
  current.updatedAt = nowIso();
  await saveTask(project, data, current);
  return current;
}
