import readline from 'node:readline';
import crypto from 'node:crypto';
import {
  VERSION,
  VibeError,
  nowIso,
  truncate
} from './util.js';
import {
  configForAgent,
  loadConfig,
  loadSpec,
  loadTasksFile,
  normalizeTask,
  taskCounts
} from './store.js';
import { checkSpec } from './spec.js';
import {
  addTask,
  completeTask,
  failTask,
  getNextTask,
  listTasks,
  startTask
} from './tasks.js';
import { summarizeVerificationResult, verifyTask } from './verify.js';
import { buildContextPack } from './context.js';

const INSTRUCTIONS = `VibeGuard is a local quality gate for AI coding. This project has no billing and no telemetry.
Work one task at a time:
1. vibeguard_get_next_task. If checkpoint.needed is true, stop and ask the human to test before continuing.
2. vibeguard_get_context, then read the listed files.
3. vibeguard_start_task (acknowledgeCheckpoint only after explicit human approval).
4. Implement only that task, inside its file scope.
5. vibeguard_verify_task. If checks are slow, call it with async:true and poll vibeguard_verification_status.
6. vibeguard_complete_task only after a passing verification. Then commit. Stop at checkpoints.
Never fake verification output, never add a task without acceptance criteria, and never edit the spec or task data to force a pass.`;

const TOOLS = [
  {
    name: 'vibeguard_status',
    description: 'Project summary: spec validity, task counts, configured checks, and the next task. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'vibeguard_get_spec',
    description: 'Return the spec (.vibeguard/spec.md) and its validation result. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'vibeguard_list_tasks',
    description: 'List tasks with status, blockers, scope, and verification state. Optionally filter by status.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', description: 'pending | in_progress | done | failed | verifying' } },
      additionalProperties: false
    }
  },
  {
    name: 'vibeguard_get_next_task',
    description: 'Return the single next task. If checkpoint.needed is true, stop and ask the human to test the previous layer/phase before starting.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'vibeguard_get_context',
    description: 'Build a context pack for one task: spec excerpt, conventions, relevant files, and verification commands. Read the files before editing.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' }, maxChars: { type: 'number' } },
      required: ['taskId'],
      additionalProperties: false
    }
  },
  {
    name: 'vibeguard_start_task',
    description: 'Start the one active task. Refuses if a checkpoint is pending unless acknowledgeCheckpoint is true after human approval.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        acknowledgeCheckpoint: { type: 'boolean' }
      },
      required: ['taskId'],
      additionalProperties: false
    }
  },
  {
    name: 'vibeguard_verify_task',
    description: 'Run all configured checks plus slop and scope guards. Writes evidence and blocks completion if anything fails. Set async:true for long test suites.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        async: { type: 'boolean' }
      },
      required: ['taskId'],
      additionalProperties: false
    }
  },
  {
    name: 'vibeguard_verification_status',
    description: 'Check an async verification job started with vibeguard_verify_task async:true.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
      additionalProperties: false
    }
  },
  {
    name: 'vibeguard_complete_task',
    description: 'Mark a task done. Only succeeds with fresh passing verification on the current working tree. Returns the next task and checkpoint.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false
    }
  },
  {
    name: 'vibeguard_fail_task',
    description: 'Record that a task is blocked or failed, with a reason.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        reason: { type: 'string' }
      },
      required: ['taskId', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'vibeguard_add_task',
    description: 'Add a task. Acceptance criteria are mandatory; tasks cannot be created while the spec is invalid.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        acceptance: { type: 'array', items: { type: 'string' }, minItems: 1 },
        files: { type: 'array', items: { type: 'string' } },
        layer: { type: 'string', description: 'frontend | backend | fullstack | data | any' },
        phase: { type: ['string', 'number'] },
        dependsOn: { type: 'array', items: { type: 'string' } },
        order: { type: 'number' }
      },
      required: ['title', 'acceptance'],
      additionalProperties: false
    }
  }
];

function textResult(text, structuredContent) {
  const content = [{ type: 'text', text: String(text) }];
  if (structuredContent !== undefined) return { content, structuredContent };
  return { content };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  const hint = error?.hint ? `\nHint: ${error.hint}` : '';
  const payload = {
    error: message,
    code: error?.code,
    hint: error?.hint || undefined,
    details: error?.details
  };
  return {
    content: [{ type: 'text', text: `${message}${hint}` }],
    structuredContent: payload,
    isError: true
  };
}

