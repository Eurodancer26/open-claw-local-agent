// src/core/executor.js
import { toolsRegistry, DANGEROUS_TOOL_NAMES } from '../tools/registry.js';
import { getStrictCommandPolicy, listStrictAllowedCommands } from '../tools/safeCommands.js';
import { MAX_PLAN_STEPS } from './limits.js';

// T5: лимит шагов берётся из единого источника (src/core/limits.js),
// чтобы не было скрытого рассинхрона с planParser.js (было 64 vs 128).
export { MAX_PLAN_STEPS };
const MAX_STEPS = MAX_PLAN_STEPS;

// Блок 6.3: опасные инструменты, требующие подтверждения пользователя
// в свободном режиме (в песочнице файлы изолированы — подтверждение не нужно).
export const DANGEROUS_TOOLS = new Set(['deleteFile']);

/**
 * Опасен ли инструмент: ядро (DANGEROUS_TOOLS) или плагин (DANGEROUS_TOOL_NAMES).
 * @param {string} name
 */
export function isDangerousTool(name) {
  return DANGEROUS_TOOLS.has(name) || DANGEROUS_TOOL_NAMES.has(name);
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function validateArguments(tool, args, strict = undefined) {
  if (!isPlainObject(args)) {
    return { valid: false, error: `Аргументы инструмента "${tool}" должны быть объектом` };
  }

  switch (tool) {
    case 'readFile':
    case 'deleteFile':
      if (typeof args.filePath !== 'string' || !args.filePath.trim()) {
        return { valid: false, error: `Инструмент "${tool}" требует непустой arguments.filePath` };
      }
      break;

    case 'writeFile':
      if (typeof args.filePath !== 'string' || !args.filePath.trim()) {
        return {
          valid: false,
          error: 'Инструмент "writeFile" требует непустой arguments.filePath'
        };
      }
      if (/[\\/]\s*$/.test(args.filePath)) {
        return {
          valid: false,
          error: `Инструмент "writeFile" получил путь "${args.filePath}", заканчивающийся слэшем — похоже, это директория. Используй createDir для создания папки.`
        };
      }
      if (args.content === undefined) {
        return {
          valid: false,
          error: 'Инструмент "writeFile" требует arguments.content (может быть пустой строкой)'
        };
      }
      break;

    case 'createDir':
      if (typeof args.dirPath !== 'string' || !args.dirPath.trim()) {
        return { valid: false, error: 'Инструмент "createDir" требует непустой arguments.dirPath' };
      }
      if (/\.\w{1,8}$/.test(args.dirPath.trim()) && !/[\\/]/.test(args.dirPath)) {
        return {
          valid: false,
          error: `Инструмент "createDir" получил "${args.dirPath}" — это похоже на имя файла (есть расширение). Для файлов используй writeFile.`
        };
      }
      break;

    case 'searchInFiles':
      if (typeof args.query !== 'string' || !args.query.trim()) {
        return {
          valid: false,
          error: 'Инструмент "searchInFiles" требует непустой arguments.query'
        };
      }
      break;

    case 'listDir':
    case 'analyzeProject':
      if (typeof args.dirPath !== 'string' || !args.dirPath.trim()) {
        return { valid: false, error: `Инструмент "${tool}" требует непустой arguments.dirPath` };
      }
      break;

    case 'generateUnitTest':
      if (typeof args.sourcePath !== 'string' || !args.sourcePath.trim()) {
        return {
          valid: false,
          error: 'Инструмент "generateUnitTest" требует arguments.sourcePath'
        };
      }
      if (typeof args.outputPath !== 'string' || !args.outputPath.trim()) {
        return {
          valid: false,
          error: 'Инструмент "generateUnitTest" требует arguments.outputPath'
        };
      }
      break;

    case 'runCommand': {
      const commandId =
        typeof args.commandId === 'string'
          ? args.commandId
          : typeof args.command === 'string'
            ? args.command
            : null;
      if (!commandId) {
        return {
          valid: false,
          error: 'Инструмент "runCommand" требует arguments.commandId (или command)'
        };
      }
      // Ранний отказ до запуска процесса: в strict команды, читающие весь
      // репозиторий, запрещены (режим приходит явным параметром).
      if (strict === true && getStrictCommandPolicy(commandId) === 'deny') {
        return {
          valid: false,
          error:
            `Инструмент "runCommand" запрещён в строгом режиме песочницы: команда "${commandId}" ` +
            `может отдать данные вне tests/sandbox/. Разрешены: ${listStrictAllowedCommands().join(', ')}. ` +
            `Для листинга внутри песочницы используй listDir.`
        };
      }
      break;
    }

    default:
      break;
  }

  return { valid: true };
}

function normalizeStep(rawStep, index) {
  if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
    return null;
  }

  const tool = typeof rawStep.tool === 'string' ? rawStep.tool.trim() : '';

  const args = isPlainObject(rawStep.arguments)
    ? { ...rawStep.arguments }
    : isPlainObject(rawStep.args)
      ? { ...rawStep.args }
      : {};

  // Совместимость с «плоским» форматом:
  // {"tool":"writeFile","filePath":"...","content":"..."}
  if (tool === 'writeFile') {
    if (args.filePath === undefined && typeof rawStep.filePath === 'string')
      args.filePath = rawStep.filePath;
    if (args.filePath === undefined && typeof rawStep.path === 'string')
      args.filePath = rawStep.path;
    if (args.content === undefined && rawStep.content !== undefined) args.content = rawStep.content;
  } else if (tool === 'createDir') {
    if (args.dirPath === undefined && typeof rawStep.dirPath === 'string')
      args.dirPath = rawStep.dirPath;
    if (args.dirPath === undefined && typeof rawStep.path === 'string') args.dirPath = rawStep.path;
  } else if (tool === 'readFile' || tool === 'deleteFile') {
    if (args.filePath === undefined && typeof rawStep.filePath === 'string')
      args.filePath = rawStep.filePath;
    if (args.filePath === undefined && typeof rawStep.path === 'string')
      args.filePath = rawStep.path;
  } else if (tool === 'listDir' || tool === 'analyzeProject') {
    if (args.dirPath === undefined && typeof rawStep.dirPath === 'string')
      args.dirPath = rawStep.dirPath;
    if (args.dirPath === undefined && typeof rawStep.path === 'string') args.dirPath = rawStep.path;
  } else if (tool === 'generateUnitTest') {
    if (args.sourcePath === undefined && typeof rawStep.sourcePath === 'string')
      args.sourcePath = rawStep.sourcePath;
    if (args.outputPath === undefined && typeof rawStep.outputPath === 'string')
      args.outputPath = rawStep.outputPath;
    if (args.outputPath === undefined && typeof rawStep.path === 'string')
      args.outputPath = rawStep.path;
  } else if (tool === 'runCommand') {
    if (args.commandId === undefined && typeof rawStep.commandId === 'string')
      args.commandId = rawStep.commandId;
    if (args.command === undefined && typeof rawStep.command === 'string')
      args.command = rawStep.command;
  } else if (tool === 'searchInFiles') {
    if (args.query === undefined && typeof rawStep.query === 'string') args.query = rawStep.query;
    if (args.query === undefined && typeof rawStep.pattern === 'string')
      args.query = rawStep.pattern;
    if (args.dirPath === undefined && typeof rawStep.dirPath === 'string')
      args.dirPath = rawStep.dirPath;
    if (args.dirPath === undefined && typeof rawStep.path === 'string') args.dirPath = rawStep.path;
  }

  // Мягкое дефолтное значение для директорий (dirPath = '.')
  if (
    (tool === 'listDir' || tool === 'analyzeProject' || tool === 'searchInFiles') &&
    args.dirPath === undefined
  ) {
    args.dirPath = '.';
  }

  const stepNumber =
    typeof rawStep.step === 'number' && Number.isFinite(rawStep.step) ? rawStep.step : index + 1;

  const description =
    typeof rawStep.description === 'string' && rawStep.description.trim().length > 0
      ? rawStep.description.trim()
      : typeof args.description === 'string' && args.description.trim().length > 0
        ? args.description.trim()
        : `Выполнение инструмента ${tool || 'unknown'}`;

  return {
    step: stepNumber,
    tool,
    arguments: args,
    description
  };
}

