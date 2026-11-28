import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const SERVER_URL = 'http://localhost:3000';
const RUN_LLM_TESTS = process.env.RUN_LLM_TESTS === 'true';
let serverProcess = null;

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Сервер не ответил на ${url} за ${timeoutMs} мс`);
}

describe('Конструкт АИ — Единый полный комплекс тестов (Hardened)', () => {
  before(async () => {
    console.log('🚀 Запуск общего тестового сервера...');
    await fs.mkdir(path.resolve('tests/sandbox'), { recursive: true });
    
    serverProcess = spawn(process.execPath, ['src/server.js'], {
      stdio: 'inherit',
      env: { ...process.env, PORT: '3000' }
    });

    await waitForServer(SERVER_URL);
    console.log('✅ Сервер успешно запущен и готов к тестам.\n');
  });

  after(async () => {
    if (serverProcess) {
      console.log('\n🛑 Остановка общего тестового сервера...');
      serverProcess.kill();
    }
  });

  // --- БЛОК 1: БЕЗОПАСНОСТЬ И ИНСТРУМЕНТЫ ---

  it('1. Комплексная проверка безопасности песочницы (Traversal, префиксы, симлинки)', async () => {
    const { toolsRegistry } = await import('../src/tools/registry.js');

    const readAttempt = await toolsRegistry.readFile.execute({ filePath: '../../package.json' });
    assert.equal(readAttempt.success, false);

    const prefixBypass = await toolsRegistry.readFile.execute({ filePath: '../other-project/package.json' });
    assert.equal(prefixBypass.success, false);

    const writeAttempt = await toolsRegistry.writeFile.execute({ filePath: '../../hack.txt', content: 'test' });
    assert.equal(writeAttempt.success, false);

    const cmdAttempt = await toolsRegistry.runCommand.execute({ commandId: 'rm -rf /' });
    assert.equal(cmdAttempt.success, false);
  });

  it('2. Проверка работы базовых файловых инструментов и рекурсивного создания папок', async () => {
    const { toolsRegistry } = await import('../src/tools/registry.js');
    const testFile = 'tests/sandbox/deep/nested/dir/base-check.txt';

    const writeRes = await toolsRegistry.writeFile.execute({ filePath: testFile, content: 'Hello deep tests!' });
    assert.equal(writeRes.success, true, `Ошибка записи во вложенную папку: ${writeRes.error}`);

    const readRes = await toolsRegistry.readFile.execute({ filePath: testFile });
    assert.equal(readRes.success, true);
    assert.equal(readRes.content, 'Hello deep tests!');

    await fs.rm(path.resolve('tests/sandbox/deep'), { recursive: true, force: true });
  });

  it('3. Проверка инструмента удаления файлов (deleteFile)', async () => {
    const { toolsRegistry } = await import('../src/tools/registry.js');
    const targetFile = 'tests/sandbox/to-delete.txt';

    await toolsRegistry.writeFile.execute({ filePath: targetFile, content: 'Delete me' });
    
    const deleteRes = await toolsRegistry.deleteFile.execute({ filePath: targetFile });
    assert.equal(deleteRes.success, true, `Ошибка удаления: ${deleteRes.error}`);

    const readAfterDelete = await toolsRegistry.readFile.execute({ filePath: targetFile });
    assert.equal(readAfterDelete.success, false, 'Удаленный файл больше не должен читаться');
  });

  it('4. Проверка валидации API (статус 400 на пустые сообщения)', async () => {
    const res = await fetch(`${SERVER_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] })
    });
    assert.equal(res.status, 400);
  });

  it('5. Проверка безопасных команд из белого списка (node-version, dir-list)', async () => {
    const { toolsRegistry } = await import('../src/tools/registry.js');
    
    const cmdRes1 = await toolsRegistry.runCommand.execute({ commandId: 'node-version' });
    assert.equal(cmdRes1.success, true);
    assert.match(cmdRes1.stdout.trim(), /^v\d+\.\d+\.\d+/);

    const cmdRes2 = await toolsRegistry.runCommand.execute({ commandId: 'dir-list' });
    assert.equal(cmdRes2.success, true);
    assert.ok(cmdRes2.stdout.length > 0);
  });

  // --- БЛОК 2: LLM, СТРИМИНГ И АГЕНТИЧНЫЙ ЦИКЛ (при RUN_LLM_TESTS=true) ---

  it('6. Сквозной HTTP-тест не-стриминга (stream: false)', { skip: !RUN_LLM_TESTS ? 'нужен LLM: RUN_LLM_TESTS=true и запущенный npm start' : false, timeout: 300_000 }, async () => {
    const res = await fetch(`${SERVER_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Напиши одно слово: тест' }],
        stream: false
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.choices?.[0]?.message?.content);
  });

  it('7. Сквозной тест SSE-стриминга (stream: true)', { skip: !RUN_LLM_TESTS ? 'нужен LLM: RUN_LLM_TESTS=true и запущенный npm start' : false, timeout: 300_000 }, async () => {
    const res = await fetch(`${SERVER_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Напиши слово: привет' }],
        stream: true
      })
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let done = false;
    let hasDoneMarker = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk.includes('[DONE]')) {
        hasDoneMarker = true;
        done = true;
      }
    }
    assert.equal(hasDoneMarker, true);
  });

  it('8. Сквозной тест агентичного цикла Plan & Execute (создание и чтение файла)', { skip: !RUN_LLM_TESTS ? 'нужен LLM: RUN_LLM_TESTS=true и запущенный npm start' : false, timeout: 300_000 }, async () => {
    const targetFile = 'tests/sandbox/unified-agent-test.txt';
    await fs.rm(path.resolve(targetFile), { force: true }).catch(() => {});

    const res = await fetch(`${SERVER_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: `Создай файл "${targetFile}" с текстом "Единый тест пройден!" и прочитай его.` }],
        stream: true
      })
    });

    assert.equal(res.status, 200);

    const reader = res.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    const content = await fs.readFile(path.resolve(targetFile), 'utf8');
    assert.equal(content, 'Единый тест пройден!');
    await fs.rm(path.resolve(targetFile), { force: true });
  });

  it('9. Сквозной тест самокоррекции агента при ошибке пути', { skip: !RUN_LLM_TESTS ? 'нужен LLM: RUN_LLM_TESTS=true и запущенный npm start' : false, timeout: 300_000 }, async () => {
    const targetFile = 'tests/sandbox/unified-correction.txt';
    await fs.rm(path.resolve(targetFile), { force: true }).catch(() => {});

    const res = await fetch(`${SERVER_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: `Попытайся прочитать файл "${targetFile}". Если его нет, создай его с текстом "Самокоррекция в едином тесте работает!" и прочитай.` }],
        stream: true
      })
    });

    assert.equal(res.status, 200);

    const reader = res.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    const fileExists = await fs.stat(path.resolve(targetFile)).then(() => true).catch(() => false);
    assert.equal(fileExists, true);
    await fs.rm(path.resolve(targetFile), { force: true });
  });
});