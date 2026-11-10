import { getLlama, LlamaChatSession } from "node-llama-cpp";
import { config } from "../config/index.js";

let llama = null;
let model = null;
let context = null;
let session = null;

export async function initLlamaEngine() {
    if (session) return session;

    console.log(`[Engine] Инициализация среды llama.cpp...`);
    llama = await getLlama();

    console.log(`[Engine] Загрузка модели из: ${config.modelPath}`);
    model = await llama.loadModel({
        modelPath: config.modelPath,
        gpuLayers: config.gpuLayers
    });

    context = await model.createContext({
        contextSize: config.contextSize
    });

    // Создаем сессию с дефолтной последовательностью контекста
    session = new LlamaChatSession({
        contextSequence: context.getSequence()
    });

    console.log("[Engine] Модель успешно загружена, оффлоаднута на GPU и готова к работе!");
    
    return session;
}