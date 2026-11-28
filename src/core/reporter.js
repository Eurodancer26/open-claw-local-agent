// src/core/reporter.js
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';

const REPORTS_ROOT = path.resolve(process.cwd(), 'reports');
const TEST_REPORTS_DIR = path.join(REPORTS_ROOT, 'tests');
const CHAT_REPORTS_DIR = path.join(REPORTS_ROOT, 'chats');
const SANDBOX_DIR = path.resolve(process.cwd(), 'tests', 'sandbox');

const SESSION_ID = new Date().toISOString().replace(/[:.]/g, '-');

// Ограничения размеров — чтобы отчёт не разрастался до мегабайтов
const MAX_CDATA_CHARS = 30000;
const MAX_MODEL_RAW_CHARS = 20000;
const MAX_FINAL_RESPONSE_CHARS = 10000;
const MAX_EVENTS_SNIPPET = 4000;
const MAX_ROUTING_JSON = 8000;
const MAX_RECORDS_PER_SESSION = 500;

const sessionRecords = {
  test: [],
  chat: []
};

const TEXT_EXTS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.jsx',
  '.tsx',
  '.json',
  '.md',
  '.txt',
  '.html',
  '.css',
  '.scss',
  '.yml',
  '.yaml',
  '.xml',
  '.env',
  '.sh',
  '.sql',
  '.log',
  '.csv'
]);

function ensureDirs() {
  fs.mkdirSync(TEST_REPORTS_DIR, { recursive: true });
  fs.mkdirSync(CHAT_REPORTS_DIR, { recursive: true });
}

// XML 1.0 допускает: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
function isXmlValidCodePoint(cp) {
  return (
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0d ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

// Убираем невалидные для XML 1.0 символы и нормализуем \r\n -> \n.
// Итерируемся по code points, чтобы корректно пропускать эмодзи и суррогатные пары.
function stripControlChars(value) {
  const str = String(value ?? '');
  let result = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (!isXmlValidCodePoint(cp)) continue;
    if (cp === 0x0d) {
      result += '\n';
    } else {
      result += ch;
    }
  }
  return result.replace(/\r\n/g, '\n');
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

// ВАЖНО: внутри CDATA XML-сущности НЕ декодируются.
// Поэтому `]]>` заменяем на `]]]]><![CDATA[>` — БЕЗ `&gt;`.
function escapeCdata(value) {
  return stripControlChars(value).split(']]>').join(']]]]><![CDATA[>');
}

// Обрезка перед выгрузкой в CDATA, чтобы не разрастался файл.
function clipForCdata(value, maxChars = MAX_CDATA_CHARS) {
  const str = String(value ?? '');
  if (str.length <= maxChars) return str;
  return `${str.slice(0, maxChars)}\n...[обрезано для отчёта, было ${str.length} символов]`;
}

// Атомарная запись: temp-файл + rename.
// Защищает от полу-записанных XML при падении процесса.
async function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fsPromises.writeFile(tmp, content, 'utf8');
    await fsPromises.rename(tmp, filePath);
  } catch (err) {
    await fsPromises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Собирает полный снимок содержимого папки tests/sandbox/
 */
export async function captureSandboxSnapshot(maxFileChars = 20000, maxFiles = 200) {
  const items = [];

  async function walk(currentDir) {
    if (items.length >= maxFiles) return;
    let entries;
    try {
      entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (items.length >= maxFiles) break;
      if (entry.name === '.gitkeep' || entry.name === 'node_modules') continue;

      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(process.cwd(), fullPath).replaceAll('\\', '/');

      if (entry.isDirectory()) {
        items.push({
          type: 'dir',
          path: relPath,
          sizeBytes: 0,
          content: ''
        });
        await walk(fullPath);
      } else if (entry.isFile()) {
        let sizeBytes = 0;
        let content;
        try {
          const stat = await fsPromises.stat(fullPath);
          sizeBytes = stat.size;
          const ext = path.extname(entry.name).toLowerCase();
          if (TEXT_EXTS.has(ext) || sizeBytes <= 64 * 1024) {
            const raw = await fsPromises.readFile(fullPath, 'utf8');
            content =
              raw.length > maxFileChars
                ? `${raw.slice(0, maxFileChars)}\n... [обрезано, всего ${raw.length} символов]`
                : raw;
          } else {
            content = `[бинарный или крупный файл: ${sizeBytes} Б]`;
          }
        } catch (err) {
          content = `[ошибка чтения: ${err.message}]`;
        }

        items.push({
          type: 'file',
          path: relPath,
          sizeBytes,
          content
        });
      }
    }
  }

  await walk(SANDBOX_DIR);
  return items;
}

function renderSandboxSnapshotXml(snapshot = []) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) {
    return '      <!-- Песочница tests/sandbox/ пуста -->';
  }

  return snapshot
    .map((entry) => {
      if (entry.type === 'dir') {
        return `      <entry type="dir" path="${escapeXml(entry.path)}" />`;
      }
      return [
        `      <entry type="file" path="${escapeXml(entry.path)}" sizeBytes="${escapeXml(entry.sizeBytes)}">`,
        `        <content><![CDATA[${escapeCdata(entry.content || '')}]]></content>`,
        '      </entry>'
      ].join('\n');
    })
    .join('\n');
}

