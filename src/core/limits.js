// src/core/limits.js
// Единый источник лимитов плана.
// T5: раньше planParser.js имел собственный MAX_STEPS = 64, а executor.js — 128,
// из-за чего план усекался молча до 64 шагов и до лимита исполнителя (128) дело не доходило.
// Теперь оба модуля берут лимит отсюда, и любое расхождение невозможно по построению.

/** Максимальное число шагов плана, которое принимает и парсер, и исполнитель. */
export const MAX_PLAN_STEPS = 128;

/**
 * Единое правило усечения: обрезает план до MAX_PLAN_STEPS.
 * Ничего не скрывает — при усечении пишет предупреждение в лог.
 * @param {Array} steps нормализованные шаги
 * @param {string} [source] метка источника для лога
 * @returns {Array} тот же массив, если усечение не требуется
 */
export function clampPlanSteps(steps, source = 'planParser') {
  if (!Array.isArray(steps) || steps.length <= MAX_PLAN_STEPS) return steps;
  const dropped = steps.length - MAX_PLAN_STEPS;
  const notice = `[${source}] План усечён: ${steps.length} > ${MAX_PLAN_STEPS} шагов, отброшено ${dropped}`;
  console.warn(notice);
  return steps.slice(0, MAX_PLAN_STEPS);
}

export default MAX_PLAN_STEPS;
