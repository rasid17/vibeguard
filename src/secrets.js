import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_EXCLUDED_DIRS,
  TEXT_EXTENSIONS,
  escapeRegExp,
  matchGlob,
  walkFiles
} from './util.js';

const BUILTIN_PATTERNS = [
  { name: 'github-token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: 'openai-key', regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'aws-access-key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'stripe-live-key', regex: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g },
  { name: 'slack-token', regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { name: 'npm-token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'private-key', regex: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/g }
];

const DEFAULT_IGNORES = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/fixtures/**',
  '**/mocks/**',
  '**/*.md',
  '**/docs/**',
  '**/.env*',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/bun.lock',
  '**/bun.lockb',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
  '**/vendor/**',
  '**/*.min.js',
  '**/*.map',
  '**/*.snap'
];

function toRegex(pattern) {
  const value = String(pattern);
  if (value.length > 2 && value.startsWith('/')) {
    const last = value.lastIndexOf('/');
    if (last > 0) {
      try {
        const flags = value.slice(last + 1);
        return new RegExp(value.slice(1, last), flags.includes('g') ? flags : `${flags}g`);
      } catch {
        /* fall through */
      }
    }
  }
  return new RegExp(escapeRegExp(value), 'gi');
}

export function containsSecretValue(text) {
  const value = String(text ?? '');
  for (const pattern of BUILTIN_PATTERNS) {
    pattern.regex.lastIndex = 0;
    const found = pattern.regex.test(value);
    pattern.regex.lastIndex = 0;
    if (found) return true;
  }
  return false;
}

function maskSecret(value) {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function ignored(rel, ignoreGlobs) {
  return rel === '.vibeguard' || rel.startsWith('.vibeguard/') || ignoreGlobs.some((glob) => matchGlob(rel, glob));
}

async function candidateFiles(project, ignoreGlobs, changedFiles) {
  if (changedFiles.length > 0) {
    return changedFiles
      .map((entry) => entry.path)
      .filter((rel) => !ignored(rel, ignoreGlobs));
  }
  const walked = await walkFiles(project, {
    excludedDirs: DEFAULT_EXCLUDED_DIRS,
    excludedGlobs: ignoreGlobs,
    extensions: TEXT_EXTENSIONS,
    maxFiles: 2000,
    maxSize: 512 * 1024
  });
  return walked.files.map((file) => file.rel);
}

export async function scanSecrets(project, config, changedFiles = []) {
  if (config.secrets?.enabled === false) {
    return { ok: true, findings: [], scannedFiles: 0, skipped: true };
  }
  const ignoreGlobs = [...DEFAULT_IGNORES, ...(config.secrets?.ignore || [])];
  const patterns = [
    ...BUILTIN_PATTERNS,
    ...(config.secrets?.patterns || []).map((item, index) => {
      if (item && typeof item === 'object' && item.pattern) {
        return { name: item.name || `custom-${index + 1}`, regex: toRegex(item.pattern) };
      }
      return { name: `custom-${index + 1}`, regex: toRegex(item) };
    })
  ];
  const files = await candidateFiles(project, ignoreGlobs, changedFiles);
  const findings = [];
  let scannedFiles = 0;
  const seen = new Set();

  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) continue;
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
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (!line || line.length > 4000) continue;
      for (const pattern of patterns) {
        pattern.regex.lastIndex = 0;
        for (const match of line.matchAll(pattern.regex)) {
          const secret = match[0];
          const key = `${rel}:${lineIndex + 1}:${pattern.name}:${match.index}`;
          if (seen.has(key)) continue;
          seen.add(key);
          let excerpt = pattern.name === 'private-key' ? '[private key block]' : line;
          if (pattern.name !== 'private-key') {
            for (const redactor of patterns) {
              redactor.regex.lastIndex = 0;
              excerpt = excerpt.replace(redactor.regex, (value) => maskSecret(value));
            }
            excerpt = excerpt.trim().slice(0, 200);
          }
          findings.push({
            type: pattern.name,
            severity: 'error',
            file: rel,
            line: lineIndex + 1,
            excerpt
          });
          if (findings.length >= 100) break;
        }
        if (findings.length >= 100) break;
      }
      if (findings.length >= 100) break;
    }
    if (findings.length >= 100) break;
  }

  return {
    ok: findings.length === 0,
    findings,
    scannedFiles,
    skipped: false
  };
}
