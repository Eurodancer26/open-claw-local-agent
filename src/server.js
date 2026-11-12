import express from 'express';
import path from 'path';
import apiRoutes from './api/routes.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware для работы с JSON
app.use(express.json());

// Раздача статических файлов веб-интерфейса («Vibecoder UI») из папки public
app.use(express.static(path.join(process.cwd(), 'public')));

// Подключаем API роуты совместимости с OpenAI
app.use('/v1', apiRoutes);

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
  console.log(`🌐 Веб-интерфейс доступен в браузере по адресу http://localhost:${PORT}`);
});