function summaryLine(result) {
  const lines = [result.ok ? 'VERIFY PASS' : 'VERIFY FAIL'];
  for (const command of result.commands || []) {
    lines.push(`${command.ok ? 'PASS' : 'FAIL'} ${command.name} (exit ${command.exitCode})`);
    if (!command.ok && command.outputTail) lines.push(truncate(command.outputTail, 1500));
  }
  if (!result.slop?.ok) {
    lines.push(`Slop errors: ${result.slop.errors.length}`);
    for (const finding of result.slop.errors.slice(0, 10)) {
      lines.push(`${finding.file}:${finding.line} [${finding.pattern}] ${finding.excerpt}`);
    }
  }
  if (result.scope?.violations?.length) lines.push(`Scope violations: ${result.scope.violations.join(', ')}`);
  return lines.join('\n');
}

export async function startMcpServer(project) {
  const jobs = new Map();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let chain = Promise.resolve();
  let closed = false;
  const closedPromise = new Promise((resolve) => {
    rl.on('close', () => {
      closed = true;
      resolve();
    });
  });

  function send(message) {
    if (closed) return;
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  function log(message) {
    process.stderr.write(`[vibeguard mcp] ${message}\n`);
  }

  async function callTool(name, args = {}) {
    switch (name) {
      case 'vibeguard_status': {
        const config = await loadConfig(project);
        const spec = await loadSpec(project);
        const check = checkSpec(spec);
        const tasks = (await loadTasksFile(project)).tasks.map(normalizeTask);
        const next = await getNextTask(project);
        return {
          project,
          config: configForAgent(config),
          spec: { ok: check.ok, title: check.title, missing: check.missing, placeholders: check.placeholders },
          counts: taskCounts(tasks),
          next: next.task ? { task: next.task, resume: next.resume, checkpoint: next.checkpoint } : { task: null, blocked: next.blocked }
        };
      }
      case 'vibeguard_get_spec': {
        const content = await loadSpec(project);
        return { content, check: checkSpec(content), file: '.vibeguard/spec.md' };
      }
      case 'vibeguard_list_tasks': {
        let tasks = await listTasks(project);
        if (args.status) tasks = tasks.filter((task) => task.status === args.status);
        return { tasks, counts: taskCounts(tasks) };
      }
      case 'vibeguard_get_next_task':
        return getNextTask(project);
      case 'vibeguard_get_context': {
        if (!args.taskId) throw new VibeError('taskId wajib diisi.');
        const pack = await buildContextPack(project, args.taskId, { maxChars: args.maxChars });
        return {
          task: pack.task,
          files: pack.files,
          keywords: pack.keywords,
          outputFile: pack.outputFile,
          context: pack.markdown
        };
      }
      case 'vibeguard_start_task': {
        if (!args.taskId) throw new VibeError('taskId wajib diisi.');
        return startTask(project, args.taskId, { acknowledgeCheckpoint: args.acknowledgeCheckpoint === true });
      }
      case 'vibeguard_verify_task': {
        if (!args.taskId) throw new VibeError('taskId wajib diisi.');
        if (args.async === true) {
          const jobId = crypto.randomUUID();
          const job = {
            id: jobId,
            taskId: args.taskId,
            status: 'running',
            startedAt: nowIso(),
            progress: [],
            result: null,
            error: null
          };
          jobs.set(jobId, job);
          job.promise = verifyTask(project, args.taskId, {
            onProgress: (event) => {
              job.progress.push({ at: nowIso(), type: event.type, name: event.name || event.result?.name });
              log(`job ${jobId}: ${event.type}${event.name ? ` ${event.name}` : ''}${event.result ? ` -> ${event.result.ok ? 'PASS' : 'FAIL'}` : ''}`);
            }
          }).then((output) => {
            job.status = 'done';
            job.result = output;
            job.finishedAt = nowIso();
            return output;
          }).catch((error) => {
            job.status = 'error';
            job.error = { message: error.message, hint: error.hint || null, details: error.details || null };
            job.finishedAt = nowIso();
          });
          return {
            jobId,
            status: 'running',
            taskId: args.taskId,
            message: 'Verification started. Poll vibeguard_verification_status with this jobId until status is done or error.'
          };
        }
        const output = await verifyTask(project, args.taskId, {
          onProgress: (event) => {
            if (event.type === 'command-end') log(`${event.result.ok ? 'PASS' : 'FAIL'} ${event.result.name}`);
          }
        });
        return {
          ok: output.result.ok,
          task: output.task,
          runId: output.result.runId,
          summary: summarizeVerificationResult(output.result),
          failedCommands: output.result.failedCommands,
          slop: { ok: output.result.slop.ok, errors: output.result.slop.errors, warnings: output.result.slop.warnings.slice(0, 30) },
          scope: output.result.scope,
          evidence: output.result.commands.map((command) => ({ name: command.name, ok: command.ok, log: command.log, outputTail: command.ok ? undefined : command.outputTail }))
        };
      }
      case 'vibeguard_verification_status': {
        if (!args.jobId) throw new VibeError('jobId wajib diisi.');
        const job = jobs.get(args.jobId);
        if (!job) throw new VibeError(`Job verifikasi tidak ditemukan: ${args.jobId}`);
        if (job.status === 'running') {
          return { jobId: job.id, status: 'running', taskId: job.taskId, startedAt: job.startedAt, progress: job.progress };
        }
        if (job.status === 'error') {
          return { jobId: job.id, status: 'error', taskId: job.taskId, error: job.error, finishedAt: job.finishedAt };
        }
        return {
          jobId: job.id,
          status: 'done',
          taskId: job.taskId,
          ok: job.result.result.ok,
          task: job.result.task,
          runId: job.result.result.runId,
          summary: summarizeVerificationResult(job.result.result),
          slop: { ok: job.result.result.slop.ok, errors: job.result.result.slop.errors, warnings: job.result.result.slop.warnings.slice(0, 30) },
          scope: job.result.result.scope,
          finishedAt: job.finishedAt
        };
      }
      case 'vibeguard_complete_task': {
        if (!args.taskId) throw new VibeError('taskId wajib diisi.');
        return completeTask(project, args.taskId);
      }
      case 'vibeguard_fail_task': {
        if (!args.taskId) throw new VibeError('taskId wajib diisi.');
        if (!args.reason) throw new VibeError('reason wajib diisi.');
        return failTask(project, args.taskId, args.reason);
      }
      case 'vibeguard_add_task': {
        if (!args.title) throw new VibeError('title wajib diisi.');
        return addTask(project, {
          title: args.title,
          description: args.description,
          acceptance: args.acceptance,
          files: args.files,
          layer: args.layer,
          phase: args.phase,
          dependsOn: args.dependsOn,
          order: args.order
        });
      }
      default:
        throw new VibeError(`Tool tidak dikenal: ${name}`);
    }
  }

  async function handleMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'vibeguard', version: VERSION },
          instructions: INSTRUCTIONS
        }
      });
      return;
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        const data = await callTool(name, args);
        if (name === 'vibeguard_get_context') {
          send({
            jsonrpc: '2.0',
            id,
            result: textResult(
              `Context pack for ${data.task.id} (${data.files.length} files). Read it, then inspect the files before editing.\n\n${data.context}`,
              {
                task: data.task,
                files: data.files,
                keywords: data.keywords,
                outputFile: data.outputFile
              }
            )
          });
          return;
        }
        if (name === 'vibeguard_verify_task') {
          send({
            jsonrpc: '2.0',
            id,
            result: textResult(data.summary || data.message || 'Verification started.', data)
          });
          return;
        }
        if (name === 'vibeguard_verification_status' && data.status === 'running') {
          send({ jsonrpc: '2.0', id, result: textResult(data.message || `Verification is still running (${data.progress.length} events).`, data) });
          return;
        }
        const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        send({ jsonrpc: '2.0', id, result: textResult(text, typeof data === 'object' ? data : undefined) });
      } catch (error) {
        send({ jsonrpc: '2.0', id, result: errorResult(error) });
      }
      return;
    }
    if (isNotification) return;
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    chain = chain.then(() => handleMessage(message)).catch((error) => {
      log(`request error: ${error.message}`);
      if (message?.id !== undefined && message?.id !== null) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } });
      }
    });
  });

  log(`ready for ${project}`);
  await closedPromise;
}
