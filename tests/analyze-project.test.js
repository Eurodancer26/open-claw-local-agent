import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { toolsRegistry } from '../src/tools/registry.js';

describe('Конструкт АИ — Тест инструмента analyzeProject', () => {
  const probeDirRel = 'tests/sandbox/project-probe';
  const probeDirAbs = path.resolve(probeDirRel);

  after(async () => {
    await fs.rm(probeDirAbs, { recursive: true, force: true }).catch(() => {});
  });

  it('Должен просканировать директорию в песочнице и вернуть статистику файлов и строк', async () => {
    await fs.mkdir(path.join(probeDirAbs, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(probeDirAbs, 'src', 'index.js'),
      'export const add = (a, b) => a + b;\nconsole.log(add(2, 3));\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(probeDirAbs, 'README.md'),
      '# Тестовый мини-проект\nОписание.\n',
      'utf8'
    );

    const res = await toolsRegistry.analyzeProject.execute({ dirPath: 'project-probe' });

    assert.equal(res.success, true, `Ожидался успех, получено: ${res.error}`);
    assert.equal(res.report.totalFiles, 2);
    assert.ok(res.report.totalLines >= 4);
    assert.equal(res.report.byExtension['.js'], 1);
    assert.equal(res.report.byExtension['.md'], 1);
  });
});