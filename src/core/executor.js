import { toolsRegistry } from '../tools/registry.js';

function normalizeStep(rawStep, index) {
  if (!rawStep || typeof rawStep !== 'object') {
    return null;
  }

  const tool = typeof rawStep.tool === 'string' ? rawStep.tool.trim() : '';
  const args =
    rawStep.arguments && typeof rawStep.arguments === 'object' && !Array.isArray(rawStep.arguments)
      ? { ...rawStep.arguments }
      : rawStep.args && typeof rawStep.args === 'object' && !Array.isArray(rawStep.args)
        ? { ...rawStep.args }
        : {};

  // Поддержка плоских аргументов, если модель передала их рядом с tool
  if (tool === 'writeFile') {
    if (!args.filePath && typeof rawStep.filePath === 'string') args.filePath = rawStep.filePath;
    if (!args.filePath && typeof rawStep.path === 'string') args.filePath = rawStep.path;
    if (args.content === undefined && rawStep.content !== undefined) args.content = rawStep.content;
  } else if (tool === 'readFile' || tool === 'deleteFile') {
    if (!args.filePath && typeof rawStep.filePath === 'string') args.filePath = rawStep.filePath;
    if (!args.filePath && typeof rawStep.path === 'string') args.filePath = rawStep.path;
  } else if (tool === 'listDir') {
    if (!args.dirPath && typeof rawStep.dirPath === 'string') args.dirPath = rawStep.dirPath;
    if (!args.dirPath && typeof rawStep.path === 'string') args.dirPath = rawStep.path;
  } else if (tool === 'runCommand') {
    if (!args.commandId && typeof rawStep.commandId === 'string') args.commandId = rawStep.commandId;
    if (!args.command && typeof rawStep.command === 'string') args.command = rawStep.command;
  }

  const stepNumber =
    typeof rawStep.step === 'number' && Number.isFinite(rawStep.step)
      ? rawStep.step
      : index + 1;

  const description =
    typeof rawStep.description === 'string' && rawStep.description.trim().length > 0
      ? rawStep.description.trim()
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

  if (typeof result.message === 'string' && result.message.trim().length > 0) {
    return result.message;
  }

  if (typeof result.stdout === 'string' && result.stdout.trim().length > 0) {
    return result.stdout.trim();
  }

  return JSON.stringify(result);
}

/**
 * Подставляет результаты предыдущих шагов по плейсхолдерам вида {{step1.output}} или {{step1}}
 */
function interpolateStepValue(value, resultsByStep) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*step(\d+)(?:\.output)?\s*\}\}/gi, (match, stepNumStr) => {
      const stepNum = Number.parseInt(stepNumStr, 10);
      const prev = resultsByStep.get(stepNum);
      if (!prev || typeof prev.output !== 'string') {
        return match;
      }
      return prev.output;
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolateStepValue(item, resultsByStep));
  }

  if (value && typeof value === 'object') {
    const nextObj = {};
    for (const [k, v] of Object.entries(value)) {
      nextObj[k] = interpolateStepValue(v, resultsByStep);
    }
    return nextObj;
  }

  return value;
}

/**
 * Последовательный исполнитель шагов плана с пробросом результатов между шагами,
 * поддержкой самокоррекции и защиты от циклов.
 */
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

  const results = [];
  const resultsByStep = new Map();
  const seenSignatures = new Set();

  for (let i = 0; i < plan.length; i += 1) {
    const normalizedInitial = normalizeStep(plan[i], i);
    if (!normalizedInitial || !normalizedInitial.tool) {
      const errMsg = `Некорректный шаг плана на позиции ${i + 1}`;
      return { success: false, error: errMsg, results };
    }

    let step = {
      ...normalizedInitial,
      arguments: interpolateStepValue(normalizedInitial.arguments, resultsByStep)
    };

    let attempts = 0;
    let stepCompleted = false;
    let wasCorrected = false;

    while (!stepCompleted) {
      step = {
        ...step,
        arguments: interpolateStepValue(step.arguments, resultsByStep)
      };

      const signature = JSON.stringify({ tool: step.tool, arguments: step.arguments });
      if (attempts > 0 && seenSignatures.has(signature)) {
        const loopErr = `Loop Guard: повторный идентичный шаг "${step.tool}" без прогресса`;
        if (typeof onProgress === 'function') {
          onProgress({
            type: 'step_result',
            step: step.step,
            tool: step.tool,
            success: false,
            error: loopErr
          });
        }
        return { success: false, error: loopErr, results };
      }
      seenSignatures.add(signature);

      if (typeof onProgress === 'function') {
        onProgress({
          type: 'step_start',
          step: step.step,
          tool: step.tool,
          description: wasCorrected ? `${step.description} [исправлено]` : step.description
        });
      }

      const toolDef = toolsRegistry[step.tool];
      if (!toolDef || typeof toolDef.execute !== 'function') {
        const unknownToolErr = `Неизвестный или недоступный инструмент: "${step.tool}"`;
        if (typeof onProgress === 'function') {
          onProgress({
            type: 'step_result',
            step: step.step,
            tool: step.tool,
            success: false,
            error: unknownToolErr
          });
        }

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
            if (typeof onProgress === 'function') {
              onProgress({
                type: 'step_result',
                step: step.step,
                tool: step.tool,
                success: false,
                error: `${toolErr} (Пробую исправить...)`
              });
            }

            attempts += 1;
            const fixedRaw = await fixStepCallback(step, toolErr, session, results);
            const normalizedFixed = normalizeStep(fixedRaw, i);
            if (normalizedFixed && normalizedFixed.tool) {
              step = { ...normalizedFixed, step: step.step };
              wasCorrected = true;
              continue;
            }
          }

          if (typeof onProgress === 'function') {
            onProgress({
              type: 'step_result',
              step: step.step,
              tool: step.tool,
              success: false,
              error: toolErr
            });
          }
          return { success: false, error: toolErr, results };
        }

        const rawFormatted = formatToolOutput(step.tool, execResult);
        const finalOutput = wasCorrected
          ? `[Исправлено через ${step.tool}] ${rawFormatted}`
          : rawFormatted;

        const stepRecord = {
          step: step.step,
          tool: step.tool,
          success: true,
          output: finalOutput
        };

        results.push(stepRecord);
        resultsByStep.set(step.step, stepRecord);

        if (typeof onProgress === 'function') {
          onProgress({
            type: 'step_result',
            step: step.step,
            tool: step.tool,
            success: true,
            result: finalOutput
          });
        }

        stepCompleted = true;
      } catch (err) {
        const caughtErr = err?.message || String(err);

        if (allowSelfCorrection && attempts < maxCorrectionsPerStep && typeof fixStepCallback === 'function') {
          if (typeof onProgress === 'function') {
            onProgress({
              type: 'step_result',
              step: step.step,
              tool: step.tool,
              success: false,
              error: `${caughtErr} (Пробую исправить...)`
            });
          }

          attempts += 1;
          const fixedRaw = await fixStepCallback(step, caughtErr, session, results);
          const normalizedFixed = normalizeStep(fixedRaw, i);
          if (normalizedFixed && normalizedFixed.tool) {
            step = { ...normalizedFixed, step: step.step };
            wasCorrected = true;
            continue;
          }
        }

        if (typeof onProgress === 'function') {
          onProgress({
            type: 'step_result',
            step: step.step,
            tool: step.tool,
            success: false,
            error: caughtErr
          });
        }

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