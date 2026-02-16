import { describe, expect, it, vi } from 'vitest';

// --- child_process spawn mock (streaming output + completion) ---
// toolCalling falls back to child_process when shellIntegration isn't available.
// In unit tests we mock spawn to make the behavior deterministic and OS-independent.
vi.mock('child_process', async () => {
  const { EventEmitter } = await import('events');

  class FakeProc extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    killed = false;
    kill = vi.fn(() => {
      this.killed = true;
      // simulate termination
      queueMicrotask(() => this.emit('close', 1));
      return true;
    });
  }

  return {
    spawn: vi.fn((command: string) => {
      const p = new FakeProc();

      // Simple scripted behavior based on the provided command.
      if (command.includes('sleep 1; echo done')) {
        setTimeout(() => {
          p.stdout.emit('data', 'done\n');
          setTimeout(() => p.emit('close', 0), 5);
        }, 20);
      } else if (command.includes('tick-')) {
        // Emit ticks periodically, then finish.
        let i = 1;
        const t = setInterval(() => {
          p.stdout.emit('data', `tick-${i}\n`);
          i++;
          if (i > 3) {
            clearInterval(t);
            p.stdout.emit('data', 'finished\n');
            setTimeout(() => p.emit('close', 0), 5);
          }
        }, 30);
      } else {
        // default: immediate success
        setTimeout(() => p.emit('close', 0), 5);
      }

      return p as any;
    })
  };
});

// We mock vscode because toolCalling imports it at module load.
vi.mock('vscode', () => {
  const terminal = {
    exitStatus: undefined,
    show: vi.fn(),
    sendText: vi.fn(),
    shellIntegration: undefined
  };

  const outputChannel = {
    appendLine: vi.fn(),
    append: vi.fn(),
    show: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn()
  };

  return {
    window: {
      createTerminal: vi.fn(() => terminal),
      createOutputChannel: vi.fn(() => outputChannel),
      showWarningMessage: vi.fn(async () => 'Выполнить')
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: 'C:/ws' } }],
      fs: { stat: vi.fn() }
    },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    FileType: { Directory: 2 }
  };
});

describe('terminal tool reliability', () => {
  it('waits for process completion and returns final output', async () => {
    const { executeTool } = await import('../src/Engine/toolCalling');

  // Command string is only used as a script selector by the spawn mock.
  const cmd = 'bash -lc "sleep 1; echo done"';

    const res: any = await executeTool('terminal', { command: cmd, timeout_ms: 5000 }, 'C:/ws');

    expect(res).toBeTruthy();
    expect(res.command).toContain('sleep');
    expect(String(res.output || '')).toMatch(/done/);
    expect(res.error).toBeFalsy();
  }, 15000);

  it('uses idle-timeout, not total runtime timeout', async () => {
    const { executeTool } = await import('../src/Engine/toolCalling');

  // Produces output periodically; should not trigger idle timeout.
  const cmd = 'bash -lc "for i in 1 2 3; do echo tick-$i; sleep 1; done; echo finished"';

    const res: any = await executeTool('terminal', { command: cmd, timeout_ms: 1500 }, 'C:/ws');

    expect(res).toBeTruthy();
    expect(res.timed_out).toBeFalsy();
    expect(String(res.output || '')).toMatch(/finished/);
    expect(res.error).toBeFalsy();
  }, 20000);
});
