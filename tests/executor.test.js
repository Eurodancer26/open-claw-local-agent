import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { executePlan } from '../src/core/executor.js';

describe('Конструкт АИ — Тесты исполнителя (Executor)', () => {
  it('Исполнитель должен последовательно выполнять шаги и пробрасывать {{stepN.output}}', async () => {
    const firstFilePath = 'tests/sandbox/exec-step1.txt';
    const secondFilePath = 'tests/sandbox/exec-step2.txt';

    const samplePlan = [
      {
        step: 1,
        tool: 'writeFile',
        arguments: { filePath: firstFilePath, content: 'Payload from step 1' },
        description: 'Создание первого файла'
      },
      {
        step: 2,
        tool: 'readFile',
        arguments: { filePath: firstFilePath },
        description: 'Чтение первого файла'
      },
      {
        step: 3,
        tool: 'writeFile',
        arguments: {
          filePath: secondFilePath,
          content: 'Copied: {{step2.output}}'
        },
        description: 'Запись результата шага 2 во второй файл'
      }
    ];

    try {
      const executionReport = await executePlan(samplePlan);

      assert.equal(executionReport.success, true, 'План должен выполниться успешно');
      assert.ok(Array.isArray(executionReport.results), 'Поле results должно быть массивом');
      assert.equal(executionReport.results.length, 3, 'Должно быть выполнено ровно 3 шага');
      assert.equal(executionReport.results[0].success, true, 'Шаг 1 (writeFile) должен завершиться успехом');
      assert.equal(executionReport.results[1].output, 'Payload from step 1', 'Содержимое первого файла должно совпадать');
      assert.equal(executionReport.results[2].success, true, 'Шаг 3 (writeFile с плейсхолдером) должен завершиться успехом');

      const copiedContent = await fs.readFile(path.resolve(secondFilePath), 'utf8');
      assert.equal(copiedContent, 'Copied: Payload from step 1', 'Плейсхолдер {{step2.output}} должен подставиться корректно');

      console.log('   ✔ Тест исполнителя и проброса результатов успешно пройден!');
    } finally {
      await fs.rm(path.resolve(firstFilePath), { force: true }).catch(() => {});
      await fs.rm(path.resolve(secondFilePath), { force: true }).catch(() => {});
    }
  });
});