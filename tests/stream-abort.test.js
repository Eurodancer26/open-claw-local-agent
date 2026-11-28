// tests/stream-abort.test.js
// T3: обрыв соединения клиента в стриминговых ветках.
//   - src/api/streamGuard.js — guard поверх res 'close' / req 'aborted';
//   - src/core/executor.js — AbortSignal обрывает план, не оставляя «зомби»-шагов;
//   - src/tools/{safeCommands,registry}.js — AbortSignal убивает дочерний процесс;
//   - src/core/mutex.js — releaseGpuOnce() не разблокирует gpuMutex дважды.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  createClientAbortGuard,
  createAbortError,
  raceAgainstClientAbort
} from '../src/api/streamGuard.js';
import { executePlan, getActiveExecutionSignal } from '../src/core/executor.js';
import { toolsRegistry } from '../src/tools/registry.js';
import { runSafeCommand } from '../src/tools/safeCommands.js';
import { gpuMutex } from '../src/core/mutex.js';

/** Минимальная заглушка req/res: нужны только события write/end/close/aborted. */
function createFakeReqRes() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.chunks = [];
  res.write = (chunk) => {
    res.chunks.push(chunk);
    return true;
  };
  res.end = () => {
    res.writableEnded = true;
    return res;
  };
  return { req, res };
}

const addedTools = [];
function addFakeTool(name, execute) {
  toolsRegistry[name] = { description: `fake ${name}`, execute };
  addedTools.push(name);
}

after(() => {
  for (const name of addedTools) delete toolsRegistry[name];
});

const runPlan = (plan, { strict, signal, onProgress } = {}) =>
  executePlan(plan, onProgress ?? null, null, null, false, undefined, strict, { signal });

// ─────────────────────────────────────────────────────────────
// 1. streamGuard: определение обрыва
// ─────────────────────────────────────────────────────────────

describe('streamGuard: обрыв соединения', () => {
  test('createAbortError помечает ошибку как AbortError', () => {
    const err = createAbortError('своё сообщение');
    assert.equal(err.name, 'AbortError');
    assert.equal(err.message, 'своё сообщение');
    assert.ok(createAbortError() instanceof Error);
  });

  test('res close при !writableEnded → клиент ушёл, signal aborted', () => {
    const { req, res } = createFakeReqRes();
    const guard = createClientAbortGuard(req, res);

    assert.equal(guard.clientGone, false);
    assert.equal(guard.signal.aborted, false);

    res.emit('close');

    assert.equal(guard.clientGone, true);
    assert.equal(guard.signal.aborted, true);
    assert.equal(guard.signal.reason.name, 'AbortError');
    guard.dispose();
  });

  test('штатный res.end() (writableEnded) обрывом не считается', () => {
    const { req, res } = createFakeReqRes();
    const guard = createClientAbortGuard(req, res);

    assert.equal(guard.end('data: [DONE]\n\n'), true);
    res.emit('close');

    assert.equal(guard.clientGone, false);
    assert.equal(guard.signal.aborted, false);
    assert.equal(res.chunks.at(-1), 'data: [DONE]\n\n');
    guard.dispose();
  });

  test('legacy req aborted → клиент ушёл', () => {
    const { req, res } = createFakeReqRes();
    const guard = createClientAbortGuard(req, res);

    req.emit('aborted');

    assert.equal(guard.clientGone, true);
    assert.equal(guard.signal.aborted, true);
    guard.dispose();
  });

  test('запись в мёртвый ответ молча пропускается (res.writableEnded/res.destroyed)', () => {
    const { req, res } = createFakeReqRes();
    const guard = createClientAbortGuard(req, res);

    res.emit('close');
    assert.equal(guard.send('data: x\n\n'), false);
    assert.equal(guard.end(), false);
    assert.equal(res.chunks.length, 0);

    const second = createFakeReqRes();
    const guard2 = createClientAbortGuard(second.req, second.res);
    second.res.destroyed = true;
    assert.equal(guard2.isResponseWritable(), false);
    assert.equal(guard2.send('data: y\n\n'), false);
    guard.dispose();
    guard2.dispose();
  });

  test('ошибка res.write помечает клиента ушедшим и не бросает наружу', () => {
    const { req, res } = createFakeReqRes();
    res.write = () => {
      throw new Error('EPIPE');
    };
    const guard = createClientAbortGuard(req, res);

    assert.equal(guard.send('data: x\n\n'), false);
    assert.equal(guard.clientGone, true);
    assert.equal(guard.signal.aborted, true);
    guard.dispose();
  });

  test('onClientGone вызывается один раз; dispose() отключает наблюдение', () => {
    const { req, res } = createFakeReqRes();
    const guard = createClientAbortGuard(req, res);

    let calls = 0;
    guard.onClientGone(() => {
      calls += 1;
    });

    res.emit('close');
    res.emit('close');
    req.emit('aborted');
    assert.equal(calls, 1, 'колбэк должен вызываться ровно один раз');

    const other = createFakeReqRes();
    const guard2 = createClientAbortGuard(other.req, other.res);
    guard2.dispose();
    other.res.emit('close');
    assert.equal(guard2.clientGone, false, 'после dispose() guard не реагирует');

    guard.dispose();
  });

  test('raceAgainstClientAbort отклоняет AbortError при обрыве', async () => {
    const { req, res } = createFakeReqRes();
    const guard = createClientAbortGuard(req, res);

    // unref: тест не должен ждать 5 секунд, обрыв всё равно побеждает в гонке.
    const operation = new Promise((resolve) => {
      const timer = setTimeout(() => resolve('готово'), 5_000);
      timer.unref?.();
    });
    const raced = raceAgainstClientAbort(operation, guard);

    res.emit('close');
    await assert.rejects(raced, (err) => err.name === 'AbortError');
    guard.dispose();
  });

  test('raceAgainstClientAbort отдаёт результат, если клиент на связи', async () => {
    const { req, res } = createFakeReqRes();
    const guard = createClientAbortGuard(req, res);

    const result = await raceAgainstClientAbort(Promise.resolve('ok'), guard);
    assert.equal(result, 'ok');
    guard.dispose();
  });
});

