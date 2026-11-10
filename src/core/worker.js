import { parentPort, workerData } from 'worker_threads';
import { initLlamaEngine, createChatSession } from './engine.js';

async function runWorker() {
    try {
        // Инициализируем модель в отдельном потоке
        await initLlamaEngine();
        const session = createChatSession();

        const prompt = workerData.prompt;
        
        // Замеряем время генерации
        const startTime = Date.now();
        const response = await session.prompt(prompt);
        const duration = Date.now() - startTime;

        // Отправляем результат обратно в главный поток
        parentPort.postMessage({
            success: true,
            response,
            duration
        });
    } catch (error) {
        parentPort.postMessage({
            success: false,
            error: error.message
        });
    }
}

runWorker();