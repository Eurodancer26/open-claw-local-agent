// tests/plugin-loader.test.js
// Блок 6.5: плагинная система инструментов (tools/*.plugin.mjs).
// Файлы тестов запускаются node --test в изолированных процессах,
// поэтому мутация модульного реестра здесь безопасна.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  validatePluginModule,
  loadPluginsFromDir,
  registerPlugins
} from '../src/tools/pluginLoader.js';
import { registerKnownTools, extractActionPlan } from '../src/core/planParser.js';
import { executePlan, isDangerousTool } from '../src/core/executor.js';
import { toolsRegistry, registerPluginTools, DANGEROUS_TOOL_NAMES } from '../src/tools/registry.js';

const NOOP = async () => ({ success: true });

describe('validatePluginModule', () => {
  test('принимает корректный экспорт', () => {
    const r = validatePluginModule({ name: 'myTool', description: 'desc', execute: NOOP });
    assert.equal(r.ok, true);
    assert.equal(r.tool.name, 'myTool');
  });

  test('принимает default-экспорт', () => {
    const r = validatePluginModule({
      default: { name: 'myTool', description: 'd', execute: NOOP }
    });
    assert.equal(r.ok, true);
  });

  test('отклоняет зарезервированное имя ядра', () => {
    const r = validatePluginModule({ name: 'readFile', description: 'd', execute: NOOP });
    assert.equal(r.ok, false);
    assert.match(r.error, /зарезервировано/);
  });

  test('отклоняет отсутствие execute и description', () => {
    assert.equal(validatePluginModule({ name: 'x', description: 'd' }).ok, false);
    assert.equal(validatePluginModule({ name: 'x', execute: NOOP }).ok, false);
  });

  test('отклоняет некорректное имя', () => {
    assert.equal(validatePluginModule({ name: '1bad', description: 'd', execute: NOOP }).ok, false);
  });
});

describe('loadPluginsFromDir', () => {
  let dir;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugins-'));
    await fs.writeFile(
      path.join(dir, 'good.plugin.mjs'),
      'export const name = "goodTool";\nexport const description = "good";\nexport async function execute() { return { success: true }; }\n'
    );
    await fs.writeFile(
      path.join(dir, 'legacy.plugin.js'),
      'export const name = "legacyTool";\nexport const description = "legacy";\nexport async function execute() { return { success: true }; }\n'
    );
    await fs.writeFile(
      path.join(dir, 'dangerous.plugin.mjs'),
      'export default { name: "rmAll", description: "danger", dangerous: true, execute: async () => ({ success: true }) };\n'
    );
    await fs.writeFile(path.join(dir, 'bad.plugin.mjs'), 'export const name = "noexecute";\n');
    await fs.writeFile(path.join(dir, 'ignored.js'), 'export const name = "ignored";\n');
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('загружает валидные плагины и пропускает некорректные/посторонние файлы', async () => {
    const errors = [];
    const plugins = await loadPluginsFromDir(dir, { onError: (m) => errors.push(m) });

    assert.deepEqual([...plugins.keys()].sort(), ['goodTool', 'legacyTool', 'rmAll']);
    assert.equal(plugins.get('rmAll').dangerous, true);
    assert.equal(errors.length, 1, 'должен быть отчёт о битом плагине');
    assert.match(errors[0], /bad\.plugin\.mjs/);
  });

  test('отсутствующий каталог → пустая карта', async () => {
    const plugins = await loadPluginsFromDir(path.join(dir, 'nope'));
    assert.equal(plugins.size, 0);
  });
});

describe('registerPlugins', () => {
  test('добавляет инструменты и не перезаписывает существующие', () => {
    const registry = { existing: { description: 'e', execute: NOOP } };
    const added = registerPlugins(
      registry,
      new Map([
        ['existing', { description: 'x', execute: NOOP }],
        ['newTool', { description: 'n', execute: NOOP }]
      ])
    );
    assert.deepEqual(added, ['newTool']);
    assert.equal(registry.existing.description, 'e');
    assert.equal(typeof registry.newTool.execute, 'function');
  });
});

describe('интеграция: плагинный инструмент в реестре, парсере и executor', () => {
  after(() => {
    delete toolsRegistry.pluginEcho;
    delete toolsRegistry.pluginDanger;
    DANGEROUS_TOOL_NAMES.delete('pluginDanger');
  });

  test('initPlugins загружает реальный пример tools/hello.plugin.mjs', async () => {
    const { initPlugins } = await import('../src/api/routes.js');
    await initPlugins();
    assert.ok(toolsRegistry.hello, 'инструмент hello должен быть зарегистрирован');
    const plan = extractActionPlan('[{"step":1,"tool":"hello","arguments":{"name":"Тест"}}]');
    assert.equal(plan.length, 1);
    const r = await toolsRegistry.hello.execute({ name: 'Тест' });
    assert.equal(r.message, 'Привет, Тест!');
  });

  test('registerPluginTools добавляет инструмент и помечает опасный', () => {
    const added = registerPluginTools(
      new Map([
        [
          'pluginEcho',
          { description: 'Эхо', execute: async (a) => ({ success: true, text: a.text }) }
        ],
        ['pluginDanger', { description: 'Опасно', dangerous: true, execute: NOOP }]
      ])
    );
    assert.deepEqual(added.sort(), ['pluginDanger', 'pluginEcho']);
    assert.equal(toolsRegistry.pluginEcho.description, 'Эхо');
    assert.equal(DANGEROUS_TOOL_NAMES.has('pluginDanger'), true);
    assert.equal(isDangerousTool('pluginDanger'), true);
    assert.equal(isDangerousTool('pluginEcho'), false);
  });

  test('парсер принимает зарегистрированное плагинное имя', () => {
    registerKnownTools(['pluginEcho']);
    const plan = extractActionPlan('[{"step":1,"tool":"pluginEcho","arguments":{"text":"hi"}}]');
    assert.equal(plan.length, 1);
    assert.equal(plan[0].tool, 'pluginEcho');
  });

  test('executor выполняет плагинный инструмент через confirmStep-гейт', async () => {
    let confirmed = 0;
    const r = await executePlan(
      [{ step: 1, tool: 'pluginDanger', arguments: {} }],
      null,
      null,
      null,
      false,
      undefined,
      false,
      {
        confirmStep: async () => {
          confirmed += 1;
          return { allowed: true };
        }
      }
    );
    assert.equal(r.success, true, r.error);
    assert.equal(confirmed, 1, 'опасный плагин должен запрашивать подтверждение');
  });
});
