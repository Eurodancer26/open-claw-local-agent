// tests/search-in-files.test.js
// Блок 6.1: регрессия инструмента searchInFiles — безопасный поиск по содержимому.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { WORKSPACE_ROOT } from '../src/tools/pathSecurity.js';
import { executePlan } from '../src/core/executor.js';
import { toolsRegistry } from '../src/tools/registry.js';

const PROBE_REL = 'tests/free_mode/search-probe';
const PROBE_DIR = path.join(WORKSPACE_ROOT, 'tests', 'free_mode', 'search-probe');

before(async () => {
  await fs.mkdir(PROBE_DIR, { recursive: true });
});

after(async () => {
  await fs.rm(PROBE_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('searchInFiles: прямой вызов инструмента', () => {
  test('отсутствие query — понятная ошибка', async () => {
    const r = await toolsRegistry.searchInFiles.execute({}, { strict: false });
    assert.equal(r.success, false);
    assert.match(r.error, /query/);
  });

  test('поиск подстроки без учёта регистра', async () => {
    const abs = path.join(PROBE_DIR, 'alpha.txt');
    await fs.writeFile(abs, 'Hello WORLD\nsecond line\n', 'utf8');

    const r = await toolsRegistry.searchInFiles.execute(
      { query: 'world', dirPath: PROBE_REL },
      { strict: false }
    );
    assert.equal(r.success, true, r.error);
    assert.equal(r.totalMatches, 1);
    assert.equal(r.results[0].line, 1);
    assert.match(r.results[0].file, /alpha\.txt$/);
  });

  test('regex-режим находит по шаблону', async () => {
    const abs = path.join(PROBE_DIR, 'regex.txt');
    await fs.writeFile(abs, 'const fixBug42 = 1;\nconst other = 2;\n', 'utf8');

    const r = await toolsRegistry.searchInFiles.execute(
      { query: 'fixBug\\d+', regex: true, dirPath: PROBE_REL },
      { strict: false }
    );
    assert.equal(r.success, true, r.error);
    assert.equal(r.totalMatches, 1);
    assert.equal(r.results[0].line, 1);
  });

  test('некорректный regex — ошибка, а не падение', async () => {
    const r = await toolsRegistry.searchInFiles.execute(
      { query: '([', regex: true, dirPath: PROBE_REL },
      { strict: false }
    );
    assert.equal(r.success, false);
    assert.match(r.error, /регулярное выражение|regex/i);
  });

  test('node_modules игнорируется', async () => {
    const hidden = path.join(PROBE_DIR, 'node_modules', 'hidden.txt');
    const visible = path.join(PROBE_DIR, 'visible.txt');
    await fs.mkdir(path.dirname(hidden), { recursive: true });
    await fs.writeFile(hidden, 'ZQTOKEN hidden\n', 'utf8');
    await fs.writeFile(visible, 'ZQTOKEN visible\n', 'utf8');

    const r = await toolsRegistry.searchInFiles.execute(
      { query: 'ZQTOKEN', dirPath: PROBE_REL },
      { strict: false }
    );
    assert.equal(r.success, true, r.error);
    const files = r.results.map((x) => x.file);
    assert.ok(
      files.some((f) => /visible\.txt$/.test(f)),
      'visible.txt не найден'
    );
    assert.ok(!files.some((f) => /hidden\.txt$/.test(f)), 'node_modules не был исключён');
  });

  test('maxResults ограничивает выдачу и помечает truncated', async () => {
    const abs = path.join(PROBE_DIR, 'many.txt');
    const body = Array.from({ length: 10 }, (_, i) => 'HITMSG line ' + i).join('\n') + '\n';
    await fs.writeFile(abs, body, 'utf8');

    const r = await toolsRegistry.searchInFiles.execute(
      { query: 'HITMSG line', dirPath: PROBE_REL, maxResults: 3 },
      { strict: false }
    );
    assert.equal(r.success, true, r.error);
    assert.equal(r.results.length, 3);
    assert.equal(r.truncated, true);
  });

  test('strict — поиск ограничен песочницей (нет утечки из корня проекта)', async () => {
    const r = await toolsRegistry.searchInFiles.execute(
      { query: 'ZQ_SANDBOX_LEAK_PROBE_TOKEN', dirPath: '.' },
      { strict: true }
    );
    assert.equal(r.success, true, r.error);
    assert.equal(r.results.length, 0);
  });
});

describe('searchInFiles: интеграция с executePlan', () => {
  test('шаг searchInFiles выполняется в плане', async () => {
    const abs = path.join(PROBE_DIR, 'plan.txt');
    await fs.writeFile(abs, 'plan-search needle\n', 'utf8');

    const r = await executePlan(
      [{ step: 1, tool: 'searchInFiles', arguments: { query: 'needle', dirPath: PROBE_REL } }],
      null,
      null,
      null,
      false,
      undefined,
      false
    );
    assert.equal(r.success, true, r.error);
    assert.match(r.results[0].rawOutput, /needle/i);
  });

  test('пустой query отклоняется валидатором executor', async () => {
    const r = await executePlan(
      [{ step: 1, tool: 'searchInFiles', arguments: { dirPath: '.' } }],
      null,
      null,
      null,
      false,
      undefined,
      false
    );
    assert.equal(r.success, false);
    assert.match(r.error, /query/);
  });
});
