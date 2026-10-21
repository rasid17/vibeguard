import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VibeError,
  ensureDir,
  fileExists,
  nowIso,
  readTextFile,
  timestampSlug,
  vgPath,
  writeFileAtomic,
  writeJson
} from './util.js';

const BEGIN = '<!-- BEGIN VIBEGUARD -->';
const END = '<!-- END VIBEGUARD -->';

export function binPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'vibeguard.js');
}

export function mcpServerConfig(project) {
  return {
    type: 'stdio',
    command: process.execPath,
    args: [binPath(), 'mcp', '--project', path.resolve(project)]
  };
}

export function mcpJson(project) {
  return { mcpServers: { vibeguard: mcpServerConfig(project) } };
}

export function codexToml(project) {
  const server = mcpServerConfig(project);
  return `[mcp_servers.vibeguard]
command = ${JSON.stringify(server.command)}
args = [${server.args.map((arg) => JSON.stringify(arg)).join(', ')}]
`;
}

function blockMarked(content) {
  return `${BEGIN}\n${content.trim()}\n${END}`;
}

export function agentProtocol(project) {
  return `# VibeGuard Agent Protocol

VibeGuard is a local quality gate. It is not a chatbot and it has no billing.
The human owns the spec; the agent works one verified task at a time.

## Hard rules

1. Read \`.vibeguard/spec.md\` before planning any code. If \`vibeguard spec check\` fails, stop and fix the spec with the human.
2. Work on exactly one task. Never implement several tasks in one session.
3. Do not edit files outside the task's \`files\` scope. If the scope is wrong, ask the human to change it.
4. Call \`start_task\` before editing.
5. Call \`verify_task\` after editing. Verification runs the project's configured checks and a slop scan. Never invent or paste fake results.
6. Call \`complete_task\` only after a passing verification. It re-checks the working tree fingerprint; editing or committing after verification invalidates the evidence.
7. When the next task changes layer or phase, \`get_next_task\` returns a checkpoint. Stop, ask the human to try the previous work, and wait for approval before starting.
8. Commit after \`complete_task\`, not before it. Verification evidence must describe the tree that was completed.
9. Do not modify \`.vibeguard/spec.md\`, \`tasks.json\`, or verification logs to make a check pass. If the human changes the spec or scope, stop and restart the task so verification uses the new contract.
10. Read before writing. Prefer the existing patterns and dependencies in the repo; do not add a library for a solved problem.

## MCP tools

- \`vibeguard_status\` — project, spec, counts, next task.
- \`vibeguard_get_spec\` — spec content + validation.
- \`vibeguard_list_tasks\` — tasks with blockers and verification state.
- \`vibeguard_get_next_task\` — one next task and checkpoint information.
- \`vibeguard_get_context\` — context pack for a task (spec, conventions, relevant files).
- \`vibeguard_start_task\` — start the only active task. Pass \`acknowledgeCheckpoint: true\` only after human approval.
- \`vibeguard_verify_task\` — run configured checks, slop scan, and scope check.
- \`vibeguard_complete_task\` — gate completion on fresh passing evidence.
- \`vibeguard_fail_task\` — record why a task is blocked.
- \`vibeguard_add_task\` — add a task with mandatory acceptance criteria.

## CLI fallback

\`\`\`sh
vibeguard status
vibeguard spec check
vibeguard task next
vibeguard task start T-001
vibeguard context T-001
vibeguard task verify T-001
vibeguard task done T-001
vibeguard task fail T-001 "reason"
\`\`\`

For a checkpoint, \`task start\` refuses until the human approves. Then use:

\`\`\`sh
vibeguard task start T-002 --acknowledge
\`\`\`

## What "done" means

A task is done only when:

- the implementation satisfies its acceptance criteria;
- every configured verification command passes;
- the slop scan has no errors;
- changed files stay within the task scope;
- \`complete_task\` accepts the evidence fingerprint.

If a check cannot run, report the blocker instead of claiming success.
`;
}

