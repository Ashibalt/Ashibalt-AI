import { window, OutputChannel } from "vscode";
import { appendFile } from 'fs/promises';
import * as path from 'path';

class Logger {
  private outputChannel: OutputChannel;
  private logFilePath: string;

  constructor() {
    this.outputChannel = window.createOutputChannel("Ashibalt AI");
    // logs.txt at workspace root
    try {
      // If workspaceFolder is undefined, fallback to CWD
      const root = process.cwd() || __dirname;
      this.logFilePath = path.join(root, 'logs.txt');
    } catch (e) {
      this.logFilePath = path.join(__dirname, '..', '..', 'logs.txt');
    }
    // Patch console.error to also write into logs.txt for easier debugging
    const originalConsoleError = console.error;
    console.error = (...args: any[]) => {
      this.error(String(args.map(a => (a instanceof Error ? a.stack || a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a)))).join(' ')));
      originalConsoleError.apply(console, args);
    };
  }

  private async appendToFile(line: string) {
    try {
      await appendFile(this.logFilePath, line + '\n', 'utf8');
    } catch (e) {
      // swallow to avoid infinite loops if logging fails
    }
  }

  log(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    const line = `[${timestamp}] ${message}`;
    this.outputChannel.appendLine(line);
    this.appendToFile(line).catch(() => {});
  }

  error(message: string, error?: any) {
    const timestamp = new Date().toLocaleTimeString();
    const header = `[${timestamp}] ERROR: ${message}`;
    this.outputChannel.appendLine(header);
    this.appendToFile(header).catch(() => {});
    if (error) {
      if (error instanceof Error) {
        const stack = error.stack || error.message;
        this.outputChannel.appendLine(stack);
        this.appendToFile(stack).catch(() => {});
      } else {
        const json = JSON.stringify(error, null, 2);
        this.outputChannel.appendLine(json);
        this.appendToFile(json).catch(() => {});
      }
    }
    this.outputChannel.show(true); // Show output channel on error
  }

  show() {
    this.outputChannel.show(true);
  }
}

export const logger = new Logger();
