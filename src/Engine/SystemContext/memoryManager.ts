/**
 * Memory Manager
 * 
 * Управляет памятью модели для эффективного использования контекста:
 * 
 * Стратегия (оптимизирована для Devstral с 256K контекстом):
 * 1. Хранить последние 10 пар сообщений (user + assistant)
 * 2. Для tool результатов - хранить скелеты файлов вместо полного содержимого
 * 3. Сохранять информацию об использованных инструментах
 * 4. При приближении к лимиту - агрессивное сжатие
 * 
 * Это позволяет модели помнить:
 * - Что делал пользователь
 * - Какие файлы были затронуты и их структуру
 * - Какие инструменты использовались и с какими аргументами
 * 
 * Based on research: sliding window + summary compression for context management
 */

import { extractSkeleton, formatSkeletonCompact } from './fileSkeletonExtractor';
import { logger } from '../../logger';

// Конфигурация
const MAX_MESSAGE_PAIRS = 15;  // 15 пар = 30 сообщений (user + assistant) — more memory for model
const MAX_TOOL_RESULT_LENGTH = 800;  // Increased: model was forgetting file contents with 300
const DEFAULT_MAX_CONTEXT_TOKENS = 50000;  // Default for models without known context window
const DEFAULT_AGGRESSIVE_THRESHOLD = 45000;  // Default pre-emptive compression threshold

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}

export interface ToolUsageRecord {
  name: string;
  args: Record<string, any>;
  timestamp: number;
  filePath?: string;  // Если инструмент работал с файлом
  skeleton?: string;  // Скелет файла (если применимо)
}

export interface MemoryState {
  systemPrompt: Message | null;
  recentMessages: Message[];  // Последние 10 пар
  toolHistory: ToolUsageRecord[];  // История использования инструментов
  fileSummaries: Map<string, string>;  // Скелеты файлов: путь -> скелет
}

/**
 * Определяет, является ли контент файлом на основе результата инструмента
 */
