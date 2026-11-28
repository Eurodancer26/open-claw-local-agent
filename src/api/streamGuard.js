// src/api/streamGuard.js
export function createAbortError(message = 'Генерация прервана: клиент разорвал соединение') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/**
 * Гоняет длительную операцию (генерацию/исполнение плана) против обрыва клиента:
 * как только клиент ушёл — промис отклоняется AbortError.
 */
export async function raceAgainstClientAbort(operation, guard) {
  let removeListener = null;
  const abortPromise = new Promise((_, reject) => {
    if (guard.clientGone) {
      reject(createAbortError());
      return;
    }
    removeListener = guard.onClientGone((err) => reject(createAbortError(err?.message)));
  });

  try {
    return await Promise.race([Promise.resolve(operation), abortPromise]);
  } finally {
    if (removeListener) removeListener();
  }
}

/**
 * Отслеживает обрыв соединения клиента для стриминговых (SSE) ответов
 * и даёт безопасные write/end + AbortSignal для остановки генерации.
 *
 * Почему НЕ req.on('close'):
 *   В Node 18+ / Express 5 событие 'close' на req срабатывает при ПОЛНОМ
 *   ЧТЕНИИ тела запроса (сразу после парсинга JSON), а не при обрыве
 *   соединения. Использовать его как признак disconnect нельзя — иначе
 *   пришлось бы прерывать каждую генерацию.
 *
 * Реальные признаки обрыва:
 *   - res 'close' при !res.writableEnded — мы не успели/не смогли завершить ответ;
 *   - legacy 'aborted' на req (старые версии Node, часть прокси).
 */
export function createClientAbortGuard(req, res) {
  const controller = new AbortController();
  const listeners = new Set();
  let clientGone = false;

  const markClientGone = (reason) => {
    if (clientGone) return;
    // Ответ штатно закрыт нами — это завершение, а не обрыв.
    if (res.writableEnded) return;
    clientGone = true;
    // Обрыв всегда публикуем как AbortError: вызывающий код ловит его по name.
    const err = reason instanceof Error ? reason : createAbortError(reason || undefined);
    if (err.name === 'Error') {
      err.name = 'AbortError';
    }
    controller.abort(err);
    for (const fn of [...listeners]) {
      try {
        fn(err);
      } catch (e) {
        console.error('[streamGuard] onClientGone threw:', e?.message || e);
      }
    }
  };

  const onResClose = () => {
    if (!res.writableEnded) {
      markClientGone(createAbortError('Клиент разорвал соединение (res close)'));
    }
  };
  const onReqAborted = () => {
    markClientGone(createAbortError('Клиент разорвал соединение (req aborted)'));
  };

  res.on('close', onResClose);
  req.on('aborted', onReqAborted);

  return {
    get clientGone() {
      return clientGone;
    },
    get signal() {
      return controller.signal;
    },
    /** Можно ли ещё писать в ответ. */
    isResponseWritable() {
      return !clientGone && !res.writableEnded && !res.destroyed;
    },
    onClientGone(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Запись в поток: молча пропускается, если клиент уже ушёл. */
    send(payload) {
      if (!this.isResponseWritable()) return false;
      try {
        res.write(payload);
        return true;
      } catch (e) {
        markClientGone(e);
        return false;
      }
    },
    end(payload) {
      if (payload !== undefined) this.send(payload);
      if (!this.isResponseWritable()) return false;
      try {
        res.end();
        return true;
      } catch (e) {
        markClientGone(e);
        return false;
      }
    },
    dispose() {
      res.off('close', onResClose);
      req.off('aborted', onReqAborted);
      listeners.clear();
    }
  };
}
