import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initLlamaEngine } from '../src/core/engine.js';
import { getToolsSystemPrompt } from '../src/tools/registry.js';

describe('Конструкт АИ — Тесты планировщика (Planner)', () => {
  it(
    'Планнер должен формировать валидный JSON-план по задаче пользователя',
    { skip: process.env.RUN_LLM_TESTS !== 'true', timeout: 300_000 },
    async () => {
      const session = await initLlamaEngine();

      const plannerPrompt = `${getToolsSystemPrompt()}

    Ты — автономный агент-планировщик «Конструкт АИ». Твоя задача — проанализировать запрос пользователя и составить пошаговый план выполнения в виде строгого JSON-массива объектов следующей структуры:
    [
    { "step": 1, "tool": "имя_инструмента", "arguments": { ... }, "description": "описание шага" }
    ]

    Доступные инструменты: readFile, writeFile, runCommand.
    Если инструменты не нужны, верни пустой массив [].
    Отвечай СТРОГО в формате валидного JSON-массива, без лишнего текста и markdown-оберток, если это возможно, или внутри блоков code.

    Запрос пользователя: Создай файл "tests/sandbox/plan-test.txt" с текстом "Plan & Execute работает!" и затем прочитай его.`;

      const responseText = await session.prompt(plannerPrompt);
      console.log('   📋 Ответ планировщика:\n', responseText);

      const jsonMatch = responseText.match(/\[\s*\{[\s\S]*\}\s*\]/);
      assert.ok(jsonMatch, 'Ответ планировщика должен содержать JSON-массив шагов');

      const plan = JSON.parse(jsonMatch[0]);
      assert.ok(Array.isArray(plan), 'План должен быть массивом');
      assert.ok(plan.length >= 2, 'План должен содержать как минимум 2 шага (запись и чтение)');
      assert.equal(plan[0].tool, 'writeFile', 'Первым шагом должна быть запись файла');
      assert.equal(plan[1].tool, 'readFile', 'Вторым шагом должно быть чтение файла');

      console.log('   ✔ План успешно распарсен и верифицирован!');
    }
  );
});