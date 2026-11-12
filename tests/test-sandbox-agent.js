import fs from 'fs';
import path from 'path';
import http from 'http';
import { toolsRegistry } from '../src/tools/registry.js';

const SANDBOX_DIR = path.join(process.cwd(), 'tests', 'sandbox');

async function runSandboxTests() {
  console.log('🛡️ Запуск изолированного полигона для тестов (Sandbox)...\n');

  // 1. Создаем папку-полигон, если её нет
  if (!fs.existsSync(SANDBOX_DIR)) {
    fs.mkdirSync(SANDBOX_DIR, { recursive: true });
    console.log('✅ Создана папка-полигон: tests/sandbox/');
  }

  // 2. Тестируем writeFile в полигоне
  const testFilePath = 'tests/sandbox/hello-agent.js';
  const testFileContent = 'console.log("Hello from Open Claw Sandbox!");';
  
  const writeRes = await toolsRegistry.writeFile.execute({
    filePath: testFilePath,
    content: testFileContent
  });
  console.log('📝 Тест writeFile:', writeRes);

  // 3. Тестируем readFile из полигона
  const readRes = await toolsRegistry.readFile.execute({
    filePath: testFilePath
  });
  console.log('📖 Тест readFile:', readRes);

  // 4. Тестируем runCommand (запуск созданного файла в песочнице)
  const cmdRes = await toolsRegistry.runCommand.execute({
    command: 'node tests/sandbox/hello-agent.js'
  });
  console.log('⚡ Тест runCommand:', cmdRes);

  console.log('\n🌐 Проверяем SSE-стриминг к серверу...');
  
  // 5. Проверка реального стриминг-запроса к нашему серверу
  const postData = JSON.stringify({
    messages: [{ role: 'user', content: 'Создай тестовую функцию и проверь работу полигона' }],
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
    console.log(`📡 Статус ответа сервера: ${res.statusCode}`);
    res.on('data', (chunk) => {
      process.stdout.write(chunk);
    });
    res.on('end', () => {
      console.log('\n\n✨ Все тесты на полигоне успешно завершены!');
    });
  });

  req.on('error', (e) => {
    console.error(`❌ Ошибка запроса к серверу (убедись, что server.js запущен): ${e.message}`);
  });

  req.write(postData);
  req.end();
}

runSandboxTests();