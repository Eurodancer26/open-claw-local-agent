// src/api/chatFormatter.js
export const MAX_CHAT_CODE_CHARS = 4000;

const FORBIDDEN_TOOL_NAMES = [
  'chat', 'strictMode', 'date', 'time', 'getDate', 'getTime',
  'format', 'formatCode', 'prettier', 'lint', 'deploy', 'hash',
  'generateCode', 'bundle', 'rollup', 'webpack', 'publish',
  'fetch', 'http', 'curl', 'browser', 'search', 'webSearch'
];

function parseStepResultData(rawResult) {
  if (!rawResult) return null;
  if (typeof rawResult === 'object') return rawResult;
  if (typeof rawResult === 'string') {
    try {
      return JSON.parse(rawResult);
    } catch {
      return { message: rawResult };
    }
  }
  return { message: String(rawResult) };
}

export function formatStepResultForChat(toolName, rawResult) {
  if (rawResult === undefined || rawResult === null) {
    return '✔ Успешно.\n';
  }

  const data = parseStepResultData(rawResult);

  if (toolName === 'readFile') {
    const text = typeof rawResult === 'string'
      ? (data && typeof data.content === 'string' ? data.content : rawResult)
      : (typeof data?.content === 'string' ? data.content : JSON.stringify(data, null, 2));

    const clipped = text.length > MAX_CHAT_CODE_CHARS
      ? `${text.slice(0, MAX_CHAT_CODE_CHARS)}\n... [обрезано, всего ${text.length} символов]`
      : text;

    return `✔ Успешно. Содержимое файла:\n\`\`\`\n${clipped}\n\`\`\`\n`;
  }

  if (toolName === 'writeFile') {
    const filePath = data?.filePath || data?.path || data?.target;
    const bytes = Number.isFinite(data?.bytesWritten) ? ` (${data.bytesWritten} Б)` : '';
    if (filePath) {
      return `✔ Успешно. Файл записан: ${filePath}${bytes}\n`;
    }
    return '✔ Успешно. Файл записан.\n';
  }

  if (toolName === 'deleteFile') {
    const filePath = data?.filePath || data?.path || data?.target;
    return filePath
      ? `✔ Успешно. Файл удалён: ${filePath}\n`
      : '✔ Успешно. Файл удалён.\n';
  }

  if (toolName === 'generateUnitTest') {
    const outputPath = data?.outputPath || data?.path || data?.testPath;
    const sourcePath = data?.sourcePath || data?.source;
    if (outputPath) {
      return `✔ Успешно. Тест создан: ${outputPath}${sourcePath ? ` (по ${sourcePath})` : ''}\n`;
    }
    return '✔ Успешно. Unit-тест сгенерирован.\n';
  }

  if (toolName === 'runCommand') {
    const stdout = typeof data?.stdout === 'string' ? data.stdout.trim() : '';
    const exitCode = data?.exitCode ?? data?.code ?? 0;
    const header = `✔ Успешно (exit=${exitCode}).`;
    if (stdout) {
      return `${header}\n\`\`\`\n${stdout}\n\`\`\`\n`;
    }
    return `${header}\n`;
  }

  if (toolName === 'analyzeProject') {
    const reportObj = data?.report || (data && typeof data.totalFiles === 'number' ? data : null);

    if (reportObj) {
      const extList = Object.entries(reportObj.byExtension || {})
        .map(([ext, count]) => `${ext}: ${count}`)
        .join(', ') || 'нет';
      const largestList = Array.isArray(reportObj.largestFiles) && reportObj.largestFiles.length > 0
        ? reportObj.largestFiles.map((f) => `${f.path} (${f.lines} строк, ${f.sizeBytes} Б)`).join('; ')
        : 'нет';

      const lines = [
        '✔ Успешно. Краткая статистика:',
        `- Директория: \`${reportObj.target}\``,
        `- Папок: ${reportObj.totalDirs}, файлов: ${reportObj.totalFiles}, строк кода: ${reportObj.totalLines}`,
        `- По расширениям: ${extList}`,
        `- Крупные файлы: ${largestList}`
      ];

      if (reportObj.packageInfo) {
        lines.push(`- Пакет: ${reportObj.packageInfo.name}@${reportObj.packageInfo.version} (${reportObj.packageInfo.type})`);
      }

      return `${lines.join('\n')}\n`;
    }

    const summaryText = typeof rawResult === 'string' ? rawResult.trim() : JSON.stringify(data, null, 2);
    return `✔ Успешно. Результат анализа:\n${summaryText}\n`;
  }

  if (toolName === 'listDir' && data && Array.isArray(data.items)) {
    const listText = data.items.length > 0
      ? data.items.map((item) => `${item.type === 'dir' ? '[dir]' : '[file]'} ${item.name}`).join(', ')
      : 'пусто';
    return `✔ Успешно. Элементы: ${listText}\n`;
  }

  if (data && typeof data.message === 'string' && data.message.trim().length > 0) {
    const extraSymbols = Array.isArray(data.detectedSymbols) && data.detectedSymbols.length > 0
      ? ` (символы: ${data.detectedSymbols.join(', ')})`
      : '';
    return `✔ Успешно. ${data.message}${extraSymbols}\n`;
  }

  if (typeof rawResult === 'string' && rawResult.trim().length > 0) {
    return `✔ Успешно. ${rawResult.trim()}\n`;
  }

  if (data && typeof data.stdout === 'string' && data.stdout.trim().length > 0) {
    return `✔ Успешно.\n\`\`\`\n${data.stdout.trim()}\n\`\`\`\n`;
  }

  return '✔ Успешно.\n';
}

