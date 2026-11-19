import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { toolsRegistry } from '../src/tools/registry.js';

describe('Конструкт АИ — Тест инструмента generateUnitTest', () => {
  const srcRel = 'tests/sandbox/math-sample.js';
  const outRel = 'tests/sandbox/math-sample.generated.test.js';

  after(async () => {
    await fs.rm(path.resolve(srcRel), { force: true }).catch(() => {});
    await fs.rm(path.resolve(outRel), { force: true }).catch(() => {});
  });

  it('Должен создать файл теста на node:test по исходному модулю', async () => {
    await fs.writeFile(
      path.resolve(srcRel),
      'export function sum(a, b) { return a + b; }\n',
      'utf8'
    );

    const res = await toolsRegistry.generateUnitTest.execute({
      sourcePath: 'math-sample.js',
      outputPath: 'math-sample.generated.test.js'
    });

    assert.equal(res.success, true, `Ожидался успех, получено: ${res.error}`);
    assert.ok(res.detectedSymbols.includes('sum'));

    const generated = await fs.readFile(path.resolve(outRel), 'utf8');
    assert.match(generated, /from 'node:test'/);
    assert.match(generated, /sum/);
  });
});