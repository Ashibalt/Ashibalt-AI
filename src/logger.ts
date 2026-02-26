import { window, OutputChannel } from "vscode";

class Logger {
  private outputChannel: OutputChannel;

  constructor() {
    this.outputChannel = window.createOutputChannel("Ashibalt AI");
  }

  log(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    const line = `[${timestamp}] ${message}`;
    this.outputChannel.appendLine(line);
  }

  error(message: string, error?: any) {
    const timestamp = new Date().toLocaleTimeString();
    const header = `[${timestamp}] ERROR: ${message}`;
    this.outputChannel.appendLine(header);
    if (error) {
      if (error instanceof Error) {
        this.outputChannel.appendLine(error.stack || error.message);
      } else {
        this.outputChannel.appendLine(JSON.stringify(error, null, 2));
      }
    }
    this.outputChannel.show(true);
  }

  show() {
    this.outputChannel.show(true);
  }
}

export const logger = new Logger();
