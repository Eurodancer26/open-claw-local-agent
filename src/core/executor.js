// src/core/executor.js
import { toolsRegistry } from '../tools/registry.js';

const MAX_STEPS = 128;

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Проверяет обязательные аргументы инструмента ДО его вызова.
 * Возвращает { valid: true } или { valid: false, error: 'текст' }.
 * Неизвестные инструменты здесь не валидируются — их отловит
 * проверка toolsRegistry ниже.
 */
function validateArguments(tool, args) {
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
        return { valid: false, error: 'Инструмент "writeFile" требует непустой arguments.filePath' };
      }
      if (args.content === undefined) {
        return { valid: false, error: 'Инструмент "writeFile" требует arguments.content (может быть пустой строкой)' };
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
        return { valid: false, error: 'Инструмент "generateUnitTest" требует arguments.sourcePath' };
      }
      if (typeof args.outputPath !== 'string' || !args.outputPath.trim()) {
        return { valid: false, error: 'Инструмент "generateUnitTest" требует arguments.outputPath' };
      }
      break;

    case 'runCommand':
      if (typeof args.commandId !== 'string' && typeof args.command !== 'string') {
        return { valid: false, error: 'Инструмент "runCommand" требует arguments.commandId (или command)' };
      }
      break;

    default:
      // Неизвестные инструменты валидируются отдельно (через toolsRegistry).
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
    if (args.filePath === undefined && typeof rawStep.filePath === 'string') args.filePath = rawStep.filePath;
    if (args.filePath === undefined && typeof rawStep.path === 'string') args.filePath = rawStep.path;
    if (args.content === undefined && rawStep.content !== undefined) args.content = rawStep.content;
  } else if (tool === 'readFile' || tool === 'deleteFile') {
    if (args.filePath === undefined && typeof rawStep.filePath === 'string') args.filePath = rawStep.filePath;
    if (args.filePath === undefined && typeof rawStep.path === 'string') args.filePath = rawStep.path;
  } else if (tool === 'listDir' || tool === 'analyzeProject') {
    if (args.dirPath === undefined && typeof rawStep.dirPath === 'string') args.dirPath = rawStep.dirPath;
    if (args.dirPath === undefined && typeof rawStep.path === 'string') args.dirPath = rawStep.path;
  } else if (tool === 'generateUnitTest') {
    if (args.sourcePath === undefined && typeof rawStep.sourcePath === 'string') args.sourcePath = rawStep.sourcePath;
    if (args.outputPath === undefined && typeof rawStep.outputPath === 'string') args.outputPath = rawStep.outputPath;
    if (args.outputPath === undefined && typeof rawStep.path === 'string') args.outputPath = rawStep.path;
  } else if (tool === 'runCommand') {
    if (args.commandId === undefined && typeof rawStep.commandId === 'string') args.commandId = rawStep.commandId;
    if (args.command === undefined && typeof rawStep.command === 'string') args.command = rawStep.command;
  }

  // Мягкое дефолтное значение для директорий (dirPath = '.')
  if ((tool === 'listDir' || tool === 'analyzeProject') && args.dirPath === undefined) {
    args.dirPath = '.';
  }

  const stepNumber =
    typeof rawStep.step === 'number' && Number.isFinite(rawStep.step)
      ? rawStep.step
      : index + 1;

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

  if (toolName === 'deleteFile' && typeof result.filePath === 'string') {
    return `Удалён ${result.filePath}`;
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
const STEP_REF_REGEX = /\{\{\s*(?:step[\s._-]*)?(\d+)(?:\.(?:output|result|content|stdout))?\s*\}\}/gi;

function interpolateStepValue(value, resultsByStep, lastReadOutput = '') {
  if (typeof value === 'string') {
    return value.replace(STEP_REF_REGEX, (match, stepNumStr) => {
      const stepNum = Number.parseInt(stepNumStr, 10);
      if (!Number.isFinite(stepNum)) return match;

      const prev = resultsByStep.get(stepNum);
      if (prev) {
        // Приоритет — «чистый» rawOutput (без [Исправлено] и т.п.),
        // затем обычный output (совместимость со старыми записями).
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
    console.error('[executor] onProgress threw:', err?.message || err);
  }
}

export async function executePlan(
  plan,
  onProgress = null,
  session = null,
  fixStepCallback = null,
  allowSelfCorrection = true,
  maxCorrectionsPerStep = 2
) {
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

      // Валидация аргументов ДО вызова инструмента
      const validation = validateArguments(step.tool, step.arguments);
      if (!validation.valid) {
        const argErr = validation.error;

        if (allowSelfCorrection && attempts < maxCorrectionsPerStep && typeof fixStepCallback === 'function') {
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
      if (attempts > 0 && seenSignatures.has(signature)) {
        const loopErr = `Loop Guard: повторный идентичный шаг "${step.tool}" без прогресса`;
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

        if (allowSelfCorrection && attempts < maxCorrectionsPerStep && typeof fixStepCallback === 'function') {
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
        const execResult = await toolDef.execute(step.arguments);

        if (execResult && execResult.success === false) {
          const toolErr = execResult.error || execResult.message || `Ошибка выполнения "${step.tool}"`;

          if (allowSelfCorrection && attempts < maxCorrectionsPerStep && typeof fixStepCallback === 'function') {
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

        // rawOutput — «чистый» вывод для интерполяции {{stepN.output}}.
        // displayOutput — с пометкой [Исправлено] для отображения в чате.
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

        if (allowSelfCorrection && attempts < maxCorrectionsPerStep && typeof fixStepCallback === 'function') {
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