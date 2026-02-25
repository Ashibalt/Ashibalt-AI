import * as vscode from 'vscode';
import * as path from 'path';
import { stripAnsi } from './toolUtils';

// ── Interactive prompt detection ────────────────────────────────────

interface DetectedPrompt {
  /** Last few lines of terminal output (context for user) */
  promptText: string;
  /** Suggested response (e.g., "y" for y/n, empty for complex prompts) */
  suggestion: string;
}

/**
 * Check whether the tail of current output looks like an interactive prompt.
 * Returns the prompt context + a suggested response, or null if not detected.
 */
function detectInteractivePrompt(output: string): DetectedPrompt | null {
  const tail = output.slice(-500).trim();
  if (!tail) return null;
  const lines = tail.split(/\r?\n/).filter(l => l.trim());
  const promptText = lines.slice(-3).join('\n');

  // y/n confirmations → suggest "y"
  if (/\(y\/n\)\s*:?\s*$/i.test(tail) || /\[y\/n\]\s*:?\s*$/i.test(tail) ||
      /\(yes\/no\)\s*:?\s*$/i.test(tail) || /\byes\/no\b.*:\s*$/i.test(tail) ||
      /\bconfirm\b.*\(y\|n\)\s*$/i.test(tail) || /\bproceed\?\s*\(y\/n\)\s*$/i.test(tail) ||
      /\boverwrite\b.*\?\s*$/i.test(tail)) {
    return { promptText, suggestion: 'y' };
  }
  // Press Enter prompts → suggest empty (just Enter)
  if (/press enter/i.test(tail) || /press any key/i.test(tail) ||
      /нажмите enter/i.test(tail) || /нажмите любую клавишу/i.test(tail)) {
    return { promptText, suggestion: '' };
  }
  // Numbered/arrow selection menus → empty suggestion (user must choose)
  if (/\?\s+.+\s*›\s*-\s+Use arrow/i.test(tail) || /\?\s+.*\n\s*❯/.test(tail) ||
      /\bselect\b.*:\s*$/i.test(tail) || /\bchoose\b.*:\s*$/i.test(tail) ||
      /\bpick\b.*:\s*$/i.test(tail)) {
    return { promptText, suggestion: '' };
  }
  // Password/token prompts → empty (sensitive)
  if (/password\s*:\s*$/i.test(tail) || /token\s*:\s*$/i.test(tail) ||
      /пароль\s*:\s*$/i.test(tail)) {
    return { promptText, suggestion: '' };
  }
  // Generic input prompts — only match lines that look like they're asking for input.
  // Require a question mark right before EOL (likely a question waiting for answer).
  // For colon, require a prompt-like keyword before it (e.g., "Name:", "Enter value:", "Input:").
  const lastLine = lines[lines.length - 1] || '';
  if (/\?\s*$/.test(lastLine)) {
    return { promptText, suggestion: '' };
  }
  if (/\b(enter|input|name|value|type|specify|provide|write|введите|укажите|напишите)\b.*:\s*$/i.test(lastLine)) {
    return { promptText, suggestion: '' };
  }

  return null;
}

// ── Interactive prompt callback (injected from agentLoop via toolCalling) ──
export type InteractivePromptCallback = (output: string, promptText: string, suggestion: string) => Promise<{ response: string } | null>;
let _onInteractivePrompt: InteractivePromptCallback | null = null;

export function setInteractivePromptHandler(handler: InteractivePromptCallback | null): void {
  _onInteractivePrompt = handler;
}

// ── Idle after output — how long to wait before checking for interactive prompt ──
const INTERACTIVE_DETECT_MS = 2500; // 2.5s of silence after output → check for prompt

// Dangerous commands that require user confirmation
const DANGEROUS_COMMANDS = [
  'rm ', 'rm -', 'rmdir', 'del ', 'rd ',
  'sudo ', 'su ',
  'format ', 'mkfs',
  '> ', '>> ', // redirects that could overwrite files
  'chmod ', 'chown ',
  'kill ', 'pkill ', 'killall ',
  'shutdown', 'reboot', 'poweroff',
  'dd ',
  'mv ', // can overwrite files
  ':(){:|:&};:', // fork bomb
  'curl | sh', 'wget | sh', 'curl | bash', 'wget | bash' // remote code execution
];

