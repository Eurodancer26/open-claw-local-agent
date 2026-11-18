import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

const REPORTS_ROOT = path.resolve(process.cwd(), 'reports');
const TEST_REPORTS_DIR = path.join(REPORTS_ROOT, 'tests');
const CHAT_REPORTS_DIR = path.join(REPORTS_ROOT, 'chats');

const FONT_PATH = 'C:\\Windows\\Fonts\\arial.ttf';
const MONO_FONT_PATH = 'C:\\Windows\\Fonts\\consola.ttf';

// Единый идентификатор запуска сервера, чтобы все запросы сессии писались в ОДИН PDF
const SESSION_ID = new Date().toISOString().replace(/[:.]/g, '-');
const sessionRecords = {
  test: [],
  chat: []
};

function ensureDirs() {
  fs.mkdirSync(TEST_REPORTS_DIR, { recursive: true });
  fs.mkdirSync(CHAT_REPORTS_DIR, { recursive: true });
}

export class ExecutionTracer {
  constructor(sessionType = 'chat') {
    this.sessionType = sessionType; // 'test' | 'chat'
    this.record = {
      time: new Date().toLocaleTimeString('ru-RU'),
      mode: 'strict',
      userQuery: '',
      modelRawPlan: '',
      actions: [], // { step, tool, targetPath, status, details }
      finalChatResponse: '',
      events: []
    };
  }

  setContext(mode, userQuery) {
    this.record.mode = mode === 'strict' ? 'Песочница (tests/sandbox/)' : 'Свободный режим';
    this.record.userQuery = userQuery;
  }

  setModelPlan(rawPlan) {
    this.record.modelRawPlan = rawPlan;
  }

  addAction(step, tool, targetPath, status, details) {
    this.record.actions.push({ step, tool, targetPath, status, details });
  }

  setFinalResponse(responseText) {
    this.record.finalChatResponse = responseText;
  }

  log(moduleName, location, status, details, codeSnippet = '') {
    this.record.events.push({
      timestamp: new Date().toISOString().split('T')[1].replace('Z', ''),
      module: moduleName,
      location,
      status,
      details,
      codeSnippet
    });
  }

  async commitAndSavePdf() {
    ensureDirs();
    const bucket = this.sessionType === 'test' ? sessionRecords.test : sessionRecords.chat;
    bucket.push(this.record);

    const targetDir = this.sessionType === 'test' ? TEST_REPORTS_DIR : CHAT_REPORTS_DIR;
    const fileName = `${this.sessionType}_report_${SESSION_ID}.pdf`;
    const filePath = path.join(targetDir, fileName);

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const stream = fs.createWriteStream(filePath);

      doc.pipe(stream);
      if (fs.existsSync(FONT_PATH)) doc.font(FONT_PATH);

      // Шапка общего отчёта
      doc.fontSize(16).fillColor('#111827')
         .text(`Конструкт АИ — Сводный отчёт (${this.sessionType === 'test' ? 'ТЕСТЫ' : 'ЧАТ'})`);
      doc.fontSize(9).fillColor('#6B7280')
         .text(`Сессия запуска: ${SESSION_ID} | Всего запросов в отчёте: ${bucket.length}`);
      doc.moveDown(1);

      bucket.forEach((rec, idx) => {
        // Разделитель между запросами
        doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#D1D5DB').stroke();
        doc.moveDown(0.5);

        doc.fontSize(12).fillColor('#1D4ED8')
           .text(`#${idx + 1} [${rec.time}] Режим: ${rec.mode}`);
        doc.moveDown(0.3);

        // 1. Запрос пользователя
        doc.fontSize(10).fillColor('#111827').text(`Запрос пользователя: `, { continued: true })
           .fillColor('#374151').text(rec.userQuery || '(пусто)');
        doc.moveDown(0.3);

        // 2. Действия с инструментами (что сделал и куда)
        if (rec.actions.length > 0) {
          doc.fontSize(10).fillColor('#111827').text('Выполненные действия:');
          for (const act of rec.actions) {
            const color = act.status === 'OK' ? '#059669' : '#DC2626';
            doc.fontSize(9.5).fillColor(color)
               .text(`  • Шаг ${act.step} [${act.tool}] -> Путь: ${act.targetPath || 'не указан'} | Статус: ${act.status} (${act.details})`);
          }
          doc.moveDown(0.3);
        }

        // 3. Финальный ответ в чат
        doc.fontSize(10).fillColor('#111827').text('Ответ агента в чат:');
        doc.fontSize(9.5).fillColor('#1F2937')
           .text(rec.finalChatResponse || '(нет текстового ответа)', { indent: 10 });
        doc.moveDown(0.4);

        // 4. Техническая трассировка модулей
        doc.fontSize(9).fillColor('#4B5563').text('Трассировка модулей:');
        for (const ev of rec.events) {
          const stColor = ev.status === 'ERROR' ? '#DC2626' : ev.status === 'RETRY' ? '#D97706' : '#059669';
          if (fs.existsSync(MONO_FONT_PATH)) doc.font(MONO_FONT_PATH);
          doc.fontSize(8).fillColor(stColor)
             .text(`  [${ev.timestamp}] [${ev.status}] ${ev.module} -> ${ev.location}: ${ev.details}`);
          if (ev.codeSnippet) {
            doc.fillColor('#6B7280').text(`      ${ev.codeSnippet.replace(/\n/g, ' ')}`);
          }
        }
        if (fs.existsSync(FONT_PATH)) doc.font(FONT_PATH);
        doc.moveDown(0.8);
      });

      doc.end();
      stream.on('finish', () => resolve(filePath));
      stream.on('error', reject);
    });
  }
}