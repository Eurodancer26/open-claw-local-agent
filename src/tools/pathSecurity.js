// src/tools/pathSecurity.js
import fs from 'node:fs/promises';
import path from 'node:path';

export const WORKSPACE_ROOT = path.resolve();
export const SANDBOX_REL = path.join('tests', 'sandbox');
export const SANDBOX_DIR = path.resolve(WORKSPACE_ROOT, SANDBOX_REL);

export const sandboxConfig = {
  strictDefault: true // true — жёстко всё в tests/sandbox, false — свобода выбора в пределах проекта
};

function isWindowsDrivePath(p) {
  return /^[a-zA-Z]:[\\/]/.test(p);
}

function isUncPath(p) {
  return /^\\\\[^\\]/.test(p) || /^\/\/[^/]/.test(p);
}

/**
 * Убирает ведущий префикс tests/sandbox (если он уже указан),
 * чтобы избежать вложенного tests/sandbox/tests/sandbox/... в строгом режиме.
 */
function stripLeadingSandboxPrefix(rawPath) {
  const slashNormalized = rawPath.replace(/\\/g, '/').trim();
  const withoutDotSlash = slashNormalized.replace(/^(?:\.\/)+/, '');
  const sandboxPrefix = SANDBOX_REL.replace(/\\/g, '/').replace(/^\.\/+/, '');

  if (withoutDotSlash === '' || withoutDotSlash === '.' || withoutDotSlash === sandboxPrefix) {
    return '.';
  }

  const prefixWithSlash = `${sandboxPrefix}/`;
  if (withoutDotSlash.startsWith(prefixWithSlash)) {
    const rest = withoutDotSlash.slice(prefixWithSlash.length);
    return rest || '.';
  }

  return withoutDotSlash;
}

/**
 * Находит ближайшую существующую родительскую директорию и проверяет её реальный путь.
 * Ограничение глубины защищает от теоретических циклов на битой ФС.
 */
async function verifyNearestExistingAncestor(targetPath, realRoot) {
  let current = path.dirname(targetPath);
  let depth = 0;
  const MAX_DEPTH = 64;

  while (true) {
    if (depth++ > MAX_DEPTH) {
      throw new Error('Нарушение безопасности: слишком глубокая вложенность при проверке пути.');
    }

    try {
      const realCurrent = await fs.realpath(current);
      const rel = path.relative(realRoot, realCurrent);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error('Нарушение безопасности: родительская директория находится вне разрешенной зоны.');
      }
      return;
    } catch (err) {
      if (err.code === 'ENOENT') {
        const parent = path.dirname(current);
        if (parent === current) {
          throw new Error('Нарушение безопасности: не удалось подтвердить корневую директорию.');
        }
        current = parent;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Строгая проверка безопасности пути с поддержкой жёсткого режима песочницы по умолчанию.
 */
export async function resolveSafePath(userPath) {
  if (!userPath || typeof userPath !== 'string') {
    throw new Error('Некорректный путь: путь должен быть непустой строкой.');
  }
  if (userPath.includes('\0')) {
    throw new Error('Некорректный путь: содержит нулевой байт.');
  }

  const trimmedInput = userPath.trim();
  if (trimmedInput.length === 0) {
    throw new Error('Некорректный путь: пустая строка после trim.');
  }

  // Абсолютные Windows и UNC пути не имеют смысла ни в strict, ни в free режиме.
  if (isWindowsDrivePath(trimmedInput) || isUncPath(trimmedInput)) {
    throw new Error('Нарушение безопасности: абсолютные Windows/UNC пути запрещены.');
  }

  const activeRoot = sandboxConfig.strictDefault ? SANDBOX_DIR : WORKSPACE_ROOT;

  let targetInput = trimmedInput;
  if (sandboxConfig.strictDefault) {
    await fs.mkdir(SANDBOX_DIR, { recursive: true });
    const cleanedRel = stripLeadingSandboxPrefix(trimmedInput);
    if (path.isAbsolute(cleanedRel)) {
      throw new Error('Нарушение безопасности: абсолютные пути в строгом режиме запрещены.');
    }
    targetInput = path.join(SANDBOX_REL, path.normalize(cleanedRel));
  }

  const absoluteTarget = path.resolve(WORKSPACE_ROOT, targetInput);
  const relativeToActiveRoot = path.relative(activeRoot, absoluteTarget);

  if (relativeToActiveRoot.startsWith('..') || path.isAbsolute(relativeToActiveRoot)) {
    throw new Error(
      sandboxConfig.strictDefault
        ? 'Нарушение безопасности: в строгом режиме работа разрешена только внутри tests/sandbox/.'
        : 'Нарушение безопасности: выход за пределы рабочей директории запрещен.'
    );
  }

  let realActiveRoot;
  try {
    realActiveRoot = await fs.realpath(activeRoot);
  } catch {
    realActiveRoot = activeRoot;
  }

  try {
    const stat = await fs.lstat(absoluteTarget);
    const realTarget = await fs.realpath(absoluteTarget);
    const relReal = path.relative(realActiveRoot, realTarget);

    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      throw new Error(
        stat.isSymbolicLink()
          ? 'Нарушение безопасности: целевой файл является симлинком за пределы разрешенной зоны.'
          : 'Нарушение безопасности: выход за пределы разрешенной директории запрещен.'
      );
    }
    return absoluteTarget;
  } catch (err) {
    if (err.code === 'ENOENT') {
      await verifyNearestExistingAncestor(absoluteTarget, realActiveRoot);
      return absoluteTarget;
    }
    throw err;
  }
}