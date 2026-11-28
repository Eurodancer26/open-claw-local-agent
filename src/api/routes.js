// src/api/routes.js
import { Router } from 'express';
import { createHash } from 'node:crypto';
import { initLlamaEngine } from '../core/engine.js';
import {
  getToolsSystemPrompt,
  DEFAULT_STRICT_SANDBOX,
  toolsRegistry,
  registerPluginTools
} from '../tools/registry.js';
import { loadPluginsFromDir, PLUGIN_DIR_NAME } from '../tools/pluginLoader.js';
import { syncKnownToolsFromRegistry } from '../core/planParser.js';
import path from 'node:path';
import { WORKSPACE_ROOT } from '../tools/pathSecurity.js';
import { executePlan } from '../core/executor.js';
import {
  initMind,
  updateMindState,
  pushRecursiveThought,
  getMindContextSummary
} from '../core/recursiveMind.js';
import { gpuMutex } from '../core/mutex.js';
import { ExecutionTracer } from '../core/reporter.js';
import { NeuralSkillRouter } from '../core/neuralRouter.js';
import {
  pruneMessages,
  buildRecentHistoryBlock,
  MAX_DIALOG_HISTORY_MESSAGES,
  MAX_DIALOG_HISTORY_CHARS
} from '../core/contextPruner.js';
import { safeParseJsonPayload, extractActionPlan } from '../core/planParser.js';
import {
  formatStepResultForChat,
  buildNonStreamPrompt,
  buildCognitivePrompt,
  formatRoutingHint
} from './chatFormatter.js';
import { createClientAbortGuard, createAbortError, raceAgainstClientAbort } from './streamGuard.js';
import { ConfirmGate } from './confirmGate.js';

const router = Router();

const neuralRouter = new NeuralSkillRouter();
neuralRouter.load().catch(() => {
  console.log('🧠 Нейро-роутер: используются стандартные веса по умолчанию');
});

// Блок 6.3: гейт интерактивного подтверждения опасных действий (deleteFile и т.п.).
const confirmGate = new ConfirmGate();

// Блок 6.5: загрузка плагинных инструментов из <корень проекта>/tools/*.plugin.mjs.
// Вызывается на старте сервера; в тестах (без старта) остаётся только ядро.
export async function initPlugins() {
  const dir = path.join(WORKSPACE_ROOT, PLUGIN_DIR_NAME);
  try {
    const plugins = await loadPluginsFromDir(dir, {
      onError: (msg) => console.warn(`⚠️ Плагин пропущен: ${msg}`)
    });
    const added = registerPluginTools(plugins);
    if (added.length > 0) {
      console.log(`🔌 Плагинные инструменты зарегистрированы: ${added.join(', ')}`);
    }
    syncKnownToolsFromRegistry();
  } catch (error) {
    console.warn(`⚠️ Не удалось загрузить плагины: ${error.message}`);
  }
}

function inferActualSkillFromPlan(plan) {
  if (!Array.isArray(plan) || plan.length === 0) {
    return 'chat';
  }
  const allSystemCmd = plan.every((step) => step && step.tool === 'runCommand');
  return allSystemCmd ? 'system_cmd' : 'file_ops';
}

// Блок 6.2: уточнённый сигнал роутера. Если план только читает/перечисляет
// (readFile / listDir / searchInFiles) и ничего не пишет и не анализирует —
// это system_cmd, даже если формально пришёл не-runCommand-план.
// Раньше любой не-runCommand-план жёстко помечался file_ops.
function refinePlanSkill(plan) {
  const base = inferActualSkillFromPlan(plan);
  if (base !== 'file_ops' || !Array.isArray(plan)) return base;

  const tools = new Set(plan.map((s) => s && s.tool).filter(Boolean));
  const hasWriteOrAnalyze = ['writeFile', 'createDir', 'analyzeProject', 'generateUnitTest'].some(
    (t) => tools.has(t)
  );
  const onlyReadOps =
    tools.size > 0 &&
    [...tools].every((t) => t === 'readFile' || t === 'listDir' || t === 'searchInFiles');

  if (onlyReadOps && !hasWriteOrAnalyze) return 'system_cmd';
  return 'file_ops';
}

