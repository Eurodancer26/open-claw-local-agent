import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLlama, LlamaChatSession } from 'node-llama-cpp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let instance = null;

class LocalLlamaEngine {
  constructor(model, context) {
    this.model = model;
    this.context = context;
  }

  /**
   * Создание новой чат-сессии для работы с моделью
   */
  async createSession() {
    const session = new LlamaChatSession({
      contextSequence: this.context.getSequence()
    });

    return {
      async prompt(text, options = {}) {
        return await session.prompt(text, options);
      }
    };
  }
}

/**
 * Инициализация синглтона LLM-движка (защита от перегрузки VRAM)
 */
export async function initLlamaEngine() {
  if (instance) {
    return instance;
  }

  console.log('[Engine] Инициализация среды llama.cpp...');
  
  // Получаем проинициализированный экземпляр llama для текущей архитектуры
  const llama = await getLlama();

  const modelPath = path.join(__dirname, '../../models/qwen2.5-7b-instruct-q4_k_m.gguf');
  console.log(`[Engine] Загрузка модели из: ${modelPath}`);

  const model = await llama.loadModel({
    modelPath: modelPath
  });

  const context = await model.createContext();
  console.log('[Engine] Модель успешно загружена, оффлоаднута на GPU и готова к работе!');

  instance = new LocalLlamaEngine(model, context);
  return instance;
}