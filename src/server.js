import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  VERSION,
  VibeError,
  nowIso
} from './util.js';
import {
  isInitialized,
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
  recordEvidence,
  startTask
} from './tasks.js';
import { readRun, readRunLog, verifyTask } from './verify.js';
import { buildContextPack } from './context.js';
import { buildGraph } from './graph.js';
import { impactGraph, queryGraph } from './codegraph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  res.end(body);
}

function text(res, status, value) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  res.end(value);
}

function html(res, value) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'"
  });
  res.end(value);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new VibeError('Request body terlalu besar (maks 1 MB).'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new VibeError('Body JSON tidak valid.'));
      }
    });
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function safeTokenEquals(candidate, token) {
  if (!candidate || candidate.length !== token.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
  } catch {
    return false;
  }
}

function stateFor(project, config, spec, tasks, next) {
  const check = checkSpec(spec);
  return {
    version: VERSION,
    project: { path: project, name: config.projectName || path.basename(project) },
    config: {
      verification: config.verification,
      context: config.context,
      secrets: config.secrets
    },
    spec: { content: spec, check },
    tasks,
    next,
    counts: taskCounts(tasks),
    time: nowIso()
  };
}

export async function createUiServer(project, options = {}) {
  if (!(await isInitialized(project))) {
    throw new VibeError('Project belum diinisialisasi VibeGuard.', { hint: 'Jalankan `vibeguard init`' });
  }
  const host = options.host || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new VibeError('Dashboard hanya boleh listen di loopback (127.0.0.1/localhost/::1).');
  }
  const port = Number.isInteger(options.port) ? options.port : 4317;
  const token = crypto.randomBytes(24).toString('hex');
  const startedAt = Date.now();
  const htmlTemplate = await fs.readFile(path.join(__dirname, 'ui.html'), 'utf8');
  let graphCache = null;
  let graphCacheAt = 0;

  async function currentGraph() {
    if (!graphCache || Date.now() - graphCacheAt > 5000) {
      graphCache = await buildGraph(project);
      graphCacheAt = Date.now();
    }
    return graphCache;
  }

  async function buildState() {
    const [config, spec] = await Promise.all([loadConfig(project), loadSpec(project)]);
    const tasksFile = await loadTasksFile(project);
    const tasks = tasksFile.tasks.map(normalizeTask);
    const listed = await listTasks(project);
    const next = await getNextTask(project);
    return stateFor(project, config, spec, listed, next);
  }

  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method || 'GET';

    if (method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, await buildState());
      return;
    }

    if (method === 'GET' && url.pathname === '/api/health') {
      json(res, 200, { ok: true, version: VERSION, uptimeMs: Date.now() - startedAt });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/graph') {
      const graph = await currentGraph();
      const query = url.searchParams.get('q');
      const target = url.searchParams.get('target');
      if (query) {
        json(res, 200, {
          stats: graph.stats,
          query: queryGraph(graph, query, { limit: Number(url.searchParams.get('limit')) || 20 })
        });
        return;
      }
      if (target) {
        const impact = impactGraph(graph, target, { depth: Number(url.searchParams.get('depth')) || 2 });
        json(res, 200, { stats: graph.stats, impact });
        return;
      }
      json(res, 200, { stats: graph.stats, generatedAt: graph.generatedAt });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/tasks') {
      if (!sameOrigin(req)) {
        json(res, 403, { error: 'Origin tidak diizinkan.' });
        return;
      }
      const body = await readBody(req);
      const task = await addTask(project, body);
      json(res, 201, { task });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'tasks' && parts[2]) {
      const taskId = decodeURIComponent(parts[2]);
      const action = parts[3];

      if (method === 'GET' && action === 'evidence') {
        const task = (await listTasks(project)).find((item) => item.id === taskId);
        if (!task) {
          json(res, 404, { error: `Task tidak ditemukan: ${taskId}` });
          return;
        }
        if (!task.verification?.runId) {
          json(res, 404, { error: `Task ${taskId} belum punya evidence verifikasi.` });
          return;
        }
        const result = await readRun(project, task.verification.runId);
        json(res, 200, { task, result });
        return;
      }

      if (method === 'GET' && action === 'context') {
        const pack = await buildContextPack(project, taskId);
        json(res, 200, {
          task: pack.task,
          files: pack.files,
          keywords: pack.keywords,
          used: pack.used,
          maxChars: pack.maxChars,
          outputFile: pack.outputFile,
          markdown: pack.markdown
        });
        return;
      }

      if (method === 'POST' && action === 'start') {
        if (!sameOrigin(req)) {
          json(res, 403, { error: 'Origin tidak diizinkan.' });
          return;
        }
        const body = await readBody(req);
        try {
          const result = await startTask(project, taskId, { acknowledgeCheckpoint: body.acknowledgeCheckpoint === true });
          json(res, 200, result);
        } catch (error) {
          if (error?.code === 'ECHECKPOINT') {
            json(res, 409, {
              error: error.message,
              hint: error.hint,
              checkpoint: error.details,
              requiresCheckpoint: true
            });
            return;
          }
          throw error;
        }
        return;
      }

      if (method === 'POST' && action === 'verify') {
        if (!sameOrigin(req)) {
          json(res, 403, { error: 'Origin tidak diizinkan.' });
          return;
        }
        const output = await verifyTask(project, taskId);
        const next = await getNextTask(project);
        json(res, 200, {
          ok: output.result.ok,
          result: output.result,
          task: output.task,
          next
        });
        return;
      }

      if (method === 'POST' && action === 'complete') {
        if (!sameOrigin(req)) {
          json(res, 403, { error: 'Origin tidak diizinkan.' });
          return;
        }
        await readBody(req);
        const result = await completeTask(project, taskId);
        json(res, 200, result);
        return;
      }

      if (method === 'POST' && action === 'evidence') {
        if (!sameOrigin(req)) {
          json(res, 403, { error: 'Origin tidak diizinkan.' });
          return;
        }
        const body = await readBody(req);
        const result = await recordEvidence(project, taskId, {
          criterion: body.criterion,
          note: body.note,
          type: body.type,
          ref: body.ref
        });
        json(res, 200, result);
        return;
      }

      if (method === 'POST' && action === 'fail') {
        if (!sameOrigin(req)) {
          json(res, 403, { error: 'Origin tidak diizinkan.' });
          return;
        }
        const body = await readBody(req);
        const task = await failTask(project, taskId, body.reason);
        json(res, 200, { task });
        return;
      }
    }

    if (method === 'GET' && url.pathname === '/api/run-log') {
      const runId = url.searchParams.get('runId');
      const name = url.searchParams.get('name');
      if (!runId || !name) {
        json(res, 400, { error: 'runId dan name wajib diisi.' });
        return;
      }
      const log = await readRunLog(project, runId, name);
      text(res, 200, log);
      return;
    }

    json(res, 404, { error: 'Endpoint tidak ditemukan.' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const candidate = url.searchParams.get('token') || '';
        if (!safeTokenEquals(candidate, token)) {
          text(res, 401, 'Buka URL dashboard yang dicetak di terminal VibeGuard (termasuk token).');
          return;
        }
        const bootstrap = JSON.stringify({ token, project, name: path.basename(project) }).replace(/</g, '\\u003c');
        html(res, htmlTemplate.replace('__VG_BOOTSTRAP__', bootstrap));
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        const headerToken = req.headers['x-vibeguard-token'];
        const queryToken = url.searchParams.get('token') || '';
        if (!safeTokenEquals(String(headerToken || queryToken), token)) {
          json(res, 401, { error: 'Token VibeGuard tidak valid.' });
          return;
        }
        await handleApi(req, res, url);
        return;
      }

      text(res, 404, 'Not found');
    } catch (error) {
      const status = error instanceof VibeError
        ? (error.code === 'ECHECKPOINT' ? 409 : 400)
        : 500;
      if (status === 500) {
        process.stderr.write(`[vibeguard ui] ${error?.stack || error}\n`);
      }
      json(res, status, {
        error: error instanceof Error ? error.message : String(error),
        code: error?.code,
        hint: error?.hint,
        details: error?.details
      });
    }
  });

  server.requestTimeout = 15 * 60 * 1000;
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new VibeError(`Port ${port} sudah dipakai.`, { hint: 'Gunakan `vibeguard ui --port <lain>`.' }));
      } else {
        reject(error);
      }
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const displayHost = host === '::1' ? '[::1]' : host;
  const url = `http://${displayHost}:${actualPort}/?token=${token}`;

  return {
    server,
    port: actualPort,
    host,
    token,
    url,
    startedAt,
    close: async () => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
