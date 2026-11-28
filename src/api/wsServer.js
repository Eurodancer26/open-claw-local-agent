// src/api/wsServer.js
// Блок 6.4: WebSocket-транспорт как альтернатива SSE.
//
// Сервер НЕ дублирует логику чата: он проксирует тот же HTTP+SSE эндпоинт
// /v1/chat/completions по loopback и пересылает события в сокет. Так SSE и
// WebSocket гарантированно отдают идентичный поток, а вся логика режимов,
// роутера, подтверждений и трассировки остаётся в одном месте.
import { WebSocketServer } from 'ws';

const DEFAULT_PATH = '/v1/ws';

/**
 * Инкрементальный парсер SSE-потока: собирает фреймы, разделённые пустой
 * строкой, и вызывает onEvent для каждой JSON-полезной нагрузки.
 * @param {(event: object) => void} onEvent
 * @param {() => void} [onDone] вызывается один раз при `[DONE]`
 */
export function createSseParser(onEvent, onDone) {
  let buffer = '';
  let done = false;

  const emitDone = () => {
    if (done) return;
    done = true;
    if (typeof onDone === 'function') onDone();
  };

  const drain = () => {
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLines = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''));
      if (dataLines.length === 0) continue;
      const payload = dataLines.join('\n');
      if (payload === '[DONE]') {
        emitDone();
        continue;
      }
      try {
        onEvent(JSON.parse(payload));
      } catch {
        // Игнорируем неполные/не-JSON полезные нагрузки.
      }
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      drain();
    },
    flush() {
      if (buffer.trim()) {
        buffer += '\n\n';
        drain();
      }
      emitDone();
    }
  };
}

/**
 * Проксирует один chat-запрос на loopback SSE-эндпоинт и отдаёт события
 * через колбэки onEvent/onDone.
 */
export async function runChatBridge({ baseUrl, payload, fetchImpl, signal, onEvent, onDone }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, stream: true }),
    signal
  });

  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}: не удалось открыть поток чата`);
  }

  const parser = createSseParser(onEvent, onDone);
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    parser.push(decoder.decode(chunk, { stream: true }));
  }
  parser.flush();
}

/**
 * Подключает WebSocket-эндпоинт к http-серверу.
 * @param {import('node:http').Server} httpServer
 * @param {{ getBaseUrl?: () => string, path?: string, fetchImpl?: typeof fetch }} [options]
 */
export function attachWebSocket(httpServer, options = {}) {
  const { getBaseUrl, path = DEFAULT_PATH, fetchImpl } = options;
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let reqPath;
    try {
      reqPath = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (reqPath !== path) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    const controller = new AbortController();
    let busy = false;

    const send = (obj) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    };
    const baseUrl = () => (typeof getBaseUrl === 'function' ? getBaseUrl() : '');
    const doFetch = () => fetchImpl || globalThis.fetch;

    ws.on('close', () => controller.abort());
    ws.on('error', () => controller.abort());

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send({ type: 'error', error: 'Некорректный JSON' });
        return;
      }

      // Ответ UI на запрос подтверждения опасного действия (см. Блок 6.3).
      if (msg?.type === 'confirm') {
        try {
          const res = await doFetch()(`${baseUrl()}/v1/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: msg.id, approved: msg.approved === true })
          });
          send({ type: 'confirm_ack', id: msg.id ?? null, success: res.ok === true });
        } catch (error) {
          send({ type: 'error', error: error.message });
        }
        return;
      }

      if (msg?.type !== 'chat') {
        send({ type: 'error', error: `Неизвестный тип сообщения: ${msg?.type}` });
        return;
      }

      if (busy) {
        send({ type: 'error', error: 'Уже обрабатывается другой запрос' });
        return;
      }

      busy = true;
      try {
        await runChatBridge({
          baseUrl: baseUrl(),
          payload: { messages: msg.messages, strictSandbox: msg.strictSandbox },
          fetchImpl,
          signal: controller.signal,
          onEvent: (event) => send(event),
          onDone: () => send({ type: 'done' })
        });
      } catch (error) {
        if (error?.name !== 'AbortError') {
          send({ type: 'error', error: error.message });
        }
      } finally {
        busy = false;
      }
    });
  });

  return wss;
}
