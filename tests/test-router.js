import { NeuralSkillRouter } from '../src/core/neuralRouter.js';

async function runTest() {
  console.log('🧠 Инициализация нейро-роутера...');
  const router = new NeuralSkillRouter();
  await router.load(); // Попробует загрузить веса, если они уже сохранялись

  // Набор тестовых запросов, имитирующих реальный диалог
  const testPhrases = [
    "Привет! Как дела?",
    "Создай файл config.json с настройками",
    "Слушай, а какая сегодня дата?",
    "Запиши в tests/sandbox/test.txt текст приветствия",
    "Покажи версию node"
  ];

  console.log('\n--- Старт тестового прогона (проверяем рекурсивную память) ---\n');

  for (const phrase of testPhrases) {
    console.log(`💬 Запрос пользователя: "${phrase}"`);
    
    // Сеть делает предсказание и обновляет скрытое состояние (рекурсию)
    const result = router.predict(phrase);

    console.log(`   🎯 Выбранный скил: ${result.selectedSkill} (уверенность: ${(result.confidence * 100).toFixed(1)}%)`);
    console.log(`   📊 Вероятности: chat=${result.scores.chat}, file_ops=${result.scores.file_ops}, system_cmd=${result.scores.system_cmd}`);
    console.log(`   🧬 Память (hiddenState): [${result.memorySnapshot.join(', ')}]`);
    console.log('--------------------------------------------------');
  }

  // Сохраняем веса, чтобы закрепить состояние
  await router.save();
  console.log('\n💾 Веса и состояние успешно сохранены на диск!');
}

runTest().catch(console.error);