export function safeParseJsonPayload(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  let cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  let candidate = '';
  if (firstBracket !== -1 && lastBracket > firstBracket && (firstBrace === -1 || firstBracket < firstBrace)) {
    candidate = cleaned.slice(firstBracket, lastBracket + 1);
  } else if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidate = cleaned.slice(firstBrace, lastBrace + 1);
  } else {
    return null;
  }

  try {
    return JSON.parse(candidate);
  } catch (_) {}

  const withoutTrailingCommas = candidate.replace(/,\s*([\]}])/g, '$1');
  try {
    return JSON.parse(withoutTrailingCommas);
  } catch (_) {}

  try {
    const repaired = withoutTrailingCommas.replace(
      /"(description|content|filePath|path|commandId)"\s*:\s*"([\s\S]*?)"(?=\s*,\s*"[a-zA-Z0-9_]+"|\s*\})/g,
      (match, key, val) => {
        const safeVal = val
          .replace(/\\"/g, '"')
          .replace(/"/g, '\\"')
          .replace(/\r\n/g, '\\n');
        return `"${key}": "${safeVal}"`;
      }
    );
    return JSON.parse(repaired);
  } catch (_) {}

  try {
    const superRepaired = withoutTrailingCommas.replace(/"description"\s*:\s*"([^"]*)"/g, (_, desc) => {
      const cleanDesc = desc.replace(/"/g, "'");
      return `"description": "${cleanDesc}"`;
    });
    return JSON.parse(superRepaired);
  } catch (_) {}

  return null;
}

export function extractActionPlan(modelResponse) {
  const parsed = safeParseJsonPayload(modelResponse);
  if (!parsed) return [];
  if (Array.isArray(parsed)) {
    return parsed.filter((item) => item && typeof item === 'object' && typeof item.tool === 'string');
  }
  if (typeof parsed === 'object' && typeof parsed.tool === 'string') {
    return [parsed];
  }
  return [];
}