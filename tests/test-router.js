import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NeuralSkillRouter } from '../src/core/neuralRouter.js';

async function runTest() {
  console.log('🧠 Инициализация нейро-роутера...');
  const router = new NeuralSkillRouter();
  await router.load();
  router.resetMemory();

  const testPhrases = [
    { text: 'Привет! Как дела?', expectedSkill: 'chat' },
    { text: 'Создай файл config.json с настройками', expectedSkill: 'file_ops' },
    { text: 'Слушай, а какая сегодня дата?', expectedSkill: 'chat' },
    { text: 'Запиши в tests/sandbox/test.txt текст приветствия', expectedSkill: 'file_ops' },
    { text: 'Покажи версию node', expectedSkill: 'system_cmd' }
  ];

  console.log('\n--- 1. Диалоговый прогон (проверяем рекурсивную память) ---\n');

  for (const item of testPhrases) {
    console.log(`💬 Запрос пользователя: "${item.text}"`);
    const result = router.predict(item.text);

    assert.equal(
      result.selectedSkill,
      item.expectedSkill,
      `Ожидался скил "${item.expectedSkill}" для "${item.text}", но получен "${result.selectedSkill}"`
    );
    assert.ok(result.confidence > 0.4, `Слишком низкая уверенность (${result.confidence}) для "${item.text}"`);
    assert.equal(result.memorySnapshot.length, 8, 'Размер hiddenState должен быть равен 8');

    console.log(`   🎯 Выбранный скил: ${result.selectedSkill} (уверенность: ${(result.confidence * 100).toFixed(1)}%)`);
    console.log(`   🧭 Широкий/смешанный запрос: ${result.isBroadOrMixed ? 'да' : 'нет'}`);
    console.log(`   📊 Вероятности: chat=${result.scores.chat}, file_ops=${result.scores.file_ops}, system_cmd=${result.scores.system_cmd}`);
    console.log(`   🧬 Память (hiddenState): [${result.memorySnapshot.join(', ')}]`);
    console.log('--------------------------------------------------');
  }

  console.log('\n--- 2. Проверка длинных и составных промтов (сброс памяти перед каждым кейсом) ---\n');

  const longPrompts = [
    {
      text: 'Привет! Расскажи подробно, как устроен наш локальный агент, зачем нужен мьютекс GPU и как работает рекурсивная память размышлений в папке mind.',
      expectedSkill: 'chat',
      expectBroad: true
    },
    {
      text: 'Мне нужно проанализировать структуру директории src/core, посмотреть какие там есть крупные файлы и строки кода, а затем сгенерировать заготовку unit-теста для одного из модулей в песочнице.',
      expectedSkill: 'file_ops',
      expectBroad: false
    },
    {
      text: 'Проверь статус репозитория через git и выведи версию node и npm, чтобы убедиться что окружение готово к работе.',
      expectedSkill: 'system_cmd',
      expectBroad: true
    },
    {
      text: `Сделай пожалуйста разбор нашего проекта: сначала посмотри файлы в src/api и src/tools,
       обрати внимание на то, как обрабатываются пути и ошибки в песочнице,
       а в конце подскажи, какие шаги стоит сделать дальше для стабильной работы агента.`,
      expectedSkill: 'file_ops',
      expectBroad: false
    }
  ];

  for (const item of longPrompts) {
    router.resetMemory();
    const result = router.predict(item.text);

    assert.equal(
      result.selectedSkill,
      item.expectedSkill,
      `Для длинного промта ожидался "${item.expectedSkill}", но получен "${result.selectedSkill}"`
    );
    assert.equal(
      result.isBroadOrMixed,
      item.expectBroad,
      `Для промта "${item.text.slice(0, 45)}..." ожидалось isBroadOrMixed=${item.expectBroad}, но получено ${result.isBroadOrMixed}`
    );

    const topStr = result.topSkills.map((s) => `${s.skill}:${(s.score * 100).toFixed(1)}%`).join(', ');
    console.log(`📝 Промт (${item.text.length} симв.): "${item.text.slice(0, 75).replace(/\s+/g, ' ')}..."`);
    console.log(`   🎯 Лидер: ${result.selectedSkill} (${(result.confidence * 100).toFixed(1)}%) | isBroadOrMixed=${result.isBroadOrMixed}`);
    console.log(`   📈 Распределение: ${topStr}`);
    console.log('--------------------------------------------------');
  }

  const tempWeightsPath = path.join(os.tmpdir(), `router-weights-${Date.now()}.json`);
  const tempRouter = new NeuralSkillRouter(tempWeightsPath);
  const beforeTrain = tempRouter.predict('Покажи статус git и версию node').scores.system_cmd;
  tempRouter.resetMemory();
  tempRouter.trainStep('Покажи статус git и версию node', 'system_cmd');
  await tempRouter.save();

  const reloadedRouter = new NeuralSkillRouter(tempWeightsPath);
  await reloadedRouter.load();
  reloadedRouter.resetMemory();
  const afterReload = reloadedRouter.predict('Покажи статус git и версию node').scores.system_cmd;

  await fs.unlink(tempWeightsPath).catch(() => {});
  assert.ok(afterReload >= beforeTrain, 'После обучения и перезагрузки весов score для system_cmd не должен упасть');

  console.log('\n💾 Проверка save()/load() на временном файле прошла успешно!');
  console.log('✅ Все assertions для NeuralSkillRouter пройдены!');
}

runTest().catch((err) => {
  console.error('❌ Тест нейро-роутера упал:', err);
  process.exit(1);
});