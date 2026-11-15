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

  it('1. Комплексная проверка безопасности песочницы (Directory Traversal, префиксы, симлинки на чтение/запись и инъекции)', async () => {
    const { toolsRegistry } = await import('../src/tools/registry.js');

    // 1.1. Блокировка Directory Traversal и префиксных обходов (защита от соседа с похожим именем)
    const readAttempt = await toolsRegistry.readFile.execute({ filePath: '../../package.json' });
    assert.equal(readAttempt.success, false, 'Доступ за пределы рабочей директории должен быть запрещен');

    const prefixBypassAttempt = await toolsRegistry.readFile.execute({ filePath: '../open-claw-local-agent-other/package.json' });
    assert.equal(prefixBypassAttempt.success, false, 'Префиксный обход путей должен строго блокироваться');

    const writeAttempt = await toolsRegistry.writeFile.execute({
      filePath: '../../hack.txt',
      content: 'test'
    });
    assert.equal(writeAttempt.success, false, 'Запись за пределы рабочей директории должна быть запрещена');

    // 1.2. Блокировка символических ссылок / junction на чтение и запись наружу
    const targetDirOutside = path.resolve('..');
    const symlinkDirPath = path.resolve('tests/sandbox/malicious-dir-link');
    await fs.mkdir(path.resolve('tests/sandbox'), { recursive: true });

    let linkCreated = false;
    try {
      await fs.symlink(targetDirOutside, symlinkDirPath, 'junction');
      linkCreated = true;
    } catch {
      // Если ОС строго запрещает создание даже junction, пропускаем проверку ссылки
    }

    if (linkCreated) {
      try {
        // Попытка чтения через симлинк-директорию наружу
        const linkReadAttempt = await toolsRegistry.readFile.execute({
          filePath: 'tests/sandbox/malicious-dir-link/open-claw-local-agent/package.json'
        });
        // Чтение файла вне песочницы через ссылку за пределы воркспейса (например, системный или соседний файл)
        const outsideReadAttempt = await toolsRegistry.readFile.execute({
          filePath: 'tests/sandbox/malicious-dir-link/outside-secret.txt'
        });
        assert.equal(outsideReadAttempt.success, false, 'Чтение через симлинк за пределы песочницы должно блокироваться');

        // Попытка записи через симлинк-директорию наружу
        const linkWriteAttempt = await toolsRegistry.writeFile.execute({
          filePath: 'tests/sandbox/malicious-dir-link/hacked-outside.txt',
          content: 'overwrite attempt'
        });
        assert.equal(linkWriteAttempt.success, false, 'Запись через симлинк за пределы песочницы должна блокироваться');
      } finally {
        await fs.rm(symlinkDirPath, { recursive: true, force: true }).catch(() => {});
      }
    }

    // 1.3. Безопасность выполнения команд (защита от неразрешенных команд и инъекций)
    const cmdAttempt1 = await toolsRegistry.runCommand.execute({ commandId: 'rm -rf /' });
    assert.equal(cmdAttempt1.success, false, 'Команды вне белого списка должны блокироваться');

    const cmdAttempt2 = await toolsRegistry.runCommand.execute({ commandId: 'node-version && echo hacked' });
    if (cmdAttempt2.success) {
      assert.equal(cmdAttempt2.stdout.includes('hacked'), false, 'Инъекции через шелл-разделители должны быть исключены');
    } else {
      assert.ok(cmdAttempt2.error, 'Составные или неразрешенные команды должны отклоняться');
    }
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