import http from 'http';

const API_URL = 'http://localhost:3000/v1/chat/completions';

const testCases = [
    {
        name: "Тест 1: Логический/Аналитический (Сравнение парадигм)",
        prompt: "Сравни функциональное программирование и объектно-ориентированное в 3 коротких тезисах каждое."
    },
    {
        name: "Тест 2: Написание и структура кода",
        prompt: "Напиши простой скрипт на Node.js, который читает файл package.json и выводит зависимости."
    },
    {
        name: "Тест 3: Многоступенчатая задача (План + Исполнение)",
        prompt: "Придумай название для ИТ-стартапа в сфере кибербезопасности и напиши слоган для него."
    }
];

async function runTest(testCase, index) {
    console.log(`\n----------------------------------------`);
    console.log(`🚀 Запуск [${index + 1}/${testCases.length}]: ${testCase.name}`);
    console.log(`📝 Запрос: "${testCase.prompt}"`);
    console.log(`----------------------------------------`);

    const startTime = Date.now();

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: "user", content: testCase.prompt }]
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        const duration = Date.now() - startTime;

        console.log(`✅ Успешно за ${duration} ms (на стороне сервера: ${data.usage?.total_duration_ms || 'N/A'} ms)`);
        console.log(`\n📥 Ответ модели:\n`);
        console.log(data.choices[0].message.content);
        console.log(`----------------------------------------\n`);

    } catch (error) {
        console.error(`❌ Ошибка в тесте "${testCase.name}":`, error.message);
    }
}

async function runAllTests() {
    console.log("🔥 Старт комплексного тестирования локального агента...");
    const globalStart = Date.now();

    for (let i = 0; i < testCases.length; i++) {
        await runTest(testCases[i], i);
        // Небольшая пауза между тестами для стабильности
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(`✨ Все тесты завершены за ${((Date.now() - globalStart) / 1000).toFixed(2)} сек.`);
}

runAllTests();