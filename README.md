# AI Construct (Open-Claw Local Agent)

**AI Construct (Open-Claw Local Agent)** — полностью автономный, приватный локальный AI-агент на базе **Node.js (ES Modules)** и **`node-llama-cpp`**, построенный по паттерну **Plan & Execute** с автоматической самокоррекцией (**Self-Correction**), рекурсивной нейро-маршрутизацией запросов на CPU, персистентной памятью размышлений и трассировкой выполнения в XML.

Проект создан для полностью локальной работы без обращения к внешним облачным API, с изоляцией файловых операций в песочнице, строгим контролем контекста и сериализацией обращений к видеопамяти через кастомный GPU-мьютекс (`gpuMutex`), что делает его устойчивым на системах с ограниченным объёмом VRAM (включая **Intel Arc A580, 8 ГБ VRAM**).

---

## Содержание

- [Архитектурный пайплайн](#архитектурный-пайплайн)
- [Ключевые подсистемы](#ключевые-подсистемы)
- [Разделение промптов chat/action](#разделение-промптов-chataction)
- [Защита от contamination памяти](#защита-от-contamination-памяти)
- [Инструменты агента (Tools Registry)](#инструменты-агента-tools-registry)
- [Модель безопасности и режимы работы](#модель-безопасности-и-режимы-работы)
- [Структура репозитория](#структура-репозитория)
- [Установка и быстрый старт](#установка-и-быстрый-старт)
- [Команды разработки и тестирования](#команды-разработки-и-тестирования)
- [HTTP и SSE API](#http-и-sse-api)
- [Трассировка и XML-отчётность](#трассировка-и-xml-отчётность)
- [Roadmap (Этапы развития)](#roadmap-этапы-развития)
- [Лицензия](#лицензия)

---

## Архитектурный пайплайн

Каждый запрос пользователя проходит через многоступенчатый локальный конвейер без отправки данных за пределы машины:

```text
[Пользователь / Web UI / HTTP Client]
                │
                ▼
      POST /v1/chat/completions
                │
                ├──► 1. Захват GPU-мьютекса (gpuMutex)
                ├──► 2. Санитайзинг и обрезка истории (contextPruner.js)
                ├──► 3. CPU Нейро-маршрутизация (NeuralSkillRouter)
                │        ├── Векторизация 7 признаков + фокус длинного промта
                │        ├── Рекурсивное скрытое состояние (hiddenState[8])
                │        ├── Оценка: chat | file_ops | system_cmd
                │        └── Итоговый mode: chat | action | mixed | unknown
                ├──► 4. Загрузка опыта и антипаттернов (recursiveMind.js)
                │
                ├─── [mode=chat] ──► Текстовый промпт без правил JSON
                │                     (buildTextOnlyPrompt) ──► LLM ──► текст
                │
                ├─── [mode=action/mixed/unknown] ──► Когнитивный промпт
                          │                            (buildCognitivePrompt)
                          ▼
                          ├── LLM ──► JSON-план
                          ├── ActionRetry (1 повтор) если план не распознан
                          │
                          ▼
               7. Парсинг и восстановление JSON (planParser.js)
                          │
                          ▼
               8. Цикл исполнения (executor.js)
                  ├── Валидация аргументов ДО вызова инструмента
                  ├── Проверка безопасности путей (pathSecurity.js)
                  ├── Выполнение инструмента (toolsRegistry)
                  ├── Защита от зацикливания (Loop Guard)
                  └── При ошибке ──► Самокоррекция с userMessage
                          │
                          ▼
               9. Сохранение рефлексии (mind/) и XML-отчёта (reports/)
```

---

## Ключевые подсистемы

### 1. Рекурсивный нейро-роутер на CPU (`src/core/neuralRouter.js`)

Перед обращением к тяжёлой языковой модели запрос анализируется лёгкой рекурсивной нейросетью на чистом JavaScript (`NeuralSkillRouter`), работающей за доли миллисекунды на CPU:

* **Архитектура сети**: `7` входных вещественных признаков → `8` нейронов скрытого рекурсивного слоя (`tanh`) с матрицами `Wxh`, `Whh` и смещениями `Bh` → `3` выходных логита (`chat`, `file_ops`, `system_cmd`) с нормализацией `softmax`.
* **Вектор входных признаков (`extractFeatures`)**:
  1. `isChatOrQuestion` — приветствия, вопросы, объяснения, сравнения, вопросительные конструкции.
  2. `hasFileAction` — глаголы и существительные файловых операций.
  3. `hasPathOrExt` — относительные пути, слэши, расширения файлов, каталоги проекта.
  4. `hasSystemCmd` — системные и CLI-маркеры (`node`, `npm`, `git`, `версия`, `запусти`).
  5. `isShortReply` — короткие уточняющие реплики в ходе диалога.
  6. `hasCodeOrSymbols` — фрагменты синтаксиса, ключевые слова JS/HTML.
  7. `hasAnalysisOrTest` — задачи на аудит структуры, статистику, рефакторинг.

* **Пост-обработка результата (`mode`)**:
  После `softmax` роутер применяет детерминированные гарантии для однозначных запросов:
  * Приветствие → `chat ≥ 0.98`, `mode=chat`.
  * Чистый информационный вопрос → `chat ≥ 0.92`, `mode=chat`.
  * Короткая реплика без action-сигналов → `chat ≥ 0.92`, `mode=chat`.
  * Явное файловое действие с путём → `file_ops ≥ 0.88`, `mode=action`.
  * Явная системная команда → `system_cmd ≥ 0.88`, `mode=action`.
  * Если активно 2+ смысловых сигнала → `isBroadOrMixed=true`, `mode=mixed`.

  Возвращаемое поле `mode` — прямой сигнал для `routes.js`, позволяющий выбрать между текстовым и когнитивным промптом без ручной интерпретации `scores`.

* **Работа с длинными и составными промтами**:
  * `extractPromptFocus` выделяет смысловое ядро длинного текста (начало и конец запроса).
  * При резкой смене темы рекурсивная инерция `hiddenState` динамически ослабляется.

* **Дообучение и персистентность**: методы `trainStep`, `trainBatch`, `save()`, `load()` с валидацией размерностей (`hasValidDimensions`). Веса хранятся в `models/neural_router_weights.json` (файл в `.gitignore`, при первом запуске создаются дефолтные веса в памяти).

### 2. Устойчивый парсер планов (`src/core/planParser.js`)

Локальные квантованные модели периодически оборачивают JSON в блоки Markdown, добавляют висячие запятые, оставляют неэкранированные кавычки или возвращают «двойной JSON» (`["{\"step\":1,...}"]`). Модуль `safeParseJsonPayload` выполняет многоступенчатую очистку, а `deepUnwrapJson` рекурсивно разворачивает строки-JSON и вложенные контейнеры. `extractActionPlan` перебирает все сбалансированные `[...]` и `{...}` в ответе, возвращая первый валидный план. Неизвестные имена инструментов отбрасываются.

### 3. Исполнитель планов и самокоррекция (`src/core/executor.js`)

* **Валидация аргументов до вызова инструмента** (`validateArguments`): `writeFile` без `filePath` или `content`, `readFile` без `filePath` — ошибка выдаётся до обращения к файловой системе и триггерит самокоррекцию.
* **Нормализация шагов (`normalizeStep`)**: поддерживает как вложенный объект `arguments` / `args`, так и плоскую передачу параметров рядом с полем `tool`.
* **Защита от циклов (`Loop Guard`)**: хранит сигнатуры выполненных шагов (`tool + arguments`) и прерывает выполнение при попытке повторить идентичное действие без прогресса.
* **Цикл самокоррекции**: при ошибке (`ENOENT`, неверный путь, неизвестный инструмент) исполнитель передаёт ошибку, контекст шага и **исходный `userMessage`** в `askModelToFixStep`, получает исправленный шаг (до `maxCorrectionsPerStep = 2` попыток) и продолжает выполнение.
* **`rawOutput` vs `output`**: результат шага хранится в двух полях — `output` (для отображения в чате, с пометкой `[Исправлено через ...]`) и `rawOutput` (чистый вывод для интерполяции `{{stepN.output}}`).

### 4. Рекурсивная память и антипаттерны (`src/core/recursiveMind.js`)

* Сохраняет краткие слепки задач и сбоев в `mind/reflections/thought_<timestamp>_d<depth>.md` и обновляет стек последних 10 мыслей в `mind/state.json`.
* Ошибки и срабатывания `Loop Guard` маркируются как **`[АНТИПАТТЕРН / ОШИБКА]`**.
* **Санитайзер preview**: полные пути (`tests/sandbox/...`, `src/...`) и содержимое в кавычках заменяются на `[путь]` / `[файл]` / `[содержимое]` при показе модели — это ключевая защита от contamination (см. раздел ниже).
* **Дедупликация** — одинаковые preview отбрасываются при записи и при чтении.
* **Разбивка на секции**: ошибки идут первыми (максимум 3), успехи — только счётчиком «В памяти N успешных операций (детали намеренно скрыты)».
* **Детектор обрезанного JSON-плана**: если в тексте есть `{` / `[` и `"tool"`/`"step"`, но баланс скобок/кавычек не сходится — запись переклассифицируется как ⚠️ антипаттерн, а не как успех.
* Автоматическая ротация файлов (`MAX_REFLECTION_FILES = 30`).

### 5. Управление сессией LLM и GPU-мьютекс

* **Сериализация доступа к GPU**: `gpuMutex` гарантирует, что одновременные HTTP-запросы не вызовут гонку за контекст `node-llama-cpp`.
* **Контроль контекста**: `pruneMessages` ограничивает историю (`DEFAULT_MAX_CONTEXT_MESSAGES = 12`, `DEFAULT_MAX_CHARS_PER_MESSAGE = 2000`).
  * Лимиты памяти диалога вынесены в `contextPruner.js` (`DEFAULT_MAX_HISTORY_MESSAGES = 6`, `DEFAULT_MAX_HISTORY_CHARS = 6000`) и отдаются клиенту в `GET /v1/mind` → `dialogHistory` (клиент стартует с 12 и подхватывает серверное значение).
* **Скрытие executor-output из истории**: сообщения ассистента, содержащие `▶ Шаг`, `✔ Успешно`, `❌ Ошибка` или `✨ Готово`, заменяются на `[предыдущее выполнение завершено, детали скрыты из контекста]` — предотвращает «модель думает, что уже сделала».
* **Обрезка с учётом code fences**: при превышении `maxCharsPerMessage` блок ```` ``` ```` не разрезается пополам.

---

## Разделение промптов chat/action

Ключевая защита от галлюцинаций типа «на приветствие модель возвращает JSON» — **разные промпты для разных режимов**:

| Режим | Промпт | Что видит модель |
| :--- | :--- | :--- |
| `mode=chat` | `buildTextOnlyPrompt` | Только правило «ответь текстом». **Никаких** правил JSON, инструментов и примеров планов. |
| `mode=action / mixed / unknown` | `buildCognitivePrompt` | Каталог 8 инструментов + правила формата JSON + примеры с placeholder'ами. |
| `stream:false` | `buildNonStreamPrompt` / `buildTextOnlyPrompt` | Аналогично, но без SSE-логики. |

Дополнительно: `chatFormatter.js` содержит **жёсткий список запрещённых инструментов** (`chat`, `date`, `deploy`, `hash`, `format` и т.п.) с явной пометкой «их не существует». Это устраняет класс ошибок, когда модель выдумывала `{"tool":"chat"}`.

Если `mode=action`, но план не распарсился — выполняется **один повторный запрос** (`ActionRetry`) со строгим требованием «только JSON без markdown». Если и это не удалось — модель считает план проваленным, роутер не дообучается.

---

## Защита от contamination памяти

Классический баг маленьких моделей: она видит в памяти «успешно создал файл summary.txt» и копирует это имя в **новый** запрос пользователя, даже если тот просит другой файл. Решается тремя слоями:

1. **`recursiveMind.js` — санитайзер**: в показываемых preview пути и содержимое заменяются на `[путь]` / `[содержимое]`. Пример: `Запрос: Создай файл tests/sandbox/notes/summary.txt` → `Запрос: Создай файл [путь]`.
2. **`contextPruner.js` — скрытие executor-output**: `▶ Шаг 1...✔ Успешно` не попадают в контекст диалога.
3. **`chatFormatter.js` — правило №8**: «Используй РОВНО то, что просит пользователь. НЕ копируй конкретные значения из примеров, памяти, предыдущих ответов. Если пример показывает placeholder вида `<имя_файла_из_запроса>` — подставь туда РЕАЛЬНОЕ имя, которое указал пользователь.»

---

## Инструменты агента (Tools Registry)

Все инструменты описаны в `src/tools/registry.js`:

| Инструмент | Аргументы | Назначение |
| :--- | :--- | :--- |
| `readFile` | `{ "filePath": "..." }` | Чтение текстового файла. Проверка директории и размера (≤ 5 МБ). |
| `writeFile` | `{ "filePath": "...", "content": "..." }` | Создание/перезапись с рекурсивным созданием папок. Возвращает `filePath`, `bytesWritten`. |
| `createDir` | `{ "dirPath": "..." }` | Создание каталога (рекурсивно, как `mkdir -p`). Отказывает, если путь похож на файл. Возвращает `dirPath`, `created`. |
| `deleteFile` | `{ "filePath": "..." }` | Удаление файла. Проверка, что это не директория. |
| `listDir` | `{ "dirPath": "." }` | Список файлов и поддиректорий с типом (`dir` / `file`). |
| `analyzeProject` | `{ "dirPath": "." }` | Рекурсивный аудит: папки, файлы, строки кода, разбивка по расширениям, топ крупных файлов, `package.json`. |
| `generateUnitTest` | `{ "sourcePath": "...", "outputPath": "..." }` | Разбор экспортов модуля (`function`, стрелочные `const`, `class`, `module.exports`) и генерация `node:test`. |
| `runCommand` | `{ "commandId": "..." }` | Разрешённые команды из белого списка. Возвращает `commandId`, `exitCode`, `stdout`, `stderr`. |

### Белый список системных команд (`SAFE_COMMANDS`)

* `node-version`, `npm-version`, `dir-list`, `git-status`, `git-diff`

Все команды выполняются через `child_process.execFile` без запуска shell. Произвольные shell-строки заблокированы. На Windows `.cmd`/`.bat` (например `npm.cmd`) запускаются через `cmd.exe /c <script> <args…>` с фиксированным списком аргументов — прямой `execFile` по `.cmd` в Node отклоняется (`spawn EINVAL`).

---

## Модель безопасности и режимы работы

1. **Строгий режим песочницы (`DEFAULT_STRICT_SANDBOX = true` — замороженный дефолт)**
   * Режим выбирается на каждый запрос параметром `strictSandbox`; дефолт `true` заморожен (`Object.freeze`) и никогда не мутируется. Внутренние вызовы передают режим явно через `{ strict }`.
   * Все относительные пути автоматически изолируются внутри `tests/sandbox/`.
   * Попытки выхода (`../`, абсолютные пути, корень проекта) отклоняются на уровне `resolveSafePath` и в системных инструкциях модели.
2. **Свободный режим (`strictSandbox: false` в запросе)**
   * Доступ ко всей рабочей директории проекта.
   * Правило уточнения пути: если директория не указана — модель отвечает текстом и просит уточнить.
3. **Защита от Path Traversal и симлинков (`pathSecurity.js`)**
   * Отклонение путей с null-байтом (`\0`).
   * Отклонение абсолютных Windows (`C:\...`) и UNC (`\\server\share`) путей.
   * Проверка через `fs.realpath()` и `fs.lstat()` для блокировки симлинков за пределы песочницы.
   * Обход по дереву вверх для несуществующих файлов (`verifyNearestExistingAncestor`) с ограничением глубины.
4. **Локальная привязка сети**: HTTP-сервер на `127.0.0.1`.

---

## Структура репозитория

```text
open-claw-local-agent/
├── mind/                                 # (в .gitignore) — личная память агента
│   ├── reflections/                      #   Журнал мыслей и антипаттернов
│   └── state.json                        #   Активная цель, режим, стек последних мыслей
├── models/
│   ├── qwen2.5-7b-instruct-q4_k_m.gguf   #   Локальная GGUF-модель (не индексируется)
│   └── neural_router_weights.json        #   Веса роутера (в .gitignore, генерируются при первом save)
├── public/
│   ├── app.js                            #   Клиентская логика чата, SSE-парсер
│   ├── index.html                        #   Веб-интерфейс
│   └── style.css                         #   Тёмная тема
├── reports/                              # (в .gitignore) — XML-отчёты
│   ├── chats/
│   └── tests/
├── scripts/
│   └── full-dump.mjs                     # Упаковка кодовой базы + sandbox + reports в единый XML
├── src/
│   ├── api/
│   │   ├── chatFormatter.js              # Промпты, форматтеры результатов инструментов
│   │   ├── routes.js                     # REST/SSE маршруты, развилка mode, ActionRetry
│   │   └── streamGuard.js                # Отмена/обрыв стрима: AbortSignal, безопасный send/end
│   ├── config/
│   │   └── index.js
│   ├── core/
│   │   ├── contextPruner.js              # Обрезка истории, скрытие executor-output
│   │   ├── engine.js
│   │   ├── executor.js                   # Валидация аргументов, Loop Guard, rawOutput
│   │   ├── limits.js                     # MAX_PLAN_STEPS — единый лимит шагов плана
│   │   ├── mutex.js
│   │   ├── neuralRouter.js               # mode: chat/action/mixed/unknown
│   │   ├── planParser.js                 # deepUnwrapJson, фильтр известных tools
│   │   ├── recursiveMind.js              # Санитайзер путей, дедуп, антипаттерны
│   │   └── reporter.js                   # XML-трассировка, атомарная запись, CDATA-fix
│   ├── tools/
│   │   ├── pathSecurity.js               # Null-byte, UNC, symlink, обход предков
│   │   ├── projectScanner.js
│   │   ├── registry.js                   # 8 инструментов, каталог для промпта
│   │   └── safeCommands.js
│   └── server.js
├── tests/
│   ├── sandbox/                          # Изолированная директория (в .gitignore, кроме .gitkeep)
│   ├── free_mode/                        # Каталог свободного режима (в .gitignore, кроме .gitkeep)
│   ├── manual/                           # Ручные smoke-скрипты (вне авто-прогона node --test)
│   │   ├── chat-completions.manual.js
│   │   ├── multi-step-agent.manual.js
│   │   ├── router.manual.js
│   │   ├── sandbox-agent.manual.js
│   │   ├── self-correction.manual.js
│   │   └── stream.manual.js
│   ├── agent-loop.test.js
│   ├── analyze-project.test.js
│   ├── benchmark.js
│   ├── benchmark-clean.js
│   ├── compare-reports.js
│   ├── executor.test.js
│   ├── free-mode.test.js
│   ├── generate-unit-test.test.js
│   ├── large-benchmark.js
│   ├── plan-limits.test.js
│   ├── plan-parser-tools.test.js
│   ├── planner.test.js
│   ├── run-all.test.js
│   ├── runcommand-sandbox.test.js
│   ├── self-correction.test.js
│   ├── session-history.test.js
│   └── stream-abort.test.js
├── .editorconfig
├── .github/
│   └── workflows/
│       └── ci.yml                    # CI: npm ci + lint + test (Node 20/22)
├── .gitignore
├── .nvmrc                        # 20.19.0
├── .prettierrc.json
├── eslint.config.js               # ESLint 10 (flat config)
├── package.json
└── README.md
```

---

## Установка и быстрый старт

### Требования
* **Node.js** `20.x` или новее (ES Modules + `node:test`). Закреплено: `.nvmrc` = `20.19.0`, `engines.node` = `>=20.9.0`.
* Локальная GGUF-модель (по умолчанию `models/qwen2.5-7b-instruct-q4_k_m.gguf`).
* GPU с поддержкой Vulkan / CUDA / Metal (или CPU-режим `node-llama-cpp`).

### Шаги запуска

1. **Клонируйте репозиторий:**
   ```bash
   git clone https://github.com/Eurodancer26/open-claw-local-agent.git
   cd open-claw-local-agent
   ```

2. **Установите зависимости:**
   ```bash
   npm install
   ```

3. **Разместите GGUF-модель:**
   Поместите файл `qwen2.5-7b-instruct-q4_k_m.gguf` в директорию `models/`.

4. **Запустите сервер:**
   ```bash
   npm start
   ```
   Сервер будет доступен по адресу **`http://127.0.0.1:3000`**.

> При первом запуске `models/neural_router_weights.json` отсутствует (он в `.gitignore`). Роутер использует дефолтные веса из кода. После первого `reinforceOutcome` файл создаётся через `save()`.

---

## Команды разработки и тестирования

| Команда | Описание |
| :--- | :--- |
| `npm start` | Запуск HTTP-сервера и веб-интерфейса на `127.0.0.1:3000`. |
| `npm test` | Быстрые unit- и интеграционные тесты (без LLM) с экспортом JUnit XML в `reports/tests/test-report.xml`. |
| `npm run test:llm` | Полный прогон, включая LLM, SSE-стриминг, Plan & Execute и Self-Correction (`RUN_LLM_TESTS=true`). |
| `node tests/manual/router.manual.js` | Проверка нейро-роутера: диалоговая память, смена контекста, длинные промты, `save()/load()`. |
| `node tests/large-benchmark.js` | Нагрузочный бенчмарк (4 категории) с замером `tok/s` и Heap. |
| `node tests/compare-reports.js` | Сравнение сохранённых JSON-отчётов бенчмарков. |
| `npm run dump:full` | Упаковка кода + `tests/sandbox/` + `reports/` в единый XML (`full-project-dump.xml`). |
| `npm run lint` | ESLint 10 (flat config). Ошибки блокируют CI, предупреждения — baseline. |
| `npm run lint:fix` | ESLint с автоисправлением. |
| `npm run format` | Prettier: форматирование всех файлов. |
| `npm run format:check` | Prettier: проверка форматирования без записи. |

> **Скипнутые тесты.** 7 тестов помечены `skip` и требуют живой LLM при запущенном `npm start`: SSE-стриминг, Plan & Execute, Self-Correction, HTTP API (`run-all.test.js`, `planner.test.js`, `agent-loop.test.js`, `self-correction.test.js`, `free-mode.test.js`). Их запускает `npm run test:llm` (`RUN_LLM_TESTS=true`); в обычном `npm test` они намеренно скипаются и не считаются провалом.

> **Ручные скрипты.** `tests/manual/*.manual.js` — smoke-проверки против живого сервера (`npm start`), исключены из авто-прогона `node --test`. Запуск вручную, напр. `node tests/manual/router.manual.js`.

> **Линт и формат.** `npm run lint` использует ESLint 10 (flat config) и сейчас проходит без ошибок; остаётся ~19 предупреждений (escape-символы в regex, control-regex в sanitize, throw в finally — осознанные приёмы). `format:check` в CI не включён: он требует единоразового `npm run format` (переформат ~36 файлов — отдельное решение). CI: `.github/workflows/ci.yml` гоняет `npm ci` + `npm run lint` + `npm test` на Ubuntu, Node 20.x и 22.x.

---

## HTTP и SSE API

### `POST /v1/chat/completions`

Основной OpenAI-совместимый эндпоинт.

**Параметры тела (JSON):**
* `messages` *(Array, обязательно)* — `[{ "role": "user"|"assistant"|"system", "content": "..." }]`.
* `stream` *(Boolean, default `false`)* — SSE-стриминг.
* `strictSandbox` *(Boolean, опционально)* — переключение режима (`true` — песочница, `false` — свободный).

**Пример SSE-запроса (`stream: true`):**
```bash
curl -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "role": "user", "content": "Создай файл demo.js с функцией суммы и прочитай его" }
    ],
    "stream": true,
    "strictSandbox": true
  }'
```

Ответ — поток `text/event-stream` с пошаговым прогрессом (`▶ Шаг 1...`, `✔ Успешно...`, отчёты о самокоррекции) и маркером `data: [DONE]`.

**Пример JSON-запроса (`stream: false`):**
Возвращает стандартный `chat.completion` + поле `neural_routing` (`selectedSkill`, `confidence`, `mode`, `isBroadOrMixed`, `topSkills`, `scores`).

### `GET /v1/mind`

Возвращает текущее состояние памяти агента из `mind/state.json` (`coreGoal`, `activeDirectory`, `mode`, `thoughtStack`).

### `POST /v1/session/reset`

Сброс памяти роутера и создание новой сессии. Тело: `{ "strictSandbox": true|false }`.

---

## Трассировка и XML-отчётность

`ExecutionTracer` (`src/core/reporter.js`) протоколирует каждую сессию в структурированный XML с CDATA-секциями и экранированием:

* `reports/chats/chat_report_<SESSION_ID>.xml` — диалоги и выполненные планы.
* `reports/tests/test_report_<SESSION_ID>.xml` — тестовые прогоны.

Ограничение размера плана — единая константа `MAX_PLAN_STEPS = 128` в `src/core/limits.js`, используемая и парсером (`planParser.js`), и исполнителем (`executor.js`).

Каждый отчёт фиксирует:
* `<mode value="strict|free">` — режим (машинно-читаемый атрибут).
* `<routing mode="chat|action|mixed|unknown">` — решение роутера.
* `<promptSent>` — фактический промпт (обрезка до 30 KB).
* `<modelRawPlan>` — сырой ответ модели (обрезка до 20 KB).
* `<actions>` — выполненные шаги.
* `<sandboxSnapshot>` — снимок песочницы (до 200 файлов, до 20 KB на файл).
* `<events>` — по-событийный лог.

Атомарная запись (temp-файл + rename) предотвращает повреждение отчёта при прерывании процесса. Дополнительно: `escapeCdata` корректно обрабатывает `]]>` внутри контента; XML-невалидные control-символы и одиночные суррогаты отфильтровываются.

---

## Roadmap (Этапы развития)

### Этап 1: Базовый фундамент и изоляция безопасности — Выполнено
* [x] Локальный Express-сервер на `127.0.0.1`, веб-интерфейс с SSE.
* [x] `node-llama-cpp` + `gpuMutex` для сериализации обращений к VRAM.
* [x] `resolveSafePath` + `fs.realpath` + белый список команд через `execFile`.

### Этап 2: Агентичный цикл Plan & Execute, Self-Correction, отчётность — Выполнено
* [x] Единый контракт `stream: true/false` с переключателем режимов.
* [x] `executePlan` с `Loop Guard`, валидацией аргументов и самокоррекцией.
* [x] Персистентная память (`recursiveMind.js`) с антипаттернами и ротацией.
* [x] XML-отчёты (`ExecutionTracer`) с атомарной записью.

### Этап 3: Модульная архитектура, нейро-роутинг, расширенные инструменты — Выполнено
* [x] Декомпозиция монолитов (`chatFormatter.js`, `contextPruner.js`, `planParser.js`, `pathSecurity.js`, `projectScanner.js`, `safeCommands.js`).
* [x] `NeuralSkillRouter` с `mode` (`chat`/`action`/`mixed`/`unknown`), пост-обработкой и сохранением весов.
* [x] Расширение реестра до 8 инструментов (добавлен `createDir`).

### Этап 4: Устранение contamination и повышение надёжности — Выполнено
* [x] **Разделение промптов** `buildTextOnlyPrompt` / `buildCognitivePrompt` по `mode`. Устранён класс багов «JSON на приветствие».
* [x] **ActionRetry** — один повторный запрос при невалидном плане на `mode=action`.
* [x] **Санитайзер памяти** в `recursiveMind.js`: пути и содержимое в preview заменяются на `[путь]` / `[содержимое]`.
* [x] **Дедупликация** в памяти и скрытие executor-output в `contextPruner.js`.
* [x] **`deepUnwrapJson`** в `planParser.js` — разворот `["{...}"]` и `"{...}"` в нормальный массив шагов.
* [x] **`userMessage` в `askModelToFixStep`** — самокоррекция не теряет исходный запрос.
* [x] **`rawOutput` в `executor.js`** — интерполяция `{{stepN.output}}` не подмешивает `[Исправлено...]`.
* [x] **`pathSecurity.js`** — null-byte, UNC, Windows drive letters, глубина обхода.
* [x] **`reporter.js`** — исправлен `escapeCdata` (`]]>` без `&gt;`), атомарная запись, лимиты CDATA.
* [x] **LLM-тесты проходят** при `RUN_LLM_TESTS=true`: 9 сценариев в `tests/run-all.test.js` (`npm run test:llm`); LLM-тесты есть также в `planner.test.js`, `agent-loop.test.js`, `self-correction.test.js`. В обычном `npm test` они помечены `skip`.

### Этап 5: Дальнейшее развитие — В планах
* [ ] Инструмент безопасного поиска по кодовой базе (`searchInFiles`).
* [ ] Автоматическое дообучение роутера на подтверждённых успешных сессиях.
  * Частично реализовано: `reinforceOutcome()` вызывается в `routes.js` по факту определения навыка (онлайн-дообучение), а `trainStep`/`trainBatch`/`save`/`load` доступны в `NeuralSkillRouter`. Не хватает батч-переобучения только на подтверждённых сессиях.
* [ ] Интерактивное подтверждение опасных действий (`deleteFile`) в свободном режиме через UI.
* [ ] WebSocket как альтернатива SSE для более гибкого стриминга.
* [ ] Плагинная система инструментов (реестр загружается из `tools/*.js`).

---

## Лицензия

Проект распространяется под лицензией **MIT**. Подробности — в файле `LICENSE`.