// tests/plan-parser-tools.test.js
// Регрессия бага 1.1: план должен разбирать ровно тот набор инструментов,
// который объявлен в toolsRegistry (src/tools/registry.js).
// Ранее createDir отсутствовал в KNOWN_TOOLS, и шаг молча отбрасывался.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractActionPlan } from '../src/core/planParser.js';
import { toolsRegistry } from '../src/tools/registry.js';

describe('planParser: полнота набора инструментов', () => {
  test('каждый инструмент реестра разбирается в форме { step, tool, arguments }', () => {
    for (const name of Object.keys(toolsRegistry)) {
      const raw = `[{"step":1,"tool":"${name}","arguments":{}}]`;
      const plan = extractActionPlan(raw);
      assert.equal(plan.length, 1, `инструмент "${name}" не разобран: шаг отброшен`);
      assert.equal(plan[0].tool, name);
    }
  });

  test('каждый инструмент реестра разбирается в компактной форме { "toolName": {...} }', () => {
    for (const name of Object.keys(toolsRegistry)) {
      const raw = `{"${name}":{"value":1}}`;
      const plan = extractActionPlan(raw);
      assert.equal(plan.length, 1, `компактная форма "${name}" не разобрана`);
      assert.equal(plan[0].tool, name);
      assert.deepEqual(plan[0].arguments, { value: 1 });
    }
  });

  test('неизвестный инструмент отбрасывается', () => {
    assert.deepEqual(extractActionPlan('[{"step":1,"tool":"noSuchTool","arguments":{}}]'), []);
  });
});

describe('planParser: регрессия createDir', () => {
  test('createDir в массиве шагов', () => {
    const plan = extractActionPlan('[{"step":1,"tool":"createDir","arguments":{"dirPath":"new/dir"}}]');
    assert.equal(plan.length, 1);
    assert.equal(plan[0].tool, 'createDir');
    assert.equal(plan[0].arguments.dirPath, 'new/dir');
  });

  test('createDir в компактной форме', () => {
    const plan = extractActionPlan('{"createDir":{"dirPath":"new/dir"}}');
    assert.equal(plan.length, 1);
    assert.equal(plan[0].tool, 'createDir');
    assert.equal(plan[0].arguments.dirPath, 'new/dir');
  });

  test('createDir в markdown-обёртке', () => {
    const raw = 'Вот план:\n```json\n[{"step":1,"tool":"createDir","arguments":{"dirPath":"a"}}]\n```';
    const plan = extractActionPlan(raw);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].tool, 'createDir');
  });
});
