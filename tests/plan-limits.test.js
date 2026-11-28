// tests/plan-limits.test.js
// T4: Loop Guard в src/core/executor.js сверяет сигнатуры ВСЕХ шагов плана
//     (а не только шагов после самокоррекции) и останавливает повтор эквивалентного шага.
// T5: единый лимит шагов (src/core/limits.js) для src/core/planParser.js и src/core/executor.js.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { executePlan } from '../src/core/executor.js';
import { extractActionPlan } from '../src/core/planParser.js';
import { MAX_PLAN_STEPS, clampPlanSteps } from '../src/core/limits.js';
import { MAX_PLAN_STEPS as MAX_FROM_EXECUTOR } from '../src/core/executor.js';
import { MAX_PLAN_STEPS as MAX_FROM_PARSER } from '../src/core/planParser.js';
import { toolsRegistry } from '../src/tools/registry.js';

const addedTools = [];
function addFakeTool(name, execute) {
  toolsRegistry[name] = { description: `fake ${name}`, execute };
  addedTools.push(name);
}

after(() => {
  for (const name of addedTools) delete toolsRegistry[name];
});

/** Ловим предупреждения усечения, не засоряя вывод теста. */
async function withCapturedWarn(fn) {
  const original = console.warn;
  const calls = [];
  console.warn = (...args) => calls.push(args.map(String).join(' '));
  try {
    return { result: await fn(), calls };
  } finally {
    console.warn = original;
  }
}

// ─────────────────────────────────────────────────────────────
// T4: Loop Guard
// ─────────────────────────────────────────────────────────────

describe('T4: Loop Guard сверяет все шаги плана', () => {
  test('повтор идентичного шага без самокоррекции останавливает план', async () => {
    let calls = 0;
    addFakeTool('__t4_dup', async () => {
      calls += 1;
      return { success: true, result: `вызов ${calls}` };
    });

    const plan = [
      { step: 1, tool: '__t4_dup', arguments: { a: 1 }, description: 'первый' },
      { step: 2, tool: '__t4_dup', arguments: { a: 1 }, description: 'дубль' },
      { step: 3, tool: '__t4_dup', arguments: { a: 2 }, description: 'другие аргументы' }
    ];

    const report = await executePlan(plan);

    assert.equal(report.success, false, 'план должен быть остановлен');
    assert.match(report.error, /Loop Guard/, 'ошибка должна ссылаться на Loop Guard');
    assert.equal(calls, 1, 'повторный шаг не должен выполняться');
    assert.equal(report.results.length, 1, 'в results только реально выполненные шаги');
  });

  test('сообщение об остановке понятное: номер шага, позиция и инструмент', async () => {
    addFakeTool('__t4_msg', async () => ({ success: true, result: 'ok' }));

    const report = await executePlan([
      { step: 1, tool: '__t4_msg', arguments: {}, description: 'первый' },
      { step: 2, tool: '__t4_msg', arguments: {}, description: 'дубль' }
    ]);

    assert.match(report.error, /шаг 2/);
    assert.match(report.error, /позиция 2/);
    assert.match(report.error, /__t4_msg/);
    assert.match(report.error, /остановлено/i);
  });

  test('шаги с разными аргументами не считаются повтором', async () => {
    const seen = [];
    addFakeTool('__t4_distinct', async (args) => {
      seen.push(args.n);
      return { success: true, result: `ok ${args.n}` };
    });

    const plan = [1, 2, 3].map((n) => ({
      step: n,
      tool: '__t4_distinct',
      arguments: { n },
      description: `шаг ${n}`
    }));

    const report = await executePlan(plan);

    assert.equal(report.success, true, 'разные аргументы — не повторы');
    assert.deepEqual(seen, [1, 2, 3]);
  });

  test('повтор, полученный после самокоррекции, тоже ловится', async () => {
    let runs = 0;
    let fixCalls = 0;
    addFakeTool('__t4_flaky', async () => {
      runs += 1;
      return { success: false, error: 'временный сбой' };
    });

    const report = await executePlan(
      [{ step: 1, tool: '__t4_flaky', arguments: { a: 1 }, description: 'флейки' }],
      null,
      null,
      async (step) => {
        fixCalls += 1;
        // Самокоррекция вернула тот же самый шаг — прогресса нет.
        return { ...step };
      },
      true,
      2
    );

    assert.equal(fixCalls, 1, 'самокоррекция вызвана один раз');
    assert.equal(runs, 1, 'повторный запуск инструмента не состоялся');
    assert.equal(report.success, false);
    assert.match(report.error, /Loop Guard/);
  });
});

