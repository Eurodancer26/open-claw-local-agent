import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
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
 * Инициализация синглтона LLM-движка с проверкой окружения и поддержкой мульти-последовательностей
 */
export async function initLlamaEngine() {
  if (instance) {
    return instance;
  }

  console.log('[Engine] Инициализация среды llama.cpp...');

  const modelPath = path.join(__dirname, '../../models/qwen2.5-7b-instruct-q4_k_m.gguf');

  try {
    await fs.access(modelPath);
  } catch {
    throw new Error(
      `[Engine] Критическая ошибка: Файл модели не найден по пути:\n  -> ${modelPath}\n` +
      `Пожалуйста, убедитесь, что GGUF-модель помещена в директорию models/ перед запуском сервера или тестов.`
    );
  }

  const llama = await getLlama();
  console.log(`[Engine] Загрузка модели из: ${modelPath}`);

  const model = await llama.loadModel({
    modelPath: modelPath
  });

  // Выделяем 4 последовательности в контексте для предотвращения ошибки "No sequences left"
  const context = await model.createContext({
    sequences: 4
  });

  console.log('[Engine] Модель успешно загружена, оффлоаднута на GPU и готова к работе!');

  instance = new LocalLlamaEngine(model, context);
  return instance;
}