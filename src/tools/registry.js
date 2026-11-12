import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);
const WORKSPACE_DIR = process.cwd();

export const toolsRegistry = {
  // 1. Чтение файла
  readFile: {
    description: 'Читает содержимое файла по относительному пути.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Путь к файлу относительно корня проекта' }
      },
      required: ['filePath']
    },
    async execute({ filePath }) {
      try {
        const fullPath = path.join(WORKSPACE_DIR, filePath);
        if (!fs.existsSync(fullPath)) return { error: `Файл ${filePath} не найден.` };
        const content = fs.readFileSync(fullPath, 'utf-8');
        return { success: true, content };
      } catch (err) {
        return { error: err.message };
      }
    }
  },

  // 2. Запись / создание файла
  writeFile: {
    description: 'Создает или перезаписывает файл с указанным содержимым.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Путь к файлу' },
        content: { type: 'string', description: 'Текст или код для записи' }
      },
      required: ['filePath', 'content']
    },
    async execute({ filePath, content }) {
      try {
        const fullPath = path.join(WORKSPACE_DIR, filePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf-8');
        return { success: true, message: `Файл ${filePath} успешно записан.` };
      } catch (err) {
        return { error: err.message };
      }
    }
  },

  // 3. Выполнение консольной команды (тесты, скрипты, сборка)
  runCommand: {
    description: 'Выполняет консольную команду в корне проекта (например, тесты или запуск скриптов).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Команда для выполнения (например, node test-stream.js)' }
      },
      required: ['command']
    },
    async execute({ command }) {
      try {
        // Базовые ограничения безопасности
        if (command.includes('rm -rf /') || command.includes('del /s /q c:\\')) {
          return { error: 'Эта команда запрещена из соображений безопасности.' };
        }
        const { stdout, stderr } = await execPromise(command, { cwd: WORKSPACE_DIR, timeout: 15000 });
        return { success: true, stdout, stderr };
      } catch (err) {
        return { error: err.message, stderr: err.stderr };
      }
    }
  }
};

/**
 * Возвращает текстовое описание инструментов для системного промта модели
 */
export function getToolsSystemPrompt() {
  let prompt = "У тебя есть доступ к следующим инструментам (Function Calling):\n";
  for (const [name, tool] of Object.entries(toolsRegistry)) {
    prompt += `- Инструмент: "${name}"\n  Описание: ${tool.description}\n  Параметры: ${JSON.stringify(tool.parameters)}\n`;
  }
  prompt += `\nЕсли тебе нужно вызвать инструмент, верни строго JSON-объект в формате:\n\`\`\`json\n{"tool": "имя_инструмента", "args": { "параметр": "значение" }}\n\`\`\`\n`;
  return prompt;
}