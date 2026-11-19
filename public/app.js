const chatForm = document.getElementById('chat-form');
const userInput = document.getElementById('user-input');
const chatMessages = document.getElementById('chat-messages');
const sendBtn = document.getElementById('send-btn');
const sandboxToggle = document.getElementById('sandbox-toggle');
const sandboxModeLabel = document.getElementById('sandbox-mode-label');

// Локальный массив истории сообщений для передачи контекста агенту
const MAX_HISTORY_MESSAGES = 12;
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

sandboxToggle.addEventListener('change', updateSandboxLabel);
updateSandboxLabel();

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

  const assistantBubble = appendMessage('assistant', '');
  let fullAssistantResponse = '';

  try {
    const response = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: messageHistory, // Передаем обрезанную актуальную историю диалога
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

    // Сохраняем ответ ассистента в историю и следим за лимитом контекста
    if (fullAssistantResponse) {
      messageHistory.push({ role: 'assistant', content: fullAssistantResponse });
      trimHistory();
    }

  } catch (err) {
    assistantBubble.textContent += `\n❌ Ошибка: ${err.message}`;
  } finally {
    userInput.disabled = false;
    sendBtn.disabled = false;
    userInput.focus();
  }
});