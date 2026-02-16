import { logger } from '../../logger';
import { prepareMessagesWithMemory, estimateTokens as memoryEstimateTokens } from './memoryManager';

const CHARS_PER_TOKEN = 4;

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export function estimateTokenCount(messages: Message[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      totalChars += msg.content.length;
    }
    if (msg.tool_calls) {
      totalChars += JSON.stringify(msg.tool_calls).length;
    }
    if (msg.role === 'tool') {
      if (msg.tool_call_id) {
        totalChars += msg.tool_call_id.length;
      }
      if (msg.name) {
        totalChars += msg.name.length;
      }
    }
    totalChars += 20;
  }
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

export async function prepareMessagesForApi(
  messages: Message[],
  _apiKey?: string,
  _baseUrl?: string,
  options?: {
    onStatusChange?: (status: 'idle' | 'summarizing') => void;
    contextLength?: number;
  }
): Promise<Message[]> {
  logger.log('[CONTEXT] Processing ' + messages.length + ' messages');
  
  const tokensBefore = memoryEstimateTokens(messages);
  const result = prepareMessagesWithMemory(messages, options?.contextLength);
  const tokensAfter = memoryEstimateTokens(result);
  
  if (tokensBefore !== tokensAfter) {
    logger.log('[CONTEXT] Memory optimized: ' + tokensBefore + ' -> ' + tokensAfter + ' tokens');
  }
  
  options?.onStatusChange?.('idle');
  return result;
}
