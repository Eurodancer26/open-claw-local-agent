import http from 'http';

const API_URL = 'http://localhost:3000/v1/chat/completions';

const payload = {
    messages: [
        { 
            role: "user", 
            content: "Напиши функцию на JavaScript для проверки, является ли строка палиндромом." 
        }
    ]
};

console.log("🧹 Запуск бенчмарка проверки чистоты вывода...");

const startTime = Date.now();

const req = http.request(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
}, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        const totalTime = Date.now() - startTime;
        console.log(`⏱️ Время выполнения: ${totalTime} ms\n`);
        
        try {
            const json = JSON.parse(data);
            console.log("📥 Полученный чистый ответ модели:");
            console.log("------------------------------------------");
            console.log(json.choices[0].message.content);
            console.log("------------------------------------------");
        } catch (e) {
            console.log("❌ Ошибка парсинга:", data);
        }
    });
});

req.on('error', err => console.error("❌ Ошибка:", err.message));
req.write(JSON.stringify(payload));
req.end();