// Commands that are blocked entirely
const BLOCKED_COMMANDS = [
  ':(){:|:&};:', // fork bomb
  'rm -rf /',
  'rm -rf /*',
  'dd if=/dev/zero',
  'mkfs.ext',
  '> /dev/sda',
  'chmod -R 777 /'
];

// Reusable terminal instance for agent commands
let agentTerminal: vscode.Terminal | null = null;
// Secondary terminal for running commands while primary is busy (e.g., running a server)
let agentTerminalSecondary: vscode.Terminal | null = null;
// Tracks whether primary terminal has a long-running process (server, watch, etc.)
let primaryTerminalBusy = false;

// ── Busy lock: prevents overlapping shell-integration commands ──
// When true, a shell-integration executeCommand is actively streaming output.
// A second run call will be routed to the secondary terminal automatically.
let _shellStreamActive = false;

// ── Terminal activity tracking via VS Code shell integration events ──
// Tracks terminals that have an active command execution — including user-initiated commands.
// This prevents the agent from sending executeCommand to a terminal where the user
// manually typed a command.
const _busyTerminals = new Set<vscode.Terminal>();
let _shellEventsInitialized = false;

function initShellExecutionEvents(): void {
  if (_shellEventsInitialized) return;
  _shellEventsInitialized = true;

  // Use defensive casting — these events are available since VS Code 1.93+
  const win = vscode.window as any;
  if (typeof win.onDidStartTerminalShellExecution === 'function') {
    win.onDidStartTerminalShellExecution((e: any) => {
      if (e?.terminal) _busyTerminals.add(e.terminal);
    });
  }
  if (typeof win.onDidEndTerminalShellExecution === 'function') {
    win.onDidEndTerminalShellExecution((e: any) => {
      if (e?.terminal) _busyTerminals.delete(e.terminal);
    });
  }
  // Clean up closed terminals
  vscode.window.onDidCloseTerminal(t => {
    _busyTerminals.delete(t);
  });
}

/** Check if a terminal has any active command execution (agent or user). */
function isTerminalBusy(terminal: vscode.Terminal | null): boolean {
  if (!terminal || terminal.exitStatus !== undefined) return false;
  // Our own stream tracking + VS Code event-based tracking
  if (terminal === agentTerminal && _shellStreamActive) return true;
  return _busyTerminals.has(terminal);
}

// Background terminal output buffer for long-running processes
let backgroundOutputBuffer = '';
let backgroundProcess: any = null;  // child_process.ChildProcess reference
let backgroundCommand = '';

type TerminalRunResult = {
  success: boolean;
  command: string;
  cwd?: string;
  exit_code?: number;
  output?: string;
  truncated?: boolean;
  method: 'vscode_terminal' | 'child_process';
  error?: string;
  timed_out?: boolean;
  idle_timeout_ms?: number;
  /** How many interactive prompts (y/n, password, etc.) were auto-answered during execution */
  interactive_prompts_handled?: number;
};

function nowMs() {
  return Date.now();
}

/**
 * Wait for shell integration to become available on a terminal.
 * Polls every 200ms up to maxWaitMs. Returns true if ready.
 */
