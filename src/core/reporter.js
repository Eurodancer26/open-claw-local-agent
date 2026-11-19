import fs from 'fs';
import path from 'path';

const REPORTS_ROOT = path.resolve(process.cwd(), 'reports');
const TEST_REPORTS_DIR = path.join(REPORTS_ROOT, 'tests');
const CHAT_REPORTS_DIR = path.join(REPORTS_ROOT, 'chats');

const SESSION_ID = new Date().toISOString().replace(/[:.]/g, '-');
const sessionRecords = {
  test: [],
  chat: []
};

function ensureDirs() {
  fs.mkdirSync(TEST_REPORTS_DIR, { recursive: true });
  fs.mkdirSync(CHAT_REPORTS_DIR, { recursive: true });
}

function stripControlChars(value) {
  const str = String(value ?? '');
  let result = '';

  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    const isDisallowedControl =
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f);

    if (!isDisallowedControl) {
      result += str.charAt(i);
    }
  }

  return result;
}

function escapeXml(value) {
  const amp = String.fromCharCode(38);
  return stripControlChars(value)
    .replace(/&/g, `${amp}amp;`)
    .replace(/</g, `${amp}lt;`)
    .replace(/>/g, `${amp}gt;`)
    .replace(/"/g, `${amp}quot;`)
    .replace(/'/g, `${amp}apos;`);
}

function escapeCdata(value) {
  const amp = String.fromCharCode(38);
  return stripControlChars(value).split(']]>').join(`]]]]><![CDATA[${amp}gt;`);
}

function buildSessionXml(sessionType, records) {
  const reportTitle = sessionType === 'test'
    ? 'Конструкт АИ — Сводный XML-отчёт (ТЕСТЫ)'
    : 'Конструкт АИ — Сводный XML-отчёт (ЧАТ)';

  const entriesXml = records
    .map((rec, idx) => {
      const actionsXml = rec.actions
        .map((act) => {
          return [
            '      <action>',
            `        <step>${escapeXml(act.step)}</step>`,
            `        <tool>${escapeXml(act.tool || 'unknown')}</tool>`,
            `        <targetPath>${escapeXml(act.targetPath || 'не указан')}</targetPath>`,
            `        <status>${escapeXml(act.status)}</status>`,
            `        <details>${escapeXml(act.details || '')}</details>`,
            '      </action>'
          ].join('\n');
        })
        .join('\n');

      const eventsXml = rec.events
        .map((ev) => {
          const snippetBlock = ev.codeSnippet
            ? `\n        <codeSnippet><![CDATA[${escapeCdata(ev.codeSnippet)}]]></codeSnippet>`
            : '';
          return [
            '      <event>',
            `        <timestamp>${escapeXml(ev.timestamp)}</timestamp>`,
            `        <status>${escapeXml(ev.status)}</status>`,
            `        <module>${escapeXml(ev.module)}</module>`,
            `        <location>${escapeXml(ev.location)}</location>`,
            `        <details>${escapeXml(ev.details || '')}</details>${snippetBlock}`,
            '      </event>'
          ].join('\n');
        })
        .join('\n');

      return [
        `  <record index="${idx + 1}">`,
        `    <time>${escapeXml(rec.time)}</time>`,
        `    <mode>${escapeXml(rec.mode)}</mode>`,
        `    <userQuery>${escapeXml(rec.userQuery || '(пусто)')}</userQuery>`,
        `    <modelRawPlan>${escapeXml(rec.modelRawPlan || '')}</modelRawPlan>`,
        `    <actions>\n${actionsXml || '      <!-- Нет выполненных действий -->'}\n    </actions>`,
        `    <finalChatResponse>${escapeXml(rec.finalChatResponse || '(нет текстового ответа)')}</finalChatResponse>`,
        `    <events>\n${eventsXml || '      <!-- Нет событий трассировки -->'}\n    </events>`,
        '  </record>'
      ].join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<report type="${escapeXml(sessionType)}" sessionId="${escapeXml(SESSION_ID)}" totalRecords="${records.length}">`,
    `  <title>${escapeXml(reportTitle)}</title>`,
    `  <records>\n${entriesXml || '    <!-- Записей пока нет -->'}\n  </records>`,
    '</report>'
  ].join('\n');
}

export class ExecutionTracer {
  constructor(sessionType = 'chat') {
    this.sessionType = sessionType === 'test' ? 'test' : 'chat';
    this.record = {
      time: new Date().toLocaleTimeString('ru-RU'),
      mode: 'strict',
      userQuery: '',
      modelRawPlan: '',
      actions: [],
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
    const isoTimePart = new Date().toISOString().split('T')[1] ?? '';
    this.record.events.push({
      timestamp: isoTimePart.replace('Z', ''),
      module: moduleName,
      location,
      status,
      details,
      codeSnippet
    });
  }

  async commitAndSaveXml() {
    ensureDirs();
    const bucket = this.sessionType === 'test' ? sessionRecords.test : sessionRecords.chat;
    bucket.push(this.record);

    const targetDir = this.sessionType === 'test' ? TEST_REPORTS_DIR : CHAT_REPORTS_DIR;
    const fileName = `${this.sessionType}_report_${SESSION_ID}.xml`;
    const filePath = path.join(targetDir, fileName);

    const xmlContent = buildSessionXml(this.sessionType, bucket);
    await fs.promises.writeFile(filePath, xmlContent, 'utf8');
    return filePath;
  }

  async commitAndSavePdf() {
    return this.commitAndSaveXml();
  }
}