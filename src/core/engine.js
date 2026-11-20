import { getLlama, LlamaChatSession } from 'node-llama-cpp';
import { config } from '../config/index.js';

class LocalLlamaEngine {
  constructor() {
    this.llama = null;
    this.model = null;
    this.context = null;
    this.persistentSession = null;
    this.lastActiveMode = null;
    this.sessionTurnCount = 0;
    this.isInitialized = false;
  }

  async ensureModelLoaded() {
    if (this.isInitialized && this.model && this.context) {
      return;
    }

    console.log('[Engine] Инициализация среды llama.cpp...');
    this.llama = await getLlama();

    this.model = await this.llama.loadModel({
      modelPath: config.modelPath,
      gpuLayers: config.gpuLayers
    });

    this.context = await this.model.createContext({
      sequences: config.contextSequences,
      contextSize: config.contextSize
    });

    this.isInitialized = true;
    console.log(`[Engine] Модель загружена (${config.modelPath}), контекст готов.`);
  }

  async getSession({ forceReset = false, mode = 'strict' } = {}) {
    await this.ensureModelLoaded();

    const normalizedMode = mode === 'free' ? 'free' : 'strict';
    const contextLimitReached = this.sessionTurnCount >= config.maxSessionTurns;

    if (
      forceReset ||
      !this.persistentSession ||
      this.lastActiveMode !== normalizedMode ||
      contextLimitReached
    ) {
      this.persistentSession = new LlamaChatSession({
        contextSequence: this.context.getSequence()
      });
      this.lastActiveMode = normalizedMode;
      this.sessionTurnCount = 0;
    }

    this.sessionTurnCount += 1;
    return this.persistentSession;
  }
}

const engineInstance = new LocalLlamaEngine();

export async function initLlamaEngine(options = {}) {
  return await engineInstance.getSession(options);
}