function formatToolOutput(toolName, result) {
  if (!result || typeof result !== 'object') {
    return String(result ?? 'Выполнено');
  }

  if (toolName === 'readFile' && typeof result.content === 'string') {
    return result.content;
  }

  if (toolName === 'writeFile' && typeof result.filePath === 'string') {
    return `Записано в ${result.filePath}`;
  }

  if (toolName === 'createDir') {
    if (typeof result.message === 'string' && result.message.trim().length > 0) {
      return result.message;
    }
    if (typeof result.dirPath === 'string') {
      return result.created
        ? `Создана директория ${result.dirPath}`
        : `Директория уже существует: ${result.dirPath}`;
    }
  }

  if (toolName === 'deleteFile' && typeof result.filePath === 'string') {
    return `Удалён ${result.filePath}`;
  }

  if (toolName === 'searchInFiles' && Array.isArray(result.results)) {
    if (result.results.length === 0) return result.message || 'Совпадений не найдено';
    const body = result.results.map((r) => `${r.file}:${r.line}: ${r.text}`).join('\n');
    return `${result.message || 'Найдено:'}\n${body}`;
  }

  if (typeof result.message === 'string' && result.message.trim().length > 0) {
    return result.message;
  }

  if (typeof result.stdout === 'string' && result.stdout.trim().length > 0) {
    return result.stdout.trim();
  }

  return JSON.stringify(result);
}

