import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WORKSPACE_DIR = await fs.realpath(process.cwd());

/**
 * Проверка и ограничение пути рабочей директорией (защита от Directory Traversal)
 */
function resolveWorkspacePath(filePath) {
  if (
    typeof filePath !== 'string' ||
    !filePath.trim() ||
    filePath.includes('\0') ||
    path.isAbsolute(filePath) ||
    /^[a-zA-Z]:[\\/]/.test(filePath) ||
    filePath.startsWith('\\\\')
  ) {
    throw new Error('Ожидается относительный путь внутри рабочей папки.');
  }

  const target = path.resolve(WORKSPACE_DIR, filePath);
  const relative = path.relative(WORKSPACE_DIR, target);

  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Путь должен находиться внутри рабочей папки.');
  }

  return target;
}

/**
 * Защита от симлинков для предотвращения обхода песочницы
 */
async function rejectSymlinks(target, { allowMissing = false } = {}) {
  const relative = path.relative(WORKSPACE_DIR, target);
  let current = WORKSPACE_DIR;

  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error('Симлинки в путях инструментов запрещены.');
      }
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return;
      throw error;
    }
  }
}

/**
 * Белый список разрешенных системных команд для runCommand
 */
const SAFE_COMMANDS = {
  'git-status': { file: 'git', args: ['status', '--short'] },
  'node-version': { file: process.execPath, args: ['--version'] },
  'run-test': { file: process.execPath, args: ['tests/sandbox/file-utils.test.js'] }
};

export const toolsRegistry = {
  readFile: {
    async execute({ filePath }) {
      try {
        const target = resolveWorkspacePath(filePath);
        await rejectSymlinks(target);
        const info = await fs.lstat(target);
        
        if (!info.isFile()) {
          return { error: 'Можно читать только обычные файлы.' };
        }
        
        const content = await fs.readFile(target, 'utf8');
        return { success: true, content };
      } catch (error) {
        return { error: error.message };
      }
    }
  },

  writeFile: {
    async execute({ filePath, content }) {
      try {
        if (typeof content !== 'string') {
          return { error: 'Содержимое файла должно быть строкой.' };
        }

        const target = resolveWorkspacePath(filePath);
        
        // Проверяем существующую часть пути до создания директорий
        await rejectSymlinks(target, { allowMissing: true });
        
        // Создаем директории, если их нет
        await fs.mkdir(path.dirname(target), { recursive: true });
        
        // Повторная проверка перед записью (разрешаем отсутствие самого файла)
        await rejectSymlinks(target, { allowMissing: true });
        
        await fs.writeFile(target, content, { encoding: 'utf8' });
        return { success: true, message: `Файл ${filePath} успешно записан.` };
      } catch (error) {
        return { error: error.message };
      }
    }
  },

  runCommand: {
    async execute({ commandId }) {
      const command = SAFE_COMMANDS[commandId];
      if (!command) {
        return { error: `Команда не разрешена или не найдена в белом списке. Доступные ID: ${Object.keys(SAFE_COMMANDS).join(', ')}` };
      }

      try {
        const { stdout, stderr } = await execFileAsync(
          command.file,
          command.args,
          {
            cwd: WORKSPACE_DIR,
            timeout: 15_000,
            maxBuffer: 1024 * 1024,
            windowsHide: true
          }
        );
        return { success: true, stdout, stderr };
      } catch (error) {
        return { error: error.message, stderr: error.stderr };
      }
    }
  }
};

export function getToolsSystemPrompt() {
  return `Доступные инструменты:
- readFile: { "filePath": "относительный путь" }
- writeFile: { "filePath": "относительный путь", "content": "код" }
- runCommand: { "commandId": "id из белого списка (${Object.keys(SAFE_COMMANDS).join(', ')})" }
Используй строго формат JSON в блоке \`\`\`json для вызова инструментов.`;
}