export function formatRoutingHint(routingDecision) {
  if (!routingDecision || typeof routingDecision !== 'object') {
    return 'Направление не определено, опирайся на текст запроса.';
  }

  const skill = routingDecision.selectedSkill || 'chat';
  const confidencePct = typeof routingDecision.confidence === 'number'
    ? (routingDecision.confidence * 100).toFixed(0)
    : '0';

  const topSummary = Array.isArray(routingDecision.topSkills) && routingDecision.topSkills.length > 0
    ? routingDecision.topSkills
        .map((item) => `${item.skill}: ${(Number(item.score || 0) * 100).toFixed(0)}%`)
        .join(', ')
    : null;

  const mode = routingDecision.mode;

  let directHint = '';
  if (mode === 'chat') {
    directHint = ' → РЕЖИМ: беседа. Отвечай ТОЛЬКО текстом, без JSON.';
  } else if (mode === 'action') {
    directHint = ' → РЕЖИМ: действие. Отвечай ТОЛЬКО JSON-массивом.';
  } else if (mode === 'mixed') {
    directHint = ' → РЕЖИМ: составной. Выбери: либо текст, либо JSON. Не смешивай.';
  }

  if (routingDecision.isBroadOrMixed) {
    return topSummary
      ? `Широкий/составной (лидер: ${skill} — ${confidencePct}%; ${topSummary}).${directHint}`
      : `Широкий/составной (лидер: ${skill} — ${confidencePct}%).${directHint}`;
  }

  return topSummary
    ? `Скил: ${skill} (${confidencePct}%; ${topSummary}).${directHint}`
    : `Скил: ${skill} (${confidencePct}%).${directHint}`;
}

const FORBIDDEN_TOOLS_LIST = FORBIDDEN_TOOL_NAMES.map((n) => `«${n}»`).join(', ');

// Сокращённый набор правил. Специально убраны ВСЕ конкретные имена файлов,
// чтобы модель не могла их скопировать (few-shot contamination).
const COGNITIVE_RULES = `ПРАВИЛА (СТРОГО):
1. Беседа / вопросы / приветствия → ответ ТОЛЬКО текстом на русском. Задачи с файлами → ответ ТОЛЬКО JSON-массивом. Не смешивай.
2. Формат плана: [{"step":1,"tool":"writeFile","arguments":{"filePath":"...","content":"..."},"description":"..."}]. БЕЗ markdown, БЕЗ \`\`\`json, БЕЗ текста до и после JSON.
3. Только 7 инструментов: readFile, writeFile, deleteFile, listDir, analyzeProject, generateUnitTest, runCommand. Инструментов ${FORBIDDEN_TOOLS_LIST} и любых других НЕ СУЩЕСТВУЕТ.
4. Если инструмента нет (дата, погода, курс) → ответ ТОЛЬКО текстом: «У меня нет такого инструмента».
5. Относительные пути автоматически привязываются к tests/sandbox/. Префикс "tests/sandbox/" в planе писать НЕ нужно.
6. Запрос вне tests/sandbox/ («в корне», «../», абсолютный) → откажись текстом и предложи путь внутри песочницы.
7. Подстановка результата шага N: строка "{{stepN.output}}". Никакого JS-кода и конкатенации.
8. ГЛАВНОЕ: имя файла и содержимое бери ДОСЛОВНО из ТЕКУЩЕГО запроса пользователя. НЕ копируй из примеров, памяти, предыдущих ответов. Если пользователь просит файл X с текстом Y — используй именно X и Y. Не подставляй «типичные» примеры.

ФОРМАТ (значения подставляй из запроса, не копируй буквально):
• «Привет! Кто ты?» → текст: «Привет! Я автономный ИИ-агент Конструкт АИ.»
• «Какая сегодня дата?» → текст: «У меня нет инструмента для получения текущей даты.»
• «Создай файл FILE_A с текстом TEXT_X» → [{"step":1,"tool":"writeFile","arguments":{"filePath":"FILE_A","content":"TEXT_X"},"description":"Создать файл"}]`;

function renderMemoryBlock(mindSummary) {
  const text = String(mindSummary || '').trim();
  if (!text || /^История размышлений пуста\.?$/i.test(text)) {
    return '';
  }
  return `\nПАМЯТЬ (только для понимания контекста, НЕ для копирования значений):\n${text}\n`;
}

export function buildNonStreamPrompt({
  currentMode,
  strictDefault,
  toolsPrompt,
  routingDecision,
  mindSummary,
  recentHistoryBlock,
  userMessage
}) {
  const routingHint = formatRoutingHint(routingDecision);

  return `РЕЖИМ: ${currentMode.toUpperCase()} (${strictDefault ? 'песочница tests/sandbox/' : 'свободный'}).

${toolsPrompt}

${routingHint}
${renderMemoryBlock(mindSummary)}${recentHistoryBlock}
${COGNITIVE_RULES}

ЗАПРОС ПОЛЬЗОВАТЕЛЯ:
${userMessage}

Твой ответ:`;
}

export function buildCognitivePrompt({
  currentMode,
  strictDefault,
  toolsPrompt,
  routingDecision,
  mindSummary,
  recentHistoryBlock,
  userMessage
}) {
  const routingHint = formatRoutingHint(routingDecision);

  return `РЕЖИМ: ${currentMode.toUpperCase()} (${strictDefault ? 'песочница tests/sandbox/' : 'свободный'}).

${toolsPrompt}

${routingHint}
${renderMemoryBlock(mindSummary)}${recentHistoryBlock}
${COGNITIVE_RULES}

ЗАПРОС ПОЛЬЗОВАТЕЛЯ:
${userMessage}

Твой ответ:`;
}