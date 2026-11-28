// src/core/recursiveMind.js
import fs from 'fs/promises';
import path from 'path';

const MIND_DIR = path.resolve(process.cwd(), 'mind');
const REFLECTIONS_DIR = path.join(MIND_DIR, 'reflections');
const STATE_FILE = path.join(MIND_DIR, 'state.json');
const MAX_THOUGHT_STACK = 10;
const MAX_REFLECTION_FILES = 30;

const PREVIEW_LEN = 140;
const SUMMARY_ERRORS = 3;
const SUMMARY_MAX_LEN = 1200;

const DEFAULT_STATE = {
  coreGoal: 'Ожидание первой задачи',
  activeDirectory: 'tests/sandbox',
  mode: 'strict',
  thoughtStack: []
};

function cloneDefaultState() {
  return {
    ...DEFAULT_STATE,
    thoughtStack: []
  };
}

async function ensureMindDirs() {
  try {
    await fs.mkdir(REFLECTIONS_DIR, { recursive: true });
    try {
      await fs.access(STATE_FILE);
    } catch {
      await fs.writeFile(STATE_FILE, JSON.stringify(DEFAULT_STATE, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('Ошибка инициализации папки mind:', err);
  }
}

async function pruneOldReflections(maxFiles = MAX_REFLECTION_FILES) {
  try {
    const entries = await fs.readdir(REFLECTIONS_DIR);
    const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();
    if (mdFiles.length <= maxFiles) return;

    const toDelete = mdFiles.slice(0, mdFiles.length - maxFiles);
    await Promise.all(
      toDelete.map((file) =>
        fs.rm(path.join(REFLECTIONS_DIR, file), { force: true }).catch(() => {})
      )
    );
  } catch (err) {
    console.error('Ошибка очистки старых рефлексий:', err);
  }
}

export async function initMind() {
  await ensureMindDirs();
  try {
    const data = await fs.readFile(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object') return cloneDefaultState();
    return {
      ...cloneDefaultState(),
      ...parsed,
      thoughtStack: Array.isArray(parsed.thoughtStack) ? parsed.thoughtStack : []
    };
  } catch {
    return cloneDefaultState();
  }
}

export async function updateMindState(updater) {
  await ensureMindDirs();
  try {
    const currentState = await initMind();
    const newState =
      typeof updater === 'function' ? updater(currentState) : { ...currentState, ...updater };
    await fs.writeFile(STATE_FILE, JSON.stringify(newState, null, 2), 'utf-8');
    return newState;
  } catch (err) {
    console.error('Ошибка обновления state.json:', err);
    return cloneDefaultState();
  }
}

// Убираем только управляющие символы. Пунктуация (включая { } " : / , ;)
// сохраняется — иначе JSON-структура в памяти превращается в кашу.
function sanitizeForFile(text) {
  return (
    String(text)
      // Намеренно вычищаем управляющие символы (включая \x00-\x1F и DEL) из
      // текста перед записью в state.json — правило ниже срабатывает осознанно.
      // eslint-disable-next-line no-control-regex -- sanitize: вырезаем управляющие символы намеренно
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim()
  );
}

// Однострочный короткий preview без переносов и длинных «хвостов» JSON.
function makePreview(text, maxLen = PREVIEW_LEN) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1).trimEnd() + '…';
}

// Определяет «обломок JSON-плана»: есть фигурные скобки и признаки
// структуры шагов, но баланс скобок/кавычек не сошёлся — значит модель
// оборвалась посреди плана.
function looksLikeBrokenJsonPlan(text) {
  const s = String(text || '');
  const hasBrace = /[{[]/.test(s);
  const hasTool = /"tool"\s*:/.test(s) || /"step"\s*:/.test(s);
  if (!hasBrace || !hasTool) return false;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return depth !== 0 || inStr;
}

// Санитайзер для показа модели.
// Убирает полные пути и содержимое, чтобы модель не копировала их в свой
// новый план (few-shot contamination — главная причина провала теста №8).
function sanitizePreviewForModel(preview) {
  let s = String(preview || '');

  // Заменяем полные пути к файлам на [путь]
  s = s.replace(
    /\b(?:tests[\\/]sandbox|src|tests|public|mind|models|reports|dist|build|config)(?:[\\/][\w.-]+)+/gi,
    '[путь]'
  );

  // Заменяем одиночные имена файлов с расширением на [файл]
  s = s.replace(/\b[\w-]+\.(?:json|txt|js|ts|md|xml|css|html|log|csv|yml|yaml|ini)\b/gi, '[файл]');

  // Заменяем содержимое в двойных кавычках, если оно длинное или содержит пути
  s = s.replace(/"([^"]{4,})"/g, (match, inner) => {
    if (inner.length > 30 || /[/\\]/.test(inner)) return '"[содержимое]"';
    return match;
  });

  return s;
}

// Разбирает строку вида «Запрос: X -> Ответ: Y» или «Запрос: X -> План из N шагов».
function splitRequestAnswer(raw) {
  const s = String(raw || '');
  const m = s.match(/^Запрос:\s*([\s\S]*?)\s*->\s*(?:План из\s+\d+\s+шагов|Ответ:\s*([\s\S]*))$/i);
  if (m) {
    return { request: (m[1] || '').trim(), answer: (m[2] || '').trim() };
  }
  return { request: '', answer: s.trim() };
}

export async function pushRecursiveThought(thoughtText, depth = 1, isError = false) {
  await ensureMindDirs();
  try {
    const timestamp = new Date().toISOString();
    const fileName = `thought_${Date.now()}_d${depth}.md`;
    const filePath = path.join(REFLECTIONS_DIR, fileName);

    let cleanText = sanitizeForFile(thoughtText);

    const brokenJson = looksLikeBrokenJsonPlan(cleanText);
    const loopGuard = /Loop Guard/i.test(cleanText);
    const explicitAntiPattern = /^\[?АНТИПАТТЕРН/i.test(cleanText);
    const looksLikeError = /\bОшибка\b|\bПровал\b/i.test(cleanText);

    if (brokenJson) {
      isError = true;
      const { request } = splitRequestAnswer(cleanText);
      cleanText = request
        ? `[АНТИПАТТЕРН: обрезанный JSON-план] Запрос «${makePreview(request, 90)}» — модель начала выдавать план, но он не сбалансирован. Не повторяй: на информацию отвечай текстом, на действие — валидным JSON без обрывов.`
        : '[АНТИПАТТЕРН: обрезанный JSON-план] Модель выдала непроходимый JSON. Так делать нельзя.';
    } else if (loopGuard) {
      isError = true;
      cleanText = `[АНТИПАТТЕРН / LOOP GUARD]: ${cleanText}. Так делать нельзя, избегай повторения этого сценария!`;
    } else if (isError || explicitAntiPattern || looksLikeError) {
      isError = true;
      cleanText = `[АНТИПАТТЕРН / ОШИБКА]: ${cleanText}. Так делать нельзя, избегай повторения этого сценария!`;
    }

    const fileContent = `# Мысль [Глубина: ${depth}]\nВремя: ${timestamp}\nСтатус: ${isError ? 'Провал/Антипаттерн' : 'Успех'}\n\n${cleanText}\n`;
    await fs.writeFile(filePath, fileContent, 'utf-8');

    const preview = makePreview(cleanText);
    const state = await initMind();

    const dedupedStack = (state.thoughtStack || []).filter((t) => t && t.preview !== preview);
    const newStack = [{ depth, file: fileName, preview, isError }, ...dedupedStack].slice(
      0,
      MAX_THOUGHT_STACK
    );

    await updateMindState({ thoughtStack: newStack });
    await pruneOldReflections(MAX_REFLECTION_FILES);
  } catch (err) {
    console.error('Ошибка записи рекурсивной мысли:', err);
  }
}

// Классификация отдельной записи с учётом старых «мусорных» preview.
function classifyEntry(entry) {
  const preview = String(entry?.preview || '');
  const depth = Number.isFinite(entry?.depth) ? entry.depth : 1;
  if (!preview) return null;

  if (looksLikeBrokenJsonPlan(preview)) {
    return {
      depth,
      isError: true,
      preview: '[обрезка JSON-плана — модель не довела план до конца]'
    };
  }

  return {
    depth,
    isError: Boolean(entry?.isError),
    preview
  };
}

export async function getMindContextSummary() {
  try {
    const state = await initMind();
    const stack = Array.isArray(state.thoughtStack) ? state.thoughtStack : [];
    if (stack.length === 0) {
      return 'История размышлений пуста.';
    }

    // Дедупликация + переклассификация
    const seen = new Set();
    const errors = [];
    let successCount = 0;

    for (const raw of stack) {
      const c = classifyEntry(raw);
      if (!c) continue;
      const key = c.isError ? `err:${c.preview.slice(0, 80)}` : `ok:${c.preview.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (c.isError) {
        errors.push(c);
      } else {
        successCount += 1;
      }
    }

    const lines = [];

    if (errors.length > 0) {
      lines.push('ИЗБЕГАЙ ЭТИХ СЦЕНАРИЕВ (прошлые ошибки):');
      for (const t of errors.slice(0, SUMMARY_ERRORS)) {
        lines.push(`- ⚠️ ${sanitizePreviewForModel(t.preview)}`);
      }
    }

    if (successCount > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(`В памяти ${successCount} успешных операций (детали намеренно скрыты).`);
    }

    lines.push('');
    lines.push(
      'ВАЖНО: НЕ копируй пути, имена файлов или содержимое из памяти или прошлых ответов. ' +
        'Используй РОВНО те значения, которые указал пользователь в ТЕКУЩЕМ запросе. ' +
        'Если память говорит «успешно создал файл [файл]» — это НЕ значит, что нужно снова создавать его.'
    );

    let summary = lines.join('\n');
    if (summary.length > SUMMARY_MAX_LEN) {
      summary = summary.slice(0, SUMMARY_MAX_LEN - 1).trimEnd() + '…';
    }
    return summary;
  } catch {
    return 'Не удалось загрузить контекст сознания.';
  }
}