function isFileContent(toolName: string, content: string): boolean {
  // Инструменты, которые возвращают содержимое файлов
  const fileTools = ['read_file', 'edit_file', 'create_file', 'search_in_file'];
  if (fileTools.includes(toolName)) {
    return true;
  }
  
  // Эвристика: если контент выглядит как код
  const codeIndicators = [
    /^import\s+/m,
    /^from\s+\w+\s+import/m,
    /^(const|let|var|function|class|interface|type)\s+/m,
    /^def\s+\w+\s*\(/m,
    /^export\s+(default\s+)?(const|let|var|function|class)/m,
  ];
  
  return codeIndicators.some(pattern => pattern.test(content));
}

/**
 * Извлекает путь к файлу из аргументов инструмента
 */
function extractFilePath(toolName: string, args: Record<string, any>): string | undefined {
  // Разные инструменты используют разные имена параметров
  const pathParams = ['filePath', 'file_path', 'path', 'file'];
  for (const param of pathParams) {
    if (args[param] && typeof args[param] === 'string') {
      return args[param];
    }
  }
  return undefined;
}

/**
 * Сжимает результат инструмента, заменяя содержимое файла на скелет
 */
export function compressToolResult(
  toolName: string, 
  toolArgs: Record<string, any>,
  result: string
): { compressed: string; skeleton?: string; filePath?: string } {
  
  // Короткие результаты не сжимаем
  if (result.length <= MAX_TOOL_RESULT_LENGTH) {
    return { compressed: result };
  }
  
  const filePath = extractFilePath(toolName, toolArgs);
  
  // Если это файловый контент - извлекаем скелет
  if (filePath && isFileContent(toolName, result)) {
    try {
      const skeleton = extractSkeleton(result, filePath);
      const formatted = formatSkeletonCompact(skeleton);
      
      logger.log(`[MEMORY] Compressed ${toolName} result: ${result.length} -> ${formatted.length} chars`);
      
      return {
        compressed: `[Файл прочитан: ${filePath}]\n${formatted}`,
        skeleton: formatted,
        filePath
      };
    } catch (err: any) {
      logger.log(`[MEMORY] Failed to extract skeleton: ${err.message}`);
    }
  }
  
  // Для других длинных результатов - просто обрезаем
  const truncated = result.slice(0, MAX_TOOL_RESULT_LENGTH) + 
    `\n...[обрезано: ${result.length - MAX_TOOL_RESULT_LENGTH} символов]`;
  
  return { compressed: truncated };
}

/**
 * Обрабатывает сообщения и применяет стратегию памяти
 */
export function processMessagesForMemory(messages: Message[]): MemoryState {
  const state: MemoryState = {
    systemPrompt: null,
    recentMessages: [],
    toolHistory: [],
    fileSummaries: new Map()
  };
  
  // Извлекаем системный промпт
  if (messages.length > 0 && messages[0].role === 'system') {
    state.systemPrompt = messages[0];
    messages = messages.slice(1);
  }
  
  // Собираем информацию об инструментах из всех сообщений
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        try {
          const args = JSON.parse(tc.function?.arguments || '{}');
          const record: ToolUsageRecord = {
            name: tc.function?.name || 'unknown',
            args,
            timestamp: Date.now(),
            filePath: extractFilePath(tc.function?.name, args)
          };
          state.toolHistory.push(record);
        } catch {
          // Игнорируем ошибки парсинга
        }
      }
    }
  }
  
  // Считаем пары сообщений (user + assistant)
  // Пара = user message + все последующие assistant/tool messages до следующего user
  const pairs: Message[][] = [];
  let currentPair: Message[] = [];
  
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (currentPair.length > 0) {
        pairs.push(currentPair);
      }
      currentPair = [msg];
    } else {
      currentPair.push(msg);
    }
  }
  
  if (currentPair.length > 0) {
    pairs.push(currentPair);
  }
  
  // Берём последние MAX_MESSAGE_PAIRS пар
  const recentPairs = pairs.slice(-MAX_MESSAGE_PAIRS);
  
  // Сжимаем tool результаты в выбранных сообщениях
  // IMPORTANT: clone messages to avoid mutating originals (which would break
  // prompt caching if the same message objects are reused across API calls)
  for (const pair of recentPairs) {
    for (let mi = 0; mi < pair.length; mi++) {
      let msg = pair[mi];
      if (msg.role === 'tool' && msg.content && msg.name) {
        // Clone before mutating
        msg = { ...msg };
        pair[mi] = msg;
        // Находим соответствующий tool_call для получения аргументов
        const toolCallId = msg.tool_call_id;
        let args: Record<string, any> = {};
        
        // Ищем аргументы в предыдущих assistant сообщениях
        for (const prevPair of recentPairs) {
          for (const prevMsg of prevPair) {
            if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
              const tc = prevMsg.tool_calls.find((t: any) => t.id === toolCallId);
              if (tc) {
                try {
                  args = JSON.parse(tc.function?.arguments || '{}');
                } catch {}
              }
            }
          }
        }
        
        const compressed = compressToolResult(msg.name!, args, msg.content);
        msg.content = compressed.compressed;
        
        if (compressed.filePath && compressed.skeleton) {
          state.fileSummaries.set(compressed.filePath, compressed.skeleton);
        }
      }
      
      state.recentMessages.push(msg);
    }
  }
  
  return state;
}

/**
 * Формирует сводку контекста для добавления в системный промпт
 */
