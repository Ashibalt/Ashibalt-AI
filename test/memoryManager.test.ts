import { describe, it, expect } from 'vitest';
import { 
  compressToolResult,
  processMessagesForMemory,
  prepareMessagesWithMemory,
  buildContextSummary,
  estimateTokens,
  Message
} from '../src/Engine/SystemContext/memoryManager';

describe('memoryManager', () => {
  
  describe('compressToolResult', () => {
    
    it('should not compress short results', () => {
      const result = compressToolResult('read_file', { filePath: 'test.ts' }, 'short content');
      expect(result.compressed).toBe('short content');
      expect(result.skeleton).toBeUndefined();
    });
    
    it('should compress long file content to skeleton', () => {
      const longContent = `import { foo } from 'bar';
import { baz } from 'qux';

export class LongClass {
  private field: string;
  
  constructor() {
    this.field = '';
  }
  
  methodOne(): void {
    // Very long implementation
    ${Array(50).fill('console.log("line");').join('\n    ')}
  }
  
  methodTwo(): string {
    return this.field;
  }
}

function helperFunction() {
  return true;
}`;
      
      const result = compressToolResult('read_file', { filePath: 'test.ts' }, longContent);
      
      expect(result.compressed.length).toBeLessThan(longContent.length);
      expect(result.filePath).toBe('test.ts');
      expect(result.skeleton).toBeDefined();
      expect(result.compressed).toContain('[Файл прочитан: test.ts]');
    });
    
    it('should truncate non-file long content', () => {
      const longOutput = 'A'.repeat(1000);
      const result = compressToolResult('terminal', { command: 'ls' }, longOutput);
      
      expect(result.compressed).toContain('...[обрезано:');
      expect(result.compressed.length).toBeLessThan(longOutput.length);
    });
  });
  
  describe('processMessagesForMemory', () => {
    
    it('should extract system prompt', () => {
      const messages: Message[] = [
        { role: 'system', content: 'You are an assistant' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' }
      ];
      
      const state = processMessagesForMemory(messages);
      
      expect(state.systemPrompt).toBeDefined();
      expect(state.systemPrompt?.content).toBe('You are an assistant');
    });
    
    it('should keep only last 15 message pairs', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System' }
      ];
      
      // Add 20 pairs (40 messages)
      for (let i = 0; i < 20; i++) {
        messages.push({ role: 'user', content: `User message ${i}` });
        messages.push({ role: 'assistant', content: `Assistant response ${i}` });
      }
      
      const state = processMessagesForMemory(messages);
      
      // Should have 30 messages (15 pairs) in recentMessages
      const userMessages = state.recentMessages.filter(m => m.role === 'user');
      expect(userMessages.length).toBe(15);
      
      // First user message should be #5 (0-4 dropped)
      expect(userMessages[0].content).toBe('User message 5');
    });
    
    it('should track tool usage history', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Read file' },
        { 
          role: 'assistant', 
          content: '', 
          tool_calls: [
            { id: 'call_1', function: { name: 'read_file', arguments: '{"filePath": "test.ts"}' } }
          ]
        },
        { role: 'tool', content: 'file content', tool_call_id: 'call_1', name: 'read_file' },
        { role: 'assistant', content: 'Done' }
      ];
      
      const state = processMessagesForMemory(messages);
      
      expect(state.toolHistory.length).toBe(1);
      expect(state.toolHistory[0].name).toBe('read_file');
      expect(state.toolHistory[0].filePath).toBe('test.ts');
    });
  });
  
  describe('buildContextSummary', () => {
    
    it('should build summary with file skeletons', () => {
      const state = processMessagesForMemory([
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Hello' }
      ]);
      
      state.fileSummaries.set('src/test.ts', '[src/test.ts] 50L | classes:[TestClass:L10{method:L15}]');
      
      const summary = buildContextSummary(state);
      
      expect(summary).toContain('ФАЙЛЫ В КОНТЕКСТЕ');
      expect(summary).toContain('src/test.ts');
    });
    
    it('should build summary with tool history', () => {
      const state = processMessagesForMemory([
        { role: 'system', content: 'System' }
      ]);
      
      state.toolHistory = [
        { name: 'read_file', args: {}, timestamp: Date.now(), filePath: 'a.ts' },
        { name: 'read_file', args: {}, timestamp: Date.now(), filePath: 'b.ts' },
        { name: 'edit_file', args: {}, timestamp: Date.now(), filePath: 'a.ts' }
      ];
      
      const summary = buildContextSummary(state);
      
      expect(summary).toContain('ИСПОЛЬЗОВАННЫЕ ИНСТРУМЕНТЫ');
      expect(summary).toContain('read_file: 2x');
      expect(summary).toContain('edit_file: 1x');
    });
  });
  
  describe('prepareMessagesWithMemory', () => {
    
    it('should return processed messages', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' }
      ];
      
      const result = prepareMessagesWithMemory(messages);
      
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[0].role).toBe('system');
    });
    
    it('should pass through messages unchanged (compression disabled, handled by agentLoop)', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System' }
      ];
      
      // Add many pairs with long content
      for (let i = 0; i < 20; i++) {
        messages.push({ role: 'user', content: `Question ${i}: ${'detail '.repeat(100)}` });
        messages.push({ role: 'assistant', content: `Answer ${i}: ${'response '.repeat(100)}` });
      }
      
      const tokensBefore = estimateTokens(messages);
      // prepareMessagesWithMemory is now a pass-through—all compression is in agentLoop mid-loop
      const result = prepareMessagesWithMemory(messages, 5000);
      const tokensAfter = estimateTokens(result);
      
      // Messages should be returned unchanged
      expect(tokensAfter).toBe(tokensBefore);
      expect(result.length).toBe(messages.length);
    });

    it('should NOT compress when context fits within threshold', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System' }
      ];
      
      // Add a few pairs — should not be compressed with large context window
      for (let i = 0; i < 5; i++) {
        messages.push({ role: 'user', content: `Question ${i}` });
        messages.push({ role: 'assistant', content: `Answer ${i}` });
      }
      
      const tokensBefore = estimateTokens(messages);
      const result = prepareMessagesWithMemory(messages, 128000);
      const tokensAfter = estimateTokens(result);
      
      expect(tokensAfter).toBe(tokensBefore);
      expect(result.length).toBe(messages.length);
    });
  });
  
  describe('estimateTokens', () => {
    
    it('should estimate tokens correctly', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello world' } // 11 chars + 20 overhead = 31 / 4 ≈ 8 tokens
      ];
      
      const tokens = estimateTokens(messages);
      
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(20);
    });
    
    it('should include tool_calls in estimation', () => {
      const messagesWithoutTools: Message[] = [
        { role: 'assistant', content: 'Text' }
      ];
      
      const messagesWithTools: Message[] = [
        { 
          role: 'assistant', 
          content: 'Text',
          tool_calls: [{ id: '1', function: { name: 'test', arguments: '{"a":1}' } }]
        }
      ];
      
      const tokensWithout = estimateTokens(messagesWithoutTools);
      const tokensWith = estimateTokens(messagesWithTools);
      
      expect(tokensWith).toBeGreaterThan(tokensWithout);
    });
  });
});