// ─────────────────────────────────────────────────────────────
// T5: единый лимит шагов
// ─────────────────────────────────────────────────────────────

describe('T5: единый лимит MAX_PLAN_STEPS', () => {
  test('executor и planParser используют одну и ту же константу', () => {
    assert.equal(MAX_FROM_EXECUTOR, MAX_PLAN_STEPS);
    assert.equal(MAX_FROM_PARSER, MAX_PLAN_STEPS);
    assert.equal(MAX_PLAN_STEPS, 128);
  });

  test('clampPlanSteps усекает план и предупреждает в логе', async () => {
    const long = Array.from({ length: MAX_PLAN_STEPS + 5 }, (_, i) => ({ step: i + 1 }));

    const { result, calls } = await withCapturedWarn(() =>
      Promise.resolve(clampPlanSteps(long, 'test'))
    );

    assert.equal(result.length, MAX_PLAN_STEPS);
    assert.equal(calls.length, 1, 'усечение не должно быть скрытым');
    assert.match(calls[0], /усечён/);
    assert.match(calls[0], new RegExp(String(MAX_PLAN_STEPS)));
  });

  test('clampPlanSteps не трогает план в пределах лимита', async () => {
    const short = Array.from({ length: 3 }, (_, i) => ({ step: i + 1 }));

    const { result, calls } = await withCapturedWarn(() => Promise.resolve(clampPlanSteps(short)));

    assert.equal(result.length, 3);
    assert.equal(calls.length, 0, 'без усечения — без предупреждений');
  });

  test('extractActionPlan больше не усекает план до 64 шагов', async () => {
    const steps = Array.from({ length: 100 }, (_, i) => ({
      step: i + 1,
      tool: 'listDir',
      arguments: { dirPath: `dir-${i}` },
      description: `просмотр dir-${i}`
    }));

    const { result, calls } = await withCapturedWarn(() =>
      Promise.resolve(extractActionPlan(JSON.stringify({ steps })))
    );

    assert.equal(result.length, 100, 'лимит парсера — 128, а не прежние 64');
    assert.equal(calls.length, 0, '100 < MAX_PLAN_STEPS — предупреждения быть не должно');
    assert.equal(result[99].step, 100, 'нумерация шагов последовательная');
  });

  test('extractActionPlan усекает сверхдлинный план с предупреждением', async () => {
    const steps = Array.from({ length: MAX_PLAN_STEPS + 20 }, (_, i) => ({
      step: i + 1,
      tool: 'listDir',
      arguments: { dirPath: `dir-${i}` },
      description: `просмотр dir-${i}`
    }));

    const { result, calls } = await withCapturedWarn(() =>
      Promise.resolve(extractActionPlan(JSON.stringify({ steps })))
    );

    assert.equal(result.length, MAX_PLAN_STEPS);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /План усечён/);
  });

  test('план из 100 шагов не отвергается исполнителем по лимиту', async () => {
    addFakeTool('__t5_ok', async (args) => ({ success: true, result: `ok ${args.n}` }));

    const plan = Array.from({ length: 100 }, (_, i) => ({
      step: i + 1,
      tool: '__t5_ok',
      arguments: { n: i },
      description: `шаг ${i + 1}`
    }));

    const report = await executePlan(plan);

    assert.equal(report.success, true, '100 <= MAX_PLAN_STEPS: отказа быть не должно');
    assert.equal(report.results.length, 100);
  });

  test('план сверх лимита отвергается с явным сообщением', async () => {
    const plan = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => ({
      step: i + 1,
      tool: '__t5_ok',
      arguments: { n: i },
      description: `шаг ${i + 1}`
    }));

    const report = await executePlan(plan);

    assert.equal(report.success, false);
    assert.match(report.error, /слишком много шагов/);
    assert.match(report.error, new RegExp(String(MAX_PLAN_STEPS)));
  });
});
