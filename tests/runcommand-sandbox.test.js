// tests/runcommand-sandbox.test.js
// T2: runCommand в strict-режиме не должен отдавать данные вне tests/sandbox.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { WORKSPACE_ROOT, SANDBOX_DIR } from '../src/tools/pathSecurity.js';
import {
  SAFE_COMMANDS,
  getStrictCommandPolicy,
  listStrictAllowedCommands,
  resolveCommandCwd,
  runSafeCommand
} from '../src/tools/safeCommands.js';
import { toolsRegistry } from '../src/tools/registry.js';
import { executePlan } from '../src/core/executor.js';

const ROOT_MARKER = path.join(WORKSPACE_ROOT, 'rc-root-marker.txt');
const SANDBOX_MARKER = path.join(SANDBOX_DIR, 'rc-sandbox-marker.txt');

const runPlan = (plan, strict) => executePlan(plan, null, null, null, false, undefined, strict);

const created = [];

after(async () => {
  for (const p of created) {
    await fs.rm(p, { force: true, recursive: true }).catch(() => {});
  }
});

describe('T2: политика команд по режимам', () => {
  test('git-status и git-diff запрещены в strict', () => {
    assert.equal(getStrictCommandPolicy('git-status'), 'deny');
    assert.equal(getStrictCommandPolicy('git-diff'), 'deny');
    assert.equal(SAFE_COMMANDS['git-status'].strictAllowed, false);
    assert.equal(SAFE_COMMANDS['git-diff'].strictAllowed, false);
  });

  test('безопасные команды разрешены в strict, неизвестная — unknown', () => {
    assert.equal(getStrictCommandPolicy('node-version'), 'allow');
    assert.equal(getStrictCommandPolicy('npm-version'), 'allow');
    assert.equal(getStrictCommandPolicy('dir-list'), 'allow');
    assert.equal(getStrictCommandPolicy('rm -rf /'), 'unknown');

    const allowed = listStrictAllowedCommands();
    assert.ok(allowed.includes('node-version'));
    assert.ok(allowed.includes('dir-list'));
    assert.ok(!allowed.includes('git-status'));
    assert.ok(!allowed.includes('git-diff'));
  });

  test('рабочая директория зависит от режима', () => {
    assert.equal(resolveCommandCwd(true), SANDBOX_DIR);
    assert.equal(resolveCommandCwd(false), WORKSPACE_ROOT);
  });
});

describe('T2: runSafeCommand', () => {
  test('strict: git-status/git-diff отклоняются до запуска процесса', async () => {
    for (const id of ['git-status', 'git-diff']) {
      await assert.rejects(
        () => runSafeCommand(id, { strict: true }),
        /запрещена в строгом режиме песочницы/
      );
    }
  });

  test('free: git-status выполняется как раньше', async () => {
    const { stdout } = await runSafeCommand('git-status', { strict: false });
    assert.equal(typeof stdout, 'string');
  });

  test('strict: dir-list видит только песочницу', async () => {
    await fs.mkdir(SANDBOX_DIR, { recursive: true });
    await fs.writeFile(ROOT_MARKER, 'root');
    await fs.writeFile(SANDBOX_MARKER, 'sandbox');
    created.push(ROOT_MARKER, SANDBOX_MARKER);

    const { stdout } = await runSafeCommand('dir-list', { strict: true });
    assert.ok(stdout.includes('rc-sandbox-marker.txt'), 'вывод strict dir-list должен содержать песочницу');
    assert.ok(
      !stdout.includes('rc-root-marker.txt'),
      'вывод strict dir-list не должен содержать файлы корня проекта'
    );
  });

  test('free: dir-list видит корень проекта', async () => {
    await fs.mkdir(SANDBOX_DIR, { recursive: true });
    await fs.writeFile(ROOT_MARKER, 'root');
    created.push(ROOT_MARKER);

    const { stdout } = await runSafeCommand('dir-list', { strict: false });
    assert.ok(stdout.includes('rc-root-marker.txt'), 'вывод free dir-list должен содержать корень проекта');
  });
});