export function agentInstructionBlock(project) {
  return blockMarked(`## VibeGuard quality gate (local)

This repo uses VibeGuard. Planning documents and verification are local; there is no billing or telemetry.

Follow this loop exactly:

1. \`vibeguard_get_next_task\` — take **one** task. If \`checkpoint.needed\` is true, STOP and ask the human to test the previous work. Do not start it until they approve.
2. \`vibeguard_get_context\` — read the spec, the listed conventions, and the relevant files before editing.
3. \`vibeguard_start_task\` — start the task. Use \`acknowledgeCheckpoint: true\` only after explicit human approval.
4. Implement **only** that task. Stay inside its \`files\` scope. Follow existing patterns; do not add duplicate libraries or abstractions.
5. \`vibeguard_verify_task\` — run the real checks. Fix failures. Never fabricate output or weaken a check.
6. \`vibeguard_complete_task\` — only after verification passes. Then commit. Stop at checkpoints.

Rules:
- Never implement from a chat plan alone. The spec at \`.vibeguard/spec.md\` is the source of truth.
- Never add a task without acceptance criteria.
- Never mark a task complete without fresh passing verification.
- Do not edit \`.vibeguard/spec.md\`, \`tasks.json\`, or logs to force a pass.

CLI fallback: \`vibeguard task next\`, \`vibeguard context <id>\`, \`vibeguard task start <id>\`, \`vibeguard task verify <id>\`, \`vibeguard task done <id>\`.
Full protocol: \`.vibeguard/agent-protocol.md\`.`);
}

function claudeBlock() {
  return blockMarked(`## VibeGuard

This project uses the local VibeGuard quality gate. Read \`AGENTS.md\` and \`.vibeguard/agent-protocol.md\` before coding.

Work one task at a time through MCP tools: \`vibeguard_get_next_task\` -> \`vibeguard_get_context\` -> \`vibeguard_start_task\` -> implement -> \`vibeguard_verify_task\` -> \`vibeguard_complete_task\`.

If \`checkpoint.needed\` is true, stop and ask the human to test before continuing. Never complete a task without a passing, fresh verification. Commit after completing, not before.`);
}

async function backupFile(project, file) {
  if (!(await fileExists(file))) return null;
  const dir = vgPath(project, 'backups');
  await ensureDir(dir);
  const name = path.basename(file);
  const target = path.join(dir, `${name}.${timestampSlug()}.bak`);
  await fs.copyFile(file, target);
  return target;
}

async function upsertBlock(project, file, block, header) {
  const exists = await fileExists(file);
  if (!exists) {
    await writeFileAtomic(file, `${header}\n\n${block}\n`);
    return { file, action: 'created' };
  }
  const current = (await readTextFile(file, '')) || '';
  if (current.includes(BEGIN) && current.includes(END)) {
    const pattern = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    if (pattern.test(current)) {
      await backupFile(project, file);
      await writeFileAtomic(file, current.replace(pattern, block));
      return { file, action: 'updated' };
    }
  }
  await backupFile(project, file);
  await writeFileAtomic(file, `${current.trimEnd()}\n\n${block}\n`);
  return { file, action: 'appended' };
}

export async function ensureAgentDocs(project) {
  const protocolFile = vgPath(project, 'agent-protocol.md');
  await writeFileAtomic(protocolFile, agentProtocol(project));

  const agents = await upsertBlock(
    project,
    path.join(project, 'AGENTS.md'),
    agentInstructionBlock(project),
    '# Agent instructions'
  );
  const claude = await upsertBlock(
    project,
    path.join(project, 'CLAUDE.md'),
    claudeBlock(),
    '# Claude instructions'
  );
  return { protocolFile, agents, claude };
}

export async function writeMcpConfig(project, targets = ['claude']) {
  const written = [];
  for (const target of targets) {
    if (target === 'claude') {
      const file = path.join(project, '.mcp.json');
      await mergeMcpJson(project, file);
      written.push(file);
    } else if (target === 'cursor') {
      const file = path.join(project, '.cursor', 'mcp.json');
      await mergeMcpJson(project, file);
      written.push(file);
    } else if (target !== 'codex') {
      throw new VibeError(`Target MCP tidak dikenal: ${target}`);
    }
  }
  return written;
}

async function mergeMcpJson(project, file) {
  let existing = {};
  if (await fileExists(file)) {
    const raw = await readTextFile(file, '');
    try {
      existing = raw.trim() ? JSON.parse(raw) : {};
    } catch (error) {
      throw new VibeError(`Tidak bisa menggabungkan MCP config karena JSON tidak valid: ${file}`, {
        hint: error.message
      });
    }
    await backupFile(project, file);
  }
  existing.mcpServers = existing.mcpServers && typeof existing.mcpServers === 'object' ? existing.mcpServers : {};
  existing.mcpServers.vibeguard = mcpServerConfig(project);
  await writeJson(file, existing);
  return file;
}

export function mcpConfigReport(project) {
  return {
    claude: JSON.stringify(mcpJson(project), null, 2),
    cursor: JSON.stringify(mcpJson(project), null, 2),
    codex: codexToml(project),
    generatedAt: nowIso()
  };
}
