import http from 'http';

const data = JSON.stringify({
  messages: [{ role: 'user', content: 'Напиши функцию сложения двух чисел на JS' }],
  stream: true
});

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  }
}, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  res.on('data', (chunk) => {
    process.stdout.write(chunk);
  });
});

req.on('error', (e) => {
  console.error(`Problem with request: ${e.message}`);
});

req.write(data);
req.end();