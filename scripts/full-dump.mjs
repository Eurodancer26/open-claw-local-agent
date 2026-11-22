import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureSandboxSnapshot } from '../src/core/reporter.js';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const DEFAULT_REPOMIX_OUT = path.join(ROOT, 'repomix-output.xml');
const FULL_DUMP_OUT = path.join(ROOT, 'full-project-dump.xml');

function escapeCdata(value) {
  return String(value ?? '').replaceAll(']]>', ']]]]><![CDATA[>');
}

async function runRepomixToFile(outputFile) {
  const localRepomixCli = path.join(ROOT, 'node_modules', 'repomix', 'bin', 'repomix.js');
  const hasLocalCli = await fs
    .access(localRepomixCli)
    .then(() => true)
    .catch(() => false);

  if (hasLocalCli) {
    await execFileAsync(process.execPath, [localRepomixCli, '--output', outputFile], {
      cwd: ROOT,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true
    });
    return;
  }

  // На Windows без лишних кавычек: repomix сам пишет repomix-output.xml в cwd
  await execFileAsync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['repomix@latest'], {
    cwd: ROOT,
    maxBuffer: 20 * 1024 * 1024,
    shell: process.platform === 'win32',
    windowsHide: true
  });
}

async function collectReportsFiles(dirPath, baseRel = 'reports') {
  const files = [];
  let entries = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dirPath, entry.name);
    const rel = `${baseRel}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await collectReportsFiles(full, rel)));
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(full);
        if (stat.size <= 512 * 1024) {
          const content = await fs.readFile(full, 'utf8');
          files.push({ path: rel, sizeBytes: stat.size, content });
        } else {
          files.push({
            path: rel,
            sizeBytes: stat.size,
            content: `[Файл слишком большой для полного дампа: ${stat.size} Б]`
          });
        }
      } catch (err) {
        files.push({ path: rel, sizeBytes: 0, content: `[Ошибка чтения: ${err.message}]` });
      }
    }
  }
  return files;
}

async function runFullDump() {
  console.log('📦 Шаг 1/3: Упаковка кодовой базы через repomix...');
  await runRepomixToFile(DEFAULT_REPOMIX_OUT);

  const baseXml = await fs.readFile(DEFAULT_REPOMIX_OUT, 'utf8');

  console.log('📂 Шаг 2/3: Сбор содержимого tests/sandbox/ и reports/...');
  const sandboxItems = await captureSandboxSnapshot(30000, 300);
  const reportFiles = await collectReportsFiles(path.join(ROOT, 'reports'));

  const sandboxXml = sandboxItems
    .map((item) => {
      if (item.type === 'dir') {
        return `    <sandboxEntry type="dir" path="${item.path}" />`;
      }
      return [
        `    <sandboxEntry type="file" path="${item.path}" sizeBytes="${item.sizeBytes}">`,
        `      <content><![CDATA[${escapeCdata(item.content)}]]></content>`,
        '    </sandboxEntry>'
      ].join('\n');
    })
    .join('\n');

  const reportsXml = reportFiles
    .map((rf) => [
      `    <reportFile path="${rf.path}" sizeBytes="${rf.sizeBytes}">`,
      `      <content><![CDATA[${escapeCdata(rf.content)}]]></content>`,
      '    </reportFile>'
    ].join('\n'))
    .join('\n');

  const extraSection = [
    '',
    '<full_project_extensions generatedAt="' + new Date().toISOString() + '">',
    '  <sandbox_files>',
    sandboxXml || '    <!-- tests/sandbox/ пуста -->',
    '  </sandbox_files>',
    '  <reports_files>',
    reportsXml || '    <!-- reports/ пуста -->',
    '  </reports_files>',
    '</full_project_extensions>'
  ].join('\n');

  const merged = baseXml.includes('</repomix>')
    ? baseXml.replace('</repomix>', `${extraSection}\n</repomix>`)
    : `${baseXml}\n${extraSection}`;

  console.log('💾 Шаг 3/3: Запись полного дампа в full-project-dump.xml...');
  await fs.writeFile(FULL_DUMP_OUT, merged, 'utf8');

  console.log(`✅ Готово! Полный дамп сохранён: ${FULL_DUMP_OUT}`);
  console.log(`   - Файлов/папок в sandbox: ${sandboxItems.length}`);
  console.log(`   - Файлов репортов включено: ${reportFiles.length}`);
}

runFullDump().catch((err) => {
  console.error('❌ Ошибка формирования полного дампа:', err);
  process.exit(1);
});