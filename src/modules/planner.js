import { initLlamaEngine } from '../core/engine.js';

export async function createPlan(userPrompt) {
    const session = await initLlamaEngine();
    
    const planningPrompt = `
Проанализируй запрос пользователя и разбей его на последовательные логические шаги для выполнения.
Ответ верни СТРОГО в формате JSON-массива строк, без лишнего текста и markdown-обертки (например: ["Шаг 1", "Шаг 2"]).

Запрос пользователя: "${userPrompt}"
    `.trim();

    const startTime = Date.now();
    const response = await session.prompt(planningPrompt);
    const duration = Date.now() - startTime;

    try {
        const cleanJson = response.replace(/```json/g, '').replace(/```/g, '').trim();
        const plan = JSON.parse(cleanJson);
        return { plan, duration };
    } catch (e) {
        // Фоллбек, если модель выдала текст вместо чистого JSON
        return { plan: [userPrompt], duration, raw: response };
    }
}