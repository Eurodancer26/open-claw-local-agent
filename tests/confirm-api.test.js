// tests/confirm-api.test.js
// Блок 6.3: HTTP-проводка эндпоинта подтверждения и статика UI.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import app from '../src/server.js';

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('POST /v1/confirm', () => {
  test('неизвестный id → success:false (запрос не найден)', async () => {
    const res = await fetch(`${base}/v1/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'no-such-id', approved: true })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, false);
  });

  test('без тела → успешный ответ, id null', async () => {
    const res = await fetch(`${base}/v1/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.id, null);
    assert.equal(data.approved, false);
  });
});

describe('Статика UI', () => {
  test('GET / отдаёт index.html', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.match(html, /Конструкт АИ/);
  });

  test('GET /app.js отдаёт клиентский скрипт с логикой подтверждения', async () => {
    const res = await fetch(`${base}/app.js`);
    assert.equal(res.status, 200);
    const js = await res.text();
    assert.match(js, /confirmation_request/);
    assert.match(js, /\/v1\/confirm/);
  });
});
