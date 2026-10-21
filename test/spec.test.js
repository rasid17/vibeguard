import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSpec, specTemplate } from '../src/spec.js';
import { validSpec } from './helpers.js';

test('template spec is rejected until placeholders are removed', () => {
  const check = checkSpec(specTemplate('Demo'));
  assert.equal(check.ok, false);
  assert.ok(check.empty.length > 0);
  assert.ok(check.placeholders.some((item) => item.reason.includes('komentar template')));
});

test('a filled spec passes', () => {
  const check = checkSpec(validSpec());
  assert.equal(check.ok, true, JSON.stringify(check, null, 2));
  assert.equal(check.title, 'Spec — Test Project');
});

test('missing non-goals fails validation', () => {
  const spec = validSpec().replace(/## Non-goals[\s\S]*?(?=## Users)/, '');
  const check = checkSpec(spec);
  assert.equal(check.ok, false);
  assert.ok(check.missing.some((item) => item.key === 'nonGoals'));
});

test('TODO placeholders fail validation', () => {
  const spec = `${validSpec()}\nTODO: finish this section\n`;
  const check = checkSpec(spec);
  assert.equal(check.ok, false);
  assert.ok(check.placeholders.some((item) => item.reason.includes('TODO')));
});

test('code fences do not trigger placeholder checks', () => {
  const spec = `${validSpec()}\n## Technical notes\n\n\`\`\`sh\n# TODO in an example command is allowed\n\`\`\`\n`;
  const check = checkSpec(spec);
  assert.equal(check.ok, true, JSON.stringify(check.placeholders));
});
