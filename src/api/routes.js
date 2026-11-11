import express from 'express';
import { initLlamaEngine } from '../core/engine.js';

const router = express.Router();

/**
 * Функция очистки и форматирования ответа шага (cleanStepOutput)
 */
function cleanStepOutput(text) {
  if (!text) return '';
  return text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
}

/**
 * Пайплайн Plan & Execute на базе синглтон-сессии llama.cpp с дедупликацией шагов
 */
async function runPlanAndExecute(userPrompt) {
  const session = await initLlamaEngine();

  // 1. Фаза планирования (Planner)
  const planningPrompt = `Разбей следующую задачу на логические шаги (от 3 до 5 шагов). Нумеруй их как "Шаг 1:", "Шаг 2:" и т.д.
Задача пользователя: "${userPrompt}"`;

  const planResponse = await session.prompt(planningPrompt, {
    temperature: 0.3,
    maxTokens: 512
  });

  const planText = cleanStepOutput(planResponse);

  // Извлекаем шаги из плана и убираем возможные дубликаты
  const stepMatches = planText.match(/(?:Шаг \d+:|^\d+\.)\s*(.+)/gm) || [];
  const uniqueSteps = [...new Set(stepMatches.map(s => s.trim()))];
  const steps = uniqueSteps.length > 0 ? uniqueSteps : [userPrompt];

  let fullExecutionResult = `### 📋 План выполнения:\n${planText}\n\n### ⚡ Результаты выполнения:\n`;

  // 2. Фаза выполнения (Executor)
  for (let i = 0; i < steps.length; i++) {
    const stepDescription = steps[i];
    
    const executionPrompt = `Контекст задачи: "${userPrompt}"
Текущий шаг выполнения: "${stepDescription}"
Инструкция: Напиши готовый результат или чистый код для этого шага. Избегай лишних вводных слов.`;

    const stepResponse = await session.prompt(executionPrompt, {
      temperature: 0.2,
      maxTokens: 1024
    });

    const cleanedContent = cleanStepOutput(stepResponse);

    fullExecutionResult += `\n**Шаг ${i + 1}:** ${stepDescription}\n\`\`\`javascript\n${cleanedContent}\n\`\`\`\n`;
  }

  return fullExecutionResult;
}

// Путь '/chat/completions', так как в server.js подключен префикс '/v1'
router.post('/chat/completions', async (req, res) => {
  try {
    const { messages } = req.body;
    
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Invalid messages array provided in request body.' });
    }

    const userPrompt = messages[messages.length - 1].content;
    const startTime = Date.now();

    // Запуск встроенного пайплайна с дедупликацией
    const resultText = await runPlanAndExecute(userPrompt);

    const endTime = Date.now();
    const totalTimeMs = endTime - startTime;

    // Расчет метрик токенов для бенчмарка (1 токен ~= 4 символа)
    const estimatedTokens = Math.round(resultText.length / 4);
    const tokensPerSecond = totalTimeMs > 0 ? parseFloat((estimatedTokens / (totalTimeMs / 1000)).toFixed(2)) : 0;

    res.json({
      choices: [
        {
          message: {
            role: 'assistant',
            content: resultText
          }
        }
      ],
      usage: {
        completion_tokens: estimatedTokens,
        total_time_ms: totalTimeMs,
        tokens_per_second: tokensPerSecond
      }
    });

  } catch (error) {
    console.error('API Error in /v1/chat/completions:', error);
    res.status(500).json({ 
      error: error.message || 'Internal server error during orchestrator execution.' 
    });
  }
});

export default router;