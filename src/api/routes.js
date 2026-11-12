import { Router } from 'express';
import { initLlamaEngine } from '../core/engine.js';
import { toolsRegistry, getToolsSystemPrompt } from '../tools/registry.js';

const router = Router();

router.post('/v1/chat/completions', async (req, res) => {
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

    // Если запрошен классический JSON-ответ (stream: false)
    if (!stream) {
      // Простейший цикл выполнения для не-стримингового запроса
      const session = await engine.createSession();
      
      // Добавляем системный промпт с инструментами
      const prompt = `${getToolsSystemPrompt()}\n\nЗапрос пользователя: ${userMessage}`;
      const responseText = await session.prompt(prompt);

      return res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'local-agent-model',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: responseText.trim()
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: -1,
          completion_tokens: -1,
          total_tokens: -1
        }
      });
    }

    // Режим SSE-стриминга (stream: true) для веб-интерфейса
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendSSE = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendSSE({
      choices: [{ delta: { role: 'assistant', content: '📋 Составляю план выполнения задачи...\n' } }]
    });

    const session = await engine.createSession();
    const prompt = `${getToolsSystemPrompt()}\n\nЗапрос пользователя: ${userMessage}`;
    
    const responseText = await session.prompt(prompt);

    sendSSE({
      choices: [{ delta: { content: `\n${responseText}\n` } }]
    });

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('Ошибка в обработчике /v1/chat/completions:', error);
    
    if (!res.headersSent) {
      return res.status(500).json({
        error: {
          message: error.message,
          type: 'internal_server_error',
          code: 500
        }
      });
    } else {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }
});

export default router;