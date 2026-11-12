import performance from 'perf_hooks';
import fs from 'fs';
import path from 'path';

const API_URL = 'http://localhost:3000/v1/chat/completions';
const MODEL_NAME = 'Qwen 2.5-7B Instruct';

const TEST_SUITE = [
  {
    category: '🧮 1. АЛГОРИТМЫ И СТРУКТУРЫ ДАННЫХ',
    title: 'Кастомный LRU Cache',
    prompt: 'Напиши реализацию класса LRUCache на JavaScript без сторонних библиотек. Укажи методы get и put, добавь пример использования.'
  },
  {
    category: '🐞 2. РЕФАКТОРИНГ И ДЕБАГГИНГ',
    title: 'Поиск утечки памяти и асинхронных багов',
    prompt: 'Найди ошибки в коде и перепиши правильно: `function loadData() { let data = fs.readFileSync("big.json"); setInterval(() => { console.log(data); }, 1000); }`'
  },
  {
    category: '🏗️ 3. АРХИТЕКТУРНОЕ ПРОЕКТИРОВАНИЕ',
    title: 'Система ротации логов',
    prompt: 'Спроектируй структуру модуля логирования на Node.js с поддержкой ротации файлов по размеру (макс 10MB) и 3 уровнями логов (info, warn, error).'
  },
  {
    category: '⚡ 4. КОМПЛЕКСНАЯ ЛОГИКА И СИНТАКСИС',
    title: 'Асинхронный пул задач (Task Queue)',
    prompt: 'Напиши функцию asyncPool(concurrency, tasks), которая выполняет массив асинхронных функций с ограничением по параллельности.'
  }
];

async function runBenchmarkTask(test, index, total) {
  console.log(`\n==================================================`);
  console.log(`🚀 [${index + 1}/${total}] Категория: ${test.category}`);
  console.log(`📌 Задача: "${test.title}"`);
  console.log(`--------------------------------------------------`);

  const startTime = performance.performance.now();
  const startHeap = process.memoryUsage().heapUsed;

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: test.prompt }]
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP Error! Status: ${response.status}`);
    }

    const data = await response.json();
    const endTime = performance.performance.now();
    const durationMs = Math.round(endTime - startTime);
    const endHeap = process.memoryUsage().heapUsed;
    const heapDiffMB = parseFloat(((endHeap - startHeap) / 1024 / 1024).toFixed(2));

    const content = data.choices[0]?.message?.content || 'ОТВЕТ ПУСТ';
    const stepsCount = (content.match(/\*\*Шаг \d+:\*\*/g) || []).length;

    const usage = data.usage || {};
    const tokensCount = usage.completion_tokens || 0;
    const tokensPerSec = usage.tokens_per_second || (tokensCount > 0 ? parseFloat((tokensCount / (durationMs / 1000)).toFixed(2)) : 0);

    console.log(`✅ Выполнено за: ${durationMs} ms (${(durationMs / 1000).toFixed(2)}s)`);
    console.log(`📊 Шагов в плане: ${stepsCount} | Токенов: ${tokensCount} | Скорость: ${tokensPerSec} tok/s`);
    console.log(`💾 Изменение Heap: ${heapDiffMB > 0 ? '+' : ''}${heapDiffMB} MB`);
    console.log(`--------------------------------------------------`);
    console.log(`📥 Результат вывода:\n`);
    console.log(content);

    return {
      title: test.title,
      category: test.category,
      success: true,
      durationMs,
      durationSec: parseFloat((durationMs / 1000).toFixed(2)),
      stepsCount,
      tokensCount,
      tokensPerSec,
      heapDiffMB,
      responseContent: content
    };
  } catch (error) {
    const endTime = performance.performance.now();
    const durationMs = Math.round(endTime - startTime);
    console.log(`❌ Ошибка выполнения: ${error.message}`);

    return {
      title: test.title,
      category: test.category,
      success: false,
      durationMs,
      durationSec: parseFloat((durationMs / 1000).toFixed(2)),
      error: error.message
    };
  }
}

async function runLargeBenchmark() {
  console.log(`🔥 ЗАПУСК РАСШИРЕННОГО ТЕСТОВОГО ПОЛИГОНА (METRICS & JSON EXPORT)`);
  console.log(`🎯 Модель: ${MODEL_NAME} | Целевая VRAM: Intel Arc A580 (8GB)`);
  console.log(`📅 Время запуска: ${new Date().toLocaleString()}`);

  const overallStart = performance.performance.now();
  const summary = [];

  for (let i = 0; i < TEST_SUITE.length; i++) {
    const result = await runBenchmarkTask(TEST_SUITE[i], i, TEST_SUITE.length);
    summary.push(result);
  }

  const overallEnd = performance.performance.now();
  const totalDurationSec = parseFloat(((overallEnd - overallStart) / 1000).toFixed(2));

  // Вывод итогового консольного отчета
  console.log(`\n==================================================`);
  console.log(`📈 ИТОГОВЫЙ СВОДНЫЙ ОТЧЕТ С МЕТРИКАМИ`);
  console.log(`==================================================`);
  console.log(`⏱️ Общее время прогона suite: ${totalDurationSec} сек.`);
  console.log(`--------------------------------------------------`);

  summary.forEach((item, idx) => {
    const status = item.success ? '✅ OK' : '❌ FAIL';
    const timeStr = `${item.durationSec}s`;
    const tokStr = item.tokensPerSec !== undefined ? `${item.tokensPerSec} tok/s` : 'N/A';
    console.log(`${idx + 1}. [${status}] ${item.title.padEnd(32)} -> ${timeStr} | ${tokStr}`);
  });

  console.log(`==================================================\n`);

  // Формирование структуры JSON-отчета
  const reportData = {
    timestamp: new Date().toISOString(),
    model: MODEL_NAME,
    hardware: 'Intel Arc A580 (8GB VRAM)',
    totalDurationSec,
    results: summary
  };

  // Сохранение в папку reports
  const reportsDir = path.join(process.cwd(), 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const dateFileTag = new Date().toISOString().replace(/[:.]/g, '-');
  const reportFileName = `benchmark-report-${dateFileTag}.json`;
  const reportFilePath = path.join(reportsDir, reportFileName);

  fs.writeFileSync(reportFilePath, JSON.stringify(reportData, null, 2), 'utf-8');
  console.log(`💾 Отчет успешно сохранен на диск: ${reportFilePath}\n`);
}

runLargeBenchmark();