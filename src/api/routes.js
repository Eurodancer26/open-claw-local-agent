import { Router } from 'express';
import { getLlama, LlamaChatSession } from 'node-llama-cpp';
import path from 'path';
import { getToolsSystemPrompt, sandboxConfig } from '../tools/registry.js';
import { executePlan } from '../core/executor.js';
import { initMind, updateMindState, pushRecursiveThought, getMindContextSummary } from '../core/recursiveMind.js';
import { gpuMutex } from '../core/mutex.js';
import { ExecutionTracer } from '../core/reporter.js';
import { NeuralSkillRouter } from '../core/neuralRouter.js'; // 🧠 Наш нейро-мозжечок

const router = Router();

let llamaInstance = null;
let modelInstance = null;
let contextInstance = null;
let persistentSession = null;
let lastActiveMode = null; // Для отслеживания смены режима и сброса кэша сессии
let sessionTurnCount = 0; // Счётчик ходов в текущей LLM-сессии для защиты от переполнения контекста

const MAX_CONTEXT_MESSAGES = 12;
const MAX_CHARS_PER_MESSAGE = 2000;
const MAX_SESSION_TURNS = 10;
const MAX_CHAT_CODE_CHARS = 4000;

// 🧠 Инициализация нейро-роутера («мозжечка»)
const neuralRouter = new NeuralSkillRouter();
neuralRouter.load().catch(() => {
  console.log('🧠 Нейро-роутер: используются стандартные веса по умолчанию');
});

/**
 * Обрезка истории диалога (Context Pruning) для защиты контекстного окна модели
 */
function pruneMessages(messages, maxMessages = MAX_CONTEXT_MESSAGES, maxCharsPerMessage = MAX_CHARS_PER_MESSAGE) {
  if (!Array.isArray(messages)) return [];

  const normalized = messages
    .filter((msg) => msg && typeof msg.content === 'string' && msg.content.trim().length > 0)
    .map((msg) => {
      const content = msg.content.trim();
      const clipped = content.length > maxCharsPerMessage
        ? `${content.slice(0, maxCharsPerMessage)}\n...[обрезано для экономии контекста]`
        : content;
      return {
        role: msg.role === 'assistant' || msg.role === 'system' ? msg.role : 'user',
        content: clipped
      };
    });

  return normalized.slice(-maxMessages);
}

/**
 * Формирует краткую сводку последних реплик диалога, если сессия была обновлена
 */
function buildRecentHistoryBlock(prunedMessages) {
  if (prunedMessages.length <= 1) return '';
  const historySlice = prunedMessages.slice(0, -1).slice(-6);
  const formatted = historySlice
    .map((m) => `${m.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${m.content}`)
    .join('\n');
  return `\nКРАТКИЙ КОНТЕКСТ ПОСЛЕДНИХ СООБЩЕНИЙ ДИАЛОГА:\n${formatted}\n`;
}

async function getPersistentSession(forceReset = false) {
  if (!llamaInstance) {
    llamaInstance = await getLlama();
    const modelPath = path.resolve(process.cwd(), 'models', 'qwen2.5-7b-instruct-q4_k_m.gguf');
    modelInstance = await llamaInstance.loadModel({ modelPath });
    contextInstance = await modelInstance.createContext({
      sequences: 4
    });
  }

  const currentModeStr = sandboxConfig.strictDefault ? 'strict' : 'free';
  const contextLimitReached = sessionTurnCount >= MAX_SESSION_TURNS;

  if (forceReset || !persistentSession || lastActiveMode !== currentModeStr || contextLimitReached) {
    persistentSession = new LlamaChatSession({
      contextSequence: contextInstance.getSequence()
    });
    lastActiveMode = currentModeStr;
    sessionTurnCount = 0;
  }

  sessionTurnCount++;
  return persistentSession;
}

/**
 * Неубиваемый парсер JSON-плана.
 */
