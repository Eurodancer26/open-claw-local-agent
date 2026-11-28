// src/tools/registry.js
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  WORKSPACE_ROOT,
  sandboxConfig,
  DEFAULT_STRICT_SANDBOX,
  resolveSafePath
} from './pathSecurity.js';
import { scanProjectStats } from './projectScanner.js';
import { runSafeCommand } from './safeCommands.js';

export { sandboxConfig, DEFAULT_STRICT_SANDBOX, resolveSafePath };
import { registerPlugins } from './pluginLoader.js';

// Блок 6.5: «опасные» плагинные инструменты (требуют подтверждения, см. executor).
export const DANGEROUS_TOOL_NAMES = new Set();

/**
 * Регистрирует инструменты плагинов в реестре.
 * @param {Map<string, object>} plugins
 * @returns {string[]} добавленные имена
 */
export function registerPluginTools(plugins) {
  const added = registerPlugins(toolsRegistry, plugins);
  for (const name of added) {
    if (plugins.get(name)?.dangerous === true) DANGEROUS_TOOL_NAMES.add(name);
  }
  return added;
}

const MAX_READ_BYTES = 5 * 1024 * 1024; // 5 МБ — потолок для readFile

// Лимиты инструмента searchInFiles (безопасный поиск по содержимому).
const MAX_SEARCH_RESULTS = 100; // сколько совпадений вернуть по умолчанию
const MAX_SEARCH_RESULTS_LIMIT = 1000; // жёсткий потолок maxResults
const MAX_SEARCH_FILE_BYTES = 512 * 1024; // файлы крупнее не читаем при поиске
const MAX_SEARCH_FILES = 500; // потолок числа просканированных файлов
const SEARCH_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'reports',
  'dist',
  'build',
  'coverage',
  'reflections'
]);
const SEARCH_TEXT_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.jsx',
  '.tsx',
  '.json',
  '.md',
  '.txt',
  '.html',
  '.css',
  '.scss',
  '.yml',
  '.yaml',
  '.xml',
  '.sh',
  '.sql'
]);