export function buildContextSummary(state: MemoryState): string {
  const lines: string[] = [];
  
  // Уникальные файлы, с которыми работали
  if (state.fileSummaries.size > 0) {
    lines.push('=== ФАЙЛЫ В КОНТЕКСТЕ ===');
    for (const [path, skeleton] of state.fileSummaries) {
      lines.push(skeleton);
    }
    lines.push('');
  }
  
  // Краткая история инструментов (без дублирования)
  if (state.toolHistory.length > 0) {
    lines.push('=== ИСПОЛЬЗОВАННЫЕ ИНСТРУМЕНТЫ ===');
    
    // Группируем по инструментам для краткости
    const toolCounts = new Map<string, number>();
    const toolFiles = new Map<string, Set<string>>();
    
    for (const record of state.toolHistory) {
      const count = toolCounts.get(record.name) || 0;
      toolCounts.set(record.name, count + 1);
      
      if (record.filePath) {
        if (!toolFiles.has(record.name)) {
          toolFiles.set(record.name, new Set());
        }
        toolFiles.get(record.name)!.add(record.filePath);
      }
    }
    
    for (const [tool, count] of toolCounts) {
      const files = toolFiles.get(tool);
      if (files && files.size > 0) {
        const fileList = Array.from(files).slice(0, 5).join(', ');
        const more = files.size > 5 ? ` и ещё ${files.size - 5}` : '';
        lines.push(`  ${tool}: ${count}x → ${fileList}${more}`);
      } else {
        lines.push(`  ${tool}: ${count}x`);
      }
    }
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * Агрессивно сжимает сообщение для экономии токенов
 */
function aggressivelyCompressMessage(msg: Message): Message {
  const compressed = { ...msg };
  
  if (msg.role === 'tool' && msg.content) {
    // Для tool результатов - оставляем только краткую суммарию
    if (msg.content.length > 200) {
      const lines = msg.content.split('\n');
      const firstLines = lines.slice(0, 3).join('\n');
      compressed.content = `${firstLines}\n...[сжато: ${lines.length} строк]`;
    }
  }
  
  if (msg.role === 'assistant' && msg.content) {
    // Для ответов ассистента - сохраняем важное
    if (msg.content.length > 500) {
      // Сохраняем первые и последние строки
      const lines = msg.content.split('\n');
      if (lines.length > 10) {
        const first5 = lines.slice(0, 5).join('\n');
        const last3 = lines.slice(-3).join('\n');
        compressed.content = `${first5}\n...[сжато: ${lines.length - 8} строк]...\n${last3}`;
      }
    }
  }
  
  return compressed;
}

/**
 * Главная функция: подготавливает сообщения для отправки в API
 * 
 * СТРАТЕГИЯ: НЕ сжимаем, пока контекст помещается в окно модели.
 * Сжатие применяется ТОЛЬКО когда текущий контекст превышает пороги.
 * Это критически важно — модель должна помнить прочитанные файлы и контекст.
 * 
 * Пороги:
 *   - aggressiveThreshold (60% окна) — начинаем превентивно сжимать старые tool результаты
 *   - maxContextTokens (70% окна) — агрессивное сжатие + удаление старых сообщений
 */
export function prepareMessagesWithMemory(messages: Message[], contextLength?: number): Message[] {
  // DISABLED: This function previously applied graduated compression (skeleton extraction,
  // tool result truncation, aggressive message removal). This CONFLICTED with the
  // cache-friendly drop-compression in agentLoop.ts, causing:
  //   - Loss of tool results (model couldn't see edit_file success)
  //   - File content replaced with skeletons (model couldn't compose correct old_string)
  //   - Double compression destroying prompt cache
  //
  // All context management is now handled SOLELY by agentLoop.ts mid-loop compression,
  // which drops complete assistant+tool groups from the oldest end while keeping
  // remaining messages byte-identical for prompt cache hits.
  
  const currentTokens = estimateTokens(messages);
  logger.log(`[MEMORY] Pass-through: ${messages.length} msgs, ~${currentTokens} tok | model context: ${contextLength ?? 'UNKNOWN'}`);
  
  return messages;
}

/**
 * Оценка количества токенов (примерная)
 */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += msg.content?.length || 0;
    if (msg.tool_calls) {
      chars += JSON.stringify(msg.tool_calls).length;
    }
    chars += 20; // overhead
  }
  return Math.ceil(chars / 4);
}
