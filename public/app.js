const chatForm = document.getElementById('chat-form');
const userInput = document.getElementById('user-input');
const chatMessages = document.getElementById('chat-messages');
const sendBtn = document.getElementById('send-btn');
const sandboxToggle = document.getElementById('sandbox-toggle');
const sandboxModeLabel = document.getElementById('sandbox-mode-label');
const resetSessionBtn = document.getElementById('reset-session-btn');

// T6: лимит истории приходит с сервера (/v1/mind -> dialogHistory),
// значение ниже — только до первого ответа сервера.
let MAX_HISTORY_MESSAGES = 12;
let messageHistory = [];

function trimHistory() {
  if (messageHistory.length > MAX_HISTORY_MESSAGES) {
    messageHistory = messageHistory.slice(-MAX_HISTORY_MESSAGES);
  }
}

function updateSandboxLabel() {
  if (sandboxToggle.checked) {
    sandboxModeLabel.textContent = '🔒 Песочница (Строго)';
    sandboxModeLabel.classList.remove('sandbox-control__label--free');
  } else {
    sandboxModeLabel.textContent = '🔓 Свободный режим';
    sandboxModeLabel.classList.add('sandbox-control__label--free');
  }
}

async function syncMindState() {
  try {
    const res = await fetch('/v1/mind');
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.strictSandbox === 'boolean') {
      sandboxToggle.checked = data.strictSandbox;
    } else if (data.mode === 'strict' || data.mode === 'free') {
      sandboxToggle.checked = data.mode === 'strict';
    }
    const serverLimit = data?.dialogHistory?.maxMessages;
    if (Number.isInteger(serverLimit) && serverLimit > 0) {
      MAX_HISTORY_MESSAGES = serverLimit;
      trimHistory();
    }
    updateSandboxLabel();
  } catch {
    updateSandboxLabel();
  }
}

sandboxToggle.addEventListener('change', updateSandboxLabel);
updateSandboxLabel();
syncMindState();

function appendMessage(role, text = '') {
  const wrapper = document.createElement('div');
  wrapper.className = `message message--${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'message__bubble';
  bubble.textContent = text;

  wrapper.appendChild(bubble);
  chatMessages.appendChild(wrapper);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return bubble;
}

function renderWelcomeMessage() {
  chatMessages.innerHTML = '';
  const modeText = sandboxToggle.checked
    ? 'строгий режим песочницы — все файлы автоматически изолируются в tests/sandbox/.'
    : 'свободный режим — разрешена работа в пределах проекта с уточнением целевой папки.';

  appendMessage(
    'assistant',
    `Привет! Я твой локальный агент. Напиши задачу, и я разобью её на шаги, выполню и выведу результат.\n\nСейчас включен ${modeText}`
  );
}

resetSessionBtn.addEventListener('click', async () => {
  resetSessionBtn.disabled = true;
  sendBtn.disabled = true;
  userInput.disabled = true;

  try {
    await fetch('/v1/session/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strictSandbox: sandboxToggle.checked })
    });
    messageHistory = [];
    renderWelcomeMessage();
  } catch (err) {
    appendMessage('assistant', `❌ Не удалось сбросить сессию: ${err.message}`);
  } finally {
    resetSessionBtn.disabled = false;
    sendBtn.disabled = false;
    userInput.disabled = false;
    userInput.focus();
  }
});

// Блок 6.3: инлайн-подтверждение опасного действия в чате (без window.confirm).
function requestUserConfirmation(payload) {
  return new Promise((resolve) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'message message--assistant';

    const bubble = document.createElement('div');
    bubble.className = 'message__bubble confirm-bubble';

    const title = document.createElement('div');
    title.className = 'confirm-title';
    title.textContent = `⚠️ Требуется подтверждение: ${payload.tool}`;

    const detail = document.createElement('pre');
    detail.className = 'confirm-detail';
    detail.textContent = JSON.stringify(payload.arguments ?? {}, null, 2);

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'confirm-btn confirm-btn--yes';
    yes.textContent = 'Подтвердить';

    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'confirm-btn confirm-btn--no';
    no.textContent = 'Отменить';

    const finish = (approved) => {
      yes.disabled = true;
      no.disabled = true;
      resolve(approved);
    };
    yes.addEventListener('click', () => finish(true));
    no.addEventListener('click', () => finish(false));

    actions.appendChild(yes);
    actions.appendChild(no);
    bubble.appendChild(title);
    bubble.appendChild(detail);
    bubble.appendChild(actions);
    wrapper.appendChild(bubble);
    chatMessages.appendChild(wrapper);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
}

// Блок 6.4: выбор транспорта — SSE (по умолчанию) или WebSocket.
const transportSelect = document.getElementById('transport-select');

function applyDelta(parsed, state, bubble) {
  const delta = parsed.choices?.[0]?.delta?.content;
  if (delta) {
    state.full += delta;
    bubble.textContent = state.prefix + state.full;
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return true;
  }
  return false;
}

async function handleConfirmEvent(parsed, state, bubble, confirmFn) {
  const approved = await requestUserConfirmation(parsed);
  try {
    await confirmFn(parsed.id, approved);
  } catch {
    // Сервер отклонит действие по таймауту, если ответ не дошёл.
  }
  state.prefix += approved ? '✅ Подтверждено\n' : '⛔ Отменено\n';
  bubble.textContent = state.prefix + state.full;
}

// SSE-транспорт (по умолчанию).
async function streamViaSSE(messages, strictSandbox, state, bubble) {
  const response = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, stream: true, strictSandbox })
  });

  if (!response.ok) throw new Error(`Ошибка сервера: ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue; // неполный чанк
      }

      if (parsed.type === 'confirmation_request') {
        await handleConfirmEvent(parsed, state, bubble, (id, approved) =>
          fetch('/v1/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, approved })
          })
        );
        continue;
      }

      applyDelta(parsed, state, bubble);
    }
  }
}

