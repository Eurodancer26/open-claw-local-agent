import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { executePlan } from '../src/core/executor.js';

describe('Конструкт АИ — Тесты исполнителя (Executor)', () => {
  it('Исполнитель должен последовательно и корректно выполнять шаги плана', async () => {
    const testFilePath = 'tests/sandbox/exec-test.txt';
    
    // Подготовим тестовый план
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

    const executionReport = await executePlan(samplePlan);

    assert.equal(executionReport.success, true, 'План должен выполниться успешно');
    assert.equal(executionReport.steps.length, 2, 'Должно быть выполнено ровно 2 шага');
    assert.equal(executionReport.steps[0].success, true, 'Шаг 1 (writeFile) должен завершиться успехом');
    assert.equal(executionReport.steps[1].success, true, 'Шаг 2 (readFile) должен завершиться успехом');
    assert.equal(executionReport.steps[1].result, 'Test execution content', 'Содержимое прочитанного файла должно совпадать');

    // Очищаем за собой
    await fs.rm(path.resolve(testFilePath), { force: true }).catch(() => {});
    console.log('   ✔ Тест исполнителя успешно пройден!');
  });
});