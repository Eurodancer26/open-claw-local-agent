// src/api/confirmGate.js
// Блок 6.3: серверный гейт интерактивного подтверждения опасных действий.
// SSE односторонний, поэтому UI отвечает отдельным запросом POST /v1/confirm.
import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 60_000;

export class ConfirmGate {
  constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }

  get size() {
    return this.pending.size;
  }

  /**
   * Запрашивает подтверждение действия и ждёт ответа UI.
   * @param {object} payload данные для UI (tool, arguments)
   * @param {(id: string, payload: object) => void} [onRequest] колбэк отправки события в UI
   * @param {AbortSignal} [signal] обрыв клиента → немедленный отказ
   * @returns {Promise<{ allowed: boolean, reason: string, id: string }>}
   */
  request(payload, onRequest, signal) {
    const id = randomUUID();

    return new Promise((resolve) => {
      let cleanupAbort = null;

      const settle = (allowed, reason) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        if (cleanupAbort) cleanupAbort();
        resolve({ allowed, reason, id });
      };

      const timer = setTimeout(() => settle(false, 'timeout'), this.timeoutMs);
      this.pending.set(id, { settle, timer });

      if (signal && typeof signal.addEventListener === 'function') {
        if (signal.aborted) {
          settle(false, 'aborted');
          return;
        }
        const onAbort = () => settle(false, 'aborted');
        signal.addEventListener('abort', onAbort, { once: true });
        cleanupAbort = () => signal.removeEventListener('abort', onAbort);
      }

      try {
        if (typeof onRequest === 'function') onRequest(id, payload);
      } catch {
        // Ошибка отправки события не должна подвешивать ожидание: сработает таймаут.
      }
    });
  }

  /**
   * Ответ UI на запрос подтверждения.
   * @returns {boolean} существовал ли такой запрос
   */
  settle(id, approved) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.settle(approved === true, approved === true ? 'approved' : 'denied');
    return true;
  }
}
