// src/core/planParser.js
const KNOWN_TOOLS = new Set([
  'readFile', 'writeFile', 'deleteFile', 'listDir',
  'analyzeProject', 'generateUnitTest', 'runCommand'
]);

const MAX_STEPS = 64;

function normalizeStepObject(rawObj, index) {
  if (!rawObj || typeof rawObj !== 'object' || Array.isArray(rawObj)) {
    return null;
  }

  const keys = Object.keys(rawObj);
  if (!rawObj.tool && keys.length === 1 && KNOWN_TOOLS.has(keys[0])) {
    const toolName = keys[0];
    const innerArgs = rawObj[toolName];
    return {
      step: typeof rawObj.step === 'number' ? rawObj.step : index + 1,
      tool: toolName,
      arguments:
        innerArgs && typeof innerArgs === 'object' && !Array.isArray(innerArgs) ? innerArgs : {},
      description:
        typeof rawObj.description === 'string' && rawObj.description.trim().length > 0
          ? rawObj.description.trim()
          : `Выполнение ${toolName}`
    };
  }

  if (typeof rawObj.tool === 'string' && rawObj.tool.trim().length > 0) {
    const toolName = rawObj.tool.trim();
    if (!KNOWN_TOOLS.has(toolName)) return null;

    const args =
      rawObj.arguments && typeof rawObj.arguments === 'object' && !Array.isArray(rawObj.arguments)
        ? { ...rawObj.arguments }
        : rawObj.args && typeof rawObj.args === 'object' && !Array.isArray(rawObj.args)
          ? { ...rawObj.args }
          : {};

    const descFromArgs = typeof args.description === 'string' ? args.description : '';
    const desc =
      typeof rawObj.description === 'string' && rawObj.description.trim().length > 0
        ? rawObj.description.trim()
        : descFromArgs.trim() || `Выполнение ${toolName}`;

    return {
      step: typeof rawObj.step === 'number' ? rawObj.step : index + 1,
      tool: toolName,
      arguments: args,
      description: desc
    };
  }

  return null;
}

function extractBalanced(text, openChar, closeChar) {
  const start = text.indexOf(openChar);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) { if (--depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

function fixTrailingCommas(text) {
  return text.replace(/,\s*([\]}])/g, '$1');
}

function fixNewlinesInStrings(text) {
  return text.replace(/"((?:\\.|[^"\\])*)"/g, (match) => {
    return match
      .replace(/\r\n/g, '\\n')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\n');
  });
}

function sanitizeModelPlanText(rawText) {
  let text = String(rawText)
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  text = text.replace(
    /"([^"\\]*)"\s*\+\s*\(?\s*(?:JSON\.parse\s*\(\s*)?(?:JSON\.stringify\s*\(\s*)?(?:await\s+)?(?:this\.)?readFile\s*\([\s\S]*?\)\s*\)?\s*\)?(?:\.(?:content|output))?/gi,
    (_, prefix) => `"${prefix}{{step2.output}}"`
  );

  text = text.replace(
    /(?<!")\b(?:await\s+)?(?:this\.)?readFile\s*\([\s\S]*?\)(?:\.(?:content|output))?(?!")/gi,
    '"{{step2.output}}"'
  );

  text = text.replace(/,\s*([\]}])/g, '$1');

  return text;
}

function tryParseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  try { return JSON.parse(fixNewlinesInStrings(text)); } catch (_) {}
  try { return JSON.parse(fixTrailingCommas(fixNewlinesInStrings(text))); } catch (_) {}
  return null;
}

/**
 * Разворачивает «двойной JSON»: массив строк, каждая из которых JSON,
 * и одиночные JSON-строки. Устраняет баг вида:
 *   ["{\"step\":1,\"tool\":\"writeFile\",...}"]
 *   "{\"step\":1,\"tool\":\"writeFile\",...}"
 *   [[{...}], {...}]
 */
