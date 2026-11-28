import fs from 'node:fs/promises';
import path from 'node:path';

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
  '.env',
  '.sh',
  '.sql'
]);

/**
 * Рекурсивно собирает статистику по директории с ограничением глубины и числа файлов
 */
export async function scanProjectStats(rootDir, maxDepth = 4, maxFiles = 250) {
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
