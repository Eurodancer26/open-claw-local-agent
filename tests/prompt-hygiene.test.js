// tests/prompt-hygiene.test.js
// Регрессия: в промптах не должно оставаться служебных маркеров-заглушек
// (баг 6.1: литерал `<<<FILE:...>>>` попал в правило 9 chatFormatter.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildCognitivePrompt, buildNonStreamPrompt } from '../src/api/chatFormatter.js';
import { getToolsSystemPrompt } from '../src/tools/registry.js';

const baseArgs = {
  currentMode: 'free',
  strictDefault: false,
  toolsPrompt: getToolsSystemPrompt(),
  routingDecision: { selectedSkill: 'chat', confidence: 0.9, mode: 'chat' },
  mindSummary: 'История размышлений пуста.',
  recentHistoryBlock: '',
  userMessage: 'создай файл demo.js'
};

describe('Гигиена промптов', () => {
  test('в cognitive-промпте нет маркеров-заглушек', () => {
    const prompt = buildCognitivePrompt(baseArgs);
    assert.doesNotMatch(prompt, /<<<FILE:/, 'в промпте остался служебный маркер');
    assert.doesNotMatch(prompt, /\{\{[^}]*\}\}<<</);
  });

  test('в non-stream-промпте нет маркеров-заглушек', () => {
    const prompt = buildNonStreamPrompt(baseArgs);
    assert.doesNotMatch(prompt, /<<<FILE:/);
  });

  test('правило 9 упоминает searchInFiles', () => {
    const prompt = buildCognitivePrompt(baseArgs);
    assert.match(prompt, /searchInFiles/);
    assert.match(prompt, /аналог grep/);
  });

  test('каталог инструментов содержит все ключи реестра', () => {
    const catalog = getToolsSystemPrompt();
    assert.match(catalog, /РОВНО 9/);
  });
});
