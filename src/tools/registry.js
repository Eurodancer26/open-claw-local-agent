// src/tools/registry.js
import fs from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE_ROOT, SANDBOX_REL, sandboxConfig, resolveSafePath } from './pathSecurity.js';
import { scanProjectStats } from './projectScanner.js';
import { runSafeCommand } from './safeCommands.js';

export { sandboxConfig, resolveSafePath };

const MAX_READ_BYTES = 5 * 1024 * 1024; // 5 МБ — потолок для readFile

export const toolsRegistry = {
  readFile: {
    description: 'Читает содержимое файла. Аргументы: { "filePath": "путь/к/файлу" }',
    async execute(args = {}) {
      try {
        const targetPath = args.filePath || args.path;
        if (!targetPath || typeof targetPath !== 'string') {
          return { success: false, error: 'readFile: не указан filePath' };
        }
        const safePath = await resolveSafePath(targetPath);
        const stat = await fs.stat(safePath);
        if (stat.isDirectory()) {
          return { success: false, error: `readFile: путь указывает на директорию, а не файл: ${targetPath}` };
        }
        if (stat.size > MAX_READ_BYTES) {
          return {
            success: false,
            error: `readFile: файл слишком большой (${stat.size} Б, максимум ${MAX_READ_BYTES} Б). Используй другой инструмент или прочитай фрагмент вручную.`
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
    description: 'Записывает текст в файл. Аргументы: { "filePath": "путь/к/файлу", "content": "текст" }',
    async execute(args = {}) {
      try {
        const targetPath = args.filePath || args.path;
        if (!targetPath || typeof targetPath !== 'string') {
          return { success: false, error: 'writeFile: не указан filePath' };
        }
        const content = args.content ?? '';
        if (typeof content !== 'string' && typeof content !== 'number' && typeof content !== 'boolean') {
          return { success: false, error: 'writeFile: content должен быть строкой' };
        }
        const text = String(content);
        const safePath = await resolveSafePath(targetPath);
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

  deleteFile: {
    description: 'Удаляет файл. Аргументы: { "filePath": "путь/к/файлу" }',
    async execute(args = {}) {
      try {
        const targetPath = args.filePath || args.path;
        if (!targetPath || typeof targetPath !== 'string') {
          return { success: false, error: 'deleteFile: не указан filePath' };
        }
        const safePath = await resolveSafePath(targetPath);

        try {
          const stat = await fs.lstat(safePath);
          if (stat.isDirectory()) {
            return { success: false, error: `deleteFile: путь указывает на директорию, а не файл: ${targetPath}. Удаление директорий не поддерживается.` };
          }
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
          // Если файла нет — unlink ниже сам даст понятную ошибку ENOENT.
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
    async execute(args = {}) {
      try {
        const targetDir = args.dirPath || args.path || '.';
        const safePath = await resolveSafePath(targetDir);
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
    description: 'Анализирует структуру директории/проекта: файлы, папки, строки кода, зависимости из package.json и крупные файлы. Аргументы: { "dirPath": "." }',
    async execute(args = {}) {
      try {
        const targetDir = args.dirPath || args.path || '.';
        const safePath = await resolveSafePath(targetDir);
        const dirStat = await fs.stat(safePath);

        if (!dirStat.isDirectory()) {
          return { success: false, error: `analyzeProject: указанный путь не является директорией: ${targetDir}` };
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
    description: 'Читает исходный файл и генерирует заготовку unit-теста на node:test. Аргументы: { "sourcePath": "путь/к/модулю.js", "outputPath": "путь/к/тесту.test.js" }',
    async execute(args = {}) {
      try {
        const srcInput = args.sourcePath || args.filePath || args.path;
        if (!srcInput || typeof srcInput !== 'string') {
          return { success: false, error: 'generateUnitTest: не указан путь к исходному файлу (sourcePath).' };
        }

        const safeSrc = await resolveSafePath(srcInput);
        const sourceCode = await fs.readFile(safeSrc, 'utf8');

        // Определение экспортируемых символов (несколько форматов)
        const fnMatches = [
          ...sourceCode.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)
        ].map((m) => m[1]);

        const arrowMatches = [
          ...sourceCode.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g)
        ].map((m) => m[1]);

        const classMatches = [
          ...sourceCode.matchAll(/(?:^|\n)\s*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)
        ].map((m) => m[1]);

        // module.exports = { a, b, c }
        const cjsObjectMatch = sourceCode.match(/module\.exports\s*=\s*\{([^}]*)\}/);
        const cjsObjectKeys = cjsObjectMatch
          ? cjsObjectMatch[1]
              .split(',')
              .map((s) => s.trim().split(':')[0].trim())
              .filter((k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k))
          : [];

        // module.exports.name = ...
        const cjsNamedMatches = [
          ...sourceCode.matchAll(/module\.exports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)
        ].map((m) => m[1]);

        const symbols = [
          ...new Set([...fnMatches, ...arrowMatches, ...classMatches, ...cjsObjectKeys, ...cjsNamedMatches])
        ];

        const baseName = path.basename(safeSrc, path.extname(safeSrc));
        const defaultOut = `${baseName}.generated.test.js`;
        const rawOut = args.outputPath || defaultOut;
        const safeOut = await resolveSafePath(rawOut);

        const relImport = path
          .relative(path.dirname(safeOut), safeSrc)
          .replaceAll('\\', '/');
        const importPath = relImport.startsWith('.') ? relImport : `./${relImport}`;

        const casesBlock = symbols.length > 0
          ? symbols
              .map(
                (sym) => [
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
    description: 'Выполняет разрешенную команду из белого списка. Аргументы: { "commandId": "node-version" | "npm-version" | "dir-list" | "git-status" | "git-diff" }',
    async execute(args = {}) {
      try {
        const commandId = args.commandId || args.command;
        if (!commandId || typeof commandId !== 'string') {
          return { success: false, error: 'runCommand: не указан commandId' };
        }
        const { stdout, stderr } = await runSafeCommand(commandId);
        return {
          success: true,
          commandId,
          exitCode: 0,
          stdout: stdout ?? '',
          stderr: stderr ?? ''
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  }
};

const FORBIDDEN_TOOLS = [
  'chat', 'date', 'time', 'getDate', 'getTime',
  'format', 'formatCode', 'prettier', 'lint', 'deploy', 'hash',
  'generateCode', 'bundle', 'rollup', 'webpack', 'publish',
  'fetch', 'http', 'curl', 'browser', 'search', 'webSearch'
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