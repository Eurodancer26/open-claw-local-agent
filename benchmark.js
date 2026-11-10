import http from 'http';

const API_URL = 'http://localhost:3000/v1/chat/completions';

const technicalPayload = {
    messages: [
        { 
            role: "user", 
            content: "Напиши мини-модуль на Node.js для генерации случайного хэша, используя встроенный модуль crypto." 
        }
    ]
};

console.log("🛠️ Запуск технического бенчмарка оркестратора...");
console.log(`📡 Отправка запроса на ${API_URL}...\n`);

const startTime = Date.now();
const startMemory = process.memoryUsage().heapUsed;

const req = http.request(API_URL, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    }
}, (res) => {
    let data = '';

    res.on('data', (chunk) => {
        data += chunk;
    });

    res.on('end', () => {
        const totalTime = Date.now() - startTime;
        const endMemory = process.memoryUsage().heapUsed;
        const memoryDiffMB = ((endMemory - startMemory) / 1024 / 1024).toFixed(2);

        console.log("==========================================");
        console.log("📊 ТЕХНИЧЕСКИЙ ОТЧЕТ БЕНЧМАРКА");
        console.log("==========================================");
        console.log(`⏱️ Общее время клиентского запроса: ${totalTime} ms`);
        
        try {
            const jsonResponse = JSON.parse(data);
            console.log(`🤖 Модель: ${jsonResponse.model}`);
            console.log(`🆔 ID сессии: ${jsonResponse.id}`);
            if (jsonResponse.usage && jsonResponse.usage.total_duration_ms) {
                console.log(`⚙️ Время на стороне сервера: ${jsonResponse.usage.total_duration_ms} ms`);
            }
            console.log("\n📥 Исходный ответ модели от сервера:");
            console.log("------------------------------------------");
            console.log(jsonResponse.choices[0].message.content);
            console.log("------------------------------------------");
        } catch (e) {
            console.log("❌ Не удалось распарсить JSON-ответ от сервера:");
            console.log(data);
        }
        
        console.log(`💾 Изменение памяти клиента (heap): ~${memoryDiffMB} MB`);
        console.log("==========================================");
    });
});

req.on('error', (error) => {
    console.error(`❌ Ошибка подключения к серверу: ${error.message}`);
    console.log("💡 Убедись, что сервер запущен через 'node src/server.js'!");
});

req.write(JSON.stringify(technicalPayload));
req.end();