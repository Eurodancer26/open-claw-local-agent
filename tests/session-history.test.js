// T6: единый учёт истории диалога.
//   - src/core/contextPruner.js — единый источник лимитов истории;
//   - src/core/engine.js — живая LlamaChatSession не накапливает историю
//     повторно (applySessionHistoryPolicy), контекст идёт в промпте;
//   - src/api/routes.js — /v1/mind отдаёт dialogHistory для клиента.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_HISTORY_MESSAGES,
  DEFAULT_MAX_HISTORY_CHARS,
  MAX_DIALOG_HISTORY_MESSAGES,
  MAX_DIALOG_HISTORY_CHARS,
  buildRecentHistoryBlock
} from '../src/core/contextPruner.js';
import { applySessionHistoryPolicy } from '../src/core/engine.js';

function createFakeSession() {
  return {
    resetCalls: 0,
    resetChatHistory() {
      this.resetCalls += 1;
    }
  };
}

describe('T6: единый источник лимитов истории', () => {
  test('MAX_DIALOG_HISTORY_* не расходятся с константами contextPruner', () => {
    assert.equal(MAX_DIALOG_HISTORY_MESSAGES, DEFAULT_MAX_HISTORY_MESSAGES);
    assert.equal(MAX_DIALOG_HISTORY_CHARS, DEFAULT_MAX_HISTORY_CHARS);
  });

  test('buildRecentHistoryBlock берёт лимиты только из переданных опций', () => {
    const messages = [
      { role: 'user', content: 'первый' },
      { role: 'assistant', content: 'второй' },
      { role: 'user', content: 'текущий' }
    ];
    const block = buildRecentHistoryBlock(messages, { maxHistoryMessages: 1 });
    assert.match(block, /первый|второй/);
    assert.doesNotMatch(block, /текущий/);
  });
});

describe('T6: сессия не ведёт вторую копию истории', () => {
  test('созданная сессия не сбрасывается (истории в ней ещё нет)', () => {
    const session = createFakeSession();
    const reset = applySessionHistoryPolicy(session, { created: true });
    assert.equal(reset, false);
    assert.equal(session.resetCalls, 0);
  });

  test('живая stateless-сессия очищается перед запросом', () => {
    const session = createFakeSession();
    const reset = applySessionHistoryPolicy(session, { created: false, stateless: true });
    assert.equal(reset, true);
    assert.equal(session.resetCalls, 1);
  });

  test('явный stateless:false отключает очистку', () => {
    const session = createFakeSession();
    const reset = applySessionHistoryPolicy(session, { created: false, stateless: false });
    assert.equal(reset, false);
    assert.equal(session.resetCalls, 0);
  });

  test('сессия без resetChatHistory безопасно пропускается', () => {
    const reset = applySessionHistoryPolicy({}, { created: false, stateless: true });
    assert.equal(reset, false);
  });

  test('null-сессия не падает', () => {
    assert.equal(applySessionHistoryPolicy(null), false);
  });
});
