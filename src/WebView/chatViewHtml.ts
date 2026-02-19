import { Webview, Uri } from 'vscode';
import { logger } from '../logger';

export function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function loadHtmlTemplate(webview: Webview, nonce: string, currentFileName: string, extensionUri: Uri, config: any, selectedModelName: string | null) {
  try {
    // Read real settings from VS Code config for initial HTML render
    const vscodeWorkspace = require('vscode').workspace;
    const cfg = vscodeWorkspace.getConfiguration('ashibaltAi');
    const agentIterations = cfg.get('agentIterations', 25);
    const autoRunTerminal = cfg.get('autoRunTerminal', false);
    const provider = cfg.get('provider', 'openrouter');

    const htmlPath = Uri.joinPath(extensionUri, 'media', 'chatView.html');
    logger.log(`Loading chat view from: ${htmlPath.fsPath}`);
    const htmlBytes = require('fs').readFileSync(htmlPath.fsPath, 'utf8');
    const codiconUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'codicon.css'));
    const markedUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'resources', 'js', 'marked.min.js'));
    const highlightUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'resources', 'js', 'highlight.min.js'));
    const highlightCssUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'resources', 'css', 'github-dark.min.css'));
    const styleUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'style.css'));
    const scriptUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'script.js'));
    const iconsUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'resources', 'icons'));
    const providerIconsUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'icon_providers'));

    const timestamp = Date.now();
    logger.log(`[ChatViewHtml] Generating HTML with timestamp: ${timestamp}`);

    return htmlBytes
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{codiconCssUri\}\}/g, codiconUri.toString())
      .replace(/\{\{markedUri\}\}/g, markedUri.toString())
      .replace(/\{\{highlightUri\}\}/g, highlightUri.toString())
      .replace(/\{\{highlightCssUri\}\}/g, highlightCssUri.toString())
      .replace(/\{\{styleUri\}\}/g, styleUri.toString() + `?v=${timestamp}`)
      .replace(/\{\{scriptUri\}\}/g, scriptUri.toString() + `?v=${timestamp}`)
      .replace(/\{\{iconsUri\}\}/g, iconsUri.toString())
      .replace(/\{\{providerIconsUri\}\}/g, providerIconsUri.toString())
      .replace(/\{\{currentFileName\}\}/g, currentFileName || 'No file')
      .replace(/\{\{agentIterations\}\}/g, String(agentIterations))
      .replace(/\{\{autoRunTerminalChecked\}\}/g, autoRunTerminal ? 'checked' : '')
      .replace(/\{\{provider\}\}/g, provider)
      .replace(/\{\{selectedModelName\}\}/g, selectedModelName || '');
  } catch (error) {
    logger.error('Failed to load HTML template', error);
    return getFallbackHtml(webview, nonce);
  }
}

function getFallbackHtml(webview: Webview, nonce: string) {
  return `<!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100vh;
          margin: 0;
          font-family: var(--vscode-font-family);
          color: var(--vscode-foreground);
          background: var(--vscode-editor-background);
        }
        .error {
          text-align: center;
          padding: 20px;
        }
      </style>
    </head>
    <body>
      <div class="error">
        <h2>Не удалось загрузить интерфейс чата</h2>
        <p>Проверьте, что файл chatView.html находится в папке media/</p>
      </div>
    </body>
    </html>`;
}
