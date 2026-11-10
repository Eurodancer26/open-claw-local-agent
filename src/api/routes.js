import express from 'express';
import { createPlan } from '../modules/planner.js';
import { executePlan } from '../modules/executor.js';

const router = express.Router();

router.post('/chat/completions', async (req, res) => {
    try {
        const { messages } = req.body;
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: "Неверный формат запроса. Ожидается массив messages." });
        }

        const userMessage = messages[messages.length - 1].content;
        console.log(`[API] Получен запрос: "${userMessage}"`);

        const totalStartTime = Date.now();

        // Шаг 1: План
        console.log(`[API] Фаза 1: Генерация плана...`);
        const planResult = await createPlan(userMessage);

        // Шаг 2: Выполнение
        console.log(`[API] Фаза 2: Выполнение шагов...`);
        const executionResult = await executePlan(planResult.plan, userMessage);

        const totalDuration = Date.now() - totalStartTime;

        let finalOutput = `### 📋 План выполнения:\n`;
        planResult.plan.forEach((step, idx) => {
            finalOutput += `${idx + 1}. ${step}\n`;
        });
        
        finalOutput += `\n### ⚡ Результаты выполнения:\n`;
        executionResult.results.forEach((resItem, idx) => {
            finalOutput += `\n**Шаг ${idx + 1}:** ${resItem.step}\n`;
            finalOutput += `${resItem.output || resItem.error}\n`;
        });

        res.json({
            id: "chatcmpl-" + Date.now(),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "qwen-2.5-7b-instruct",
            choices: [{
                index: 0,
                message: { role: "assistant", content: finalOutput },
                finish_reason: "stop"
            }],
            usage: { total_duration_ms: totalDuration }
        });

    } catch (error) {
        console.error("[API Error]", error);
        res.status(500).json({ error: error.message });
    }
});

export default router;