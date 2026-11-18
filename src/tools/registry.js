import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WORKSPACE_ROOT = path.resolve();
const SANDBOX_REL = path.join('tests', 'sandbox');
const SANDBOX_DIR = path.resolve(WORKSPACE_ROOT, SANDBOX_REL);

export const sandboxConfig = {
  strictDefault: true // true — жестко всё в tests/sandbox, false — свобода выбора в пределах проекта
};

/**
 * Находит ближайшую существующую родительскую директорию и проверяет её реальный путь
 */
async function verifyNearestExistingAncestor(targetPath, realRoot) {
  let current = path.dirname(targetPath);
  while (true) {
    try {
      const realCurrent = await fs.realpath(current);
      const rel = path.relative(realRoot, realCurrent);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error('Нарушение безопасности: родительская директория находится вне разрешенной зоны.');
      }
      return;
    } catch (err) {
      if (err.code === 'ENOENT') {
        const parent = path.dirname(current);
        if (parent === current) {
          throw new Error('Нарушение безопасности: не удалось подтвердить корневую директорию.');
        }
        current = parent;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Строгая проверка безопасности пути с поддержкой жесткого режима песочницы по умолчанию
 */
async function resolveSafePath(userPath) {
  if (!userPath || typeof userPath !== 'string') {
    throw new Error('Некорректный путь: путь должен быть непустой строкой.');
  }
  let targetInput = userPath.trim();
  const normalizedInput = path.normalize(targetInput);
  const activeRoot = sandboxConfig.strictDefault ? SANDBOX_DIR : WORKSPACE_ROOT;

  if (sandboxConfig.strictDefault) {
    await fs.mkdir(SANDBOX_DIR, { recursive: true });
    const relToSandboxPrefix = path.relative(SANDBOX_REL, normalizedInput);
    const isAlreadyPrefixed =
      !relToSandboxPrefix.startsWith('..') &&
      !path.isAbsolute(relToSandboxPrefix) &&
      (normalizedInput === SANDBOX_REL || normalizedInput.startsWith(SANDBOX_REL + path.sep));

    if (!isAlreadyPrefixed) {
      targetInput = path.join(SANDBOX_REL, normalizedInput);
    }
  }

  const absoluteTarget = path.resolve(WORKSPACE_ROOT, targetInput);
  const relativeToActiveRoot = path.relative(activeRoot, absoluteTarget);

  if (relativeToActiveRoot.startsWith('..') || path.isAbsolute(relativeToActiveRoot)) {
    throw new Error(
      sandboxConfig.strictDefault
        ? 'Нарушение безопасности: в строгом режиме работа разрешена только внутри tests/sandbox/.'
        : 'Нарушение безопасности: выход за пределы рабочей директории запрещен.'
    );
  }

  const realActiveRoot = await fs.realpath(activeRoot);
  try {
    const stat = await fs.lstat(absoluteTarget);
    const realTarget = await fs.realpath(absoluteTarget);
    const relReal = path.relative(realActiveRoot, realTarget);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      throw new Error(
        stat.isSymbolicLink()
          ? 'Нарушение безопасности: целевой файл является симлинком за пределы разрешенной зоны.'
          : 'Нарушение безопасности: выход за пределы разрешенной директории запрещен.'
      );
    }
    return absoluteTarget;
  } catch (err) {
    if (err.code === 'ENOENT') {
      await verifyNearestExistingAncestor(absoluteTarget, realActiveRoot);
      return absoluteTarget;
    }
    throw err;
  }
}

const SAFE_COMMANDS = {
  'node-version': {
    executable: process.execPath,
    args: ['-e', 'console.log(process.version)']
  },
  'npm-version': {
    executable: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['-v']
  },
  'dir-list': {
    executable: process.platform === 'win32' ? 'cmd.exe' : 'ls',
    args: process.platform === 'win32' ? ['/c', 'dir'] : ['-la']
  }
};

export const toolsRegistry = {
  readFile: {
    description: 'Читает содержимое файла. Аргументы: { "filePath": "путь/к/файлу" }',
    async execute(args) {
      try {
        const targetPath = args.filePath || args.path;
        const safePath = await resolveSafePath(targetPath);
        const content = await fs.readFile(safePath, 'utf8');
        return { success: true, content };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },
  writeFile: {
    description: 'Записывает текст в файл. Аргументы: { "filePath": "путь/к/файлу", "content": "текст" }',
    async execute(args) {
      try {
        const targetPath = args.filePath || args.path;
        const safePath = await resolveSafePath(targetPath);
        await fs.mkdir(path.dirname(safePath), { recursive: true });
        await fs.writeFile(safePath, args.content || '', 'utf8');
        return { success: true, message: `Файл успешно записан: ${path.relative(WORKSPACE_ROOT, safePath)}` };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },
  deleteFile: {
    description: 'Удаляет файл. Аргументы: { "filePath": "путь/к/файлу" }',
    async execute(args) {
      try {
        const targetPath = args.filePath || args.path;
        const safePath = await resolveSafePath(targetPath);
        await fs.unlink(safePath);
        return { success: true, message: `Файл успешно удален: ${path.relative(WORKSPACE_ROOT, safePath)}` };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },
  runCommand: {
    description: 'Выполняет разрешенную команду из белого списка. Аргументы: { "commandId": "node-version" | "npm-version" | "dir-list" }',
    async execute(args) {
      try {
        const cmdId = args.commandId;
        const cmdConfig = SAFE_COMMANDS[cmdId];
        if (!cmdConfig) {
          return { success: false, error: `Команда "${cmdId}" не разрешена в белом списке.` };
        }
        const { stdout, stderr } = await execFileAsync(cmdConfig.executable, cmdConfig.args);
        return { success: true, stdout, stderr };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  }
};

export function getToolsSystemPrompt() {
  let prompt = 'Ты — автономный ИИ-агент «Конструкт АИ». У тебя есть следующие инструменты:\n\n';
  for (const [name, tool] of Object.entries(toolsRegistry)) {
    prompt += `- **${name}**: ${tool.description}\n`;
  }

  prompt += '\n🚨 СТРОГИЕ ПРАВИЛА ДИАЛОГА И ЧЕСТНОСТИ:\n';
  prompt += '1. ИНФОРМАЦИОННЫЕ ВОПРОСЫ И БЕСЕДА: Если пользователь спрашивает "Кто ты?", "В каком ты режиме?", приветствует тебя или ведет обычный диалог — ТЫ ОБЯЗАН ответить чистым текстом на русском языке. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО возвращать JSON-планы или создавать файлы на информационные вопросы!\n';
  prompt += '2. НЕДОСТУПНЫЕ ИНСТРУМЕНТЫ: Если у тебя нет подходящего инструмента для выполнения запроса (например, узнать точное время или погоду), ответь пользователю честным текстом: "У меня пока нет такого инструмента".\n';

  if (sandboxConfig.strictDefault) {
    prompt += '\n🔒 РЕЖИМ ПЕСОЧНИЦЫ (СТРОГО ПО УМОЛЧАНИЮ): Ты работаешь исключительно внутри папки `tests/sandbox/`. Все обычные относительные пути автоматически привязываются к `tests/sandbox/`.\n';
    prompt += '⚠️ ЗАЩИТА ОТ ВЫХОДА ИЗ ПЕСОЧНИЦЫ: Если пользователь просит создать/изменить/удалить файл ВНЕ песочницы (например, "в корне проекта", "вне папки sandbox", "../"), НЕ создавай файл молча! Ответь обычным текстом в чат: объясни, что сейчас включён режим песочницы, ты не можешь работать в корне проекта, и предложи создать этот файл внутри `tests/sandbox/`.\n';
  } else {
    prompt += '\n🔓 РЕЖИМ СВОБОДЫ: Тебе разрешено создавать, читать и удалять файлы в любой папке проекта.\n';
    prompt += '⚠️ ЖЕСТКОЕ ПРАВИЛО УТОЧНЕНИЯ ПУТИ: Если пользователь в своем запросе НЕ указал конкретный путь или папку для файла (например, написал просто "создай файл data.txt" или "создай скрипт.js" без указания директории), ТЫ КАТЕГОРИЧЕСКИ НЕ ИМЕЕШЬ ПРАВА вызывать инструменты и создавать файл в корне! Вместо этого ты ОБЯЗАН ответить чистым текстом в чат, задать вопрос пользователю и уточнить: в какой именно папке или директории создать этот файл?\n';
  }

  return prompt;
}