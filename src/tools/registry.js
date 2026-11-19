import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const WORKSPACE_ROOT = path.resolve();
const SANDBOX_REL = path.join('tests', 'sandbox');
const SANDBOX_DIR = path.resolve(WORKSPACE_ROOT, SANDBOX_REL);

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'reports',
  'dist',
  'build',
  'coverage',
  'reflections'
]);

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
  '.json', '.md', '.txt', '.html', '.css', '.scss',
  '.yml', '.yaml', '.xml', '.env', '.sh', '.sql'
]);

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

  try {
    const realActiveRoot = await fs.realpath(activeRoot);
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
      const realActiveRoot = await fs.realpath(activeRoot).catch(() => activeRoot);
      await verifyNearestExistingAncestor(absoluteTarget, realActiveRoot);
      return absoluteTarget;
    }
    throw err;
  }
}

/**
 * Рекурсивно собирает статистику по директории с ограничением глубины и числа файлов
 */
async function scanProjectStats(rootDir, maxDepth = 4, maxFiles = 250) {
  const stats = {
    totalFiles: 0,
    totalDirs: 0,
    totalLines: 0,
    byExtension: {},
    largestFiles: [],
    topEntries: [],
    truncated: false
  };

  const rootEntries = await fs.readdir(rootDir, { withFileTypes: true });
  stats.topEntries = rootEntries
    .filter((entry) => !IGNORED_DIRS.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file'
    }));

  async function walk(currentDir, depth) {
    if (stats.totalFiles >= maxFiles) {
      stats.truncated = true;
      return;
    }

    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (stats.totalFiles >= maxFiles) {
        stats.truncated = true;
        return;
      }

      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(rootDir, fullPath) || entry.name;

      if (entry.isDirectory()) {
        stats.totalDirs += 1;
        if (depth < maxDepth) {
          await walk(fullPath, depth + 1);
        }
      } else if (entry.isFile()) {
        stats.totalFiles += 1;
        const ext = path.extname(entry.name).toLowerCase() || '(без расширения)';
        stats.byExtension[ext] = (stats.byExtension[ext] || 0) + 1;

        let fileSize = 0;
        let lineCount = 0;

        try {
          const info = await fs.stat(fullPath);
          fileSize = info.size;

          if (TEXT_EXTENSIONS.has(ext) && fileSize <= 512 * 1024) {
            const content = await fs.readFile(fullPath, 'utf8');
            lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length;
            stats.totalLines += lineCount;
          }
        } catch {
          // Пропускаем недоступные при чтении файлы
        }

        stats.largestFiles.push({
          path: relPath,
          sizeBytes: fileSize,
          lines: lineCount
        });
      }
    }
  }

  await walk(rootDir, 0);

  stats.largestFiles.sort((a, b) => b.sizeBytes - a.sizeBytes);
  stats.largestFiles = stats.largestFiles.slice(0, 5);

  return stats;
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
  },
  'git-status': {
    executable: 'git',
    args: ['status', '--short']
  },
  'git-diff': {
    executable: 'git',
    args: ['diff', '--stat']
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

  listDir: {
    description: 'Возвращает список файлов и папок в директории. Аргументы: { "dirPath": "." }',
    async execute(args = {}) {
      try {
        const targetDir = args.dirPath || args.filePath || args.path || '.';
        const safePath = await resolveSafePath(targetDir);
        const entries = await fs.readdir(safePath, { withFileTypes: true });
        const items = entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'dir' : 'file'
        }));
        return { success: true, items, message: JSON.stringify(items) };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  analyzeProject: {
    description: 'Анализирует структуру директории/проекта: файлы, папки, строки кода, зависимости из package.json и крупные файлы. Аргументы: { "dirPath": "." }',
    async execute(args = {}) {
      try {
        const targetDir = args.dirPath || args.filePath || args.path || '.';
        const safePath = await resolveSafePath(targetDir);
        const dirStat = await fs.stat(safePath);

        if (!dirStat.isDirectory()) {
          return { success: false, error: `Указанный путь не является директорией: ${targetDir}` };
        }

        const stats = await scanProjectStats(safePath);
        let pkgSummary = null;

        try {
          const pkgRaw = await fs.readFile(path.join(safePath, 'package.json'), 'utf8');
          const pkg = JSON.parse(pkgRaw);
          pkgSummary = {
            name: pkg.name || '(без имени)',
            version: pkg.version || '0.0.0',
            type: pkg.type || 'commonjs',
            scripts: Object.keys(pkg.scripts || {}),
            dependencies: Object.keys(pkg.dependencies || {})
          };
        } catch {
          // В подпапках или песочнице package.json может отсутствовать
        }

        const relTarget = path.relative(WORKSPACE_ROOT, safePath) || '.';
        const report = {
          target: relTarget,
          packageInfo: pkgSummary,
          totalDirs: stats.totalDirs,
          totalFiles: stats.totalFiles,
          totalLines: stats.totalLines,
          byExtension: stats.byExtension,
          largestFiles: stats.largestFiles,
          topEntries: stats.topEntries,
          truncated: stats.truncated
        };

        return {
          success: true,
          report,
          message: JSON.stringify(report)
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  generateUnitTest: {
    description: 'Читает исходный файл и генерирует заготовку unit-теста на node:test. Аргументы: { "sourcePath": "путь/к/модулю.js", "outputPath": "путь/к/тесту.test.js" }',
    async execute(args = {}) {
      try {
        const srcInput = args.sourcePath || args.filePath || args.path;
        if (!srcInput || typeof srcInput !== 'string') {
          return { success: false, error: 'Не указан путь к исходному файлу (sourcePath).' };
        }

        const safeSrc = await resolveSafePath(srcInput);
        const sourceCode = await fs.readFile(safeSrc, 'utf8');

        const fnMatches = [...sourceCode.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)].map(m => m[1]);
        const arrowMatches = [...sourceCode.matchAll(/(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/g)].map(m => m[1]);
        const classMatches = [...sourceCode.matchAll(/(?:export\s+)?class\s+([A-Za-z0-9_]+)/g)].map(m => m[1]);
        const symbols = [...new Set([...fnMatches, ...arrowMatches, ...classMatches])];

        const baseName = path.basename(safeSrc, path.extname(safeSrc));
        const defaultOut = path.join(SANDBOX_REL, `${baseName}.generated.test.js`);
        const rawOut = args.outputPath || defaultOut;
        const safeOut = await resolveSafePath(rawOut);

        const relImport = path.relative(path.dirname(safeOut), safeSrc).replaceAll('\\', '/');
        const importPath = relImport.startsWith('.') ? relImport : `./${relImport}`;

        const casesBlock = symbols.length > 0
          ? symbols.map((sym) => [
              `  it('должен импортировать и проверять ${sym}', async () => {`,
              `    const mod = await import('${importPath}');`,
              `    assert.ok('${sym}' in mod, 'Ожидался экспорт ${sym}');`,
              `  });`
            ].join('\n')).join('\n\n')
          : [
              `  it('должен успешно импортироваться без ошибок', async () => {`,
              `    const mod = await import('${importPath}');`,
              `    assert.ok(mod, 'Модуль должен быть загружен');`,
              `  });`
            ].join('\n');

        const testContent = [
          `import { describe, it } from 'node:test';`,
          `import assert from 'node:assert/strict';`,
          ``,
          `describe('Автотест для ${path.basename(safeSrc)}', () => {`,
          casesBlock,
          `});`,
          ``
        ].join('\n');

        await fs.mkdir(path.dirname(safeOut), { recursive: true });
        await fs.writeFile(safeOut, testContent, 'utf8');

        const relOut = path.relative(WORKSPACE_ROOT, safeOut);
        return {
          success: true,
          outputPath: relOut,
          detectedSymbols: symbols,
          message: `Сгенерирован тест: ${relOut} (найдено символов: ${symbols.length})`
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  runCommand: {
    description: 'Выполняет разрешенную команду из белого списка. Аргументы: { "commandId": "node-version" | "npm-version" | "dir-list" | "git-status" | "git-diff" }',
    async execute(args) {
      try {
        const cmdId = args.commandId;
        const cmdConfig = SAFE_COMMANDS[cmdId];
        if (!cmdConfig) {
          return { success: false, error: `Команда "${cmdId}" не разрешена в белом списке.` };
        }
        const { stdout, stderr } = await execFileAsync(cmdConfig.executable, cmdConfig.args, {
          cwd: WORKSPACE_ROOT,
          timeout: 60_000,
          windowsHide: true
        });
        return { success: true, stdout, stderr };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  }
};

export function getToolsSystemPrompt() {
  let prompt = 'Ты автономный ИИ-агент «Конструкт АИ». У тебя есть следующие инструменты:\n\n';
  for (const [name, tool] of Object.entries(toolsRegistry)) {
    prompt += `- **${name}**: ${tool.description}\n`;
  }
  prompt += '\nСТРОГИЕ ПРАВИЛА ДИАЛОГА И ЧЕСТНОСТИ:\n';
  prompt += '1. ИНФОРМАЦИОННЫЕ ВОПРОСЫ И БЕСЕДА: Если пользователь спрашивает "Кто ты?", "В каком ты режиме?", приветствует тебя или ведет обычный диалог, ТЫ ОБЯЗАН ответить чистым текстом на русском языке. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО возвращать JSON-планы или создавать файлы на информационные вопросы!\n';
  prompt += '2. НЕДОСТУПНЫЕ ИНСТРУМЕНТЫ: Если у тебя нет подходящего инструмента для выполнения запроса (например, узнать точное время или погоду), ответь пользователю честным текстом: "У меня пока нет такого инструмента".\n';
  
  if (sandboxConfig.strictDefault) {
    prompt += '\n3. РЕЖИМ ПЕСОЧНИЦЫ (СТРОГО ПО УМОЛЧАНИЮ): Ты работаешь исключительно внутри папки tests/sandbox/. Все обычные относительные пути автоматически привязываются к tests/sandbox/.\n';
    prompt += '4. ЗАЩИТА ОТ ВЫХОДА ИЗ ПЕСОЧНИЦЫ: Если пользователь просит создать/изменить/удалить файл ВНЕ песочницы (например, "в корне проекта", "вне папки sandbox", "../"), НЕ создавай файл молча! Ответь обычным текстом в чат: объясни, что сейчас включён режим песочницы, ты не можешь работать в корне проекта, и предложи создать этот файл внутри tests/sandbox/`.\n';
  } else {
    prompt += '\n3. РЕЖИМ СВОБОДЫ: Тебе разрешено создавать, читать и удалять файлы в любой папке проекта.\n';
    prompt += '4. ЖЕСТКОЕ ПРАВИЛО УТОЧНЕНИЯ ПУТИ: Если пользователь в своем запросе НЕ указал конкретный путь или папку для файла (например, написал просто "создай файл data.txt" или "создай скрипт.js" без указания директории), ТЫ КАТЕГОРИЧЕСКИ НЕ ИМЕЕШЬ ПРАВА вызывать инструменты и создавать файл в корне! Вместо этого ты ОБЯЗАН ответить чистым текстом в чат, задать вопрос пользователю и уточнить: в какой именно папке или директории создать этот файл?\n';
  }
  return prompt;
}