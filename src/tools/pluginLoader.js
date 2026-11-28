// src/tools/pluginLoader.js
// Блок 6.5: плагинная система инструментов.
//
// Плагин — это файл `*.plugin.mjs` (ESM) в каталоге `tools/` в корне проекта.
// Каждый файл экспортирует метаданные инструмента; реестр расширяется ими
// без правки ядра. Загрузка небезопасного кода — сознательное решение: это
// локальный агент, плагины пишет сам владелец, поэтому фильтра по содержимому нет.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PLUGIN_DIR_NAME = 'tools';
// Поддерживаем оба суффикса: `.plugin.mjs` и `.plugin.js` (проект — ESM).
export const PLUGIN_SUFFIXES = ['.plugin.mjs', '.plugin.js'];
const isPluginFile = (name) => PLUGIN_SUFFIXES.some((s) => name.endsWith(s));

// Имена ядра зарезервированы: плагин не должен перекрывать встроенные инструменты.
const RESERVED_NAMES = new Set([
  'readFile',
  'writeFile',
  'createDir',
  'deleteFile',
  'listDir',
  'analyzeProject',
  'generateUnitTest',
  'runCommand',
  'searchInFiles'
]);

/**
 * Проверяет форму экспорта плагина.
 * Ожидается либо { name, description, execute }, либо default с теми же полями.
 * @returns {{ ok: true, tool: object } | { ok: false, error: string }}
 */
export function validatePluginModule(mod, fileName = '') {
  const candidate = mod && typeof mod === 'object' && mod.default ? mod.default : mod;

  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, error: `${fileName}: модуль не экспортирует объект инструмента` };
  }
  const { name, description, execute } = candidate;
  if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
    return { ok: false, error: `${fileName}: некорректное имя инструмента "${name}"` };
  }
  if (RESERVED_NAMES.has(name)) {
    return { ok: false, error: `${fileName}: имя "${name}" зарезервировано ядром` };
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    return { ok: false, error: `${fileName}: отсутствует description` };
  }
  if (typeof execute !== 'function') {
    return { ok: false, error: `${fileName}: отсутствует функция execute` };
  }
  // Флаг dangerous: инструмент требует подтверждения (см. registry/executor).
  return {
    ok: true,
    tool: { name, description, execute, dangerous: candidate.dangerous === true }
  };
}

/**
 * Загружает все плагины из каталога.
 * @param {string} dir каталог плагинов
 * @param {{ onError?: (msg: string) => void }} [options]
 * @returns {Promise<Map<string, object>>} имя инструмента -> определение
 */
export async function loadPluginsFromDir(dir, options = {}) {
  const tools = new Map();
  const report = typeof options.onError === 'function' ? options.onError : () => {};

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return tools; // нет каталога — плагинов нет
    throw error;
  }

  const files = entries
    .filter((e) => e.isFile() && isPluginFile(e.name))
    .map((e) => e.name)
    .sort();

  for (const fileName of files) {
    const abs = path.join(dir, fileName);
    let mod;
    try {
      mod = await import(pathToFileURL(abs).href);
    } catch (error) {
      report(`${fileName}: ошибка загрузки — ${error.message}`);
      continue;
    }

    const check = validatePluginModule(mod, fileName);
    if (!check.ok) {
      report(check.error);
      continue;
    }
    if (tools.has(check.tool.name)) {
      report(`${fileName}: инструмент "${check.tool.name}" уже загружен`);
      continue;
    }
    tools.set(check.tool.name, check.tool);
  }

  return tools;
}

/**
 * Расширяет базовый реестр инструментами плагинов (in-place, новые ключи).
 * @param {object} registry
 * @param {Map<string, object>} plugins
 * @returns {string[]} добавленные имена
 */
export function registerPlugins(registry, plugins) {
  const added = [];
  for (const [name, tool] of plugins) {
    if (registry[name]) continue;
    registry[name] = { description: tool.description, execute: tool.execute };
    added.push(name);
  }
  return added;
}
