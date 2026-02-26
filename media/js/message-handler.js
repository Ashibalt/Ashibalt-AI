/* ================================================================
   MESSAGE-HANDLER — обработка всех входящих сообщений из расширения
   через window.addEventListener('message', ...)
   ================================================================ */

    // Message Handling
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'addMessage':
          addMessage(message.role, message.content, message.reasoning, { id: message.id, replyTo: message.replyTo, attachment: message.attachment, attachedFiles: message.attachedFiles, deferFooter: message.deferFooter, fileActions: message.fileActions, actions: message.actions, modelName: message.modelName, errorDetails: message.errorDetails });
          break;
        case 'streamResponse':
          updateLastAssistantMessage(message.content, message.reasoning, message.id, message.modelName);
          break;
        case 'metricsUpdate':
          updateMetricsDashboard(message.metrics);
          // Track cumulative token deltas (input/output separate)
          if (metricsToggle && metricsToggle.checked && message.metrics) {
            const inNow = message.metrics.inputTokens || 0;
            const outNow = message.metrics.outputTokens || 0;
            const inDelta = inNow - (window.__lastInputTokens || 0);
            const outDelta = outNow - (window.__lastOutputTokens || 0);
            const eventData = {};
            if (inDelta > 0) eventData.inputTokens = inDelta;
            if (outDelta > 0) eventData.outputTokens = outDelta;
            // Track model usage from agentLoop (authoritative source)
            if (message.metrics.model) eventData.model = message.metrics.model;
            trackUsageEvent(eventData);
            window.__lastInputTokens = inNow;
            window.__lastOutputTokens = outNow;
          }
          break;
        case 'toolUsed':
          // Centralized tool usage tracking — agentLoop sends this for EVERY tool call
          if (metricsToggle && metricsToggle.checked && message.tool) {
            trackUsageEvent({ tool: message.tool });
          }
          break;
        case 'tasksUpdate':
          renderTasksPanel(message.tasks);
          break;
        case 'balanceUpdate':
          updateBalanceDisplay(message.balance);
          break;
        case 'terminalInteractivePrompt':
          showTerminalInteractivePrompt(message.output, message.prompt, message.id, message.suggestion || '');
          break;
        case 'streamEnd':
          // Finalize interrupted message - add footer if needed
          if (message.id) {
            const msg = chatContainer.querySelector(`.message.assistant[data-msg-id="${message.id}"]`);
            if (msg) {
              // Persist actions on the DOM element for saveChatState
              if (message.actions && message.actions.length > 0) {
                msg.dataset.actions = JSON.stringify(message.actions);
              }
              // If raw content is empty but backend sent content, populate it
              if (!msg.dataset.raw && message.content) {
                msg.dataset.raw = message.content;
                // Also render it visibly if msgDiv is empty
                const msgDiv = msg.querySelector('.markdown-content') || msg;
                if (!msgDiv.textContent?.trim()) {
                  msgDiv.innerHTML = renderMarkdown(message.content);
                }
              }
              // Always attempt to add footer (appendFooterToMessage is idempotent)
              const content = msg.dataset.raw || message.content || '';
              const modelName = msg.dataset.modelName || message.modelName || '';
              appendFooterToMessage(msg, content, modelName);
            }
          }
          // Clean up any stuck "correcting" indicators — replace spinner with error state
          {
            const stuckCorrectings = chatContainer.querySelectorAll('.correcting');
            stuckCorrectings.forEach(el => {
              // Replace correcting class with failed state
              el.classList.remove('correcting');
              el.classList.add('failed');
              const spinner = el.querySelector('.tool-spinner');
              if (spinner) {
                spinner.outerHTML = '<span class="codicon codicon-warning" style="color:var(--warning-color,#e2b340);"></span>';
              }
              const correctingText = el.querySelector('.correcting-text');
              if (correctingText) {
                correctingText.textContent = 'Не удалось исправить';
                correctingText.classList.remove('correcting-text');
              }
            });
          }
          break;
        case 'clearChat':
          chatContainer.innerHTML = '';
          // Unlock mode toggle for new session
          modeLocked = false;
          if (modeSelector) {
            modeSelector.style.opacity = '1';
            modeSelector.style.cursor = 'pointer';
          }
          // Изначальный размер 60, при желании увеличить
          chatContainer.innerHTML = `
            <div class="welcome-screen" id="welcome-screen">
              <div class="welcome-icon">
<svg width="48" height="48" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg">
<g clip-path="url(#clip0)">
<path d="M30 60C46.5685 60 60 46.5685 60 30C60 13.4315 46.5685 0 30 0C13.4315 0 0 13.4315 0 30C0 46.5685 13.4315 60 30 60Z"/>
<path d="M30 36.36C33.5143 36.36 36.36 33.5143 36.36 30C36.36 26.4857 33.5143 23.64 30 23.64C26.4857 23.64 23.64 26.4857 23.64 30C23.64 33.5143 26.4857 36.36 30 36.36Z" fill="gray"/>
<path d="M36.16 14.88L30.32 0.76L24.36 14.88C24.36 14.88 30.16 12.28 36.16 14.88Z" fill="gray"/>
<path d="M15.4 23.2C15.4 23.2 17.68 17.32 23.96 14.68L9.56 9.2L15.4 23.2Z" fill="gray"/>
<path d="M58.04 29.16L44.32 23.2C44.32 23.2 47.36 29.08 44.72 35.36L58.04 29.16Z" fill="gray"/>
<path d="M44.16 23.24L50.12 8.84L35.92 14.76C35.92 14.76 41.8 17 44.16 23.24Z" fill="gray"/>
<path d="M24.4 45.04L30.24 59.16L36.16 45.04C36.16 45.04 30.36 47.64 24.4 45.04Z" fill="gray"/>
<path d="M35.96 44.88L50.36 50.36L44.52 36.36C44.52 36.36 42.24 42.24 35.96 44.88Z" fill="gray"/>
<path d="M2 30.04L15.72 36C15.72 36 12.68 30.12 15.32 23.84L2 30.04Z" fill="gray"/>
<path d="M15.8 36.32L9.92 50.76L24.04 44.8C24.04 44.8 18.12 42.56 15.8 36.32Z" fill="gray"/>
</g>
<defs>
<clipPath id="clip0">
<rect width="60" height="60" fill="white"/>
</clipPath>
</defs>
</svg>
              </div>
              <h2 class="welcome-title">Запуск в режиме агента</h2>
              <p class="welcome-subtitle">Ответы AI могут быть неточными.</p>
              <p class="welcome-hint">Добавьте контекст (#), команды (/)</p>
            </div>
          `;
          localStorage.removeItem(CHAT_STATE_KEY);
          lastUserMessageId = null;
          isRestoringState = true; // Don't save to localStorage while loading session
          // Reset metrics dashboard
          const metricsDash = document.getElementById('metrics-dashboard');
          if (metricsDash) {
            metricsDash.innerHTML = '';
          }
          if (metricsFabWrap) {
            metricsFabWrap.style.display = 'none';
            metricsFabWrap.classList.remove('open');
          }
          window.__lastMetricsTokens = 0;
          // Clear tasks panel
          renderTasksPanel([]);
          break;
        case 'sessionLoaded':
          // Session finished loading, allow saving to localStorage again
          isRestoringState = false;
          saveChatState();
          break;
        case 'confirmSessionSwitch':
          showSessionSwitchDialog();
          break;
        case 'addContext':
          addContextChip(message.label, message.path, message.icon);
          break;
        case 'updateModelText':
          setModelSelectorLabel(message.value || '');
          if (!message.value) {
            currentSelectedModelId = null;
          }
          break;
        case 'setCurrentFile':
          const btn = document.getElementById('add-current-file-btn');
          if (btn) {
             const nameSpan = btn.querySelector('.file-name');
             if (nameSpan) nameSpan.textContent = message.value;
          }
          break;
        case 'updateHistory':
          renderHistory(message.sessions, message.currentSessionId);
          // Don't auto-show sidebar, only update data
          break;
        case 'updateModels':
          savedModels = message.models || [];
          currentSelectedModelId = message.selectedModelId || null;
          currentCodeModelId = message.codeModelId || null;
          renderModels(message.models || [], message.selectedModelId || null);
          
          // Update configProvider based on selected model
          if (message.selectedModelId && message.models) {
            const selectedModel = message.models.find(m => m.id === message.selectedModelId);
            if (selectedModel) {
              configProvider = selectedModel.provider;
            }
          }
          break;
        case 'fetchProviderModelsResult':
          // Remove loading state from fetch button
          document.querySelectorAll(`.provider-fetch-btn[data-provider="${message.provider}"]`).forEach(btn => {
            btn.classList.remove('loading');
          });
          break;
        case 'providerModelsList':
          // Show model browser popup for cloud providers
          showModelBrowser(message.provider, message.models || []);
          break;
        case 'updateAuthUser':
          // Update auth UI with user info or null (logged out)
          updateAuthUI(message.user);
          break;
        case 'updateSettings':
          // Update settings form with current values
          if (message.agentIterations !== undefined && agentIterationsSlider && agentIterationsValue) {
            agentIterationsSlider.value = message.agentIterations;
            agentIterationsValue.textContent = String(message.agentIterations);
          }
          // Restore Ollama URL
          if (message.ollamaBaseUrl !== undefined) {
            const urlInput = document.getElementById('ollama-base-url');
            if (urlInput) {
              urlInput.value = message.ollamaBaseUrl || 'http://localhost:11434';
            }
          }
          break;
        case 'restoreMode':
          if (message.mode) {
            dbg('[Mode] Restoring mode from extension:', message.mode);
            currentMode = message.mode;
            updateModeSelectorUI();
          }
          break;
        case 'lockMode':
          modeLocked = !!message.locked;
          if (modeSelector) {
            modeSelector.style.opacity = modeLocked ? '0.5' : '1';
            modeSelector.style.cursor = modeLocked ? 'default' : 'pointer';
          }
          dbg('[Mode] Mode lock:', modeLocked ? 'LOCKED' : 'UNLOCKED');
          break;
        case 'restoreSettings':
          // Restore saved provider settings (API keys, URLs) on webview reload
          dbg('[Settings] Restoring saved settings');
          if (message.providerSettings) {
            for (const [prov, val] of Object.entries(message.providerSettings)) {
              if (!val) continue;
              const acc = document.querySelector(`.provider-accordion[data-provider="${prov}"]`);
              if (!acc) continue;
              if (val.apiKey) {
                const apiInput = acc.querySelector('.provider-apikey');
                if (apiInput) apiInput.value = val.apiKey;
              }
              if (val.url) {
                const urlInput = acc.querySelector('.provider-url');
                if (urlInput) urlInput.value = val.url;
              }
            }
          }
          if (message.ollamaBaseUrl) {
            const ollamaUrl = document.getElementById('ollama-base-url');
            if (ollamaUrl) ollamaUrl.value = message.ollamaBaseUrl;
          }
          if (message.agentIterations) {
            const slider = document.getElementById('agent-iterations-slider');
            const valueEl = document.getElementById('agent-iterations-value');
            if (slider) slider.value = String(message.agentIterations);
            if (valueEl) valueEl.textContent = String(message.agentIterations);
          }
          if (message.autoRunTerminal !== undefined) {
            const toggle = document.getElementById('auto-run-terminal');
            if (toggle) toggle.checked = message.autoRunTerminal;
            const warning = document.getElementById('auto-run-warning');
            if (warning) warning.style.display = message.autoRunTerminal ? '' : 'none';
          }
          // Restore metrics toggle from VS Code config (overrides localStorage default)
          if (message.metricsEnabled !== undefined) {
            const metricsToggleEl = document.getElementById('metrics-toggle');
            if (metricsToggleEl) {
              metricsToggleEl.checked = message.metricsEnabled;
              localStorage.setItem('ashibalt_metrics_enabled', message.metricsEnabled ? 'true' : 'false');
              const panel = document.getElementById('usage-metrics-panel');
              if (panel) panel.style.display = message.metricsEnabled ? 'block' : 'none';
            }
          }
          break;
        case 'slashCommands':
          // Store slash commands for autocomplete
          slashCommands = message.commands || [];
          break;
        case 'fileCompletions':
          // Show file completions for # autocomplete
          fileCompletions = message.files || [];
          if (fileCompletions.length > 0) {
            showAutocomplete(fileCompletions, 'hash');
          } else {
            hideAutocomplete();
          }
          break;
        case 'setConfigPath':
          if (configPathDisplay && message.path) {
            configPathDisplay.textContent = message.path;
          }
          break;
        case 'removeLastAssistantMessage':
          removeLastAssistantMessage();
          break;
        case 'removeMessage':
          removeMessageById(message.id);
          break;
        case 'removeLastAssistantFooter':
          // Remove footer/toolbar from last assistant message (used when continuing a response)
          {
            const msgs = chatContainer.querySelectorAll('.message.assistant');
            const last = msgs[msgs.length - 1];
            if (last) {
              const footer = last.querySelector('.message-footer');
              if (footer) footer.remove();
            }
          }
          break;
        case 'clearContext':
          // Clear all context chips from the context bar
          contextBar.innerHTML = '';
          break;
        case 'setLoading':
          dbg('webview: setLoading', message.value);
          if (message.value) {
            modelStreaming = true;
            // Remove stale error bubbles from previous requests
            chatContainer.querySelectorAll('.message.system').forEach(el => el.remove());
            // Change button to Stop
            if (sendBtn) {
              sendBtn.innerHTML = STOP_ICON_SVG;
              sendBtn.dataset.state = 'stop';
              sendBtn.classList.remove('ready');
              sendBtn.classList.add('streaming');
            }
            // show temporary loading placeholder if not already present
            if (!chatContainer.querySelector('.message.assistant[data-temporary="loading"]')) {
              const temp = document.createElement('div');
              temp.className = 'message assistant';
              temp.dataset.temporary = 'loading';
              // Use message-content with content-segment for consistency with new architecture
              const messageContent = document.createElement('div');
              messageContent.className = 'message-content';
              const segment = document.createElement('div');
              segment.className = 'content-segment';
              segment.dataset.segmentIdx = '0';
              segment.dataset.raw = '';
              // explicit inline style to ensure visibility across themes
              segment.innerHTML = `<span class="loader"></span><span style="color:var(--text-color); padding-left:4px;">Выполняется...</span>`;
              messageContent.appendChild(segment);
              temp.appendChild(messageContent);
              chatContainer.appendChild(temp);
              markLatestAssistantMessage();
              scrollToBottom();
            }
          } else {
            // streaming finished
            modelStreaming = false;
            
            // Switch reasoning indicators from "thinking" to "completed"
            const thinkingIndicators = chatContainer.querySelectorAll('.reasoning-indicator.thinking');
            thinkingIndicators.forEach(indicator => {
              indicator.classList.remove('thinking');
              indicator.classList.add('completed');
              indicator.innerHTML = `
                <svg class="reasoning-check-icon" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 111.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/>
                </svg>
                <span class="reasoning-label">Thinking</span>
              `;
            });
            
            // remove any lingering loading placeholders that were never replaced by real messages.
            // IMPORTANT: Never remove messages that have a real data-msg-id — those are actual
            // assistant responses (possibly partially streamed) and must be preserved.
            const tempPlaceholders = Array.from(chatContainer.querySelectorAll('.message.assistant[data-temporary="loading"]'));
            for (const m of tempPlaceholders) {
              try {
                m.remove();
              } catch (e) {
                // ignore
              }
            }
            // Recalculate latest assistant marker after removals
            markLatestAssistantMessage();
            saveChatState();

            // Append deferred footers for assistant messages that were placeholders
            try {
              const needers = chatContainer.querySelectorAll('.message.assistant[data-needs-footer]');
              needers.forEach(n => {
                try {
                  const content = n.dataset.raw || '';
                  const modelName = n.dataset.modelName || '';
                  appendFooterToMessage(n, content, modelName);
                } catch (e) {}
              });
            } catch (e) {}

            // Reset send button to Send with icon
            if (sendBtn) {
              sendBtn.innerHTML = SEND_ICON_SVG;
              sendBtn.dataset.state = 'send';
              sendBtn.classList.remove('streaming');
            }
          }
          break;
        // Dead handlers removed: toolStart, toolEnd, listFilesResult, diagnoseResult, 
        // runTestsStart, runTestsResult, findReferencesResult — these tools no longer show UI indicators
        case 'fileReadAction':
          // Support both old format (fields directly on message) and new format (fileAction object)
          if (message.fileAction) {
            showFileReadAction({
              ...message.fileAction,
              replyTo: message.id
            });
          } else {
            showFileReadAction(message);
          }
          break;
        case 'fileEditAction':
          if (message.fileAction) {
            showFileEditAction({
              ...message.fileAction,
              replyTo: message.id
            });
          }
          break;
        case 'fileCreateAction':
          if (message.fileAction) {
            showFileCreateAction({
              ...message.fileAction,
              replyTo: message.id
            });
          }
          break;
        case 'fileDeleteAction':
          if (message.fileAction) {
            showFileDeleteAction({
              ...message.fileAction,
              replyTo: message.id
            });
          }
          break;
        case 'webSearchStart':
          showWebSearchLoading(message.id, message.query);
          break;
        case 'webSearchResult':
          showWebSearchResult(message.id, message.success, message.query, message.results, message.resultsCount);
          break;
        case 'searchResult':
          showCodeSearchResult(message.id, message.success, message.query, message.mode, message.results, message.totalResults);
          break;
        case 'lspResult':
          showLspResult(message.id, message.success, message.operation, message.filePath, message.results, message.resultsCount);
          break;
        case 'terminalConfirm':
          showTerminalConfirmation(message.command, message.workingDir, message.id);
          break;
        case 'toolApproval':
          showToolApproval(message.toolName, message.args, message.id);
          break;
        case 'userQuestionRequest':
          showUserQuestion(message.question, message.options, message.id);
          break;
        case 'iterationConfirm':
          showIterationConfirmation();
          break;
        case 'terminalRunning':
          showTerminalRunning(message.id, message.command);
          break;
        case 'terminalResult':
          showTerminalResult(message.id, message.command, message.output, message.exitCode, message.success, message.rejected, message.error);
          break;
        case 'requireModelSelection':
          flashModelSelectorWarning();
          break;
        case 'updatePendingSnapshots':
          updatePendingDashboard(message.data);
          break;
        case 'summarizationStatus':
          handleSummarizationStatus(message.status);
          break;
      }
    });
    
    // Handle context summarization status
    function handleSummarizationStatus(status) {
      const overlay = document.getElementById('summarization-overlay');
      if (status === 'summarizing') {
        // Show overlay, disable input
        if (!overlay) {
          const newOverlay = document.createElement('div');
          newOverlay.id = 'summarization-overlay';
          newOverlay.className = 'summarization-overlay';
          newOverlay.innerHTML = `
            <div class="summarization-content">
              <span class="loader"></span>
              <span>Сжатие контекста...</span>
            </div>
          `;
          document.body.appendChild(newOverlay);
        } else {
          overlay.style.display = 'flex';
        }
        if (messageInput) {
          messageInput.disabled = true;
          messageInput.placeholder = 'Ожидание сжатия контекста...';
        }
        if (sendBtn) {
          sendBtn.disabled = true;
        }
      } else {
        // Hide overlay, enable input
        if (overlay) {
          overlay.style.display = 'none';
        }
        if (messageInput) {
          messageInput.disabled = false;
          messageInput.placeholder = 'Введите сообщение... (Shift+Enter для новой строки)';
        }
        if (sendBtn) {
          sendBtn.disabled = false;
        }
      }
    }