function safeParseJsonPayload(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  let cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  let candidate = '';
  if (firstBracket !== -1 && lastBracket > firstBracket && (firstBrace === -1 || firstBracket < firstBrace)) {
    candidate = cleaned.slice(firstBracket, lastBracket + 1);
  } else if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidate = cleaned.slice(firstBrace, lastBrace + 1);
  } else {
    return null;
  }
  try {
    return JSON.parse(candidate);
  } catch (_) {}

  const withoutTrailingCommas = candidate.replace(/,\s*([\]}])/g, '$1');
  try {
    return JSON.parse(withoutTrailingCommas);
  } catch (_) {}

  try {
    const repaired = withoutTrailingCommas.replace(
      /"(description|content|filePath|path|commandId)"\s*:\s*"([\s\S]*?)"(?=\s*,\s*"[a-zA-Z0-9_]+"|\s*\})/g,
      (match, key, val) => {
        const safeVal = val
          .replace(/\\"/g, '"')
          .replace(/"/g, '\\"')
          .replace(/\r\n/g, '\\n');
        return `"${key}": "${safeVal}"`;
      }
    );
    return JSON.parse(repaired);
  } catch (_) {}

  try {
    const superRepaired = withoutTrailingCommas.replace(/"description"\s*:\s*"([^"]*)"/g, (_, desc) => {
      const cleanDesc = desc.replace(/"/g, "'");
      return `"description": "${cleanDesc}"`;
    });
    return JSON.parse(superRepaired);
  } catch (_) {}

  return null;
}

function extractActionPlan(modelResponse) {
  const parsed = safeParseJsonPayload(modelResponse);
  if (!parsed) return [];
  if (Array.isArray(parsed)) {
    return parsed.filter(item => item && typeof item === 'object' && typeof item.tool === 'string');
  }
  if (typeof parsed === 'object' && typeof parsed.tool === 'string') {
    return [parsed];
  }
  return [];
}

/**
 * Преобразует сырой результат шага в структурированный объект
 */
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

/**
 * Форматирует результат выполнения инструмента для отображения пользователю в чате
 */
