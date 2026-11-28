import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: parsePositiveInt(process.env.PORT, 3000),
  modelPath: process.env.MODEL_PATH
    ? path.resolve(projectRoot, process.env.MODEL_PATH)
    : path.join(projectRoot, 'models', 'qwen2.5-7b-instruct-q4_k_m.gguf'),
  gpuLayers: parsePositiveInt(process.env.GPU_LAYERS, 99),
  contextSize: parsePositiveInt(process.env.CONTEXT_SIZE, 2048),
  contextSequences: parsePositiveInt(process.env.CONTEXT_SEQUENCES, 4),
  maxSessionTurns: parsePositiveInt(process.env.MAX_SESSION_TURNS, 10)
};