// Дедупликация подтверждённых исходов: один и тот же запрос не должен
// переучивать роутер много раз подряд (эхо-повторы, повторные запросы).
const recentConfirmedKeys = new Map();
const CONFIRMED_DEDUP_TTL_MS = 60_000;

function confirmedKey(userMessage, actualSkill) {
  const normalized = String(userMessage || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const digest = createHash('sha1').update(normalized).digest('hex').slice(0, 16);
  return `${actualSkill}:${digest}`;
}

function isDuplicateConfirmed(key) {
  const now = Date.now();
  for (const [k, ts] of recentConfirmedKeys) {
    if (now - ts > CONFIRMED_DEDUP_TTL_MS) recentConfirmedKeys.delete(k);
  }
  const prev = recentConfirmedKeys.get(key);
  if (typeof prev === 'number' && now - prev <= CONFIRMED_DEDUP_TTL_MS) {
    return true;
  }
  recentConfirmedKeys.set(key, now);
  return false;
}

/**
 * Блок 6.2: дообучение роутера ТОЛЬКО по подтверждённым успехам.
 * Онлайн-подкрепление (reinforceOutcome) применяется сразу, батч — при
 * накоплении порога в буфере роутера. Дубликаты в пределах TTL игнорируются;
 * провалы и «мусорные» исходы сюда не попадают вообще.
 */
async function recordConfirmedOutcome(userMessage, actualSkill, tracer, isTestRun) {
  const key = confirmedKey(userMessage, actualSkill);
  if (isDuplicateConfirmed(key)) {
    tracer.log(
      'routes.js',
      'RouterFeedback',
      'INFO',
      `Подтверждённый исход ${actualSkill} уже учтён недавно — пропуск`
    );
    return;
  }

  const feedback = neuralRouter.reinforceOutcome(userMessage, actualSkill);
  if (feedback.updated) {
    tracer.log(
      'routes.js',
      'NeuralRouter.reinforceOutcome',
      'INFO',
      `Дообучение роутера: ${feedback.previousSkill} (${(feedback.previousConfidence * 100).toFixed(1)}%) -> ${feedback.actualSkill} (${(feedback.newConfidence * 100).toFixed(1)}%)`
    );
  }

  const batch = neuralRouter.recordConfirmedSuccess(userMessage, actualSkill);
  if (batch.trained) {
    tracer.log(
      'routes.js',
      'NeuralRouter.trainBatch',
      'INFO',
      `Батч-дообучение по подтверждённым успехам: ${batch.batchSize} пример(ов), скилы: ${batch.skills.join(', ')}`
    );
  } else if (batch.reason === 'pending') {
    tracer.log(
      'routes.js',
      'NeuralRouter.trainBatch',
      'INFO',
      `Накоплено подтверждённых успехов: ${batch.pending}/${batch.threshold}`
    );
  }

  if (!isTestRun && (feedback.updated || batch.trained)) {
    try {
      await neuralRouter.save();
    } catch (err) {
      tracer.log(
        'routes.js',
        'NeuralRouter.save',
        'ERROR',
        `Не удалось сохранить веса роутера: ${err.message}`
      );
    }
  }
}

function buildTextOnlyPrompt({
  currentMode,
  strictDefault,
  routingDecision,
  mindSummary,
  recentHistoryBlock,
  userMessage
}) {
  const routingHint = formatRoutingHint(routingDecision);
  const modeLine = strictDefault
    ? 'Строгий режим песочницы (tests/sandbox/).'
    : 'Свободный режим по всему проекту.';

  const memoryBlock = String(mindSummary || '').trim()
    ? `\nПАМЯТЬ (контекст, не для копирования):\n${mindSummary}\n`
    : '';

  return `РЕЖИМ: ${currentMode.toUpperCase()}. ${modeLine}

${routingHint}
${memoryBlock}${recentHistoryBlock}
ПРАВИЛО: этот запрос — беседа/информация. Ответь ТОЛЬКО обычным текстом на русском. НЕ возвращай JSON. НЕ создавай файлы. Если для ответа нужен отсутствующий инструмент (дата, погода) — честно скажи: «У меня нет такого инструмента».

ЗАПРОС ПОЛЬЗОВАТЕЛЯ:
${userMessage}

Твой ответ:`;
}

// Подсказка под конкретную ошибку — помогает модели не повторять ту же ошибку
// в цикле самокоррекции.
function getErrorHint(errorMessage) {
  const msg = String(errorMessage || '').toLowerCase();

  if (/абсолютные.*windows|unc|абсолютный путь/i.test(msg)) {
    return 'ПОДСКАЗКА: используй ОТНОСИТЕЛЬНЫЙ путь от корня проекта. Пример: вместо "D:\\project\\src" пиши "src". Без буквы диска и без ведущего слэша.';
  }
  if (/путь указывает на директорию/i.test(msg)) {
    return 'ПОДСКАЗКА: для чтения содержимого директории используй listDir (или analyzeProject для статистики). readFile — только для файлов.';
  }
  if (/директорию, а не файл.*удаление/i.test(msg)) {
    return 'ПОДСКАЗКА: инструмент deleteFile удаляет только файлы. Директории не удаляются.';
  }
  if (/mkdir.*не разрешен|команда.*mkdir/i.test(msg)) {
    return 'ПОДСКАЗКА: mkdir не существует. Для создания папки используй инструмент createDir с аргументом dirPath.';
  }
  if (/loop guard/i.test(msg)) {
    return 'ПОДСКАЗКА: предыдущая попытка не сработала. Верни ДРУГОЙ план — измени путь или инструмент. Не повторяй то же самое.';
  }
  if (/writeFile.*заканчивается слэшем/i.test(msg)) {
    return 'ПОДСКАЗКА: writeFile создаёт файл, а не папку. Если пользователь просит папку — используй createDir.';
  }
  return '';
}

function buildActionRetryPrompt({ userMessage, originalResponse, strictDefault }) {
  const preview = String(originalResponse ?? '').slice(0, 800);
  const pathRule = strictDefault
    ? 'Пути относительны tests/sandbox/. Без префикса "tests/sandbox/".'
    : 'Ты в СВОБОДНОМ режиме. Пути относительны корня проекта. Абсолютные пути (C:\\..., D:\\...) и "../" запрещены.';

  return `Твой предыдущий ответ НЕ является валидным JSON-массивом шагов:
---
${preview}
---

Повтори ответ СТРОГО в виде JSON-массива. БЕЗ markdown (\`\`\`json), БЕЗ текста до и после.
Только ${Object.keys(toolsRegistry).join(', ')}.
Формат: [{"step":1,"tool":"writeFile","arguments":{"filePath":"...","content":"..."},"description":"..."}]
${pathRule}
Имя файла и содержимое бери ДОСЛОВНО из запроса пользователя ниже — не подставляй примеры.

ЗАПРОС ПОЛЬЗОВАТЕЛЯ:
${userMessage}

Твой ответ (только JSON, без markdown):`;
}

function buildFixPrompt(step, errorMessage, userMessage, prevResults = [], strictDefault = true) {
  const completedStepsSummary =
    Array.isArray(prevResults) && prevResults.length > 0
      ? `Уже выполненные шаги: ${prevResults.map((r) => `step ${r.step} (${r.tool})`).join(', ')}.`
      : 'Выполненных шагов пока нет.';

  const pathRule = strictDefault
    ? 'Режим strict: пути относительны tests/sandbox/ (без префикса "tests/sandbox/"). Вне песочницы работать нельзя.'
    : 'Режим free: пути относительны КОРНЯ ПРОЕКТА (WORKSPACE_ROOT). Абсолютные пути (C:\\..., D:\\..., //server/...) и "../" ЗАПРЕЩЕНЫ.';

  const hint = getErrorHint(errorMessage);
  const hintBlock = hint ? `\n${hint}\n` : '';

  return `ИСХОДНЫЙ ЗАПРОС ПОЛЬЗОВАТЕЛЯ:
${userMessage}

ОШИБКА выполнения шага: "${errorMessage}"
${hintBlock}${completedStepsSummary}
УПАВШИЙ ШАГ: ${JSON.stringify(step)}

${pathRule}

ЗАДАЧА: верни СТРОГО один JSON-объект исправленного шага, который решает ИСХОДНЫЙ запрос пользователя.
- Если исходный запрос просит создать файл X с текстом Y — используй ИМЕННО X и Y из запроса, не выдумывай.
- Если исходный запрос просит создать ПАПКУ — используй инструмент createDir, а не writeFile.
- Не подставляй "типичные" имена файлов (config.json, test.js, index.js и т.п.), если пользователь их не назвал.
- Разрешены ТОЛЬКО инструменты: ${Object.keys(toolsRegistry).join(', ')}.
- Не повторяй уже выполненные успешные шаги.

Формат ответа (без markdown, без пояснений):
{ "tool": "writeFile", "arguments": { "filePath": "...", "content": "..." }, "description": "Исправленный шаг" }

Твой ответ:`;
}

async function askModelToFixStep(
  step,
  errorMessage,
  session,
  tracer,
  prevResults,
  userMessage,
  strictDefault,
  signal = undefined
) {
  tracer.log(
    'routes.js',
    'askModelToFixStep',
    'RETRY',
    `Запрос самокоррекции. Ошибка: ${errorMessage}`,
    JSON.stringify(step)
  );

  const fixPrompt = buildFixPrompt(step, errorMessage, userMessage, prevResults, strictDefault);

  await gpuMutex.acquire();
  try {
    if (signal?.aborted) {
      throw createAbortError();
    }
    const rawFix = await session.prompt(
      fixPrompt,
      signal ? { signal, stopOnAbortSignal: true } : undefined
    );
    const parsedFix = safeParseJsonPayload(rawFix);
    if (parsedFix && typeof parsedFix === 'object' && !Array.isArray(parsedFix)) {
      tracer.log(
        'routes.js',
        'askModelToFixStep',
        'OK',
        'Получено исправление от модели',
        JSON.stringify(parsedFix)
      );
      return parsedFix;
    }
    tracer.log(
      'routes.js',
      'askModelToFixStep',
      'ERROR',
      'Не удалось извлечь JSON-объект из ответа коррекции'
    );
  } catch (e) {
    tracer.log(
      'routes.js',
      'askModelToFixStep',
      'ERROR',
      `Ошибка парсинга исправления: ${e.message}`
    );
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

  // Обрыв соединения клиента: следим за res 'close'/'aborted' и получаем
  // AbortSignal, которым можно остановить генерацию node-llama-cpp.
  const clientGuard = createClientAbortGuard(req, res);
  const abortSignal = clientGuard.signal;
  const promptOptions = { signal: abortSignal, stopOnAbortSignal: true };

  // Инициализируется ниже (initLlamaEngine) перед использованием; null нужен,
  // чтобы finally/refinePlanSkill не падали, если исключение прилетело раньше.
  // eslint-disable-next-line no-useless-assignment -- сброс к null обязателен для безопасного finally до инициализации
  let session = null;
  const isTestRun = process.env.RUN_LLM_TESTS === 'true';
  const tracer = new ExecutionTracer(isTestRun ? 'test' : 'chat');
  let chatTranscript = '';

  try {
    const { messages, stream = false, strictSandbox } = req.body;

    // Режим песочницы — только этого запроса, без глобальной мутации:
    // если strictSandbox не передан, берём замороженный дефолт.
    const requestStrict =
      typeof strictSandbox === 'boolean' ? strictSandbox : DEFAULT_STRICT_SANDBOX;

    const prunedMessages = pruneMessages(messages);
    if (prunedMessages.length === 0) {
      releaseGpuOnce();
      return res.status(400).json({ error: { message: 'Пустой массив messages', code: 400 } });
    }

    const userMessage = prunedMessages[prunedMessages.length - 1].content;
    const recentHistoryBlock = buildRecentHistoryBlock(prunedMessages);
    const currentMode = requestStrict ? 'strict' : 'free';
    tracer.setContext(currentMode, userMessage);
    tracer.log(
      'routes.js',
      'POST /v1/chat/completions',
      'INFO',
      `stream=${stream}, mode=${currentMode}, strict=${requestStrict}, prunedCount=${prunedMessages.length}`,
      JSON.stringify(prunedMessages, null, 2)
    );

    const routingDecision = neuralRouter.predict(userMessage);
    const expectedMode = routingDecision.mode || 'unknown';
    tracer.setRoutingInfo(routingDecision);
    tracer.log(
      'routes.js',
      'NeuralRouter',
      'INFO',
      `Мозжечок определил скил: ${routingDecision.selectedSkill} (уверенность: ${(routingDecision.confidence * 100).toFixed(1)}%), mode=${expectedMode}`,
      JSON.stringify(routingDecision, null, 2)
    );

    await initMind();
    await updateMindState((st) => ({
      ...st,
      coreGoal: userMessage,
      mode: currentMode
    }));

    const mindSummary = await getMindContextSummary();
    const modeBadge = requestStrict ? '[Песочница]' : '[Свободный режим]';
    const toolsPrompt = getToolsSystemPrompt();
    session = await initLlamaEngine({
      forceReset: false, // сессия не сбрасывается из-за смены режима: режим теперь per-request
      mode: currentMode
    });

    if (!stream) {
      const prompt =
        expectedMode === 'chat'
          ? buildTextOnlyPrompt({
              currentMode,
              strictDefault: requestStrict,
              routingDecision,
              mindSummary,
              recentHistoryBlock,
              userMessage
            })
          : buildNonStreamPrompt({
              currentMode,
              strictDefault: requestStrict,
              toolsPrompt,
              routingDecision,
              mindSummary,
              recentHistoryBlock,
              userMessage
            });
      tracer.setPromptSent(prompt);

      const responseText = await session.prompt(prompt, promptOptions);
      releaseGpuOnce();
      // Клиент ушёл, пока считалась генерация: отвечать некому.
      if (clientGuard.clientGone) return;
      const cleanResp = responseText.trim();
      tracer.setFinalResponse(cleanResp);
      tracer.log(
        'routes.js',
        'session.prompt (non-stream)',
        'OK',
        `Ответ сформирован (mode=${expectedMode})`
      );
      await tracer.commitAndSavePdf();

      return res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'local-agent-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: cleanResp },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: -1, completion_tokens: -1, total_tokens: -1 },
        neural_routing: routingDecision
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendSSE = (data) => {
      const chunk = data?.choices?.[0]?.delta?.content;
      if (chunk) chatTranscript += chunk;
      // Никаких записей в уже закрытый/разрушенный ответ.
      clientGuard.send(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendSSE({ choices: [{ delta: { role: 'assistant', content: `${modeBadge} Думаю...\n` } }] });

    // ---------- ВЕТКА 1: ЧИСТЫЙ ДИАЛОГ ----------
    if (expectedMode === 'chat') {
      const textPrompt = buildTextOnlyPrompt({
        currentMode,
        strictDefault: requestStrict,
        routingDecision,
        mindSummary,
        recentHistoryBlock,
        userMessage
      });
      tracer.setPromptSent(textPrompt);

      const rawText = await session.prompt(textPrompt, promptOptions);
      releaseGpuOnce();
      // Клиент ушёл — не пишем в мысль, не дообучаем роутер и не шлём [DONE].
      if (clientGuard.clientGone) throw createAbortError();
      tracer.setModelPlan(rawText);
      tracer.log(
        'routes.js',
        'session.prompt (stream, chat-mode)',
        'OK',
        'Получен текстовый ответ'
      );

      const cleanText = rawText.trim();

      const planLookalike = extractActionPlan(rawText);
      if (planLookalike.length > 0) {
        tracer.log(
          'routes.js',
          'ChatModePlanIgnored',
          'WARN',
          `На chat-запрос модель вернула план из ${planLookalike.length} шагов — план проигнорирован, отдан как текст.`
        );
      }

      await pushRecursiveThought(
        `Запрос: ${userMessage} -> Ответ: ${cleanText.slice(0, 100)}`,
        1,
        false
      );
      await recordConfirmedOutcome(userMessage, 'chat', tracer, isTestRun);

      sendSSE({ choices: [{ delta: { content: `\n${cleanText}\n` } }] });
      tracer.setFinalResponse(chatTranscript.trim());
      tracer.log('routes.js', 'TextResponse', 'OK', 'Текстовый ответ отправлен в чат');
      await tracer.commitAndSavePdf();
      return clientGuard.end('data: [DONE]\n\n');
    }

    // ---------- ВЕТКА 2: ДЕЙСТВИЕ / MIXED / UNKNOWN ----------
    const cognitivePrompt = buildCognitivePrompt({
      currentMode,
      strictDefault: requestStrict,
      toolsPrompt,
      routingDecision,
      mindSummary,
      recentHistoryBlock,
      userMessage
    });
    tracer.setPromptSent(cognitivePrompt);

    let modelResponse = await session.prompt(cognitivePrompt, promptOptions);
    releaseGpuOnce();
    // Клиент ушёл во время генерации — план не выполняем.
    if (clientGuard.clientGone) throw createAbortError();
    tracer.setModelPlan(modelResponse);
    tracer.log(
      'routes.js',
      'session.prompt (stream)',
      'OK',
      `Получен ответ от модели (mode=${expectedMode})`
    );

    let plan = extractActionPlan(modelResponse);

    if (plan.length === 0 && expectedMode === 'action') {
      tracer.log(
        'routes.js',
        'ActionRetry',
        'RETRY',
        'План не распознан, запрашиваем повтор в строгом формате'
      );
      const retryPrompt = buildActionRetryPrompt({
        userMessage,
        originalResponse: modelResponse,
        strictDefault: requestStrict
      });
      const retryResponse = await session.prompt(retryPrompt, promptOptions);
      if (clientGuard.clientGone) throw createAbortError();
      const retryPlan = extractActionPlan(retryResponse);
      if (retryPlan.length > 0) {
        modelResponse = retryResponse;
        plan = retryPlan;
        tracer.setModelPlan(modelResponse);
        tracer.log('routes.js', 'ActionRetry', 'OK', `Retry успешен: план из ${plan.length} шагов`);
      } else {
        tracer.log('routes.js', 'ActionRetry', 'ERROR', 'Retry не дал валидного плана');
      }
    }

    const isJsonPlan = plan.length > 0;

    if (!isJsonPlan) {
      const cleanText = modelResponse.trim();

      if (expectedMode !== 'action') {
        await recordConfirmedOutcome(userMessage, 'chat', tracer, isTestRun);
      } else {
        tracer.log(
          'routes.js',
          'FeedbackSkipped',
          'WARN',
          'Action-запрос провалился в текст — роутер не дообучаем'
        );
      }

      await pushRecursiveThought(
        `Запрос: ${userMessage} -> Ответ: ${cleanText.slice(0, 100)}`,
        1,
        false
      );
      sendSSE({ choices: [{ delta: { content: `\n${cleanText}\n` } }] });
      if (clientGuard.clientGone) throw createAbortError();
      tracer.setFinalResponse(chatTranscript.trim());
      tracer.log('routes.js', 'TextResponse', 'OK', 'Текстовый ответ отправлен в чат (fallback)');
      await tracer.commitAndSavePdf();
      return clientGuard.end('data: [DONE]\n\n');
    }

    await pushRecursiveThought(`Запрос: ${userMessage} -> План из ${plan.length} шагов`, 1, false);
    tracer.log(
      'routes.js',
      'PlanParser',
      'OK',
      `План из ${plan.length} шагов`,
      JSON.stringify(plan, null, 2)
    );
    sendSSE({
      choices: [{ delta: { content: `\nПлан принят (${plan.length} шагов). Выполняем...\n\n` } }]
    });

    let currentStepMeta = null;
    const progressCallback = (event) => {
      // Клиент ушёл — не выполняем следующие шаги плана.
      if (clientGuard.clientGone) {
        throw createAbortError();
      }
      if (event.type === 'step_start') {
        const stepObj = plan.find((p) => (p.step || 1) === event.step) || {};
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
        currentStepMeta = {
          step: event.step,
          tool: event.tool || stepObj.tool,
          target,
          args: argsObj
        };
        tracer.log(
          'executor.js',
          `Шаг ${event.step} (${currentStepMeta.tool})`,
          'INFO',
          `${event.description} [Путь: ${target}]`,
          JSON.stringify(argsObj, null, 2)
        );
        sendSSE({
          choices: [
            {
              delta: {
                content: `▶ Шаг ${event.step}: ${event.description} [\`${currentStepMeta.tool}\`]\n`
              }
            }
          ]
        });
      } else if (event.type === 'step_result') {
        const target = currentStepMeta?.target || 'не указан';
        const toolName = event.tool || currentStepMeta?.tool;
        const argsObj = currentStepMeta?.args || null;
        if (event.success) {
          tracer.addAction(
            event.step,
            toolName,
            target,
            'OK',
            event.result || 'Выполнено',
            argsObj
          );
          tracer.log('executor.js', `Шаг ${event.step}`, 'OK', event.result || 'Успешно');
          const formatted = formatStepResultForChat(toolName, event.result);
          sendSSE({ choices: [{ delta: { content: formatted } }] });
        } else {
          tracer.addAction(event.step, toolName, target, 'ERROR', event.error, argsObj);
          tracer.log('executor.js', `Шаг ${event.step}`, 'ERROR', event.error);
          sendSSE({ choices: [{ delta: { content: `❌ Ошибка: ${event.error}\n` } }] });
        }
      }
    };

    let executionReport;
    try {
      executionReport = await raceAgainstClientAbort(
        executePlan(
          plan,
          progressCallback,
          session,
          (step, err, sess, prevResults) =>
            askModelToFixStep(
              step,
              err,
              sess,
              tracer,
              prevResults,
              userMessage,
              requestStrict,
              abortSignal
            ),
          true,
          2,
          requestStrict,
          {
            signal: abortSignal,
            // Блок 6.3: подтверждение опасно только в свободном режиме —
            // в песочнице файлы изолированы, спрашивать не нужно.
            confirmStep: requestStrict
              ? undefined
              : (step) =>
                  confirmGate.request(
                    {
                      tool: step.tool,
                      arguments: step.arguments,
                      description: step.description
                    },
                    (id, payload) => {
                      clientGuard.send(
                        `data: ${JSON.stringify({ type: 'confirmation_request', id, ...payload })}\n\n`
                      );
                    },
                    abortSignal
                  )
          }
        ),
        clientGuard
      );
    } finally {
      // executePlan получил сигнал обрыва и вернул report.aborted (сам он не бросает):
      // превращаем это в AbortError, чтобы внешний catch отработал как при обрыве.
      // eslint-disable-next-line no-unsafe-finally -- throw нужен намеренно: пробрасываем abort из finally во внешний catch
      if (executionReport?.aborted || clientGuard.clientGone) throw createAbortError();
    }

    if (executionReport.success) {
      const actualSkill = refinePlanSkill(plan);
      await recordConfirmedOutcome(userMessage, actualSkill, tracer, isTestRun);
      tracer.log('routes.js', 'ExecutionComplete', 'OK', 'Все шаги выполнены');
      sendSSE({ choices: [{ delta: { content: '\n✨ Готово!\n' } }] });
    } else {
      await pushRecursiveThought(`Провал: ${executionReport.error}`, 1, true);
      tracer.log('routes.js', 'ExecutionComplete', 'ERROR', executionReport.error);
      sendSSE({
        choices: [{ delta: { content: `\n❌ Ошибка выполнения: ${executionReport.error}\n` } }]
      });
    }

    tracer.setFinalResponse(chatTranscript.trim());
    const reportPath = await tracer.commitAndSavePdf();
    console.log(`📄 Сводный отчёт обновлён: ${reportPath}`);
    clientGuard.end('data: [DONE]\n\n');
  } catch (error) {
    // Обрыв соединения клиента — не ошибка сервера: не отдаём 500 и не пишем в мёртвый ответ.
    const aborted =
      error?.name === 'AbortError' ||
      clientGuard.clientGone ||
      /разорвал соединение/i.test(String(error?.message || ''));

    if (aborted) {
      console.log('⏹️ Генерация прервана: клиент разорвал соединение');
      tracer.log(
        'routes.js',
        'ClientAborted',
        'WARN',
        error?.message || 'Клиент разорвал соединение'
      );
    } else {
      console.error('Ошибка:', error);
      tracer.log('routes.js', 'GlobalCatch', 'ERROR', error.message);
    }

    tracer.setFinalResponse(chatTranscript.trim() || `Ошибка: ${error.message}`);
    await tracer.commitAndSavePdf();

    if (!aborted) {
      if (!res.headersSent) {
        res.status(500).json({ error: { message: error.message } });
      } else {
        clientGuard.send(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        clientGuard.end();
      }
    }
  } finally {
    clientGuard.dispose();
    releaseGpuOnce();
  }
});

router.post('/v1/confirm', (req, res) => {
  const { id, approved } = req.body || {};
  const handled = confirmGate.settle(id, approved === true);
  res.json({ success: handled, id: id ?? null, approved: approved === true });
});

router.post('/v1/session/reset', async (req, res) => {
  await gpuMutex.acquire();
  try {
    const { strictSandbox } = req.body || {};
    // Без глобальной мутации: режим этого вызова определяем локально.
    const currentMode = (
      typeof strictSandbox === 'boolean' ? strictSandbox : DEFAULT_STRICT_SANDBOX
    )
      ? 'strict'
      : 'free';
    neuralRouter.resetMemory();

    await initMind();
    await updateMindState((st) => ({
      ...st,
      coreGoal: 'Ожидание новой задачи после сброса сессии',
      mode: currentMode
    }));

    await initLlamaEngine({
      forceReset: true,
      mode: currentMode
    });

    res.json({
      success: true,
      mode: currentMode,
      strictSandbox: currentMode === 'strict'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    gpuMutex.release();
  }
});

router.get('/v1/mind', async (req, res) => {
  const mindData = await initMind();
  res.json({
    ...mindData,
    strictSandbox: DEFAULT_STRICT_SANDBOX,
    // T6: единый источник лимитов истории диалога для клиента,
    // чтобы public/app.js не держал свой несогласованный лимит.
    dialogHistory: {
      maxMessages: MAX_DIALOG_HISTORY_MESSAGES,
      maxChars: MAX_DIALOG_HISTORY_CHARS
    }
  });
});

export default router;
