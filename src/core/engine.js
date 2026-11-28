import { getLlama, LlamaChatSession } from 'node-llama-cpp';
import { config } from '../config/index.js';

// T6: история диалога имеет ровно один источник — клиентский массив messages.
// routes.js ужимает его (pruneMessages -> buildRecentHistoryBlock) и вкладывает
// в промпт. Живая LlamaChatSession не должна накапливать ту же историю повторно,
// иначе модель видит предыдущие реплики дважды: из сессии и из блока промпта.
export function applySessionHistoryPolicy(session, { created = false, stateless = true } = {}) {
  if (!session) return false;
  if (created) return false;     // сессия только что создана — истории в ней ещё нет
  if (!stateless) return false;  // явный отказ: сессия сама хранит историю
  if (typeof session.resetChatHistory === 'function') {
    session.resetChatHistory();
    return true;
  }
  return false;
}

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

  async getSession({ forceReset = false, mode = 'strict', stateless = true } = {}) {
    await this.ensureModelLoaded();

    const normalizedMode = mode === 'free' ? 'free' : 'strict';
    const contextLimitReached = this.sessionTurnCount >= config.maxSessionTurns;

    const created =
      forceReset ||
      !this.persistentSession ||
      this.lastActiveMode !== normalizedMode ||
      contextLimitReached;

    if (created) {
      this.persistentSession = new LlamaChatSession({
        contextSequence: this.context.getSequence()
      });
      this.lastActiveMode = normalizedMode;
      this.sessionTurnCount = 0;
    } else {
      // T6: контекст диалога приходит в промпте, поэтому перед каждым
      // запросом очищаем историю сессии — учёт остаётся одинарным.
      applySessionHistoryPolicy(this.persistentSession, { created: false, stateless });
    }

    this.sessionTurnCount += 1;
    return this.persistentSession;
  }
}

const engineInstance = new LocalLlamaEngine();

export async function initLlamaEngine(options = {}) {
  return await engineInstance.getSession(options);
}