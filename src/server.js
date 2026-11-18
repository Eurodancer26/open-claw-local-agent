import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import routes from './api/routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware для обработки JSON и статики
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Подключаем API-маршруты в корень (чтобы работал путь /v1/chat/completions)[cite: 25]
app.use(routes);

// Запуск сервера с привязкой строго к локальному интерфейсу (127.0.0.1)[cite: 9, 25]
if (process.argv[1] === __filename) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Сервер запущен на http://127.0.0.1:${PORT}`);
  });
}

export default app;