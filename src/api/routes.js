import { Router } from 'express';
import { initLlamaEngine } from '../core/engine.js';
import { getToolsSystemPrompt, sandboxConfig } from '../tools/registry.js';
import { executePlan } from '../core/executor.js';
import { initMind, updateMindState, pushRecursiveThought, getMindContextSummary } from '../core/recursiveMind.js';
import { gpuMutex } from '../core/mutex.js';
import { ExecutionTracer } from '../core/reporter.js';
import { NeuralSkillRouter } from '../core/neuralRouter.js';
import { pruneMessages, buildRecentHistoryBlock } from '../core/contextPruner.js';
import { safeParseJsonPayload, extractActionPlan } from '../core/planParser.js';
import { formatStepResultForChat, buildNonStreamPrompt, buildCognitivePrompt } from './chatFormatter.js';

const router = Router();

const neuralRouter = new NeuralSkillRouter();
neuralRouter.load().catch(() => {
  console.log('🧠 Нейро-роутер: используются стандартные веса по умолчанию');
});

function inferActualSkillFromPlan(plan) {
  if (!Array.isArray(plan) || plan.length === 0) {
    return 'chat';
  }
  const allSystemCmd = plan.every((step) => step && step.tool === 'runCommand');
  return allSystemCmd ? 'system_cmd' : 'file_ops';
}

async function applyRouterFeedback(userMessage, actualSkill, tracer, isTestRun) {
  const feedback = neuralRouter.reinforceOutcome(userMessage, actualSkill);
  if (!feedback.updated) {
    return;
  }

  tracer.log(
    'routes.js',
    'NeuralRouter.reinforceOutcome',
    'INFO',
    `Дообучение роутера: ${feedback.previousSkill} (${(feedback.previousConfidence * 100).toFixed(1)}%) -> ${feedback.actualSkill} (${(feedback.newConfidence * 100).toFixed(1)}%)`
  );

  if (!isTestRun) {
    try {
      await neuralRouter.save();
    } catch (err) {
      tracer.log('routes.js', 'NeuralRouter.save', 'ERROR', `Не удалось сохранить веса роутера: ${err.message}`);
    }
  }
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

    const routingDecision = neuralRouter.predict(userMessage);
    tracer.log(
      'routes.js',
      'NeuralRouter',
      'INFO',
      `Мозжечок определил скил: ${routingDecision.selectedSkill} (уверенность: ${(routingDecision.confidence * 100).toFixed(1)}%)`
    );

    await initMind();
    await updateMindState((st) => ({
      ...st,
      coreGoal: userMessage,
      mode: currentMode
    }));

    const mindSummary = await getMindContextSummary();
    const modeBadge = sandboxConfig.strictDefault ? '[Песочница]' : '[Свободный режим]';
    const toolsPrompt = getToolsSystemPrompt();
    session = await initLlamaEngine({
      forceReset: modeChanged,
      mode: currentMode
    });

    if (!stream) {
      const prompt = buildNonStreamPrompt({
        currentMode,
        strictDefault: sandboxConfig.strictDefault,
        toolsPrompt,
        routingDecision,
        mindSummary,
        recentHistoryBlock,
        userMessage
      });

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
        neural_routing: routingDecision
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

    const cognitivePrompt = buildCognitivePrompt({
      currentMode,
      strictDefault: sandboxConfig.strictDefault,
      toolsPrompt,
      routingDecision,
      mindSummary,
      recentHistoryBlock,
      userMessage
    });

    const modelResponse = await session.prompt(cognitivePrompt);
    releaseGpuOnce();
    tracer.setModelPlan(modelResponse);
    tracer.log('routes.js', 'session.prompt (stream)', 'OK', 'Получен ответ от модели');

    const plan = extractActionPlan(modelResponse);
    const isJsonPlan = plan.length > 0;

    if (!isJsonPlan) {
      const cleanText = modelResponse.trim();
      await applyRouterFeedback(userMessage, 'chat', tracer, isTestRun);
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
      (step, err, sess, prevResults) => askModelToFixStep(step, err, sess, tracer, prevResults),
      true
    );

    if (executionReport.success) {
      const actualSkill = inferActualSkillFromPlan(plan);
      await applyRouterFeedback(userMessage, actualSkill, tracer, isTestRun);
      tracer.log('routes.js', 'ExecutionComplete', 'OK', 'Все шаги выполнены');
      sendSSE({ choices: [{ delta: { content: '\n✨ Готово!\n' } }] });
    } else {
      await pushRecursiveThought(`Провал: ${executionReport.error}`, 1, true);
      tracer.log('routes.js', 'ExecutionComplete', 'ERROR', executionReport.error);
      sendSSE({ choices: [{ delta: { content: `\n❌ Ошибка выполнения: ${executionReport.error}\n` } }] });
    }

    tracer.setFinalResponse(chatTranscript.trim());
    const reportPath = await tracer.commitAndSavePdf();
    console.log(`📄 Сводный отчёт обновлён: ${reportPath}`);
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

router.post('/v1/session/reset', async (req, res) => {
  await gpuMutex.acquire();
  try {
    const { strictSandbox } = req.body || {};
    if (typeof strictSandbox === 'boolean') {
      sandboxConfig.strictDefault = strictSandbox;
    }

    const currentMode = sandboxConfig.strictDefault ? 'strict' : 'free';
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
      strictSandbox: sandboxConfig.strictDefault
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
    strictSandbox: sandboxConfig.strictDefault
  });
});

export default router;