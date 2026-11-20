export const DEFAULT_MAX_CONTEXT_MESSAGES = 12;
export const DEFAULT_MAX_CHARS_PER_MESSAGE = 2000;

export function pruneMessages(
  messages,
  maxMessages = DEFAULT_MAX_CONTEXT_MESSAGES,
  maxCharsPerMessage = DEFAULT_MAX_CHARS_PER_MESSAGE
) {
  if (!Array.isArray(messages)) return [];

  const normalized = messages
    .filter((msg) => msg && typeof msg.content === 'string' && msg.content.trim().length > 0)
    .map((msg) => {
      const content = msg.content.trim();
      const clipped = content.length > maxCharsPerMessage
        ? `${content.slice(0, maxCharsPerMessage)}\n...[обрезано для экономии контекста]`
        : content;
      return {
        role: msg.role === 'assistant' || msg.role === 'system' ? msg.role : 'user',
        content: clipped
      };
    });

  return normalized.slice(-maxMessages);
}

export function buildRecentHistoryBlock(prunedMessages) {
  if (prunedMessages.length <= 1) return '';
  const historySlice = prunedMessages.slice(0, -1).slice(-6);
  const formatted = historySlice
    .map((m) => `${m.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${m.content}`)
    .join('\n');
  return `\nКРАТКИЙ КОНТЕКСТ ПОСЛЕДНИХ СООБЩЕНИЙ ДИАЛОГА:\n${formatted}\n`;
}