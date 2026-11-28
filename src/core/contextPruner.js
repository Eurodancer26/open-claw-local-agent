// src/core/contextPruner.js
export const DEFAULT_MAX_CONTEXT_MESSAGES = 12;
export const DEFAULT_MAX_CHARS_PER_MESSAGE = 2000;
export const DEFAULT_MAX_HISTORY_MESSAGES = 6;
export const DEFAULT_MAX_HISTORY_CHARS = 6000;

// T6: единый источник лимитов истории диалога.
// Клиент (public/app.js) получает их из /v1/mind и больше не держит
// собственный несогласованный MAX_HISTORY_MESSAGES = 12.
export const MAX_DIALOG_HISTORY_MESSAGES = DEFAULT_MAX_HISTORY_MESSAGES;
export const MAX_DIALOG_HISTORY_CHARS = DEFAULT_MAX_HISTORY_CHARS;

const MIN_MAX_MESSAGES = 1;
const MIN_CHARS_PER_MESSAGE = 100;
const MIN_HISTORY_CHARS = 500;

// Системный префикс + «План принят»
const DUMMY_PREFIX_REGEX = /^\s*\[(?:Песочница|Свободный режим)\]\s*Думаю\.\.\.\s*\n+(?:План принят\s*\(\d+\s+шагов?\)\.\s*Выполняем\.\.\.\s*\n+)?/i;

// Маркеры executor-output: прячем целиком, чтобы модель не думала «уже сделал»
const EXECUTOR_OUTPUT_REGEX = /(?:▶\s*Шаг\s*\d+|✔\s*Успешно|❌\s*Ошибка|✨\s*Готово)/;

function normalizeNewlines(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

function clampMaxMessages(n) {
  const v = Number.isFinite(n) ? Math.floor(n) : DEFAULT_MAX_CONTEXT_MESSAGES;
  return Math.max(MIN_MAX_MESSAGES, v);
}

function clampMaxChars(n) {
  const v = Number.isFinite(n) ? Math.floor(n) : DEFAULT_MAX_CHARS_PER_MESSAGE;
  return Math.max(MIN_CHARS_PER_MESSAGE, v);
}

function clampHistoryMessages(n) {
  const v = Number.isFinite(n) ? Math.floor(n) : DEFAULT_MAX_HISTORY_MESSAGES;
  return Math.max(1, v);
}

function clampHistoryChars(n) {
  const v = Number.isFinite(n) ? Math.floor(n) : DEFAULT_MAX_HISTORY_CHARS;
  return Math.max(MIN_HISTORY_CHARS, v);
}

function truncateSafely(text, maxChars) {
  if (text.length <= maxChars) return text;
  let head = text.slice(0, maxChars);
  const fenceCount = (head.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) {
    head = head.replace(/\n+$/, '') + '\n```';
  }
  return `${head}\n...[обрезано, было ${text.length} символов]`;
}

function stripDummyPrefix(content) {
  return String(content || '').replace(DUMMY_PREFIX_REGEX, '');
}

function looksLikeLeakedJsonPlan(text) {
  const s = String(text || '').trim();
  if (!/"(?:tool|step)"\s*:/.test(s)) return false;
  if (/^[\[{]/.test(s)) return true;
  if (/[\[{][\s\S]*"(?:tool|step)"\s*:[\s\S]*[\]}]/.test(s)) return true;
  return false;
}

function cleanAssistantContent(content) {
  const stripped = stripDummyPrefix(content).trim();
  if (!stripped) return '';

  if (looksLikeLeakedJsonPlan(stripped)) {
    return '[предыдущий ответ содержал JSON-план — скрыт из контекста, чтобы не провоцировать повтор]';
  }

  if (EXECUTOR_OUTPUT_REGEX.test(stripped)) {
    return '[предыдущее выполнение завершено, детали скрыты из контекста]';
  }

  return stripped;
}

export function pruneMessages(
  messages,
  maxMessages = DEFAULT_MAX_CONTEXT_MESSAGES,
  maxCharsPerMessage = DEFAULT_MAX_CHARS_PER_MESSAGE
) {
  if (!Array.isArray(messages)) return [];

  const limMessages = clampMaxMessages(maxMessages);
  const limChars = clampMaxChars(maxCharsPerMessage);

  const normalized = messages
    .filter((msg) => msg && typeof msg.content === 'string' && msg.content.trim().length > 0)
    .map((msg) => {
      const role =
        msg.role === 'assistant' || msg.role === 'system' ? msg.role : 'user';
      const contentRaw = normalizeNewlines(msg.content).trim();
      const content = truncateSafely(contentRaw, limChars);
      return { role, content };
    });

  return normalized.slice(-limMessages);
}

export function buildRecentHistoryBlock(prunedMessages, opts = {}) {
  if (!Array.isArray(prunedMessages) || prunedMessages.length <= 1) return '';

  const maxHistoryMessages = clampHistoryMessages(opts.maxHistoryMessages);
  const maxTotalChars = clampHistoryChars(opts.maxTotalChars);

  const historySlice = prunedMessages.slice(0, -1).slice(-maxHistoryMessages);
  if (historySlice.length === 0) return '';

  const lines = [];
  let totalChars = 0;
  let prevSignature = '';

  for (const m of historySlice) {
    const roleLabel =
      m.role === 'assistant' ? 'Ассистент' :
      m.role === 'system' ? 'Система' :
      'Пользователь';

    let content = m.content;
    if (m.role === 'assistant') {
      content = cleanAssistantContent(content);
    }
    if (!content) continue;

    const signature = `${roleLabel}:${content}`;
    if (signature === prevSignature) continue;
    prevSignature = signature;

    const line = `${roleLabel}: ${content}`;
    if (totalChars + line.length + 1 > maxTotalChars) {
      lines.push('...[часть предыдущих сообщений опущена для экономии контекста]');
      break;
    }
    lines.push(line);
    totalChars += line.length + 1;
  }

  if (lines.length === 0) return '';

  return `\nКРАТКИЙ КОНТЕКСТ ПОСЛЕДНИХ СООБЩЕНИЙ ДИАЛОГА:\n${lines.join('\n')}\n`;
}