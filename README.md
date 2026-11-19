# AI Construct (Open-Claw Local Agent)

**AI Construct (Open-Claw Local Agent)** — это полностью автономный, приватный локальный AI-агент на базе Node.js (ESM) и `node-llama-cpp`, спроектированный по паттерну **Plan & Execute** с поддержкой автоматической самокоррекции (**Self-Correction**), гибридной маршрутизацией запросов на CPU, рекурсивной памятью размышлений и генерацией структурированных XML-отчётов.

Система оптимизирована для работы на локальном оборудовании с ограничением по VRAM (включая **Intel Arc A580, 8 ГБ VRAM**) с защитой от конкурентного доступа через кастомный GPU-мьютекс (`gpuMutex`) и без отправки данных во внешние облачные сервисы.

## Архитектурная концепция

1. **Нейро-маршрутизация на CPU (`NeuralSkillRouter`)**: Лёгкая рекурсивная нейро-ячейка на чистом JavaScript с сохранением скрытого состояния (`hiddenState`). Быстро определяет направление запроса (`chat`, `file_ops`, `system_cmd`) до обращения к модели.

2. **Планирование (Plan)**: Разбор задачи на последовательность шагов в формате JSON с нормализацией шагов (`normalizeStep`) и устойчивым парсером (`safeParseJsonPayload`).

3. **Выполнение (Execute)**: Безопасное выполнение действий через `toolsRegistry` (`readFile`, `writeFile`, `deleteFile`, `listDir`, `runCommand`) с защитой от зацикливания (`Loop Guard`) и отслеживанием повторяющихся сигнатур.

4. **Самокоррекция (Self-Correction)**: При ошибке выполнения шага (например, `ENOENT`) запрашивается исправление у модели (`askModelToFixStep`) и фиксируется статус исправления.

5. **Рекурсивная память и XML-трассировка**: Сохранение мыслей и антипаттернов в `mind/reflections/` и `mind/state.json` с ротацией старых файлов (`MAX_REFLECTION_FILES = 30`), а также запись сводных XML-отчётов через `ExecutionTracer` в `reports/tests/` и `reports/chats/`.

## Фактическая структура проекта

```
open-claw-local-agent/
├── mind/
│   ├── reflections/                      # Файлы рефлексий и антипаттернов (автоочистка до 30 файлов)
│   └── state.json                        # Текущее состояние цели, режима и стек мыслей
├── models/
│   ├── qwen2.5-7b-instruct-q4_k_m.gguf   # Локальная GGUF-модель (игнорируется Git)
│   └── neural_router_weights.json        # Веса нейро-роутера
├── public/
│   ├── app.js                            # Клиентская логика чата, SSE-стриминга и переключателя режима
│   ├── index.html                        # Веб-интерфейс
│   └── style.css                         # Стили интерфейса
├── reports/
│   ├── chats/                            # Сводные XML-отчёты сессий чата (игнорируется Git)
│   └── tests/                            # Сводные XML-отчёты прогонов тестов (игнорируется Git)
├── src/
│   ├── api/
│   │   └── routes.js                     # Маршруты Express, SSE/JSON контракты, Context Pruning, Self-Correction
│   ├── config/
│   │   └── index.js                      # Конфигурация порта и пути к модели
│   ├── core/
│   │   ├── engine.js                     # Синглтон локального LLM-движка
│   │   ├── executor.js                   # Исполнитель планов с самокоррекцией и защитой от циклов
│   │   ├── mutex.js                      # Мьютекс доступа к GPU
│   │   ├── neuralRouter.js               # Рекурсивный нейро-роутер на CPU
│   │   ├── recursiveMind.js              # Рекурсивная память, антипаттерны и ротация рефлексий
│   │   └── reporter.js                   # Трассировщик выполнения и генератор XML-отчётов
│   ├── tools/
│   │   └── registry.js                   # Инструменты и проверка путей в песочнице / проекте
│   └── server.js                         # Точка входа HTTP-сервера Express
├── tests/
│   ├── sandbox/                          # Песочница для тестов файловых операций
│   ├── agent-loop.test.js                # Сквозной SSE-тест агентичного цикла Plan & Execute
│   ├── executor.test.js                  # Тесты исполнителя планов
│   ├── planner.test.js                   # Тесты планировщика
│   ├── run-all.test.js                   # Основной набор тестов безопасности, API, SSE и LLM
│   ├── self-correction.test.js           # Сквозной тест самокоррекции
│   └── test-router.js                    # Проверка рекурсивного нейро-роутера
├── .gitignore
├── package.json
└── README.md

```

