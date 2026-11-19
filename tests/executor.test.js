import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { executePlan } from '../src/core/executor.js';

describe('Конструкт АИ — Тесты исполнителя (Executor)', () => {
  it('Исполнитель должен последовательно и корректно выполнять шаги плана', async () => {
    const testFilePath = 'tests/sandbox/exec-test.txt';

    const samplePlan = [
      {
        step: 1,
        tool: 'writeFile',
        arguments: { filePath: testFilePath, content: 'Test execution content' },
        description: 'Создание тестового файла'
      },
      {
        step: 2,
        tool: 'readFile',
        arguments: { filePath: testFilePath },
        description: 'Чтение созданного файла'
      }
    ];

    try {
      const executionReport = await executePlan(samplePlan);

      assert.equal(executionReport.success, true, 'План должен выполниться успешно');
      assert.ok(Array.isArray(executionReport.results), 'Поле results должно быть массивом');
      assert.equal(executionReport.results.length, 2, 'Должно быть выполнено ровно 2 шага');
      assert.equal(executionReport.results[0].success, true, 'Шаг 1 (writeFile) должен завершиться успехом');
      assert.equal(executionReport.results[1].success, true, 'Шаг 2 (readFile) должен завершиться успехом');
      assert.equal(
        executionReport.results[1].output,
        'Test execution content',
        'Содержимое прочитанного файла должно совпадать'
      );

      console.log('   ✔ Тест исполнителя успешно пройден!');
    } finally {
      await fs.rm(path.resolve(testFilePath), { force: true }).catch(() => {});
    }
  });
});