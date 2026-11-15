import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Абсолютный путь к рабочей директории (корню проекта)
const WORKSPACE_DIR = path.resolve(__dirname, '../../');

/**
 * Надежная проверка пути с защитой от Directory Traversal, префиксных обходов и симлинков
 */
async function resolveWorkspacePath(userInputPath) {
  const resolved = path.resolve(WORKSPACE_DIR, userInputPath);

  // 1. Проверка границ через path.relative (защита от /project vs /project-other)
  const relative = path.relative(WORKSPACE_DIR, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Доступ запрещен: выход за пределы рабочей директории.');
  }

  // 2. Покомпонентная проверка каждого сегмента пути на наличие симлинков / junctions
  const segments = relative.split(path.sep).filter(Boolean);
  let currentPath = WORKSPACE_DIR;

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    try {
      const stats = await fs.lstat(currentPath);
      if (stats.isSymbolicLink()) {
        const realTarget = await fs.realpath(currentPath);
        const targetRelative = path.relative(WORKSPACE_DIR, realTarget);
        if (targetRelative.startsWith('..') || path.isAbsolute(targetRelative)) {
          throw new Error('Доступ запрещен: символическая ссылка ведет за пределы песочницы.');
        }
      }
    } catch (err) {
      if (err.message && err.message.includes('Доступ запрещен')) {
        throw err;
      }
      // Компонент еще не существует — выходим из цикла проверки существующих частей
      break;
    }
  }

  // 3. Финальная проверка реального физического пути (если объект уже существует)
  try {
    const realPath = await fs.realpath(resolved);
    const realRelative = path.relative(WORKSPACE_DIR, realPath);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new Error('Доступ запрещен: целевой объект ведет за пределы песочницы.');
    }
    return realPath;
  } catch (err) {
    if (err.message && err.message.includes('Доступ запрещен')) {
      throw err;
    }
    return resolved;
  }
}

/**
 * Белый список разрешенных команд для инструмента runCommand
 */
const SAFE_COMMANDS = {
  'node-version': { cmd: process.execPath, args: ['-v'] },
  'npm-version': { cmd: 'npm', args: ['-v'] }
};

export const toolsRegistry = {
  readFile: {
    description: 'Чтение файла из рабочей директории с проверкой безопасности',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Путь к файлу относительно корня проекта' }
      },
      required: ['filePath']
    },
    async execute({ filePath }) {
      try {
        const safePath = await resolveWorkspacePath(filePath);
        const content = await fs.readFile(safePath, 'utf8');
        return { success: true, content };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  writeFile: {
    description: 'Запись файла в рабочую директорию с проверкой безопасности',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Путь к файлу' },
        content: { type: 'string', description: 'Содержимое файла' }
      },
      required: ['filePath', 'content']
    },
    async execute({ filePath, content }) {
      try {
        const safePath = await resolveWorkspacePath(filePath);
        await fs.mkdir(path.dirname(safePath), { recursive: true });
        await fs.writeFile(safePath, content, 'utf8');
        return { success: true, message: `Файл успешно записан: ${filePath}` };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  runCommand: {
    description: 'Безопасное выполнение разрешенных системных команд из белого списка',
    parameters: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: 'Идентификатор команды из белого списка' }
      },
      required: ['commandId']
    },
    async execute({ commandId }) {
      const allowed = SAFE_COMMANDS[commandId];
      if (!allowed) {
        return {
          success: false,
          error: `Команда "${commandId}" не разрешена политикой безопасности или не найдена в белом списке.`
        };
      }

      try {
        const { stdout, stderr } = await execFileAsync(allowed.cmd, allowed.args, {
          cwd: WORKSPACE_DIR,
          timeout: 10000
        });
        return { success: true, stdout, stderr };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  }
};

export function getToolsSystemPrompt() {
  return `Ты — локальный AI-агент. У тебя есть инструменты для работы с файлами и безопасными системными командами. Всегда строго соблюдай правила безопасности песочницы.`;
}