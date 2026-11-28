// scripts/full-dump.mjs
// Собирает полный дамп проекта в один XML: код, конфиги, память агента,
// веса роутера, песочницу и отчёты. Работает без внешних зависимостей.
// Запуск: node scripts/full-dump.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'full-project-dump.xml');

// ─────────────────────────────────────────────────────────────
// Что попадает в дамп. Порядок = порядок секций в XML.
// ─────────────────────────────────────────────────────────────
const SECTIONS = [
  {
    id: 'config',
    title: 'Конфигурация',
    paths: ['.gitignore', 'package.json', 'README.md', 'LICENSE'],
    type: 'files'
  },
  {
    id: 'source',
    title: 'Исходный код',
    paths: ['src'],
    type: 'dir'
  },
  {
    id: 'public',
    title: 'Веб-интерфейс',
    paths: ['public'],
    type: 'dir'
  },
  {
    id: 'scripts',
    title: 'Служебные скрипты',
    paths: ['scripts'],
    type: 'dir'
  },
  {
    id: 'tests',
    title: 'Тесты',
    paths: ['tests'],
    type: 'dir',
    // sandbox вынесен в отдельную секцию ниже
    exclude: /^tests\/sandbox\//
  },
  {
    id: 'mind',
    title: 'Память агента (mind/)',
    paths: ['mind'],
    type: 'dir',
    maxFileSize: 100 * 1024,
    note: 'Рекурсивная память: state.json и reflections/*.md. Игнорируется git, но критична для понимания поведения агента и накопленных антипаттернов.'
  },
  {
    id: 'models',
    title: 'Веса нейро-роутера',
    paths: ['models/neural_router_weights.json'],
    type: 'files',
    note: 'Обученные веса. Игнорируются git, но показывают текущее состояние роутера.'
  },
  {
    id: 'sandbox',
    title: 'Песочница (tests/sandbox/)',
    paths: ['tests/sandbox'],
    type: 'dir',
    note: 'Текущее содержимое изолированной директории — артефакты последних прогонов.'
  },
  {
    id: 'reports',
    title: 'Отчёты трассировки',
    paths: ['reports'],
    type: 'dir',
    maxFileSize: 200 * 1024,
    note: 'XML-отчёты из reports/chats/ и reports/tests/. Обрезаются до 200 KB на файл.'
  }
];

// ─────────────────────────────────────────────────────────────
// Исключения — что никогда не попадает в дамп
// ─────────────────────────────────────────────────────────────
const EXCLUDED = [
  /node_modules\//,
  /\.git\//,
  /\.gguf$/i, // бинарные модели (гигантские)
  /\.bin$/i,
  /\.(zip|tar|gz|7z|rar)$/i,
  /\.(png|jpe?g|gif|ico|svg|webp|bmp)$/i,
  /\.(mp3|mp4|wav|ogg|webm|mkv)$/i,
  /\.(exe|dll|so|dylib|wasm)$/i
];

const MAX_FILE_SIZE = 500 * 1024; // 500 KB на файл по умолчанию

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const isExcluded = (p) => EXCLUDED.some((re) => re.test(p));

const escXml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const escCdata = (s) =>
  String(s ?? '')
    .split(']]>')
    .join(']]]]><![CDATA[>');

// XML 1.0 не допускает большинство control-символов
const stripCtl = (s) =>
  String(s ?? '')
    // eslint-disable-next-line no-control-regex -- намеренно вырезаем управляющие символы для XML
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

async function walk(dir, relBase, exclude = null, maxFileSize = MAX_FILE_SIZE) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const e of sorted) {
    const full = path.join(dir, e.name);
    const rel = `${relBase}/${e.name}`.replace(/^\/+/, '').replaceAll('\\', '/');

    if (isExcluded(rel)) continue;
    if (exclude && exclude.test(rel)) continue;

    if (e.isDirectory()) {
      out.push(...(await walk(full, rel, exclude, maxFileSize)));
    } else if (e.isFile()) {
      try {
        const stat = await fs.stat(full);
        if (stat.size > maxFileSize) {
          out.push({
            path: rel,
            size: stat.size,
            content: `[Файл слишком велик для полного дампа: ${stat.size} Б, лимит ${maxFileSize} Б]`,
            truncated: true
          });
        } else {
          const content = await fs.readFile(full, 'utf8');
          out.push({ path: rel, size: stat.size, content });
        }
      } catch (err) {
        out.push({ path: rel, size: 0, content: `[Ошибка чтения: ${err.message}]` });
      }
    }
  }
  return out;
}