export const toolsRegistry = {
  readFile: {
    description: 'Читает содержимое файла. Аргументы: { "filePath": "путь/к/файлу" }',
    async execute(args = {}, options = {}) {
      try {
        const targetPath = args.filePath || args.path;
        if (!targetPath || typeof targetPath !== 'string') {
          return { success: false, error: 'readFile: не указан filePath' };
        }
        const safePath = await resolveSafePath(targetPath, options);
        const stat = await fs.stat(safePath);
        if (stat.isDirectory()) {
          return {
            success: false,
            error: `readFile: путь указывает на директорию, а не файл: ${targetPath}. Используй listDir.`
          };
        }
        if (stat.size > MAX_READ_BYTES) {
          return {
            success: false,
            error: `readFile: файл слишком большой (${stat.size} Б, максимум ${MAX_READ_BYTES} Б).`
          };
        }
        const content = await fs.readFile(safePath, 'utf8');
        return { success: true, content, filePath: path.relative(WORKSPACE_ROOT, safePath) };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  writeFile: {
    description:
      'Записывает текст в файл. Создаёт файл и все нужные родительские папки. Для создания только папки используй createDir. Аргументы: { "filePath": "путь/к/файлу", "content": "текст" }',
    async execute(args = {}, options = {}) {
      try {
        const targetPath = args.filePath || args.path;
        if (!targetPath || typeof targetPath !== 'string') {
          return { success: false, error: 'writeFile: не указан filePath' };
        }
        // Если пользователь пишет "папка/" с завершающим слэшем — это ошибка
        if (/[\\/]\s*$/.test(targetPath)) {
          return {
            success: false,
            error: `writeFile: путь "${targetPath}" заканчивается слэшем — похоже, это директория. Используй createDir для создания папки.`
          };
        }
        const content = args.content ?? '';
        if (
          typeof content !== 'string' &&
          typeof content !== 'number' &&
          typeof content !== 'boolean'
        ) {
          return { success: false, error: 'writeFile: content должен быть строкой' };
        }
        const text = String(content);
        const safePath = await resolveSafePath(targetPath, options);
        await fs.mkdir(path.dirname(safePath), { recursive: true });
        await fs.writeFile(safePath, text, 'utf8');
        return {
          success: true,
          filePath: path.relative(WORKSPACE_ROOT, safePath),
          bytesWritten: Buffer.byteLength(text, 'utf8'),
          message: `Файл успешно записан: ${path.relative(WORKSPACE_ROOT, safePath)}`
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  createDir: {
    description:
      'Создаёт директорию (включая все родительские папки, как mkdir -p). Не перезаписывает существующие. Аргументы: { "dirPath": "путь/к/папке" }',
    async execute(args = {}, options = {}) {
      try {
        const targetDir = args.dirPath || args.path;
        if (!targetDir || typeof targetDir !== 'string') {
          return { success: false, error: 'createDir: не указан dirPath' };
        }
        if (/\.\w{1,8}$/.test(targetDir) && !/[\\/]/.test(targetDir)) {
          // Простая эвристика: "foo.txt" — похоже на файл, а не папку
          return {
            success: false,
            error: `createDir: "${targetDir}" похоже на имя файла (есть расширение). Для файлов используй writeFile.`
          };
        }
        const safePath = await resolveSafePath(targetDir, options);

        // Проверяем, существует ли уже
        let existed = false;
        try {
          const stat = await fs.stat(safePath);
          if (!stat.isDirectory()) {
            return {
              success: false,
              error: `createDir: путь уже существует и это не директория: ${targetDir}`
            };
          }
          existed = true;
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }

        await fs.mkdir(safePath, { recursive: true });
        const rel = path.relative(WORKSPACE_ROOT, safePath);
        return {
          success: true,
          dirPath: rel,
          created: !existed,
          message: existed ? `Директория уже существует: ${rel}` : `Директория создана: ${rel}`
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  deleteFile: {
    description: 'Удаляет файл (не директорию). Аргументы: { "filePath": "путь/к/файлу" }',
    async execute(args = {}, options = {}) {
      try {
        const targetPath = args.filePath || args.path;
        if (!targetPath || typeof targetPath !== 'string') {
          return { success: false, error: 'deleteFile: не указан filePath' };
        }
        const safePath = await resolveSafePath(targetPath, options);

        try {
          const stat = await fs.lstat(safePath);
          if (stat.isDirectory()) {
            return {
              success: false,
              error: `deleteFile: путь указывает на директорию, а не файл: ${targetPath}. Удаление директорий не поддерживается.`
            };
          }
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }

        await fs.unlink(safePath);
        return {
          success: true,
          filePath: path.relative(WORKSPACE_ROOT, safePath),
          message: `Файл успешно удален: ${path.relative(WORKSPACE_ROOT, safePath)}`
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  listDir: {
    description: 'Возвращает список файлов и папок в директории. Аргументы: { "dirPath": "." }',
    async execute(args = {}, options = {}) {
      try {
        const targetDir = args.dirPath || args.path || '.';
        const safePath = await resolveSafePath(targetDir, options);
        const stat = await fs.stat(safePath);
        if (!stat.isDirectory()) {
          return { success: false, error: `listDir: путь не является директорией: ${targetDir}` };
        }
        const entries = await fs.readdir(safePath, { withFileTypes: true });
        const items = entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'dir' : 'file'
        }));
        return {
          success: true,
          dirPath: path.relative(WORKSPACE_ROOT, safePath) || '.',
          items
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  analyzeProject: {
    description:
      'Анализирует структуру директории/проекта: файлы, папки, строки кода, зависимости из package.json и крупные файлы. Аргументы: { "dirPath": "." }',
    async execute(args = {}, options = {}) {
      try {
        const targetDir = args.dirPath || args.path || '.';
        const safePath = await resolveSafePath(targetDir, options);
        const dirStat = await fs.stat(safePath);

        if (!dirStat.isDirectory()) {
          return {
            success: false,
            error: `analyzeProject: указанный путь не является директорией: ${targetDir}`
          };
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

        const summary = `Анализ ${relTarget}: папок ${report.totalDirs}, файлов ${report.totalFiles}, строк ${report.totalLines}`;

        return {
          success: true,
          report,
          message: summary
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  generateUnitTest: {
    description:
      'Читает исходный файл и генерирует заготовку unit-теста на node:test. Аргументы: { "sourcePath": "путь/к/модулю.js", "outputPath": "путь/к/тесту.test.js" }',
    async execute(args = {}, options = {}) {
      try {
        const srcInput = args.sourcePath || args.filePath || args.path;
        if (!srcInput || typeof srcInput !== 'string') {
          return {
            success: false,
            error: 'generateUnitTest: не указан путь к исходному файлу (sourcePath).'
          };
        }

        const safeSrc = await resolveSafePath(srcInput, options);
        const sourceCode = await fs.readFile(safeSrc, 'utf8');

        const fnMatches = [
          ...sourceCode.matchAll(
            /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g
          )
        ].map((m) => m[1]);

        const arrowMatches = [
          ...sourceCode.matchAll(
            /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g
          )
        ].map((m) => m[1]);

        const classMatches = [
          ...sourceCode.matchAll(
            /(?:^|\n)\s*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g
          )
        ].map((m) => m[1]);

        const cjsObjectMatch = sourceCode.match(/module\.exports\s*=\s*\{([^}]*)\}/);
        const cjsObjectKeys = cjsObjectMatch
          ? cjsObjectMatch[1]
              .split(',')
              .map((s) => s.trim().split(':')[0].trim())
              .filter((k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k))
          : [];

        const cjsNamedMatches = [
          ...sourceCode.matchAll(/module\.exports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)
        ].map((m) => m[1]);

        const symbols = [
          ...new Set([
            ...fnMatches,
            ...arrowMatches,
            ...classMatches,
            ...cjsObjectKeys,
            ...cjsNamedMatches
          ])
        ];

        const baseName = path.basename(safeSrc, path.extname(safeSrc));
        const defaultOut = `${baseName}.generated.test.js`;
        const rawOut = args.outputPath || defaultOut;
        const safeOut = await resolveSafePath(rawOut, options);

        const relImport = path.relative(path.dirname(safeOut), safeSrc).replaceAll('\\', '/');
        const importPath = relImport.startsWith('.') ? relImport : `./${relImport}`;

        const casesBlock =
          symbols.length > 0
            ? symbols
                .map((sym) =>
                  [
                    `  it('должен импортировать и проверять ${sym}', async () => {`,
                    `    const mod = await import('${importPath}');`,
                    `    assert.ok('${sym}' in mod, 'Ожидался экспорт ${sym}');`,
                    `  });`
                  ].join('\n')
                )
                .join('\n\n')
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
          sourcePath: path.relative(WORKSPACE_ROOT, safeSrc),
          detectedSymbols: symbols,
          message: `Сгенерирован тест: ${relOut} (найдено символов: ${symbols.length})`
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  runCommand: {
    description:
      'Выполняет разрешенную команду из белого списка. Аргументы: { "commandId": "node-version" | "npm-version" | "dir-list" | "git-status" | "git-diff" }. В строгом режиме git-status/git-diff запрещены.',
    async execute(args = {}, options = {}) {
      try {
        const commandId = args.commandId || args.command;
        if (!commandId || typeof commandId !== 'string') {
          return { success: false, error: 'runCommand: не указан commandId' };
        }
        const { stdout, stderr } = await runSafeCommand(commandId, options);
        return {
          success: true,
          commandId,
          exitCode: 0,
          stdout: stdout ?? '',
          stderr: stderr ?? ''
        };
      } catch (err) {
        // Обрыв клиента не маскируем под обычную ошибку инструмента.
        if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
          return {
            success: false,
            aborted: true,
            error: 'Генерация прервана: клиент разорвал соединение'
          };
        }
        return { success: false, error: err.message };
      }
    }
  },

  searchInFiles: {
    description:
      'Ищет строку (или RegExp) по содержимому текстовых файлов директории. Безопасен: игнорирует node_modules/.git, крупные и бинарные файлы, ограничивает выдачу. Аргументы: { "query": "текст", "dirPath": ".", "regex": false, "maxResults": 100 }',
    async execute(args = {}, options = {}) {
      try {
        const query =
          typeof args.query === 'string'
            ? args.query
            : typeof args.pattern === 'string'
              ? args.pattern
              : '';
        if (!query) {
          return { success: false, error: 'searchInFiles: не указан query (строка для поиска)' };
        }
        if (query.length > 512) {
          return {
            success: false,
            error: 'searchInFiles: query слишком длинный (максимум 512 символов)'
          };
        }

        const useRegex = args.regex === true;
        let regex = null;
        if (useRegex) {
          try {
            regex = new RegExp(query);
          } catch (err) {
            return {
              success: false,
              error: `searchInFiles: некорректное регулярное выражение: ${err.message}`
            };
          }
        }
        const needle = useRegex ? null : query.toLowerCase();
        const matches = (line) =>
          useRegex ? regex.test(line) : line.toLowerCase().includes(needle);

        const maxResults =
          Number.isInteger(args.maxResults) && args.maxResults > 0
            ? Math.min(args.maxResults, MAX_SEARCH_RESULTS_LIMIT)
            : MAX_SEARCH_RESULTS;

        const targetDir = args.dirPath || args.path || '.';
        const safeDir = await resolveSafePath(targetDir, options);
        const dirStat = await fs.stat(safeDir);
        if (!dirStat.isDirectory()) {
          return {
            success: false,
            error: `searchInFiles: путь не является директорией: ${targetDir}`
          };
        }

        const results = [];
        let filesScanned = 0;
        let totalMatches = 0;
        let truncated = false;

        async function walk(currentDir) {
          if (truncated) return;
          let entries;
          try {
            entries = await fs.readdir(currentDir, { withFileTypes: true });
          } catch {
            return;
          }

          for (const entry of entries) {
            if (truncated) return;
            if (entry.isSymbolicLink()) continue;
            const fullPath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
              if (SEARCH_IGNORED_DIRS.has(entry.name)) continue;
              await walk(fullPath);
              continue;
            }
            if (!entry.isFile()) continue;
            if (filesScanned >= MAX_SEARCH_FILES) {
              truncated = true;
              return;
            }

            const ext = path.extname(entry.name).toLowerCase();
            if (!SEARCH_TEXT_EXTENSIONS.has(ext)) continue;

            let info;
            try {
              info = await fs.stat(fullPath);
            } catch {
              continue;
            }
            if (info.size === 0 || info.size > MAX_SEARCH_FILE_BYTES) continue;

            let content;
            try {
              content = await fs.readFile(fullPath, 'utf8');
            } catch {
              continue;
            }
            if (content.includes('\u0000')) continue; // бинарный файл

            filesScanned += 1;
            const relFile = path.relative(WORKSPACE_ROOT, fullPath).split(path.sep).join('/');
            const lines = content.split(/\r?\n/);
            for (let li = 0; li < lines.length; li += 1) {
              if (!matches(lines[li])) continue;
              totalMatches += 1;
              const rawText = lines[li].trim();
              results.push({
                file: relFile,
                line: li + 1,
                text: rawText.length > 300 ? `${rawText.slice(0, 300)}…` : rawText
              });
              if (results.length >= maxResults) {
                truncated = true;
                return;
              }
            }
          }
        }

        await walk(safeDir);

        const relDir = path.relative(WORKSPACE_ROOT, safeDir).split(path.sep).join('/') || '.';
        const summary =
          `Найдено совпадений: ${totalMatches} в ${filesScanned} файл(ах) ` +
          `(директория ${relDir}${truncated ? ', выдача усечена' : ''})`;

        return {
          success: true,
          dirPath: relDir,
          query,
          regex: useRegex,
          results,
          totalMatches,
          filesScanned,
          truncated,
          message: summary
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  }
};

const FORBIDDEN_TOOLS = [
  'chat',
  'date',
  'time',
  'getDate',
  'getTime',
  'format',
  'formatCode',
  'prettier',
  'lint',
  'deploy',
  'hash',
  'generateCode',
  'bundle',
  'rollup',
  'webpack',
  'publish',
  'fetch',
  'http',
  'curl',
  'browser',
  'search',
  'webSearch',
  'grep',
  'ripgrep',
  'findstr',
  'mkdir',
  'rmdir',
  'rm',
  'cp',
  'mv',
  'touch'
];

/**
 * Возвращает КАТАЛОГ инструментов. Правила поведения (JSON-формат, песочница,
 * честность) живут в chatFormatter.COGNITIVE_RULES, чтобы не дублироваться
 * и не противоречить друг другу.
 */
export function getToolsSystemPrompt() {
  const toolNames = Object.keys(toolsRegistry);
  const catalog = toolNames
    .map((name) => `- **${name}**: ${toolsRegistry[name].description}`)
    .join('\n');

  const forbiddenList = FORBIDDEN_TOOLS.map((n) => `«${n}»`).join(', ');

  return `ДОСТУПНЫЕ ИНСТРУМЕНТЫ (РОВНО ${toolNames.length}):
${catalog}

ИНСТРУМЕНТОВ ${forbiddenList} и любых других, не перечисленных выше, НЕ СУЩЕСТВУЕТ.
Если для запроса нет подходящего инструмента (например, узнать дату, погоду, курс валют) — ответь честным текстом: «У меня нет такого инструмента».`;
}
