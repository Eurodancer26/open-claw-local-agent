import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Простая и прозрачная рекурсивная нейро-ячейка на чистом JavaScript.
 * Работает на CPU за доли миллисекунды, не нагружая видеокарту.
 */
export class NeuralSkillRouter {
  constructor(weightsPath = 'models/neural_router_weights.json') {
    this.weightsPath = path.resolve(process.cwd(), weightsPath);

    // Наши 3 базовых направления (класса/скила), между которыми выбирает сеть
    this.skills = ['chat', 'file_ops', 'system_cmd'];

    // Размер входного вектора (6 понятных признаков из текста) и размер скрытой памяти
    this.inputSize = 6;
    this.hiddenSize = 6;

    // Скрытое состояние сети (рекурсивная память — помнит контекст прошлых шагов)
    this.hiddenState = new Array(this.hiddenSize).fill(0);

    // Стартовые осмысленные веса (чтобы сеть сразу работала из коробки, а не гадала вслепую)
    // Строки — нейроны памяти, столбцы — входные признаки
    this.Wxh = [
      [ 0.9, -0.3, -0.3,  0.1,  0.2, -0.2], // Нейрон 0: реагирует на вопросы и приветствия
      [-0.2,  0.9,  0.1,  0.4, -0.1,  0.3], // Нейрон 1: реагирует на глаголы действий с файлами
      [-0.2,  0.5,  0.1,  0.9,  0.0,  0.4], // Нейрон 2: реагирует на расширения файлов и пути
      [-0.3,  0.1,  0.9,  0.0,  0.3,  0.2], // Нейрон 3: реагирует на системные команды
      [ 0.3,  0.2,  0.2,  0.2,  0.5,  0.1], // Нейрон 4: общий контекст диалога
      [-0.1,  0.4,  0.3,  0.5, -0.2,  0.8]  // Нейрон 5: наличие технических символов / JSON / скобок
    ];

    // Рекуррентные веса (как прошлое состояние памяти влияет на текущее)
    this.Whh = [
      [ 0.35, -0.10, -0.10,  0.05,  0.10, -0.05],
      [-0.10,  0.40,  0.05,  0.15,  0.05,  0.10],
      [-0.10,  0.15,  0.35,  0.10,  0.05,  0.10],
      [-0.10,  0.05,  0.05,  0.40,  0.05,  0.05],
      [ 0.10,  0.10,  0.10,  0.10,  0.30,  0.05],
      [-0.05,  0.10,  0.15,  0.05,  0.05,  0.35]
    ];

    // Выходные веса: переводят состояние 6 нейронов памяти в 3 скила ['chat', 'file_ops', 'system_cmd']
    this.Why = [
      [ 1.2, -0.6, -0.6, -0.5,  0.4, -0.4], // Итоговый балл для 'chat'
      [-0.6,  1.1,  1.1, -0.3,  0.2,  0.6], // Итоговый балл для 'file_ops'
      [-0.6, -0.3, -0.2,  1.3,  0.2,  0.3]  // Итоговый балл для 'system_cmd'
    ];

    // Смещения (базовый порог срабатывания)
    this.Bh = [0.05, 0.0, 0.0, 0.0, 0.05, 0.0];
    this.By = [0.1, 0.0, -0.1];
  }