// {{step1.output}} / {{step1}} / {{step 1.output}} / {{step1.result}} /
// {{step1.content}} / {{step1.stdout}} — все варианты, которые модели пишут.
const STEP_REF_REGEX =
  /\{\{\s*(?:step[\s._-]*)?(\d+)(?:\.(?:output|result|content|stdout))?\s*\}\}/gi;

function interpolateStepValue(value, resultsByStep, lastReadOutput = '') {
  if (typeof value === 'string') {
    return value.replace(STEP_REF_REGEX, (match, stepNumStr) => {
      const stepNum = Number.parseInt(stepNumStr, 10);
      if (!Number.isFinite(stepNum)) return match;

      const prev = resultsByStep.get(stepNum);
      if (prev) {
        const candidate = typeof prev.rawOutput === 'string' ? prev.rawOutput : prev.output;
        if (typeof candidate === 'string') return candidate;
      }

      if (lastReadOutput) return lastReadOutput;
      return match;
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolateStepValue(item, resultsByStep, lastReadOutput));
  }

  if (value && typeof value === 'object') {
    const nextObj = {};
    for (const [k, v] of Object.entries(value)) {
      nextObj[k] = interpolateStepValue(v, resultsByStep, lastReadOutput);
    }
    return nextObj;
  }

  return value;
}

function safeProgress(onProgress, event) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(event);
  } catch (err) {
    // Прерывание — не «шум» колбэка: оно должно остановить выполнение плана,
    // а не быть проглоченным вместе с остальными ошибками прогресса.
    if (err?.name === 'AbortError') throw err;
    console.error('[executor] onProgress threw:', err?.message || err);
  }
}

/**
 * AbortController активного executePlan. Зачем:
 *  - прогресс-колбэк и инструменты (runCommand) видят сигнал обрыва
 *    через options.signal и не продолжают работу;
 *  - глобальная ссылка нужна только чтобы вложенные вызовы могли прервать
 *    активный план, поэтому она снимается на ЛЮБОМ выходе из executePlan
 *    (иначе повторное использование можно было бы считать регрессией).
 */
let activeExecutionController = null;

export function getActiveExecutionSignal() {
  return activeExecutionController ? activeExecutionController.signal : null;
}

export function abortActiveExecution(reason = 'Генерация прервана') {
  if (activeExecutionController && !activeExecutionController.signal.aborted) {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    if (!err.name || err.name === 'Error') err.name = 'AbortError';
    activeExecutionController.abort(err);
  }
}

function clearActiveExecution(controller) {
  if (activeExecutionController === controller) {
    activeExecutionController = null;
  }
}

