import fs from 'node:fs/promises';
import path from 'node:path';

export const WORKSPACE_ROOT = path.resolve();
export const SANDBOX_REL = path.join('tests', 'sandbox');
export const SANDBOX_DIR = path.resolve(WORKSPACE_ROOT, SANDBOX_REL);

export const sandboxConfig = {
  strictDefault: true // true — жёстко всё в tests/sandbox, false — свобода выбора в пределах проекта
};

/**
 * Находит ближайшую существующую родительскую директорию и проверяет её реальный путь
 */
async function verifyNearestExistingAncestor(targetPath, realRoot) {
  let current = path.dirname(targetPath);
  while (true) {
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
 * Строгая проверка безопасности пути с поддержкой жёсткого режима песочницы по умолчанию
 */
export async function resolveSafePath(userPath) {
  if (!userPath || typeof userPath !== 'string') {
    throw new Error('Некорректный путь: путь должен быть непустой строкой.');
  }

  let targetInput = userPath.trim();
  const normalizedInput = path.normalize(targetInput);
  const activeRoot = sandboxConfig.strictDefault ? SANDBOX_DIR : WORKSPACE_ROOT;

  if (sandboxConfig.strictDefault) {
    await fs.mkdir(SANDBOX_DIR, { recursive: true });
    const relToSandboxPrefix = path.relative(SANDBOX_REL, normalizedInput);
    const isAlreadyPrefixed =
      !relToSandboxPrefix.startsWith('..') &&
      !path.isAbsolute(relToSandboxPrefix) &&
      (normalizedInput === SANDBOX_REL || normalizedInput.startsWith(SANDBOX_REL + path.sep));

    if (!isAlreadyPrefixed) {
      targetInput = path.join(SANDBOX_REL, normalizedInput);
    }
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

  try {
    const realActiveRoot = await fs.realpath(activeRoot);
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
      const realActiveRoot = await fs.realpath(activeRoot).catch(() => activeRoot);
      await verifyNearestExistingAncestor(absoluteTarget, realActiveRoot);
      return absoluteTarget;
    }
    throw err;
  }
}