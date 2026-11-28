// tools/hello.plugin.mjs
// Пример плагинного инструмента (Блок 6.5).
//
// Любой файл `tools/*.plugin.mjs` (или `*.plugin.js`) автоматически
// загружается при старте сервера и добавляется в реестр инструментов.
// Имя `hello` станет доступно модели как обычный инструмент `hello`.
//
// ВНИМАНИЕ: плагин исполняется в том же процессе, что и сервер. Не загружайте
// сюда чужой код. Для инструментов, требующих подтверждения пользователя,
// добавьте `export const dangerous = true;`.

export const name = 'hello';
export const description = 'Приветствует пользователя по имени. Аргументы: { "name": "имя" }';

export async function execute(args = {}) {
  const who = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'мир';
  return { success: true, message: `Привет, ${who}!` };
}
