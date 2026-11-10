import express from 'express';
import { config } from './config/index.js';
import { initLlamaEngine } from './core/engine.js';
import apiRouter from './api/routes.js';

const app = express();
app.use(express.json());
app.use('/v1', apiRouter);

async function startServer() {
    try {
        console.log("[Server] Предварительная инициализация модели в памяти...");
        await initLlamaEngine();

        app.listen(config.port, () => {
            console.log(`[Server] Сервер запущен на http://localhost:${config.port}`);
        });
    } catch (error) {
        console.error("[Server Error] Ошибка запуска:", error);
        process.exit(1);
    }
}

startServer();