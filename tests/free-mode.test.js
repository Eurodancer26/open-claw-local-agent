// tests/free-mode.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WORKSPACE_ROOT,
  SANDBOX_DIR,
  sandboxConfig,
  resolveSafePath
} from '../src/tools/pathSecurity.js';
import { executePlan } from '../src/core/executor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FREE_DIR = path.join(WORKSPACE_ROOT, 'tests', 'free_mode');

// Все созданные файлы — удалить после прогона
const createdFiles = [];

before(async () => {
  await fs.mkdir(FREE_DIR, { recursive: true });
  await fs.mkdir(SANDBOX_DIR, { recursive: true });
});

after(async () => {
  for (const f of createdFiles) {
    await fs.rm(f, { force: true }).catch(() => {});
  }
});

// T1: режим песочницы стал per-request. Вместо мутации глобального
// sandboxConfig.strictDefault он передаётся явным параметром { strict }.
const runPlan = (plan, strict) =>
  executePlan(plan, null, null, null, false, undefined, strict);

// ─────────────────────────────────────────────────────────────
// 0. Глобальное состояние режима
// ─────────────────────────────────────────────────────────────

describe('Режим песочницы: глобальное состояние', () => {
  test('sandboxConfig заморожен — мутация на запрос невозможна', () => {
    assert.throws(() => {
      sandboxConfig.strictDefault = false;
    }, TypeError);
    assert.equal(sandboxConfig.strictDefault, true);
  });
});

// ─────────────────────────────────────────────────────────────
// 1. resolveSafePath — прямые проверки
// ─────────────────────────────────────────────────────────────

describe('Свободный режим: resolveSafePath', () => {
  test('strict — простое имя → SANDBOX_DIR', async () => {
    const p = await resolveSafePath('marker.txt', { strict: true });
    assert.equal(p, path.join(SANDBOX_DIR, 'marker.txt'));
  });

  test('strict — ../ отклоняется', async () => {
    await assert.rejects(
      () => resolveSafePath('../escape.txt', { strict: true }),
      /Нарушение безопасности/
    );
  });

  test('strict — абсолютный путь отклоняется', async () => {
    await assert.rejects(
      () => resolveSafePath('/etc/passwd', { strict: true }),
      /Нарушение безопасности/
    );
  });

  test('strict — Windows drive отклоняется', async () => {
    await assert.rejects(
      () => resolveSafePath('C:\\Windows\\System32', { strict: true }),
      /Нарушение безопасности/
    );
  });

  test('strict — UNC-путь отклоняется', async () => {
    await assert.rejects(
      () => resolveSafePath('\\\\server\\share', { strict: true }),
      /Нарушение безопасности/
    );
  });

  test('strict — null-byte отклоняется', async () => {
    await assert.rejects(
      () => resolveSafePath('a\0b.txt', { strict: true }),
      /нулевой байт/i
    );
  });

  test('free — простое имя → WORKSPACE_ROOT', async () => {
    const p = await resolveSafePath('marker.txt', { strict: false });
    assert.equal(p, path.join(WORKSPACE_ROOT, 'marker.txt'));
  });

  test('free — tests/free_mode/... → подпапка проекта', async () => {
    const p = await resolveSafePath('tests/free_mode/marker.txt', { strict: false });
    assert.equal(p, path.join(WORKSPACE_ROOT, 'tests', 'free_mode', 'marker.txt'));
  });

  test('free — sandbox-путь остаётся валидным', async () => {
    const p = await resolveSafePath('tests/sandbox/marker.txt', { strict: false });
    assert.equal(p, path.join(SANDBOX_DIR, 'marker.txt'));
  });

  test('free — выход из WORKSPACE_ROOT отклоняется', async () => {
    await assert.rejects(
      () => resolveSafePath('../outside.txt', { strict: false }),
      /Нарушение безопасности/
    );
  });

  test('free — абсолютный путь к корню диска отклоняется', async () => {
    await assert.rejects(
      () => resolveSafePath('C:\\Windows', { strict: false }),
      /Нарушение безопасности/
    );
  });
});

