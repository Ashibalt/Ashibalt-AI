import { commands, env, Uri, Webview, WebviewView, WebviewViewProvider, window, workspace, ExtensionContext, FileType, Position, Range } from "vscode";
import { TextDecoder } from "util";
import { ExtensionConfig, type ProviderType, loadExtensionConfig } from "../Config/config";
import { logger } from "../logger";
import { getChatSystemPrompt, getAgentSystemPrompt } from "../promptUtils";
import { tools as availableTools, executeTool } from "../Engine/toolCalling";
import { ChatModelClient, createChatClientWithFallback } from "../chatClientFactory";
import { ConfigManager, AIModel } from "../Config/configManager";
import { getIconForFile } from "../iconMap";
import { getNonce, loadHtmlTemplate } from './chatViewHtml';
import { buildAttachedFilesFromContext } from '../Engine/SystemContext/contextHelpers';
import { StorageManager } from "../Storage/storageManager";
import { getSnapshotManager } from "../Storage/snapshotManager";
import { SnapshotHandler } from './snapshotHandler';
import { 
  parseSlashCommand, 
  isValidCommand, 
  getCommand,
  generateFixPrompt,
  generateProjectAnalysisPrompt,
  generateWorkspaceFixPrompt,
  processHashReferences,
  SLASH_COMMANDS
} from "../Commands/slashCommands";
import * as path from 'path';

type ChatRole = "system" | "user" | "assistant";

interface AttachedFile {
  path: string;
  name: string;
  icon?: string;
}

type ChatMode = 'agent' | 'chat';

const MODE_STORAGE_KEY = 'ashibaltChatMode';
const DEFAULT_CHAT_MODE: ChatMode = 'agent';

interface ChatMessage {
  role: ChatRole;
  content: string;
  mode?: ChatMode;
  id?: string;
  // temporary messages (placeholders) are not persisted across sessions
  temporary?: boolean;
  // Optional attachment (images etc). data SHOULD NOT be embedded into text sent to model.
  attachment?: {
    mime: string;
    data?: string; // base64 or data URL for rendering in webview; do NOT include in model prompt
    name?: string;
    size?: number;
  };
  // Array of files attached to this message (for display and processing)
  attachedFiles?: AttachedFile[];
  // Pasted image data stored in the message (for recovery if contextAttachments is cleared)
  pastedImages?: Record<string, { mime: string; dataUrl?: string; name?: string; size?: number }>;
  // Agent actions (file operations performed by the agent)
  actions?: any[];
  // Model name used to generate this message (for assistant messages)
  modelName?: string;
}

interface ChatSession {
  id: string;
  title: string;
  date: number;
  messages: ChatMessage[];
}

/**
 * Main WebView provider for the Ashibalt AI sidebar.
 * Manages chat UI, session persistence, agent loop orchestration,
 * terminal/iteration confirmations, and all webview↔extension messaging.
 */
export class ChatViewProvider implements WebviewViewProvider {
  public static readonly viewType = "ashibalt.chatView";

  private view?: WebviewView;
  private config: ExtensionConfig;
  private client!: ChatModelClient;
  private primaryProvider: ProviderType = "mistral";
  private history: ChatMessage[] = [];
  private sessions: ChatSession[] = [];
  private currentSessionId: string = Date.now().toString();
  private pendingLoadSessionId: string | null = null;
  private pendingRestoreSessionId: string | null = null;
  private abortController: AbortController | null = null;
  private isStreamingAborted = false;
  private _isProcessing = false; // true while a request is in progress
  private pendingHostMessages: string[] = [];
  private readonly maxHistory = 50;
  private contextFiles: Set<string> = new Set();
  private contextAttachments: Map<string, { mime: string; dataUrl?: string; name?: string; size?: number }> = new Map();
  private configManager: ConfigManager;
  private selectedModel: AIModel | null = null;
  private _suppressConfigReload = false;
  private currentMode: ChatMode = DEFAULT_CHAT_MODE;
  private disposeConfigSubscription?: () => void;
  private storageManager: StorageManager;
  private sessionSyncHandle: NodeJS.Timeout | null = null;
  private _saveHistoryTimer: ReturnType<typeof setTimeout> | null = null;
  private historyLoaded!: Promise<void>;
  private historyLoadedResolve!: () => void;
  /**
   * Full API conversation including tool_calls and tool results.
   * Persisted between agent loop invocations so context is not lost.
   * Cleared on session switch / reset.
   */
  private _apiConversation: any[] = [];
  // Terminal confirmation pending promise (only one at a time)
  private pendingTerminalConfirmation: {
    resolve: (result: { confirmed: boolean; editedCommand?: string }) => void;
    reject: (error: Error) => void;
    command: string;
  } | null = null;
  // Iteration confirmation pending promise
  private pendingIterationConfirmation: {
    resolve: (confirmed: boolean) => void;
    reject: (error: Error) => void;
  } | null = null;
  // Terminal detach pending promise
  private pendingTerminalDetach: {
    resolve: () => void;
  } | null = null;
  // Tool approval pending promise (chat mode)
  private pendingToolApproval: {
    resolve: (approved: boolean) => void;
    reject: (error: Error) => void;
  } | null = null;
  // Domain handler
  private snapshots: SnapshotHandler;

  constructor(
    private readonly extensionUri: Uri, 
    config: ExtensionConfig, 
    private readonly context: ExtensionContext,
    configManager: ConfigManager
  ) {
    this.config = config;
    this.configManager = configManager;
    
    // Restore mode from storage
    const storedMode = this.context.globalState.get<ChatMode>(MODE_STORAGE_KEY);
    if (storedMode === 'chat' || storedMode === 'agent') {
      this.currentMode = storedMode;
    }
    
    // Initialize extracted domain handlers
    const self = this;
    this.snapshots = new SnapshotHandler({
      postMessage: (msg: any) => self.postMessage(msg)
    });
    
    this.rebuildClient();
    // Create promise that resolves when history is loaded
    this.historyLoaded = new Promise(resolve => {
      this.historyLoadedResolve = resolve;
    });
    // initialize storage manager and migrate/load history asynchronously
    this.storageManager = new StorageManager();
    this.storageManager.init()
      .then(() => this.storageManager.migrateFromGlobalStateIfPresent(this.context))
      .then(() => this.loadHistory())
      .then(() => {
        this.historyLoadedResolve();
        this.startSessionSync();
      })
      .catch(err => {
        logger.error('StorageManager init/migrate failed', err);
        this.historyLoadedResolve(); // resolve anyway to not block forever
      });
    this.configManager.reload();
    this.loadSelectedModel();
    this.disposeConfigSubscription = this.configManager.onDidChange(() => {
      logger.log('Config updated, syncing chat models...');
      this.syncModelsToView();
      if (this.view) {
        this.postMessage({ type: "updateModelText", value: this.selectedModel?.name ?? null });
      }
    });
    this.context.subscriptions.push({ dispose: () => this.disposeConfigSubscription?.() });
    
    logger.log(`ChatViewProvider initialized. Models available: ${this.configManager.getModels().length}`);
  }

  public updateConfig(config: ExtensionConfig) {
    // Skip entire update if we're in the middle of a batch save or model change
    // (config.update triggers onDidChangeConfiguration before all settings are written)
    if (this._suppressConfigReload) return;
    this.config = config;
    if (this.selectedModel) {
      this.applyModelOverridesFromSelection(false, true);
    }
    this.rebuildClient();
  }