function deepUnwrapJson(value, depth = 0) {
  if (depth > 5) return value;

  // Строка — пробуем распарсить как JSON
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return value;
    // Быстрая проверка: похоже ли на JSON
    if (!/^[\[{]/.test(s)) return value;
    const parsed = tryParseJson(s);
    if (parsed === null) return value;
    return deepUnwrapJson(parsed, depth + 1);
  }

  // Массив — обрабатываем каждый элемент
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      out.push(deepUnwrapJson(item, depth + 1));
    }
    return out;
  }

  // Объект — если это контейнер {steps: [...]}, разворачиваем
  if (value && typeof value === 'object') {
    if (Array.isArray(value.steps)) {
      return {
        ...value,
        steps: value.steps.map((s) => deepUnwrapJson(s, depth + 1))
      };
    }
    return value;
  }

  return value;
}

export function safeParseJsonPayload(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  const cleaned = sanitizeModelPlanText(rawText);

  // Быстрый путь: весь текст — валидный JSON
  const whole = tryParseJson(cleaned);
  if (whole !== null) {
    return deepUnwrapJson(whole);
  }

  // Иначе — первый сбалансированный [...] или {...}
  const firstBracket = cleaned.indexOf('[');
  const firstBrace = cleaned.indexOf('{');
  let candidate = null;

  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    candidate = extractBalanced(cleaned, '[', ']');
  } else if (firstBrace !== -1) {
    candidate = extractBalanced(cleaned, '{', '}');
  }

  if (candidate) {
    const parsed = tryParseJson(candidate);
    if (parsed !== null) {
      return deepUnwrapJson(parsed);
    }
  }
  return null;
}

function findAllBalancedCandidates(text) {
  const candidates = [];

  let pos = 0;
  while (pos < text.length) {
    const openIdx = text.indexOf('[', pos);
    if (openIdx === -1) break;
    const balanced = extractBalanced(text.slice(openIdx), '[', ']');
    if (balanced && balanced.length > 2) {
      candidates.push({ start: openIdx, text: balanced });
      pos = openIdx + balanced.length;
    } else {
      pos = openIdx + 1;
    }
  }

  pos = 0;
  while (pos < text.length) {
    const openIdx = text.indexOf('{', pos);
    if (openIdx === -1) break;
    const balanced = extractBalanced(text.slice(openIdx), '{', '}');
    if (balanced && balanced.length > 2) {
      candidates.push({ start: openIdx, text: balanced });
      pos = openIdx + balanced.length;
    } else {
      pos = openIdx + 1;
    }
  }

  return candidates.sort((a, b) => a.start - b.start).map((c) => c.text);
}

function normalizePlan(parsed) {
  if (parsed === null || parsed === undefined) return [];

  let rawSteps = [];
  if (Array.isArray(parsed)) {
    rawSteps = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.steps)) {
    rawSteps = parsed.steps;
  } else if (parsed && typeof parsed === 'object') {
    rawSteps = [parsed];
  }

  const normalized = rawSteps
    .map((item, idx) => normalizeStepObject(item, idx))
    .filter(Boolean)
    .slice(0, MAX_STEPS);

  return normalized.map((s, idx) => ({ ...s, step: idx + 1 }));
}

export function extractActionPlan(modelResponse) {
  const cleaned = sanitizeModelPlanText(modelResponse);
  if (!cleaned) return [];

  // Быстрый путь
  const primary = safeParseJsonPayload(modelResponse);
  if (primary !== null) {
    const plan = normalizePlan(primary);
    if (plan.length > 0) return plan;
  }

  // Fallback: перебираем все [...] и {...} в тексте
  const candidates = findAllBalancedCandidates(cleaned);
  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed === null) continue;

    const unwrapped = deepUnwrapJson(parsed);
    const plan = normalizePlan(unwrapped);
    if (plan.length > 0) return plan;
  }

  return [];
}