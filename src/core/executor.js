import { toolsRegistry } from '../tools/registry.js';

/**
 * Исполнитель пошагового плана агента с поддержкой возврата результатов для самокоррекции
 */
export async function executePlan(plan) {
  const executionResults = [];
  let success = true;

  console.log(`\n⚙️ [Executor] Запуск выполнения плана (${plan.length} шагов)...`);

  for (const item of plan) {
    const { step, tool: toolName, arguments: args, description } = item;
    console.log(`   ▶ Шаг ${step}: ${description} [Инструмент: ${toolName}]`);

    const tool = toolsRegistry[toolName];
    if (!tool) {
      const errorMsg = `Инструмент "${toolName}" не найден в реестре.`;
      console.error(`   ❌ ${errorMsg}`);
      executionResults.push({ step, tool: toolName, success: false, error: errorMsg });
      success = false;
      break;
    }

    try {
      const result = await tool.execute(args);
      executionResults.push({
        step,
        tool: toolName,
        success: result.success,
        result: result.success ? (result.content || result.stdout || result.message || 'Успешно выполнено') : null,
        error: result.error || null
      });

      if (!result.success) {
        console.error(`   ❌ Ошибка на шаге ${step}:`, result.error);
        success = false;
        break; // Прерываем выполнение для передачи ошибки обратно в цикл самокоррекции
      } else {
        console.log(`   ✔ Шаг ${step} выполнен успешно.`);
      }
    } catch (err) {
      console.error(`   ❌ Исключение на шаге ${step}:`, err.message);
      executionResults.push({ step, tool: toolName, success: false, error: err.message });
      success = false;
      break;
    }
  }

  return { success, steps: executionResults };
}