function formatStepResultForChat(toolName, rawResult) {
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

async function askModelToFixStep(step, errorMessage, session, tracer) {
  tracer.log(
    'routes.js',
    'askModelToFixStep',
    'RETRY',
    `Запрос самокоррекции. Ошибка: ${errorMessage}`,
    JSON.stringify(step)
  );
  const fixPrompt = `Ошибка выполнения шага: "${errorMessage}".
Исходный шаг: ${JSON.stringify(step)}
Верни СТРОГО JSON-объект формата без лишнего текста:
{ "tool": "writeFile", "arguments": { "filePath": "...", "content": "..." } }
Твой ответ:`;

  await gpuMutex.acquire();
  try {
    const rawFix = await session.prompt(fixPrompt);
    const parsedFix = safeParseJsonPayload(rawFix);
    if (parsedFix && typeof parsedFix === 'object' && !Array.isArray(parsedFix)) {
      tracer.log('routes.js', 'askModelToFixStep', 'OK', 'Получено исправление от модели', JSON.stringify(parsedFix));
      return parsedFix;
    }
    tracer.log('routes.js', 'askModelToFixStep', 'ERROR', 'Не удалось извлечь JSON-объект из ответа коррекции');
  } catch (e) {
    tracer.log('routes.js', 'askModelToFixStep', 'ERROR', `Ошибка парсинга исправления: ${e.message}`);
  } finally {
    gpuMutex.release();
  }
  return null;
}

router.post('/v1/chat/completions', async (req, res) => {
  await gpuMutex.acquire();
  let mutexReleased = false;
  const releaseGpuOnce = () => {
    if (!mutexReleased) {
      mutexReleased = true;
      gpuMutex.release();
    }
  };

  let session = null;
  const isTestRun = process.env.RUN_LLM_TESTS === 'true';
  const tracer = new ExecutionTracer(isTestRun ? 'test' : 'chat');
  let chatTranscript = '';

  try {
    const { messages, stream = false, strictSandbox } = req.body;
    let modeChanged = false;
    if (typeof strictSandbox === 'boolean' && sandboxConfig.strictDefault !== strictSandbox) {
      sandboxConfig.strictDefault = strictSandbox;
      modeChanged = true;
    }

    const prunedMessages = pruneMessages(messages);
    if (prunedMessages.length === 0) {
      releaseGpuOnce();
      return res.status(400).json({ error: { message: 'Пустой массив messages', code: 400 } });
    }

    const userMessage = prunedMessages[prunedMessages.length - 1].content;
    const recentHistoryBlock = buildRecentHistoryBlock(prunedMessages);
    const currentMode = sandboxConfig.strictDefault ? 'strict' : 'free';
    tracer.setContext(currentMode, userMessage);
    tracer.log(
      'routes.js',
      'POST /v1/chat/completions',
      'INFO',
      `stream=${stream}, mode=${currentMode}, reset=${modeChanged}, prunedCount=${prunedMessages.length}`
    );

    // 🧠 Прогоняем пользовательский запрос через наш рекурсивный нейро-роутер на CPU
    const routingDecision = neuralRouter.predict(userMessage);
    tracer.log('routes.js', 'NeuralRouter', 'INFO', `Мозжечок определил скил: ${routingDecision.selectedSkill} (уверенность: ${(routingDecision.confidence * 100).toFixed(1)}%)`);

    await initMind();
    await updateMindState(st => ({
      ...st,
      coreGoal: userMessage,
      mode: currentMode
    }));

    const mindSummary = await getMindContextSummary();
    const modeBadge = sandboxConfig.strictDefault ? '[Песочница]' : '[Свободный режим]';
    session = await getPersistentSession(modeChanged);

    if (!stream) {
      const prompt = `ТЕКУЩИЙ РЕЖИМ РАБОТЫ: ${currentMode.toUpperCase()} (${sandboxConfig.strictDefault ? 'Строго внутри tests/sandbox/' : 'Свободный доступ по всему проекту'}).\n\n${getToolsSystemPrompt()}\n\nАНАЛИЗ НЕЙРО-МОЗЖЕЧКА: Выбранный скил: ${routingDecision.selectedSkill} (${(routingDecision.confidence * 100).toFixed(0)}%).\n\n${mindSummary}${recentHistoryBlock}\nЗапрос: ${userMessage}`;
      
      const responseText = await session.prompt(prompt);
      releaseGpuOnce();
      const cleanResp = responseText.trim();
      tracer.setFinalResponse(cleanResp);
      tracer.log('routes.js', 'session.prompt (non-stream)', 'OK', 'Ответ сформирован');
      await tracer.commitAndSavePdf();

      return res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'local-agent-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: cleanResp },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: -1, completion_tokens: -1, total_tokens: -1 },
        neural_routing: routingDecision // Возвращаем вердикт нейросети для отладки
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendSSE = (data) => {
      const chunk = data?.choices?.[0]?.delta?.content;
      if (chunk) chatTranscript += chunk;
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendSSE({ choices: [{ delta: { role: 'assistant', content: `${modeBadge} Думаю...\n` } }] });

    const cognitivePrompt = `ТЕКУЩИЙ АКТИВНЫЙ РЕЖИМ СИСТЕМЫ: ${currentMode.toUpperCase()}
${sandboxConfig.strictDefault ? '-> ВНИМАНИЕ: Включен строгий режим песочницы (tests/sandbox/).' : '-> ВНИМАНИЕ: Включен СВОБОДНЫЙ режим работы по всему проекту.'}
${getToolsSystemPrompt()}
АНАЛИЗ НЕЙРО-МОЗЖЕЧКА: Предварительно определенный скил: ${routingDecision.selectedSkill} (${(routingDecision.confidence * 100).toFixed(0)}%).
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

    const modelResponse = await session.prompt(cognitivePrompt);
    releaseGpuOnce();
    tracer.setModelPlan(modelResponse);
    tracer.log('routes.js', 'session.prompt (stream)', 'OK', 'Получен ответ от модели');

    const plan = extractActionPlan(modelResponse);
    const isJsonPlan = plan.length > 0;

    if (!isJsonPlan) {
      const cleanText = modelResponse.trim();
      await pushRecursiveThought(`Запрос: ${userMessage} -> Ответ: ${cleanText.slice(0, 100)}`, 1, false);
      sendSSE({ choices: [{ delta: { content: `\n${cleanText}\n` } }] });
      tracer.setFinalResponse(chatTranscript.trim());
      tracer.log('routes.js', 'TextResponse', 'OK', 'Текстовый ответ отправлен в чат');
      await tracer.commitAndSavePdf();
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    await pushRecursiveThought(`Запрос: ${userMessage} -> План из ${plan.length} шагов`, 1, false);
    tracer.log('routes.js', 'PlanParser', 'OK', `План из ${plan.length} шагов`, JSON.stringify(plan));
    sendSSE({ choices: [{ delta: { content: `\nПлан принят (${plan.length} шагов). Выполняем...\n\n` } }] });

    let currentStepMeta = null;
    const progressCallback = (event) => {
      if (event.type === 'step_start') {
        const stepObj = plan.find(p => (p.step || 1) === event.step) || {};
        const argsObj = stepObj.arguments || {};
        const target =
          argsObj.filePath ||
          argsObj.dirPath ||
          argsObj.sourcePath ||
          argsObj.outputPath ||
          argsObj.path ||
          argsObj.commandId ||
          argsObj.command ||
          'не указан';
        currentStepMeta = { step: event.step, tool: event.tool || stepObj.tool, target };
        tracer.log('executor.js', `Шаг ${event.step} (${currentStepMeta.tool})`, 'INFO', `${event.description} [Путь: ${target}]`);
        sendSSE({ choices: [{ delta: { content: `▶ Шаг ${event.step}: ${event.description} [\`${currentStepMeta.tool}\`]\n` } }] });
      } else if (event.type === 'step_result') {
        const target = currentStepMeta?.target || 'не указан';
        const toolName = event.tool || currentStepMeta?.tool;
        if (event.success) {
          tracer.addAction(event.step, toolName, target, 'OK', event.result || 'Выполнено');
          tracer.log('executor.js', `Шаг ${event.step}`, 'OK', event.result || 'Успешно');
          const formatted = formatStepResultForChat(toolName, event.result);
          sendSSE({ choices: [{ delta: { content: formatted } }] });
        } else {
          tracer.addAction(event.step, toolName, target, 'ERROR', event.error);
          tracer.log('executor.js', `Шаг ${event.step}`, 'ERROR', event.error);
          sendSSE({ choices: [{ delta: { content: `❌ Ошибка: ${event.error}\n` } }] });
        }
      }
    };

    const executionReport = await executePlan(
      plan,
      progressCallback,
      session,
      (step, err, sess) => askModelToFixStep(step, err, sess, tracer),
      true
    );

    if (executionReport.success) {
      tracer.log('routes.js', 'ExecutionComplete', 'OK', 'Все шаги выполнены');
      sendSSE({ choices: [{ delta: { content: '\n✨ Готово!\n' } }] });
    } else {
      await pushRecursiveThought(`Провал: ${executionReport.error}`, 1, true);
      tracer.log('routes.js', 'ExecutionComplete', 'ERROR', executionReport.error);
      sendSSE({ choices: [{ delta: { content: `\n❌ Ошибка выполнения: ${executionReport.error}\n` } }] });
    }

    tracer.setFinalResponse(chatTranscript.trim());
    const pdfPath = await tracer.commitAndSavePdf();
    console.log(`📄 Сводный PDF-отчёт обновлён: ${pdfPath}`);
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('Ошибка:', error);
    tracer.log('routes.js', 'GlobalCatch', 'ERROR', error.message);
    tracer.setFinalResponse(chatTranscript.trim() || `Ошибка: ${error.message}`);
    await tracer.commitAndSavePdf();
    if (!res.headersSent) {
      res.status(500).json({ error: { message: error.message } });
    } else {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    }
    res.end();
  } finally {
    releaseGpuOnce();
  }
});

router.get('/v1/mind', async (req, res) => {
  const mindData = await initMind();
  res.json(mindData);
});

export default router;