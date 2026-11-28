// tests/ws-transport.test.js
// Блок 6.4: WebSocket-транспорт (альтернатива SSE).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import WebSocket from 'ws';

import { createSseParser, attachWebSocket } from '../src/api/wsServer.js';

describe('createSseParser', () => {
  test('собирает события из чанков, разделённых пустой строкой', () => {
    const events = [];
    let doneCount = 0;
    const parser = createSseParser(
      (e) => events.push(e),
      () => {
        doneCount += 1;
      }
    );

    parser.push('data: {"a":1}\n\ndata: {"a"');
    parser.push(':2}\n\n');
    parser.push('data: [DONE]\n\n');
    parser.flush();

    assert.deepEqual(events, [{ a: 1 }, { a: 2 }]);
    assert.equal(doneCount, 1);
  });

  test('не-JSON и мусорные строки игнорируются', () => {
    const events = [];
    const parser = createSseParser((e) => events.push(e));
    parser.push('data: not-json\n\n: комментарий\n\ndata: {"ok":true}\n\n');
    parser.flush();
    assert.deepEqual(events, [{ ok: true }]);
  });
});

describe('attachWebSocket', () => {
  let server;
  let base;
  let confirmCalls;
  let upstream;

  before(async () => {
    confirmCalls = [];

    server = http.createServer((req, res) => {
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const frames = [
          { choices: [{ delta: { content: 'Привет' } }] },
          {
            type: 'confirmation_request',
            id: 'req-1',
            tool: 'deleteFile',
            arguments: { filePath: 'a.txt' }
          },
          { choices: [{ delta: { content: ', мир' } }] }
        ];
        for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (req.url === '/v1/confirm') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          confirmCalls.push(JSON.parse(body));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    upstream = attachWebSocket(server, { getBaseUrl: () => base });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    upstream.close();
    await new Promise((r) => server.close(r));
  });

  test('проксирует chat-поток в сокет (дельты + done)', async () => {
    const wsUrl = base.replace('http', 'ws') + '/v1/ws';
    const ws = new WebSocket(wsUrl);
    const received = [];
    let deltas = '';
    const done = new Promise((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        received.push(msg.type || 'delta');
        if (msg.choices?.[0]?.delta?.content) deltas += msg.choices[0].delta.content;
        if (msg.type === 'done') resolve();
      });
    });

    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'chat', messages: [{ role: 'user', content: 'привет' }] }));
    await done;
    ws.close();

    assert.equal(deltas, 'Привет, мир');
    assert.ok(received.includes('confirmation_request'));
    assert.ok(received.includes('done'), 'должно прийти событие done');
  });

  test('сообщение confirm уходит на /v1/confirm', async () => {
    const wsUrl = base.replace('http', 'ws') + '/v1/ws';
    const ws = new WebSocket(wsUrl);
    const ack = new Promise((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'confirm_ack') resolve(msg);
      });
    });

    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'confirm', id: 'req-1', approved: true }));
    const msg = await ack;

    assert.equal(msg.id, 'req-1');
    assert.equal(msg.success, true);
    assert.deepEqual(confirmCalls.at(-1), { id: 'req-1', approved: true });
    ws.close();
  });

  test('неизвестный тип сообщения → error', async () => {
    const wsUrl = base.replace('http', 'ws') + '/v1/ws';
    const ws = new WebSocket(wsUrl);
    const err = new Promise((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'error') resolve(msg);
      });
    });

    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'nope' }));
    const msg = await err;

    assert.match(msg.error, /Неизвестный тип/);
    ws.close();
  });

  test('апгрейд на чужой путь отклоняется', async () => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/other');
    const outcome = await Promise.race([
      once(ws, 'error').then(() => 'error'),
      once(ws, 'open').then(() => 'open'),
      new Promise((r) => setTimeout(() => r('timeout'), 2000))
    ]);
    assert.notEqual(outcome, 'open', 'чужой путь не должен принимать соединение');
    ws.terminate();
  });
});
