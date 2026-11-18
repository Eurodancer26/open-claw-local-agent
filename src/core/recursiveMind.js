import fs from 'fs/promises';
import path from 'path';

const MIND_DIR = path.resolve(process.cwd(), 'mind');
const REFLECTIONS_DIR = path.join(MIND_DIR, 'reflections');
const STATE_FILE = path.join(MIND_DIR, 'state.json');

const DEFAULT_STATE = {
  coreGoal: 'Ожидание первой задачи',
  activeDirectory: 'tests/sandbox',
  mode: 'strict',
  thoughtStack: []
};

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

export async function initMind() {
  await ensureMindDirs();
  try {
    const data = await fs.readFile(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return DEFAULT_STATE;
  }
}

export async function updateMindState(updater) {
  await ensureMindDirs();
  try {
    const currentState = await initMind();
    const newState = typeof updater === 'function' ? updater(currentState) : { ...currentState, ...updater };
    await fs.writeFile(STATE_FILE, JSON.stringify(newState, null, 2), 'utf-8');
    return newState;
  } catch (err) {
    console.error('Ошибка обновления state.json:', err);
    return DEFAULT_STATE;
  }
}

/**
 * Санитар памяти и фиксация опыта (превращает ошибки в антипаттерны)
 */
export async function pushRecursiveThought(thoughtText, depth = 1, isError = false) {
  await ensureMindDirs();
  try {
    const timestamp = new Date().toISOString();
    const fileName = `thought_${Date.now()}_d${depth}.md`;
    const filePath = path.join(REFLECTIONS_DIR, fileName);

    let cleanText = thoughtText.replace(/[^\x00-\x7FА-Яа-яЁё0-9\s.,!?-]/g, '').trim();

    if (isError || cleanText.includes('Loop Guard') || cleanText.includes('Ошибка')) {
      cleanText = `[АНТИПАТТЕРН / ОШИБКА]: ${cleanText}. Так делать нельзя, избегай повторения этого сценария!`;
      isError = true;
    }

    const fileContent = `# Мысль [Глубина: ${depth}]\nВремя: ${timestamp}\nСтатус: ${isError ? 'Провал/Антипаттерн' : 'Успех'}\n\n${cleanText}\n`;
    await fs.writeFile(filePath, fileContent, 'utf-8');

    const state = await initMind();
    const newStack = [
      { depth, file: fileName, preview: cleanText.slice(0, 100), isError },
      ...(state.thoughtStack || [])
    ].slice(0, 10);

    await updateMindState({ thoughtStack: newStack });
  } catch (err) {
    console.error('Ошибка записи рекурсивной мысли:', err);
  }
}

export async function getMindContextSummary() {
  try {
    const state = await initMind();
    if (!state.thoughtStack || state.thoughtStack.length === 0) {
      return 'История размышлений пуста.';
    }

    const summaries = state.thoughtStack.map(t => {
      const prefix = t.isError ? '⚠️' : '💡';
      return `- ${prefix} [Глубина ${t.depth}]: ${t.preview}`;
    }).join('\n');

    return `РЕКУРСИВНАЯ ПАМЯТЬ И ОПЫТ (АНТИПАТТЕРНЫ):\n${summaries}`;
  } catch {
    return 'Не удалось загрузить контекст сознания.';
  }
}