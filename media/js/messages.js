/* ================================================================
   MESSAGES — создание и обновление сообщений в чате:
              addMessage, createContentSegment, createFileActionElement,
              createToolActionElement, appendFooterToMessage,
              updateLastAssistantMessage, scrollToBottom,
              removePendingCorrectings
   ================================================================ */

    // options: { id, replyTo, attachedFiles }
    function addMessage(role, content, reasoning, options = {}) {
      // Debug logging for modelName
      if (role === 'assistant') {
        dbg('[addMessage] options.modelName:', options.modelName, 'role:', role);
      }
      
      // Hide welcome screen when first message is added
      const welcomeScreen = document.getElementById('welcome-screen');
      if (welcomeScreen) {
        welcomeScreen.style.display = 'none';
      }
      
      // Ensure msgId is available in this function scope
      const msgId = options.id || generateId();
      // If this is an assistant message and there is a temporary loading placeholder, reuse it
      let msgDiv;
      let reusingPlaceholder = false;
      if (role === 'assistant' && options.id) {
        const temp = chatContainer.querySelector('.message.assistant[data-temporary="loading"]');
        if (temp) {
          msgDiv = temp;
          reusingPlaceholder = true;
          // assign id and replyTo
          delete msgDiv.dataset.temporary;
          msgDiv.dataset.msgId = msgId;
          if (options.replyTo) msgDiv.dataset.replyTo = options.replyTo;
          // Always clear children when reusing - we'll rebuild structure
          while (msgDiv.firstChild) msgDiv.removeChild(msgDiv.firstChild);
          // proceed to update content below
        }
      }
      if (!msgDiv) {
        msgDiv = document.createElement('div');
        msgDiv.className = 'message ' + role;
        msgDiv.dataset.msgId = msgId;
        if (options.replyTo) msgDiv.dataset.replyTo = options.replyTo;
      }
      
      if (role === 'assistant') {
        // Add reasoning indicator FIRST if present (simple "Thinking" with icon)
        if (reasoning) {
          const reasoningBlock = document.createElement('div');
          reasoningBlock.className = 'reasoning-indicator completed';
          reasoningBlock.innerHTML = `
            <svg class="reasoning-check-icon" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 111.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/>
            </svg>
            <span class="reasoning-label">Thinking</span>
          `;
          msgDiv.appendChild(reasoningBlock);
        }
      }
      
      // Store raw content for persistence
      msgDiv.dataset.raw = content || '';
      // Store model name for footer
      if (options.modelName) {
        msgDiv.dataset.modelName = options.modelName;
      }
      // If there's an attachment, render it visually but DO NOT include binary in the text
      const attachment = options.attachment;
      if (attachment && attachment.data) {
        // Render image preview before the message bubble
        const imgWrap = document.createElement('div');
        imgWrap.className = 'message-attachment';
        const img = document.createElement('img');
        img.src = attachment.data;
        img.alt = attachment.name || 'image';
        img.className = 'attachment-img';
        imgWrap.appendChild(img);
        msgDiv.appendChild(imgWrap);
      }
      msgDiv.dataset.reasoning = reasoning || '';

      if (role === 'assistant') {
        // If assistant message, link it to last user message if exists
        if (lastUserMessageId) {
          msgDiv.dataset.replyTo = lastUserMessageId;
        }
        
        // NEW ARCHITECTURE: Use .message-content wrapper with .content-segment elements
        const messageContent = document.createElement('div');
        messageContent.className = 'message-content';
        
        // Check if we have actions to render (from history)
        const actions = options.actions || options.fileActions || [];
        
        // Persist actions for saveChatState
        if (actions.length > 0) {
          msgDiv.dataset.actions = JSON.stringify(actions);
        }
        
        if (actions.length > 0) {
          // Build segmented structure from actions
          let segmentIdx = 0;
          let textSegments = [];
          let fileActions = [];
          
          // Collect text segments and file actions in order
          // Only visible tools: read_file, edit_file, create_file, delete_file, terminal, search, web_search
          const VISIBLE_TOOL_TYPES = ['read_file', 'edit_file', 'create_file', 'delete_file', 'terminal', 'search', 'web_search'];
          for (const action of actions) {
            if (action.type === 'text') {
              textSegments.push({ idx: segmentIdx, content: action.content || '' });
              segmentIdx++;
            } else if (VISIBLE_TOOL_TYPES.includes(action.type)) {
              fileActions.push({ idx: segmentIdx, action });
              segmentIdx++;
            }
            // All other action types (diagnose, list_files, etc.) are silently skipped
          }
          
          // Render in order
          let textIdx = 0;
          let fileIdx = 0;
          for (let i = 0; i < segmentIdx; i++) {
            if (textIdx < textSegments.length && textSegments[textIdx].idx === i) {
              const seg = createContentSegment(textSegments[textIdx].content, i);
              messageContent.appendChild(seg);
              textIdx++;
            } else if (fileIdx < fileActions.length && fileActions[fileIdx].idx === i) {
              const act = fileActions[fileIdx].action;
              let actionEl;
              if (act.type === 'read_file' || act.type === 'edit_file' || act.type === 'create_file' || act.type === 'delete_file') {
                actionEl = createFileActionElement(act);
              } else {
                actionEl = createToolActionElement(act);
              }
              if (actionEl) {
                messageContent.appendChild(actionEl);
              }
              fileIdx++;
            }
          }
        } else {
          // No actions, just create initial content segment
          const segment = createContentSegment(content, 0);
          messageContent.appendChild(segment);
        }
        
        msgDiv.appendChild(messageContent);
      } else if (role === 'system') {
        // System/error message — styled with optional collapsible details
        const bubble = document.createElement('div');
        bubble.className = 'message-bubble system-error-bubble';
        
        const summaryText = document.createElement('span');
        summaryText.className = 'system-error-summary';
        summaryText.textContent = content;
        bubble.appendChild(summaryText);
        
        // If errorDetails provided, add collapsible raw error
        const errorDetails = options.errorDetails;
        if (errorDetails && errorDetails !== content) {
          const detailsEl = document.createElement('details');
          detailsEl.className = 'system-error-details';
          const summaryEl = document.createElement('summary');
          summaryEl.textContent = 'Подробности ошибки';
          detailsEl.appendChild(summaryEl);
          const preEl = document.createElement('pre');
          preEl.className = 'system-error-raw';
          preEl.textContent = errorDetails;
          detailsEl.appendChild(preEl);
          bubble.appendChild(detailsEl);
        }

        // Retry button for provider errors
        const retryBtn = document.createElement('button');
        retryBtn.className = 'error-retry-btn';
        retryBtn.innerHTML = '<span class="codicon codicon-refresh"></span> Повторить';
        retryBtn.addEventListener('click', () => {
          if (modelStreaming) return; // Block retry during streaming
          // Remove the error bubble from DOM
          msgDiv.remove();
          // Clean up any lingering terminal confirmation dialogs
          document.querySelectorAll('.terminal-confirm-inline').forEach(el => el.remove());
          // Reuse existing retry mechanism
          vscode.postMessage({ type: 'retryMessage' });
        });
        bubble.appendChild(retryBtn);

        // Continue button — resumes the conversation after a provider error
        const continueBtn = document.createElement('button');
        continueBtn.className = 'error-retry-btn';
        continueBtn.innerHTML = '<span class="codicon codicon-debug-continue"></span> Продолжить';
        continueBtn.addEventListener('click', () => {
          if (modelStreaming) return;
          // Remove the error bubble from DOM
          msgDiv.remove();
          document.querySelectorAll('.terminal-confirm-inline').forEach(el => el.remove());
          // Send continue (re-send without rollback)
          vscode.postMessage({ type: 'continueMessage' });
        });
        bubble.appendChild(continueBtn);
        
        msgDiv.appendChild(bubble);
      } else {
        // User message - simple bubble
        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.textContent = content;
        msgDiv.appendChild(bubble);
        // remember id of last user message for linking
        lastUserMessageId = msgId;
      }

      // If this is a user message with attached files, display them below the message
      if (role === 'user' && options.attachedFiles && options.attachedFiles.length > 0) {
        const filesContainer = document.createElement('div');
        filesContainer.className = 'message-attached-files';
        
        options.attachedFiles.forEach(file => {
          const fileName = file.name || 'Unknown file';
          const icon = file.icon;
          const chip = document.createElement('div');
          chip.className = 'attached-file-chip';
          
          let iconHtml = '';
          if (icon && window.__ICONS_URI) {
              iconHtml = `<img src="${window.__ICONS_URI}/${icon}" class="file-icon" />`;
          } else {
              iconHtml = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.71 4.29l-3-3L10 1H4L3 2v12l1 1h9l1-1V5l-.29-.71zM10 5V2.41L12.59 5H10z"/></svg>`;
          }

          chip.innerHTML = `
            ${iconHtml}
            <span>${fileName}</span>
          `;
          filesContainer.appendChild(chip);
        });
        
        msgDiv.appendChild(filesContainer);
      }

      if (role === 'assistant') {
        // Determine if footer should be added
        // Footer is shown for completed messages (non-empty content and not currently streaming)
        // Placeholder messages (empty or streaming) defer footer until completion
        dbg('[addMessage] Footer decision - deferFooter:', options.deferFooter, 'content:', !!content, 'modelStreaming:', modelStreaming, 'modelName:', options.modelName);
        if (options.deferFooter) {
          // Explicitly deferred (e.g., during initial placeholder creation)
          msgDiv.dataset.needsFooter = '1';
          dbg('[addMessage] Footer deferred: deferFooter=true');
        } else if (!content || content.trim().length === 0) {
          // Empty placeholder - defer footer
          msgDiv.dataset.needsFooter = '1';
          dbg('[addMessage] Footer deferred: empty content');
        } else if (modelStreaming) {
          // Currently streaming - defer footer until stream ends
          msgDiv.dataset.needsFooter = '1';
          dbg('[addMessage] Footer deferred: modelStreaming=true');
        } else {
          // Completed message with content - add footer immediately
          dbg('[addMessage] Adding footer immediately with modelName:', options.modelName);
          appendFooterToMessage(msgDiv, content, options.modelName || '');
        }
      }

      chatContainer.appendChild(msgDiv);
      markLatestAssistantMessage();
      scrollToBottom();
      saveChatState();
    }
    
    // Helper: Create a content segment with parsed markdown
    function createContentSegment(content, idx) {
      const segment = document.createElement('div');
      segment.className = 'content-segment';
      segment.dataset.segmentIdx = String(idx);
      segment.dataset.raw = content || '';
      
      if (content && content.trim()) {
        segment.innerHTML = marked.parse(content);
        // Add copy buttons and syntax highlighting
        segment.querySelectorAll('pre').forEach(pre => {
          const code = pre.querySelector('code');
          if (code) {
            const copyBtn = document.createElement('button');
            copyBtn.className = 'code-copy-btn';
            copyBtn.textContent = 'Копировать';
            copyBtn.onclick = (e) => {
              e.stopPropagation();
              navigator.clipboard.writeText(code.textContent).then(() => {
                copyBtn.textContent = 'Скопировано!';
                setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 1200);
              });
            };
            pre.appendChild(copyBtn);
          }
        });
        segment.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
      }
      
      return segment;
    }
    
    // Helper: Create a file action element (supports read_file, edit_file, create_file, delete_file)
    function createFileActionElement(action) {
      // Determine action type and set CSS class accordingly
      let actionClass = 'file-read-action';
      if (action.type === 'edit_file') actionClass = 'file-edit-action';
      else if (action.type === 'create_file') actionClass = 'file-create-action';
      else if (action.type === 'delete_file') actionClass = 'file-delete-action';
      
      const actionEl = document.createElement('div');
      actionEl.className = actionClass + ' ' + (action.success ? 'success' : 'error');
      
      const fileName = action.fileName || action.filePath?.split(/[\\/]/).pop() || 'Unknown file';
      const filePath = action.filePath || '';
      
      let iconHtml = '';
      if (window.__ICONS_URI && fileName) {
        const iconName = getFileIcon(fileName);
        iconHtml = `<img src="${window.__ICONS_URI}/${iconName}" class="file-icon" />`;
      } else {
        iconHtml = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.71 4.29l-3-3L10 1H4L3 2v12l1 1h9l1-1V5l-.29-.71zM10 5V2.41L12.59 5H10z"/></svg>`;
      }
      
      const statusIconClass = action.success ? 'success' : 'warning';
      
      // Choose icon based on action type and success status
      let codiconName = 'codicon-check-all';
      if (!action.success) {
        codiconName = 'codicon-warning'; // clear error indicator
      } else if (action.type === 'edit_file') {
        codiconName = 'codicon-edit';
      } else if (action.type === 'create_file') {
        codiconName = 'codicon-new-file';
      } else if (action.type === 'delete_file') {
        codiconName = 'codicon-trash';
      }
      
      // Build line info text based on action type
      let lineInfoText = '';
      if (action.type === 'read_file') {
        if (action.success) {
          const startLine = action.startLine || action.start_line || 1;
          const endLine = action.endLine || action.end_line || 0;
          const totalLines = action.totalLines || 0;
          const truncated = action.truncated || false;
          
          if (totalLines > 0) {
            if (truncated) {
              lineInfoText = `строки ${startLine}-${endLine} из ${totalLines}`;
            } else if (startLine === 1 && endLine >= totalLines) {
              lineInfoText = `${totalLines} строк`;
            } else {
              lineInfoText = `строки ${startLine}-${endLine}`;
            }
          }
        } else {
          lineInfoText = 'Ошибка чтения';
        }
      } else if (action.type === 'edit_file') {
        if (action.success) {
          const added = action.linesAdded || 0;
          const removed = action.linesRemoved || 0;
          lineInfoText = `<span class="added">+${added}</span> | <span class="removed">-${removed}</span>`;
        } else {
          lineInfoText = 'Не удалось исправить';
        }
      } else if (action.type === 'create_file') {
        lineInfoText = action.success ? 'Создан' : 'Не удалось создать';
      } else if (action.type === 'delete_file') {
        lineInfoText = action.success ? 'Удалён' : 'Не удалось удалить';
      }
      
      actionEl.innerHTML = `
        <span class="status-icon ${statusIconClass}">
          <span class="codicon ${codiconName}"></span>
        </span>
        <div class="file-chip" data-path="${escapeHtml(filePath)}">
          ${iconHtml}
          <span>${escapeHtml(fileName)}</span>
        </div>
        <span class="line-info">${lineInfoText}</span>
      `;
      
      // Add click handler to open file in editor
      const fileChip = actionEl.querySelector('.file-chip');
      if (fileChip && filePath) {
        fileChip.addEventListener('click', () => {
          vscode.postMessage({ type: 'openFile', filePath: filePath });
        });
      }
      
      return actionEl;
    }

    /**
     * Creates a tool action element for session history restore.
     * Only renders visible tools: terminal, search, web_search.
     * Returns null for invisible tool types (diagnose, list_files, etc.)
     */
    function createToolActionElement(action) {
      switch (action.type) {
        case 'terminal': {
          const actionEl = document.createElement('div');
          const displayCmd = action.command && action.command.length > 50 
            ? action.command.slice(0, 50) + '...' 
            : (action.command || '');
          
          if (action.rejected) {
            actionEl.className = 'terminal-result-inline rejected';
            actionEl.innerHTML = `
              <span class="codicon codicon-circle-slash"></span>
              <span class="terminal-result-text">"${escapeHtml(displayCmd)}" отклонена</span>
            `;
          } else if (!action.success || action.error) {
            actionEl.className = 'terminal-result-inline error';
            actionEl.innerHTML = `
              <span class="codicon codicon-error"></span>
              <span class="terminal-result-text">"${escapeHtml(displayCmd)}" error (${action.exitCode ?? '?'})</span>
            `;
          } else {
            actionEl.className = 'terminal-result-inline success';
            actionEl.innerHTML = `
              <span class="codicon codicon-terminal"></span>
              <span class="terminal-result-text">"${escapeHtml(displayCmd)}" completed</span>
            `;
          }
          return actionEl;
        }
        case 'search': {
          const actionEl = document.createElement('div');
          actionEl.className = 'code-search-action ' + (action.success ? 'success' : 'error');
          const query = action.query || '';
          const displayQuery = query.length > 50 ? query.slice(0, 47) + '...' : query;
          actionEl.innerHTML = `
            <div class="code-search-header">
              <span class="status-icon ${action.success ? 'success' : 'error'}">
                <span class="codicon codicon-search"></span>
              </span>
              <span class="code-search-title">Поиск: "${escapeHtml(displayQuery)}"</span>
              <span class="code-search-count">${action.totalResults || 0}</span>
            </div>
          `;
          return actionEl;
        }
        case 'web_search': {
          const actionEl = document.createElement('div');
          actionEl.className = 'web-search-action ' + (action.success ? 'success' : 'error');
          const query = action.query || '';
          const displayQuery = query.length > 50 ? query.slice(0, 47) + '...' : query;
          actionEl.innerHTML = `
            <div class="web-search-header">
              <span class="status-icon ${action.success ? 'success' : 'error'}">
                <span class="codicon codicon-globe"></span>
              </span>
              <span class="web-search-title">Поиск: "${escapeHtml(displayQuery)}"</span>
              <span class="web-search-count">${action.resultsCount || 0}</span>
            </div>
          `;
          return actionEl;
        }
        default:
          // All other tool types are invisible — do not render
          return null;
      }
    }

    function appendFooterToMessage(msgDiv, content, modelName) {
      // NEVER add footer while model is still streaming a response
      if (modelStreaming) {
        msgDiv.dataset.needsFooter = '1';
        return;
      }
      // Use dataset.modelName as fallback if modelName param is empty
      const effectiveModelName = modelName || msgDiv.dataset.modelName || '';
      
      // Debug logging
      dbg('[appendFooterToMessage] param modelName:', modelName, 'dataset:', msgDiv.dataset.modelName, 'effective:', effectiveModelName);
      
      // Don't add footer to truly empty messages (no text, no actions, no visible content)
      const raw = msgDiv.dataset.raw || '';
      const hasActions = msgDiv.dataset.actions || msgDiv.querySelector('.file-read-action, .file-edit-action, .file-create-action, .file-delete-action, .terminal-result-inline, .search-accordion, .web-search-accordion');
      if (!raw.trim() && !hasActions) {
        // Check textContent as last resort (might have rendered content from actions)
        const text = msgDiv.textContent || '';
        if (!text.trim()) {
          // Truly empty — don't add footer but DON'T remove needsFooter flag
          // (action elements might appear later during streaming)
          return;
        }
      }

      // Skip if already has footer (prevent duplicates)
      if (msgDiv.classList.contains('has-footer')) {
        msgDiv.removeAttribute('data-needs-footer');
        return;
      }
      const existing = msgDiv.querySelector('.message-footer');
      if (existing) {
        msgDiv.classList.add('has-footer');
        msgDiv.removeAttribute('data-needs-footer');
        return;
      }

      const footer = document.createElement('div');
      footer.className = 'message-footer';
      // Format model name: extract after "/" and truncate if too long
      let displayModel = effectiveModelName;
      if (displayModel.includes('/')) {
        displayModel = displayModel.split('/').pop();
      }
      if (displayModel.length > 30) {
        displayModel = displayModel.substring(0, 27) + '...';
      }
      footer.innerHTML = `
        <button class="footer-btn" data-action="copy" title="Копировать ответ">
          <span class="codicon codicon-copy"></span>
        </button>
        <button class="footer-btn" data-action="retry" title="Повторить запрос">
          <span class="codicon codicon-refresh"></span>
        </button>
        <button class="footer-btn" data-action="undo" title="Удалить ответ">
          <span class="codicon codicon-discard"></span>
        </button>
        <div class="model-name" title="${effectiveModelName}">
          <span class="codicon codicon-hubot"></span>
          <span>${displayModel}</span>
        </div>
      `;
      msgDiv.appendChild(footer);
      msgDiv.classList.add('has-footer');
      msgDiv.removeAttribute('data-needs-footer');
    }

    function updateLastAssistantMessage(content, reasoning, id, modelName) {
      const wasAtBottom = chatContainer.scrollTop + chatContainer.clientHeight >= chatContainer.scrollHeight - 10;
      let lastMsg = null;
      if (id) {
        lastMsg = chatContainer.querySelector(`.message.assistant[data-msg-id="${id}"]`);
      }
      if (!lastMsg) {
        lastMsg = chatContainer.querySelector('.message.assistant:last-child');
      }
      if (lastMsg) {
        // Store model name if provided
        if (modelName) {
          lastMsg.dataset.modelName = modelName;
        }
        // NEW ARCHITECTURE: Update only the LAST content segment
        const messageContent = lastMsg.querySelector('.message-content');
        if (messageContent) {
          // Find the last content segment
          const segments = messageContent.querySelectorAll('.content-segment');
          let lastSegment = segments.length > 0 ? segments[segments.length - 1] : null;
          
          if (!lastSegment) {
            // Create initial segment if none exists
            lastSegment = document.createElement('div');
            lastSegment.className = 'content-segment';
            lastSegment.dataset.segmentIdx = '0';
            messageContent.appendChild(lastSegment);
          }
          
          // Get the raw content for this segment
          // For streaming, we need to calculate what content belongs to this segment
          // by subtracting content from previous segments
          let previousContent = '';
          for (let i = 0; i < segments.length - 1; i++) {
            previousContent += segments[i].dataset.raw || '';
          }
          
          // The content for current segment is everything after previous segments
          const segmentContent = content.substring(previousContent.length);
          lastSegment.dataset.raw = segmentContent;
          
          if (segmentContent && segmentContent.trim()) {
            lastSegment.innerHTML = marked.parse(segmentContent);
            // Add copy buttons and syntax highlighting
            lastSegment.querySelectorAll('pre').forEach(pre => {
              const code = pre.querySelector('code');
              if (code) {
                const copyBtn = document.createElement('button');
                copyBtn.className = 'code-copy-btn';
                copyBtn.textContent = 'Копировать';
                copyBtn.onclick = (e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(code.textContent).then(() => {
                    copyBtn.textContent = 'Скопировано!';
                    setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 1200);
                  });
                };
                pre.appendChild(copyBtn);
              }
            });
            lastSegment.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
          }
          
          // Update stored raw content for the whole message
          lastMsg.dataset.raw = content || '';
          
          // If footer was postponed for a placeholder, append it now (unless streaming still active)
          if (lastMsg.dataset.needsFooter && !modelStreaming) {
            appendFooterToMessage(lastMsg, content, lastMsg.dataset.modelName || '');
          }
          // Model name in footer doesn't need updating during stream - it's static
        }
        
        // Update or add reasoning indicator
        if (reasoning) {
          let reasoningBlock = lastMsg.querySelector('.reasoning-indicator');
          const messageContent = lastMsg.querySelector('.message-content');
          if (!reasoningBlock) {
            reasoningBlock = document.createElement('div');
            reasoningBlock.className = 'reasoning-indicator thinking';
            reasoningBlock.innerHTML = `
              <svg class="reasoning-spinner" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1a7 7 0 1 0 7 7h-1.5A5.5 5.5 0 1 1 8 2.5V1z"/>
              </svg>
              <span class="reasoning-label">Thinking</span>
            `;
            
            // Insert BEFORE message-content (at the beginning)
            if (messageContent) {
              lastMsg.insertBefore(reasoningBlock, messageContent);
            } else {
              lastMsg.insertBefore(reasoningBlock, lastMsg.firstChild);
            }
          }
          // Keep it in "thinking" state during streaming
        }
        
        if (wasAtBottom) scrollToBottom();
        saveChatState();
      } else {
        addMessage('assistant', content, reasoning);
      }
    }

    function scrollToBottom() {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    // Helper: remove all .correcting elements for a given file path (with fuzzy matching)
    function removePendingCorrectings(container, filePath) {
      if (!container || !filePath) return;
      // Try exact match first
      const exact = container.querySelectorAll(`.correcting[data-file-path="${CSS.escape(filePath)}"]`);
      if (exact.length > 0) {
        exact.forEach(p => p.remove());
        return;
      }
      // Fuzzy: match by filename (basename) — handles path mismatches (relative vs absolute)
      const baseName = filePath.split(/[\\/]/).pop();
      if (!baseName) return;
      container.querySelectorAll('.correcting[data-file-path]').forEach(el => {
        const elPath = el.dataset.filePath || '';
        const elBase = elPath.split(/[\\/]/).pop();
        if (elBase === baseName) el.remove();
      });
    }