describe('T2: инструмент runCommand', () => {
  test('strict: runCommand с git-status возвращает ошибку', async () => {
    const res = await toolsRegistry.runCommand.execute({ commandId: 'git-status' }, { strict: true });
    assert.equal(res.success, false);
    assert.match(res.error, /запрещена в строгом режиме песочницы/);
  });

  test('strict: runCommand с node-version по-прежнему работает', async () => {
    const res = await toolsRegistry.runCommand.execute({ commandId: 'node-version' }, { strict: true });
    assert.equal(res.success, true);
    assert.match(res.stdout.trim(), /^v\d+\.\d+\.\d+/);
  });

  test('free: runCommand с git-status выполняется', async () => {
    const res = await toolsRegistry.runCommand.execute({ commandId: 'git-status' }, { strict: false });
    assert.equal(res.success, true);
  });
});

describe('T2: executePlan с режимом', () => {
  test('strict: план с git-status отклонён на валидации шага', async () => {
    const report = await runPlan(
      [{ step: 1, tool: 'runCommand', arguments: { commandId: 'git-status' }, description: 'git status' }],
      true
    );
    assert.equal(report.success, false);
    assert.match(report.error, /запрещён в строгом режиме песочницы/);
    assert.equal(report.results.length, 0);
  });

  test('strict: план с git-diff отклонён', async () => {
    const report = await runPlan(
      [{ step: 1, tool: 'runCommand', arguments: { commandId: 'git-diff' }, description: 'git diff' }],
      true
    );
    assert.equal(report.success, false);
    assert.match(report.error, /запрещён в строгом режиме песочницы/);
  });

  test('strict: безопасная команда проходит', async () => {
    const report = await runPlan(
      [{ step: 1, tool: 'runCommand', arguments: { commandId: 'node-version' }, description: 'node -v' }],
      true
    );
    assert.equal(report.success, true, report.error || '');
  });

  test('free: тот же план с git-status выполняется', async () => {
    const report = await runPlan(
      [{ step: 1, tool: 'runCommand', arguments: { commandId: 'git-status' }, description: 'git status' }],
      false
    );
    assert.equal(report.success, true, report.error || '');
  });

  test('strict и free параллельно не перетирают режим', async () => {
    const strictPlan = [
      { step: 1, tool: 'runCommand', arguments: { commandId: 'git-diff' }, description: 'git diff' }
    ];
    const freePlan = [
      { step: 1, tool: 'runCommand', arguments: { commandId: 'git-status' }, description: 'git status' }
    ];

    const [strictReport, freeReport] = await Promise.all([runPlan(strictPlan, true), runPlan(freePlan, false)]);
    assert.equal(strictReport.success, false);
    assert.match(strictReport.error, /запрещён в строгом режиме песочницы/);
    assert.equal(freeReport.success, true, freeReport.error || '');
  });
});

describe('T2: npm-version (регрессия spawn EINVAL)', () => {
  test('free: runSafeCommand npm-version возвращает версию', async () => {
    const { stdout } = await runSafeCommand('npm-version', { strict: false });
    assert.match(String(stdout).trim(), /^\d+\.\d+\.\d+/);
  });

  test('strict: runCommand npm-version разрешён и работает', async () => {
    const res = await toolsRegistry.runCommand.execute({ commandId: 'npm-version' }, { strict: true });
    assert.equal(res.success, true, res.error || '');
    assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  test('resolveCommandSpawn оборачивает .cmd через cmd.exe без shell', async () => {
    const { resolveCommandSpawn, SAFE_COMMANDS } = await import('../src/tools/safeCommands.js');
    const spawn = resolveCommandSpawn(SAFE_COMMANDS['npm-version']);
    if (process.platform === 'win32') {
      assert.match(String(spawn.file), /cmd\.exe$/i);
      assert.deepEqual(spawn.args, ['/c', 'npm.cmd', '-v']);
    } else {
      assert.equal(spawn.file, 'npm');
    }
  });
});
