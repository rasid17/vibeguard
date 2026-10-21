import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { makeProject } from './helpers.js';

const bin = path.resolve('bin', 'vibeguard.js');

function createClient(project) {
  const child = spawn(process.execPath, [bin, 'mcp', '--project', project], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffer = '';
  let nextId = 0;
  const pending = new Map();
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  function request(method, params = {}, timeoutMs = 8000) {
    const id = ++nextId;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }
  return {
    request,
    async close() {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once('exit', resolve);
      });
    }
  };
}

test('MCP handshake, tool list, status and task creation', async (t) => {
  const { project, cleanup } = await makeProject();
  const client = createClient(project);
  t.after(async () => {
    await client.close();
    await cleanup();
  });

  const init = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' }
  });
  assert.equal(init.result.serverInfo.name, 'vibeguard');
  assert.equal(init.result.protocolVersion, '2025-06-18');

  const tools = await client.request('tools/list');
  const names = tools.result.tools.map((tool) => tool.name);
  for (const expected of [
    'vibeguard_get_next_task',
    'vibeguard_get_context',
    'vibeguard_verify_task',
    'vibeguard_complete_task',
    'vibeguard_add_task'
  ]) {
    assert.ok(names.includes(expected), expected);
  }

  const status = await client.request('tools/call', { name: 'vibeguard_status', arguments: {} });
  assert.equal(status.result.isError, undefined);
  const statusData = JSON.parse(status.result.content[0].text);
  assert.equal(statusData.project, project);
  assert.equal(statusData.spec.ok, true);

  const invalidAdd = await client.request('tools/call', {
    name: 'vibeguard_add_task',
    arguments: { title: 'No criteria' }
  });
  assert.equal(invalidAdd.result.isError, true);

  const add = await client.request('tools/call', {
    name: 'vibeguard_add_task',
    arguments: {
      title: 'MCP-created task',
      acceptance: ['The task is visible'],
      files: ['src/**'],
      layer: 'frontend',
      phase: '1'
    }
  });
  assert.equal(add.result.isError, undefined);
  assert.equal(add.result.structuredContent.id, 'T-001');
  assert.equal(add.result.structuredContent.status, 'pending');

  const start = await client.request('tools/call', {
    name: 'vibeguard_start_task',
    arguments: { taskId: 'T-001' }
  });
  assert.equal(start.result.isError, undefined);
  assert.equal(start.result.structuredContent.task.status, 'in_progress');

  const verify = await client.request('tools/call', {
    name: 'vibeguard_verify_task',
    arguments: { taskId: 'T-001', async: true }
  });
  assert.equal(verify.result.isError, undefined);
  const jobId = verify.result.structuredContent.jobId;
  assert.ok(jobId);

  let verification = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const poll = await client.request('tools/call', {
      name: 'vibeguard_verification_status',
      arguments: { jobId }
    });
    const data = poll.result.structuredContent;
    if (data.status === 'done') {
      verification = data;
      break;
    }
    if (data.status === 'error') {
      assert.fail(JSON.stringify(data.error));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(verification, 'async verification did not finish');
  assert.equal(verification.ok, true, verification.summary);

  const complete = await client.request('tools/call', {
    name: 'vibeguard_complete_task',
    arguments: { taskId: 'T-001' }
  });
  assert.equal(complete.result.isError, undefined);
  assert.equal(complete.result.structuredContent.task.status, 'done');
});