async function waitForShellIntegration(terminal: vscode.Terminal, maxWaitMs: number): Promise<boolean> {
  const start = nowMs();
  while (nowMs() - start < maxWaitMs) {
    const si = (terminal as any).shellIntegration;
    if (si && typeof si.executeCommand === 'function') {
      return true;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function waitForExitCode(execution: any, fallbackMs: number): Promise<number> {
  // VS Code's shellIntegration execution.exitCode isn't consistently typed across versions.
  // It may be: number | Promise<number> | undefined.
  try {
    const maybe = execution?.exitCode;
    if (typeof maybe === 'number') return maybe;
    if (maybe && typeof maybe.then === 'function') {
      const v = await maybe;
      if (typeof v === 'number') return v;
    }
  } catch {
    // ignore
  }

  // Fallback: best-effort wait. If we can't access exit code, assume success.
  await new Promise(r => setTimeout(r, Math.max(0, fallbackMs)));
  return 0;
}

/**
 * Run a terminal command using VS Code Terminal with shell integration.
 */
export async function runTerminalCommandTool(args: any, workspaceRoot?: string): Promise<any> {
  if (!args || typeof args.command !== 'string' || args.command.trim() === '') {
    return { error: 'command is required and cannot be empty' };
  }

  const command = args.command.trim();
  // Idle timeout is DISABLED — the user can click "Продолжить без ожидания" to detach.
  // Previously, idle timeout killed commands that paused for interactive input (prompts, y/n).
  // We keep only the 1h total safety cap.
  const idleTimeoutMs = 0; // Disabled

  // Check for blocked commands
  for (const blocked of BLOCKED_COMMANDS) {
    if (command.includes(blocked)) {
      return { 
        error: `Command blocked for safety: contains "${blocked}"`,
        success: false 
      };
    }
  }

  // Check for dangerous commands - ask user confirmation
  const isDangerous = DANGEROUS_COMMANDS.some(d => command.toLowerCase().includes(d.toLowerCase()));
  if (isDangerous) {
    const choice = await vscode.window.showWarningMessage(
      `⚠️ Потенциально опасная команда:\n\n${command}\n\nВыполнить?`,
      { modal: true },
      'Выполнить',
      'Отмена'
    );
    if (choice !== 'Выполнить') {
      return { 
        error: 'Command cancelled by user',
        success: false,
        command 
      };
    }
  }

  // Determine working directory
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { error: 'No workspace folder open' };
  }
  
  const rootPath = workspaceRoot || folders[0].uri.fsPath;
  let cwd = rootPath;
  
  if (args.cwd) {
    const resolved = path.resolve(rootPath, args.cwd);
    const rel = path.relative(rootPath, resolved);
    if (rel.startsWith('..')) {
      return { error: 'Working directory must be within workspace' };
    }
    cwd = resolved;
  }

  // Absorb leading "cd <path> &&" from model's command into cwd.
  // This avoids double-cd when our shell integration also prepends cd.
  let finalCommand = command;
  const cdAbsorbPattern = /^cd\s+(?:\/d\s+)?"?([^"&]+?)"?\s*&&\s*/i;
  const cdMatch = finalCommand.match(cdAbsorbPattern);
  if (cdMatch) {
    const cdTarget = path.resolve(cwd, cdMatch[1].trim());
    const rel = path.relative(rootPath, cdTarget);
    if (!rel.startsWith('..')) {
      // Absorb the cd target into cwd, remove cd from command
      cwd = cdTarget;
      finalCommand = finalCommand.replace(cdAbsorbPattern, '').trim();
    }
  }

  // Detect if this is a long-running server/watch command
  const SERVER_PATTERNS = [
    /\b(npm|npx|yarn|pnpm)\s+(run\s+)?(dev|start|serve|watch)\b/i,
    /\bnode\s+\S+\.(js|ts)\b/i,
    /\b(python|python3)\s+\S+\.py\b.*\b(serve|run|start)\b/i,
    /\b(docker|docker-compose)\s+(up|run)\b/i,
    /\buvicorn\b/i, /\bgunicorn\b/i, /\bflask\s+run\b/i,
    /\bnext\s+(dev|start)\b/i, /\bvite\b/i,
  ];
  const isServerCommand = SERVER_PATTERNS.some(p => p.test(finalCommand));

  // ── Background mode ──────────────────────────────────────────────
  // When background=true, start the command and return immediately.
  // Output is collected in backgroundOutputBuffer for later reading via read_terminal_output.
  if (args.background === true || (isServerCommand && args.background !== false)) {
    return await startBackgroundCommand(finalCommand, cwd, command);
  }
  // ─────────────────────────────────────────────────────────────────

  // Ensure VS Code shell execution event listeners are registered
  initShellExecutionEvents();

  // Detect if this is a quick test/check command (curl, wget, etc.)
  const QUICK_CMD_PATTERNS = [
    /\bcurl\b/i, /\bwget\b/i, /\bhttpie\b/i, /\bhttp\s/i,
  ];
  const isQuickCommand = QUICK_CMD_PATTERNS.some(p => p.test(finalCommand));

  // If primary terminal is busy — use secondary terminal.
  // Checks: our own stream active, background server running, OR any command
  // running in the terminal (including user-initiated commands via shell events).
  const primaryBusy = primaryTerminalBusy || isTerminalBusy(agentTerminal);
  let useSecondary = primaryBusy && (isQuickCommand || !isServerCommand);

  // Try VS Code Terminal with Shell Integration first
  try {
    // Choose terminal: secondary if primary is busy, primary otherwise.
    // If secondary is also busy, create a fresh one.
    let activeTerminal: vscode.Terminal;
    if (useSecondary) {
      if (!agentTerminalSecondary || agentTerminalSecondary.exitStatus !== undefined || isTerminalBusy(agentTerminalSecondary)) {
        // Secondary is busy or doesn't exist — create a new one
        agentTerminalSecondary = vscode.window.createTerminal({
          name: 'Ashibalt Agent (2)',
          cwd: cwd
        });
      }
      activeTerminal = agentTerminalSecondary;
    } else {
      if (!agentTerminal || agentTerminal.exitStatus !== undefined) {
        agentTerminal = vscode.window.createTerminal({
          name: 'Ashibalt Agent',
          cwd: cwd
        });
      }
      activeTerminal = agentTerminal;
    }
    
    activeTerminal.show(true); // Show terminal to user

    // Wait for shell integration to become available (VS Code needs time to spawn the shell).
    // Instead of a fixed delay, poll for shellIntegration readiness with a reasonable cap.
    const shellReady = await waitForShellIntegration(activeTerminal, 5000);
    if (!shellReady) {
      // Fallback: extra static delay if shell integration never appeared
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    
    // Check if shell integration is available (VS Code 1.93+)
    const shellIntegration = (activeTerminal as any).shellIntegration;
    if (shellIntegration && typeof shellIntegration.executeCommand === 'function') {
      try {
        // Always cd to the correct cwd before executing the command.
        // The shell integration terminal is reused between calls, so its pwd
        // may have drifted (e.g. if a previous command contained "cd ...").
        // Use plain "cd" (no /d) — works in both cmd.exe (same drive) and Git Bash.
        const fullCommand = `cd "${cwd}" && ${finalCommand}`;
        
        // Use shell integration for command execution with output capture
        const execution = shellIntegration.executeCommand(fullCommand);
        _shellStreamActive = true; // Mark: shell stream is reading
        
        // Wait for command to complete.
        // Uses manual async iteration with idle detection for interactive prompts.
        const stream = execution.read();
        let rawOutput = '';
        let lastChunkTime = nowMs();
        const startedAt = nowMs();
        const maxTotalMs = 60 * 60 * 1000; // 1h safety cap

        // Manual async iterator so we can race with idle timeout
        const iterator = stream[Symbol.asyncIterator]();
        let streamDone = false;
        // Track how much output has already been checked for interactive prompts.
        // After sending a response, we bump this so the same prompt text isn't re-detected.
        let promptCheckedOffset = 0;
        // Track how many interactive prompts were answered automatically.
        let promptsHandled = 0;

        // ── Pending next chunk ──
        // CRITICAL: We must only call iterator.next() ONCE at a time.
        // Calling it a second time while the first is still pending causes
        // undefined behavior — lost chunks, premature stream end.
        // We store the pending promise and reuse it across idle retries.
        let pendingNext: Promise<IteratorResult<string, any>> | null = null;

        while (!streamDone) {
          // Start a chunk read only if one isn't already pending
          if (!pendingNext) {
            pendingNext = iterator.next();
          }
          const idleWait = new Promise<'idle'>(r => setTimeout(() => r('idle'), INTERACTIVE_DETECT_MS));

          const raceResult = await Promise.race([
            pendingNext!.then((v: any) => ({ type: 'chunk' as const, value: v })),
            idleWait.then(() => ({ type: 'idle' as const, value: null }))
          ]);

          if (raceResult.type === 'chunk') {
            pendingNext = null; // consumed — next iteration will start a new one
            const iterResult = raceResult.value!;
            if (iterResult.done) {
              streamDone = true;
              break;
            }
            rawOutput += iterResult.value;
            lastChunkTime = nowMs();

            // Prevent huge output
            if (rawOutput.length > 50000) {
              rawOutput = rawOutput.substring(0, 10000) + '\n... (output truncated)';
              break;
            }
          } else {
            // Idle timeout — check if this looks like an interactive prompt
            // Only check NEW output (after promptCheckedOffset) to avoid re-detecting answered prompts
            const cleanOutput = stripAnsi(rawOutput);
            const newPortion = cleanOutput.slice(promptCheckedOffset);
            const detected = newPortion.length > 0 ? detectInteractivePrompt(newPortion) : null;

            if (detected && _onInteractivePrompt) {
              try {
                const promptResult = await _onInteractivePrompt(cleanOutput.slice(-2000), detected.promptText, detected.suggestion);
                if (promptResult && promptResult.response !== undefined && promptResult.response !== null) {
                  // Send the response to terminal (always press Enter after response)
                  const resp = String(promptResult.response).replace(/\n$/, '');
                  activeTerminal.sendText(resp, true);
                  // Mark current output as handled — don't re-detect same prompt
                  promptCheckedOffset = cleanOutput.length;
                  promptsHandled++;
                  // Continue reading stream after sending response.
                  // DO NOT null pendingNext — reuse the same pending promise!
                  lastChunkTime = nowMs();
                  continue;
                }
              } catch {
                // Callback failed — continue waiting
              }
            }

            // Not an interactive prompt or no handler — wait for actual next chunk
            // (don't spin; await the already-started pendingNext promise)
            const iterResult = await pendingNext!;
            pendingNext = null; // consumed
            if (iterResult!.done) {
              streamDone = true;
              break;
            }
            rawOutput += iterResult!.value;
            lastChunkTime = nowMs();

            if (rawOutput.length > 50000) {
              rawOutput = rawOutput.substring(0, 10000) + '\n... (output truncated)';
              break;
            }
          }

          // Total duration safety cap
          if (nowMs() - startedAt > maxTotalMs) {
            _shellStreamActive = false;
            return {
              success: false,
              command,
              cwd,
              error: `Command exceeded maximum total duration (${maxTotalMs}ms)`,
              timed_out: true,
              output: stripAnsi(rawOutput).substring(0, 10000),
              method: 'vscode_terminal'
            } satisfies TerminalRunResult;
          }
        }

        // Strip ANSI/OSC sequences from shell integration output
        let output = stripAnsi(rawOutput);

        // Remove the echoed command itself from the beginning of the output
        // Shell integration often echoes: cd "path" && actual_command\n...output...
        const echoIdx = output.indexOf(finalCommand);
        if (echoIdx !== -1 && echoIdx < 200) {
          output = output.substring(echoIdx + finalCommand.length).replace(/^\r?\n/, '');
        }
        // Also try removing the full command (with cd prefix)
        const fullEchoIdx = output.indexOf(fullCommand);
        if (fullEchoIdx !== -1 && fullEchoIdx < 200) {
          output = output.substring(fullEchoIdx + fullCommand.length).replace(/^\r?\n/, '');
        }

        // Trim leading/trailing whitespace and empty lines
        output = output.trim();

        // If we exited the stream quickly but the command went silent/hung, detect by idle timeout.
        if (idleTimeoutMs > 0 && nowMs() - lastChunkTime > idleTimeoutMs) {
          // Mark primary terminal as busy if this was a server command that timed out
          if (isServerCommand && !useSecondary) {
            primaryTerminalBusy = true;
          }
          _shellStreamActive = false;
          return {
            success: false,
            command,
            cwd,
            error: `Command produced no output for ${idleTimeoutMs}ms (idle timeout)`,
            timed_out: true,
            idle_timeout_ms: idleTimeoutMs,
            output: output.substring(0, 10000) || '(no output)',
            method: 'vscode_terminal'
          } satisfies TerminalRunResult;
        }

        // exitCode may be a promise or number depending on VS Code version
        const exitCode = await waitForExitCode(execution, 0);
        
        // Command completed normally — primary terminal is free
        if (!useSecondary) primaryTerminalBusy = false;
        _shellStreamActive = false;
        
        const truncated = output.length > 10000;
        
        const result: TerminalRunResult = {
          success: exitCode === 0,
          command,
          cwd,
          exit_code: exitCode,
          output: output.substring(0, 10000) || '(no output)',
          truncated,
          method: 'vscode_terminal'
        };
        // Tell the model that interactive prompts were already answered during execution
        if (promptsHandled > 0) {
          result.interactive_prompts_handled = promptsHandled;
          result.output = `[Note: ${promptsHandled} interactive prompt(s) were detected and answered automatically during this command. The command has completed.]\n\n${result.output}`;
        }
        return result;
      } catch (shellErr: any) {
        // Shell integration failed, fall through to sendText approach
        _shellStreamActive = false;
        console.error('Shell integration executeCommand failed:', shellErr.message);
      }
    }
    
    // Shell integration not available or failed - use child_process for output capture
    // Show command in VS Code terminal for user visibility (child_process runs the actual execution)
    activeTerminal.sendText(finalCommand);
    return await runCommandWithChildProcess(finalCommand, cwd, idleTimeoutMs);
    
  } catch (err: any) {
    // If VS Code terminal fails completely, fallback to child_process only
    console.error('VS Code terminal failed, using child_process fallback:', err.message);
    return await runCommandWithChildProcess(finalCommand, cwd, idleTimeoutMs);
  }
}

/**
 * Fallback: run command with child_process.
 * Also used by run_tests tool.
 */
export async function runCommandWithChildProcess(command: string, cwd: string, idleTimeoutMs: number): Promise<any> {
  const cp = await import('child_process');

  // Helper for reliable cross-platform process kill
  const killChild = (child: any) => {
    try {
      if (process.platform === 'win32' && child.pid) {
        // On Windows, child.kill() sends SIGTERM which cmd.exe ignores.
        // Use taskkill /F /T to kill entire process tree.
        cp.exec(`taskkill /pid ${child.pid} /T /F`, { windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    } catch { /* ignore kill errors */ }
  };

  // Use spawn to implement idle-timeout (instead of exec's hard timeout).
  return await new Promise((resolve) => {
    const child = cp.spawn(command, {
      cwd,
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
      windowsHide: true,
      env: process.env
    });

    let output = '';
    let truncated = false;
    let lastChunkTime = nowMs();
    const startedAt = nowMs();
    const maxTotalMs = 60 * 60 * 1000; // 1h safety cap
    const maxOutputLength = 10000;
    const hardCapLength = 50000;

    const push = (chunk: any) => {
      const s = stripAnsi(String(chunk ?? ''));
      if (!s) return;
      lastChunkTime = nowMs();
      output += s;
      if (output.length > hardCapLength) {
        output = output.substring(0, maxOutputLength) + '\n... (output truncated)';
        truncated = true;
      }
    };

    child.stdout?.on('data', push);
    child.stderr?.on('data', (d: any) => {
      if (output && String(d ?? '').length) output += '\n';
      push(d);
    });

    const interval = setInterval(() => {
      // Total duration safety cap
      if (nowMs() - startedAt > maxTotalMs) {
        clearInterval(interval);
        killChild(child);
        resolve({
          success: false,
          command,
          cwd,
          error: `Command exceeded maximum total duration (${maxTotalMs}ms)`,
          timed_out: true,
          output: output || '(no output)',
          truncated,
          method: 'child_process'
        } satisfies TerminalRunResult);
        return;
      }

      if (idleTimeoutMs > 0 && nowMs() - lastChunkTime > idleTimeoutMs) {
        clearInterval(interval);
        killChild(child);
        resolve({
          success: false,
          command,
          cwd,
          error: `Command produced no output for ${idleTimeoutMs}ms (idle timeout)`,
          timed_out: true,
          idle_timeout_ms: idleTimeoutMs,
          output: output || '(no output)',
          truncated,
          method: 'child_process'
        } satisfies TerminalRunResult);
      }
    }, 250);

    child.on('error', (err: any) => {
      clearInterval(interval);
      resolve({
        success: false,
        command,
        cwd,
        exit_code: 1,
        error: err?.message || 'Command failed',
        output: output || '(no output)',
        truncated,
        method: 'child_process'
      } satisfies TerminalRunResult);
    });

    child.on('close', (code: number | null) => {
      clearInterval(interval);
      resolve({
        success: (code ?? 1) === 0,
        command,
        cwd,
        exit_code: code ?? 1,
        output: output || '(no output)',
        truncated,
        method: 'child_process'
      } satisfies TerminalRunResult);
    });
  });
}

/**
 * Start a command in background mode (non-blocking).
 * Runs the command in a VISIBLE VS Code terminal so the user can see it.
 */
async function startBackgroundCommand(finalCommand: string, cwd: string, originalCommand: string): Promise<any> {
  const cp = await import('child_process');

  // Kill previous background process if any
  if (backgroundProcess && !backgroundProcess.killed) {
    try {
      if (process.platform === 'win32' && backgroundProcess.pid) {
        cp.exec(`taskkill /pid ${backgroundProcess.pid} /T /F`, { windowsHide: true });
      } else {
        backgroundProcess.kill('SIGKILL');
      }
    } catch { /* ignore */ }
    backgroundProcess = null;
  }

  backgroundOutputBuffer = '';
  backgroundCommand = originalCommand;
  primaryTerminalBusy = true;

  // Create/reuse a dedicated terminal for background commands
  if (!agentTerminal || agentTerminal.exitStatus !== undefined) {
    agentTerminal = vscode.window.createTerminal({ name: 'Ashibalt Agent', cwd });
  }
  agentTerminal.show(true);
  agentTerminal.sendText(finalCommand);

  // Watch for terminal close to reset busy flag
  const closeListener = vscode.window.onDidCloseTerminal(t => {
    if (t === agentTerminal) {
      primaryTerminalBusy = false;
      backgroundProcess = null;
      closeListener.dispose();
    }
  });

  // Wait briefly (3s) for initial output
  await new Promise(resolve => setTimeout(resolve, 3000));

  return {
    success: true,
    command: originalCommand,
    cwd,
    background: true,
    output: '(command started in VS Code terminal)',
    message: 'Command started in the VS Code terminal "Ashibalt Agent". The output is visible there.',
    method: 'vscode_terminal'
  };
}

/**
 * Write input to the active terminal (stdin).
 * Sends text to the VS Code terminal (e.g. answering prompts like "y\n").
 * Also writes to the background child_process stdin if available.
 */
export async function writeToTerminalTool(args: any): Promise<any> {
  if (!args || typeof args.input !== 'string') {
    return { error: 'input is required (string)' };
  }

  const input = args.input;
  let sent = false;

  // Write to background process stdin if it exists
  if (backgroundProcess && !backgroundProcess.killed && backgroundProcess.stdin) {
    try {
      backgroundProcess.stdin.write(input);
      sent = true;
    } catch (err: any) {
      // stdin may be closed
    }
  }

  // Also send to VS Code terminal via sendText (covers shell integration path)
  // Prefer secondary terminal if primary stream is active (it's blocked reading output)
  const terminal = (_shellStreamActive && agentTerminalSecondary && agentTerminalSecondary.exitStatus === undefined)
    ? agentTerminalSecondary
    : agentTerminal;
  if (terminal && terminal.exitStatus === undefined) {
    // sendText appends \n by default; if input already ends with \n, avoid double newline
    const shouldAddNewline = input.endsWith('\n');
    terminal.sendText(input.replace(/\n$/, ''), shouldAddNewline);
    terminal.show(true);
    sent = true;
  }

  if (!sent) {
    return {
      success: false,
      error: 'No active terminal or background process to write to. Start a command first.'
    };
  }

  // Wait briefly to let the process react, then read any new output
  await new Promise(r => setTimeout(r, 1500));

  // Return latest output from background buffer if available
  const output = backgroundOutputBuffer.substring(backgroundOutputBuffer.length - 5000);

  return {
    success: true,
    input_sent: input,
    output: output || '(no output yet — use read_terminal_output to check later)'
  };
}

/**
 * Read output from the background terminal process.
 * Returns accumulated output and optionally clears the buffer.
 */
export async function readTerminalOutputTool(args: any): Promise<any> {
  if (!backgroundProcess && !backgroundOutputBuffer) {
    return {
      success: false,
      error: 'No background process is running and no output is available.',
      hint: 'Start a command with background=true first.'
    };
  }

  const isRunning = backgroundProcess && !backgroundProcess.killed;
  const output = backgroundOutputBuffer.substring(0, 10000);
  const truncated = backgroundOutputBuffer.length > 10000;

  // Clear buffer after reading if requested (default: true to avoid re-reading same output)
  if (args?.clear_buffer !== false) {
    backgroundOutputBuffer = '';
  }

  return {
    success: true,
    command: backgroundCommand,
    is_running: !!isRunning,
    output: output || '(no new output)',
    truncated
  };
}

/**
 * Unified terminal tool — dispatches to run / write / read based on `action`.
 *
 * action="run"   (default) — run a shell command (wraps runTerminalCommandTool)
 * action="write"           — send stdin to the active terminal (wraps writeToTerminalTool)
 * action="read"            — read background process output (wraps readTerminalOutputTool)
 */
export async function terminalTool(args: any, workspaceRoot?: string): Promise<any> {
  const action: string = (args?.action ?? 'run').toLowerCase();

  switch (action) {
    case 'run':
    case '':
      return runTerminalCommandTool(args, workspaceRoot);

    case 'write':
      return writeToTerminalTool(args);

    case 'read':
      return readTerminalOutputTool(args);

    default:
      return {
        error: `Unknown terminal action: "${action}". Valid values: "run", "write", "read".`,
        hint: 'Use action="run" to execute a command, action="write" to send stdin input, action="read" to read background output.'
      };
  }
}
