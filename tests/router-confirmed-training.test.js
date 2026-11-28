// tests/router-confirmed-training.test.js
// Блок 6.2: дообучение нейро-роутера ТОЛЬКО по подтверждённым успехам.
// Онлайн-подкрепление применяется сразу, батч — при накоплении порога.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { NeuralSkillRouter } from '../src/core/neuralRouter.js';

// Изолированный экземпляр: свой путь весов, save() не вызывается.
const makeRouter = () =>
  new NeuralSkillRouter(path.join('tests', 'free_mode', 'router-test-weights.json'));

describe('NeuralSkillRouter: буфер подтверждённых успехов', () => {
  test('порог по умолчанию — 3, буфер пуст в начале', () => {
    const r = makeRouter();
    assert.equal(r.confirmedThreshold, 3);
    assert.deepEqual(r.confirmedSamples, []);
  });

  test('одиночный успех не обучает (pending), батч стартует на пороге', () => {
    const r = makeRouter();

    const b1 = r.recordConfirmedSuccess('Создай файл a.txt', 'file_ops');
    assert.equal(b1.trained, false);
    assert.equal(b1.reason, 'pending');
    assert.equal(b1.pending, 1);

    const b2 = r.recordConfirmedSuccess('Прочитай файл b.txt', 'system_cmd');
    assert.equal(b2.trained, false);
    assert.equal(b2.pending, 2);

    const b3 = r.recordConfirmedSuccess('Проанализируй проект', 'file_ops');
    assert.equal(b3.trained, true);
    assert.equal(b3.batchSize, 3);
    assert.deepEqual(b3.skills.sort(), ['file_ops', 'system_cmd']);
  });

  test('после батч-обучения буфер очищается', () => {
    const r = makeRouter();
    r.recordConfirmedSuccess('Привет', 'chat');
    r.recordConfirmedSuccess('Как дела', 'chat');
    r.recordConfirmedSuccess('Кто ты', 'chat');
    assert.deepEqual(r.confirmedSamples, []);
    assert.equal(r.lastBatchTrainSize, 3);
  });

  test('батч реально меняет веса роутера', () => {
    const r = makeRouter();
    const before = JSON.stringify(r.Why);

    r.recordConfirmedSuccess('git status', 'system_cmd');
    r.recordConfirmedSuccess('npm version', 'system_cmd');
    r.recordConfirmedSuccess('запусти сборку', 'system_cmd');

    const after = JSON.stringify(r.Why);
    assert.notEqual(before, after, 'веса Why должны измениться после батч-обучения');
  });

  test('некорректный ввод и неизвестный скил не попадают в буфер', () => {
    const r = makeRouter();
    assert.equal(r.recordConfirmedSuccess('', 'chat').reason, 'invalid_input');
    assert.equal(r.recordConfirmedSuccess('текст', 'no_such_skill').reason, 'unknown_skill');
    assert.equal(r.recordConfirmedSuccess(null, 'chat').reason, 'invalid_input');
    assert.deepEqual(r.confirmedSamples, [], 'буфер должен остаться пустым');
  });

  test('провал/успех не смешиваются: recordConfirmedSuccess обучает только на переданный скил', () => {
    const r = makeRouter();
    for (let i = 0; i < 3; i += 1) {
      r.recordConfirmedSuccess('Создай папку logs', 'file_ops');
    }
    // После трёх подтверждений тот же запрос уверенно маршрутизируется в file_ops.
    const decision = r.predict('Создай папку logs');
    assert.equal(decision.selectedSkill, 'file_ops');
  });
});
