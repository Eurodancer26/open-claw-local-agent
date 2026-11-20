export const MAX_CHAT_CODE_CHARS = 4000;

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

  if (routingDecision.isBroadOrMixed) {
    return topSummary
      ? `Широкий или составной запрос (ведущий вектор: ${skill} — ${confidencePct}%; распределение: ${topSummary}). Опирайся на весь текст промта целиком.`
      : `Широкий или составной запрос (ведущий вектор: ${skill} — ${confidencePct}%). Опирайся на весь текст промта целиком.`;
  }

  return topSummary
    ? `Выбранный скил: ${skill} (${confidencePct}%; распределение: ${topSummary}).`
    : `Выбранный скил: ${skill} (${confidencePct}%).`;
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

  return `ТЕКУЩИЙ РЕЖИМ РАБОТЫ: ${currentMode.toUpperCase()} (${strictDefault ? 'Строго внутри tests/sandbox/' : 'Свободный доступ по всему проекту'}).\n\n${toolsPrompt}\n\nАНАЛИЗ НЕЙРО-МОЗЖЕЧКА: ${routingHint}\n\n${mindSummary}${recentHistoryBlock}\nЗапрос: ${userMessage}`;
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

  return `ТЕКУЩИЙ АКТИВНЫЙ РЕЖИМ СИСТЕМЫ: ${currentMode.toUpperCase()}
${strictDefault ? '-> ВНИМАНИЕ: Включен строгий режим песочницы (tests/sandbox/).' : '-> ВНИМАНИЕ: Включен СВОБОДНЫЙ режим работы по всему проекту.'}
${toolsPrompt}
АНАЛИЗ НЕЙРО-МОЗЖЕЧКА: ${routingHint}
ОПЫТ ПРОШЛЫХ ОШИБОК:
${mindSummary}${recentHistoryBlock}
Запрос пользователя: ${userMessage}
ПРАВИЛА ОТВЕТА:
1. Если это обычный вопрос, отказ из-за ограничений песочницы или уточнение папки в свободном режиме отвечай ТОЛЬКО чистым текстом на русском языке без JSON.
2. Если в свободном режиме пользователь не указал путь (например, "создай файл data.txt"), ты ОБЯЗАН задать вопрос текстом: "В какой именно папке создать файл?" и НЕ вызывать инструменты.
3. Если требуется выполнить действие инструментом и все условия режима соблюдены, верни СТРОГО валидный JSON-план с обязательным объектом "arguments":
[
  { "step": 1, "tool": "writeFile", "arguments": { "filePath": "путь/к/файлу", "content": "содержимое" }, "description": "Создание файла" }
]
4. В поле "description" пиши ТОЛЬКО простой текст без кавычек и фигурных скобок!
Твой ответ:`;
}