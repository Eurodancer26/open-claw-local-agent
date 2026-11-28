// src/tools/safeCommands.js
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'util';
import { WORKSPACE_ROOT, SANDBOX_DIR } from './pathSecurity.js';

const execFileAsync = promisify(execFile);

/**
 * Windows: файлы `.cmd`/`.bat` нельзя запускать напрямую через execFile:
 * Node отклоняет их с `spawn EINVAL` (защита после CVE-2024-27980), если не
 * передан `shell: true`. `shell: true` использовать не хотим (интерполяция
 * строки команды), поэтому запускаем через cmd.exe с фиксированным списком
 * аргументов: `/c <script> <args...>`. Проверено: `cmd.exe /c npm.cmd -v`
 * возвращает версию, прямой execFile("npm.cmd") падает с EINVAL.
 */
const CMD_EXE = process.env.ComSpec || 'cmd.exe';
const isCmdScript = (exe) => /\.(cmd|bat)$/i.test(String(exe));

/** Возвращает { file, args } для execFile без shell-интерполяции. */
export function resolveCommandSpawn(cmdConfig) {
  if (process.platform === 'win32' && isCmdScript(cmdConfig.executable)) {
    return { file: CMD_EXE, args: ['/c', cmdConfig.executable, ...cmdConfig.args] };
  }
  return { file: cmdConfig.executable, args: [...cmdConfig.args] };
}

/**
 * Белый список команд.
 *
 * strictAllowed — можно ли запускать команду в СТРОГОМ режиме песочницы.
 *  - true  → команда не читает файловую систему проекта (версии node/npm) либо
 *            безопасна при запуске с cwd = tests/sandbox (dir-list показывает
 *            только содержимое рабочей директории).
 *  - false → команда раскрывает данные всего репозитория (git status/diff) и в
 *            strict-режиме запрещена: git находит корень репозитория выше
 *            tests/sandbox и вернул бы данные вне песочницы.
 */
export const SAFE_COMMANDS = {
  'node-version': {
    executable: process.execPath,
    args: ['-e', 'console.log(process.version)'],
    strictAllowed: true
  },
  'npm-version': {
    executable: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['-v'],
    strictAllowed: true
  },
  'dir-list': {
    executable: process.platform === 'win32' ? 'cmd.exe' : 'ls',
    args: process.platform === 'win32' ? ['/c', 'dir'] : ['-la'],
    // В strict запускается с cwd = tests/sandbox и потому видит только песочницу.
    strictAllowed: true
  },
  'git-status': {
    executable: 'git',
    args: ['status', '--short'],
    strictAllowed: false,
    strictDenyReason:
      'git status показывает состояние всего репозитория (включая файлы вне tests/sandbox/).'
  },
  'git-diff': {
    executable: 'git',
    args: ['diff', '--stat'],
    strictAllowed: false,
    strictDenyReason:
      'git diff показывает изменения по всему репозиторию (включая файлы вне tests/sandbox/).'
  }
};

/** Политика команды для strict-режима: 'allow' | 'deny' | 'unknown'. */
export function getStrictCommandPolicy(commandId) {
  const cmdConfig = SAFE_COMMANDS[commandId];
  if (!cmdConfig) {
    return 'unknown';
  }
  return cmdConfig.strictAllowed ? 'allow' : 'deny';
}

/** Список id команд, разрешённых в strict-режиме. */
export function listStrictAllowedCommands() {
  return Object.keys(SAFE_COMMANDS).filter((id) => SAFE_COMMANDS[id].strictAllowed);
}

/**
 * Рабочая директория запуска: в strict — песочница, иначе корень проекта.
 * В strict режим передаётся явным параметром { strict }, как и в resolveSafePath.
 */
export function resolveCommandCwd(strict) {
  return strict === true ? SANDBOX_DIR : WORKSPACE_ROOT;
}

/**
 * Запускает команду из белого списка с учётом режима песочницы.
 * options.strict === true → команда не должна выходить за tests/sandbox.
 * options.signal — AbortSignal запроса: при обрыве клиента дочерний процесс убивается.
 * На Windows `.cmd`/`.bat` (npm-version) автоматически запускаются через cmd.exe
 * (см. resolveCommandSpawn) — прямой execFile даёт spawn EINVAL.
 */
export async function runSafeCommand(commandId, options = {}) {
  const strict = options?.strict === true;
  const cmdConfig = SAFE_COMMANDS[commandId];
  if (!cmdConfig) {
    throw new Error(`Команда "${commandId}" не разрешена в белом списке.`);
  }

  if (options?.signal?.aborted) {
    const err = new Error('Генерация прервана: клиент разорвал соединение');
    err.name = 'AbortError';
    throw err;
  }

  if (strict && !cmdConfig.strictAllowed) {
    const reason = cmdConfig.strictDenyReason ? ` ${cmdConfig.strictDenyReason}` : '';
    throw new Error(
      `Команда "${commandId}" запрещена в строгом режиме песочницы: она может отдать данные вне tests/sandbox/.${reason} ` +
        `Разрешены: ${listStrictAllowedCommands().join(', ')}. Для листинга внутри песочницы используй listDir.`
    );
  }

  const cwd = resolveCommandCwd(strict);
  if (strict) {
    // В strict команды запускаются из tests/sandbox — гарантируем, что она есть.
    await fs.mkdir(SANDBOX_DIR, { recursive: true });
  }

  const { file, args } = resolveCommandSpawn(cmdConfig);

  return execFileAsync(file, args, {
    cwd,
    timeout: 60_000,
    windowsHide: true,
    signal: options?.signal
  });
}