  /**
   * Превращает обычный текст пользователя в массив из 6 чисел (от 0 до 1).
   * Это "глаза" нашей мини-сети.
   */
  extractFeatures(text) {
    const lower = (text || '').toLowerCase().trim();

    // Признак 0: Похоже на вопрос или приветствие?
    const isChatOrQuestion = /(привет|кто ты|как дела|режим|почему|дата|время|погода|расскажи|что умеешь|\?)/i.test(lower) ? 1 : 0;

    // Признак 1: Есть глаголы работы с файлами?
    const hasFileAction = /(создай|запиши|прочитай|удали|сохрани|измени|открой|покажи файл|файл|папк)/i.test(lower) ? 1 : 0;

    // Признак 2: Есть пути или расширения файлов (.js, .json, .txt, / и \)?
    const hasPathOrExt = /(\.[a-z0-9]{1,5}\b|[\\/]|sandbox|free_mode|tests)/i.test(lower) ? 1 : 0;

    // Признак 3: Есть упоминание системных команд?
    const hasSystemCmd = /(верси|node|npm|директори|список файлов|команд|терминал|dir|ls)/i.test(lower) ? 1 : 0;

    // Признак 4: Короткий ответ-уточнение (например, пользователь просто прислал путь после вопроса агента)
    const isShortReply = lower.length > 0 && lower.length < 60 && !isChatOrQuestion ? 1 : 0;

    // Признак 5: Есть код, JSON или спецсимволы?
    const hasCodeOrSymbols = /([{}[\]"'=;]|const |let |function |import )/i.test(lower) ? 1 : 0;

    return [
      isChatOrQuestion,
      hasFileAction,
      hasPathOrExt,
      hasSystemCmd,
      isShortReply,
      hasCodeOrSymbols
    ];
  }

  /**
   * Softmax превращает сырые баллы в красивые проценты (вероятности, сумма которых равна 1.0)
   */
  softmax(logits) {
    const maxLogit = Math.max(...logits);
    const exps = logits.map(v => Math.exp(v - maxLogit));
    const sumExps = exps.reduce((a, b) => a + b, 0);
    return exps.map(v => Number((v / sumExps).toFixed(4)));
  }

  /**
   * Главный шаг работы сети (Forward Pass):
   * Принимает текст, смешивает с рекурсивной памятью и возвращает решение.
   */
  predict(userText) {
    const input = this.extractFeatures(userText);
    const nextHidden = new Array(this.hiddenSize).fill(0);

    // 1. Считаем новое состояние каждого нейрона с учётом текущего входа И прошлой памяти
    for (let i = 0; i < this.hiddenSize; i++) {
      let sum = this.Bh[i];

      for (let j = 0; j < this.inputSize; j++) {
        sum += this.Wxh[i][j] * input[j];
      }

      for (let j = 0; j < this.hiddenSize; j++) {
        sum += this.Whh[i][j] * this.hiddenState[j];
      }

      // Сжимаем результат в диапазон [-1, 1], чтобы числа не взрывались
      nextHidden[i] = Math.tanh(sum);
    }

    // Обновляем рекурсивную память (теперь сеть помнит этот шаг для следующего запроса!)
    this.hiddenState = nextHidden;

    // 2. Считаем итоговые баллы для каждого из 3 скилов
    const logits = new Array(this.skills.length).fill(0);
    for (let k = 0; k < this.skills.length; k++) {
      let sum = this.By[k];
      for (let i = 0; i < this.hiddenSize; i++) {
        sum += this.Why[k][i] * this.hiddenState[i];
      }
      logits[k] = sum;
    }

    const probabilities = this.softmax(logits);

    // Находим победителя
    let bestIndex = 0;
    for (let k = 1; k < probabilities.length; k++) {
      if (probabilities[k] > probabilities[bestIndex]) {
        bestIndex = k;
      }
    }

    return {
      selectedSkill: this.skills[bestIndex],
      confidence: probabilities[bestIndex],
      scores: {
        chat: probabilities[0],
        file_ops: probabilities[1],
        system_cmd: probabilities[2]
      },
      features: input,
      memorySnapshot: this.hiddenState.map(n => Number(n.toFixed(3)))
    };
  }

  /**
   * Простое дообучение (подкрутка выходных весов), если мы хотим закрепить правильный выбор скила
   */
  trainStep(userText, targetSkill, learningRate = 0.05) {
    const targetIndex = this.skills.indexOf(targetSkill);
    if (targetIndex === -1) return null;

    const prediction = this.predict(userText);
    const probs = [prediction.scores.chat, prediction.scores.file_ops, prediction.scores.system_cmd];

    for (let k = 0; k < this.skills.length; k++) {
      const targetVal = k === targetIndex ? 1 : 0;
      const error = targetVal - probs[k];

      this.By[k] += learningRate * error;
      for (let i = 0; i < this.hiddenSize; i++) {
        this.Why[k][i] += learningRate * error * this.hiddenState[i];
      }
    }

    return this.predict(userText);
  }

  /**
   * Сброс кратковременной рекурсивной памяти (например, при смене режима или новом диалоге)
   */
  resetMemory() {
    this.hiddenState = new Array(this.hiddenSize).fill(0);
  }

  /**
   * Сохранение обученных весов на диск
   */
  async save() {
    const payload = {
      Wxh: this.Wxh,
      Whh: this.Whh,
      Why: this.Why,
      Bh: this.Bh,
      By: this.By
    };
    await fs.mkdir(path.dirname(this.weightsPath), { recursive: true });
    await fs.writeFile(this.weightsPath, JSON.stringify(payload, null, 2), 'utf8');
  }

  /**
   * Загрузка весов с диска
   */
  async load() {
    try {
      const raw = await fs.readFile(this.weightsPath, 'utf8');
      const data = JSON.parse(raw);
      if (data.Wxh && data.Whh && data.Why) {
        this.Wxh = data.Wxh;
        this.Whh = data.Whh;
        this.Why = data.Why;
        this.Bh = data.Bh || this.Bh;
        this.By = data.By || this.By;
      }
    } catch (_) {
      // Работаем на встроенных стартовых весах
    }
  }
}