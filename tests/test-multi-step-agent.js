import http from 'http';

async function runMultiStepTest() {
  console.log('🤖 Запуск многошагового теста агента с инструментами...\n');

  const userPrompt = 'Создай файл "tests/sandbox/calc.js" с функцией умножения двух чисел, затем создай файл "tests/sandbox/calc.test.js" для ее проверки, и запусти тесты через node.';

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
    console.log('--- Начало потока выполнения агента ---\n');
    
    res.on('data', (chunk) => {
      process.stdout.write(chunk);
    });

    res.on('end', () => {
      console.log('\n\n--- Конец потока выполнения ---');
      console.log('✨ Многошаговый тест завершен!');
    });
  });

  req.on('error', (e) => {
    console.error(`❌ Ошибка запроса (убедись, что сервер запущен): ${e.message}`);
  });

  req.write(postData);
  req.end();
}

runMultiStepTest();