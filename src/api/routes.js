import { Router } from 'express';
import { initLlamaEngine } from '../core/engine.js';
import { getToolsSystemPrompt } from '../tools/registry.js';
import { executePlan } from '../core/executor.js';

const router = Router();

router.post('/v1/chat/completions', async (req, res) => {
  let session = null;
  try {
    const { messages, stream = false } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: 'Поле "messages" должно быть непустым массивом.',
          type: 'invalid_request_error',
          code: 400
        }
      });
    }

    const userMessage = messages[messages.length - 1].content;
    const engine = await initLlamaEngine();
    session = await engine.createSession();

    if (!stream) {
      const prompt = `${getToolsSystemPrompt()}\n\nЗапрос пользователя: ${userMessage}`;
      const responseText = await session.prompt(prompt);

      return res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'local-agent-model',
        choices: [{ index: 0, message: { role: 'assistant', content: responseText.trim() }, finish_reason: 'stop' }],
        usage: { prompt_tokens: -1, completion_tokens: -1, total_tokens: -1 }
      });
    }

    // Режим агентичного SSE-стриминга с самокоррекцией
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendSSE = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendSSE({
      choices: [{ delta: { role: 'assistant', content: '📋 Анализирую задачу и составляю пошаговый план...\n' } }]
    });

    const plannerPrompt = `${getToolsSystemPrompt()}

Ты — автономный агент-планировщик «Конструкт АИ». Твоя задача — проанализировать запрос пользователя и составить пошаговый план выполнения в виде строгого JSON-массива объектов следующей структуры:
[
  { "step": 1, "tool": "имя_инструмента", "arguments": { ... }, "description": "описание шага" }
]

Доступные инструменты: readFile, writeFile, runCommand.
Если инструменты не нужны для ответа, верни пустой массив [].
Отвечай СТРОГО в формате валидного JSON-массива, без лишнего текста.

Запрос пользователя: ${userMessage}`;

    const plannerResponse = await session.prompt(plannerPrompt);
    
    let plan = [];
    try {
      const jsonMatch = plannerResponse.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (jsonMatch) {
        plan = JSON.parse(jsonMatch[0]);
      }
    } catch (err) {
      console.error('Ошибка парсинга плана агента:', err);
    }

    if (!Array.isArray(plan) || plan.length === 0) {
      sendSSE({
        choices: [{ delta: { content: `\n${plannerResponse}\n` } }]
      });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    sendSSE({
      choices: [{ delta: { content: `\n✅ План составлен (${plan.length} шагов). Начинаю выполнение...\n\n` } }]
    });

    for (const item of plan) {
      sendSSE({
        choices: [{ delta: { content: `▶ Шаг ${item.step}: ${item.description} [\`${item.tool}\`]\n` } }]
      });
    }

    // Первая попытка выполнения плана
    let executionReport = await executePlan(plan);

    // 🔥 ЦИКЛ САМОКОРРЕКЦИИ (Self-Correction): Если план упал с ошибкой, даем агенту шанс исправиться
    if (!executionReport.success) {
      sendSSE({
        choices: [{ delta: { content: '\n⚠️ Обнаружена ошибка при выполнении. Запускаю самокоррекцию плана...\n\n' } }]
      });

      const errorContext = JSON.stringify(executionReport.steps);
      const correctionPrompt = `${getToolsSystemPrompt()}

Предыдущий план для задачи "${userMessage}" завершился ошибкой.
Отчет о выполнении шагов: ${errorContext}

Проанализируй ошибку, исправь неверные аргументы или шаги и сформируй НОВЫЙ исправленный JSON-массив плана.
Отвечай СТРОГО в формате валидного JSON-массива, без лишнего текста.`;

      const correctionResponse = await session.prompt(correctionPrompt);
      
      try {
        const jsonMatch = correctionResponse.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (jsonMatch) {
          const newPlan = JSON.parse(jsonMatch[0]);
          if (Array.isArray(newPlan) && newPlan.length > 0) {
            sendSSE({
              choices: [{ delta: { content: `🔄 Новый скорректированный план составлен (${newPlan.length} шагов). Выполняем повторно...\n\n` } }]
            });
            for (const item of newPlan) {
              sendSSE({
                choices: [{ delta: { content: `▶ (Исправление) Шаг ${item.step}: ${item.description} [\`${item.tool}\`]\n` } }]
              });
            }
            executionReport = await executePlan(newPlan);
          }
        }
      } catch (err) {
        console.error('Ошибка самокоррекции плана:', err);
      }
    }

    // Итоговый ответ по результатам выполнения
    if (executionReport.success) {
      sendSSE({
        choices: [{ delta: { content: '\n🎉 Все шаги плана успешно выполнены!\n' } }]
      });

      const summaryPrompt = `Пользователь просил: "${userMessage}". 
План выполнен успешно. Результаты: ${JSON.stringify(executionReport.steps)}. 
Дай финальный короткий ответ пользователю.`;
      
      const finalResponse = await session.prompt(summaryPrompt);
      sendSSE({
        choices: [{ delta: { content: `\n${finalResponse}\n` } }]
      });
    } else {
      sendSSE({
        choices: [{ delta: { content: '\n❌ План не удалось выполнить даже после самокоррекции.\n' } }]
      });
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('Ошибка в обработчике /v1/chat/completions:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        error: { message: error.message, type: 'internal_server_error', code: 500 }
      });
    } else {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }
});

export default router;