import * as vscode from 'vscode';
import { tools as availableTools, executeTool } from './toolCalling';
import { getAgentSystemPrompt } from '../promptUtils';
import { MessageAction, StorageManager } from '../Storage/storageManager';
import { logger } from '../logger';
import { prepareMessagesForApi, estimateTokenCount } from './SystemContext/contextSummarizer';
import { getFileTime } from './SystemContext/contextCache';
import { parseApiError, tryRecoverJSON } from './agentErrors';
import { fetchOpenRouterWithTools, type ChatResponse } from './fetchWithTools';

// Re-export parseApiError for consumers that import from agentLoop
export { parseApiError } from './agentErrors';

/**
 * Module-level rate limiter: persists across agent loop calls.
 * Prevents rapid-fire API requests that trigger provider rate limits (429).
 */
const MIN_API_INTERVAL_MS = 2000; // 2 seconds minimum between API calls
let lastApiCallTime = 0;

/**
 * Default context window for models where API didn't return context_length.
 * 32K is safe for virtually all modern models.
 */
const DEFAULT_CONTEXT_WINDOW = 32000;

/**
 * Maximum effective context window for compression thresholds.
 * Models with 200K+ windows waste resources before compression kicks in.
 * Cap at 128K for efficiency — the model still has its full window,
 * but we trigger compression earlier to keep costs and latency reasonable.
 */
const MAX_EFFECTIVE_CONTEXT = 128000;

interface AgentLoopOptions {
  baseUrl?: string;
  apiKey: string;
  model: string;
  providerMessages: any[];
  storageManager: StorageManager;
  addToHistory: (entry: { role: string; content: string; temporary?: boolean }) => string;
  postMessage: (msg: any) => void;
  getLastUserMessage: () => { id: string; content: string } | undefined;
  updateHistoryEntry: (id: string, content: string, temporary?: boolean, fileActions?: any[], modelName?: string) => void;
  currentSessionId: string;
  reasoning?: { max_tokens?: number; effort?: string; enabled?: boolean };
  onReasoning?: (reasoning: string) => void;
  signal?: AbortSignal;
  /** Callback to request terminal command confirmation from user. Returns confirmed status and optionally edited command. */
  requestTerminalConfirmation?: (command: string, workingDir: string) => Promise<{ confirmed: boolean; editedCommand?: string }>;
  /** Returns a promise that resolves when the user clicks "Detach" during terminal execution. Allows agent to continue without waiting for command. */
  createDetachPromise?: () => Promise<void>;
  /** Callback to request continuation when iteration limit is reached. Returns true if user wants to continue. */
  requestIterationConfirmation?: () => Promise<boolean>;
  /** Override the default tool list (e.g. for chat mode with read-only tools) */
  toolOverrides?: any[];
  /** Override max iterations (e.g. chat mode = 5) */
  maxIterationsOverride?: number;
  /** System prompt override (e.g. chat mode uses different prompt) */
  systemPromptOverride?: string;
  /** Context window size of the selected model (for dynamic compression thresholds) */
  contextLength?: number;
  /** Whether this is running in chat mode (read-only tools, auto tool choice) */
  isChat?: boolean;
  /** Callback to request user approval before executing a tool in chat mode. Returns true if approved. */
  requestToolApproval?: (toolName: string, args: any) => Promise<boolean>;
  /** Callback to persist the full conversation (including tool calls) after loop ends */
  onConversationUpdate?: (messages: any[]) => void;
}

/**
 * Runs OpenRouter agent loop with tool calling.
 * Returns true if handled, false otherwise.
 */