// WebSocket-транспорт: сервер проксирует тот же chat-поток.
function streamViaWebSocket(messages, strictSandbox, state, bubble) {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/v1/ws`);
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'chat', messages, strictSandbox }));
    });

    ws.addEventListener('message', async (ev) => {
      let parsed;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (parsed.type === 'done') {
        ws.close();
        finish(resolve);
        return;
      }
      if (parsed.type === 'error') {
        ws.close();
        finish(reject, new Error(parsed.error || 'Ошибка WebSocket'));
        return;
      }
      if (parsed.type === 'confirmation_request') {
        await handleConfirmEvent(parsed, state, bubble, (id, approved) => {
          ws.send(JSON.stringify({ type: 'confirm', id, approved }));
        });
        return;
      }

      applyDelta(parsed, state, bubble);
    });

    ws.addEventListener('error', () => finish(reject, new Error('Соединение WebSocket разорвано')));
    ws.addEventListener('close', () => finish(resolve));
  });
}

async function streamChat(messages, strictSandbox, state, bubble) {
  const transport = transportSelect && transportSelect.value === 'ws' ? 'ws' : 'sse';
  if (transport === 'ws') {
    return streamViaWebSocket(messages, strictSandbox, state, bubble);
  }
  return streamViaSSE(messages, strictSandbox, state, bubble);
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = userInput.value.trim();
  if (!text) return;

  appendMessage('user', text);
  messageHistory.push({ role: 'user', content: text });
  trimHistory();

  userInput.value = '';
  userInput.disabled = true;
  sendBtn.disabled = true;
  resetSessionBtn.disabled = true;

  const assistantBubble = appendMessage('assistant', '');
  const state = { prefix: '', full: '' };

  try {
    await streamChat(messageHistory, sandboxToggle.checked, state, assistantBubble);
    if (state.full) {
      messageHistory.push({ role: 'assistant', content: state.full });
      trimHistory();
    }
  } catch (err) {
    assistantBubble.textContent += `\n❌ Ошибка: ${err.message}`;
  } finally {
    userInput.disabled = false;
    sendBtn.disabled = false;
    resetSessionBtn.disabled = false;
    userInput.focus();
  }
});
