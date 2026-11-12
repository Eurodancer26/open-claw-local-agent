import fs from 'fs';
import path from 'path';

const reportsDir = path.join(process.cwd(), 'reports');

function compareReports() {
  console.log(`🔍 Сканирование папки отчетов: ${reportsDir}\n`);

  if (!fs.existsSync(reportsDir)) {
    console.log('❌ Папка reports/ не найдена. Сначала запусти хотя бы один бенчмарк!');
    return;
  }

  const files = fs.readdirSync(reportsDir).filter(f => f.endsWith('.json'));

  if (files.length === 0) {
    console.log('⚠️ В папке reports/ не найдено JSON-отчетов для сравнения.');
    return;
  }

  // Загружаем и парсим все отчеты
  const reports = files.map(file => {
    const filePath = path.join(reportsDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    return { filename: file, data: JSON.parse(content) };
  });

  // Сортируем отчеты по времени создания (от старых к новым)
  reports.sort((a, b) => new Date(a.data.timestamp) - new Date(b.data.timestamp));

  console.log(`==================================================`);
  console.log(`📈 СВОДНЫЙ АНАЛИЗ ИСТОРИИ БЕНЧМАРКОВ (${reports.length} отчетов)`);
  console.log(`==================================================`);

  reports.forEach((rep, idx) => {
    const d = rep.data;
    console.log(`\n[${idx + 1}] Файл отчета: ${rep.filename}`);
    console.log(`🕒 Дата: ${new Date(d.timestamp).toLocaleString()}`);
    console.log(`🤖 Модель: ${d.model} | Железо: ${d.hardware}`);
    console.log(`⏱️ Общее время suite: ${d.totalDurationSec} сек.`);
    console.log(`--------------------------------------------------`);

    if (d.results && Array.isArray(d.results)) {
      d.results.forEach(res => {
        const status = res.success ? '✅' : '❌';
        const timeStr = `${res.durationSec}s`;
        const tokStr = res.tokensPerSec !== undefined ? `${res.tokensPerSec} tok/s` : 'N/A';
        console.log(`  ${status} ${res.title.padEnd(32)} -> ${timeStr.padEnd(8)} | ${tokStr}`);
      });
    }
  });

  console.log(`==================================================\n`);
}

compareReports();