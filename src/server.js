import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config/index.js';
import routes from './api/routes.js';
import { attachWebSocket } from './api/wsServer.js';
import { initPlugins } from './api/routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.use(routes);

if (process.argv[1] === __filename) {
  await initPlugins();
  const server = app.listen(config.port, config.host, () => {
    console.log(`Сервер запущен на http://${config.host}:${config.port}`);
    console.log(`WebSocket-транспорт: ws://${config.host}:${config.port}/v1/ws`);
  });
  // Блок 6.4: WebSocket-транспорт как альтернатива SSE.
  attachWebSocket(server, {
    getBaseUrl: () => `http://${config.host}:${config.port}`
  });
}

export default app;
