import { describe, it, expect, vi } from 'vitest';

// Mock vscode before importing toolCalling
vi.mock('vscode', () => {
  return {
    window: {
      createTerminal: vi.fn(() => ({
        exitStatus: undefined,
        show: vi.fn(),
        sendText: vi.fn(),
        shellIntegration: undefined
      })),
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(),
        append: vi.fn(),
        show: vi.fn(),
        clear: vi.fn(),
        dispose: vi.fn()
      })),
      showWarningMessage: vi.fn(async () => 'Выполнить'),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn()
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: 'C:/ws' } }],
      fs: {
        readFile: vi.fn(async () => Buffer.from('test content')),
        writeFile: vi.fn(async () => {}),
        stat: vi.fn(async () => ({ type: 1 })),
        createDirectory: vi.fn(async () => {}),
        delete: vi.fn(async () => {})
      },
      openTextDocument: vi.fn(async () => ({
        getText: () => '',
        lineAt: () => ({ text: '' }),
        lineCount: 10
      })),
      getConfiguration: vi.fn(() => ({
        get: () => undefined,
        update: vi.fn(async () => {})
      }))
    },
    Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file', path: p }) },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    Range: class { constructor(public s: number, public sc: number, public e: number, public ec: number) {} },
    Position: class { constructor(public line: number, public character: number) {} },
    TextEdit: { replace: vi.fn() },
    WorkspaceEdit: class { replace() {} },
    languages: {
      createDiagnosticCollection: () => ({ set: vi.fn(), clear: vi.fn(), delete: vi.fn(), dispose: vi.fn() })
    }
  };
});

describe('toolCalling', () => {
  describe('tools array', () => {
    it('should export tool definitions', async () => {
      const { tools } = await import('../src/Engine/toolCalling');
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(5);
    });

    it('should include core tools', async () => {
      const { tools } = await import('../src/Engine/toolCalling');
      const names = tools.map(t => t.function.name);
      expect(names).toContain('read_file');
      expect(names).toContain('edit_file');
      expect(names).toContain('create_file');
      expect(names).toContain('delete_file');
      expect(names).toContain('terminal');
      expect(names).toContain('search');
      expect(names).toContain('list_files');
      expect(names).toContain('diagnose');
    });

    it('should include read_terminal_output tool', async () => {
      const { tools } = await import('../src/Engine/toolCalling');
      const names = tools.map(t => t.function.name);
      expect(names).toContain('read_terminal_output');
    });

    it('should NOT include attempt_completion', async () => {
      const { tools } = await import('../src/Engine/toolCalling');
      const names = tools.map(t => t.function.name);
      expect(names).not.toContain('attempt_completion');
    });

    it('terminal tool should have background parameter', async () => {
      const { tools } = await import('../src/Engine/toolCalling');
      const terminal = tools.find(t => t.function.name === 'terminal');
      expect(terminal).toBeTruthy();
      expect(terminal!.function.parameters.properties.background).toBeTruthy();
      expect(terminal!.function.parameters.properties.background.type).toBe('boolean');
    });
  });

  describe('chatTools', () => {
    it('should be a subset of tools (read-only)', async () => {
      const { chatTools, tools } = await import('../src/Engine/toolCalling');
      expect(chatTools.length).toBeLessThan(tools.length);
      
      const chatNames = chatTools.map(t => t.function.name);
      // Should NOT include edit/create/delete/terminal
      expect(chatNames).not.toContain('edit_file');
      expect(chatNames).not.toContain('create_file');
      expect(chatNames).not.toContain('delete_file');
      expect(chatNames).not.toContain('terminal');
      // Should include read-only tools
      expect(chatNames).toContain('read_file');
      expect(chatNames).toContain('search');
      expect(chatNames).toContain('read_terminal_output');
    });
  });

  describe('executeTool validation', () => {
    it('should reject disabled tools', async () => {
      const { executeTool } = await import('../src/Engine/toolCalling');
      const result = await executeTool('find_references', {}, 'C:/ws');
      expect(result.error).toContain('disabled');
    });

    it('should reject terminal with empty command', async () => {
      const { executeTool } = await import('../src/Engine/toolCalling');
      const result = await executeTool('terminal', { command: '' }, 'C:/ws');
      expect(result.error).toBeTruthy();
    });

    it('should reject read_file without file_path', async () => {
      const { executeTool } = await import('../src/Engine/toolCalling');
      const result = await executeTool('read_file', {}, 'C:/ws');
      expect(result.error).toBeTruthy();
    });

    it('should reject edit_file without required params', async () => {
      const { executeTool } = await import('../src/Engine/toolCalling');
      const result = await executeTool('edit_file', { file_path: 'test.ts' }, 'C:/ws');
      expect(result.error).toBeTruthy();
    });

    it('should reject create_file without content', async () => {
      const { executeTool } = await import('../src/Engine/toolCalling');
      const result = await executeTool('create_file', { file_path: 'test.ts' }, 'C:/ws');
      expect(result.error).toBeTruthy();
    });

    it('should reject unknown tools', async () => {
      const { executeTool } = await import('../src/Engine/toolCalling');
      await expect(executeTool('nonexistent_tool', {}, 'C:/ws')).rejects.toThrow('Unknown tool');
    });
  });
});