## Безопасность, режимы работы и изоляция (Sandbox)

* **Строгий режим песочницы (`strictDefault: true`)**: Файловые операции изолированы в `tests/sandbox/`.

* **Свободный режим (`strictDefault: false`)**: Разрешена работа в пределах рабочей директории проекта; при неполном запросе без пути агент уточняет папку у пользователя.

* **Проверка путей и симлинков (`resolveSafePath`)**: Проверка относительных путей через `path.relative()`, контроль реальных путей через `fs.realpath` и проверка ближайшего существующего родителя (`verifyNearestExistingAncestor`).

* **Белый список команд (`SAFE_COMMANDS`)**: Запуск через `execFile` без вызова shell для `node-version`, `npm-version`, `dir-list`, `git-status` и `git-diff`.

* **Контроль контекста и GPU**: Ограничение длины и числа сообщений (`pruneMessages`), обновление сессии при смене режима или достижении лимита ходов, сериализация обращений к модели через `gpuMutex`.

## Технологический стек

* **Runtime**: Node.js (ES Modules)

* **Web Server**: Express

* **Inference Engine**: `node-llama-cpp`

* **Neural Routing**: `NeuralSkillRouter` (чистый JavaScript на CPU)

* **Validation**: `zod`

* **Testing Framework**: Встроенный раннер `node:test` и `node:assert/strict`

## Установка и запуск

1. **Клонируйте репозиторий и перейдите в директорию проекта:**

   ```
   git clone https://github.com/Eurodancer26/open-claw-local-agent.git
   cd open-claw-local-agent
   
   ```

2. **Установите зависимости:**

   ```
   npm install
   
   ```

3. **Поместите локальную GGUF-модель** (например, `qwen2.5-7b-instruct-q4_k_m.gguf`) в каталог `models/`.

4. **Запустите сервер:**

   ```
   npm start
   
   ```

5. **Откройте веб-интерфейс:**
   `http://127.0.0.1:3000` (или `http://localhost:3000`).

## Команды и тестирование

* **Запуск сервера:**

  ```
  npm start
  
  ```

* **Быстрые тесты (без запуска тяжёлых LLM-кейсов):**

  ```
  npm test
  
  ```

* **Полный сквозной прогон на модели:**

  ```
  npm run test:llm
  
  ```

* **Тест рекурсивного нейро-роутера:**

  ```
  node tests/test-router.js
  
  ```

* **Дамп репозитория через Repomix:**

  ```
  npm run dump
  
  ```

## API Контракт

Эндпоинт `POST /v1/chat/completions`:

* **`"stream": true`**: Потоковый ответ по SSE (`text/event-stream`) с ходом выполнения плана, самокоррекции и завершением `data: [DONE]`.

* **`"stream": false`**: Стандартный JSON-ответ формата `chat.completion`.

Дополнительно доступен эндпоинт `GET /v1/mind` для чтения текущего состояния памяти агента.

## Roadmap (План развития)

### Этап 1: Закалка безопасности и базовый фундамент (Выполнено)

* Express-сервер, веб-интерфейс с SSE и переключателем режима песочницы.

* Синглтон LLM-движка на `node-llama-cpp` и `gpuMutex`.

* Защита путей (`resolveSafePath`), проверка `fs.realpath` и белый список `SAFE_COMMANDS` через `execFile`.

### Этап 2: Стабилизация API контракта, режимов и цикла Self-Correction (Выполнено)

* Единое поведение `stream: true` и `stream: false`.

* Исполнитель планов (`executePlan`) с нормализацией шагов, защитой от циклов и самокоррекцией.

* Рекурсивная память (`recursiveMind.js`) с антипаттернами и автоочисткой старых рефлексий.

* Сводные XML-отчёты (`ExecutionTracer`) в `reports/tests/` и `reports/chats/`.

### Этап 3: Гибридный нейро-роутинг и расширение экосистемы (Выполнено)

* \[x\] Разработка и тестирование рекурсивного нейро-роутера на CPU (`src/core/neuralRouter.js`, `tests/test-router.js`).

* \[x\] Интеграция `NeuralSkillRouter` в `src/api/routes.js`.

* \[x\] Добавление инструментов `listDir` и `deleteFile` в `toolsRegistry`.

* \[x\] Расширение `SAFE_COMMANDS` (`dir-list`, `git-status`, `git-diff`).

* \[x\] Обрезка истории диалога (`Context Pruning`) и контроль лимита ходов сессии.

## Лицензия

Проект распространяется под лицензией **MIT**. См. файл `LICENSE`.
