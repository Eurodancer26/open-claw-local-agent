import { parentPort } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLlama, LlamaChatSession } from 'node-llama-cpp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let session = null;
let model = null;
let context = null;

async function initModel(modelPath) {
    try {
        parentPort.postMessage({ status: 'info', message: 'Инициализация Llama с ускорением GPU...' });
        
        const llama = await getLlama();
        
        model = await llama.loadModel({
            modelPath: path.resolve(modelPath)
        });

        context = await model.createContext({
            contextSize: 2048,
            gpuLayers: 99 // Все слои на видеокарту Intel Arc
        });

        session = new LlamaChatSession({
            contextSequence: context.getSequence()
        });

        parentPort.postMessage({ status: 'ready', message: 'Модель успешно загружена на GPU Intel Arc и готова!' });
    } catch (error) {
        parentPort.postMessage({ status: 'error', message: error.message });
    }
}

parentPort.on('message', async (msg) => {
    if (msg.type === 'init') {
        await initModel(msg.modelPath);
    } else if (msg.type === 'prompt' || msg.type === 'prompt_json') {
        if (!session) {
            parentPort.postMessage({ status: 'error', message: 'Модель еще не инициализирована!' });
            return;
        }

        try {
            const response = await session.prompt(msg.prompt, {
                temperature: 0.1,
                maxTokens: 512
            });

            parentPort.postMessage({ status: 'success', response });
        } catch (error) {
            parentPort.postMessage({ status: 'error', message: error.message });
        }
    }
});