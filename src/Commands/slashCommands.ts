/**
 * Slash Commands Handler
 * 
 * Handles /command literals in chat input.
 * Commands can be:
 * - Immediate actions (/clear, /new)
 * - Prompt generators (/fix, /project_analysis, /workspace_fix)
 */

export interface SlashCommand {
  name: string;
  description: string;
  /** If true, command is executed immediately without sending to model */
  immediate: boolean;
  /** Arguments pattern (e.g., "<file>" for /fix) */
  args?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'clear', description: 'Очистить историю сообщений в текущей сессии', immediate: true },
  { name: 'new', description: 'Создать новый чат', immediate: true },
  { name: 'fix', description: 'Исправить проблемы в файле', immediate: false, args: '<file>' },
  { name: 'project_analysis', description: 'Анализ структуры и качества проекта', immediate: false },
  { name: 'workspace_fix', description: 'Исправить проблемы во всём workspace', immediate: false },
];

export interface ParsedCommand {
  command: string;
  args: string[];
  raw: string;
}

/**
 * Parse slash command from user input
 * Returns null if input doesn't start with /
 */
export function parseSlashCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  
  // Split by whitespace: /command arg1 arg2
  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0]?.toLowerCase() || '';
  const args = parts.slice(1);
  
  return { command, args, raw: trimmed };
}

/**
 * Check if command is valid
 */
export function isValidCommand(command: string): boolean {
  return SLASH_COMMANDS.some(c => c.name === command);
}

/**
 * Get command definition
 */
export function getCommand(name: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find(c => c.name === name);
}

/**
 * Generate hidden prompt for /fix command
 */
export function generateFixPrompt(filePath: string): string {
  return `Исправь проблемы в файле: ${filePath}

Инструкции:
1. Используй инструмент diagnose чтобы получить список ошибок в файле
2. Если есть синтаксические ошибки - исправь их первыми
3. Затем исправь семантические ошибки
4. Читай только нужные участки файла (не весь файл целиком)
5. После исправления проверь файл снова через diagnose

Не читай файл полностью без необходимости - используй диагностику.`;
}

/**
 * Generate hidden prompt for /project_analysis command
 */
export function generateProjectAnalysisPrompt(): string {
  return `Проанализируй проект.

Шаги анализа:
1. **Структура проекта**: Получи дерево файлов и папок
2. **Ключевые файлы**: Прочитай package.json, tsconfig.json, README.md и другие конфигурационные файлы
3. **Анализ кода**: Используй параметр symbols для получения списка классов, функций, экспортов в ключевых файлах. НЕ читай файлы целиком - только определения и сигнатуры
4. **Точечное чтение**: Если нужны детали реализации - читай только конкретные функции/классы, не весь файл

Формат отчёта:
1. **О проекте**: Краткое описание назначения и технологий
2. **Сильные стороны**: Что сделано хорошо (архитектура, код, практики)
3. **Слабые стороны**: Проблемы и технический долг
4. **Рекомендации**: Конкретные предложения по улучшению с примерами

ВАЖНО: Не читай все файлы полностью - это перегрузит контекст. Используй symbols и точечное чтение.`;
}

/**
 * Generate hidden prompt for /workspace_fix command
 */
export function generateWorkspaceFixPrompt(): string {
  return `Исправь проблемы в проекте.

Инструкции:
1. Используй diagnose для получения ошибок во ВСЕХ файлах (без указания конкретного файла)
2. Если ошибок нет - СПРОСИ у пользователя какую проблему нужно решить
3. НЕ читай файлы целиком без диагностики
4. Исправляй файлы по одному, начиная с синтаксических ошибок
5. После каждого исправления проверяй результат через diagnose

ВАЖНО: 
- Если диагностика не показывает ошибок, но пользователь жалуется - ОБЯЗАТЕЛЬНО спроси детали проблемы
- Не пытайся угадать проблему читая весь код
- Используй инструменты диагностики, а не полное чтение файлов`;
}

/**
 * Process file/folder references in message (#file, #folder/)
 * Returns the message with references extracted
 */
export interface ProcessedMessage {
  /** Message text shown to user (original) */
  displayText: string;
  /** Message text sent to model (with expanded references) */
  modelText: string;
  /** Extracted file/folder references */
  references: Array<{ type: 'file' | 'folder'; path: string }>;
}

export function processHashReferences(input: string): ProcessedMessage {
  const references: Array<{ type: 'file' | 'folder'; path: string }> = [];
  
  // Match #path/to/file or #path/to/folder/
  // Supports: #file.ts, #src/utils.ts, #src/folder/, #"path with spaces.ts"
  const hashPattern = /#(?:"([^"]+)"|([^\s#]+))/g;
  
  let match;
  while ((match = hashPattern.exec(input)) !== null) {
    const path = match[1] || match[2]; // quoted or unquoted
    if (path) {
      const isFolder = path.endsWith('/');
      references.push({
        type: isFolder ? 'folder' : 'file',
        path: isFolder ? path.slice(0, -1) : path
      });
    }
  }
  
  if (references.length === 0) {
    return { displayText: input, modelText: input, references: [] };
  }
  
  // Build model text with reference annotations
  let modelText = input;
  
  // Add context section for model
  const refSection = references.map(r => {
    if (r.type === 'folder') {
      return `[Папка: ${r.path}/ - используй list_dir для просмотра содержимого]`;
    } else {
      return `[Файл: ${r.path} - используй read_file для чтения если нужно]`;
    }
  }).join('\n');
  
  modelText = `${input}\n\n---\nУказанные файлы/папки:\n${refSection}`;
  
  return { displayText: input, modelText, references };
}