export async function executePlan(
  plan,
  onProgress = null,
  session = null,
  fixStepCallback = null,
  allowSelfCorrection = true,
  maxCorrectionsPerStep = 2,
  strict = undefined,
  options = {}
) {
  // Режим песочницы — явный параметр запроса, а не глобальное состояние:
  // один и тот же режим применяется ко всем шагам плана, не затрагивая
  // параллельные запросы с другим strictSandbox.
  const toolOptions = typeof strict === 'boolean' ? { strict } : {};

  const executionController = new AbortController();
  activeExecutionController = executionController;
  let externalSignal = options.signal;
  let externalAbortHandler = null;
  if (externalSignal && typeof externalSignal.addEventListener === 'function') {
    if (externalSignal.aborted) {
      executionController.abort(externalSignal.reason);
    } else {
      externalAbortHandler = () => executionController.abort(externalSignal.reason);
      externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }
  toolOptions.signal = executionController.signal;

  try {
    return await runPlanSteps();
  } finally {
    if (externalSignal && externalAbortHandler) {
      externalSignal.removeEventListener('abort', externalAbortHandler);
    }
    clearActiveExecution(executionController);
  }

  async function runPlanSteps() {
    if (!Array.isArray(plan) || plan.length === 0) {
      return {
        success: false,
        error: 'План пуст или имеет некорректный формат',
        results: []
      };
    }

    if (plan.length > MAX_STEPS) {
      return {
        success: false,
        error: `План содержит слишком много шагов (${plan.length} > ${MAX_STEPS})`,
        results: []
      };
    }

    const results = [];
    const resultsByStep = new Map();
    const seenSignatures = new Set();
    let lastReadOutput = '';

    for (let i = 0; i < plan.length; i += 1) {
      // Обрыв клиента в середине плана — не выполняем оставшиеся шаги.
      if (executionController.signal.aborted) {
        return {
          success: false,
          aborted: true,
          error: 'Генерация прервана: клиент разорвал соединение',
          results
        };
      }

      const normalizedInitial = normalizeStep(plan[i], i);
      if (!normalizedInitial || !normalizedInitial.tool) {
        const errMsg = `Некорректный шаг плана на позиции ${i + 1}: отсутствует или пуст tool`;
        return { success: false, error: errMsg, results };
      }

      let step = {
        ...normalizedInitial,
        arguments: interpolateStepValue(normalizedInitial.arguments, resultsByStep, lastReadOutput)
      };

      let attempts = 0;
      let stepCompleted = false;
      let wasCorrected = false;

      while (!stepCompleted) {
        step = {
          ...step,
          arguments: interpolateStepValue(step.arguments, resultsByStep, lastReadOutput)
        };

        const validation = validateArguments(step.tool, step.arguments, strict);
        if (!validation.valid) {
          const argErr = validation.error;

          if (
            allowSelfCorrection &&
            attempts < maxCorrectionsPerStep &&
            typeof fixStepCallback === 'function'
          ) {
            safeProgress(onProgress, {
              type: 'step_result',
              step: step.step,
              tool: step.tool,
              success: false,
              error: `${argErr} (Пробую исправить...)`
            });

            attempts += 1;
            const fixedRaw = await fixStepCallback(step, argErr, session, results);
            const normalizedFixed = normalizeStep(fixedRaw, i);
            if (normalizedFixed && normalizedFixed.tool) {
              step = { ...normalizedFixed, step: step.step };
              wasCorrected = true;
              continue;
            }
          }

          safeProgress(onProgress, {
            type: 'step_result',
            step: step.step,
            tool: step.tool,
            success: false,
            error: argErr
          });
          return { success: false, error: argErr, results };
        }

        const signature = JSON.stringify({ tool: step.tool, arguments: step.arguments });
        // T4: сигнатуры сверяем для ВСЕХ шагов плана, а не только после самокоррекции
        // (раньше условие attempts > 0 пропускало «эхо»-повторы внутри одного плана).
        if (seenSignatures.has(signature)) {
          const loopErr =
            `Loop Guard: шаг ${step.step} (позиция ${i + 1}) повторяет уже выполненный шаг ` +
            `"${step.tool}" с идентичными аргументами — выполнение остановлено, ` +
            `чтобы не зациклиться. Измените шаг или аргументы.`;
          safeProgress(onProgress, {
            type: 'step_result',
            step: step.step,
            tool: step.tool,
            success: false,
            error: loopErr
          });
          return { success: false, error: loopErr, results };
        }
        seenSignatures.add(signature);

        safeProgress(onProgress, {
          type: 'step_start',
          step: step.step,
          tool: step.tool,
          description: wasCorrected ? `${step.description} [исправлено]` : step.description
        });

        // Блок 6.3/6.5: опасные действия в свободном режиме требуют подтверждения.
        if (typeof options.confirmStep === 'function' && isDangerousTool(step.tool)) {
          const verdict = await options.confirmStep(step);
          if (!verdict || verdict.allowed !== true) {
            const denyMsg =
              (verdict && verdict.error) || `Действие "${step.tool}" не подтверждено пользователем`;
            safeProgress(onProgress, {
              type: 'step_result',
              step: step.step,
              tool: step.tool,
              success: false,
              error: denyMsg
            });
            return { success: false, error: denyMsg, aborted: false, results };
          }
        }

        const toolDef = toolsRegistry[step.tool];
        if (!toolDef || typeof toolDef.execute !== 'function') {
          const unknownToolErr = `Неизвестный или недоступный инструмент: "${step.tool}"`;
          safeProgress(onProgress, {
            type: 'step_result',
            step: step.step,
            tool: step.tool,
            success: false,
            error: unknownToolErr
          });

          if (
            allowSelfCorrection &&
            attempts < maxCorrectionsPerStep &&
            typeof fixStepCallback === 'function'
          ) {
            attempts += 1;
            const fixedRaw = await fixStepCallback(step, unknownToolErr, session, results);
            const normalizedFixed = normalizeStep(fixedRaw, i);
            if (normalizedFixed && normalizedFixed.tool) {
              step = { ...normalizedFixed, step: step.step };
              wasCorrected = true;
              continue;
            }
          }
          return { success: false, error: unknownToolErr, results };
        }

        try {
          const execResult = await toolDef.execute(step.arguments, toolOptions);

          if (execResult && execResult.success === false) {
            const toolErr =
              execResult.error || execResult.message || `Ошибка выполнения "${step.tool}"`;

            // Прерывание — не ошибка инструмента: самокоррекция запрещена.
            if (execResult.aborted || executionController.signal.aborted) {
              safeProgress(onProgress, {
                type: 'step_result',
                step: step.step,
                tool: step.tool,
                success: false,
                error: toolErr
              });
              return { success: false, aborted: true, error: toolErr, results };
            }

            if (
              allowSelfCorrection &&
              attempts < maxCorrectionsPerStep &&
              typeof fixStepCallback === 'function'
            ) {
              safeProgress(onProgress, {
                type: 'step_result',
                step: step.step,
                tool: step.tool,
                success: false,
                error: `${toolErr} (Пробую исправить...)`
              });

              attempts += 1;
              const fixedRaw = await fixStepCallback(step, toolErr, session, results);
              const normalizedFixed = normalizeStep(fixedRaw, i);
              if (normalizedFixed && normalizedFixed.tool) {
                step = { ...normalizedFixed, step: step.step };
                wasCorrected = true;
                continue;
              }
            }

            safeProgress(onProgress, {
              type: 'step_result',
              step: step.step,
              tool: step.tool,
              success: false,
              error: toolErr
            });
            return { success: false, error: toolErr, results };
          }

          const rawFormatted = formatToolOutput(step.tool, execResult);
          if (step.tool === 'readFile' && typeof execResult?.content === 'string') {
            lastReadOutput = execResult.content;
          }

          const rawOutput = rawFormatted;
          const displayOutput = wasCorrected
            ? `[Исправлено через ${step.tool}] ${rawFormatted}`
            : rawFormatted;

          const stepRecord = {
            step: step.step,
            tool: step.tool,
            success: true,
            output: displayOutput,
            rawOutput
          };

          results.push(stepRecord);
          resultsByStep.set(step.step, stepRecord);

          safeProgress(onProgress, {
            type: 'step_result',
            step: step.step,
            tool: step.tool,
            success: true,
            result: displayOutput
          });

          stepCompleted = true;
        } catch (err) {
          const caughtErr = err?.message || String(err);

          if (
            allowSelfCorrection &&
            attempts < maxCorrectionsPerStep &&
            typeof fixStepCallback === 'function'
          ) {
            safeProgress(onProgress, {
              type: 'step_result',
              step: step.step,
              tool: step.tool,
              success: false,
              error: `${caughtErr} (Пробую исправить...)`
            });

            attempts += 1;
            const fixedRaw = await fixStepCallback(step, caughtErr, session, results);
            const normalizedFixed = normalizeStep(fixedRaw, i);
            if (normalizedFixed && normalizedFixed.tool) {
              step = { ...normalizedFixed, step: step.step };
              wasCorrected = true;
              continue;
            }
          }

          safeProgress(onProgress, {
            type: 'step_result',
            step: step.step,
            tool: step.tool,
            success: false,
            error: caughtErr
          });

          return { success: false, error: caughtErr, results };
        }
      }
    }

    return {
      success: true,
      error: null,
      results
    };
  }
}
