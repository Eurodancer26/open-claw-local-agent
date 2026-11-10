import { initLlamaEngine } from '../core/engine.js';

// Функция для очистки ответа от JSON-подобных оберток, если модель их подмешивает
function cleanStepOutput(output) {
    if (!output) return "";
    let cleaned = output.trim();
    
    // Если модель обернула ответ в массив строк вроде ["текст"]
    if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
        try {
            const parsed = JSON.parse(cleaned);
            if (Array.isArray(parsed)) {
                cleaned = parsed.join('\n');
            }
        } catch (e) {
            // Если не удалось распарсить как JSON, просто уберем крайние скобки и кавычки
            cleaned = cleaned.replace(/^\[\s*["']?/, '').replace(/["']?\s*\]$/, '');
        }
    }
    
    // Убираем лишние экранированные переносы строк
    cleaned = cleaned.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    
    return cleaned.trim();
}

export async function executePlan(plan, originalUserPrompt) {
    const session = await initLlamaEngine();
    const results = [];
    let totalDuration = 0;

    for (let i = 0; i < plan.length; i++) {
        const step = plan[i];
        console.log(`[Executor] Выполняется шаг ${i + 1}/${plan.length}: "${step}"`);
        
        const executionPrompt = `
            Контекст исходной задачи пользователя: "${originalUserPrompt}"

            Текущий шаг для выполнения: "${step}"

            Инструкция: Выполни этот шаг максимально конкретно. Не пиши мета-рассуждения о том, как нужно делать, не описывай процесс — дай СРАЗУ готовый результат или чистый код для этого шага. Без JSON-массивов, просто текст или код.`
        .trim();

        const startTime = Date.now();
        try {
            const rawOutput = await session.prompt(executionPrompt);
            const output = cleanStepOutput(rawOutput);
            const duration = Date.now() - startTime;
            
            results.push({ step, output, duration });
            totalDuration += duration;
        } catch (error) {
            const duration = Date.now() - startTime;
            results.push({ step, error: error.message, duration });
            totalDuration += duration;
        }
    }

    return { results, totalDuration };
}