// ─────────────────────────────────────────────────────────────
// 2. executor: сигнал обрыва останавливает план
// ─────────────────────────────────────────────────────────────

describe('executor: обрыв клиента', () => {
  test('сигнал снимается на выходе из executePlan (нет утечки controller)', async () => {
    addFakeTool('__fake_noop', async () => ({ success: true, result: 'ok' }));
    assert.equal(getActiveExecutionSignal(), null);

    await runPlan([{ step: 1, tool: '__fake_noop', arguments: {}, description: 'noop' }]);

    assert.equal(getActiveExecutionSignal(), null);
  });

  test('обрыв после первого шага не выполняет оставшиеся', async () => {
    let calls = 0;
    addFakeTool('__fake_count', async () => {
      calls += 1;
      return { success: true, result: `шаг ${calls}` };
    });

    const controller = new AbortController();
    const plan = [
      { step: 1, tool: '__fake_count', arguments: {}, description: 'первый' },
      { step: 2, tool: '__fake_count', arguments: {}, description: 'второй' },
      { step: 3, tool: '__fake_count', arguments: {}, description: 'третий' }
    ];

    const report = await runPlan(plan, {
      onProgress: (event) => {
        if (event.type === 'step_start' && event.step === 1) controller.abort(createAbortError());
      },
      signal: controller.signal
    });

    assert.equal(report.success, false);
    assert.equal(report.aborted, true);
    assert.match(report.error, /прерван/i);
    assert.equal(calls, 1, 'выполнен только первый шаг');
    assert.equal(report.results.length, 1);
  });

  test('уже отменённый signal не запускает ни одного шага', async () => {
    let calls = 0;
    addFakeTool('__fake_count2', async () => {
      calls += 1;
      return { success: true, result: 'ok' };
    });

    const controller = new AbortController();
    controller.abort(createAbortError());

    const report = await runPlan(
      [{ step: 1, tool: '__fake_count2', arguments: {}, description: 'шаг' }],
      { signal: controller.signal }
    );

    assert.equal(report.aborted, true);
    assert.equal(calls, 0);
    assert.equal(report.results.length, 0);
  });

  test('AbortError из onProgress останавливает план (не глотается safeProgress)', async () => {
    let calls = 0;
    addFakeTool('__fake_throw_abort', async () => {
      calls += 1;
      return { success: true, result: 'ok' };
    });

    await assert.rejects(
      () =>
        runPlan(
          [
            { step: 1, tool: '__fake_throw_abort', arguments: {}, description: 'первый' },
            { step: 2, tool: '__fake_throw_abort', arguments: {}, description: 'второй' }
          ],
          {
            onProgress: (event) => {
              if (event.type === 'step_start') throw createAbortError();
            }
          }
        ),
      (err) => err.name === 'AbortError'
    );

    assert.equal(calls, 0, 'прерывание на step_start не должно запускать инструмент');
    assert.equal(getActiveExecutionSignal(), null, 'controller снимается и при выброшенном AbortError');
  });

  test('aborted-результат инструмента прерывает план и запрещает самокоррекцию', async () => {
    let fixCalls = 0;
    let secondStepCalls = 0;
    addFakeTool('__fake_aborted_tool', async () => ({
      success: false,
      aborted: true,
      error: 'Генерация прервана: клиент разорвал соединение'
    }));
    addFakeTool('__fake_after', async () => {
      secondStepCalls += 1;
      return { success: true, result: 'ok' };
    });

    const report = await executePlan(
      [
        { step: 1, tool: '__fake_aborted_tool', arguments: {}, description: 'обрыв' },
        { step: 2, tool: '__fake_after', arguments: {}, description: 'после' }
      ],
      null,
      null,
      async () => {
        fixCalls += 1;
        return null;
      },
      true,
      2
    );

    assert.equal(report.aborted, true);
    assert.equal(fixCalls, 0, 'прерывание — не повод звать самокоррекцию');
    assert.equal(secondStepCalls, 0);
    assert.equal(report.results.length, 0, 'прерванный шаг не попадает в results');
    assert.match(report.error, /прерван/i);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. runSafeCommand / runCommand: остановка дочернего процесса
// ─────────────────────────────────────────────────────────────

describe('runCommand: остановка по AbortSignal', () => {
  test('уже отменённый signal — команда не запускается', async () => {
    const controller = new AbortController();
    controller.abort(createAbortError());

    await assert.rejects(
      () => runSafeCommand('node-version', { strict: false, signal: controller.signal }),
      (err) => err.name === 'AbortError'
    );
  });

  test('инструмент runCommand возвращает aborted вместо обычной ошибки', async () => {
    const controller = new AbortController();
    controller.abort(createAbortError());

    const res = await toolsRegistry.runCommand.execute(
      { commandId: 'node-version' },
      { strict: false, signal: controller.signal }
    );

    assert.equal(res.success, false);
    assert.equal(res.aborted, true);
    assert.match(res.error, /прерван/i);
  });

  test('штатный запуск по-прежнему работает', async () => {
    const controller = new AbortController();
    const res = await toolsRegistry.runCommand.execute(
      { commandId: 'node-version' },
      { strict: false, signal: controller.signal }
    );
    assert.equal(res.success, true);
    assert.match(res.stdout.trim(), /^v\d+\.\d+\.\d+/);
  });
});

// ─────────────────────────────────────────────────────────────
// 4. gpuMutex: releaseGpuOnce() освобождает слот ровно один раз
// ─────────────────────────────────────────────────────────────

describe('gpuMutex: однократный release при обрыве', () => {
  test('двойной releaseGpuOnce() не пропускает второго ожидающего вперёд третьего', async () => {
    // Повторяем схему маршрута: releaseGpuOnce() защищён флагом mutexReleased.
    await gpuMutex.acquire();
    let mutexReleased = false;
    const releaseGpuOnce = () => {
      if (!mutexReleased) {
        mutexReleased = true;
        gpuMutex.release();
      }
    };

    let secondAcquired = false;
    const second = gpuMutex.acquire().then(() => {
      secondAcquired = true;
    });
    let thirdAcquired = false;
    const third = gpuMutex.acquire().then(() => {
      thirdAcquired = true;
    });

    // Обрыв клиента: finally вызывает releaseGpuOnce(), а catch мог бы вызвать ещё раз.
    releaseGpuOnce();
    releaseGpuOnce();
    await second;

    assert.equal(secondAcquired, true, 'второй ожидающий должен получить слот');
    assert.equal(thirdAcquired, false, 'третий ожидающий не должен получить слот от двойного release');
    assert.equal(mutexReleased, true);

    gpuMutex.release(); // отпускаем за второй запрос
    await third;
    assert.equal(thirdAcquired, true);
    gpuMutex.release();
  });
});
