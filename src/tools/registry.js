import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WORKSPACE_ROOT = path.resolve();

/**
 * Строгая проверка безопасности пути (защита от Directory Traversal, префиксов и симлинков)
 */
async function resolveSafePath(userPath) {
  if (!userPath || typeof userPath !== 'string') {
    throw new Error('Некорректный путь: путь должен быть непустой строкой.');
  }

  const absoluteTarget = path.resolve(WORKSPACE_ROOT, userPath);
  const relative = path.relative(WORKSPACE_ROOT, absoluteTarget);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Нарушение безопасности: выход за пределы рабочей директории запрещен.');
  }

  try {
    const realWorkspace = await fs.realpath(WORKSPACE_ROOT);
    const realTargetDir = await fs.realpath(path.dirname(absoluteTarget));
    const realTargetFull = path.join(realTargetDir, path.basename(absoluteTarget));

    const relReal = path.relative(realWorkspace, realTargetFull);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      throw new Error('Нарушение безопасности: попытка обхода через символические ссылки или junction.');
    }

    return absoluteTarget;
  } catch (err) {
    if (err.code === 'ENOENT') {
      const parentDir = path.dirname(absoluteTarget);
      try {
        const realWorkspace = await fs.realpath(WORKSPACE_ROOT);
        const realParent = await fs.realpath(parentDir);
        const relRealParent = path.relative(realWorkspace, realParent);
        if (relRealParent.startsWith('..') || path.isAbsolute(relRealParent)) {
          throw new Error('Нарушение безопасности: родительская директория находится вне песочницы.');
        }
        return absoluteTarget;
      } catch (parentErr) {
        throw new Error(`Ошибка проверки родительской директории: ${parentErr.message}`);
      }
    }
    throw err;
  }
}

const SAFE_COMMANDS = {
  'node-version': ['-e', 'console.log(process.version)'],
  'npm-version': ['-v'],
  'dir-list': ['-la']
};

export const toolsRegistry = {
  readFile: {
    description: 'Читает содержимое файла. Аргументы: { "filePath": "путь/к/файлу" } (также поддерживается "path")',
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
    description: 'Записывает текст в файл. Аргументы: { "filePath": "путь/к/файлу", "content": "текст" } (также поддерживается "path")',
    async execute(args) {
      try {
        const targetPath = args.filePath || args.path;
        const safePath = await resolveSafePath(targetPath);
        await fs.mkdir(path.dirname(safePath), { recursive: true });
        await fs.writeFile(safePath, args.content || '', 'utf8');
        return { success: true, message: `Файл успешно записан: ${targetPath}` };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  runCommand: {
    description: 'Выполняет разрешенную команду из белого списка. Аргументы: { "commandId": "node-version" }',
    async execute(args) {
      try {
        const cmdId = args.commandId;
        if (!SAFE_COMMANDS[cmdId]) {
          return { success: false, error: `Команда "${cmdId}" не разрешена в белом списке.` };
        }
        const [executable, ...defaultArgs] = cmdId === 'node-version' ? [process.execPath, '-e', 'console.log(process.version)'] : ['node', SAFE_COMMANDS[cmdId]];
        
        const { stdout, stderr } = await execFileAsync(process.execPath, SAFE_COMMANDS[cmdId]);
        return { success: true, stdout, stderr };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  }
};

/**
 * Возвращает системный промпт с описанием инструментов для агента
 */
export function getToolsSystemPrompt() {
  let prompt = 'Ты — автономный ИИ-агент «Конструкт АИ». У тебя есть следующие инструменты:\n\n';
  for (const [name, tool] of Object.entries(toolsRegistry)) {
    prompt += `- **${name}**: ${tool.description}\n`;
  }
  return prompt;
}