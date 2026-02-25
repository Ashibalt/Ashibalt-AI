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
    // CSS modules
    const cssBsUri      = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'css', 'base.css'));
    const cssAuthUri    = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'css', 'auth.css'));
    const cssChatUri    = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'css', 'chat.css'));
    const cssPendingUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'css', 'pending.css'));
    const cssInputUri   = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'css', 'input.css'));
    const cssSettingsUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'css', 'settings.css'));
    const cssNavUri     = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'css', 'navigation.css'));
    const cssActionsUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'css', 'actions.css'));
    // JS modules
    const jsGlobalsUri      = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'js', 'globals.js'));
    const jsAutocompleteUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'js', 'autocomplete.js'));
    const jsUiUri           = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'js', 'ui.js'));
    const jsSettingsUri     = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'js', 'settings.js'));
    const jsMsgHandlerUri   = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'js', 'message-handler.js'));
    const jsMessagesUri     = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'js', 'messages.js'));
    const jsToolActionsUri  = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'js', 'tool-actions.js'));
    const jsMainUri         = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'js', 'main.js'));
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
      // CSS modules
      .replace(/\{\{cssBsUri\}\}/g,       cssBsUri.toString()      + `?v=${timestamp}`)
      .replace(/\{\{cssAuthUri\}\}/g,     cssAuthUri.toString()    + `?v=${timestamp}`)
      .replace(/\{\{cssChatUri\}\}/g,     cssChatUri.toString()    + `?v=${timestamp}`)
      .replace(/\{\{cssPendingUri\}\}/g,  cssPendingUri.toString() + `?v=${timestamp}`)
      .replace(/\{\{cssInputUri\}\}/g,    cssInputUri.toString()   + `?v=${timestamp}`)
      .replace(/\{\{cssSettingsUri\}\}/g, cssSettingsUri.toString()+ `?v=${timestamp}`)
      .replace(/\{\{cssNavUri\}\}/g,      cssNavUri.toString()     + `?v=${timestamp}`)
      .replace(/\{\{cssActionsUri\}\}/g,  cssActionsUri.toString() + `?v=${timestamp}`)
      // JS modules
      .replace(/\{\{jsGlobalsUri\}\}/g,      jsGlobalsUri.toString()      + `?v=${timestamp}`)
      .replace(/\{\{jsAutocompleteUri\}\}/g, jsAutocompleteUri.toString() + `?v=${timestamp}`)
      .replace(/\{\{jsUiUri\}\}/g,           jsUiUri.toString()           + `?v=${timestamp}`)
      .replace(/\{\{jsSettingsUri\}\}/g,     jsSettingsUri.toString()     + `?v=${timestamp}`)
      .replace(/\{\{jsMsgHandlerUri\}\}/g,   jsMsgHandlerUri.toString()   + `?v=${timestamp}`)
      .replace(/\{\{jsMessagesUri\}\}/g,     jsMessagesUri.toString()     + `?v=${timestamp}`)
      .replace(/\{\{jsToolActionsUri\}\}/g,  jsToolActionsUri.toString()  + `?v=${timestamp}`)
      .replace(/\{\{jsMainUri\}\}/g,         jsMainUri.toString()         + `?v=${timestamp}`)
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