async function collectSection(section) {
  const files = [];
  for (const p of section.paths) {
    const full = path.join(ROOT, p);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) continue;

    if (section.type === 'files' || stat.isFile()) {
      if (stat.size > MAX_FILE_SIZE) {
        files.push({
          path: p,
          size: stat.size,
          content: `[Файл слишком велик: ${stat.size} Б]`,
          truncated: true
        });
      } else {
        const content = await fs.readFile(full, 'utf8');
        files.push({ path: p, size: stat.size, content });
      }
    } else if (stat.isDirectory()) {
      files.push(...(await walk(full, p, section.exclude, section.maxFileSize || MAX_FILE_SIZE)));
    }
  }
  return files;
}

async function buildDirectoryTree() {
  const lines = ['open-claw-local-agent/'];

  async function walkTree(dir, prefix = '') {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const filtered = entries
      .filter((e) => {
        const rel = path.relative(ROOT, path.join(dir, e.name)).replaceAll('\\', '/');
        return !isExcluded(rel);
      })
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    for (let i = 0; i < filtered.length; i++) {
      const e = filtered[i];
      const isLast = i === filtered.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');

      lines.push(`${prefix}${connector}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory()) {
        await walkTree(path.join(dir, e.name), nextPrefix);
      }
    }
  }

  await walkTree(ROOT);
  return lines.join('\n');
}

function renderFile(f) {
  const truncatedAttr = f.truncated ? ' truncated="true"' : '';
  return [
    `    <file path="${escXml(f.path)}" sizeBytes="${f.size}"${truncatedAttr}>`,
    `      <content><![CDATA[${escCdata(stripCtl(f.content))}]]></content>`,
    `    </file>`
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log('📦 Собираю полный дамп проекта...\n');

  const collected = [];
  let totalFiles = 0;
  let totalBytes = 0;

  for (const section of SECTIONS) {
    const files = await collectSection(section);
    if (files.length === 0) continue;

    const bytes = files.reduce((a, f) => a + f.size, 0);
    totalFiles += files.length;
    totalBytes += bytes;

    console.log(
      `  ✓ ${section.title.padEnd(24)} ${String(files.length).padStart(3)} файл(ов), ${(bytes / 1024).toFixed(1).padStart(8)} KB`
    );
    collected.push({ section, files });
  }

  console.log(`\n📊 Итого: ${totalFiles} файлов, ${(totalBytes / 1024 / 1024).toFixed(2)} MB\n`);
  console.log('🌳 Строю дерево директорий...');
  const tree = await buildDirectoryTree();

  const parts = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<full_project_dump generatedAt="${new Date().toISOString()}">`,
    '  <metadata>',
    `    <projectName>open-claw-local-agent</projectName>`,
    `    <rootPath>${escXml(ROOT)}</rootPath>`,
    `    <nodeVersion>${escXml(process.version)}</nodeVersion>`,
    `    <platform>${escXml(process.platform)}</platform>`,
    `    <totalFiles>${totalFiles}</totalFiles>`,
    `    <totalSizeBytes>${totalBytes}</totalSizeBytes>`,
    '  </metadata>',
    '  <directory_structure><![CDATA[',
    stripCtl(tree),
    '  ]]></directory_structure>'
  ];

  for (const { section, files } of collected) {
    parts.push(`  <section id="${escXml(section.id)}" fileCount="${files.length}">`);
    parts.push(`    <title>${escXml(section.title)}</title>`);
    if (section.note) {
      parts.push(`    <note>${escXml(section.note)}</note>`);
    }
    parts.push('    <files>');
    for (const f of files) parts.push(renderFile(f));
    parts.push('    </files>');
    parts.push('  </section>');
  }

  parts.push('</full_project_dump>');
  parts.push('');

  const xml = parts.join('\n');
  await fs.writeFile(OUTPUT, xml, 'utf8');

  const ms = Date.now() - t0;
  const kb = (Buffer.byteLength(xml, 'utf8') / 1024).toFixed(1);

  console.log(`\n✅ Готово: ${OUTPUT}`);
  console.log(`   ${kb} KB, ${ms} ms`);
}

main().catch((err) => {
  console.error('❌ Ошибка при создании дампа:', err);
  process.exit(1);
});
