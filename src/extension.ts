import {
  commands,
  ConfigurationChangeEvent,
  ExtensionContext,
  window,
  workspace
} from "vscode";
import { ChatViewProvider } from "./WebView/ChatViewProvider";
import { loadExtensionConfig } from "./Config/config";
import { logger } from "./logger";
import { ConfigManager, setConfigManager } from "./Config/configManager";
import { getSnapshotManager } from "./Storage/snapshotManager";
import { initDecorations, setupDecorationListeners, refreshAllDecorations, disposeDecorations } from "./Storage/snapshotDecorations";
import { uidManager } from "./Storage/uidManager";
import { metricsService } from "./Services/metricsService";

let chatProvider: ChatViewProvider | undefined;
let configManager: ConfigManager | undefined;

export async function activate(context: ExtensionContext) {
  logger.log("Activating Ashibalt AI extension...");

  try {
    // Initialize UID manager (for anonymous metrics)
    logger.log("Initializing UID Manager...");
    uidManager.initialize(context).then(uid => {
      logger.log(`[UID] Ready: ${uid}`);
    }).catch(e => {
      logger.error('Failed to initialize UID Manager:', e);
    });

  logger.log("Initializing ConfigManager...");
  configManager = new ConfigManager(context.globalState);
    setConfigManager(configManager); // Register singleton for use by other modules
  logger.log(`Config storage: ${configManager.getConfigPath()}`);
    logger.log(`Loaded ${configManager.getModels().length} models from config`);

    // Initialize SnapshotManager for undo functionality
    logger.log("Initializing SnapshotManager...");
    const snapshotManager = getSnapshotManager();
    snapshotManager.init().then(() => {
      logger.log(`SnapshotManager initialized. Pending changes: ${snapshotManager.hasPendingChanges()}`);
      // Initialize decorations for visual diff
      initDecorations();
      setupDecorationListeners(context);
      // Refresh decorations for any pending snapshots
      refreshAllDecorations();
    }).catch(e => {
      logger.error('Failed to initialize SnapshotManager:', e);
    });
    
    const config = loadExtensionConfig();
    logger.log(`Loaded config`);

    chatProvider = new ChatViewProvider(context.extensionUri, config, context, configManager);

    context.subscriptions.push(
      window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider)
    );

    context.subscriptions.push(
      workspace.onDidChangeConfiguration((event: ConfigurationChangeEvent) => {
        if (event.affectsConfiguration("ashibaltAi")) {
          logger.log("Configuration changed, reloading...");
          const newConfig = loadExtensionConfig();
          chatProvider?.updateConfig(newConfig);
        }
      })
    );

    context.subscriptions.push(
      commands.registerCommand("ashibaltAi.reloadSettings", () => {
        logger.log("Manual settings reload triggered.");
        const newConfig = loadExtensionConfig();
        chatProvider?.updateConfig(newConfig);
        window.showInformationMessage("Settings reloaded.");
      })
    );

    // Explain Code — context menu command (requires selection)
    context.subscriptions.push(
      commands.registerCommand("ashibaltAi.explainCode", () => {
        const editor = window.activeTextEditor;
        if (!editor) return;
        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);
        if (!selectedText.trim()) {
          window.showWarningMessage("Выделите код для объяснения.");
          return;
        }
        const fileName = editor.document.fileName.split(/[\/\\]/).pop() || '';
        const prompt = `Объясни этот код из \`${fileName}\`. Отвечай на русском:\n\`\`\`\n${selectedText}\n\`\`\``;
        chatProvider?.handleUserMessage(prompt, 'chat');
      })
    );

    // Refactor Code — context menu command (requires selection)
    context.subscriptions.push(
      commands.registerCommand("ashibaltAi.refactorCode", () => {
        const editor = window.activeTextEditor;
        if (!editor) return;
        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);
        if (!selectedText.trim()) {
          window.showWarningMessage("Выделите код для рефакторинга.");
          return;
        }
        const fileName = editor.document.fileName.split(/[\/\\]/).pop() || '';
        const prompt = `Проведи рефакторинг этого кода из \`${fileName}\` (строки ${selection.start.line + 1}-${selection.end.line + 1}). Улучши читаемость, производительность и следование лучшим практикам. Отвечай на русском:\n\`\`\`\n${selectedText}\n\`\`\``;
        chatProvider?.handleUserMessage(prompt, 'agent');
      })
    );

    context.subscriptions.push(
      commands.registerCommand("ashibaltAi.showConfigPath", () => {
        if (configManager) {
          const configPath = configManager.getConfigPath();
          const models = configManager.getModels();
          window.showInformationMessage(`Config storage: ${configPath}\nModels: ${models.length}`);
        }
      })
    );

    context.subscriptions.push({
      dispose: () => configManager?.dispose()
    });

    logger.log("Extension activated successfully.");
  } catch (error) {
    logger.error("Failed to activate extension:", error);
    window.showErrorMessage("Extension failed to activate. Check Output panel for details.");
  }
}

export function deactivate() {
  disposeDecorations();
  metricsService.dispose();
}
