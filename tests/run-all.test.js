import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const SERVER_URL = 'http://localhost:3000';
const RUN_LLM_TESTS = process.env.RUN_LLM_TESTS === 'true';
let serverProcess = null;

/**
 * Ожидание готовности HTTP-сервера
 */
async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Сервер еще поднимается
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Сервер не ответил на ${url} за ${timeoutMs} мс`);
}

describe('Open-Claw Local Agent — Единый набор тестов', () => {
  before(async () => {
    console.log('🚀 Запуск фонового сервера для тестов...');
    // Используем 'inherit', чтобы все логи и ошибки сервера выводились в терминал
    serverProcess = spawn(process.execPath, ['src/server.js'], {
      stdio: 'inherit',
      env: { ...process.env, PORT: '3000' }
    });

    await waitForServer(SERVER_URL);
    console.log('✅ Сервер готов к тестированию.\n');
  });

  after(() => {
    if (serverProcess) {
      console.log('\n🛑 Остановка тестового сервера...');
      serverProcess.kill();
    }
  });

  it('1. Проверка безопасности песочницы (блокировка Directory Traversal и неразрешенных команд)', async () => {
    const { toolsRegistry } = await import('../src/tools/registry.js');

    const readAttempt = await toolsRegistry.readFile.execute({ filePath: '../package.json' });
    assert.ok(readAttempt.error, 'Должна вернуться ошибка при попытке чтения выше корня');

    const writeAttempt = await toolsRegistry.writeFile.execute({
      filePath: '../../hack.txt',
      content: 'test'
    });
    assert.ok(writeAttempt.error, 'Должна вернуться ошибка при попытке записи выше корня');

    const cmdAttempt = await toolsRegistry.runCommand.execute({ commandId: 'rm -rf /' });
    assert.ok(cmdAttempt.error, 'Должна вернуться ошибка при попытке вызова команды вне белого списка');
  });

  it('2. Проверка работы инструментов внутри tests/sandbox/', async () => {
    const { toolsRegistry } = await import('../src/tools/registry.js');
    const testFile = 'tests/sandbox/auto-check.txt';

    const writeRes = await toolsRegistry.writeFile.execute({
      filePath: testFile,
      content: 'Hello from automated test!'
    });
    assert.equal(writeRes.success, true, `Ошибка записи: ${writeRes.error}`);

    const readRes = await toolsRegistry.readFile.execute({ filePath: testFile });
    assert.equal(readRes.success, true, `Ошибка чтения: ${readRes.error}`);
    assert.equal(readRes.content, 'Hello from automated test!');

    // Удаляем временный файл после проверки
    await fs.rm(path.resolve(testFile), { force: true });
  });

  it('3. Проверка невалидного запроса к API (статус 400)', async () => {
    const res = await fetch(`${SERVER_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error, 'Ответ 400 должен содержать поле error');
  });

  it('4. Проверка безопасной команды из белого списка (node-version)', async () => {
    const { toolsRegistry } = await import('../src/tools/registry.js');
    const cmdRes = await toolsRegistry.runCommand.execute({ commandId: 'node-version' });
    assert.equal(cmdRes.success, true, `Ошибка выполнения команды: ${cmdRes.error}`);
    assert.match(cmdRes.stdout.trim(), /^v\d+\.\d+\.\d+/);
  });

  it(
    '5. Сквозной HTTP-тест к запущенному серверу с реальной LLM (при RUN_LLM_TESTS=true)',
    { skip: !RUN_LLM_TESTS, timeout: 300_000 },
    async () => {
      console.log('   ▶ Отправка тестового запроса к локальному агенту через HTTP...');
      
      const res = await fetch(`${SERVER_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Привет! Напиши одно слово: тест' }],
          stream: false
        })
      });

      assert.equal(res.status, 200, `Сервер вернул статус ${res.status}`);
      const data = await res.json();
      
      assert.ok(data.choices, 'Ответ должен содержать поле choices');
      assert.ok(data.choices.length > 0, 'Массив choices не должен быть пустым');
      console.log('   ✔ Ответ от локальной LLM успешно получен:', data.choices[0].message.content.trim());
    }
  );
});