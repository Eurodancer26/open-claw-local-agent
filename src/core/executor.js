import path from 'path';
import { toolsRegistry, sandboxConfig } from '../tools/registry.js';

const WORKSPACE_ROOT = path.resolve();

export async function executePlan(plan, progressCallback = () => {}, session = null, askModelToFix = null) {
  let lastToolCallSignature = '';
  let consecutiveDuplicates = 0;

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    const stepNum = step.step || (i + 1);
    let toolName = step.tool;
    let args = step.arguments || {};

    // LOOP GUARD: Проверяем на зацикливание
    const currentSignature = `${toolName}:${JSON.stringify(args)}`;
    if (currentSignature === lastToolCallSignature) {
      consecutiveDuplicates++;
    } else {
      consecutiveDuplicates = 0;
      lastToolCallSignature = currentSignature;
    }

    if (consecutiveDuplicates >= 2) {
      const errorMsg = `Loop Guard: Обнаружен бесконечный цикл. Инструмент "${toolName}" вызван повторно без изменений. Прерываю выполнение.`;
      progressCallback({ type: 'step_start', step: stepNum, tool: toolName, description: step.description || 'Выполнение шага' });
      progressCallback({ type: 'step_result', step: stepNum, success: false, error: errorMsg });
      return { success: false, error: errorMsg };
    }

    progressCallback({
      type: 'step_start',
      step: stepNum,
      tool: toolName,
      description: step.description || 'Выполнение шага'
    });

    try {
      let tool = toolsRegistry[toolName];
      if (!tool || typeof tool.execute !== 'function') {
        throw new Error(`Неизвестный или недоступный инструмент: ${toolName}`);
      }

      // Первая попытка выполнения инструмента
      let res = await tool.execute(args);

      // 🩺 Хирургическая самокоррекция (Self-Correction Retry)
      if (!res.success && session && typeof askModelToFix === 'function') {
        progressCallback({
          type: 'step_result',
          step: stepNum,
          success: false,
          error: `${res.error} (Пробую исправить...)`
        });

        // Просим модель исправить инструмент или аргументы на основе ошибки
        const fixResult = await askModelToFix({ tool: toolName, arguments: args, description: step.description }, res.error, session);
        
        if (fixResult && typeof fixResult === 'object') {
          // Если модель решила сменить инструмент
          if (fixResult.tool && toolsRegistry[fixResult.tool]) {
            toolName = fixResult.tool;
            tool = toolsRegistry[toolName];
          }
          // Если модель скорректировала аргументы
          if (fixResult.arguments && typeof fixResult.arguments === 'object') {
            args = fixResult.arguments;
          } else if (!fixResult.tool && !fixResult.arguments) {
            args = fixResult;
          }

          // Повторная попытка с исправленными параметрами
          if (tool && typeof tool.execute === 'function') {
            res = await tool.execute(args);
          }
        }
      }

      if (!res.success) {
        const errorMsg = res.error || 'Ошибка выполнения шага';
        progressCallback({
          type: 'step_result',
          step: stepNum,
          success: false,
          error: errorMsg
        });
        return { success: false, error: errorMsg };
      }

      const resultMsg = res.content || res.message || res.stdout || 'Успешно выполнено';
      progressCallback({
        type: 'step_result',
        step: stepNum,
        success: true,
        result: resultMsg
      });

    } catch (err) {
      progressCallback({
        type: 'step_result',
        step: stepNum,
        success: false,
        error: err.message
      });
      return { success: false, error: err.message };
    }
  }

  return { success: true };
}