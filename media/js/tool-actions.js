/* ================================================================
   TOOL-ACTIONS — визуальные индикаторы действий инструментов:
                 чтение/редактирование/создание/удаление файлов,
                 терминал, веб-поиск, поиск по коду
   ================================================================ */

    function showFileReadAction(data) {
      const { filePath, startLine, endLine, totalLines, truncated, success, error, replyTo } = data;
      
      // Find the message to attach to (use replyTo which is the assistant placeholder id)
      let targetMsg = null;
      if (replyTo) {
        targetMsg = chatContainer.querySelector(`.message.assistant[data-msg-id="${replyTo}"]`);
      }
      if (!targetMsg) {
        // Fall back to last assistant message
        const assistants = chatContainer.querySelectorAll('.message.assistant');
        targetMsg = assistants.length > 0 ? assistants[assistants.length - 1] : null;
      }
      if (!targetMsg) return;
      
      // NEW ARCHITECTURE: Insert action into message-content, create new segment after
      const messageContent = targetMsg.querySelector('.message-content');
      if (!messageContent) return;
      
      // Create the action element
      const actionEl = document.createElement('div');
      // On error, show "correcting" state (model will retry)
      actionEl.className = 'file-read-action ' + (success ? 'success' : 'correcting');
      actionEl.dataset.filePath = filePath || '';
      
      // Get filename from path
      const fileName = filePath ? filePath.split(/[\\/]/).pop() : 'Unknown file';
      
      // Get file icon
      let iconHtml = '';
      if (window.__ICONS_URI && fileName) {
        const iconName = getFileIcon(fileName);
        iconHtml = `<img src="${window.__ICONS_URI}/${iconName}" class="file-icon" />`;
      } else {
        iconHtml = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.71 4.29l-3-3L10 1H4L3 2v12l1 1h9l1-1V5l-.29-.71zM10 5V2.41L12.59 5H10z"/></svg>`;
      }
      
      // Status icon and line info
      let statusHtml = '';
      if (success) {
        let lineInfoText = '';
        if (totalLines > 0) {
          if (truncated) {
            lineInfoText = `строки ${startLine || 1}-${endLine || 0} из ${totalLines}`;
          } else if ((startLine || 1) === 1 && (endLine || 0) >= totalLines) {
            lineInfoText = `${totalLines} строк`;
          } else {
            lineInfoText = `строки ${startLine || 1}-${endLine || 0}`;
          }
        }
        statusHtml = `
          <span class="status-icon success">
            <span class="codicon codicon-check-all"></span>
          </span>
          <div class="file-chip" data-path="${escapeHtml(filePath || '')}">
            ${iconHtml}
            <span>${escapeHtml(fileName)}</span>
          </div>
          <span class="line-info">${lineInfoText}</span>
        `;
      } else {
        statusHtml = `
          <span class="status-icon correcting">
            <span class="tool-spinner"></span>
          </span>
          <div class="file-chip" data-path="${escapeHtml(filePath || '')}">
            ${iconHtml}
            <span>${escapeHtml(fileName)}</span>
          </div>
          <span class="line-info correcting-text">Корректировка запроса...</span>
        `;
      }
      
      actionEl.innerHTML = statusHtml;
      
      // Add click handler to open file in editor
      const fileChip = actionEl.querySelector('.file-chip');
      if (fileChip && filePath) {
        fileChip.addEventListener('click', () => {
          vscode.postMessage({ type: 'openFile', filePath: filePath });
        });
      }
      
      // Append action to message-content
      messageContent.appendChild(actionEl);
      
      // Create new empty segment for content that comes after this action
      const segments = messageContent.querySelectorAll('.content-segment');
      const newSegmentIdx = segments.length;
      const newSegment = document.createElement('div');
      newSegment.className = 'content-segment';
      newSegment.dataset.segmentIdx = String(newSegmentIdx);
      newSegment.dataset.raw = '';
      messageContent.appendChild(newSegment);
      
      scrollToBottom();
    }

    // Show file edit action indicator
    function showFileEditAction(data) {
      const { filePath, success, error, replyTo, linesAdded, linesRemoved, startLine } = data;
      
      let targetMsg = null;
      if (replyTo) {
        targetMsg = chatContainer.querySelector(`.message.assistant[data-msg-id="${replyTo}"]`);
      }
      if (!targetMsg) {
        const assistants = chatContainer.querySelectorAll('.message.assistant');
        targetMsg = assistants.length > 0 ? assistants[assistants.length - 1] : null;
      }
      if (!targetMsg) return;
      
      const messageContent = targetMsg.querySelector('.message-content');
      if (!messageContent) return;
      
      const fileName = filePath ? filePath.split(/[\\/]/).pop() : 'Unknown file';
      
      // If success, check if there's a pending "correcting" indicator for this file and replace it
      if (success) {
        removePendingCorrectings(messageContent, filePath);
      }
      
      const actionEl = document.createElement('div');
      // On error, show "correcting" state instead of error — model will retry
      actionEl.className = 'file-edit-action ' + (success ? 'success' : 'correcting');
      actionEl.dataset.filePath = filePath || '';
      
      let iconHtml = '';
      if (window.__ICONS_URI && fileName) {
        const iconName = getFileIcon(fileName);
        iconHtml = `<img src="${window.__ICONS_URI}/${iconName}" class="file-icon" />`;
      } else {
        iconHtml = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.71 4.29l-3-3L10 1H4L3 2v12l1 1h9l1-1V5l-.29-.71zM10 5V2.41L12.59 5H10z"/></svg>`;
      }
      
      let statusHtml = '';
      if (success) {
        const added = linesAdded || 0;
        const removed = linesRemoved || 0;
        statusHtml = `
          <span class="status-icon success">
            <span class="codicon codicon-edit"></span>
          </span>
          <div class="file-chip" data-path="${escapeHtml(filePath || '')}">
            ${iconHtml}
            <span>${escapeHtml(fileName)}</span>
          </div>
          <span class="line-info"><span class="added">+${added}</span> | <span class="removed">-${removed}</span></span>
        `;
      } else {
        statusHtml = `
          <span class="status-icon correcting">
            <span class="tool-spinner"></span>
          </span>
          <div class="file-chip" data-path="${escapeHtml(filePath || '')}">
            ${iconHtml}
            <span>${escapeHtml(fileName)}</span>
          </div>
          <span class="line-info correcting-text">Корректировка запроса...</span>
        `;
      }
      
      actionEl.innerHTML = statusHtml;
      
      // Add click handler to open file in editor
      const fileChip = actionEl.querySelector('.file-chip');
      if (fileChip && filePath) {
        fileChip.addEventListener('click', () => {
          vscode.postMessage({ type: 'openFile', filePath: filePath, line: startLine });
        });
      }
      
      messageContent.appendChild(actionEl);
      
      const segments = messageContent.querySelectorAll('.content-segment');
      const newSegmentIdx = segments.length;
      const newSegment = document.createElement('div');
      newSegment.className = 'content-segment';
      newSegment.dataset.segmentIdx = String(newSegmentIdx);
      newSegment.dataset.raw = '';
      messageContent.appendChild(newSegment);
      
      scrollToBottom();
    }

    // Show file create action indicator
    function showFileCreateAction(data) {
      const { filePath, success, error, replyTo } = data;
      
      let targetMsg = null;
      if (replyTo) {
        targetMsg = chatContainer.querySelector(`.message.assistant[data-msg-id="${replyTo}"]`);
      }
      if (!targetMsg) {
        const assistants = chatContainer.querySelectorAll('.message.assistant');
        targetMsg = assistants.length > 0 ? assistants[assistants.length - 1] : null;
      }
      if (!targetMsg) return;
      
      const messageContent = targetMsg.querySelector('.message-content');
      if (!messageContent) return;
      
      const fileName = filePath ? filePath.split(/[\\/]/).pop() : 'Unknown file';
      
      // If success, remove pending "correcting" indicator for this file
      if (success) {
        removePendingCorrectings(messageContent, filePath);
      }
      
      const actionEl = document.createElement('div');
      actionEl.className = 'file-create-action ' + (success ? 'success' : 'correcting');
      actionEl.dataset.filePath = filePath || '';
      
      let iconHtml = '';
      if (window.__ICONS_URI && fileName) {
        const iconName = getFileIcon(fileName);
        iconHtml = `<img src="${window.__ICONS_URI}/${iconName}" class="file-icon" />`;
      } else {
        iconHtml = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.71 4.29l-3-3L10 1H4L3 2v12l1 1h9l1-1V5l-.29-.71zM10 5V2.41L12.59 5H10z"/></svg>`;
      }
      
      let statusHtml = '';
      if (success) {
        statusHtml = `
          <span class="status-icon success">
            <span class="codicon codicon-new-file"></span>
          </span>
          <div class="file-chip" data-path="${escapeHtml(filePath || '')}">
            ${iconHtml}
            <span>${escapeHtml(fileName)}</span>
          </div>
          <span class="line-info">Создан</span>
        `;
      } else {
        statusHtml = `
          <span class="status-icon correcting">
            <span class="tool-spinner"></span>
          </span>
          <div class="file-chip" data-path="${escapeHtml(filePath || '')}">
            ${iconHtml}
            <span>${escapeHtml(fileName)}</span>
          </div>
          <span class="line-info correcting-text">Корректировка запроса...</span>
        `;
      }
      
      actionEl.innerHTML = statusHtml;
      
      // Add click handler to open file in editor
      const fileChip = actionEl.querySelector('.file-chip');
      if (fileChip && filePath) {
        fileChip.addEventListener('click', () => {
          vscode.postMessage({ type: 'openFile', filePath: filePath });
        });
      }
      
      messageContent.appendChild(actionEl);
      
      const segments = messageContent.querySelectorAll('.content-segment');
      const newSegmentIdx = segments.length;
      const newSegment = document.createElement('div');
      newSegment.className = 'content-segment';
      newSegment.dataset.segmentIdx = String(newSegmentIdx);
      newSegment.dataset.raw = '';
      messageContent.appendChild(newSegment);
      
      scrollToBottom();
    }

    // Show file delete action indicator
    function showFileDeleteAction(data) {
      const { filePath, success, error, replyTo } = data;
      
      let targetMsg = null;
      if (replyTo) {
        targetMsg = chatContainer.querySelector(`.message.assistant[data-msg-id="${replyTo}"]`);
      }
      if (!targetMsg) {
        const assistants = chatContainer.querySelectorAll('.message.assistant');
        targetMsg = assistants.length > 0 ? assistants[assistants.length - 1] : null;
      }
      if (!targetMsg) return;
      
      const messageContent = targetMsg.querySelector('.message-content');
      if (!messageContent) return;
      
      const fileName = filePath ? filePath.split(/[\\/]/).pop() : 'Unknown file';
      
      // If success, remove pending "correcting" indicator for this file
      if (success) {
        removePendingCorrectings(messageContent, filePath);
      }
      
      const actionEl = document.createElement('div');
      actionEl.className = 'file-delete-action ' + (success ? 'success' : 'correcting');
      actionEl.dataset.filePath = filePath || '';
      
      let statusHtml = '';
      if (success) {
        statusHtml = `
          <span class="status-icon success">
            <span class="codicon codicon-trash"></span>
          </span>
          <div class="file-chip deleted">
            <span class="codicon codicon-file"></span>
            <span>${escapeHtml(fileName)}</span>
          </div>
          <span class="line-info">Удалён</span>
        `;
      } else {
        statusHtml = `
          <span class="status-icon correcting">
            <span class="tool-spinner"></span>
          </span>
          <div class="file-chip">
            <span class="codicon codicon-file"></span>
            <span>${escapeHtml(fileName)}</span>
          </div>
          <span class="line-info correcting-text">Корректировка запроса...</span>
        `;
      }
      
      actionEl.innerHTML = statusHtml;
      
      messageContent.appendChild(actionEl);
      
      const segments = messageContent.querySelectorAll('.content-segment');
      const newSegmentIdx = segments.length;
      const newSegment = document.createElement('div');
      newSegment.className = 'content-segment';
      newSegment.dataset.segmentIdx = String(newSegmentIdx);
      newSegment.dataset.raw = '';
      messageContent.appendChild(newSegment);
      
      scrollToBottom();
    }

    // Show terminal confirmation dialog in chat (inline, like VS Code)
    function showTerminalConfirmation(command, workingDir, replyTo) {
      // Remove any existing confirmation dialog
      const existing = document.querySelector('.terminal-confirm-inline');
      if (existing) existing.remove();
      
      // Find target message to append to
      let targetMsg = null;
      if (replyTo) {
        targetMsg = chatContainer.querySelector(`.message.assistant[data-msg-id="${replyTo}"]`);
      }
      if (!targetMsg) {
        // Fall back to last assistant message
        const assistants = chatContainer.querySelectorAll('.message.assistant');
        targetMsg = assistants.length > 0 ? assistants[assistants.length - 1] : null;
      }
      if (!targetMsg) {
        // Fallback: create in chat container directly
        targetMsg = chatContainer;
      }
      
      const messageContent = targetMsg.querySelector('.message-content') || targetMsg;
      
      const actionEl = document.createElement('div');
      actionEl.className = 'terminal-confirm-inline';
      
      actionEl.innerHTML = `
        <div class="terminal-confirm-box">
          <div class="terminal-confirm-label">
            <span class="codicon codicon-terminal"></span>
            Выполнить команду?
          </div>
          <div class="terminal-confirm-command">
            <textarea class="terminal-command-input" id="terminal-command-input" rows="1">${escapeHtml(command)}</textarea>
          </div>
          <div class="terminal-confirm-actions">
            <button class="terminal-confirm-btn allow" id="terminal-confirm-yes">
              Разрешить
            </button>
            <button class="terminal-confirm-btn deny" id="terminal-confirm-no">
              Пропустить
            </button>
          </div>
        </div>
      `;
      
      messageContent.appendChild(actionEl);
      
      const commandInput = actionEl.querySelector('#terminal-command-input');
      
      // Auto-resize textarea to fit content
      function autoResize() {
        commandInput.style.height = 'auto';
        commandInput.style.height = commandInput.scrollHeight + 'px';
      }
      autoResize();
      commandInput.addEventListener('input', autoResize);
      
      // Add event handlers
      actionEl.querySelector('#terminal-confirm-yes').addEventListener('click', () => {
        const editedCommand = commandInput.value.trim();
        vscode.postMessage({ type: 'terminalConfirmResponse', confirmed: true, command: editedCommand });
        
        // Immediately show loading state with detach button
        actionEl.innerHTML = `
          <div class="terminal-running-inline">
            <span class="loader small"></span>
            <span class="terminal-running-text">Выполняется "${escapeHtml(editedCommand.length > 40 ? editedCommand.slice(0, 40) + '...' : editedCommand)}"</span>
            <button class="terminal-confirm-btn detach terminal-detach-btn" style="margin-left: 8px;">Продолжить без ожидания</button>
          </div>
        `;
        
        actionEl.querySelector('.terminal-detach-btn').addEventListener('click', () => {
          vscode.postMessage({ type: 'terminalDetach' });
          actionEl.innerHTML = `
            <div class="terminal-running-inline">
              <span>⏩</span>
              <span class="terminal-running-text">Отсоединено — команда продолжает выполняться</span>
            </div>
          `;
        });
      });
      
      actionEl.querySelector('#terminal-confirm-no').addEventListener('click', () => {
        vscode.postMessage({ type: 'terminalConfirmResponse', confirmed: false });
        // Replace with rejected state
        actionEl.innerHTML = `
          <div class="terminal-confirm-box rejected">
            <div class="terminal-confirm-label rejected">
              <span class="codicon codicon-circle-slash"></span>
              Команда отклонена
            </div>
            <div class="terminal-confirm-command rejected">
              <span class="terminal-command-text">${escapeHtml(command)}</span>
            </div>
          </div>
        `;
      });
      
      scrollToBottom();
    }

    // Show tool approval dialog in chat mode (inline)
    function showToolApproval(toolName, args, replyTo) {
      // Remove any existing approval dialog
      const existing = document.querySelector('.tool-approval-inline');
      if (existing) existing.remove();

      // Find target message
      let targetMsg = null;
      if (replyTo) {
        targetMsg = chatContainer.querySelector(`.message.assistant[data-msg-id="${replyTo}"]`);
      }
      if (!targetMsg) {
        const assistants = chatContainer.querySelectorAll('.message.assistant');
        targetMsg = assistants.length > 0 ? assistants[assistants.length - 1] : null;
      }
      if (!targetMsg) targetMsg = chatContainer;

      const messageContent = targetMsg.querySelector('.message-content') || targetMsg;

      // Build description based on tool
      let description = toolName;
      if (toolName === 'read_file' && args && args.file_path) {
        description = args.file_path;
      } else if (toolName === 'search' && args && args.query) {
        description = `"${args.query}"`;
      } else if (toolName === 'web_search' && args && args.query) {
        description = `"${args.query}"`;
      } else if (toolName === 'list_files' && args && args.path) {
        description = args.path;
      } else if (toolName === 'diagnose' && args && args.file_path) {
        description = args.file_path;
      } else if (toolName === 'fetch_url' && args && args.url) {
        description = args.url;
      } else if (toolName === 'lsp' && args) {
        const opLabels = { definitions: 'Определение', references: 'Ссылки', hover: 'Информация', symbols: 'Символы', type_definition: 'Тип', implementations: 'Реализации', rename_preview: 'Превью переименования' };
        description = (opLabels[args.operation] || args.operation || 'lsp') + ': ' + (args.file_path || '');
      }

      const toolLabels = {
        'read_file': 'Прочитать файл',
        'list_files': 'Список файлов',
        'search': 'Поиск',
        'web_search': 'Веб-поиск',
        'diagnose': 'Диагностика',
        'fetch_url': 'Загрузить URL',
        'lsp': 'LSP Запрос'
      };
      const label = toolLabels[toolName] || toolName;

      const actionEl = document.createElement('div');
      actionEl.className = 'tool-approval-inline';
      actionEl.innerHTML = `
        <div class="terminal-confirm-box">
          <div class="terminal-confirm-label">
            <span class="codicon codicon-search"></span>
            ${escapeHtml(label)}: <code>${escapeHtml(description)}</code>
          </div>
          <div class="terminal-confirm-actions">
            <button class="terminal-confirm-btn allow" id="tool-approve-yes">Разрешить</button>
            <button class="terminal-confirm-btn deny" id="tool-approve-no">Отклонить</button>
          </div>
        </div>
      `;
      messageContent.appendChild(actionEl);

      actionEl.querySelector('#tool-approve-yes').addEventListener('click', () => {
        vscode.postMessage({ type: 'toolApprovalResponse', confirmed: true });
        actionEl.innerHTML = `
          <div class="terminal-confirm-box" style="opacity:0.6;">
            <div class="terminal-confirm-label">
              <span class="codicon codicon-check"></span>
              ${escapeHtml(label)}: <code>${escapeHtml(description)}</code> — разрешено
            </div>
          </div>
        `;
      });

      actionEl.querySelector('#tool-approve-no').addEventListener('click', () => {
        vscode.postMessage({ type: 'toolApprovalResponse', confirmed: false });
        actionEl.innerHTML = `
          <div class="terminal-confirm-box rejected">
            <div class="terminal-confirm-label rejected">
              <span class="codicon codicon-circle-slash"></span>
              ${escapeHtml(label)}: <code>${escapeHtml(description)}</code> — отклонено
            </div>
          </div>
        `;
      });

      scrollToBottom();
    }

    // Show terminal running state (loading)
    function showTerminalRunning(replyTo, command) {
      let targetMsg = null;
      if (replyTo) {
        targetMsg = chatContainer.querySelector(`.message.assistant[data-msg-id="${replyTo}"]`);
      }
      if (!targetMsg) {
        const assistants = chatContainer.querySelectorAll('.message.assistant');
        targetMsg = assistants.length > 0 ? assistants[assistants.length - 1] : null;
      }
      if (!targetMsg) return;
      
      const messageContent = targetMsg.querySelector('.message-content');
      if (!messageContent) return;
      
      // Remove confirmation dialog if present (it already has its own running state)
      const confirmDialog = document.getElementById('terminal-confirm-container');
      if (confirmDialog) confirmDialog.remove();
      
      // If confirmation inline already shows running state, don't duplicate
      const existingRunning = messageContent.querySelector('.terminal-running-inline');
      if (existingRunning) return;
      
      const actionEl = document.createElement('div');
      actionEl.className = 'terminal-action loading';
      actionEl.dataset.command = command;
      
      actionEl.innerHTML = `
        <div class="terminal-header">
          <span class="status-icon loading">
            <span class="loader small"></span>
          </span>
          <span class="terminal-title">Выполняется команда...</span>
        </div>
        <div class="terminal-command-preview">
          <code>${escapeHtml(command.length > 60 ? command.slice(0, 60) + '...' : command)}</code>
        </div>
        <div class="terminal-detach-actions">
          <button class="terminal-confirm-btn detach terminal-detach-btn">Продолжить без ожидания</button>
        </div>
      `;
      
      actionEl.querySelector('.terminal-detach-btn').addEventListener('click', () => {
        vscode.postMessage({ type: 'terminalDetach' });
        actionEl.innerHTML = `
          <div class="terminal-header">
            <span class="status-icon detached">⏩</span>
            <span class="terminal-title">Отсоединено от терминала</span>
          </div>
          <div class="terminal-command-preview">
            <code>${escapeHtml(command.length > 60 ? command.slice(0, 60) + '...' : command)}</code>
          </div>
        `;
      });
      
      messageContent.appendChild(actionEl);
      scrollToBottom();
    }

    // Show terminal result as simple text (icon + command + status)
    function showTerminalResult(replyTo, command, output, exitCode, success, rejected, error) {
      let targetMsg = null;
      if (replyTo) {
        targetMsg = chatContainer.querySelector(`.message.assistant[data-msg-id="${replyTo}"]`);
      }
      if (!targetMsg) {
        const assistants = chatContainer.querySelectorAll('.message.assistant');
        targetMsg = assistants.length > 0 ? assistants[assistants.length - 1] : null;
      }
      if (!targetMsg) return;
      
      const messageContent = targetMsg.querySelector('.message-content');
      if (!messageContent) return;
      
      // Remove confirmation dialog if present (may have loading state inside)
      const confirmDialog = document.querySelector('.terminal-confirm-inline');
      if (confirmDialog) confirmDialog.remove();
      
      // Remove loading state if present (old style)
      const loadingEl = messageContent.querySelector('.terminal-action.loading');
      if (loadingEl) loadingEl.remove();
      
      // Remove inline running state if present (new style)
      const runningEl = messageContent.querySelector('.terminal-running-inline');
      if (runningEl) {
        // Get parent to remove (the container)
        if (runningEl.parentElement && runningEl.parentElement.classList.contains('terminal-confirm-inline')) {
          runningEl.parentElement.remove();
        } else {
          runningEl.remove();
        }
      }
      
      const actionEl = document.createElement('div');
      
      // Truncate command for display
      const displayCmd = command && command.length > 50 ? command.slice(0, 50) + '...' : (command || '');
      
      if (rejected) {
        // Command was rejected by user
        actionEl.className = 'terminal-result-inline rejected';
        actionEl.innerHTML = `
          <span class="codicon codicon-circle-slash"></span>
          <span class="terminal-result-text">"${escapeHtml(displayCmd)}" отклонена</span>
        `;
      } else if (!success || error) {
        // Command failed
        actionEl.className = 'terminal-result-inline error';
        actionEl.innerHTML = `
          <span class="codicon codicon-error"></span>
          <span class="terminal-result-text">"${escapeHtml(displayCmd)}" error (${exitCode ?? '?'})</span>
        `;
      } else {
        // Command succeeded
        actionEl.className = 'terminal-result-inline success';
        actionEl.innerHTML = `
          <span class="codicon codicon-terminal"></span>
          <span class="terminal-result-text">"${escapeHtml(displayCmd)}" completed</span>
        `;
      }
      
      messageContent.appendChild(actionEl);
      
      // Add new segment for continuing content
      const segments = messageContent.querySelectorAll('.content-segment');
      const newSegmentIdx = segments.length;
      const newSegment = document.createElement('div');
      newSegment.className = 'content-segment';
      newSegment.dataset.segmentIdx = String(newSegmentIdx);
      newSegment.dataset.raw = '';
      messageContent.appendChild(newSegment);
      
      scrollToBottom();
    }

    // ============ WEB SEARCH UI ============
    function showWebSearchLoading(replyTo, query) {
      let targetMsg = null;
      if (replyTo) {
        targetMsg = chatContainer.querySelector(`.message.assistant[data-msg-id="${replyTo}"]`);
      }
      if (!targetMsg) {
        const assistants = chatContainer.querySelectorAll('.message.assistant');
        targetMsg = assistants.length > 0 ? assistants[assistants.length - 1] : null;
      }
      if (!targetMsg) return;

      const messageContent = targetMsg.querySelector('.message-content');
      if (!messageContent) return;

      const actionEl = document.createElement('div');
      actionEl.className = 'web-search-action loading';
      actionEl.dataset.searchQuery = query || '';
      actionEl.innerHTML = `
        <div class="web-search-loading">
          <div class="web-search-spinner"></div>
          <span class="web-search-text">Ищу: "${escapeHtml(query || '')}"...</span>
        </div>
      `;
      messageContent.appendChild(actionEl);
      scrollToBottom();
    }

    function showWebSearchResult(replyTo, success, query, results, resultsCount) {
      let targetMsg = null;
      if (replyTo) {
        targetMsg = chatContainer.querySelector(`.message.assistant[data-msg-id="${replyTo}"]`);
      }
      if (!targetMsg) {
        const assistants = chatContainer.querySelectorAll('.message.assistant');
        targetMsg = assistants.length > 0 ? assistants[assistants.length - 1] : null;
      }
      if (!targetMsg) return;

      const messageContent = targetMsg.querySelector('.message-content');
      if (!messageContent) return;

      // Remove loading indicator
      const loadingEl = messageContent.querySelector('.web-search-action.loading');
      if (loadingEl) loadingEl.remove();

      const actionEl = document.createElement('div');
      actionEl.className = 'web-search-action ' + (success ? 'success' : 'error');

      if (!success || !results || results.length === 0) {
        actionEl.innerHTML = `
          <div class="web-search-header">
            <span class="status-icon error">
              <span class="codicon codicon-globe"></span>
            </span>
            <span class="web-search-title">Поиск: "${escapeHtml(query)}"</span>
            <span class="web-search-count">0</span>
          </div>
        `;
      } else {
        let resultsHtml = '<div class="web-search-results">';
        for (const r of results) {
          const title = escapeHtml(r.title || 'No title');
          const url = escapeHtml(r.url || '');
          const content = escapeHtml((r.content || '').substring(0, 120));
          resultsHtml += `
            <div class="web-search-result-item" data-url="${url}">
              <span class="codicon codicon-globe"></span>
              <span class="result-file">${title}</span>
              <span class="result-preview">${content}</span>
            </div>
          `;
        }
        resultsHtml += '</div>';

        actionEl.innerHTML = `
          <button class="web-search-header accordion-toggle">
            <span class="status-icon success">
              <span class="codicon codicon-globe"></span>
            </span>
            <span class="web-search-title">Поиск: "${escapeHtml(query)}"</span>
            <span class="web-search-count">${resultsCount || results.length}</span>
            <span class="accordion-icon">
              <span class="codicon codicon-chevron-down"></span>
            </span>
          </button>
          <div class="web-search-content collapsed">
            ${resultsHtml}
          </div>
        `;

        const header = actionEl.querySelector('.accordion-toggle');
        const content = actionEl.querySelector('.web-search-content');
        const icon = actionEl.querySelector('.accordion-icon');
        if (header && content) {
          header.addEventListener('click', () => {
            content.classList.toggle('collapsed');
            if (icon) icon.classList.toggle('rotated');
          });
        }

        // Click on result opens URL in browser
        actionEl.querySelectorAll('.web-search-result-item').forEach(item => {
          item.addEventListener('click', () => {
            const url = item.dataset.url;
            if (url) vscode.postMessage({ type: 'openExternal', url });
          });
        });
      }

      messageContent.appendChild(actionEl);

      const segments = messageContent.querySelectorAll('.content-segment');
      const newSegmentIdx = segments.length;
      const newSegment = document.createElement('div');
      newSegment.className = 'content-segment';
      newSegment.dataset.segmentIdx = String(newSegmentIdx);
      newSegment.dataset.raw = '';
      messageContent.appendChild(newSegment);

      scrollToBottom();
    }

    // Show code search result as accordion (different style from web search)
    function showCodeSearchResult(replyTo, success, query, mode, results, totalResults) {
      let targetMsg = null;
      if (replyTo) {
        targetMsg = chatContainer.querySelector(`.message.assistant[data-msg-id="${replyTo}"]`);
      }
      if (!targetMsg) {
        const assistants = chatContainer.querySelectorAll('.message.assistant');
        targetMsg = assistants.length > 0 ? assistants[assistants.length - 1] : null;
      }
      if (!targetMsg) return;
      
      const messageContent = targetMsg.querySelector('.message-content');
      if (!messageContent) return;
      
      const actionEl = document.createElement('div');
      actionEl.className = 'code-search-action ' + (success ? 'success' : 'error');
      
      if (!success || !results || results.length === 0) {
        actionEl.innerHTML = `
          <div class="code-search-header">
            <span class="status-icon error">
              <span class="codicon codicon-search"></span>
            </span>
            <span class="code-search-title">Поиск: "${escapeHtml(query)}"</span>
            <span class="code-search-count">0</span>
          </div>
        `;
      } else {
        // Build results list
        let resultsHtml = '<div class="code-search-results">';
        for (const r of results) {
          const file = r.file || '';
          const line = r.line || 1;
          const preview = escapeHtml(r.preview || '').substring(0, 80);
          const fileName = file.split(/[\\/]/).pop();
          
          resultsHtml += `
            <div class="code-search-result-item" data-file="${escapeHtml(file)}" data-line="${line}">
              <span class="codicon codicon-file-code"></span>
              <span class="result-file">${escapeHtml(fileName)}</span>
              <span class="result-line">:${line}</span>
              <span class="result-preview">${preview}</span>
            </div>
          `;
        }
        resultsHtml += '</div>';
        
        actionEl.innerHTML = `
          <button class="code-search-header accordion-toggle">
            <span class="status-icon success">
              <span class="codicon codicon-search"></span>
            </span>
            <span class="code-search-title">Поиск: "${escapeHtml(query)}"</span>
            <span class="code-search-count">${totalResults}</span>
            <span class="accordion-icon">
              <span class="codicon codicon-chevron-down"></span>
            </span>
          </button>
          <div class="code-search-content collapsed">
            ${resultsHtml}
          </div>
        `;
        
        // Add accordion toggle handler
        const header = actionEl.querySelector('.accordion-toggle');
        const content = actionEl.querySelector('.code-search-content');
        const icon = actionEl.querySelector('.accordion-icon');
        
        if (header && content) {
          header.addEventListener('click', () => {
            content.classList.toggle('collapsed');
            if (icon) icon.classList.toggle('rotated');
          });
        }
        
        // Add click handlers to open files
        actionEl.querySelectorAll('.code-search-result-item').forEach(item => {
          item.addEventListener('click', () => {
            const file = item.dataset.file;
            const line = parseInt(item.dataset.line) || 1;
            vscode.postMessage({ type: 'openFile', filePath: file, line });
          });
        });
      }
      
      messageContent.appendChild(actionEl);
      
      const segments = messageContent.querySelectorAll('.content-segment');
      const newSegmentIdx = segments.length;
      const newSegment = document.createElement('div');
      newSegment.className = 'content-segment';
      newSegment.dataset.segmentIdx = String(newSegmentIdx);
      newSegment.dataset.raw = '';
      messageContent.appendChild(newSegment);
      
      scrollToBottom();
    }

    // ============ LSP BRIDGE UI ============
    function showLspResult(replyTo, success, operation, filePath, resultsText, resultsCount) {
      let targetMsg = null;
      if (replyTo) {
        targetMsg = chatContainer.querySelector(`.message.assistant[data-msg-id="${replyTo}"]`);
      }
      if (!targetMsg) {
        const assistants = chatContainer.querySelectorAll('.message.assistant');
        targetMsg = assistants.length > 0 ? assistants[assistants.length - 1] : null;
      }
      if (!targetMsg) return;
      
      const messageContent = targetMsg.querySelector('.message-content');
      if (!messageContent) return;
      
      const actionEl = document.createElement('div');
      actionEl.className = 'lsp-action ' + (success ? 'success' : 'error');

      const operationLabels = {
        'definitions': 'Определение',
        'references': 'Ссылки',
        'hover': 'Информация',
        'symbols': 'Символы',
        'type_definition': 'Тип',
        'implementations': 'Реализации',
        'rename_preview': 'Превью переименования'
      };
      const label = operationLabels[operation] || operation;
      const fileName = filePath ? filePath.split(/[\\/]/).pop() : '';

      if (!success || resultsCount === 0) {
        actionEl.innerHTML = `
          <div class="lsp-header">
            <span class="status-icon error">
              <span class="codicon codicon-symbol-reference"></span>
            </span>
            <span class="lsp-title">${escapeHtml(label)}: ${escapeHtml(fileName)}</span>
            <span class="lsp-count">0</span>
          </div>
        `;
      } else {
        // Parse results into lines for display
        const resultLines = (resultsText || '').split('\n').filter(l => l.trim());
        let resultsHtml = '<div class="lsp-results">';
        
        for (const line of resultLines) {
          // Try to parse file:line:col — make it clickable
          const fileMatch = line.match(/^(.+?):(\d+):(\d+)$/);
          if (fileMatch) {
            const [, file, lineNum] = fileMatch;
            const fName = file.split(/[\\/]/).pop();
            resultsHtml += `
              <div class="lsp-result-item" data-file="${escapeHtml(file)}" data-line="${lineNum}">
                <span class="codicon codicon-symbol-reference"></span>
                <span class="result-file">${escapeHtml(fName)}</span>
                <span class="result-line">:${lineNum}</span>
              </div>
            `;
          } else {
            resultsHtml += `<div style="padding: 1px 6px;">${escapeHtml(line)}</div>`;
          }
        }
        resultsHtml += '</div>';

        actionEl.innerHTML = `
          <button class="lsp-header accordion-toggle">
            <span class="status-icon success">
              <span class="codicon codicon-symbol-reference"></span>
            </span>
            <span class="lsp-title">${escapeHtml(label)}: ${escapeHtml(fileName)}</span>
            <span class="lsp-count">${resultsCount}</span>
            <span class="accordion-icon">
              <span class="codicon codicon-chevron-down"></span>
            </span>
          </button>
          <div class="lsp-content collapsed">
            ${resultsHtml}
          </div>
        `;
        
        // Accordion toggle
        const header = actionEl.querySelector('.accordion-toggle');
        const content = actionEl.querySelector('.lsp-content');
        const icon = actionEl.querySelector('.accordion-icon');
        
        if (header && content) {
          header.addEventListener('click', () => {
            content.classList.toggle('collapsed');
            if (icon) icon.classList.toggle('rotated');
          });
        }
        
        // Click to open files
        actionEl.querySelectorAll('.lsp-result-item').forEach(item => {
          item.addEventListener('click', () => {
            const file = item.dataset.file;
            const line = parseInt(item.dataset.line) || 1;
            vscode.postMessage({ type: 'openFile', filePath: file, line });
          });
        });
      }
      
      messageContent.appendChild(actionEl);
      
      // Add new content segment after action
      const lspSegments = messageContent.querySelectorAll('.content-segment');
      const lspSegIdx = lspSegments.length;
      const lspNewSeg = document.createElement('div');
      lspNewSeg.className = 'content-segment';
      lspNewSeg.dataset.segmentIdx = String(lspSegIdx);
      lspNewSeg.dataset.raw = '';
      messageContent.appendChild(lspNewSeg);
      
      scrollToBottom();
    }
