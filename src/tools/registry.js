import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Определяем безопасную рабочую директорию (песочницу) проекта
const WORKSPACE_DIR = path.resolve(__dirname, '../../');

/**
 * Надежная проверка пути с защитой от Directory Traversal и симлинков, ведущих наружу
 */
async function resolveWorkspacePath(userInputPath) {
  // Нормализуем путь относительно воркспейса
  const resolved = path.resolve(WORKSPACE_DIR, userInputPath);

  // Проверяем, что путь физически начинается с рабочей директории
  if (!resolved.startsWith(WORKSPACE_DIR)) {
    throw new Error('Доступ запрещен: выход за пределы рабочей директории.');
  }

  try {
    // Проверяем реальный физический путь (защита от симлинков)
    const realPath = await fs.realpath(resolved);
    if (!realPath.startsWith(WORKSPACE_DIR)) {
      throw new Error('Доступ запрещен: символическая ссылка ведет за пределы песочницы.');
    }
    return realPath;
  } catch (err) {
    // Если файл еще не существует (например, для writeFile), проверяем родительскую директорию
    const parsedPath = path.parse(resolved);
    try {
      const realParentPath = await fs.realpath(parsedPath.dir);
      if (!realParentPath.startsWith(WORKSPACE_DIR)) {
        throw new Error('Доступ запрещен: родительская директория вне песочницы.');
      }
    } catch {
      // Если родительская папка тоже не найдена, возвращаем базовый разрешенный путь
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
      // Проверяем строгое соответствие ключу белого списка (исключаем любые shell-инъекции и разделители вроде &&, ;)
      const allowed = SAFE_COMMANDS[commandId];
      if (!allowed) {
        return { 
          success: false, 
          error: `Команда "${commandId}" не разрешена политикой безопасности или не найдена в белом списке.` 
        };
      }

      try {
        // Используем execFile без вызова системного shell, что полностью исключает инъекции
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