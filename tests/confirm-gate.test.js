// tests/confirm-gate.test.js
// Блок 6.3: серверный гейт подтверждения опасных действий (deleteFile) в свободном режиме.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ConfirmGate } from '../src/api/confirmGate.js';
import { executePlan } from '../src/core/executor.js';
import { WORKSPACE_ROOT } from '../src/tools/pathSecurity.js';

const FREE_DIR = path.join(WORKSPACE_ROOT, 'tests', 'free_mode');

before(async () => {
  await fs.mkdir(FREE_DIR, { recursive: true });
});

after(async () => {
  await fs.rm(path.join(FREE_DIR, 'confirm-probe.txt'), { force: true }).catch(() => {});
});

describe('ConfirmGate', () => {
  test('подтверждение разрешает действие', async () => {
    const gate = new ConfirmGate();
    const seen = [];
    const p = gate.request({ tool: 'deleteFile' }, (id, payload) => seen.push({ id, payload }));
    assert.equal(gate.size, 1);
    const { id } = seen[0];
    assert.ok(id, 'id запроса должен быть сгенерирован');
    assert.equal(seen[0].payload.tool, 'deleteFile');

    assert.equal(gate.settle(id, true), true);
    const verdict = await p;
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reason, 'approved');
    assert.equal(gate.size, 0);
  });

  test('отказ блокирует действие', async () => {
    const gate = new ConfirmGate();
    let id = null;
    const p = gate.request({ tool: 'deleteFile' }, (rid) => {
      id = rid;
    });
    gate.settle(id, false);
    const verdict = await p;
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'denied');
  });

  test('таймаут — безопасный отказ', async () => {
    const gate = new ConfirmGate(20);
    const p = gate.request({ tool: 'deleteFile' }, () => {});
    const verdict = await p;
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'timeout');
  });

  test('settle по неизвестному id возвращает false', () => {
    const gate = new ConfirmGate();
    assert.equal(gate.settle('no-such-id', true), false);
  });

  test('обрыв клиента (abort) — немедленный отказ', async () => {
    const gate = new ConfirmGate(5000);
    const controller = new AbortController();
    const p = gate.request({ tool: 'deleteFile' }, () => {}, controller.signal);
    controller.abort();
    const verdict = await p;
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'aborted');
    assert.equal(gate.size, 0);
  });

  test('уже прерванный сигнал — отказ без запроса', async () => {
    const gate = new ConfirmGate(5000);
    const controller = new AbortController();
    controller.abort();
    let requested = false;
    const verdict = await gate.request(
      { tool: 'deleteFile' },
      () => {
        requested = true;
      },
      controller.signal
    );
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'aborted');
    assert.equal(requested, false, 'событие не должно отправляться после обрыва');
  });
});

describe('executePlan: хук подтверждения опасных действий', () => {
  const rel = 'tests/free_mode/confirm-probe.txt';
  const abs = path.join(FREE_DIR, 'confirm-probe.txt');

  test('отказ подтверждения блокирует deleteFile, файл остаётся', async () => {
    await fs.writeFile(abs, 'keep me', 'utf8');
    let asked = 0;

    const r = await executePlan(
      [{ step: 1, tool: 'deleteFile', arguments: { filePath: rel } }],
      null,
      null,
      null,
      false,
      undefined,
      false,
      {
        confirmStep: async () => {
          asked += 1;
          return { allowed: false };
        }
      }
    );

    assert.equal(asked, 1, 'хук подтверждения должен быть вызван один раз');
    assert.equal(r.success, false);
    assert.match(r.error, /не подтверждено/i);
    await fs.access(abs); // файл на месте
  });

  test('подтверждение разрешает deleteFile', async () => {
    await fs.writeFile(abs, 'delete me', 'utf8');

    const r = await executePlan(
      [{ step: 1, tool: 'deleteFile', arguments: { filePath: rel } }],
      null,
      null,
      null,
      false,
      undefined,
      false,
      { confirmStep: async () => ({ allowed: true }) }
    );

    assert.equal(r.success, true, r.error);
    await assert.rejects(() => fs.access(abs), /ENOENT/);
  });

  test('без confirmStep в options опасное действие не спрашивает и выполняется', async () => {
    await fs.writeFile(abs, 'no gate', 'utf8');
    const r = await executePlan(
      [{ step: 1, tool: 'deleteFile', arguments: { filePath: rel } }],
      null,
      null,
      null,
      false,
      undefined,
      false
    );
    assert.equal(r.success, true, r.error);
  });

  test('безопасный инструмент не вызывает confirmStep', async () => {
    let asked = 0;
    const r = await executePlan(
      [{ step: 1, tool: 'writeFile', arguments: { filePath: rel, content: 'safe' } }],
      null,
      null,
      null,
      false,
      undefined,
      false,
      {
        confirmStep: async () => {
          asked += 1;
          return { allowed: true };
        }
      }
    );
    assert.equal(r.success, true, r.error);
    assert.equal(asked, 0, 'writeFile не должен требовать подтверждения');
  });
});