function modeLabelToValue(modeLabel) {
  if (!modeLabel) return 'unknown';
  if (/Песочниц/i.test(modeLabel)) return 'strict';
  if (/Свободн/i.test(modeLabel)) return 'free';
  return 'unknown';
}

function renderRoutingBlock(routingInfo) {
  if (!routingInfo) return '';

  const rawJson =
    typeof routingInfo === 'string' ? routingInfo : JSON.stringify(routingInfo, null, 2);

  const clipped = clipForCdata(rawJson, MAX_ROUTING_JSON);

  let modeAttr = '';
  if (routingInfo && typeof routingInfo === 'object' && typeof routingInfo.mode === 'string') {
    modeAttr = ` mode="${escapeXml(routingInfo.mode)}"`;
  }

  return `\n    <routing${modeAttr}><![CDATA[${escapeCdata(clipped)}]]></routing>`;
}

function buildSessionXml(sessionType, records) {
  const reportTitle =
    sessionType === 'test'
      ? 'Конструкт АИ — Сводный XML-отчёт (ТЕСТЫ И ОПЕРАЦИИ)'
      : 'Конструкт АИ — Сводный XML-отчёт (ЧАТ И ОПЕРАЦИИ)';

  const entriesXml = records
    .map((rec, idx) => {
      const actionsXml = (rec.actions || [])
        .map((act) => {
          const argsSnippet = act.arguments
            ? `\n        <arguments><![CDATA[${escapeCdata(
                clipForCdata(
                  typeof act.arguments === 'string'
                    ? act.arguments
                    : JSON.stringify(act.arguments, null, 2),
                  MAX_ROUTING_JSON
                )
              )}]]></arguments>`
            : '';
          return [
            '      <action>',
            `        <step>${escapeXml(act.step)}</step>`,
            `        <tool>${escapeXml(act.tool || 'unknown')}</tool>`,
            `        <targetPath>${escapeXml(act.targetPath || 'не указан')}</targetPath>`,
            `        <status>${escapeXml(act.status)}</status>`,
            `        <details>${escapeXml(act.details || '')}</details>${argsSnippet}`,
            '      </action>'
          ].join('\n');
        })
        .join('\n');

      const eventsXml = (rec.events || [])
        .map((ev) => {
          const snippetBlock = ev.codeSnippet
            ? `\n        <codeSnippet><![CDATA[${escapeCdata(
                clipForCdata(ev.codeSnippet, MAX_EVENTS_SNIPPET)
              )}]]></codeSnippet>`
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

      const routingBlock = renderRoutingBlock(rec.routingInfo);

      const promptBlock = rec.promptSent
        ? `\n    <promptSent><![CDATA[${escapeCdata(
            clipForCdata(rec.promptSent, MAX_CDATA_CHARS)
          )}]]></promptSent>`
        : '';

      const sandboxBlock = `\n    <sandboxSnapshot>\n${renderSandboxSnapshotXml(rec.sandboxSnapshot)}\n    </sandboxSnapshot>`;

      const modeValue = modeLabelToValue(rec.mode);

      return [
        `  <record index="${idx + 1}">`,
        `    <time>${escapeXml(rec.time)}</time>`,
        `    <mode value="${modeValue}">${escapeXml(rec.mode)}</mode>`,
        `    <userQuery>${escapeXml(rec.userQuery || '(пусто)')}</userQuery>${routingBlock}${promptBlock}`,
        `    <modelRawPlan><![CDATA[${escapeCdata(
          clipForCdata(rec.modelRawPlan || '', MAX_MODEL_RAW_CHARS)
        )}]]></modelRawPlan>`,
        `    <actions>\n${actionsXml || '      <!-- Нет выполненных действий -->'}\n    </actions>`,
        `    <finalChatResponse><![CDATA[${escapeCdata(
          clipForCdata(rec.finalChatResponse || '(нет текстового ответа)', MAX_FINAL_RESPONSE_CHARS)
        )}]]></finalChatResponse>${sandboxBlock}`,
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
      routingInfo: null,
      promptSent: '',
      modelRawPlan: '',
      actions: [],
      finalChatResponse: '',
      sandboxSnapshot: [],
      events: []
    };
  }

  setContext(mode, userQuery) {
    this.record.mode = mode === 'strict' ? 'Песочница (tests/sandbox/)' : 'Свободный режим';
    this.record.userQuery = userQuery;
  }

  setRoutingInfo(routingInfo) {
    this.record.routingInfo = routingInfo;
  }

  setPromptSent(promptText) {
    this.record.promptSent = String(promptText ?? '');
  }

  setModelPlan(rawPlan) {
    this.record.modelRawPlan = String(rawPlan ?? '');
  }

  addAction(step, tool, targetPath, status, details, args = null) {
    this.record.actions.push({
      step,
      tool,
      targetPath,
      status,
      details,
      arguments: args
    });
  }

  setFinalResponse(responseText) {
    this.record.finalChatResponse = String(responseText ?? '');
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
    this.record.sandboxSnapshot = await captureSandboxSnapshot();

    const bucket = this.sessionType === 'test' ? sessionRecords.test : sessionRecords.chat;
    if (!bucket.includes(this.record)) {
      bucket.push(this.record);
      // Ограничение роста в долгой сессии: держим только последние N записей
      if (bucket.length > MAX_RECORDS_PER_SESSION) {
        bucket.splice(0, bucket.length - MAX_RECORDS_PER_SESSION);
      }
    }

    const targetDir = this.sessionType === 'test' ? TEST_REPORTS_DIR : CHAT_REPORTS_DIR;
    const fileName = `${this.sessionType}_report_${SESSION_ID}.xml`;
    const filePath = path.join(targetDir, fileName);

    const xmlContent = buildSessionXml(this.sessionType, bucket);
    await atomicWrite(filePath, xmlContent);
    return filePath;
  }

  async commitAndSavePdf() {
    return this.commitAndSaveXml();
  }
}

/**
 * Утилита для записи каждой операции из обычных тестов в единый XML-репорт тестов
 */
export async function recordTestOperation({
  suiteName = 'test-suite',
  operationName = 'operation',
  mode = 'strict',
  userQuery = '',
  actions = [],
  events = [],
  finalResponse = ''
}) {
  const tracer = new ExecutionTracer('test');
  tracer.setContext(mode, userQuery || `${suiteName}: ${operationName}`);
  tracer.log('test-runner', suiteName, 'INFO', `Операция теста: ${operationName}`);

  for (const ev of events) {
    tracer.log(
      ev.module || 'test',
      ev.location || operationName,
      ev.status || 'INFO',
      ev.details || '',
      ev.codeSnippet || ''
    );
  }

  for (const act of actions) {
    tracer.addAction(
      act.step ?? 1,
      act.tool || 'testOp',
      act.targetPath || 'не указан',
      act.status || 'OK',
      act.details || '',
      act.arguments || null
    );
  }

  tracer.setFinalResponse(finalResponse || `${operationName}: завершено`);
  return tracer.commitAndSaveXml();
}
