import { getLlama, LlamaChatSession } from 'node-llama-cpp';
import path from 'path';

class LocalLlamaEngine {
  constructor() {
    this.llama = null;
    this.model = null;
    this.context = null;
    this.persistentSession = null;
    this.isInitialized = false;
  }

  async initialize() {
    if (this.isInitialized && this.persistentSession) {
      return this.persistentSession;
    }

    console.log('[Engine] Инициализация среды llama.cpp...');
    this.llama = await getLlama();
    
    const modelPath = path.resolve(process.cwd(), 'models', 'qwen2.5-7b-instruct-q4_k_m.gguf');
    
    this.model = await this.llama.loadModel({
      modelPath: modelPath
    });

    this.context = await this.model.createContext();
    
    // Создаем ЕДИНСТВЕННУЮ постоянную сессию на весь жизненный цикл сервера
    this.persistentSession = new LlamaChatSession({
      contextSequence: this.context.getSequence()
    });

    this.isInitialized = true;
    console.log('[Engine] Модель успешно загружена, постоянная сессия в VRAM инициализирована!');
    
    return this.persistentSession;
  }

  async getSession() {
    if (!this.isInitialized || !this.persistentSession) {
      return await this.initialize();
    }
    return this.persistentSession;
  }
}

// Экспортируем синглтон движка
const engineInstance = new LocalLlamaEngine();

export async function initLlamaEngine() {
  return await engineInstance.getSession();
}