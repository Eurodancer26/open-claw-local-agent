import express from 'express';
import { initLlamaEngine } from '../core/engine.js';
import { toolsRegistry, getToolsSystemPrompt } from '../tools/registry.js';

const router = express.Router();

/**
 * Функция очистки и форматирования ответа шага
 */
function cleanStepOutput(text) {
  if (!text) return '';
  return text
    .replace(/```(?:json|javascript|js)?\s*[\s\S]*?```/gi, '')
    .trim();
}

/**
 * Всеядный парсер вызовов инструментов (Tool Call), поддерживающий любые блоки кода
 */
function parseToolCall(text) {
  if (!text) return null;

  // 1. Ищем любые JSON-подобные структуры внутри текста или блоков кода
  const regex = /\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[\s\S]*?\}\s*\}/g;
  let match;
  
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed.tool && toolsRegistry[parsed.tool]) {
        return parsed;
      }
    } catch (e) {
      // Пытаемся исправить частые проблемы с неэкранированными переводами строк в строках JSON
      try {
        const fixedJson = match[0].replace(/[\n\r]+/g, '\\n');
        const parsed = JSON.parse(fixedJson);
        if (parsed.tool && toolsRegistry[parsed.tool]) {
          return parsed;
        }
      } catch (innerE) {
        // Продолжаем поиск
      }
    }
  }

  // 2. Дополнительная попытка распарсить весь текст после удаления маркдаун-оберток
  try {
    const stripped = text.replace(/```(?:json|javascript|js)?\s*([\s\S]*?)\s*```/gi, '$1').trim();
    if (stripped.startsWith('{') && stripped.endsWith('}')) {
      const parsed = JSON.parse(stripped);
      if (parsed.tool && toolsRegistry[parsed.tool]) {
        return parsed;
      }
    }
  } catch (e) {}

  return null;
}

/**
 * Эндпоинт чата с поддержкой SSE-стриминга, дедупликацией, Function Calling и Self-Correction
 */
router.post('/chat/completions', async (req, res) => {
  try {
    const { messages, stream } = req.body;
    
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Invalid messages array provided in request body.' });
    }

    const userPrompt = messages[messages.length - 1].content;
    const session = await initLlamaEngine();
    const startTime = Date.now();

    // 1. Фаза планирования (Planner)
    const planningPrompt = `Ты планировщик задач. Разбей задачу пользователя на логические шаги (от 2 до 3 шагов).
        ВАЖНО: Пиши план ТОЛЬКО текстовыми пунктами вида "Шаг 1: [описание]". НЕ вызывай никаких инструментов в этой фазе!
        Задача пользователя: "${userPrompt}"`;

    const planResponse = await session.prompt(planningPrompt, {
      temperature: 0.2,
      maxTokens: 256
    });

    const planText = cleanStepOutput(planResponse);
    
    const stepRegex = /(?:Шаг \d+:|^\d+\.)\s*(.+)/gm;
    const matches = [...planText.matchAll(stepRegex)];
    const stepDescriptions = matches.map(m => m[1].trim());
    const uniqueSteps = [...new Set(stepDescriptions)];
    const steps = uniqueSteps.length > 0 ? uniqueSteps : [userPrompt];

    let fullExecutionResult = `### 📋 План выполнения:\n${planText}\n\n### ⚡ Результаты выполнения:\n`;

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const initialChunk = `### 📋 План выполнения:\n${planText}\n\n### ⚡ Результаты выполнения:\n`;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: initialChunk } }] })}\n\n`);

      // Фаза выполнения шагов
      for (let i = 0; i < steps.length; i++) {
        const stepDescription = steps[i];
        const stepHeader = `\n**Шаг ${i + 1}:** ${stepDescription}\n`;
        
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: stepHeader } }] })}\n\n`);
        fullExecutionResult += stepHeader;

        const executionPrompt = `${getToolsSystemPrompt()}

        Контекст задачи: "${userPrompt}"
        Текущий шаг выполнения: "${stepDescription}"
        ИНСТРУКЦИЯ: Выполни этот конкретный шаг. Если нужен инструмент (например, создание файла через writeFile или запуск через runCommand), верни его в формате JSON внутри блока кода.`;

        const stepResponse = await session.prompt(executionPrompt, {
          temperature: 0.1,
          maxTokens: 1024
        });

        const toolCall = parseToolCall(stepResponse);
        if (toolCall) {
          const toolNotice = `\n*(Вызов инструмента: \`${toolCall.tool}\`)*\n`;
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: toolNotice } }] })}\n\n`);
          fullExecutionResult += toolNotice;

          let toolResult = await toolsRegistry[toolCall.tool].execute(toolCall.args || {});
          let resultString = `\`\`\`json\n${JSON.stringify(toolResult, null, 2)}\n\`\`\`\n`;
          
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: resultString } }] })}\n\n`);
          fullExecutionResult += resultString;

          // Цикл самопроверки (Self-Correction)
          if (toolCall.tool === 'runCommand' && (toolResult.error || toolResult.stderr)) {
            const fixPrompt = `В предыдущем шаге команда завершилась с ошибкой:\nОшибка: ${toolResult.error || ''}\nStderr: ${toolResult.stderr || ''}\n\nИсправь код или ошибку, вызвав инструмент writeFile.`;
            
            const fixResponse = await session.prompt(fixPrompt, { temperature: 0.1, maxTokens: 1024 });
            const fixToolCall = parseToolCall(fixResponse);
            
            if (fixToolCall && fixToolCall.tool === 'writeFile') {
              const fixNotice = `\n*(🔄 Самопроверка: исправляем ошибку через \`writeFile\`)*\n`;
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: fixNotice } }] })}\n\n`);
              fullExecutionResult += fixNotice;

              const fixResult = await toolsRegistry[fixToolCall.tool].execute(fixToolCall.args || {});
              const fixResultString = `\`\`\`json\n${JSON.stringify(fixResult, null, 2)}\n\`\`\`\n`;
              
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: fixResultString } }] })}\n\n`);
              fullExecutionResult += fixResultString;
            }
          }

        } else {
          const cleaned = cleanStepOutput(stepResponse);
          const codeBlock = `\`\`\`javascript\n${cleaned}\n\`\`\`\n`;
          
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: codeBlock } }] })}\n\n`);
          fullExecutionResult += codeBlock;
        }
      }

      res.write('data: [DONE]\n\n');
      return res.end();
    }

  } catch (error) {
    console.error('API Error in /v1/chat/completions:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Internal server error.' });
    } else {
      res.end();
    }
  }
});

export default router;