import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config/index.js';
import routes from './api/routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.use(routes);

if (process.argv[1] === __filename) {
  app.listen(config.port, config.host, () => {
    console.log(`Сервер запущен на http://${config.host}:${config.port}`);
  });
}

export default app;