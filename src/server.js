import express from 'express';
import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const PORT = 3000;
const MODEL_FILE_NAME = "qwen2.5-7b-instruct-q4_k_m.gguf";
const modelPath = path.join(__dirname, '../models', MODEL_FILE_NAME);

const worker = new Worker(new URL('./worker.js', import.meta.url));
let isModelReady = false;

worker.on('message', (msg) => {
    console.log(`[Worker]: ${msg.message || msg.response || ''}`);
    if (msg.status === 'ready') {
        isModelReady = true;
    }
});

worker.postMessage({ type: 'init', modelPath });

function askWorker(type, payload) {
    return new Promise((resolve, reject) => {
        const handler = (msg) => {
            if (msg.status === 'success') {
                worker.off('message', handler);
                resolve(msg.response);
            } else if (msg.status === 'error') {
                worker.off('message', handler);
                reject(new Error(msg.message));
            }
        };
        worker.on('message', handler);
        worker.postMessage({ type, ...payload });
    });
}

app.post('/v1/chat/completions', async (req, res) => {
    if (!isModelReady) {
        return res.status(503).json({ error: { message: 'Модель загружается в GPU, подождите...' } });
    }

    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: { message: 'Неверный формат сообщений' } });
    }

    const userPrompt = messages[messages.length - 1].content;
    console.log(`\n==================================================`);
    console.log(`[Orchestrator] Получена задача: ${userPrompt}`);
    const globalStartTime = Date.now();

    try {
        // Шаг 1: Генерация плана с замером времени
        console.log(`[Orchestrator] Шаг 1: Генерация структурированного плана...`);
        const planStartTime = Date.now();

        const planPrompt = `Ты — планировщик задач. Верни ответ СТРОГО в формате JSON без какого-либо дополнительного текста, разметки markdown или пояснений. 
Структура JSON должна быть такой:
{
  "steps": [
    { "stepNumber": 1, "action": "описание первого действия" },
    { "stepNumber": 2, "action": "описание второго действия" }
  ]
}
Задача для декомпозиции: ${userPrompt}`;
        
        const planResponseRaw = await askWorker('prompt_json', {
            prompt: planPrompt
        });

        const planDuration = ((Date.now() - planStartTime) / 1000).toFixed(2);
        console.log(`[Orchestrator] План сгенерирован за ${planDuration} сек.`);

        // Очистка от markdown-оберток
        let cleanJsonStr = planResponseRaw.trim();
        if (cleanJsonStr.startsWith("```json")) {
            cleanJsonStr = cleanJsonStr.replace(/^```json/, "").replace(/```$/, "").trim();
        } else if (cleanJsonStr.startsWith("```")) {
            cleanJsonStr = cleanJsonStr.replace(/^```/, "").replace(/```$/, "").trim();
        }

        const planObj = JSON.parse(cleanJsonStr);
        console.log(`[Orchestrator] Шагов в плане: ${planObj.steps.length}`);

        // Шаг 2: Выполнение шагов с детальным таймингом
        let finalResultText = "";
        for (const step of planObj.steps) {
            console.log(`\n[Orchestrator] --- Выполнение шага 2.${step.stepNumber}: "${step.action}" ---`);
            const stepStartTime = Date.now();

            const stepPrompt = `Выполни следующее действие и выдай результат простым текстом (без JSON и кода): ${step.action}`;
            const stepResult = await askWorker('prompt', { prompt: stepPrompt });

            const stepDuration = ((Date.now() - stepStartTime) / 1000).toFixed(2);
            console.log(`[Orchestrator] Шаг 2.${step.stepNumber} выполнен за ${stepDuration} сек.`);

            finalResultText += `\n${stepResult.trim()}\n`;
        }

        const totalDuration = ((Date.now() - globalStartTime) / 1000).toFixed(2);
        console.log(`\n[Orchestrator] 🎉 Задача полностью выполнена за ${totalDuration} сек.`);
        console.log(`==================================================\n`);

        // Возвращаем результат клиенту
        res.json({
            choices: [{
                message: {
                    role: 'assistant',
                    content: finalResultText.trim()
                }
            }]
        });

    } catch (error) {
        console.error(`[Orchestrator Error]:`, error.message);
        res.status(500).json({ error: { message: error.message } });
    }
});

app.listen(PORT, () => {
    console.log(`[Server] Умный оркестратор с таймингами запущен на http://localhost:${PORT}`);
});