  public resolveWebviewView(webviewView: WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    logger.log(`[WebView] resolveWebviewView called. selectedModel: ${this.selectedModel?.name || 'null'}`);

    // If selectedModel is null, try to restore it
    if (!this.selectedModel) {
      logger.log('[WebView] selectedModel is null, attempting to restore...');
      this.loadSelectedModel();
    }

    // Don't restore auth state immediately - wait for webviewReady message
    // This ensures webview JavaScript is loaded and can receive messages

    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.abortController?.abort();
      this.stopSessionSync();
      this.cancelPendingTerminalConfirmation();
    });

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "webviewReady":
          // Webview is ready to receive messages
          logger.log('[WebView] Received webviewReady signal');
          // Auth disabled — skip restoreStateToView
          // Also sync models
          this.syncModelsToView();
          this.postMessage({ type: "updateModelText", value: this.selectedModel?.name ?? null });
          // Restore mode
          this.postMessage({ type: 'restoreMode', mode: this.currentMode });
          // Restore saved settings (API keys, URLs, etc.)
          {
            const cfg = workspace.getConfiguration("ashibaltAi");
            const providerSettings = cfg.get<Record<string, any>>("providerSettings", {});
            const ollamaBaseUrl = cfg.get<string>("ollamaBaseUrl", "http://localhost:11434");
            const agentIterations = cfg.get<number>("agentIterations", 25);
            const autoRunTerminal = cfg.get<boolean>("autoRunTerminal", false);
            this.postMessage({
              type: 'restoreSettings',
              providerSettings,
              ollamaBaseUrl,
              agentIterations,
              autoRunTerminal
            });
          }
          // Wait for history/sessions to be loaded from disk before restoring.
          // Without this, pendingRestoreSessionId may still be null if
          // loadHistory() hasn't completed yet — a race condition.
          await this.historyLoaded;
          // Auto-restore last session (skip snapshot check on startup)
          if (this.pendingRestoreSessionId) {
            const sessionId = this.pendingRestoreSessionId;
            this.pendingRestoreSessionId = null;
            logger.log(`[WebView] Auto-restoring last session: ${sessionId}`);
            this.loadSession(sessionId);
          }
          // Send pending snapshots state AFTER webview is fully ready.
          // Must wait for snapshotManager.init() to complete — otherwise snapshots
          // haven't been loaded from disk yet and the dashboard shows empty.
          {
            const sm = getSnapshotManager();
            sm.ready().then(() => {
              this.snapshots.sendUpdate();
              logger.log(`[WebView] Snapshot dashboard sent on webviewReady. hasPending=${sm.hasPendingChanges()}`);
            }).catch(() => {
              // Fallback: send anyway even if init failed
              this.snapshots.sendUpdate();
            });
          }
          break;
        case "sendMessage":
          // Auth check disabled — all users can send messages

          if (message.selectedModelId && message.selectedModelId !== this.selectedModel?.id) {
            this.syncSelectedModelFromWebview(
              message.selectedModelId,
              message.selectedModelProvider,
              message.selectedModelName
            );
          }

          await this.handleUserMessage(String(message.value ?? ""), message.mode || 'agent');
          break;
        case "modeChanged":
          // Mode changed notification from UI
          this.currentMode = message.mode === 'chat' ? 'chat' : 'agent';
          void this.context.globalState.update(MODE_STORAGE_KEY, this.currentMode);
          logger.log(`[Mode] Switched to: ${this.currentMode}`);
          break;
        case "clearChat": {
          const snapshotMgrClear = getSnapshotManager();
          if (snapshotMgrClear.hasPendingChanges()) {
            // Store null to indicate "new chat" (not session switch)
            this.pendingLoadSessionId = null;
            this.postMessage({ type: 'confirmSessionSwitch' });
          } else {
            this.resetConversation();
          }
          break;
        }
        case "addCurrentFile": {
          const editor = window.activeTextEditor;
          if (editor) {
            const fullPath = editor.document.fileName;
            const filename = fullPath.split(/[\\/]/).pop();
            try {
              const stat = await workspace.fs.stat(Uri.file(fullPath));
              const maxSize = 64 * 1024; // 64KB
              if (stat.type === FileType.Directory) {
                window.showErrorMessage(`"${filename}" — это папка; добавление папок в контекст запрещено.`);
              } else if (stat.size > maxSize) {
                window.showErrorMessage(`Файл "${filename}" слишком большой для добавления в контекст (размер > 64KB).`);
              } else {
                // extension-based checks
                const ext = (() => {
                  if (!filename) return '';
                  const parts = filename.split('.');
                  if (parts.length < 2) return '';
                  const last = parts[parts.length - 1];
                  return last ? last.toLowerCase() : '';
                })();
                const archiveExts = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2']);
                const videoExts = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'mpeg', 'mpg']);
                const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'tiff']);

                if (archiveExts.has(ext)) {
                  window.showErrorMessage(`Архивы (${ext}) запрещены для добавления в контекст.`);
                } else if (videoExts.has(ext)) {
                  window.showErrorMessage(`Видео-файлы (${ext}) запрещены для добавления в контекст.`);
                } else {
                  // If extension unknown, or to detect binary, read file and check for null bytes
                  try {
                    const content = await workspace.fs.readFile(Uri.file(fullPath));
                    const isBinary = content.some(b => b === 0);
                    if (isBinary && !imageExts.has(ext)) {
                      window.showErrorMessage(`Бинарные файлы не поддерживаются для добавления в контекст.`);
                    } else {
                      if (!this.contextFiles.has(fullPath)) {
                        this.contextFiles.add(fullPath);
                        this.postMessage({ type: "addContext", label: filename, path: fullPath, icon: getIconForFile(filename || '') });
                      } else {
                        window.showInformationMessage('File already added to context.');
                      }
                    }
                  } catch (e) {
                    logger.error(`Failed to read file ${fullPath}`, e);
                    window.showErrorMessage(`Не удалось добавить файл ${filename}: ошибка чтения файла.`);
                  }
                }
              }
            } catch (e) {
              logger.error(`Failed to stat file ${fullPath}`, e);
              window.showErrorMessage(`Не удалось добавить файл ${filename}: ошибка чтения файла.`);
            }
          } else {
            window.showInformationMessage("No active file to add.");
          }
          break;
        }
  case "attachFile": {
          const files = await window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Attach'
          });
          if (files) {
            for (const file of files) {
              const fullPath = file.fsPath;
              const filename = fullPath.split(/[\\/]/).pop();
              try {
                const stat = await workspace.fs.stat(Uri.file(fullPath));
                const maxSize = 64 * 1024; // 64KB
                if (stat.type === FileType.Directory) {
                  window.showErrorMessage(`"${filename}" — это папка; добавление папок в контекст запрещено.`);
                  continue;
                }
                if (stat.size > maxSize) {
                  window.showErrorMessage(`Файл "${filename}" слишком большой для добавления в контекст (размер > 64KB).`);
                  continue;
                }

                const ext = (() => {
                  if (!filename) return '';
                  const parts = filename.split('.');
                  if (parts.length < 2) return '';
                  const last = parts[parts.length - 1];
                  return last ? last.toLowerCase() : '';
                })();
                const archiveExts = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2']);
                const videoExts = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'mpeg', 'mpg']);
                const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'tiff']);

                if (archiveExts.has(ext)) {
                  window.showErrorMessage(`Архивы (${ext}) запрещены для добавления в контекст.`);
                  continue;
                }
                if (videoExts.has(ext)) {
                  window.showErrorMessage(`Видео-файлы (${ext}) запрещены для добавления в контекст.`);
                  continue;
                }

                try {
                  const content = await workspace.fs.readFile(Uri.file(fullPath));
                  const isBinary = content.some(b => b === 0);
                  if (isBinary && !imageExts.has(ext)) {
                    window.showErrorMessage(`Бинарные файлы не поддерживаются для добавления в контекст.`);
                    continue;
                  }
                } catch (e) {
                  logger.error(`Failed to read file ${fullPath}`, e);
                  window.showErrorMessage(`Не удалось добавить файл ${filename}: ошибка чтения файла.`);
                  continue;
                }

                if (!this.contextFiles.has(fullPath)) {
                  this.contextFiles.add(fullPath);
                  this.postMessage({ type: "addContext", label: filename, path: fullPath, icon: getIconForFile(filename || '') });
                } else {
                  // skip duplicates silently
                }
              } catch (e) {
                logger.error(`Failed to stat file ${fullPath}`, e);
                window.showErrorMessage(`Не удалось добавить файл ${filename}: ошибка чтения файла.`);
              }
            }
          }
          break;
        }
        case "pasteImage": {
          // Treat pasted images as context attachments (do not create a user message)
          const ext = String(message.mime || 'image/png').split('/').pop() || 'png';
          const name = String(message.name || `Вставленное изображение.${ext}`);
          const mime = String(message.mime || 'image/png');
          const size = Number(message.size || 0);
          const id = `pasted_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
          const pseudoPath = `pasted:${id}`;
          if (!this.contextFiles.has(pseudoPath)) {
            this.contextFiles.add(pseudoPath);
            this.contextAttachments.set(pseudoPath, { mime, dataUrl: message.dataUrl, name, size });
            // Notify webview to render a context chip (label + path)
            this.postMessage({ type: 'addContext', label: name, path: pseudoPath, icon: getIconForFile(name) });
          } else {
            window.showInformationMessage('Image already added to context.');
          }
          break;
        }
        
        case "removeContext": {
          // If it's a pasted attachment, remove from attachments map as well
          this.contextFiles.delete(message.path);
          if (String(message.path).startsWith('pasted:')) {
            this.contextAttachments.delete(message.path);
          }
          break;
        }
        case "selectModel": {
          const models = ['Claude 3 Opus', 'GPT-4', 'Gemini Pro'];
          const selected = await window.showQuickPick(models, { placeHolder: 'Select Model' });
          if (selected) {
             let model = "";
             if (selected.includes("Claude")) model = "anthropic/claude-3-opus";
             else if (selected.includes("GPT-4")) model = "openai/gpt-4-turbo";
             else if (selected.includes("Gemini")) model = "google/gemini-pro";
             
             const config = workspace.getConfiguration("ashibaltAi");
             await config.update("provider", "openrouter", true);
             await config.update("openRouterModel", model, true);
             
             window.showInformationMessage(`Switched to ${selected}`);
             this.postMessage({ type: "updateModelText", value: selected });
          }
          break;
        }
        case "showHistory": {
           this.postMessage({ type: "updateHistory", sessions: this.sessions });
           break;
        }
        case "forgetMessages": {
           if (Array.isArray(message.ids) && message.ids.length > 0) {
             const idsToForget = new Set(message.ids.map(String));

             // Rollback file snapshots for assistant messages being removed
             const sm = getSnapshotManager();
             const pendingSnapshots = sm.getPendingSnapshots();
             for (const msg of this.history) {
               if (msg.role === 'assistant' && msg.id && idsToForget.has(String(msg.id)) && (msg as any).actions) {
                 const fileActions = ((msg as any).actions as any[]).filter((a: any) =>
                   a.type === 'edit_file' || a.type === 'create_file' || a.type === 'delete_file'
                 );
                 for (const fa of fileActions) {
                   if (fa.filePath) {
                     const snap = pendingSnapshots.find(s => s.filePath === fa.filePath);
                     if (snap) {
                       await sm.rollbackSnapshot(snap.id).catch(err => logger.error('Rollback on forgetMessages failed:', err));
                     }
                   }
                 }
               }
             }

             this.history = this.history.filter(m => !m.id || !idsToForget.has(String(m.id)));
             this.saveHistory();

             // Remove from persistent messages.jsonl
             for (const id of idsToForget) {
               this.storageManager.removeMessage(this.currentSessionId, String(id)).catch(() => {});
             }

             // Prune _apiConversation: remove trailing assistant/tool messages
             const beforePrune = this._apiConversation.length;
             while (this._apiConversation.length > 0) {
               const last = this._apiConversation[this._apiConversation.length - 1];
               if (last.role === 'assistant' || last.role === 'tool') {
                 this._apiConversation.pop();
               } else { break; }
             }
             logger.log(`[API_CONV] forgetMessages prune: ${beforePrune} -> ${this._apiConversation.length}`);
             this.storageManager.saveApiConversation(this.currentSessionId, this._apiConversation).catch(() => {});

             // Re-render view from updated history (include actions for tool indicators)
             this.postMessage({ type: "clearChat" });
             for (const msg of this.history) {
               this.postMessage({ type: "addMessage", role: msg.role, content: msg.content, id: msg.id, actions: (msg as any).actions, modelName: msg.modelName });
             }

             // Re-send metrics so dashboard stays visible after undo
             this.storageManager.loadSessionMetrics(this.currentSessionId).then(metrics => {
               if (metrics.apiCalls > 0) {
                 this.postMessage({ type: 'metricsUpdate', id: '', metrics });
               }
             }).catch(() => {});
           }
           break;
        }
        case "loadSession": {
           // Check for pending snapshot changes before switching
           const snapshotMgr = getSnapshotManager();
           if (snapshotMgr.hasPendingChanges()) {
             // Ask user what to do about pending changes
             this.pendingLoadSessionId = message.sessionId;
             this.postMessage({ type: "confirmSessionSwitch" });
           } else {
             this.loadSession(message.sessionId);
           }
           break;
        }
        case "sessionSwitchConfirmed": {
           const action = message.action as string;
           const targetSessionId = this.pendingLoadSessionId;
           this.pendingLoadSessionId = null;
           
           if (action === 'save') {
             const sm = getSnapshotManager();
             await sm.confirmAll();
             if (targetSessionId) {
               this.loadSession(targetSessionId);
             } else {
               // New chat requested
               this.resetConversation();
             }
           } else if (action === 'revert') {
             const sm = getSnapshotManager();
             await sm.rollbackAll();
             if (targetSessionId) {
               this.loadSession(targetSessionId);
             } else {
               // New chat requested
               this.resetConversation();
             }
           }
           // action === 'cancel' — do nothing, stay on current session
           break;
        }
        case "saveModel": {
       const model = message.model as AIModel | undefined;
       if (!model?.name || !model?.id || !model?.provider) {
         window.showErrorMessage("Нельзя сохранить модель без имени, идентификатора и провайдера.");
         return;
       }

       try {
         // If contextLength is missing, try to fetch it from provider API
         if (!model.contextLength) {
           try {
             const { resolveProviderConnection } = await import('../chatClientFactory');
             const { baseUrl, apiKey } = resolveProviderConnection(this.config, model.provider);
             const ctx = await this.configManager.fetchSingleModelContextLength(
               model.provider, model.id, baseUrl, apiKey
             );
             if (ctx) model.contextLength = ctx;
           } catch {
             // Non-critical — save model without contextLength
           }
         }

         this.configManager.addModel(model);

         // Show any warnings from provider API (deprecated, no tools, etc.)
         const warnings = this.configManager.getModelWarnings(model.id);
         if (warnings.length > 0) {
           window.showWarningMessage(`Модель "${model.name}": ${warnings.join(' ')}`);
         }

         const ctxInfo = model.contextLength ? ` (контекст: ${Math.round(model.contextLength / 1024)}K)` : '';
         window.showInformationMessage(`Модель "${model.name}" сохранена.${ctxInfo}`);
         this.syncModelsToView();
       } catch (error: any) {
         window.showErrorMessage(error.message || "Не удалось сохранить модель.");
       }
       break;
        }
        case "deleteModel": {
       try {
         this.configManager.deleteModel(message.id);
         
         if (this.selectedModel && this.selectedModel.id === message.id) {
           this.selectedModel = null;
           this.postMessage({ type: "updateModelText", value: null });
         }

         window.showInformationMessage("Модель удалена.");
         this.syncModelsToView();
       } catch (error: any) {
         window.showErrorMessage(error.message || "Не удалось удалить модель.");
       }
       break;
        }
        case "clearAllModels": {
          this.configManager.clearAllModels();
          this.selectedModel = null;
          this.postMessage({ type: "updateModelText", value: null });
          window.showInformationMessage("Все модели удалены.");
          this.syncModelsToView();
          break;
        }
        case "sendFeedback": {
          // Open GitHub Issues page for bug reports
          env.openExternal(Uri.parse('https://github.com/Ashibalt/Ashibalt-AI/issues'));
          break;
        }
        case "refreshOllamaModels": {
          try {
            const models = await this.configManager.fetchOllamaModels();
            const ollamaCount = models.filter(m => m.provider === 'ollama').length;
            if (ollamaCount > 0) {
              window.showInformationMessage(`Загружено ${ollamaCount} моделей из Ollama`);
            } else {
              window.showWarningMessage('Не удалось найти модели Ollama. Убедитесь что Ollama запущена.');
            }
            this.syncModelsToView();
          } catch (error: any) {
            window.showErrorMessage(error.message || 'Не удалось подключиться к Ollama');
          }
          break;
        }
        case "fetchProviderModels": {
          const provider = message.provider;
          const url = message.url;
          const apiKey = message.apiKey || '';
          try {
            const models = await this.configManager.fetchProviderModels(provider, url, apiKey);
            if (models.length > 0) {
              if (provider === 'ollama') {
                // Ollama auto-saves — just sync
                window.showInformationMessage(`Загружено ${models.length} моделей от ${provider}`);
                this.syncModelsToView();
              } else {
                // Cloud providers — send models list for browsing
                this.postMessage({ 
                  type: 'providerModelsList', 
                  provider, 
                  models: models.map(m => ({ id: m.id, name: m.name, provider: m.provider, contextLength: m.contextLength }))
                });
              }
            } else {
              window.showWarningMessage(`Нет доступных моделей от ${provider}`);
            }
            this.postMessage({ type: 'fetchProviderModelsResult', provider, success: true });
          } catch (error: any) {
            window.showErrorMessage(`Ошибка загрузки моделей ${provider}: ${error.message}`);
            this.postMessage({ type: 'fetchProviderModelsResult', provider, success: false });
          }
          break;
        }
        case "getSlashCommands": {
          // Return list of available slash commands for autocomplete
          this.postMessage({ 
            type: "slashCommands", 
            commands: SLASH_COMMANDS.map(c => ({
              name: c.name,
              description: c.description,
              args: c.args
            }))
          });
          break;
        }
        case "getFileCompletions": {
          // Return list of files matching query for # autocomplete
          const query = message.query || '';
          const files = await this.getWorkspaceFiles(query);
          this.postMessage({ type: "fileCompletions", files, query });
          break;
        }
        case "deleteSession": {
           this.deleteSession(message.sessionId);
           break;
        }
        case "assignModel": {
           // message: { type: 'assignModel', category: 'chat'|'code', modelId: string }
           const config = workspace.getConfiguration("ashibaltAi");
           
           if (message.category === 'code') {
               try {
                 this.configManager.setCodeModel(message.modelId || null);
                 await config.update("autocompleteModel", message.modelId, true);
                 await config.update("refactorModel", message.modelId, true);
                 window.showInformationMessage(`Модель для автодополнения и рефакторинга обновлена`);
               } catch (error: any) {
                 window.showErrorMessage(error.message || "Не удалось назначить модель");
               }
           } else {
               const key = message.category + "Model"; // e.g. chatModel
               await config.update(key, message.modelId, true);
               window.showInformationMessage(`Модель ${message.category} обновлена`);
           }
           break;
        }
        case "setModel": {
           const { provider, id, name } = message;
           logger.log(`[SetModel] Received request to set model: ${id} (${provider})`);
           
           // Apply model FIRST to avoid race condition:
           // config.update triggers onDidChangeConfiguration which would
           // re-send the OLD model to the webview before applySelectedModel runs
           const models = this.configManager.getModels();
           let picked = models.find((model) => model.id === id && model.provider === provider);
           if (!picked) {
             // Create stub with contextLength from cache if available
             const cachedCtx = this.configManager.getCachedContextLength(id);
             picked = { provider, id, name, ...(cachedCtx ? { contextLength: cachedCtx } : {}) } as AIModel;
           }
           this.applySelectedModel(picked);
           
           // Suppress config reload while persisting settings
           this._suppressConfigReload = true;
           try {
             const config = workspace.getConfiguration("ashibaltAi");
             await config.update("provider", provider, true);
             await config.update("openRouterModel", id, true);
           } finally {
             this._suppressConfigReload = false;
           }
           
           window.showInformationMessage(`Выбрана модель ${name}`);
           break;
        }
        case "saveSettings": {
           // Suppress onDidChangeConfiguration during batch updates to avoid
           // multiple config reloads and client rebuilds per save.
           this._suppressConfigReload = true;
           try {
           const config = workspace.getConfiguration("ashibaltAi");

           // Helper: update a single config key, log errors but don't throw
           const safeUpdate = async (key: string, value: any) => {
             try {
               await config.update(key, value, true);
             } catch (err) {
               logger.log(`[SaveSettings] Failed to update '${key}': ${err}`);
             }
           };

           if (message.agentIterations !== undefined) {
               await safeUpdate("agentIterations", message.agentIterations);
           }
           if (message.autoRunTerminal !== undefined) {
               await safeUpdate("autoRunTerminal", message.autoRunTerminal);
           }
           if (message.metricsEnabled !== undefined) {
               await safeUpdate("metricsEnabled", message.metricsEnabled);
           }
           if (message.ollamaBaseUrl !== undefined) {
               await safeUpdate("ollamaBaseUrl", message.ollamaBaseUrl);
           }
           // Save all provider-specific settings (URLs and API keys)
           if (message.providerSettings) {
             const ps = message.providerSettings;
             logger.log(`[SaveSettings] Received providerSettings: ${JSON.stringify(ps)}`);
             // Merge with existing providerSettings
             const existing = config.get<Record<string, any>>("providerSettings", {});
             const merged = { ...existing };
             for (const [prov, val] of Object.entries(ps) as [string, any][]) {
               if (!val) continue;
               if (!merged[prov]) merged[prov] = {};
               // Use !== undefined to allow clearing fields (empty string is valid)
               if (val.url !== undefined) merged[prov].url = val.url;
               if (val.apiKey !== undefined) merged[prov].apiKey = val.apiKey;
             }
             logger.log(`[SaveSettings] Merged providerSettings: ${JSON.stringify(merged)}`);
             await safeUpdate("providerSettings", merged);
             // Also keep legacy openrouter keys in sync
             if (ps.openrouter?.apiKey) {
               await safeUpdate("openRouterApiKey", ps.openrouter.apiKey);
             }
             if (ps.openrouter?.url) {
               await safeUpdate("openRouterBaseUrl", ps.openrouter.url);
             }
           } else {
             logger.log(`[SaveSettings] No providerSettings in message`);
           }
           } finally {
             // Reload config and rebuild client ONCE after all updates,
             // BEFORE releasing the suppress flag to prevent race conditions
             // with onDidChangeConfiguration events.
             this.config = loadExtensionConfig();
             logger.log(`[SaveSettings] Reloaded config. providerSettings: ${JSON.stringify(this.config.providerSettings)}`);
             this.rebuildClient();
             this._suppressConfigReload = false;
           }
           break;
        }
        case "metricsToggle": {
           const { metricsService } = await import('../Services/metricsService');
           if (message.enabled) {
             metricsService.enable(message.metrics || { totalRequests: 0, inputTokens: 0, outputTokens: 0, toolUsage: {}, modelUsage: {} });
           } else {
             metricsService.disable();
           }
           break;
        }
        case "openExternal": {
           if (message.url) {
               const { env } = await import('vscode');
               env.openExternal(Uri.parse(message.url));
           }
           break;
        }

      case "undoMessage": {
        // Rollback file snapshots associated with this response before removing it
        const lastMsg = this.history.length > 0 ? this.history[this.history.length - 1] : null;
        if (lastMsg && lastMsg.role === 'assistant' && (lastMsg as any).actions) {
          const sm = getSnapshotManager();
          const pendingSnapshots = sm.getPendingSnapshots();
          const fileActions = ((lastMsg as any).actions as any[]).filter((a: any) => 
            a.type === 'edit_file' || a.type === 'create_file' || a.type === 'delete_file'
          );
          for (const fa of fileActions) {
            if (fa.filePath) {
              const snap = pendingSnapshots.find(s => s.filePath === fa.filePath);
              if (snap) {
                sm.rollbackSnapshot(snap.id).catch(err => logger.error('Rollback on undo failed', err));
              }
            }
          }
        }
        if (!this.pruneLastAssistantMessage(true)) {
          window.showInformationMessage("Нет ответа для удаления.");
        } else {
          // Re-send metrics so dashboard stays visible after undo
          this.storageManager.loadSessionMetrics(this.currentSessionId).then(metrics => {
            if (metrics.apiCalls > 0) {
              this.postMessage({ type: 'metricsUpdate', id: '', metrics });
            }
          }).catch(() => {});
        }
        break;
      }
      case "retryMessage": {
        // Rollback all file changes from the interrupted response before retrying
        const lastAssistant = this.history.length > 0 ? this.history[this.history.length - 1] : null;
        if (lastAssistant && lastAssistant.role === 'assistant' && (lastAssistant as any).actions) {
          const sm = getSnapshotManager();
          const pendingSnapshots = sm.getPendingSnapshots();
          const fileActions = ((lastAssistant as any).actions as any[]).filter((a: any) => 
            a.type === 'edit_file' || a.type === 'create_file' || a.type === 'delete_file'
          );
          for (const fa of fileActions) {
            if (fa.filePath) {
              const snap = pendingSnapshots.find(s => s.filePath === fa.filePath);
              if (snap) {
                sm.rollbackSnapshot(snap.id).catch(err => logger.error('Rollback on retry failed', err));
              }
            }
          }
        }

        // Try to prune last assistant message (normal retry from assistant footer).
        // If no assistant message to prune (e.g. provider error before any response),
        // still allow retry — just find the last user message.
        this.pruneLastAssistantMessage(true);

        // SAFETY: Always prune _apiConversation trailing assistant/tool messages on retry,
        // even if history didn't have an assistant at the end (can happen when error catch
        // removes temporary assistant from history but onConversationUpdate already saved
        // the full conversation with assistant messages).
        while (this._apiConversation.length > 0) {
          const last = this._apiConversation[this._apiConversation.length - 1];
          if (last.role === 'assistant' || last.role === 'tool') {
            this._apiConversation.pop();
          } else {
            break;
          }
        }
        this.storageManager.saveApiConversation(this.currentSessionId, this._apiConversation).catch(() => {});

        const lastUserMessage = this.getLastUserMessage();
        if (!lastUserMessage) {
          window.showWarningMessage("Не удалось найти исходный запрос пользователя для повтора.");
          break;
        }

        await this.requestAssistantResponse(lastUserMessage.mode ?? 'agent');
        break;
      }
      case "continueMessage": {
        // Continue without rollback — re-send with existing conversation context
        const lastUser = this.getLastUserMessage();
        if (!lastUser) {
          window.showWarningMessage("Не удалось найти исходный запрос пользователя для продолжения.");
          break;
        }
        // Remove footer (toolbar) from last assistant message — it's being continued
        this.postMessage({ type: 'removeLastAssistantFooter' });
        await this.requestAssistantResponse(lastUser.mode ?? 'agent');
        break;
      }
      case "stopStreaming": {
        this.isStreamingAborted = true;
        this.abortController?.abort();
        this.cancelPendingTerminalConfirmation();
        
        // Handle ALL temporary assistant messages after abort
        // (not just the last one — there could be multiple from tool calls)
        for (let i = this.history.length - 1; i >= 0; i--) {
          const msg = this.history[i];
          if (msg.role === 'assistant' && msg.temporary) {
            const hasContent = msg.content && msg.content.trim().length > 0;
            const hasActions = msg.actions && msg.actions.length > 0;
            if (hasContent || hasActions) {
              // Has partial content or actions — keep and finalize
              this.history[i].temporary = false;
              
              this.postMessage({ 
                type: 'streamEnd', 
                id: msg.id,
                content: msg.content,
                modelName: msg.modelName,
                actions: msg.actions
              });
              
              const toStore: any = {
                id: msg.id!,
                role: 'assistant',
                content: msg.content || '',
                timestamp: Date.now(),
                tokenCount: 0
              };
              if (msg.modelName) {
                toStore.modelName = msg.modelName;
              }
              if (msg.actions) {
                toStore.actions = msg.actions;
              }
              
              this.storageManager.createSession(this.currentSessionId).then(() => {
                this.storageManager.appendMessage(this.currentSessionId, toStore).catch(err => {
                  logger.error('Failed to save interrupted message', err);
                });
              }).catch(err => {
                logger.error('Failed to create session for interrupted message', err);
              });
            } else {
              // Empty/broken message — finalize it with a "stopped" notice
              // so the user can still see the retry button
              this.history[i].temporary = false;
              this.history[i].content = '*(запрос прерван)*';
              
              this.postMessage({ 
                type: 'streamEnd', 
                id: msg.id,
                content: '*(запрос прерван)*',
                modelName: msg.modelName,
                actions: msg.actions
              });
            }
          }
        }
        
        this.saveHistory();
        this.postMessage({ type: "setLoading", value: false });
        this._isProcessing = false;
        break;
      }
      // dropdownSelect removed — agent mode is always active.
      case "openConfigFolder": {
        window.showInformationMessage('Локальный config.json больше не используется. Настройки сохраняются внутри VS Code.');
        break;
      }
      case "confirmSnapshot": {
        await this.snapshots.confirmSnapshot(message.id);
        break;
      }
      case "revertSnapshot": {
        await this.snapshots.revertSnapshot(message.id);
        break;
      }
      case "confirmFile": {
        await this.snapshots.confirmFile(message.filePath);
        break;
      }
      case "revertFile": {
        await this.snapshots.revertFile(message.filePath);
        break;
      }
      case "confirmAllSnapshots": {
        await this.snapshots.confirmAll();
        break;
      }
      case "revertAllSnapshots": {
        await this.snapshots.revertAll();
        break;
      }
      case "openSnapshotFile": {
        if (message.filePath) {
          const doc = await workspace.openTextDocument(message.filePath);
          await window.showTextDocument(doc);
        }
        break;
      }
      case "openFile": {
        if (message.filePath) {
          try {
            // Sanitize path - remove any leading/trailing whitespace and newlines
            let filePath = String(message.filePath).trim();
            logger.log(`[openFile] Attempting to open: "${filePath}" (original: "${message.filePath}", line: ${message.line})`);
            
            // Check if path is valid (not empty, doesn't start with special chars that could be escape sequences)
            if (!filePath || filePath.length < 2) {
              logger.error('Invalid file path received - too short', { filePath: message.filePath });
              return;
            }
            
            // Resolve relative paths to workspace root
            const path = require('path');
            if (!path.isAbsolute(filePath)) {
              const folders = workspace.workspaceFolders;
              if (folders && folders.length > 0) {
                filePath = path.resolve(folders[0].uri.fsPath, filePath);
                logger.log(`[openFile] Resolved relative path to: "${filePath}"`);
              }
            }
            
            const doc = await workspace.openTextDocument(filePath);
            
            // If line number is provided, navigate to that line
            let selection: Range | undefined;
            if (typeof message.line === 'number' && message.line > 0) {
              // Convert 1-based line to 0-based Position
              const line = Math.max(0, message.line - 1);
              const position = new Position(line, 0);
              selection = new Range(position, position);
            }
            
            await window.showTextDocument(doc, { selection });
          } catch (e) {
            logger.error('Failed to open file', e);
          }
        }
        break;
      }
      case "terminalConfirmResponse": {
        // User responded to terminal confirmation dialog
        if (this.pendingTerminalConfirmation) {
          const confirmed = message.confirmed === true;
          const editedCommand = message.command || undefined;
          this.pendingTerminalConfirmation.resolve({ confirmed, editedCommand });
          this.pendingTerminalConfirmation = null;
        }
        break;
      }
      case "terminalDetach": {
        // User clicked "Продолжить без ожидания" while terminal command is running
        if (this.pendingTerminalDetach) {
          this.pendingTerminalDetach.resolve();
          this.pendingTerminalDetach = null;
        }
        break;
      }
      case "toolApprovalResponse": {
        // User responded to tool approval dialog (chat mode)
        if (this.pendingToolApproval) {
          this.pendingToolApproval.resolve(message.confirmed === true);
          this.pendingToolApproval = null;
        }
        break;
      }
      case "iterationConfirmResponse": {
        if (this.pendingIterationConfirmation) {
          const confirmed = message.confirmed === true;
          this.pendingIterationConfirmation.resolve(confirmed);
          this.pendingIterationConfirmation = null;
        }
        break;
      }
      // ===== AUTH HANDLERS (delegated to this.auth) =====
        default:
          break;
      }
    });

    // Listen for active editor changes to update the UI
    const editorChangeDisposable = window.onDidChangeActiveTextEditor(editor => {
      if (this.view && editor) {
        const filename = editor.document.fileName.split(/[\\/]/).pop();
        this.postMessage({ type: 'setCurrentFile', value: filename });
      }
    });
    webviewView.onDidDispose(() => editorChangeDisposable.dispose());

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.configManager.reload();
      }
    });

    this.flushPendingMessages();
    
    // Send initial models and restore chat immediately
    this.syncModelsToView();
    this.postMessage({ type: "updateModelText", value: this.selectedModel?.name ?? null });
    this.postMessage({ type: "setConfigPath", path: this.configManager.getConfigPath() });
    
    // Subscribe to snapshot changes to update dashboard
    const snapshotManager = getSnapshotManager();
    const unsubscribeSnapshots = snapshotManager.onChange(() => {
      this.snapshots.sendUpdate();
    });
    this.context.subscriptions.push({ dispose: unsubscribeSnapshots });
    
    // NOTE: Initial snapshot dashboard update is sent in the 'webviewReady' handler,
    // NOT here — at this point the webview JS hasn't loaded yet, so messages are lost.
    
    // NOTE: Session restore is handled in the 'webviewReady' handler
    // (which awaits historyLoaded before checking pendingRestoreSessionId).
    // Do NOT send clearChat/addMessage here — messages sent before webviewReady
    // are lost, and messages sent after could wipe a restored session.
  }

  private startSessionSync() {
    // poll every 3 seconds for external changes to sessions on disk
    if (this.sessionSyncHandle) return;
    this.sessionSyncHandle = setInterval(() => this.syncSessionsFromDisk().catch(e => logger.error('Session sync failed', e)), 3000) as any;
  }

  private stopSessionSync() {
    if (this.sessionSyncHandle) {
      clearInterval(this.sessionSyncHandle as any);
      this.sessionSyncHandle = null;
    }
  }

  private async syncSessionsFromDisk() {
    try {
      const idx = await this.storageManager.listSessions();
      const valid: any[] = [];
      for (const s of idx) {
        const exists = await this.storageManager.sessionExists(s.id);
        if (exists) valid.push(s);
      }
      // If index differs, update in-memory and notify view
      const idsOld = new Set(this.sessions.map(s => s.id));
      const idsNew = new Set(valid.map(v => v.id));
      let changed = false;
      if (idsOld.size !== idsNew.size) changed = true;
      if (!changed) {
        for (const id of idsOld) if (!idsNew.has(id)) { changed = true; break; }
      }
      if (changed) {
        this.sessions = valid.map((s: any) => ({ id: s.id, title: s.title, date: s.date, messages: [] } as ChatSession));
        // Persist cleaned index so disk and UI stay in sync
        (async () => {
          try {
            await this.storageManager.saveSessionsIndex(valid.map(v => ({ id: v.id, title: v.title, date: v.date })));
          } catch (err) {
            logger.error('Failed to persist cleaned sessions index after sync', err);
            try {
              this.context.globalState.update('chatSessions', this.sessions);
            } catch (e) {
              logger.error('Failed to update globalState fallback for sessions', e);
            }
          }
        })().catch(e => logger.error('Failed to persist cleaned sessions index after sync', e));
        // If currentSessionId no longer exists, pick first available or create new
        if (!this.sessions.find(x => x.id === this.currentSessionId)) {
          if (this.sessions.length > 0) {
            this.currentSessionId = this.sessions[0].id;
            await this.loadSession(this.currentSessionId);
          } else {
            this.currentSessionId = Date.now().toString();
            this.history = [];
            this.postMessage({ type: 'clearChat' });
          }
        }
        this.postMessage({ type: 'updateHistory', sessions: this.sessions });
      }
    } catch (e) {
      logger.error('syncSessionsFromDisk error', e);
    }
  }

  public async handleUserMessage(text: string, mode: ChatMode = 'agent') {
    logger.log(`[HandleUserMessage] text: "${text.substring(0, 20)}...", mode: ${mode}, selectedModel: ${this.selectedModel?.id}`);
    if (!this.view) return;

    // Lock mode on first message in this session (prevent switching mid-session)
    if (this.history.length === 0) {
      // First message — lock this mode for the session
      this.storageManager.saveSessionMode(this.currentSessionId, mode).catch(err => {
        logger.error('Failed to save session mode', err);
      });
      this.postMessage({ type: 'lockMode', locked: true });
      logger.log(`[Mode] Locked session mode: ${mode}`);
    }

    // Check for slash commands
    const parsed = parseSlashCommand(text);
    if (parsed) {
      const cmdDef = getCommand(parsed.command);
      
      if (!cmdDef) {
        // Unknown command - show available commands
        const available = SLASH_COMMANDS.map(c => `/${c.name}`).join(', ');
        window.showWarningMessage(`Неизвестная команда /${parsed.command}. Доступные: ${available}`);
        return;
      }
      
      // Handle immediate commands (no model interaction)
      if (cmdDef.immediate) {
        if (parsed.command === 'clear') {
          // Clear current session messages but keep session
          this.history = [];
          this.postMessage({ type: 'clearChat' });
          await this.storageManager.clearSession(this.currentSessionId);
          window.showInformationMessage('История сообщений очищена');
          return;
        } else if (parsed.command === 'new') {
          const snapshotMgrNew = getSnapshotManager();
          if (snapshotMgrNew.hasPendingChanges()) {
            this.pendingLoadSessionId = null;
            this.postMessage({ type: 'confirmSessionSwitch' });
          } else {
            this.resetConversation();
          }
          return;
        }
        return;
      }
      
      // Handle prompt-generating commands
      let hiddenPrompt = '';
      let displayText = text; // What user sees
      
      if (parsed.command === 'fix') {
        const filePath = parsed.args.join(' ');
        if (!filePath) {
          window.showWarningMessage('Укажите файл: /fix <путь к файлу>');
          return;
        }
        hiddenPrompt = generateFixPrompt(filePath);
        displayText = `/fix ${filePath}`;
      } else if (parsed.command === 'project_analysis') {
        hiddenPrompt = generateProjectAnalysisPrompt();
        displayText = '/project_analysis';
      } else if (parsed.command === 'workspace_fix') {
        hiddenPrompt = generateWorkspaceFixPrompt();
        displayText = '/workspace_fix';
      }
      
      if (hiddenPrompt) {
        // Send command to model with hidden prompt
        await this.sendCommandToModel(displayText, hiddenPrompt, mode);
        return;
      }
    }

    // ========================================================================
    // HASH REFERENCES HANDLING (#file, #folder/)
    // ========================================================================
    const processed = processHashReferences(text);
    const textForModel = processed.modelText;
    const displayText = processed.displayText;

    if (!this.ensureModelReady()) {
      return;
    }

    if (!this.view) {
      logger.log("Чат ещё не инициализирован. Сохраняю сообщение в очередь.");
      this.pendingHostMessages.push(displayText);
      await this.ensureViewVisible();
      return;
    }

  // Save current attached files before clearing them (delegated to helper)
  const attachedFilesForThisMessage: AttachedFile[] = await buildAttachedFilesFromContext(this.contextFiles, this.contextAttachments, getIconForFile);

  // Also save pasted images data to ensure they're available later
  const pastedImages: Record<string, any> = {};
  for (const [key, value] of this.contextAttachments.entries()) {
    if (String(key).startsWith('pasted:')) {
      pastedImages[key] = value;
    }
  }

  // Store the model-facing text (with expanded # references) but show user the display text
  const userId = this.addToHistory({ 
    role: "user", 
    content: textForModel, // Hidden prompt with # references expanded
    mode,
    attachedFiles: attachedFilesForThisMessage,
    pastedImages: Object.keys(pastedImages).length > 0 ? pastedImages : undefined
  });
  this.postMessage({ 
    type: "addMessage", 
    role: "user", 
    content: displayText, // User sees original text
    id: userId,
    attachedFiles: attachedFilesForThisMessage 
  });

  // Clear attached files after sending the message
  this.contextFiles.clear();
  this.contextAttachments.clear();
  this.postMessage({ type: "clearContext" });

  await this.requestAssistantResponse(mode);
  }

  /**
   * Send a slash command to the model with a hidden prompt
   * User sees displayText, model receives hiddenPrompt
   */
  private async sendCommandToModel(displayText: string, hiddenPrompt: string, mode: ChatMode = 'agent') {
    if (!this.ensureModelReady()) {
      return;
    }

    if (!this.view) {
      logger.log("Чат ещё не инициализирован.");
      return;
    }

    // Add user message to history (user sees display text, model gets hidden prompt)
    const userId = this.addToHistory({ 
      role: "user", 
      content: hiddenPrompt, // Hidden prompt for model
      mode
    });
    
    // Show display text to user
    this.postMessage({ 
      type: "addMessage", 
      role: "user", 
      content: displayText, // User sees command
      id: userId
    });

    await this.requestAssistantResponse(mode);
  }

  private async requestAssistantResponse(mode: ChatMode = 'agent') {
    logger.log(`[Request] requestAssistantResponse called. mode: ${mode}`);
    
    if (!this.view) {
      logger.log('[Request] No view, returning');
      return;
    }

    // Prevent concurrent requests
    if (this._isProcessing) {
      logger.log('[Request] Already processing a request, ignoring');
      return;
    }
    this._isProcessing = true;

    this.isStreamingAborted = false;
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;

    if (!this.ensureModelReady() || !this.selectedModel) {
      logger.log('[Request] Model not ready or not selected');
      this._isProcessing = false;
      return;
    }

    logger.log(`[Request] Using model: ${this.selectedModel.name} (${this.selectedModel.provider})`);

    const messages = await this.composeMessages();
    let buffer = "";
    let reasoningBuffer = "";
    this.postMessage({ type: "setLoading", value: true });

    const activeProvider = this.selectedModel.provider;
    const activeModel = this.selectedModel.id;

    const chatOptions: any = {
      model: activeModel,
      messages,
      stream: true,
      signal: controller.signal
    };

  // Route to correct API based on provider — use centralized resolver
  {
    const { resolveProviderConnection } = await import('../chatClientFactory');
    const resolved = resolveProviderConnection(this.config, activeProvider as any);
    // Build provider messages: reuse stored API conversation if available
    // (preserves tool_calls and tool results from prior agent loop iterations)
    let providerMessages: any[];
    if (this._apiConversation.length > 0) {
      // Append new user message(s) that aren't already in the conversation
      // Find the last user message in messages array (the one just sent)
      const newUserMessages = messages.filter(m => m.role === 'user');
      const lastNewUser = newUserMessages[newUserMessages.length - 1];
      if (lastNewUser) {
        // Check if already appended (avoid duplicates on retry)
        const lastConvUser = [...this._apiConversation].reverse().find(m => m.role === 'user');
        const lastConvMsg = this._apiConversation[this._apiConversation.length - 1];
        if (!lastConvUser || lastConvUser.content !== lastNewUser.content) {
          this._apiConversation.push({ role: 'user', content: lastNewUser.content });
        } else if (lastConvMsg && lastConvMsg.role === 'assistant') {
          // Conversation ends with assistant (e.g. after rate limit on Continue).
          // API requires last message to be user or tool — append user message.
          this._apiConversation.push({ role: 'user', content: lastNewUser.content });
        }
      }

      // SAFETY NET: Guarantee conversation never ends with assistant role.
      // This catches ALL edge cases (partial saves on error, interrupted streams, etc.)
      // that would cause 400 "Expected last role User or Tool but got assistant".
      const finalMsg = this._apiConversation[this._apiConversation.length - 1];
      if (finalMsg && finalMsg.role === 'assistant') {
        const userContent = (lastNewUser?.content) || 'Продолжай выполнение задачи.';
        this._apiConversation.push({ role: 'user', content: userContent });
        logger.log('[API_CONV] Safety: conversation ended with assistant — appended user message');
      }

      // Remove empty assistant messages that would cause API errors
      this._apiConversation = this._apiConversation.filter((msg: any) => {
        if (msg.role === 'assistant' && !msg.content && (!msg.tool_calls || msg.tool_calls.length === 0)) {
          logger.log('[API_CONV] Removed empty assistant message');
          return false;
        }
        return true;
      });

      providerMessages = this._apiConversation;

      // Normalize tool_call IDs for Mistral compatibility (requires [a-zA-Z0-9]{9})
      if (activeProvider === 'mistral') {
        const idMap = new Map<string, string>();
        const genShortId = () => {
          const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
          let id = '';
          for (let i = 0; i < 9; i++) id += chars[Math.floor(Math.random() * chars.length)];
          return id;
        };
        const remap = (oldId: string): string => {
          if (!oldId || /^[a-zA-Z0-9]{9}$/.test(oldId)) return oldId;
          if (!idMap.has(oldId)) idMap.set(oldId, genShortId());
          return idMap.get(oldId)!;
        };
        for (const msg of providerMessages) {
          if (msg.role === 'assistant' && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              tc.id = remap(tc.id);
            }
          }
          if (msg.role === 'tool' && msg.tool_call_id) {
            msg.tool_call_id = remap(msg.tool_call_id);
          }
        }
      }
    } else {
      providerMessages = messages.map(m => ({ role: m.role, content: m.content }));
      logger.log(`[Context] Starting fresh conversation: ${providerMessages.length} messages`);
    }
    
    let apiBaseUrl = resolved.baseUrl;
    let apiKey = resolved.apiKey;

    const modelId = activeModel;

    logger.log(`[Request] Provider: ${activeProvider}, apiKey present: ${!!apiKey}, baseUrl: ${apiBaseUrl}`);
    logger.log(`[Request] Config providerSettings: ${JSON.stringify(this.config.providerSettings)}`);

    // Validate: require API key for cloud providers
    if (activeProvider !== 'ollama' && !apiKey) {
      const providerNames: Record<string, string> = {
        mistral: 'Mistral', openrouter: 'OpenRouter', openai: 'OpenAI',
        claude: 'Claude', deepseek: 'DeepSeek', grok: 'Grok', gemini: 'Gemini'
      };
      const name = providerNames[activeProvider] || activeProvider;
      this.postMessage({
        type: "addMessage", role: "system",
        content: `🔑 API-ключ для ${name} не задан. Откройте настройки → ${name} → введите ключ → Сохранить.`
      });
      this.postMessage({ type: "setLoading", value: false });
      this._isProcessing = false;
      return;
    }
    
    // In Agent mode, use agent loop with full tools
    // In Chat mode, use agent loop with read-only tools (read, search, diagnose, fetch)
    if (mode === 'agent' || mode === 'chat') {
      const isChat = mode === 'chat';
      logger.log(`[Request] Using ${isChat ? 'CHAT' : 'AGENT'} mode with ${isChat ? 'read-only' : 'full'} tools`);
      
      // Import chat tools for chat mode
      let chatToolOverrides: any[] | undefined;
      let chatSystemPrompt: string | undefined;
      if (isChat) {
        const { chatTools } = await import('../Engine/toolCalling');
        const { getChatSystemPrompt } = await import('../promptUtils');
        chatToolOverrides = chatTools;
        chatSystemPrompt = getChatSystemPrompt();
      }
      
      // attempt agentic loop — if handled, return early
      try {
        const { runOpenRouterAgentLoop } = await import('../Engine/agentLoop');
        const handled = await runOpenRouterAgentLoop({
          baseUrl: apiBaseUrl,
          apiKey: apiKey, // OpenRouter API key or JWT token for Ashibalt
          model: modelId,
          providerMessages,
          currentSessionId: this.currentSessionId,
          storageManager: this.storageManager as any,
          addToHistory: (entry: any) => this.addToHistory(entry),
          postMessage: (p: any) => this.postMessage(p),
          getLastUserMessage: () => {
            const msg = this.getLastUserMessage();
            if (msg && msg.id) {
              return { id: msg.id, content: msg.content };
            }
            return undefined;
          },
          updateHistoryEntry: (id: string, content: string, temporary?: boolean, fileActions?: any[], modelName?: string) => {
            const idx = this.history.findIndex(h => h.id === id);
            if (idx !== -1) {
              this.history[idx].content = content;
              this.history[idx].temporary = temporary ?? false;
              if (fileActions) {
                this.history[idx].actions = fileActions;
              }
              if (modelName) {
                this.history[idx].modelName = modelName;
              }
              // Debounce saveHistory during streaming (temporary=true) to avoid I/O spam
              if (temporary) {
                if (!this._saveHistoryTimer) {
                  this._saveHistoryTimer = setTimeout(() => {
                    this._saveHistoryTimer = null;
                    this.saveHistory();
                  }, 2000);
                }
              } else {
                // Final save — flush immediately and persist message content to storage
                if (this._saveHistoryTimer) {
                  clearTimeout(this._saveHistoryTimer);
                  this._saveHistoryTimer = null;
                }
                this.saveHistory();
                // Persist finalized message content to storage (crash-safe)
                const h = this.history[idx];
                if (h.content && h.content.trim().length > 0) {
                  const toStore: any = {
                    id: h.id!,
                    role: h.role,
                    content: h.content,
                    timestamp: Date.now(),
                    tokenCount: 0
                  };
                  if (h.modelName) toStore.modelName = h.modelName;
                  if (h.actions) toStore.actions = h.actions;
                  this.storageManager.createSession(this.currentSessionId).then(() => {
                    this.storageManager.appendMessage(this.currentSessionId, toStore).catch(err => {
                      logger.error('Failed to persist finalized agent message', err);
                    });
                  }).catch(err => {
                    logger.error('Failed to create session for finalized agent message', err);
                  });
                }
              }
            }
          },
          onReasoning: (reasoning) => {
            reasoningBuffer = reasoning;
          },
          signal: controller.signal,
          requestTerminalConfirmation: this.requestTerminalConfirmation.bind(this),
          createDetachPromise: () => {
            return new Promise<void>((resolve) => {
              this.pendingTerminalDetach = { resolve };
            });
          },
          requestIterationConfirmation: this.requestIterationConfirmation.bind(this),
          ...(isChat ? {
            toolOverrides: chatToolOverrides,
            maxIterationsOverride: 25,
            systemPromptOverride: chatSystemPrompt,
            isChat: true,
            requestToolApproval: this.requestToolApproval.bind(this)
          } : {}),
          contextLength: this.resolveContextLength(),
          onConversationUpdate: (msgs: any[]) => {
            this._apiConversation = msgs;
            const assistantCount = msgs.filter((m: any) => m.role === 'assistant').length;
            const toolCount = msgs.filter((m: any) => m.role === 'tool').length;
            logger.log(`[API_CONV] update session=${this.currentSessionId} total=${msgs.length} assistant=${assistantCount} tool=${toolCount}`);
            // Persist to disk so context survives session switches
            this.storageManager.saveApiConversation(this.currentSessionId, msgs).catch(err => {
              logger.error('Failed to persist API conversation', err);
            });
          }
        });

        if (handled) {
          this.postMessage({ type: "setLoading", value: false });
          this._isProcessing = false;
          return; // agent loop processed response
        }
      } catch (e: any) {
        logger.error('Failed to run agent loop helper', e);
        const errMsg = e.message || String(e);
        const isAborted = errMsg.includes('abort') || errMsg.includes('Aborted');

        // Protect partial content: save temporary assistant messages that have content
        // instead of deleting them (prevents session history loss)
        for (const h of this.history) {
          if (h.role === 'assistant' && h.temporary) {
            const hasContent = h.content && h.content.trim().length > 0;
            const hasActions = h.actions && h.actions.length > 0;
            if (hasContent || hasActions) {
              // Has partial content or actions — finalize it with [interrupted] marker
              h.temporary = false;
              const tag = isAborted ? '' : '\n\n*[Ответ прерван из-за ошибки]*';
              h.content = (h.content || '') + tag;
              this.postMessage({ type: 'streamEnd', id: h.id, content: h.content, modelName: h.modelName, actions: h.actions });
              // Persist to storage
              const toStore: any = { id: h.id!, role: 'assistant', content: h.content, timestamp: Date.now(), tokenCount: 0 };
              if (h.modelName) toStore.modelName = h.modelName;
              if (h.actions) toStore.actions = h.actions;
              this.storageManager.createSession(this.currentSessionId).then(() => {
                this.storageManager.appendMessage(this.currentSessionId, toStore).catch(() => {});
              }).catch(() => {});
            } else {
              // Empty message — remove to prevent 400 errors
              this.postMessage({ type: 'removeMessage', id: h.id });
            }
          }
        }
        // Remove empty temporary messages from history array
        this.history = this.history.filter(h => !(h.role === 'assistant' && h.temporary));
        this.saveHistory();

        // Show error to user (NOT on manual abort — user knows they pressed Stop)
        if (!isAborted) {
          this.postMessage({
            type: "addMessage",
            role: "system",
            content: errMsg,
            errorDetails: (e as any).errorDetails || undefined
          });
        }
        // Manual abort: no notification needed — the stop button already communicated intent
        this.postMessage({ type: "setLoading", value: false });
        this._isProcessing = false;
        return;
      }
    } else {
      logger.log(`[Request] Unknown mode "${mode}" - falling back to simple chat`);
    }
    // Unknown mode or agent loop fallback - continue to simple chat below
  }

    // create assistant placeholder so webview can render and receive stream updates by id
    const lastUser = this.getLastUserMessage();
    const assistantPlaceholderId = this.addToHistory({ role: 'assistant', content: '', temporary: true, modelName: activeModel });
  // inform webview to add assistant placeholder (replyTo last user id if present)
  this.postMessage({ type: 'addMessage', role: 'assistant', content: '', id: assistantPlaceholderId, replyTo: lastUser?.id, modelName: activeModel });

    try {
      await this.client.chat(
        chatOptions,
        (chunk) => {
          if (this.isStreamingAborted) return;
          buffer += chunk;
          const sanitized = this.sanitizeResponse(buffer);
          this.postMessage({ type: "streamResponse", content: sanitized, reasoning: reasoningBuffer, id: assistantPlaceholderId, modelName: activeModel });
        },
        (reasoning) => {
          if (this.isStreamingAborted) return;
          reasoningBuffer = reasoning;
          const sanitized2 = this.sanitizeResponse(buffer);
          this.postMessage({ type: "streamResponse", content: sanitized2, reasoning: reasoningBuffer, id: assistantPlaceholderId, modelName: activeModel });
        }
      );

  const finalAnswer = this.sanitizeResponse(buffer);
  if (finalAnswer) {
        // update placeholder content in history
        // find placeholder in history and replace content
        const idx = this.history.findIndex(h => h.id === assistantPlaceholderId);
        if (idx !== -1) {
          this.history[idx].content = finalAnswer;
          // no longer temporary
          this.history[idx].temporary = false;
          // Ensure modelName is set in history
          if (!this.history[idx].modelName && activeModel) {
            this.history[idx].modelName = activeModel;
          }
          // tokens estimate already computed above
          // persist finalized assistant message to storage as well
          (async () => {
            const assistantStore = {
              id: assistantPlaceholderId,
              role: 'assistant',
              content: finalAnswer,
              timestamp: Date.now(),
              modelName: activeModel,
              attachments: this.history[idx].attachedFiles || undefined
            } as any;
            // Include actions if present
            if (this.history[idx].actions) {
              assistantStore.actions = this.history[idx].actions;
            }
            try {
              await this.storageManager.createSession(this.currentSessionId);
              await this.storageManager.appendMessage(this.currentSessionId, assistantStore);
            } catch (err) {
              logger.error('Failed to persist assistant final answer', err);
            }
          })().catch(err => logger.error('Failed to persist assistant final answer', err));
          this.saveHistory();
        }
        // send final assistant content with id so webview can update placeholder
        this.postMessage({ type: 'streamResponse', content: finalAnswer, reasoning: '', id: assistantPlaceholderId, modelName: activeModel });
      }
    } catch (primaryError: any) {
      if (controller.signal.aborted) {
        logger.log("Ответ прерван пользователем или новым запросом.");
      } else {
        const errorMsg = String(primaryError?.message || primaryError);
        logger.error("Ошибка при обращении к чату", primaryError);
        // Use parseApiError for human-readable messages in chat mode too
        const { parseApiError } = require('../Engine/agentLoop');
        const { summary, details } = parseApiError(primaryError);
        this.postMessage({
          type: "addMessage",
          role: "system",
          content: summary,
          errorDetails: details
        });
      }
      // Protect partial content: save messages with content, handle empty ones
      for (const h of this.history) {
        if (h.role === 'assistant' && h.temporary) {
          if (h.content && h.content.trim().length > 0) {
            h.temporary = false;
            this.postMessage({ type: 'streamEnd', id: h.id, content: h.content, modelName: h.modelName });
            const toStore: any = { id: h.id!, role: 'assistant', content: h.content, timestamp: Date.now(), tokenCount: 0 };
            if (h.modelName) toStore.modelName = h.modelName;
            this.storageManager.createSession(this.currentSessionId).then(() => {
              this.storageManager.appendMessage(this.currentSessionId, toStore).catch(() => {});
            }).catch(() => {});
          } else {
            // Empty placeholder — remove from DOM so user can retry cleanly
            this.postMessage({ type: 'removeMessage', id: h.id });
          }
        }
      }
      this.history = this.history.filter(h => !(h.role === 'assistant' && h.temporary));
      this.saveHistory();

      // Manual abort: no notification needed — user pressed Stop intentionally
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
      this.postMessage({ type: "setLoading", value: false });
      this._isProcessing = false;
    }
  }

  private addToHistory(entry: ChatMessage) {
    // ensure each history entry has an id so webview can reference it
    const id = entry.id ?? (Date.now().toString() + '_' + Math.floor(Math.random() * 10000));
    const withId: ChatMessage = { ...entry, id };
    this.history = [...this.history, withId].slice(-this.maxHistory);

    // persist non-temporary messages to storage (append-only for crash-safety)
    if (!withId.temporary) {
      const toStore: any = {
        id: withId.id!,
        role: withId.role,
        content: withId.content,
        timestamp: Date.now(),
        tokenCount: 0,
        attachments: withId.attachedFiles || undefined
      };
      // Include actions if present
      if (withId.actions) {
        toStore.actions = withId.actions;
      }
      // Include modelName if present
      if (withId.modelName) {
        toStore.modelName = withId.modelName;
      }

      // Ensure session exists, then append (fire-and-forget but log errors)
      this.storageManager.createSession(this.currentSessionId).then(() => {
        this.storageManager.appendMessage(this.currentSessionId, toStore).catch(err => {
          logger.error('Failed to append message to storage', err);
        });
      }).catch(err => {
        logger.error('Failed to create session before append', err);
      });
      // update sessions index metadata
      this.saveHistory();
    } else {
      // keep session index updated in memory; full save will happen when finalizing
      this.saveHistory();
    }

    return id;
  }

  private async composeMessages(): Promise<ChatMessage[]> {
  const systemContent = this.currentMode === 'agent' ? getAgentSystemPrompt() : getChatSystemPrompt();
  const systemMessage: ChatMessage = { role: "system", content: systemContent };
    const context = await this.getContextPrompts();
    // Filter out corrupted/empty messages to prevent 400 errors
    const validHistory = this.history.filter(h => {
      // Remove temporary (unfinished) messages
      if (h.temporary) return false;
      // Remove empty assistant messages (corrupted by abort/error)
      if (h.role === 'assistant' && (!h.content || !h.content.trim())) return false;
      return true;
    });
    // Clone history but strip any binary/data fields from attachments so we don't send them to the model
    const history = validHistory.map(h => {
      // Destructure to remove internal fields that shouldn't be sent to the provider
      // 'id' causes 400 errors with some providers (e.g. Azure/OpenRouter)
      // 'mode' causes 422 errors with Mistral API
      const { id, attachedFiles, attachment, temporary, modelName, actions, pastedImages, mode, ...rest } = h as any;
      
      if (h.attachment) {
        // represent attachment as a short metadata placeholder in the prompt
        const meta = `[ATTACHMENT] name=${h.attachment.name || 'file'} mime=${h.attachment.mime} size=${h.attachment.size || 0}`;
        return { ...rest, content: `${h.content}\n\n${meta}` } as ChatMessage;
      }
      
      return rest as ChatMessage;
    });

    if (context) {
      history.unshift({ role: "system", content: `Selected Context:\n${context}` });
    }

    return [systemMessage, ...history];
  }

  private async getContextPrompts(): Promise<string> {
    let contextMsg = "";
    // Get files from the last user message (which contains the files that were attached to this request)
    const lastUserMsg = this.getLastUserMessage();
    const filesToUse = lastUserMsg?.attachedFiles || [];
    const pastedImagesData = lastUserMsg?.pastedImages || {};
    
    for (const file of filesToUse) {
      try {
        if (String(file.path).startsWith('pasted:')) {
          // First try to get from saved pastedImages in the message
          let attach = pastedImagesData[file.path];
          
          // If not found, try contextAttachments
          if (!attach) {
            const contextAttach = this.contextAttachments.get(file.path);
            if (contextAttach) {
              attach = contextAttach;
            }
          }
          
          if (attach) {
            contextMsg += `\nAttachment: ${attach.name || file.name} (mime=${attach.mime} size=${attach.size || 0})\n`;
          } else {
            contextMsg += `\nAttachment: ${file.name} (missing)\n`;
          }
          continue;
        }

        const uri = Uri.file(file.path);
        const stat = await workspace.fs.stat(uri);
        
        // Skip files over 100KB to prevent token waste
        const MAX_CONTEXT_FILE_SIZE = 100 * 1024; // 100KB
        if (stat.size > MAX_CONTEXT_FILE_SIZE) {
            contextMsg += `\nFile: ${file.name}\n(Skipped: File too large > 100KB. Use read_file tool for specific sections.)\n`;
            continue;
        }

        const content = await workspace.fs.readFile(uri);
        
        // Simple binary check
        if (content.some(b => b === 0)) {
             contextMsg += `\nFile: ${file.name}\n(Skipped: Binary file detected)\n`;
             continue;
        }

        const text = new TextDecoder().decode(content);
        const lines = text.split('\n');
        
        // For files over 200 lines, send only first/last portions with summary
        const MAX_CONTEXT_LINES = 200;
        if (lines.length > MAX_CONTEXT_LINES) {
          const head = lines.slice(0, 120).join('\n');
          const tail = lines.slice(-50).join('\n');
          contextMsg += `\nFile: ${file.name} (${lines.length} lines, truncated)\n\`\`\`\n${head}\n\n... [${lines.length - 170} lines omitted — use read_file for full content] ...\n\n${tail}\n\`\`\`\n`;
        } else {
          contextMsg += `\nFile: ${file.name}\n\`\`\`\n${text}\n\`\`\`\n`;
        }
      } catch (e) {
        logger.error(`Failed to read file ${file.path}`, e);
        contextMsg += `\nFile: ${file.name}\n(Error reading file)\n`;
      }
    }
    return contextMsg;
  }

  private sanitizeResponse(text: string): string {
    return text.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }

  private resetConversation() {
    logger.log("Пользователь очистил историю чата.");
    this.abortController?.abort();
    this._apiConversation = [];
    
    // If current session is already empty, don't create a new one to avoid accumulating empty sessions
    if (this.history.length === 0) {
      logger.log("Текущая сессия уже пуста, новая не создаётся.");
      this.postMessage({ type: "clearChat" });
      this.postMessage({ type: "sessionLoaded" });
      return;
    }
    
    this.history = [];
    this.currentSessionId = Date.now().toString();

    // Immediately clear the webview UI
    this.postMessage({ type: "clearChat" });

    // Ensure a session folder exists on disk and persist the sessions index,
    // then notify the webview to refresh the history list so the UI switches.
    (async () => {
      try {
        await this.storageManager.createSession(this.currentSessionId, 'New Chat');
      } catch (e) {
        logger.error('Failed to create session during resetConversation', e);
      }

      this.saveHistory();
      this.postMessage({ type: 'updateHistory', sessions: this.sessions });
      // Signal that the new session is ready — unlocks saveChatState in webview
      this.postMessage({ type: 'sessionLoaded' });
    })().catch(e => logger.error('resetConversation async error', e));
  }

  private deleteSession(sessionId: string) {
      // attempt to delete session folder and remove from index
      (async () => {
        try {
          await this.storageManager.deleteSession(sessionId);
          // reload index into memory
          const idx = await this.storageManager.listSessions();
          this.sessions = idx.map((s: any) => ({ id: s.id, title: s.title, date: s.date, messages: [] } as ChatSession));
        } catch (err) {
          logger.error('Failed to delete session on disk, falling back to in-memory update', err);
          // fallback: update in-memory and globalState
          this.sessions = this.sessions.filter(s => s.id !== sessionId);
          try {
            this.context.globalState.update('chatSessions', this.sessions);
          } catch (e) {
            logger.error('Failed to update globalState after deleteSession fallback', e);
          }
        }

        // If we deleted the current session, start a new one
        if (this.currentSessionId === sessionId) {
          this.history = [];
          this.currentSessionId = Date.now().toString();
          this.postMessage({ type: "clearChat" });
        }

        this.postMessage({ type: "updateHistory", sessions: this.sessions });
      })().catch(e => logger.error('deleteSession wrapper error', e));
  }

  private async ensureViewVisible() {
    this.view?.show?.(true);
    if (!this.view) {
      await commands.executeCommand("workbench.view.extension.ashibalt-sidebar");
    }
  }

  private flushPendingMessages() {
    if (!this.view || this.pendingHostMessages.length === 0) {
      return;
    }

    const queue = [...this.pendingHostMessages];
    this.pendingHostMessages = [];
    const run = async () => {
      for (const message of queue) {
        await this.handleUserMessage(message);
      }
    };

    run().catch((error) => logger.error("Не удалось доставить отложенные сообщения", error));
  }

  private postMessage(payload: any) {
    this.view?.webview.postMessage(payload);
  }

  /**
   * Request terminal command confirmation from user via WebView UI.
   * Returns Promise that resolves to true if confirmed, false if rejected.
   * Rejects if WebView is closed or timeout (no response from user).
   */
  private requestTerminalConfirmation(command: string, workingDir: string): Promise<{ confirmed: boolean; editedCommand?: string }> {
    return new Promise((resolve, reject) => {
      // Only one pending confirmation at a time
      if (this.pendingTerminalConfirmation) {
        // Reject previous pending confirmation
        this.pendingTerminalConfirmation.reject(new Error('Новый запрос подтверждения отменил предыдущий'));
      }

      // Check if WebView is available
      if (!this.view) {
        reject(new Error('WebView недоступен'));
        return;
      }

      this.pendingTerminalConfirmation = { resolve, reject, command };

      // Send confirmation request to WebView
      this.postMessage({
        type: 'terminalConfirm',
        command,
        workingDir
      });

      // Note: No timeout here - agentLoop controls flow
      // If WebView closes, the onDidDispose will reject
    });
  }

  /**
   * Request user confirmation to continue agent iterations
   */
  private requestIterationConfirmation(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (this.pendingIterationConfirmation) {
        this.pendingIterationConfirmation.reject(new Error('New iteration confirmation cancelled previous'));
      }
      if (!this.view) {
        reject(new Error('WebView unavailable'));
        return;
      }
      this.pendingIterationConfirmation = { resolve, reject };
      this.postMessage({ type: 'iterationConfirm' });
    });
  }

  /**
   * Cancel pending terminal confirmation (called when WebView disposed or request cancelled)
   */
  private cancelPendingTerminalConfirmation() {
    if (this.pendingTerminalConfirmation) {
      this.pendingTerminalConfirmation.reject(new Error('Запрос подтверждения отменён'));
      this.pendingTerminalConfirmation = null;
    }
    if (this.pendingToolApproval) {
      this.pendingToolApproval.reject(new Error('Запрос подтверждения отменён'));
      this.pendingToolApproval = null;
    }
  }

  /**
   * Request user approval before executing a tool in chat mode
   */
  private requestToolApproval(toolName: string, args: any): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (this.pendingToolApproval) {
        this.pendingToolApproval.reject(new Error('New approval request cancelled previous'));
      }
      if (!this.view) {
        reject(new Error('WebView unavailable'));
        return;
      }
      this.pendingToolApproval = { resolve, reject };
      this.postMessage({ type: 'toolApproval', toolName, args });
    });
  }


  private _getHtmlForWebview(webview: Webview): string {
    const nonce = getNonce();
    const editor = window.activeTextEditor;
    const currentFileName = editor ? editor.document.fileName.split(/[\\/]/).pop() || 'No file' : 'No file';
    return this._loadHtmlTemplate ? this._loadHtmlTemplate(webview, nonce, currentFileName) : loadHtmlTemplate(webview, nonce, currentFileName, this.extensionUri, this.config, this.selectedModel?.name ?? null);
  }

  private _loadHtmlTemplate(webview: Webview, nonce: string, currentFileName: string): string {
    try {
      // deprecated in-favour of external helper loadHtmlTemplate
      return loadHtmlTemplate(webview, nonce, currentFileName, this.extensionUri, this.config, this.selectedModel?.name ?? null);
    } catch (error) {
      logger.error('Failed to load HTML template', error);
      return this._getFallbackHtml(webview, nonce);
    }
  }

  private _getFallbackHtml(webview: Webview, nonce: string): string {
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
          background: #181818;
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
        <p>Проверьте, что файл chatView.html находится в папке src/chat/</p>
      </div>
    </body>
    </html>`;
  }



  private async loadHistory() {
    // Load sessions list for history panel, but always start with empty chat
    try {
      const idx = await this.storageManager.listSessions();
      if (Array.isArray(idx) && idx.length > 0) {
        this.sessions = idx.map((s: any) => ({ id: s.id, title: s.title, date: s.date, messages: [] } as ChatSession));
      }
    } catch (e) {
      logger.error('Failed to read sessions from StorageManager', e);
      // fallback to globalState
      const savedSessions = this.context.globalState.get<ChatSession[]>("chatSessions", []);
      this.sessions = savedSessions;
    }

    // Restore last session if available, otherwise start fresh
    const lastSessionId = this.context.globalState.get<string>('lastSessionId');
    if (lastSessionId && this.sessions.some(s => s.id === lastSessionId)) {
      this.currentSessionId = lastSessionId;
      // Actual messages will be loaded when webview sends webviewReady
      this.pendingRestoreSessionId = lastSessionId;
      this.history = [];
    } else {
      this.currentSessionId = Date.now().toString();
      this.history = [];
    }
  }

  private saveHistory() {
    // Compose session metadata (without embedding messages)
    // Use first USER message for title, not system/assistant messages
    const userMessages = this.history.filter(m => !m.temporary && m.role === 'user');
    const title = userMessages.length > 0 
      ? (userMessages[0].content.substring(0, 50) + (userMessages[0].content.length > 50 ? '...' : '')) 
      : 'New Chat';
    const sessionMeta = { id: this.currentSessionId, title, date: Date.now() };

    // Update in-memory sessions list
    const existingSessionIndex = this.sessions.findIndex(s => s.id === this.currentSessionId);
    if (existingSessionIndex !== -1) {
      this.sessions[existingSessionIndex] = { id: sessionMeta.id, title: sessionMeta.title, date: sessionMeta.date, messages: [] };
    } else {
      this.sessions.unshift({ id: sessionMeta.id, title: sessionMeta.title, date: sessionMeta.date, messages: [] });
    }

    if (this.sessions.length > 20) this.sessions = this.sessions.slice(0, 20);

    // Persist sessions index via storage manager; fallback to globalState if unavailable
    this.storageManager.saveSessionsIndex(this.sessions.map(s => ({ id: s.id, title: s.title, date: s.date })))
      .catch(err => {
        logger.error('Failed to save sessions index, falling back to globalState', err);
        this.context.globalState.update('chatSessions', this.sessions);
      });

    // Remember current session so it can be restored on restart
    void this.context.globalState.update('lastSessionId', this.currentSessionId);
  }

  /**
   * Resolve contextLength for the selected model.
   * Priority: 1) model.contextLength 2) cached from API 3) guess by model family 4) undefined
   */
  private resolveContextLength(): number | undefined {
    const model = this.selectedModel;
    if (!model) return undefined;

    // 1) Already known
    if (model.contextLength) {
      return model.contextLength;
    }

    // 2) Check configManager cache (populated by fetchProviderModels)
    const cached = this.configManager.getCachedContextLength(model.id);
    if (cached) {
      model.contextLength = cached;
      return cached;
    }

    // 3) Check if model was updated in storage (migration from fetchProviderModels)
    const stored = this.configManager.getModels().find(m => m.id === model.id);
    if (stored?.contextLength) {
      model.contextLength = stored.contextLength;
      return stored.contextLength;
    }

    // 4) Guess by well-known model families
    const guessed = this.guessContextLength(model.id);
    if (guessed) {
      model.contextLength = guessed;
      return guessed;
    }

    return undefined;
  }

  /**
   * Guess context window by model ID patterns.
   * Fallback when API metadata is unavailable.
   */
  private guessContextLength(modelId: string): number | undefined {
    const id = modelId.toLowerCase();

    // DeepSeek: all models 128K
    if (id.includes('deepseek')) return 128000;

    // Claude models
    if (id.includes('claude-3-5') || id.includes('claude-3.5') || id.includes('claude-4') || id.includes('claude-sonnet-4') || id.includes('claude-opus-4')) return 200000;
    if (id.includes('claude-3') || id.includes('claude-3.0')) return 200000;
    if (id.includes('claude')) return 200000;

    // Gemini
    if (id.includes('gemini-2') || id.includes('gemini-1.5-pro')) return 1000000;
    if (id.includes('gemini-1.5-flash')) return 1000000;
    if (id.includes('gemini')) return 128000;

    // GPT-4o / GPT-4.1
    if (id.includes('gpt-4o') || id.includes('gpt-4.1') || id.includes('o3') || id.includes('o4')) return 128000;
    if (id.includes('gpt-4-turbo')) return 128000;
    if (id.includes('gpt-4')) return 128000;

    // Mistral / Devstral
    if (id.includes('devstral')) return 128000;
    if (id.includes('mistral-large') || id.includes('mistral-medium')) return 128000;
    if (id.includes('codestral')) return 256000;
    if (id.includes('mistral-small')) return 128000;
    if (id.includes('mistral')) return 32000;

    // Qwen
    if (id.includes('qwen')) return 128000;

    // Llama
    if (id.includes('llama-3.3') || id.includes('llama-3.2') || id.includes('llama-3.1')) return 128000;
    if (id.includes('llama')) return 128000;

    // Grok
    if (id.includes('grok')) return 131072;

    return undefined;
  }

  private loadSelectedModel() {
    const selectedModelId = this.configManager.getSelectedModelId();
    const models = this.configManager.getModels();
    
    if (!selectedModelId) {
      // If no model selected, try to select the first available one
      if (models.length > 0) {
        this.selectedModel = models[0];
        this.configManager.setSelectedModel(this.selectedModel.id);
        logger.log(`[Model] No model selected, defaulting to: ${this.selectedModel.name}`);
        this.applyModelOverridesFromSelection(true, true);
      } else {
        logger.log('[Model] No models available to select');
        this.selectedModel = null;
      }
      return;
    }

    const existing = models.find((model) => model.id === selectedModelId);
    if (!existing) {
      // If selected model not found, try to select the first available one
      if (models.length > 0) {
        this.selectedModel = models[0];
        this.configManager.setSelectedModel(this.selectedModel.id);
        logger.log(`[Model] Previously selected model ${selectedModelId} not found, defaulting to: ${this.selectedModel.name}`);
        this.applyModelOverridesFromSelection(true, true);
      } else {
        this.configManager.setSelectedModel(null);
        this.selectedModel = null;
        logger.log(`[Model] Previously selected model ${selectedModelId} not found and no alternatives`);
      }
      return;
    }

    logger.log(`[Model] Loaded selected model: ${existing.name}`);
    this.selectedModel = existing;
    this.applyModelOverridesFromSelection(true, true);
  }

  private applySelectedModel(model: AIModel, silent = false) {
    this.selectedModel = model;
    logger.log(`[Model] applySelectedModel -> ${model?.id ?? 'unknown'}`);
    this.applyModelOverridesFromSelection(true, silent);
  }

  private syncSelectedModelFromWebview(modelId: string, provider?: string, name?: string) {
    if (!modelId) return;
    if (this.selectedModel?.id === modelId) {
      return;
    }

    const models = this.configManager.getModels();
    let picked = models.find(m => m.id === modelId);

    if (!picked && provider) {
      // Try to get contextLength from cache before creating stub
      const cachedCtx = this.configManager.getCachedContextLength(modelId);
      picked = {
        id: modelId,
        name: name ?? modelId,
        provider: provider as any,
        ...(cachedCtx ? { contextLength: cachedCtx } : {})
      } as AIModel;
    }

    if (!picked) {
      return;
    }

    this.applySelectedModel(picked, true);
  }

  private applyModelOverridesFromSelection(rebuildClient = true, silentLabel = false) {
    if (!this.selectedModel) {
      return;
    }

    if (rebuildClient) {
      this.rebuildClient();
    }

    this.persistSelectedModel();
    this.syncModelsToView();

    if (!silentLabel) {
      this.postMessage({ type: "updateModelText", value: this.selectedModel.name });
    }
  }

  private rebuildClient() {
    const provider = this.selectedModel?.provider;
    const clientInfo = createChatClientWithFallback(this.config, provider);
    this.client = clientInfo.client;
    this.primaryProvider = clientInfo.primaryProvider;
  }

  private persistSelectedModel() {
    this.configManager.setSelectedModel(this.selectedModel?.id ?? null);
  }

  private syncModelsToView() {
    const models = this.configManager.getModels();
    const codeModel = this.configManager.getCodeModel();
    
    // Ensure selectedModel is up to date with config if not set
    if (!this.selectedModel) {
        this.updateSelectedModelFromConfig(models);
    }

    if (this.view) {
      this.postMessage({
        type: "updateModels",
        models: models,
        selectedModelId: this.selectedModel?.id ?? null,
        codeModelId: codeModel
      });
      // Also send current settings
      const vsConfig = workspace.getConfiguration("ashibaltAi");
      this.postMessage({
        type: "updateSettings",
        agentIterations: vsConfig.get<number>("agentIterations", 25),
        ollamaBaseUrl: vsConfig.get<string>("ollamaBaseUrl", "http://localhost:11434")
      });
      // Send current mode to restore UI state
      this.postMessage({
        type: "restoreMode",
        mode: this.currentMode
      });
    }
  }

  private updateSelectedModelFromConfig(models: AIModel[]) {
    const selectedModelId = this.configManager.getSelectedModelId();
    if (!selectedModelId) {
      this.selectedModel = null;
      return;
    }

    const current = models.find(m => m.id === selectedModelId);
    if (!current) {
      this.selectedModel = null;
      return;
    }
    this.selectedModel = current;
  }

  private ensureModelReady(): boolean {
    if (!this.selectedModel) {
      logger.log('[Model] No model selected, showing warning');
      window.showWarningMessage("Сначала выберите модель рядом с полем ввода.");
      this.postMessage({ type: "requireModelSelection" });
      return false;
    }

    logger.log(`[Model] Model ready: ${this.selectedModel.name}`);
    // Авторизация через Ashibalt проверяется на сервере
    return true;
  }

  private pruneLastAssistantMessage(notifyView = true): boolean {
    if (this.history.length === 0) {
      return false;
    }

    const lastEntry = this.history[this.history.length - 1];
    if (lastEntry.role !== "assistant") {
      return false;
    }

    const removedId = lastEntry.id;
    this.history = this.history.slice(0, -1);
    this.saveHistory();

    // Remove from persistent messages.jsonl
    if (removedId) {
      this.storageManager.removeMessage(this.currentSessionId, removedId).catch(() => {});
    }

    // Prune _apiConversation: remove trailing assistant + tool messages
    // (prevents stale tool_call IDs from being re-sent on retry)
    while (this._apiConversation.length > 0) {
      const last = this._apiConversation[this._apiConversation.length - 1];
      if (last.role === 'assistant' || last.role === 'tool') {
        this._apiConversation.pop();
      } else {
        break;
      }
    }
    logger.log(`[API_CONV] removeLastAssistantMessage prune complete, size=${this._apiConversation.length}`);
    this.storageManager.saveApiConversation(this.currentSessionId, this._apiConversation).catch(() => {});

    if (notifyView) {
      this.postMessage({ type: "removeLastAssistantMessage" });
    }

    return true;
  }

  private removeMessageById(messageId: string, notifyView = true): void {
    const index = this.history.findIndex(entry => entry.id === messageId);
    if (index !== -1) {
      this.history.splice(index, 1);
      this.saveHistory();
    }
    if (notifyView) {
      this.postMessage({ type: 'removeMessage', id: messageId });
    }
  }

  private getLastUserMessage(): ChatMessage | undefined {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i];
      if (entry.role === "user") {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Get workspace files matching a query for # autocomplete
   */
  private async getWorkspaceFiles(query: string): Promise<Array<{ path: string; name: string; isFolder: boolean }>> {
    const results: Array<{ path: string; name: string; isFolder: boolean }> = [];
    const workspaceFolders = workspace.workspaceFolders;
    
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return results;
    }

    const rootUri = workspaceFolders[0].uri;
    const queryLower = query.toLowerCase();
    
    // Use VS Code's findFiles API for efficient file search
    try {
      // Search for files matching the query
      const pattern = query ? `**/*${query}*` : '**/*';
      const excludePattern = '**/node_modules/**,**/.git/**,**/dist/**,**/out/**';
      const files = await workspace.findFiles(pattern, excludePattern, 50);
      
      for (const file of files) {
        const relativePath = workspace.asRelativePath(file, false);
        const fileName = path.basename(relativePath);
        
        // Filter by query if provided
        if (!query || relativePath.toLowerCase().includes(queryLower) || fileName.toLowerCase().includes(queryLower)) {
          results.push({
            path: relativePath,
            name: fileName,
            isFolder: false
          });
        }
      }
      
      // Also get folders if query matches
      if (query) {
        const folderPattern = `**/${query}*/`;
        try {
          const folders = await workspace.findFiles(`${folderPattern}*`, excludePattern, 20);
          const seenFolders = new Set<string>();
          
          for (const file of folders) {
            const relativePath = workspace.asRelativePath(file, false);
            const parts = relativePath.split(/[\\/]/);
            
            // Add parent folders that match
            for (let i = 0; i < parts.length - 1; i++) {
              const folderPath = parts.slice(0, i + 1).join('/');
              const folderName = parts[i];
              
              if (folderName.toLowerCase().includes(queryLower) && !seenFolders.has(folderPath)) {
                seenFolders.add(folderPath);
                results.push({
                  path: folderPath + '/',
                  name: folderName,
                  isFolder: true
                });
              }
            }
          }
        } catch (e) {
          // Ignore folder search errors
        }
      }
    } catch (e) {
      logger.error('Failed to search workspace files', e);
    }
    
    // Sort: folders first, then by name
    results.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
    
    return results.slice(0, 30); // Limit results
  }

  private loadSession(sessionId: string) {
    (async () => {
      try {
        // Save current session index before switching
        this.saveHistory();
        
        // Restore API conversation from disk (preserves full tool_calls context)
        const savedConv = await this.storageManager.loadApiConversation(sessionId);
        this._apiConversation = savedConv;
        logger.log(`[API_CONV] loadSession restored apiConversation: session=${sessionId}, messages=${savedConv.length}`);

        
        const tail = await this.storageManager.readSessionTail(sessionId, this.maxHistory * 2);
        this.currentSessionId = sessionId;
        // Filter out system messages (tool results) - they shouldn't be displayed to user
        const filteredTail = tail.filter(t => t.role === 'user' || t.role === 'assistant');
        
        this.history = filteredTail.map(t => {
          const msg: any = { id: t.id, role: t.role as ChatRole, content: t.content };
          if (t.actions) {
            msg.actions = t.actions;
          }
          // Legacy support
          if (t.fileActions && !t.actions) {
            msg.actions = t.fileActions;
          }
          // Load modelName if present
          if (t.modelName) {
            msg.modelName = t.modelName;
          }
          return msg as ChatMessage;
        });
        this.postMessage({ type: "clearChat" });
        
        // Send all messages - WebView will determine footer visibility based on temporary flag
        for (let i = 0; i < filteredTail.length; i++) {
          const t = filteredTail[i];
          this.postMessage({ 
            type: "addMessage", 
            role: t.role, 
            content: t.content, 
            id: t.id,
            actions: t.actions || t.fileActions,
            modelName: t.modelName
          });
        }
        // Signal that session loading is complete
        this.postMessage({ type: "sessionLoaded" });

        // Restore metrics dashboard for this session
        const metrics = await this.storageManager.loadSessionMetrics(sessionId);
        if (metrics.apiCalls > 0) {
          this.postMessage({ type: 'metricsUpdate', id: '', metrics });
        }
        
        // Restore session mode lock
        const savedMode = await this.storageManager.loadSessionMode(sessionId);
        if (savedMode === 'agent' || savedMode === 'chat') {
          this.currentMode = savedMode as ChatMode;
          void this.context.globalState.update(MODE_STORAGE_KEY, this.currentMode);
          // Notify webview: restore mode and lock it (session already has messages)
          this.postMessage({ type: 'restoreMode', mode: this.currentMode });
          if (filteredTail.length > 0) {
            this.postMessage({ type: 'lockMode', locked: true });
          }
          logger.log(`[loadSession] Restored session mode: ${savedMode}, locked: ${filteredTail.length > 0}`);
        } else {
          // No saved mode — unlock mode toggle for new/legacy sessions
          this.postMessage({ type: 'lockMode', locked: false });
        }

        // Always refresh snapshot dashboard after session load —
        // pending changes are global (not per-session) but dashboard must be visible
        this.snapshots.sendUpdate();
      } catch (e) {
        logger.error('Failed to load session from storage, falling back to in-memory', e);
        const session = this.sessions.find(s => s.id === sessionId);
        if (session) {
          this.currentSessionId = session.id;
          this.history = session.messages;
          this.postMessage({ type: "clearChat" });
          
          // Send all messages - WebView will determine footer visibility based on temporary flag
          for (let i = 0; i < session.messages.length; i++) {
            const msg = session.messages[i];
            this.postMessage({ 
              type: "addMessage", 
              role: msg.role, 
              content: msg.content, 
              id: msg.id, 
              attachedFiles: msg.attachedFiles, 
              actions: (msg as any).actions || (msg as any).fileActions,
              modelName: msg.modelName
            });
          }
          // Signal that session loading is complete
          this.postMessage({ type: "sessionLoaded" });
        }
      }
    })().catch(err => logger.error('loadSession error', err));
  }

  /** Public: send snapshot dashboard state to webview */
  public sendPendingSnapshotsUpdate(): void {
    this.snapshots.sendUpdate();
  }
}
