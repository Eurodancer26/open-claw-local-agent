import http from 'http';

async function runSelfCorrectionTest() {
  console.log('🔄 Запуск теста цикла самопроверки (Self-Correction)...\n');

  // Промт заставляет агента выполнить команду с ошибкой, чтобы проверить реакцию
  const userPrompt = 'Создай файл "tests/sandbox/buggy.js" с заведомо синтаксически неверным кодом (например, пропущена скобка), запусти его через runCommand, а затем исправь ошибку.';

  const postData = JSON.stringify({
    messages: [{ role: 'user', content: userPrompt }],
    stream: true
  });

  const req = http.request({
    hostname: 'localhost',
    port: 3000,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, (res) => {
    console.log(`📡 Статус ответа сервера: ${res.statusCode}\n`);
    console.log('--- Начало потока выполнения с самопроверкой ---\n');
    
    res.on('data', (chunk) => {
      process.stdout.write(chunk);
    });

    res.on('end', () => {
      console.log('\n\n--- Конец потока выполнения ---');
      console.log('✨ Тест самопроверки завершен!');
    });
  });

  req.on('error', (e) => {
    console.error(`❌ Ошибка запроса (убедись, что сервер запущен): ${e.message}`);
  });

  req.write(postData);
  req.end();
}

runSelfCorrectionTest();