import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Гибкий рекурсивный нейро-роутер на чистом JavaScript для CPU.
 * Ориентирован на длинные многословные промты, составные задачи,
 * смену контекста в диалоге и сохранение скрытого состояния.
 */
export class NeuralSkillRouter {
  constructor(weightsPath = 'models/neural_router_weights.json') {
    this.weightsPath = path.resolve(process.cwd(), weightsPath);

    // Направления маршрутизации
    this.skills = ['chat', 'file_ops', 'system_cmd'];

    // 7 входных признаков и 8 нейронов скрытого состояния
    this.inputSize = 7;
    this.hiddenSize = 8;

    this.hiddenState = new Array(this.hiddenSize).fill(0);

    // Веса вход -> скрытый слой [hiddenSize][inputSize]
    // Признаки:
    // 0: isChatOrQuestion (вопросы, приветствия, объяснения, рассуждения, сравнение)
    // 1: hasFileAction (создать, прочитать, записать, удалить, сохранить, файл, папка, директория, модуль)
    // 2: hasPathOrExt (пути, слэши, расширения .js/.json/.md/.css/.scss, папки src/tests/mind/models)
    // 3: hasSystemCmd (версия, node, npm, git, команда, запуск, терминал, скрипт, прогон, сборка)
    // 4: isShortReply (короткое уточнение пути/ответа — только для коротких реплик)
    // 5: hasCodeOrSymbols (код, скобки, кавычки, стрелки, синтаксис JS/HTML/SCSS/SQL)
    // 6: hasAnalysisOrTest (анализ, статистика, структура, тест, проверка, рефакторинг, разбор)
    this.Wxh = [
      [ 1.25, -0.35, -0.35, -0.40,  0.15, -0.15,  0.05], // Нейрон 0: диалог, вопросы, объяснения
      [-0.30,  1.05,  0.40, -0.55,  0.00,  0.25,  0.35], // Нейрон 1: файловые операции и модули
      [-0.25,  0.60,  0.95, -0.35,  0.15,  0.25,  0.25], // Нейрон 2: пути, расширения и каталоги
      [-0.40, -0.30,  0.05,  1.45, -0.10,  0.10,  0.15], // Нейрон 3: команды, git/node/npm, запуск
      [ 0.20,  0.10,  0.20,  0.00,  0.55,  0.05,  0.00], // Нейрон 4: короткие уточняющие реплики
      [-0.10,  0.35,  0.30,  0.10, -0.15,  0.90,  0.25], // Нейрон 5: код, разметка и символы
      [ 0.05,  0.50,  0.40,  0.10, -0.10,  0.20,  1.05], // Нейрон 6: анализ, структура, тесты, рефакторинг
      [ 0.20,  0.20,  0.15,  0.15,  0.05,  0.15,  0.20]  // Нейрон 7: интегратор контекста
    ];

    // Рекуррентные веса скрытого слоя [hiddenSize][hiddenSize]
    this.Whh = Array.from({ length: this.hiddenSize }, (_, r) =>
      Array.from({ length: this.hiddenSize }, (_, c) => (r === c ? 0.20 : 0.03))
    );

    // Выходные веса [skills.length][hiddenSize] -> ['chat', 'file_ops', 'system_cmd']
    this.Why = [
      [ 1.45, -0.55, -0.50, -0.65,  0.20, -0.20,  0.05,  0.20], // chat
      [-0.55,  1.25,  1.15, -0.65,  0.00,  0.55,  0.75,  0.10], // file_ops
      [-0.60, -0.45, -0.20,  1.70, -0.10,  0.20, -0.05,  0.15]  // system_cmd
    ];

    this.Bh = new Array(this.hiddenSize).fill(0.02);
    this.By = [0.08, 0.02, 0.00];

    // Гибкие словари паттернов для русского и технического английского
    this.patterns = {
      systemCmd:
        /(?:^|[^\p{L}\p{N}_-])(?:верси[яиюе]|node(?:js)?|npm|npx|yarn|pnpm|git(?:\s+(?:status|diff|log|branch|commit|pull|push))?|запуст[иь]|выполн[иь]|команд[ауые]?|терминал[ауе]?|консол[ьию]|скрипт[ауые]?|прогон[ауе]?|сборк[ауие]|билд|процесс[ауые]?|pm2|nginx|docker)(?=$|[^\p{L}\p{N}_-])/giu,

      chatQuestion:
        /(?:привет|здравствуй|добрый\s+(?:день|вечер|утро)|кто\s+ты|что\s+(?:ты\s+)?умеешь|как\s+дела|в\s+каком\s+режим[еу]|почему|зачем|как\s+(?:работает|устроен|лучше)|расскаж[иь]|объясн[иь]|поясн[иь]|сравни|в\s+чём\s+разниц[аа]|какая\s+(?:сегодня\s+)?дат[ау]|\?)/giu,

      fileAction:
        /(?:^|[^\p{L}\p{N}_-])(?:созда[йть]|запиш[иь]|прочита[йть]|счита[йть]|удал[иь]|сохран[иь]|измен[иь]|обнов[иь]|откро[йть]|вывед[иь]|перенес[иь]|скопиру[йть]|файл[ауые]?|файлик[ауе]?|папк[ауеио]?|директор[ияиюе]|каталог[ауе]?|модул[ьяюе]|компонент[ауые]?|заготовк[ауие]|шаблон[ауые]?)(?=$|[^\p{L}\p{N}_-])/giu,

      pathOrExt:
        /(?:\.(?:m?js|cjs|ts|tsx|jsx|json|md|txt|html|css|scss|sass|yml|yaml|xml|env|sh|sql|pdf|csv|log)\b|(?:^|[\s"'`(])(?:src|tests?|sandbox|public|mind|models|reports|dist|build|config|api|core|tools)[\\/]|(?:[\p{L}\p{N}_-]+[/\\]){1,5}[\p{L}\p{N}_.-]+)/giu,

      codeOrSymbols:
        /(?:[{}[\];]|=>|\b(?:const|let|var|function|async|await|import|export|from|class|return|if|else|switch|try|catch|throw|new|typeof)\b|<\/?[a-zA-Z0-9-]+|\.[a-zA-Z0-9_-]+\s*\()/gi,

      analysisOrTest:
        /(?:^|[^\p{L}\p{N}_-])(?:анализ[ауе]?|проанализиру[йть]|статистик[ауые]|структур[ауые]|обзор[ауе]?|аудит[ауе]?|сгенериру[йть]|напиш[иь]\s+тест|(?:unit|юнит)[-_\s]?тест[ауые]?|тестирован[ияию]|провер[ьяи]|проверк[ауие]|рефакторинг[ауе]?|разбе[йть]|оптимизиру[йть]|диагностик[ауие])(?=$|[^\p{L}\p{N}_-])/giu
    };
  }

  /**
   * Извлекает смысловое ядро длинного промта:
   * первые и последние строки/фрагменты, где чаще всего задаётся цель и путь к файлам.
   */
  extractPromptFocus(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    if (raw.length <= 500) return raw;

    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length >= 4) {
      const head = lines.slice(0, 2).join(' ');
      const tail = lines.slice(-2).join(' ');
      return `${head}\n${tail}`.slice(0, 650);
    }

    return `${raw.slice(0, 320)} ${raw.slice(-280)}`;
  }

  /**
   * Вычисляет плавный весовой сигнал [0..1] с учётом количества совпадений
   * и длины текста, чтобы длинные описания не размывали важный сигнал.
   */
  computeSignal(text, regex, { baseWeight = 0.5, stepWeight = 0.25, maxValue = 1.0, lengthNorm = 0 } = {}) {
    if (!text) return 0;
    const matches = text.match(regex);
    if (!matches || matches.length === 0) return 0;

    const rawScore = baseWeight + Math.max(0, matches.length - 1) * stepWeight;

    let lengthFactor = 1;
    if (lengthNorm > 0 && text.length > lengthNorm) {
      const ratio = lengthNorm / text.length;
      lengthFactor = Math.max(0.7, Math.min(1, 0.7 + 0.3 * ratio));
    }

    return Number(Math.min(maxValue, rawScore * lengthFactor).toFixed(3));
  }

  /**
   * Преобразует текст пользователя в вектор из 7 вещественных признаков [0..1].
   */
  extractFeatures(text) {
    const fullText = String(text || '').trim();
    if (!fullText) {
      return new Array(this.inputSize).fill(0);
    }

    const focusText = this.extractPromptFocus(fullText);

    const cmdFocus = this.computeSignal(focusText, this.patterns.systemCmd, {
      baseWeight: 0.75,
      stepWeight: 0.25,
      maxValue: 1.0
    });
    const cmdFull = this.computeSignal(fullText, this.patterns.systemCmd, {
      baseWeight: 0.6,
      stepWeight: 0.2,
      maxValue: 0.95,
      lengthNorm: 800
    });
    const hasSystemCmd = Number(Math.max(cmdFocus, cmdFull * 0.95).toFixed(3));

    const chatFocus = this.computeSignal(focusText, this.patterns.chatQuestion, {
      baseWeight: 0.65,
      stepWeight: 0.25,
      maxValue: 1.0
    });
    const hasQuestionMark = fullText.includes('?') ? 0.25 : 0;
    const isChatOrQuestion = Number(Math.min(1, Math.max(chatFocus, hasQuestionMark)).toFixed(3));

    const fileFocus = this.computeSignal(focusText, this.patterns.fileAction, {
      baseWeight: 0.55,
      stepWeight: 0.25,
      maxValue: 1.0
    });
    const fileFull = this.computeSignal(fullText, this.patterns.fileAction, {
      baseWeight: 0.45,
      stepWeight: 0.2,
      maxValue: 0.95,
      lengthNorm: 900
    });
    const hasFileAction = Number(Math.max(fileFocus, fileFull * 0.95).toFixed(3));

    const hasPathOrExt = this.computeSignal(fullText, this.patterns.pathOrExt, {
      baseWeight: 0.6,
      stepWeight: 0.25,
      maxValue: 1.0
    });

    const isShortReply =
      fullText.length > 0 &&
      fullText.length < 65 &&
      !fullText.includes('\n') &&
      isChatOrQuestion < 0.5 &&
      hasSystemCmd < 0.5
        ? 0.75
        : 0;

    const hasCodeOrSymbols = this.computeSignal(fullText, this.patterns.codeOrSymbols, {
      baseWeight: 0.45,
      stepWeight: 0.2,
      maxValue: 1.0
    });

    const analysisFocus = this.computeSignal(focusText, this.patterns.analysisOrTest, {
      baseWeight: 0.6,
      stepWeight: 0.25,
      maxValue: 1.0
    });
    const analysisFull = this.computeSignal(fullText, this.patterns.analysisOrTest, {
      baseWeight: 0.5,
      stepWeight: 0.2,
      maxValue: 0.95,
      lengthNorm: 900
    });
    const hasAnalysisOrTest = Number(Math.max(analysisFocus, analysisFull * 0.95).toFixed(3));

    return [
      isChatOrQuestion,
      hasFileAction,
      hasPathOrExt,
      hasSystemCmd,
      isShortReply,
      hasCodeOrSymbols,
      hasAnalysisOrTest
    ];
  }

  softmax(logits) {
    const maxLogit = Math.max(...logits);
    const exps = logits.map((v) => Math.exp(v - maxLogit));
    const sumExps = exps.reduce((a, b) => a + b, 0);
    return exps.map((v) => Number((v / sumExps).toFixed(4)));
  }

  predict(userText) {
    const rawText = String(userText || '').trim();
    const input = this.extractFeatures(rawText);

    // При явной смене темы (чёткая системная команда или чистый диалог без файлов/путей)
    // ослабляем старую рекурсивную инерцию, чтобы прошлый шаг не перетягивал ответ
    const clearTopicShift =
      input[3] >= 0.7 ||
      (input[0] >= 0.65 && input[1] === 0 && input[2] === 0);
    const prevHidden = clearTopicShift
      ? this.hiddenState.map((v) => v * 0.55)
      : this.hiddenState;

    const nextHidden = new Array(this.hiddenSize).fill(0);

    for (let i = 0; i < this.hiddenSize; i++) {
      let sum = this.Bh[i];

      for (let j = 0; j < this.inputSize; j++) {
        sum += this.Wxh[i][j] * input[j];
      }

      for (let j = 0; j < this.hiddenSize; j++) {
        sum += this.Whh[i][j] * prevHidden[j];
      }

      nextHidden[i] = Math.tanh(sum);
    }

    this.hiddenState = nextHidden;

    const logits = new Array(this.skills.length).fill(0);
    for (let k = 0; k < this.skills.length; k++) {
      let sum = this.By[k];
      for (let i = 0; i < this.hiddenSize; i++) {
        sum += this.Why[k][i] * this.hiddenState[i];
      }
      logits[k] = sum;
    }

    const probabilities = this.softmax(logits);

    const ranked = this.skills
      .map((skill, idx) => ({ skill, score: probabilities[idx] }))
      .sort((a, b) => b.score - a.score);

    const best = ranked[0];
    const second = ranked[1] || { score: 0 };

    const activeSignalsCount = [
      input[0] >= 0.5,
      input[1] >= 0.45 || input[2] >= 0.6 || input[6] >= 0.5,
      input[3] >= 0.5
    ].filter(Boolean).length;

    const isLongPrompt = rawText.length > 220;
    const isBroadOrMixed =
      activeSignalsCount > 1 ||
      best.score < 0.56 ||
      (isLongPrompt && best.score - second.score < 0.22);

    return {
      selectedSkill: best.skill,
      confidence: best.score,
      isBroadOrMixed,
      topSkills: ranked,
      scores: {
        chat: probabilities[0],
        file_ops: probabilities[1],
        system_cmd: probabilities[2]
      },
      features: input,
      memorySnapshot: this.hiddenState.map((n) => Number(n.toFixed(3)))
    };
  }

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

  trainBatch(samples, epochs = 3, learningRate = 0.04) {
    if (!Array.isArray(samples) || samples.length === 0) return;

    for (let epoch = 0; epoch < epochs; epoch++) {
      for (const item of samples) {
        if (item && typeof item.text === 'string' && typeof item.skill === 'string') {
          this.trainStep(item.text, item.skill, learningRate);
        }
      }
    }
  }

  resetMemory() {
    this.hiddenState = new Array(this.hiddenSize).fill(0);
  }

  async save() {
    const payload = {
      inputSize: this.inputSize,
      hiddenSize: this.hiddenSize,
      Wxh: this.Wxh,
      Whh: this.Whh,
      Why: this.Why,
      Bh: this.Bh,
      By: this.By
    };
    await fs.mkdir(path.dirname(this.weightsPath), { recursive: true });
    await fs.writeFile(this.weightsPath, JSON.stringify(payload, null, 2), 'utf8');
  }

  hasValidDimensions(data) {
    if (!data || !Array.isArray(data.Wxh) || !Array.isArray(data.Whh) || !Array.isArray(data.Why)) {
      return false;
    }
    const h = this.hiddenSize;
    const x = this.inputSize;
    const s = this.skills.length;

    return (
      data.Wxh.length === h &&
      data.Wxh.every((row) => Array.isArray(row) && row.length === x) &&
      data.Whh.length === h &&
      data.Whh.every((row) => Array.isArray(row) && row.length === h) &&
      data.Why.length === s &&
      data.Why.every((row) => Array.isArray(row) && row.length === h)
    );
  }

  async load() {
    try {
      const raw = await fs.readFile(this.weightsPath, 'utf8');
      const data = JSON.parse(raw);
      if (this.hasValidDimensions(data)) {
        this.Wxh = data.Wxh;
        this.Whh = data.Whh;
        this.Why = data.Why;
        this.Bh = Array.isArray(data.Bh) && data.Bh.length === this.hiddenSize ? data.Bh : this.Bh;
        this.By = Array.isArray(data.By) && data.By.length === this.skills.length ? data.By : this.By;
      }
    } catch (_) {
      // Используем стандартные веса по умолчанию
    }
  }
}