export async function runOpenRouterAgentLoop(opts: AgentLoopOptions): Promise<boolean> {
  const {
    baseUrl = 'https://openrouter.ai/api/v1',
    apiKey,
    model,
    providerMessages,
    storageManager,
    addToHistory,
    postMessage,
    getLastUserMessage,
    updateHistoryEntry,
    currentSessionId,
    reasoning,
    onReasoning,
    signal,
    requestTerminalConfirmation,
    createDetachPromise,
    requestIterationConfirmation,
    toolOverrides,
    maxIterationsOverride,
    systemPromptOverride,
    contextLength: modelContextLength,
    isChat,
    requestToolApproval,
    onConversationUpdate
  } = opts;

  const vsConfig = vscode.workspace.getConfiguration("ashibaltAi");
  let maxIterations = maxIterationsOverride ?? vsConfig.get<number>("agentIterations", 25);
  
  // Use overridden tools if provided (chat mode uses read-only subset)
  const loopTools = toolOverrides || availableTools;
  
  let conversationMessages = [...providerMessages];

  // Determine effective model for prompt generation
  // This ensures we use the correct system prompt (e.g. refusal for R1)
  let effectiveModel = model;
  const isDeepSeek = baseUrl.includes('deepseek.com');
  if (isDeepSeek && reasoning?.enabled) {
    effectiveModel = 'deepseek-reasoner';
  }

  let systemContent = systemPromptOverride || getAgentSystemPrompt();
  
  // GLM models need explicit instruction to not put tool calls in reasoning blocks
  if (/glm/i.test(model)) {
    systemContent += `\n\n<GLM_TOOL_POLICY>
CRITICAL: You MUST use ONLY these exact tool names (no other names will work):
  read_file, edit_file, create_file, delete_file, list_files, search, terminal, diagnose

DO NOT invent tool names like "write_file_content_to_path" or "run_command" — they will FAIL.
To create a NEW file, use "create_file". To edit an EXISTING file, use "edit_file". To run a command, use "terminal".

When using create_file or edit_file, the "content" parameter must be the EXACT raw source code text.
NEVER convert HTML/CSS/JS into JSON objects or structured data. Write the actual file content as-is.
Example: for HTML write "<!DOCTYPE html>\n<html>..." — NOT [{"margin": 0, "padding": 0}].

NEVER place tool calls inside thinking/reasoning blocks — they will NOT execute there.
Use reasoning ONLY for analysis. ALL tool invocations MUST go through the function calling API.
</GLM_TOOL_POLICY>`;
  }
  
  const newSystemPrompt = { role: 'system', content: systemContent };
  
  if (conversationMessages.length > 0 && conversationMessages[0].role === 'system') {
    conversationMessages[0] = newSystemPrompt;
  } else {
    conversationMessages.unshift(newSystemPrompt);
  }

  // Context Summarization: compress old messages if approaching token limit
  const tokensBefore = estimateTokenCount(conversationMessages);
  logger.log(`[AGENT] Pre-prepare context: messages=${conversationMessages.length}, tokens=${tokensBefore}`);
  conversationMessages = await prepareMessagesForApi(conversationMessages, apiKey, baseUrl, {
    onStatusChange: (status) => {
      // Notify WebView about summarization status for UI blocking
      postMessage({ type: 'summarizationStatus', status });
    },
    contextLength: modelContextLength
  });
  const tokensAfter = estimateTokenCount(conversationMessages);
  if (tokensBefore !== tokensAfter) {
    logger.log(`[AGENT] Context summarized: ${tokensBefore} -> ${tokensAfter} tokens`);
  } else {
    logger.log(`[AGENT] Context unchanged after prepare: ${tokensAfter} tokens`);
  }


  const lastUser = getLastUserMessage();
  const assistantPlaceholderId = addToHistory({ role: 'assistant', content: '', temporary: true });
  postMessage({ type: 'addMessage', role: 'assistant', content: '', id: assistantPlaceholderId, replyTo: lastUser?.id, tokenCount: 0, modelName: effectiveModel });

  const collectedActions: MessageAction[] = [];
  let accumulatedContent = '';
  let accumulatedReasoning = ''; // Track reasoning for UI updates

  // Session metrics tracking for UI dashboard — load persisted values
  const savedMetrics = await storageManager.loadSessionMetrics(currentSessionId);
  let sessionInputTokens = savedMetrics.inputTokens;
  let sessionOutputTokens = savedMetrics.outputTokens;
  let sessionApiCalls = savedMetrics.apiCalls;
  let sessionCachedTokens = (savedMetrics as any).cachedTokens || 0;
  let currentModelHasCache = false; // tracks if the CURRENT model returns cache data
  // Single source of truth for current context size.
  // Updated ONLY from API prompt_tokens (most accurate).
  // Used for all UI metrics to prevent saw-tooth display pattern.
  let lastKnownContextTokens = 0;
  // How many messages were in conversationMessages when lastKnownContextTokens was set.
  // Used to estimate tokens for messages added AFTER the last API call.
  let messagesAtLastApiCall = 0;

  // Set FileTime session so read_file/edit_file can track per-session reads
  const fileTime = getFileTime();
  fileTime.setSession(currentSessionId);

  const toolNames = loopTools.map((t: any) => t.function?.name || 'unknown');
  logger.log(`[AGENT] Starting loop. Model: ${model}`);
  logger.log(`[AGENT] Tools sent to model: [${toolNames.join(', ')}]`);

  let iteration = 0;
  // Loop breaker: track consecutive identical failures to detect and break loops
  let consecutiveFailCount = 0;
  let lastFailSignature = '';
  const MAX_CONSECUTIVE_FAILS = 3; // After 3 identical failures, force-break

  // Escalation: track how many times the loop breaker has fired for each tool+file
  const loopBreakerTriggers = new Map<string, number>();

  // Track delete→create cycles per file to prevent truncation cascades
  const deleteCreateCount = new Map<string, number>();

  // Limit consecutive web_search calls to prevent infinite search loops
  let consecutiveWebSearchCount = 0;
  const MAX_CONSECUTIVE_WEB_SEARCH = 3;

  // 429 retry backoff state (resets each loop call)
  let consecutiveRateLimitRetries = 0;
  const MAX_RATE_LIMIT_RETRIES = 3;

  try {
  while (iteration < maxIterations) {
    logger.log(`[AGENT] Iteration ${iteration + 1}/${maxIterations}`);
    
    if (signal?.aborted) {
      logger.log(`[AGENT] Aborted by user`);
      updateHistoryEntry(assistantPlaceholderId, accumulatedContent, false, collectedActions, effectiveModel);
      postMessage({ type: 'streamEnd', id: assistantPlaceholderId, actions: collectedActions });
      onConversationUpdate?.(conversationMessages);
      return true;
    }

    // Sanitize conversation: remove empty assistant messages that break API
    // (can appear after failed requests where model returned neither content nor tool_calls)
    conversationMessages = conversationMessages.filter((msg: any) => {
      if (msg.role === 'assistant' && !msg.content && (!msg.tool_calls || msg.tool_calls.length === 0)) {
        logger.log(`[AGENT] Removed empty assistant message from conversation history`);
        return false;
      }
      return true;
    });

    // Rate limit: wait if less than MIN_API_INTERVAL_MS since last call (module-level, persists across calls)
    const now = Date.now();
    const elapsed = now - lastApiCallTime;
    if (lastApiCallTime > 0 && elapsed < MIN_API_INTERVAL_MS) {
      const waitMs = MIN_API_INTERVAL_MS - elapsed;
      logger.log(`[AGENT] Rate limit: waiting ${waitMs}ms before next API call`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    lastApiCallTime = Date.now();

    // Record message count before API call for accurate context size tracking
    messagesAtLastApiCall = conversationMessages.length;

    // Make API request with automatic 429 retry (exponential backoff)
    let response: ChatResponse;
    try {
      response = await fetchOpenRouterWithTools({
        baseUrl,
        apiKey,
        model,
        messages: conversationMessages,
        tools: loopTools,
        toolChoice: 'auto',
        reasoning,
        signal,
        onChunk: (chunk) => {
          if (signal?.aborted) return;
          accumulatedContent += chunk;
          const estTokens = Math.max(1, Math.ceil(accumulatedContent.length / 4));
          postMessage({ type: 'streamResponse', content: accumulatedContent, reasoning: accumulatedReasoning, id: assistantPlaceholderId, tokenCount: estTokens, modelName: effectiveModel });
          // Sync partial content + actions to history so abort preserves them
          updateHistoryEntry(assistantPlaceholderId, accumulatedContent, true, collectedActions, effectiveModel);
        },
        onReasoning: (newReasoning) => {
          accumulatedReasoning = newReasoning;
          if (onReasoning) onReasoning(newReasoning);
          const estTokens = Math.max(1, Math.ceil(accumulatedContent.length / 4));
          postMessage({ type: 'streamResponse', content: accumulatedContent, reasoning: accumulatedReasoning, id: assistantPlaceholderId, tokenCount: estTokens, modelName: effectiveModel });
        }
      });
      // Successful request — reset retry counter
      consecutiveRateLimitRetries = 0;
    } catch (apiError: any) {
      const { summary, details } = parseApiError(apiError);
      const rawMsg = apiError?.message || String(apiError);

      // Auto-retry on 429 rate limit errors with exponential backoff
      // Check both parsed summary (Russian) and raw error message (contains HTTP status)
      const is429 = rawMsg.includes('(429)') || summary.includes('429') || summary.includes('лимит запросов') || summary.toLowerCase().includes('rate limit') || summary.toLowerCase().includes('too many requests');
      if (is429 && consecutiveRateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        consecutiveRateLimitRetries++;
        const backoffMs = Math.min(2000 * Math.pow(2, consecutiveRateLimitRetries), 30000); // 4s, 8s, 16s
        logger.log(`[AGENT] 429 rate limit hit — auto-retry ${consecutiveRateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} after ${backoffMs}ms`);
        postMessage({ type: 'streamResponse', content: accumulatedContent + `\n\n⏳ *Rate limit — автоматический повтор через ${Math.round(backoffMs / 1000)}с...*`, id: assistantPlaceholderId, tokenCount: 0, modelName: effectiveModel });
        lastApiCallTime = Date.now() + backoffMs; // Prevent next iteration from firing too soon
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue; // Retry the same iteration
      }

      const wrapped = new Error(summary) as any;
      wrapped.errorDetails = details;
      throw wrapped;
    }

    sessionApiCalls++;
    const realUsage = response.usage;
    const estInputTokens = realUsage?.prompt_tokens || estimateTokenCount(conversationMessages);
    const estOutputTokens = realUsage?.completion_tokens || (Math.ceil((response.content?.length || 0) / 4) 
      + (response.tool_calls?.reduce((sum, tc) => sum + Math.ceil((tc.function.arguments?.length || 0) / 4), 0) || 0));
    sessionInputTokens += estInputTokens;
    sessionOutputTokens += estOutputTokens;
    lastKnownContextTokens = estInputTokens;
    if (realUsage?.cached_tokens) {
      sessionCachedTokens += realUsage.cached_tokens;
      currentModelHasCache = true;
    } else {
      currentModelHasCache = false;
    }

    // Send metrics update to UI
    const currentMetrics: any = {
      inputTokens: sessionInputTokens,
      outputTokens: sessionOutputTokens,
      apiCalls: sessionApiCalls,
      currentContextTokens: estInputTokens,
      contextLimit: modelContextLength || DEFAULT_CONTEXT_WINDOW,
      cachedTokens: currentModelHasCache ? sessionCachedTokens : 0,
      model: model  // for webview model usage tracking
    };
    postMessage({
      type: 'metricsUpdate',
      id: assistantPlaceholderId,
      metrics: currentMetrics
    });

    // Persist metrics to disk (fire-and-forget)
    storageManager.saveSessionMetrics(currentSessionId, currentMetrics).catch(() => {});

    if (response.content && response.content.trim()) {
      collectedActions.push({ type: 'text', content: response.content });
      logger.log(`[AGENT] Model returned text (${response.content.length} chars)`);
    }

    // No tool calls - done
    if (!response.tool_calls || response.tool_calls.length === 0) {
      // CRITICAL: Push assistant's text response to conversation history.
      // Without this, the model's response is lost between turns — it can't
      // see its own previous output when the user sends the next message.
      if (response.content) {
        conversationMessages.push({
          role: 'assistant',
          content: response.content
        });
      }
      logger.log(`[AGENT] No tool calls, ending loop (text pushed to conversation: ${!!response.content})`);
      break;
    }

    const calledTools = response.tool_calls.map(tc => `${tc.function.name}(${tc.function.arguments.slice(0, 100)}...)`);
    logger.log(`[AGENT] Model called tools: ${calledTools.join(', ')}`);

    // Sync history before tool execution so abort preserves partial progress.
    // accumulatedContent may be empty if model returned only tool_calls —
    // that's OK, the actions array carries the visual indicators.
    updateHistoryEntry(assistantPlaceholderId, accumulatedContent, true, collectedActions, effectiveModel);
    // Add assistant message with tool calls to conversation
    const assistantMsg: any = {
      role: 'assistant',
      content: response.content || '',
      tool_calls: response.tool_calls
    };
    
    // DeepSeek Reasoner requires 'reasoning_content' to be preserved in history
    if (response.reasoning) {
      assistantMsg.reasoning_content = response.reasoning;
    }
    
    conversationMessages.push(assistantMsg);

    // Get workspace root for path resolution
    const folders = vscode.workspace.workspaceFolders;
    const workspaceRoot = folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;

    // Execute each tool call
    for (const toolCall of response.tool_calls) {
      let toolName = toolCall.function.name;

      // --- Tool name remapping for models that hallucinate tool names ---
      // Some models (e.g. GLM-4.7) invent their own tool names instead of
      // using the provided function definitions. We clean and remap them.
      // 1) Strip XML-like suffixes: "write_file</arg_value>" → "write_file"
      toolName = toolName.replace(/<[^>]*>.*$/s, '').trim();
      // 2) Map known hallucinated names → real tool names
      const TOOL_NAME_REMAP: Record<string, string> = {
        // write/create variants → create_file
        'write_file_content_to_path': 'create_file',
        'write_file_content': 'create_file',
        'write_file': 'create_file',
        'save_file': 'create_file',
        'write_to_file': 'create_file',
        'new_file': 'create_file',
        // edit/update/modify variants → edit_file
        'update_file': 'edit_file',
        'modify_file': 'edit_file',
        'replace_in_file': 'edit_file',
        'replace_string_in_file': 'edit_file',
        'str_replace_editor': 'edit_file',
        'patch_file': 'edit_file',
        'apply_edit': 'edit_file',
        // read variants → read_file
        'read_file_content': 'read_file',
        'get_file_content': 'read_file',
        'view_file': 'read_file',
        'open_file': 'read_file',
        // terminal variants
        'run_command': 'terminal',
        'execute_command': 'terminal',
        'run_terminal_command': 'terminal',
        'shell': 'terminal',
        'bash': 'terminal',
        'exec': 'terminal',
        // delete variants
        'remove_file': 'delete_file',
        // search variants
        'find': 'search',
        'grep': 'search',
        'search_files': 'search',
        'search_code': 'search',
        // list variants
        'list_directory': 'list_files',
        'ls': 'list_files',
        'dir': 'list_files',
        // diagnose variants
        'get_diagnostics': 'diagnose',
        'check_errors': 'diagnose',
        // fetch_url variants
        'http_request': 'fetch_url',
        'curl': 'fetch_url',
        'wget': 'fetch_url',
        'http_get': 'fetch_url',
        'get_url': 'fetch_url',
        'fetch': 'fetch_url',
        // read_terminal_output variants
        'get_terminal_output': 'read_terminal_output',
        'check_terminal': 'read_terminal_output',
        'terminal_output': 'read_terminal_output',
        // write_to_terminal variants
        'send_terminal_input': 'write_to_terminal',
        'terminal_input': 'write_to_terminal',
        'stdin': 'write_to_terminal',
        'send_input': 'write_to_terminal',
      };
      const remappedName = TOOL_NAME_REMAP[toolName];
      if (remappedName) {
        logger.log(`[TOOL] Remapped hallucinated tool name "${toolName}" → "${remappedName}"`);
        toolName = remappedName;
      }

      let args: any = {};
      const rawArgs = toolCall.function.arguments || '{}';
      try {
        args = JSON.parse(rawArgs);
      } catch (parseErr) {
        // Multi-stage JSON recovery for common model mistakes
        args = tryRecoverJSON(rawArgs, toolName, response.finish_reason);
        if (args === null) {
          // Unrecoverable — if truncated, tell model to split content
          if (response.finish_reason === 'length') {
            logger.log(`[TOOL] Args truncated by max_tokens for ${toolName}. Raw length: ${rawArgs.length}`);
            const truncError = `ERROR: Your tool call arguments were truncated because the response exceeded max_tokens. ` +
              `The file content was too large to send in a single tool call. ` +
              `Please split the file into smaller parts: first create_file with a skeleton, then use edit_file with start_line/end_line to add content section by section.`;
            
            // Assistant message with tool_calls was already pushed above (line ~349).
            // Only push the tool result — do NOT push another assistant message.
            conversationMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: truncError
            });
            
            postMessage({ type: 'toolResult', name: toolName, result: truncError, id: assistantPlaceholderId });
            continue;
          }
          
          logger.log(`[TOOL] Failed to parse args for ${toolName}: ${(parseErr as Error).message}. Raw(200): ${rawArgs.slice(0, 200)}`);
          args = {};
        }
      }

      // Post tool call notification (preface text)
      postMessage({ type: 'toolCall', name: toolName, args });

      // Track consecutive web_search usage and enforce limit
      if (toolName === 'web_search') {
        consecutiveWebSearchCount++;
      } else {
        consecutiveWebSearchCount = 0;
      }

      // Block web_search if used too many times consecutively
      if (toolName === 'web_search' && consecutiveWebSearchCount > MAX_CONSECUTIVE_WEB_SEARCH) {
        logger.log(`[AGENT] web_search blocked: ${consecutiveWebSearchCount} consecutive uses (max ${MAX_CONSECUTIVE_WEB_SEARCH})`);
        const limitMsg = `web_search limit reached: you have already performed ${MAX_CONSECUTIVE_WEB_SEARCH} consecutive web searches. ` +
          `Please use the information you already have, or use a different tool. ` +
          `The counter resets when you use any other tool.`;
        
        // Assistant message with tool_calls was already pushed above (line ~349).
        // Only push the tool result — do NOT push another assistant message.
        conversationMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: limitMsg
        });
        postMessage({ type: 'toolResult', name: toolName, result: limitMsg, id: assistantPlaceholderId });
        continue;
      }

      // Send web_search start notification for UI loading state
      if (toolName === 'web_search') {
        postMessage({ type: 'webSearchStart', id: assistantPlaceholderId, query: args.query });
      }

      let result: any;
      const toolStart = Date.now();

      // Special handling for terminal - may require user confirmation
      if (toolName === 'terminal' || toolName === 'run_terminal_command') {
        // Re-read config each time to pick up live toggle changes
        const freshConfig = vscode.workspace.getConfiguration("ashibaltAi");
        const autoRun = freshConfig.get<boolean>("autoRunTerminal", false);
        const command = args.command || '';
        const workingDir = args.working_directory || workspaceRoot || '';

        if (!autoRun && requestTerminalConfirmation) {
          // Show UI and wait for user confirmation
          postMessage({ 
            type: 'terminalConfirm', 
            id: assistantPlaceholderId, 
            command, 
            workingDir 
          });

          try {
            const confirmResult = await requestTerminalConfirmation(command, workingDir);
            
            if (!confirmResult.confirmed) {
              // User rejected the command
              result = { 
                error: 'Пользователь отклонил действие. Команда не была выполнена.', 
                rejected: true,
                command 
              };
              postMessage({ 
                type: 'terminalResult', 
                id: assistantPlaceholderId, 
                command, 
                rejected: true,
                success: false 
              });
            } else {
              // User confirmed - use edited command if provided
              const finalCommand = confirmResult.editedCommand || command;
              
              // Update args with potentially edited command
              args.command = finalCommand;
              
              // User confirmed - execute with loading state
              postMessage({ 
                type: 'terminalRunning', 
                id: assistantPlaceholderId, 
                command: finalCommand 
              });

              // Race the tool execution against a detach signal
              const toolExecution = executeTool(toolName, args, workspaceRoot);
              if (createDetachPromise) {
                const detach = createDetachPromise();
                result = await Promise.race([
                  toolExecution,
                  detach.then(() => ({
                    success: true,
                    command: finalCommand,
                    output: '(Пользователь отсоединился от терминала. Команда продолжает выполняться в фоне. Не нужно пытаться снова запустить эту команду.)',
                    detached: true,
                    method: 'detached'
                  }))
                ]);
              } else {
                result = await toolExecution;
              }
            }
          } catch (err: any) {
            // Confirmation was cancelled (e.g., WebView closed)
            result = { 
              error: 'Запрос подтверждения отменён', 
              cancelled: true,
              command 
            };
          }
        } else {
          // Auto-run enabled or no confirmation callback - execute directly
          result = await executeTool(toolName, args, workspaceRoot);
        }

        // Send terminal result to UI (if not already sent for rejection)
        if (!result?.rejected && !result?.cancelled) {
          postMessage({ 
            type: 'terminalResult', 
            id: assistantPlaceholderId, 
            command,
            output: result?.output || result?.stdout || '',
            exitCode: result?.exit_code ?? result?.exitCode ?? 0,
            success: !result?.error,
            error: result?.error
          });
        }

        // Persist terminal action for session restore
        collectedActions.push({
          type: 'terminal',
          command: args.command || command,
          exitCode: result?.exit_code ?? result?.exitCode,
          success: !result?.error && !result?.rejected,
          rejected: result?.rejected,
          error: result?.error
        });
      } else {
        // Chat mode: ask user approval before executing read_file
        if (isChat && requestToolApproval && toolName === 'read_file') {
          try {
            const approved = await requestToolApproval(toolName, args);
            if (!approved) {
              result = { error: 'Пользователь отклонил запрос на использование инструмента.' };
              // Push rejected tool result and continue to next tool_call
              conversationMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify(result)
              });
              postMessage({ type: 'toolResult', name: toolName, result: JSON.stringify(result), id: assistantPlaceholderId });
              continue;
            }
          } catch (err: any) {
            // Approval was cancelled (e.g., abort or WebView closed)
            result = { error: 'Запрос подтверждения отменён' };
            conversationMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(result)
            });
            continue;
          }
        }
        // All other tools - execute normally
        // Guard: block delete→create cycles that waste tokens and produce truncated files
        if (toolName === 'delete_file' && args.file_path) {
          const dp = (args.file_path || '').replace(/\\/g, '/').toLowerCase();
          if ((deleteCreateCount.get(dp) || 0) >= 1) {
            result = {
              error: `BLOCKED: "${args.file_path}" was already deleted+recreated in this session. ` +
                `Repeating this cycle wastes tokens and causes truncated files. ` +
                `Use edit_file with small targeted edits (10-30 lines each) instead.`
            };
            logger.log(`[AGENT] Blocked delete_file for ${args.file_path} (delete+create cycle #${deleteCreateCount.get(dp)})`);
          }
        }
        if (!result) {
          try {
            result = await executeTool(toolName, args, workspaceRoot);
          } catch (err: any) {
            result = { error: err.message || String(err) };
          }
        }
      }
      const toolDuration = Date.now() - toolStart;

      // Notify webview about tool usage for metrics tracking (all tools, one place)
      postMessage({ type: 'toolUsed', tool: toolName });

      // Log tool result summary
      if (result?.error) {
        logger.log(`[TOOL] ${toolName} FAILED (${toolDuration}ms): ${result.error}`);
      } else if (toolName === 'diagnose') {
        logger.log(`[TOOL] diagnose OK (${toolDuration}ms): errors=${result?.errors_count || 0}`);
      } else if (toolName === 'read_file') {
        const lines = result?.content?.split('\n').length || 0;
        logger.log(`[TOOL] read_file OK (${toolDuration}ms): ${lines} lines, file=${args.file_path}`);
      } else if (toolName === 'apply_patch') {
        logger.log(`[TOOL] apply_patch (${toolDuration}ms): success=${result?.success}, files=${result?.files_modified?.join(',') || 'none'}`);
      } else if (toolName === 'get_diagnostics') {
        logger.log(`[TOOL] get_diagnostics OK (${toolDuration}ms): ${result?.content?.slice(0, 200) || 'empty'}`);
      } else {
        logger.log(`[TOOL] ${toolName} OK (${toolDuration}ms)`);
      }

      // Create file action for read_file
      if (toolName === 'read_file') {
        // Use resolved path from result if available, otherwise fall back to args
        const filePath = result?.file || args.file_path || '';
        const fileName = filePath.split(/[/\\]/).pop() || filePath;

        if (result && !result.error) {
          const fileAction: MessageAction = {
            type: 'read_file',
            fileName,
            filePath,
            success: true,
            startLine: result.start_line || args.start_line || 1,
            endLine: result.end_line || args.end_line,
            totalLines: result.total_lines,
            truncated: result.truncated
          };
          collectedActions.push(fileAction);
          // Show action indicator in webview
          postMessage({ type: 'fileReadAction', id: assistantPlaceholderId, fileAction });
        } else {
          const fileAction: MessageAction = {
            type: 'read_file',
            fileName,
            filePath,
            success: false,
            error: result?.error || 'Unknown error'
          };
          collectedActions.push(fileAction);
          postMessage({ type: 'fileReadAction', id: assistantPlaceholderId, fileAction });
        }
      }

      // Create file action for edit_file
      if (toolName === 'edit_file') {
        // Use resolved path from result if available, otherwise fall back to args
        const filePath = result?.file || args.file_path || '';
        const fileName = filePath.split(/[/\\]/).pop() || filePath;

        const fileAction: MessageAction = {
          type: 'edit_file',
          fileName,
          filePath,
          success: result && !result.error,
          error: result?.error,
          linesAdded: result?.linesAdded,
          linesRemoved: result?.linesRemoved,
          startLine: result?.line
        };
        collectedActions.push(fileAction);
        postMessage({ type: 'fileEditAction', id: assistantPlaceholderId, fileAction });
      }

      // Create file action for apply_patch (new patch-based editing)
      if (toolName === 'apply_patch') {
        // apply_patch can modify multiple files, create action for each
        if (result && result.files_modified && Array.isArray(result.files_modified)) {
          for (const filePath of result.files_modified) {
            const fileName = filePath.split(/[/\\]/).pop() || filePath;
            const fileAction: MessageAction = {
              type: 'edit_file',  // Reuse edit_file type for UI compatibility
              fileName,
              filePath,
              success: result.success,
              error: result.errors?.join('; ')
            };
            collectedActions.push(fileAction);
            postMessage({ type: 'fileEditAction', id: assistantPlaceholderId, fileAction });
          }
        } else if (result && !result.success) {
          // Patch failed entirely
          const fileAction: MessageAction = {
            type: 'edit_file',
            fileName: 'patch',
            filePath: '',
            success: false,
            error: result.errors?.join('; ') || result.error || 'Patch failed'
          };
          collectedActions.push(fileAction);
          postMessage({ type: 'fileEditAction', id: assistantPlaceholderId, fileAction });
        }
      }

      // Create file action for create_file
      if (toolName === 'create_file') {
        // Use resolved path from result if available, otherwise fall back to args
        const filePath = result?.file_path || args.file_path || '';
        const fileName = filePath.split(/[/\\]/).pop() || filePath;

        const fileAction: MessageAction = {
          type: 'create_file',
          fileName,
          filePath,
          success: result && !result.error,
          error: result?.error
        };
        collectedActions.push(fileAction);
        postMessage({ type: 'fileCreateAction', id: assistantPlaceholderId, fileAction });
      }

      // Create file action for delete_file
      if (toolName === 'delete_file') {
        const filePath = result?.file_path || args.file_path || '';
        const fileName = filePath.split(/[/\\]/).pop() || filePath;

        const fileAction: MessageAction = {
          type: 'delete_file',
          fileName,
          filePath,
          success: result && !result.error,
          error: result?.error
        };
        collectedActions.push(fileAction);
        postMessage({ type: 'fileDeleteAction', id: assistantPlaceholderId, fileAction });
      }

      // list_files, diagnose, run_tests, find_references, fetch_url — 
      // these tools execute normally but do NOT show UI indicators or save actions.
      // Only 7 tools get visible indicators: read_file, edit_file, create_file, delete_file, search, terminal, web_search

      // Send search result for UI accordion
      if (toolName === 'search') {
        const results = result?.results || result?.matches || [];
        const totalResults = result?.total_results || result?.total_matches || results.length;
        postMessage({
          type: 'searchResult',
          id: assistantPlaceholderId,
          success: !result?.error,
          query: args.query || '',
          mode: result?.mode || 'workspace',
          results: results.slice(0, 20),
          totalResults
        });
        collectedActions.push({
          type: 'search',
          query: args.query || '',
          totalResults,
          success: !result?.error
        });
      }

      // Send web_search result for UI accordion
      if (toolName === 'web_search') {
        postMessage({
          type: 'webSearchResult',
          id: assistantPlaceholderId,
          success: result?.success ?? false,
          query: args.query || '',
          results: result?.results || [],
          resultsCount: result?.results_count || 0
        });
        collectedActions.push({
          type: 'web_search',
          query: args.query || '',
          resultsCount: result?.results_count || 0,
          success: result?.success ?? false
        });
      }

      // Add tool result to conversation (with token-saving truncation)
      const rawResult = typeof result === 'string' ? result : JSON.stringify(result);
      const MAX_TOOL_RESULT_CHARS = 12000; // ~3000 tokens max per tool result
      // read_file gets a dynamic higher limit based on model context window.
      // Too-small limits force repeated reads and lead to bad edits/full rewrites.
      const readCtxWindow = Math.min(modelContextLength || DEFAULT_CONTEXT_WINDOW, MAX_EFFECTIVE_CONTEXT);
      const readFileTokenBudget = Math.max(6000, Math.min(20000, Math.floor(readCtxWindow * 0.35)));
      const MAX_READ_FILE_CHARS = readFileTokenBudget * 4; // ~chars from tokens
      const effectiveMaxChars = (toolName === 'read_file') ? MAX_READ_FILE_CHARS : MAX_TOOL_RESULT_CHARS;
      let toolResultContent = rawResult;

      // ---- TERMINAL OUTPUT TRUNCATION ----
      // Terminal output can be huge (npm install, build logs, test output).
      // Pattern from Cline: keep first half + last half of lines.
      // This preserves the command header and the final result/error.
      if ((toolName === 'terminal' || toolName === 'run_terminal_command') && rawResult.length > MAX_TOOL_RESULT_CHARS) {
        const lines = rawResult.split('\n');
        if (lines.length > 40) {
          const keepHead = 15; // First 15 lines (command, initial output)
          const keepTail = 15; // Last 15 lines (final result, exit code, errors)
          const omitted = lines.length - keepHead - keepTail;
          toolResultContent = [
            ...lines.slice(0, keepHead),
            `\n... [${omitted} lines omitted to save context] ...\n`,
            ...lines.slice(-keepTail)
          ].join('\n');
          logger.log(`[AGENT] Terminal output truncated: ${lines.length} lines -> ${keepHead}+${keepTail} lines (${omitted} omitted)`);
        }
      }

      // General truncation for all tool results
      if (toolResultContent.length > effectiveMaxChars) {
        // Keep first and last portions for context
        const headSize = Math.floor(effectiveMaxChars * 0.7);
        const tailSize = Math.floor(effectiveMaxChars * 0.2);
        const removedChars = toolResultContent.length - headSize - tailSize;
        toolResultContent = toolResultContent.slice(0, headSize) 
          + `\n\n... [truncated ${removedChars} chars to save tokens] ...\n\n`
          + toolResultContent.slice(-tailSize);
        logger.log(`[AGENT] Tool result truncated for ${toolName}: ${rawResult.length} -> ${toolResultContent.length} chars (limit=${effectiveMaxChars}, removed=${removedChars})`);
      }
      conversationMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResultContent
      });

      // Warn model when create_file/edit_file was truncated by max_tokens
      if (response.finish_reason === 'length' && (toolName === 'create_file' || toolName === 'edit_file')) {
        const actualLines = result?.total_lines || 0;
        const truncWarning = `\n\n\u26a0\ufe0f WARNING: Your response was TRUNCATED (finish_reason=length). ` +
          `The content you tried to write was cut off mid-stream. ` +
          `The file on disk may be INCOMPLETE (${actualLines} lines saved). ` +
          `Do NOT assume the file has all the content you intended. ` +
          `NEXT STEP: Use read_file to check what was actually saved, then use multiple small edit_file calls to add the missing parts.`;
        conversationMessages[conversationMessages.length - 1].content += truncWarning;
        logger.log(`[AGENT] Appended truncation warning for ${toolName} (finish_reason=length, ${actualLines} lines saved)`);
      }

      // Track create_file for delete+create cycle detection
      if (toolName === 'create_file' && result?.success && args.file_path) {
        const cp = (args.file_path || '').replace(/\\/g, '/').toLowerCase();
        deleteCreateCount.set(cp, (deleteCreateCount.get(cp) || 0) + 1);
      }

      // ============ LOOP BREAKER ============
      // Detect when model keeps calling the same tool with the same args repeatedly.
      // Works for ALL tools: edit_file failing, terminal running same command, etc.
      // Uses a signature of tool name + key args + truncated result to detect loops.
      const resultHash = toolResultContent.slice(0, 500); // Use longer prefix for more accurate loop detection
      const failSig = toolName === 'terminal'
        ? `terminal:${args?.command || ''}`  // For terminal: track exact command
        : `${toolName}:${args?.file_path || args?.command || args?.query || ''}`;
      const fullSig = `${failSig}|${resultHash}`; // Include result to detect "same command, same result"

      // Track: same tool+args AND same result = model is looping
      if (fullSig === lastFailSignature) {
        consecutiveFailCount++;
      } else {
        consecutiveFailCount = 1;
        lastFailSignature = fullSig;
      }

      if (consecutiveFailCount >= MAX_CONSECUTIVE_FAILS) {
        const triggerKey = failSig;
        const triggers = (loopBreakerTriggers.get(triggerKey) || 0) + 1;
        loopBreakerTriggers.set(triggerKey, triggers);

        logger.log(`[AGENT] LOOP BREAKER: ${consecutiveFailCount} consecutive identical calls for ${failSig} (trigger #${triggers}). Injecting break message.`);

        let breakMsg: string;
        if (triggers >= 2) {
          // ESCALATION: model is utterly stuck, force it to stop
          breakMsg = `SYSTEM OVERRIDE: You have looped on "${failSig}" ${triggers} times. ` +
            `You MUST stop working on this file/command immediately. ` +
            `Call attempt_completion NOW and tell the user what you accomplished and what you couldn't complete. ` +
            `Any further tool calls for this file will be blocked.`;
        } else if (toolName === 'terminal') {
          breakMsg = `CRITICAL: You have run the EXACT SAME terminal command "${(args?.command || '').slice(0, 60)}" ${consecutiveFailCount} times and got the same result each time. ` +
            `You are in a LOOP. STOP running this command. ` +
            `The command output is not going to change. ` +
            `Options: 1) Fix the underlying issue (edit the code/config that causes the error). ` +
            `2) Try a completely different command. ` +
            `3) Report the problem to the user and move on.`;
        } else {
          breakMsg = `CRITICAL: This tool call has produced the same result ${consecutiveFailCount} times in a row. ` +
            `You are in a LOOP. STOP retrying the same approach. ` +
            `Options: 1) Use read_file to see current file content first. ` +
            `2) Try a completely different strategy. ` +
            `3) If the file is large, edit a smaller section at a time. ` +
            `4) Skip this file and move on to the next task. ` +
            `DO NOT retry the same call again.`;
        }
        conversationMessages[conversationMessages.length - 1].content = breakMsg;
        consecutiveFailCount = 0; // Reset so we don't trigger again immediately
      }
    }

    // NOTE: We intentionally do NOT compress assistant tool_call arguments.
    // The model copies its own previous tool_calls from conversation history.
    // Any modification gets copied verbatim into new tool calls, causing
    // validation failures and infinite loops. Context savings are handled
    // by cache-friendly drop-compression below, which removes ENTIRE old
    // assistant+tool message groups instead of modifying them.

    // Add separator for next iteration's content
    if (accumulatedContent && !accumulatedContent.endsWith('\n\n')) {
      accumulatedContent += '\n\n';
    }

    // ============ MID-LOOP CONTEXT COMPRESSION (cache-friendly) ============
    // CRITICAL FOR COST OPTIMIZATION:
    //
    // The old approach modified old messages in-place (truncating tool results,
    // stripping tool_call args, shortening assistant text). This DESTROYED
    // prompt caching because providers cache the byte-identical prefix of the
    // message array. Any modification to an old message changes the prefix,
    // causing a cache miss and forcing 100% token cost every iteration.
    //
    // New approach: DROP complete assistant+tool groups from the oldest end.
    // Remaining messages stay byte-identical to what was sent in previous
    // API calls, so the provider cache hits on the shared prefix.
    //
    // We drop to DROP_TARGET (60% of threshold) to create a buffer zone:
    // after one drop event, ~4-5 iterations pass before the next one.
    // This means cache is valid ~80% of iterations instead of ~0%.
    //
    // Cost impact (25-iteration session, 25K threshold):
    //   Old (modify every iter): 0% cache hit → ~500K billable input tokens
    //   New (drop every ~5 iter): ~80% cache hit → ~300K billable, ~200K cached at 50-90% discount
    //
    // ============ MODEL-DEPENDENT THRESHOLDS ============
    // Use contextLength from model API (stored in AIModel.contextLength).
    // Fallback to 32K if API didn't return context_length.
    // Cap at MAX_EFFECTIVE_CONTEXT (128K) for efficiency.
    const rawCtxWindow = modelContextLength || DEFAULT_CONTEXT_WINDOW;
    const ctxWindow = Math.min(rawCtxWindow, MAX_EFFECTIVE_CONTEXT);
    const ctxBuffer = ctxWindow <= 16000 ? 4000    // Tiny models (≤16K): 4K buffer
                    : ctxWindow <= 32000 ? 8000    // Small models (16K-32K): 8K buffer
                    : ctxWindow <= 65000 ? 16000   // Medium models (32K-64K): 16K buffer
                    : ctxWindow <= 131000 ? 30000  // Large models (128K): 30K buffer
                    : 40000;                        // XL models (200K+): 40K buffer
    const MID_LOOP_COMPRESS_THRESHOLD = Math.max(
      Math.floor(ctxWindow * 0.8) - ctxBuffer,  // 80% minus buffer
      Math.min(ctxWindow - ctxBuffer, 40000)     // At least ctxWindow-buffer, capped at 40K for safety
    );
    const DROP_TARGET_RATIO = 0.65; // Drop to 65% of threshold (buffer for ~4-5 iterations)
    const MIN_KEEP_MSGS = 12; // Always keep last N messages untouched (more recent context)
    if (iteration === 2) {
      logger.log(`[CACHE] Mid-loop thresholds: ctxWindow=${ctxWindow}${modelContextLength ? '' : ' (DEFAULT — model contextLength unknown)'}, compress@${MID_LOOP_COMPRESS_THRESHOLD} tokens`);
    }

    if (iteration >= 2) {
      // NOTE: Deduplication and pruning were REMOVED.
      // With 262K context window, retroactive mutation of conversationMessages
      // causes more harm (context loss, inconsistent state) than it prevents.
      // The mid-loop compression below is the only safety net — it only fires
      // when context exceeds 80% of the window, which rarely happens.

      const contextSize = lastKnownContextTokens > 0 && messagesAtLastApiCall > 0
        ? lastKnownContextTokens + estimateTokenCount(conversationMessages.slice(messagesAtLastApiCall))
        : estimateTokenCount(conversationMessages);
      logger.log(`[CACHE] Context size check: ${contextSize} tokens (threshold=${MID_LOOP_COMPRESS_THRESHOLD})${lastKnownContextTokens > 0 ? ` [base=${lastKnownContextTokens} from API + ${contextSize - lastKnownContextTokens} delta]` : ' [estimate]'}`);
      if (contextSize > MID_LOOP_COMPRESS_THRESHOLD) {
        const dropTarget = Math.floor(MID_LOOP_COMPRESS_THRESHOLD * DROP_TARGET_RATIO);
        const tokensToSave = contextSize - dropTarget;

        // Identify droppable assistant+tool groups.
        // A group = 1 assistant message (with tool_calls) + all subsequent tool messages.
        // We MUST drop complete groups to avoid orphaned tool_call_ids (API contract).
        const keepBoundary = conversationMessages.length - MIN_KEEP_MSGS;

        // Skip system prompt (idx 0) and initial user message(s)
        let scanStart = 1;
        while (scanStart < keepBoundary && conversationMessages[scanStart].role !== 'assistant') {
          scanStart++;
        }

        // Collect groups
        const groups: { start: number; end: number; tokens: number; summary: string }[] = [];
        let gi = scanStart;
        while (gi < keepBoundary) {
          if (conversationMessages[gi].role === 'assistant') {
            const gStart = gi;
            const assistantMsg = conversationMessages[gi];
            gi++;
            // Collect tool messages belonging to this assistant's tool_calls
            while (gi < keepBoundary && conversationMessages[gi].role === 'tool') {
              gi++;
            }
            // Brief summary for logging
            let summary = '';
            if (assistantMsg.tool_calls) {
              summary = assistantMsg.tool_calls.map((tc: any) => {
                const name = tc.function?.name || '?';
                try {
                  const a = JSON.parse(tc.function?.arguments || '{}');
                  if (a.file_path) return `${name}:${a.file_path.split(/[\\/]/).pop()}`;
                  if (a.command) return `${name}:${a.command.slice(0, 25)}`;
                  if (a.query) return `${name}:${a.query.slice(0, 25)}`;
                } catch {}
                return name;
              }).join(', ');
            }
            groups.push({
              start: gStart,
              end: gi,
              tokens: estimateTokenCount(conversationMessages.slice(gStart, gi)),
              summary
            });
          } else {
            gi++; // skip unexpected non-assistant messages
          }
        }

        // Select oldest groups to drop until we've saved enough tokens
        let saved = 0;
        let numDrop = 0;
        const droppedSummaries: string[] = [];
        for (const grp of groups) {
          if (saved >= tokensToSave) break;
          saved += grp.tokens;
          numDrop++;
          if (grp.summary) droppedSummaries.push(grp.summary);
        }

        if (numDrop > 0) {
          const dropStart = groups[0].start;
          const dropEnd = groups[numDrop - 1].end;
          const droppedMsgCount = dropEnd - dropStart;

          // Splice out dropped groups (single operation, preserves remaining order)
          conversationMessages.splice(dropStart, droppedMsgCount);

          const afterSize = estimateTokenCount(conversationMessages);
          logger.log(
            `[CACHE] Drop-compression at iter ${iteration}: ${contextSize} → ${afterSize} tokens ` +
            `(dropped ${numDrop} groups / ${droppedMsgCount} msgs, saved ~${saved} tok). ` +
            `Dropped: [${droppedSummaries.join(' | ')}]`
          );

          // ---- VALIDATE tool_use/tool_result PAIRS ----
          // After dropping messages, ensure no orphaned tool_call_ids or tool_calls remain.
          // An orphaned tool result (without matching assistant tool_call) crashes the API.
          // Pattern from Cline: ensureToolResultsFollowToolUse()
          const validToolCallIds = new Set<string>();
          for (const m of conversationMessages) {
            if (m.role === 'assistant' && m.tool_calls) {
              for (const tc of m.tool_calls) {
                validToolCallIds.add(tc.id);
              }
            }
          }
          // Remove orphaned tool results (tool_call_id not in any assistant message)
          let orphansRemoved = 0;
          for (let vi = conversationMessages.length - 1; vi >= 0; vi--) {
            if (conversationMessages[vi].role === 'tool' && conversationMessages[vi].tool_call_id) {
              if (!validToolCallIds.has(conversationMessages[vi].tool_call_id!)) {
                conversationMessages.splice(vi, 1);
                orphansRemoved++;
              }
            }
          }
          // Remove assistant messages with tool_calls that have no matching tool results
          const existingToolResultIds = new Set<string>();
          for (const m of conversationMessages) {
            if (m.role === 'tool' && m.tool_call_id) {
              existingToolResultIds.add(m.tool_call_id);
            }
          }
          for (let vi = conversationMessages.length - 1; vi >= 0; vi--) {
            const m = conversationMessages[vi];
            if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
              const allOrphaned = m.tool_calls.every((tc: any) => !existingToolResultIds.has(tc.id));
              if (allOrphaned) {
                conversationMessages.splice(vi, 1);
                orphansRemoved++;
              }
            }
          }
          if (orphansRemoved > 0) {
            logger.log(`[CACHE] Removed ${orphansRemoved} orphaned tool_call/tool_result messages after compression`);
          }
        } else {
          logger.log(`[CACHE] Compression needed but no droppable groups found (keepBoundary=${keepBoundary}, groups=${groups.length})`);
        }
      }
    }

    // Update context size metric after tools are processed (prevents UI "freeze"
    // while tools execute between API calls).
    // Use lastKnownContextTokens (from API prompt_tokens) as base.
    // Add estimated delta from tool results added since last API call.
    // This prevents saw-tooth pattern where metric jumps between API-reported
    // and locally-estimated values.
    const postToolMetrics: any = {
        inputTokens: sessionInputTokens,
        outputTokens: sessionOutputTokens,
        apiCalls: sessionApiCalls,
        currentContextTokens: lastKnownContextTokens,
        contextLimit: modelContextLength || DEFAULT_CONTEXT_WINDOW,
        cachedTokens: currentModelHasCache ? sessionCachedTokens : 0
    };
    postMessage({
      type: 'metricsUpdate',
      id: assistantPlaceholderId,
      metrics: postToolMetrics
    });

    iteration++;
    if (iteration >= maxIterations) {
      if (requestIterationConfirmation) {
        logger.log(`[AGENT] Reached iteration limit ${maxIterations}. Asking user...`);
        const confirmed = await requestIterationConfirmation();
        if (confirmed) {
          maxIterations += 5;
          logger.log(`[AGENT] User extended iterations to ${maxIterations}`);
        } else {
          logger.log(`[AGENT] User denied iteration extension`);
          break;
        }
      } else {
        logger.log(`[AGENT] Reached iteration limit ${maxIterations}. Stopping.`);
        break;
      }
    }
  }
  } catch (loopError) {
    // CRITICAL: Persist conversation state before propagating error.
    // Without this, all tool results and assistant messages from this agent loop run are LOST,
    // causing context loss when user retries after a provider error.
    logger.log(`[AGENT] Error in agent loop — saving conversation state (${conversationMessages.length} messages) before propagating`);
    onConversationUpdate?.(conversationMessages);
    throw loopError;
  }

  // Build full content from all text actions for storage
  const fullContent = collectedActions
    .filter(a => a.type === 'text')
    .map(a => (a as { type: 'text'; content: string }).content)
    .join('\n\n');

  // Final update - mark as not temporary, save with actions and modelName
  updateHistoryEntry(assistantPlaceholderId, accumulatedContent || fullContent, false, collectedActions, model);
  postMessage({ type: 'streamEnd', id: assistantPlaceholderId, actions: collectedActions });

  // Persist full conversation state (including tool calls) for next request
  onConversationUpdate?.(conversationMessages);

  return true;
}
