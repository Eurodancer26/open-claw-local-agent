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
  let fullAssistantResponse = '';

  try {
    const response = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: messageHistory,
        stream: true,
        strictSandbox: sandboxToggle.checked
      })
    });

    if (!response.ok) {
      throw new Error(`Ошибка сервера: ${response.status}`);
    }

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

        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullAssistantResponse += delta;
            assistantBubble.textContent = fullAssistantResponse;
            chatMessages.scrollTop = chatMessages.scrollHeight;
          }
        } catch {
          // Игнорируем неполные чанки
        }
      }
    }

    if (fullAssistantResponse) {
      messageHistory.push({ role: 'assistant', content: fullAssistantResponse });
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