import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const config = {
    port: process.env.PORT || 3000,
    modelPath: path.join(__dirname, '../../models/qwen2.5-7b-instruct-q4_k_m.gguf'),
    gpuLayers: 99,
    contextSize: 2048,
};