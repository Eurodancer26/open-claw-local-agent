import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const SERVER_URL = 'http://localhost:3002';
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

describe('Конструкт АИ — Сквозной тест самокоррекции агента', () => {
  const targetFile = 'tests/sandbox/corrected-file.txt';

  before(async () => {
    await fs.mkdir(path.resolve('tests/sandbox'), { recursive: true });
    await fs.rm(path.resolve(targetFile), { force: true }).catch(() => {});

    console.log('🚀 Запуск сервера для теста самокоррекции на порту 3002...');
    serverProcess = spawn(process.execPath, ['src/server.js'], {
      stdio: 'inherit',
      env: { ...process.env, PORT: '3002' }
    });
    await waitForServer(SERVER_URL);
  });

  after(async () => {
    if (serverProcess) {
      console.log('\n🛑 Остановка тестового сервера...');
      serverProcess.kill();
    }
    await fs.rm(path.resolve(targetFile), { force: true }).catch(() => {});
  });

  it(
    'Агент должен обработать ошибку, запустить самокоррекцию и создать файл',
    { skip: !RUN_LLM_TESTS, timeout: 300_000 },
    async () => {
      console.log('   ▶ Отправка провокационной задачи агенту...');

      // Мы просим прочитать файл, которого еще нет, и записать в него текст.
      // Логичный агент сначала попытается его прочитать (получит ошибку ENOENT), 
      // после чего сработает самокоррекция, и он переключится на запись/создание файла.
      const res = await fetch(`${SERVER_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: `Прочитай файл "${targetFile}". Если его нет, создай его с текстом "Самокоррекция сработала успешно!" и прочитай снова.`
            }
          ],
          stream: true
        })
      });

      assert.equal(res.status, 200, `Сервер должен вернуть статус 200, получено: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let doneReading = false;
      let fullStreamOutput = '';

      while (!doneReading) {
        const { value, done } = await reader.read();
        if (done) {
          doneReading = true;
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;

          if (trimmed.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmed.slice(6));
              if (data.choices && data.choices[0]?.delta?.content) {
                const text = data.choices[0].delta.content;
                process.stdout.write(text);
                fullStreamOutput += text;
              }
            } catch {}
          }
        }
      }

      console.log('\n');

      // Проверяем, что в логах стрима промелькнуло сообщение о самокоррекции или успешном выполнении
      const hasCorrected = fullStreamOutput.includes('самокоррекцию') || fullStreamOutput.includes('успешно выполнен');
      assert.ok(hasCorrected, 'Агент должен отчитаться о выполнении или коррекции');

      // Проверяем, что файл в итоге РЕАЛЬНО появился на диске благодаря агенту
      const fileExists = await fs.stat(path.resolve(targetFile)).then(() => true).catch(() => false);
      assert.equal(fileExists, true, 'Файл должен быть создан на диске в результате работы агента');

      const content = await fs.readFile(path.resolve(targetFile), 'utf8');
      assert.ok(content.length > 0, 'Созданный файл не должен быть пустым');

      console.log('   ✔ Тест самокоррекции успешно пройден! Файл создан и проверен.');
    }
  );
});