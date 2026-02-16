import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      appendLine: () => {},
      append: () => {},
      show: () => {},
      clear: () => {}
    })
  },
  workspace: {
    getConfiguration: () => ({ get: () => undefined })
  }
}));

import { estimateTokenCount, type Message } from '../src/Engine/SystemContext/contextSummarizer';

describe('estimateTokenCount', () => {
  it('should estimate tokens for simple messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello world' }
    ];
    const tokens = estimateTokenCount(messages);
    // "Hello world" = 11 chars, +20 overhead = 31 / 4 = ~8
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });

  it('should handle empty messages', () => {
    const tokens = estimateTokenCount([]);
    expect(tokens).toBe(0);
  });

  it('should account for tool_calls', () => {
    const withTool: Message[] = [
      { 
        role: 'assistant', 
        content: 'thinking...',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"test.ts"}' } }]
      }
    ];
    const withoutTool: Message[] = [
      { role: 'assistant', content: 'thinking...' }
    ];
    expect(estimateTokenCount(withTool)).toBeGreaterThan(estimateTokenCount(withoutTool));
  });

  it('should account for tool response metadata', () => {
    const toolResponse: Message[] = [
      { role: 'tool', content: 'file contents here', tool_call_id: 'call_123', name: 'read_file' }
    ];
    const tokens = estimateTokenCount(toolResponse);
    expect(tokens).toBeGreaterThan(0);
  });

  it('should scale linearly with content length', () => {
    const short: Message[] = [{ role: 'user', content: 'a'.repeat(100) }];
    const long: Message[] = [{ role: 'user', content: 'a'.repeat(1000) }];
    const shortTokens = estimateTokenCount(short);
    const longTokens = estimateTokenCount(long);
    // Long should be roughly 10x more (±overhead)
    expect(longTokens).toBeGreaterThan(shortTokens * 5);
    expect(longTokens).toBeLessThan(shortTokens * 15);
  });

  it('should handle multiple messages', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is 2+2?' },
      { role: 'assistant', content: 'The answer is 4.' }
    ];
    const tokens = estimateTokenCount(messages);
    expect(tokens).toBeGreaterThan(10);
  });
});
