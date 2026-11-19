import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const SERVER_URL = 'http://localhost:3001';
const RUN_LLM_TESTS = process.env.RUN_LLM_TESTS === 'true';
let serverProcess = null;

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Сервер поднимается
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Сервер не ответил на ${url} за ${timeoutMs} мс`);
}

describe('Конструкт АИ — Сквозной тест агентичного цикла (Plan & Execute)', () => {
  const targetFile = 'tests/sandbox/agent-created.txt';

  before(async () => {
    await fs.mkdir(path.resolve('tests/sandbox'), { recursive: true });
    await fs.rm(path.resolve(targetFile), { force: true }).catch(() => {});

    console.log('🚀 Запуск тестового сервера агента на порту 3001...');
    serverProcess = spawn(process.execPath, ['src/server.js'], {
      stdio: 'inherit',
      env: { ...process.env, PORT: '3001' }
    });

    await waitForServer(SERVER_URL);
    console.log('✅ Сервер агента готов к работе.\n');
  });

  after(async () => {
    if (serverProcess) {
      console.log('\n🛑 Остановка тестового сервера...');
      serverProcess.kill();
    }
    await fs.rm(path.resolve(targetFile), { force: true }).catch(() => {});
  });

  it(
    'Агент должен составить план, реально создать файл на диске, прочитать его и вернуть финальный ответ по SSE',
    { skip: !RUN_LLM_TESTS, timeout: 300_000 },
    async () => {
      console.log('   ▶ Отправка задачи агенту...');

      const res = await fetch(`${SERVER_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: `Создай файл "${targetFile}" с текстом "Автономный цикл Plan & Execute успешно выполнен!" и затем прочитай его содержимое.`
            }
          ],
          stream: true
        })
      });

      assert.equal(res.status, 200, `Ожидался статус 200, получен ${res.status}`);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let doneReading = false;
      let receivedDoneMarker = false;
      let fullStreamLog = '';

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
          if (!trimmed) continue;

          if (trimmed === 'data: [DONE]') {
            receivedDoneMarker = true;
            doneReading = true;
            break;
          }

          if (trimmed.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmed.slice(6));
              if (data.choices && data.choices[0]?.delta?.content) {
                const textPart = data.choices[0].delta.content;
                process.stdout.write(textPart);
                fullStreamLog += textPart;
              }
            } catch {
              // Пропускаем неполные чанки при склейке
            }
          }
        }
      }

      console.log('\n');

      // 1. Проверяем корректность завершения SSE-потока
      assert.equal(receivedDoneMarker, true, 'SSE-поток должен завершиться маркером [DONE]');
      assert.ok(fullStreamLog.includes('План принят'), 'Агент должен сообщить о принятии плана');

      // 2. Проверяем, что файл РЕАЛЬНО создан на диске в песочнице
      const fileContentOnDisk = await fs.readFile(path.resolve(targetFile), 'utf8');
      assert.equal(
        fileContentOnDisk,
        'Автономный цикл Plan & Execute успешно выполнен!',
        'Содержимое реального файла на диске должно точно совпадать с заданием'
      );

      console.log('   ✔ Файл на диске проверен: содержимое совпадает на 100%!');
    }
  );
});