// ─────────────────────────────────────────────────────────────
// 2. executePlan — реальные файловые операции
// ─────────────────────────────────────────────────────────────

describe('Свободный режим: executePlan', () => {
  const freeRel = 'tests/free_mode/plan-free.txt';
  const freeAbs = path.join(FREE_DIR, 'plan-free.txt');
  createdFiles.push(freeAbs);

  test('free — writeFile вне песочницы создаёт файл', async () => {
    await fs.rm(freeAbs, { force: true });

    const r = await runPlan(
      [{ step: 1, tool: 'writeFile', arguments: { filePath: freeRel, content: 'free mode works' } }],
      false
    );
    assert.equal(r.success, true, r.error);

    const content = await fs.readFile(freeAbs, 'utf8');
    assert.equal(content, 'free mode works');
  });

  test('free — deleteFile вне песочницы удаляет файл', async () => {
    await fs.writeFile(freeAbs, 'to-delete', 'utf8');

    const r = await runPlan(
      [{ step: 1, tool: 'deleteFile', arguments: { filePath: freeRel } }],
      false
    );
    assert.equal(r.success, true, r.error);

    await assert.rejects(() => fs.access(freeAbs), /ENOENT/);
  });

  test('free — readFile вне песочницы читает файл', async () => {
    await fs.writeFile(freeAbs, 'readable content', 'utf8');

    const r = await runPlan(
      [{ step: 1, tool: 'readFile', arguments: { filePath: freeRel } }],
      false
    );
    assert.equal(r.success, true, r.error);
    assert.equal(r.results[0].rawOutput, 'readable content');
  });

  const strictName = 'plan-strict-marker.txt';
  const strictAbs = path.join(SANDBOX_DIR, strictName);
  createdFiles.push(strictAbs);

  test('strict — простое имя создаётся в SANDBOX_DIR', async () => {
    await fs.rm(strictAbs, { force: true });

    const r = await runPlan(
      [{ step: 1, tool: 'writeFile', arguments: { filePath: strictName, content: 'strict mode works' } }],
      true
    );
    assert.equal(r.success, true, r.error);

    const content = await fs.readFile(strictAbs, 'utf8');
    assert.equal(content, 'strict mode works');
  });

  test('strict — ../ проваливается с понятной ошибкой', async () => {
    const r = await runPlan(
      [{ step: 1, tool: 'writeFile', arguments: { filePath: '../strict-escape.txt', content: 'nope' } }],
      true
    );
    assert.equal(r.success, false);
    assert.match(r.error, /Нарушение безопасности|песочниц/i);
  });

  test('free — ../ тоже проваливается (не выходим за WORKSPACE_ROOT)', async () => {
    const r = await runPlan(
      [{ step: 1, tool: 'writeFile', arguments: { filePath: '../free-escape.txt', content: 'nope' } }],
      false
    );
    assert.equal(r.success, false);
    assert.match(r.error, /Нарушение безопасности/);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Параллельные запросы с разными режимами
// ─────────────────────────────────────────────────────────────

describe('Параллельные запросы: разные режимы не перетирают друг друга', () => {
  const freeRel = 'tests/free_mode/parallel-free.txt';
  const freeAbs = path.join(FREE_DIR, 'parallel-free.txt');
  const strictName = 'parallel-strict-marker.txt';
  const strictAbs = path.join(SANDBOX_DIR, strictName);
  createdFiles.push(freeAbs, strictAbs);

  test('free и strict одновременно — каждый пишет в свой корень', async () => {
    await fs.rm(freeAbs, { force: true });
    await fs.rm(strictAbs, { force: true });

    const [freeRes, strictRes] = await Promise.all([
      runPlan(
        [{ step: 1, tool: 'writeFile', arguments: { filePath: freeRel, content: 'parallel free' } }],
        false
      ),
      runPlan(
        [{ step: 1, tool: 'writeFile', arguments: { filePath: strictName, content: 'parallel strict' } }],
        true
      )
    ]);

    assert.equal(freeRes.success, true, freeRes.error);
    assert.equal(strictRes.success, true, strictRes.error);

    assert.equal(await fs.readFile(freeAbs, 'utf8'), 'parallel free');
    assert.equal(await fs.readFile(strictAbs, 'utf8'), 'parallel strict');
  });

  test('free-режим не «протекает» в соседний strict-вызов', async () => {
    const rel = 'tests/free_mode/leak.txt';
    const relAbsInRoot = path.join(WORKSPACE_ROOT, 'tests', 'free_mode', 'leak.txt');
    // В strict тот же относительный путь уезжает внутрь песочницы
    const relAbsInSandbox = path.join(SANDBOX_DIR, 'tests', 'free_mode', 'leak.txt');
    createdFiles.push(relAbsInSandbox);
    await fs.rm(relAbsInRoot, { force: true });
    await fs.rm(relAbsInSandbox, { force: true });

    // В strict-запуске путь, который free-запрос пишет в корень проекта,
    // не должен оказаться в корне: strict не подменяется режимом соседа.
    const [freeRes, strictRes] = await Promise.all([
      runPlan(
        [{ step: 1, tool: 'writeFile', arguments: { filePath: freeRel, content: 'isolation ok' } }],
        false
      ),
      runPlan(
        [{ step: 1, tool: 'writeFile', arguments: { filePath: rel, content: 'should land in sandbox' } }],
        true
      )
    ]);

    assert.equal(freeRes.success, true, freeRes.error);
    assert.equal(strictRes.success, true, strictRes.error);

    // free-запись — в корне проекта
    assert.equal(await fs.readFile(freeAbs, 'utf8'), 'isolation ok');
    // strict-запись — только внутри песочницы, в корне её нет
    assert.equal(await fs.readFile(relAbsInSandbox, 'utf8'), 'should land in sandbox');
    await assert.rejects(() => fs.access(relAbsInRoot), /ENOENT/);
  });
});

// ─────────────────────────────────────────────────────────────
// 4. HTTP API с LLM (скипается без RUN_LLM_TESTS=true)
// ─────────────────────────────────────────────────────────────

describe(
  'Свободный режим: HTTP API (LLM)',
  { skip: !process.env.RUN_LLM_TESTS },
  () => {
    const BASE = 'http://127.0.0.1:3000';
    const waitForFile = async (abs, timeoutMs = 3000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          return await fs.readFile(abs, 'utf8');
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      return null;
    };

    test('free — API создаёт файл вне песочницы', async () => {
      const rel = 'tests/free_mode/api-free.txt';
      const abs = path.join(FREE_DIR, 'api-free.txt');
      createdFiles.push(abs);
      await fs.rm(abs, { force: true });

      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: `Создай файл "${rel}" с текстом "api-free works"` }],
          stream: false,
          strictSandbox: false
        })
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.choices?.[0]?.message?.content, 'пустой ответ модели');

      const content = await waitForFile(abs);
      assert.ok(content !== null, `Файл ${abs} не создан`);
      assert.match(content, /api-free works/);
    });

    test('strict — тот же запрос создаёт файл в песочнице', async () => {
      const name = 'api-strict-marker.txt';
      const abs = path.join(SANDBOX_DIR, name);
      createdFiles.push(abs);
      await fs.rm(abs, { force: true });

      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: `Создай файл "${name}" с текстом "api-strict works"` }],
          stream: false,
          strictSandbox: true
        })
      });

      assert.equal(res.status, 200);

      const content = await waitForFile(abs);
      assert.ok(content !== null, `Файл ${abs} не создан в песочнице`);
      assert.match(content, /api-strict works/);
    });
  }
);
