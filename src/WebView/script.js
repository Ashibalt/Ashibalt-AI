/* Extracted script for chatView webview. Requires marked.js and highlight.js to be available. */
(function() {
    const vscode = acquireVsCodeApi();
    
    /** Set to true for debug logging; false for production (hides console.log from users) */
    const DEBUG = false;
    /** Debug log helper — only prints when DEBUG is true */
    function dbg(...args) { if (DEBUG) console.log(...args); }

    // Signal to extension that webview is ready to receive messages
    // This MUST be sent early, before any other initialization that depends on extension data
    dbg('[WebView] Sending webviewReady signal (v1.1)');
    vscode.postMessage({ type: 'webviewReady' });
    
    // Configure marked
    marked.setOptions({
        highlight: function(code, lang) {
            const language = hljs.getLanguage(lang) ? lang : 'plaintext';
            return hljs.highlight(code, { language }).value;
        },
        langPrefix: 'hljs language-'
    });

    // Elements
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    const settingsBtn = document.getElementById('settings-btn');
    const newChatBtn = document.getElementById('new-chat-btn');
    const historyBtn = document.getElementById('history-btn');
    const attachFileBtn = document.getElementById('attach-file-btn');
    const modelSelector = document.getElementById('model-selector');
    const modelDropdown = document.getElementById('model-dropdown');
    
    // Initialize send button state
    if (sendBtn) {
      sendBtn.dataset.state = 'send';
    }
    
    const settingsPanel = document.getElementById('settings-panel');
    const settingsOverlay = document.getElementById('settings-overlay');
    const closeSettingsBtn = document.getElementById('close-settings-btn');
    const cancelSettingsBtn = document.getElementById('cancel-settings');
    const saveSettingsBtn = document.getElementById('save-settings-btn');
    const agentIterationsSlider = document.getElementById('agent-iterations-slider');
    const agentIterationsValue = document.getElementById('agent-iterations-value');
    
    const contextBar = document.getElementById('context-bar');
    const addCurrentFileBtn = document.getElementById('add-current-file-btn');
    
    const historySidebar = document.getElementById('history-sidebar');
    const closeHistoryBtn = document.getElementById('close-history-btn');
    const historyList = document.getElementById('history-list');
    const modeSelector = document.getElementById('mode-selector');

    // Auth elements
    const authLoginBtn = document.getElementById('auth-login-btn');
    const authUserInfo = document.getElementById('auth-user-info');
    const authUserAvatar = document.getElementById('auth-user-avatar');
    const authAvatarImg = document.getElementById('auth-avatar-img');
    const authTierBadge = document.getElementById('auth-tier-badge');
    const authUserDropdown = document.getElementById('auth-user-dropdown');
    const authDropdownUsername = document.getElementById('auth-dropdown-username');
    const authDropdownEmail = document.getElementById('auth-dropdown-email');
    const authStatTier = document.getElementById('auth-stat-tier');
    const authStatRequests = document.getElementById('auth-stat-requests');
    const authStatRequestsRow = document.getElementById('auth-stat-requests-row');
    const authStatCredits = document.getElementById('auth-stat-credits');
    const authStatCreditsRow = document.getElementById('auth-stat-credits-row');
    const authUpgradeBtn = document.getElementById('auth-upgrade-btn');
    const authRefreshBtn = document.getElementById('auth-refresh-btn');
    const authLogoutBtn = document.getElementById('auth-logout-btn');
    
    // Settings elements
    const settingsModelList = document.getElementById('settings-model-list');
    const clearAllModelsBtn = document.getElementById('clear-all-models-btn');

    let configProvider = 'mistral';
    const MODEL_PLACEHOLDER = 'Выбрать модель';
    let savedModels = [];
    let currentSelectedModelId = null;
    let currentCodeModelId = null;
    let currentMode = 'agent'; // 'agent' or 'chat'
    let modeLocked = false; // true when mode is locked for current session
    let modelSelectorAttentionTimeout = null;
    let isRestoringState = false;
    let lastUserMessageId = null;
    let reasoningTimer = null;
    let modelStreaming = false; // true while model is streaming a response
    let currentUser = null; // Current authenticated user

    const CHAT_STATE_KEY = 'ashibalt_chat_state_v1';

    function generateId() {
      return 'm_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 10000).toString(36);
    }

    // ===== AUTH FUNCTIONS (DISABLED — will be restored with own server) =====
    
    function updateAuthUI(user) {
      // Auth is disabled — agent mode always available, no tier restrictions
      dbg('[Auth] updateAuthUI called but auth is disabled');
      currentUser = null;
    }
    
    function updateSelectorsForTier(tier) {
      // Auth disabled — all selectors always enabled
      if (modeSelector) {
        modeSelector.classList.remove('disabled');
        modeSelector.title = 'Режим работы';
      }
      if (modelSelector) {
        modelSelector.classList.remove('disabled');
        modelSelector.title = 'Выбрать модель';
      }
    }
    
    function toggleUserDropdown() {
      if (authUserDropdown) {
        authUserDropdown.classList.toggle('show');
      }
    }
    
    function closeUserDropdown() {
      if (authUserDropdown) {
        authUserDropdown.classList.remove('show');
      }
    }
    
    // Auth event handlers
    if (authLoginBtn) {
      authLoginBtn.addEventListener('click', () => {
        dbg('[Auth] Login button clicked');
        vscode.postMessage({ type: 'authLogin' });
      });
    } else {
      dbg('[Auth] authLoginBtn not found!');
    }
    
    if (authUserAvatar) {
      authUserAvatar.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleUserDropdown();
      });
    }
    
    if (authLogoutBtn) {
      authLogoutBtn.addEventListener('click', () => {
        closeUserDropdown();
        vscode.postMessage({ type: 'authLogout' });
      });
    }
    
    if (authUpgradeBtn) {
      authUpgradeBtn.addEventListener('click', () => {
        closeUserDropdown();
        vscode.postMessage({ type: 'authUpgrade' });
      });
    }

    if (authRefreshBtn) {
      authRefreshBtn.addEventListener('click', () => {
        closeUserDropdown();
        vscode.postMessage({ type: 'refreshAuth' });
      });
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (authUserDropdown && authUserDropdown.classList.contains('show')) {
        if (!authUserInfo?.contains(e.target)) {
          closeUserDropdown();
        }
      }
    });
    
    // ===== END AUTH FUNCTIONS =====

    // Paste handler: capture images from clipboard (Ctrl+V) and send to extension as dataURL
    document.addEventListener('paste', (e) => {
      if (!e.clipboardData) return;
      const items = Array.from(e.clipboardData.items || []);
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            const reader = new FileReader();
            reader.onload = () => {
              const dataUrl = reader.result;
              vscode.postMessage({ type: 'pasteImage', name: file.name || 'pasted.png', mime: file.type, dataUrl, size: file.size });
            };
            reader.readAsDataURL(file);
            e.preventDefault();
            break;
          }
        }
      }
    });

    function saveChatState() {
      if (isRestoringState) return;
      try {
        const msgs = [];
        const nodes = chatContainer.querySelectorAll('.message');
        nodes.forEach(node => {
          const id = node.dataset.msgId || null;
          const role = node.classList.contains('assistant') ? 'assistant' : node.classList.contains('user') ? 'user' : 'unknown';
          const raw = node.dataset.raw || '';
          const reasoning = node.dataset.reasoning || '';
          const replyTo = node.dataset.replyTo || null;
          
          // Extract attached files for user messages
          let attachedFiles = [];
          if (role === 'user') {
            const filesContainer = node.querySelector('.message-attached-files');
            if (filesContainer) {
              const chips = filesContainer.querySelectorAll('.attached-file-chip');
              chips.forEach(chip => {
                const nameSpan = chip.querySelector('span');
                if (nameSpan) {
                  // We store the name but lose the path during UI refresh
                  // This is acceptable as files are re-added during getLastUserMessage lookup
                  attachedFiles.push({ path: 'unknown', name: nameSpan.textContent });
                }
              });
            }
          }
          
          // Extract actions for assistant messages
          let actions = null;
          if (role === 'assistant' && node.dataset.actions) {
            try { actions = JSON.parse(node.dataset.actions); } catch(e) {}
          }
          
          msgs.push({ id, role, raw, reasoning, replyTo, attachedFiles, actions });
        });
        localStorage.setItem(CHAT_STATE_KEY, JSON.stringify(msgs));
      } catch (e) {
        console.error('Failed to save chat state', e);
      }
    }

    // ========================================================================
    // AUTOCOMPLETE SYSTEM FOR / AND # LITERALS
    // ========================================================================
    
    let slashCommands = []; // Will be populated from backend
    let fileCompletions = []; // Will be populated from backend
    let autocompleteVisible = false;
    let autocompleteType = null; // 'slash' or 'hash'
    let autocompleteSelectedIndex = 0;
    
    // Create autocomplete dropdown element
    const autocompleteDropdown = document.createElement('div');
    autocompleteDropdown.id = 'autocomplete-dropdown';
    autocompleteDropdown.className = 'autocomplete-dropdown';
    autocompleteDropdown.style.display = 'none';
    document.body.appendChild(autocompleteDropdown);
    
    // Request slash commands from backend on init
    vscode.postMessage({ type: 'getSlashCommands' });
    
    function showAutocomplete(items, type) {
      if (items.length === 0) {
        hideAutocomplete();
        return;
      }
      
      autocompleteType = type;
      autocompleteSelectedIndex = 0;
      autocompleteVisible = true;
      
      autocompleteDropdown.innerHTML = '';
      items.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'autocomplete-item' + (index === 0 ? ' selected' : '');
        
        if (type === 'slash') {
          // Use codicons for slash commands
          let iconClass = 'codicon-terminal';
          if (item.name === 'clear') iconClass = 'codicon-clear-all';
          else if (item.name === 'new') iconClass = 'codicon-add';
          else if (item.name === 'fix') iconClass = 'codicon-wrench';
          else if (item.name === 'project_analysis') iconClass = 'codicon-graph';
          else if (item.name === 'workspace_fix') iconClass = 'codicon-tools';
          
          div.innerHTML = `
            <span class="codicon ${iconClass} autocomplete-icon"></span>
            <span class="autocomplete-name">/${item.name}</span>
            <span class="autocomplete-desc">${item.description}</span>
          `;
          div.dataset.value = '/' + item.name + (item.args ? ' ' : '');
        } else {
          // Use codicons for files/folders
          const iconClass = item.isFolder ? 'codicon-folder' : 'codicon-file';
          div.innerHTML = `
            <span class="codicon ${iconClass} autocomplete-icon"></span>
            <span class="autocomplete-name">${item.name}</span>
            <span class="autocomplete-path">${item.path}</span>
          `;
          div.dataset.value = '#' + item.path;
        }
        
        div.addEventListener('click', () => selectAutocompleteItem(index));
        div.addEventListener('mouseenter', () => {
          autocompleteSelectedIndex = index;
          updateAutocompleteSelection();
        });
        
        autocompleteDropdown.appendChild(div);
      });
      
      // Position dropdown above input
      if (messageInput) {
        const rect = messageInput.getBoundingClientRect();
        autocompleteDropdown.style.left = rect.left + 'px';
        autocompleteDropdown.style.bottom = (window.innerHeight - rect.top + 5) + 'px';
        autocompleteDropdown.style.width = Math.min(rect.width, 350) + 'px';
      }
      
      autocompleteDropdown.style.display = 'block';
    }
    
    function hideAutocomplete() {
      autocompleteVisible = false;
      autocompleteType = null;
      autocompleteDropdown.style.display = 'none';
    }
    
    function updateAutocompleteSelection() {
      const items = autocompleteDropdown.querySelectorAll('.autocomplete-item');
      items.forEach((item, index) => {
        item.classList.toggle('selected', index === autocompleteSelectedIndex);
      });
    }
    
    function selectAutocompleteItem(index) {
      const items = autocompleteDropdown.querySelectorAll('.autocomplete-item');
      if (index >= 0 && index < items.length) {
        const item = items[index];
        const value = item.dataset.value;
        
        if (messageInput) {
          const text = messageInput.value;
          // Find the trigger position (/ or #)
          const trigger = autocompleteType === 'slash' ? '/' : '#';
          const lastTrigger = text.lastIndexOf(trigger);
          
          if (lastTrigger !== -1) {
            // Replace from trigger to end with selected value
            messageInput.value = text.substring(0, lastTrigger) + value;
            messageInput.focus();
          }
        }
        
        hideAutocomplete();
      }
    }
    
    function handleAutocompleteKeydown(e) {
      if (!autocompleteVisible) return false;
      
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const items = autocompleteDropdown.querySelectorAll('.autocomplete-item');
        autocompleteSelectedIndex = (autocompleteSelectedIndex + 1) % items.length;
        updateAutocompleteSelection();
        return true;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const items = autocompleteDropdown.querySelectorAll('.autocomplete-item');
        autocompleteSelectedIndex = (autocompleteSelectedIndex - 1 + items.length) % items.length;
        updateAutocompleteSelection();
        return true;
      } else if (e.key === 'Tab') {
        // Tab inserts the selected item
        e.preventDefault();
        selectAutocompleteItem(autocompleteSelectedIndex);
        return true;
      } else if (e.key === 'Enter') {
        // Enter inserts the selected item but doesn't send
        e.preventDefault();
        e.stopPropagation();
        selectAutocompleteItem(autocompleteSelectedIndex);
        return true;
      } else if (e.key === 'Escape') {
        hideAutocomplete();
        return true;
      }
      
      return false;
    }
    
    function checkForAutocomplete(text) {
      // Check for slash commands at the start of input
      if (text.startsWith('/')) {
        const query = text.slice(1).toLowerCase();
        const filtered = slashCommands.filter(cmd => 
          cmd.name.toLowerCase().startsWith(query)
        );
        showAutocomplete(filtered, 'slash');
        return;
      }
      
      // Check for # file references anywhere in text
      const hashMatch = text.match(/#([^\s#]*)$/);
      if (hashMatch) {
        const query = hashMatch[1];
        // Request file completions from backend
        vscode.postMessage({ type: 'getFileCompletions', query });
        return;
      }
      
      hideAutocomplete();
    }

    function loadChatState() {
      const raw = localStorage.getItem(CHAT_STATE_KEY);
      if (!raw) return;
      try {
        const msgs = JSON.parse(raw);
        if (!Array.isArray(msgs)) return;
        isRestoringState = true;
        chatContainer.innerHTML = '';
        lastUserMessageId = null;
        msgs.forEach(m => {
          addMessage(m.role, m.raw, m.reasoning || '', { id: m.id, replyTo: m.replyTo, attachedFiles: m.attachedFiles, actions: m.actions || undefined });
        });
        isRestoringState = false;
        markLatestAssistantMessage();
        scrollToBottom();
      } catch (e) {
        console.error('Failed to load chat state', e);
      }
    }

    function setModelSelectorLabel(label) {
      if (!modelSelector) return;
      const pillLabel = modelSelector.querySelector('.pill-label');
      if (!pillLabel) return;
      const text = label?.trim();
      pillLabel.textContent = text || MODEL_PLACEHOLDER;
      modelSelector.classList.toggle('empty', !text || text === MODEL_PLACEHOLDER);
      if (text && text !== MODEL_PLACEHOLDER) {
        modelSelector.classList.remove('attention');
      }
    }

    // Recommended models toggle handler
    {
      const recToggle = document.getElementById('recommended-models-toggle');
      const recContent = document.getElementById('recommended-models-content');
      if (recToggle && recContent) {
        recToggle.addEventListener('click', () => {
          const isHidden = recContent.style.display === 'none';
          recContent.style.display = isHidden ? 'block' : 'none';
          recToggle.textContent = isHidden ? 'Скрыть рекомендации' : 'Рекомендуемые модели';
        });
      }
      const mistralLink = document.getElementById('mistral-free-link');
      if (mistralLink) {
        mistralLink.addEventListener('click', (e) => {
          e.preventDefault();
          vscode.postMessage({ type: 'openExternal', url: 'https://telegra.ph/Besplatno-1mlrd-tokenov-v-mesyac-02-10' });
        });
      }



      // Donate link
      const daLink = document.getElementById('donate-da-link');
      if (daLink) {
        daLink.addEventListener('click', (e) => {
          e.preventDefault();
          vscode.postMessage({ type: 'openExternal', url: 'https://dalink.to/ashibalt' });
        });
      }
    }

    function flashModelSelectorWarning() {
      if (!modelSelector) return;
      modelSelector.classList.add('attention');
      if (modelSelectorAttentionTimeout) clearTimeout(modelSelectorAttentionTimeout);
      modelSelectorAttentionTimeout = setTimeout(() => {
        modelSelector.classList.remove('attention');
        modelSelectorAttentionTimeout = null;
      }, 1200);
    }

    // Mode selector (Agent/Chat)
    function updateModeSelectorUI() {
      if (!modeSelector) return;
      const label = modeSelector.querySelector('.pill-label');
      const icon = modeSelector.querySelector('.pill-icon');
      if (label) {
        label.textContent = currentMode === 'agent' ? 'Agent' : 'Chat';
      }
      if (icon) {
        icon.classList.remove('codicon-rocket', 'codicon-comment-discussion');
        icon.classList.add(currentMode === 'agent' ? 'codicon-rocket' : 'codicon-comment-discussion');
      }
      modeSelector.classList.remove('agent', 'chat');
      modeSelector.classList.add(currentMode);
      modeSelector.title = currentMode === 'agent' 
        ? 'Режим агента: полный доступ к инструментам'
        : 'Режим чата: чтение файлов, поиск, диагностика';
    }

    if (modeSelector) {
      modeSelector.addEventListener('click', () => {
        // Block mode switch while model is streaming or mode is locked for session
        if (modelStreaming || modeLocked) return;
        // Auth disabled — agent mode always available, no tier restrictions
        currentMode = currentMode === 'agent' ? 'chat' : 'agent';
        dbg('[UI] Switching mode to:', currentMode);
        updateModeSelectorUI();
        vscode.postMessage({ type: 'modeChanged', mode: currentMode });
      });
      
      // Initialize UI
      updateModeSelectorUI();
    }

    // Auto-resize textarea and trigger autocomplete check
    if (messageInput) {
      messageInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
        // Check for autocomplete triggers
        checkForAutocomplete(this.value);
      });
      
      // Hide autocomplete when input loses focus
      messageInput.addEventListener('blur', function() {
        // Delay to allow clicking on autocomplete items
        setTimeout(() => {
          if (!autocompleteDropdown.matches(':hover')) {
            hideAutocomplete();
          }
        }, 150);
      });
    }

    // Immediate slash commands that don't require model response
    const IMMEDIATE_COMMANDS = ['/clear', '/new'];
    
    function isImmediateCommand(text) {
      const trimmed = text.trim().toLowerCase();
      return IMMEDIATE_COMMANDS.some(cmd => trimmed === cmd || trimmed.startsWith(cmd + ' '));
    }

    // Send Message Logic
    function sendMessage() {
      if (!messageInput) return;
      // Block sending while model is streaming a response
      if (modelStreaming) {
        dbg('[SendMessage] Blocked — model is still streaming');
        return;
      }
      const text = messageInput.value.trim();
      // Auth disabled — no tier restrictions, agent mode always available

      const selectedModel = savedModels.find(m => m.id === currentSelectedModelId);
      if (!selectedModel) {
        dbg('[SendMessage] No model selected, blocking send');
        flashModelSelectorWarning();
        setModelSelectorLabel('Выбрать модель');
        vscode.postMessage({ type: 'restrictedAction', feature: 'model' });
        return;
      }

      dbg('[SendMessage] Attempting to send. text:', text, 'currentUser:', currentUser);
      if (text) {
        hideAutocomplete(); // Hide autocomplete when sending
        dbg('[SendMessage] Sending message to extension...');
        vscode.postMessage({ 
          type: 'sendMessage', 
          value: text, 
          mode: currentMode, 
          selectedModelId: selectedModel.id,
          selectedModelProvider: selectedModel.provider,
          selectedModelName: selectedModel.name
        });
        messageInput.value = '';
        messageInput.style.height = 'auto';
        // Track user request for usage metrics
        if (metricsToggle && metricsToggle.checked) {
          trackUsageEvent({ requests: 1, model: selectedModel.id || '' });
        }
        // Change button to Stop only if not an immediate command
        if (sendBtn && !isImmediateCommand(text)) {
          sendBtn.innerHTML = '<span class="codicon codicon-debug-stop"></span>';
          sendBtn.dataset.state = 'stop';
          sendBtn.style.background = 'var(--vscode-errorForeground, #f44336)';
          sendBtn.style.color = '#fff';
        }
      }
    }

    function stopStreaming() {
      vscode.postMessage({ type: 'stopStreaming' });
      // Set modelStreaming to false immediately to prevent race conditions
      modelStreaming = false;
      // Don't remove temporary placeholder - it will be finalized by the backend
      // Immediately reset button to Send for better UX
      if (sendBtn) {
        sendBtn.innerHTML = '<span class="codicon codicon-send"></span>';
        sendBtn.dataset.state = 'send';
        sendBtn.style.background = 'var(--accent-color)';
        sendBtn.style.color = 'var(--accent-fg)';
      }
      // Add footers to any messages that need them (completed messages only)
      try {
        const needers = chatContainer.querySelectorAll('.message.assistant[data-needs-footer]');
        needers.forEach(n => {
          const content = n.dataset.raw || '';
          const modelName = n.dataset.modelName || '';
          appendFooterToMessage(n, content, modelName);
        });
      } catch (e) {}
    }

    if (sendBtn) {
      dbg('[Init] sendBtn found, adding click listener');
      sendBtn.addEventListener('click', () => {
        dbg('[Click] sendBtn clicked, state:', sendBtn.dataset.state);
        if (sendBtn.dataset.state === 'stop') {
          stopStreaming();
        } else {
          sendMessage();
        }
      });
    } else {
      console.error('[Init] sendBtn NOT FOUND!');
    }
    
    if (messageInput) {
      messageInput.addEventListener('keydown', (e) => {
        // First check if autocomplete should handle this event
        if (handleAutocompleteKeydown(e)) {
          return; // Event was handled by autocomplete
        }
        // Otherwise, handle Enter to send message
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
    }

    // Header Actions
    if (newChatBtn) {
      newChatBtn.addEventListener('click', () => {
        chatContainer.innerHTML = '';
        vscode.postMessage({ type: 'clearChat' });
      });
    }

    if (historyBtn) {
      historyBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'showHistory' });
        historySidebar.classList.add('visible');
      });
    }

    if (closeHistoryBtn) {
      closeHistoryBtn.addEventListener('click', () => {
        historySidebar.classList.remove('visible');
      });
    }

    function renderHistory(sessions) {
      historyList.innerHTML = '';
      sessions.forEach(session => {
        const item = document.createElement('div');
        item.className = 'history-item';
        const date = new Date(session.date).toLocaleDateString();
        
        // Container for text
        const contentDiv = document.createElement('div');
        contentDiv.style.flex = '1';
        contentDiv.style.overflow = 'hidden';
        contentDiv.innerHTML = `
          <div class="title">${session.title}</div>
          <div class="date">${date}</div>
        `;
        
        // Delete button
        const delBtn = document.createElement('button');
        delBtn.innerHTML = '×';
        delBtn.className = 'delete-model-btn'; // Reuse style
        delBtn.style.padding = '0 4px';
        delBtn.onclick = (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: 'deleteSession', sessionId: session.id });
        };

        item.appendChild(contentDiv);
        item.appendChild(delBtn);
        
        item.addEventListener('click', () => {
          vscode.postMessage({ type: 'loadSession', sessionId: session.id });
          historySidebar.classList.remove('visible');
        });
        historyList.appendChild(item);
      });
    }

    // Toolbar Actions
    if (attachFileBtn) {
      attachFileBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'attachFile' });
      });
    }

    // Model Selector Logic
    if (modelSelector && modelDropdown) {
      modelSelector.addEventListener('click', (e) => {
        e.stopPropagation();
        // Block model switch while model is streaming
        if (modelStreaming) return;
        const isVisible = modelDropdown.classList.contains('visible');
        modelDropdown.classList.toggle('visible');
        
        // Always populate dropdown, even if empty
        if (!isVisible && savedModels.length === 0) {
          modelDropdown.innerHTML = '';
          const emptyState = document.createElement('div');
          emptyState.className = 'empty-models';
          emptyState.textContent = 'Нет сохранённых моделей. Добавьте их в настройках.';
          modelDropdown.appendChild(emptyState);
        }
      });

      document.addEventListener('click', (e) => {
        if (!modelSelector.contains(e.target) && !modelDropdown.contains(e.target)) {
          modelDropdown.classList.remove('visible');
        }
      });
    }

    if (chatContainer) {
      chatContainer.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest('button[data-action]');
        if (!button) return;
        const action = button.getAttribute('data-action');
        const messageEl = button.closest('.message.assistant');
        if (!messageEl) return;

        switch (action) {
          case 'copy':
            handleCopyAction(messageEl);
            break;
          case 'retry':
            if (modelStreaming) break; // Block retry during streaming
            if (messageEl.classList.contains('is-latest')) {
              vscode.postMessage({ type: 'retryMessage' });
            }
            break;
          case 'undo':
            // Delete this assistant message and the chain under it (including its triggering user message)
            removeAssistantAndFollowing(messageEl);
            break;
        }
      });
    }

    function removeAssistantAndFollowing(assistantEl) {
      if (!assistantEl || !chatContainer) return;
      // Find the user message that triggered this assistant (if any)
      const replyTo = assistantEl.dataset.replyTo;
      let startNode = null;
      if (replyTo) {
        startNode = chatContainer.querySelector(`.message.user[data-msg-id="${replyTo}"]`);
      }
      // If no linked user message, start from the assistant itself
      if (!startNode) startNode = assistantEl;

      // Collect nodes from startNode to end and remove them
      const toRemove = [];
      let node = startNode;
      while (node) {
        toRemove.push(node);
        node = node.nextElementSibling;
      }

      // collect ids to inform the extension which messages to forget
      const removedIds = toRemove.map(n => n.dataset && n.dataset.msgId).filter(Boolean);

      toRemove.forEach(n => n.remove());

      // Notify extension to remove these messages from its stored history
      try {
        if (removedIds.length > 0 && typeof vscode !== 'undefined' && vscode.postMessage) {
          vscode.postMessage({ type: 'forgetMessages', ids: removedIds });
        }
      } catch (e) {
        console.error('Failed to post forgetMessages', e);
      }

      // Recalculate lastUserMessageId to the last remaining user message id in DOM
      const remainingUsers = Array.from(chatContainer.querySelectorAll('.message.user'));
      if (remainingUsers.length > 0) {
        lastUserMessageId = remainingUsers[remainingUsers.length - 1].dataset.msgId || null;
      } else {
        lastUserMessageId = null;
      }

      markLatestAssistantMessage();
      saveChatState();
    }

    // ===== Model Browser Popup (for cloud providers with many models) =====
    function showModelBrowser(provider, models) {
      // Remove existing browser if any
      const existing = document.getElementById('model-browser-overlay');
      if (existing) existing.remove();

      const providerLabels = {
        ollama: 'Ollama', openrouter: 'OpenRouter', openai: 'OpenAI',
        claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek',
        mistral: 'Mistral', grok: 'Grok'
      };

      // Already saved model IDs for this provider
      const savedIds = new Set((savedModels || []).filter(m => m.provider === provider).map(m => m.id));

      const overlay = document.createElement('div');
      overlay.id = 'model-browser-overlay';
      overlay.className = 'model-browser-overlay';

      overlay.innerHTML = `
        <div class="model-browser">
          <div class="model-browser-header">
            <span class="model-browser-title">${providerLabels[provider] || provider} — ${models.length} моделей</span>
            <button class="model-browser-close" title="Закрыть">&times;</button>
          </div>
          <div class="model-browser-search-wrap">
            <input type="text" class="model-browser-search" placeholder="Поиск модели..." autofocus />
          </div>
          <div class="model-browser-list"></div>
          <div class="model-browser-footer">
            <span class="model-browser-count">0 выбрано</span>
            <button class="model-browser-add-btn" disabled>Добавить выбранные</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const listEl = overlay.querySelector('.model-browser-list');
      const searchInput = overlay.querySelector('.model-browser-search');
      const closeBtn = overlay.querySelector('.model-browser-close');
      const addBtn = overlay.querySelector('.model-browser-add-btn');
      const countEl = overlay.querySelector('.model-browser-count');

      const selected = new Set();

      function renderList(filter = '') {
        listEl.innerHTML = '';
        const lowerFilter = filter.toLowerCase();
        const filtered = filter 
          ? models.filter(m => m.id.toLowerCase().includes(lowerFilter) || m.name.toLowerCase().includes(lowerFilter))
          : models;

        if (filtered.length === 0) {
          listEl.innerHTML = '<div class="model-browser-empty">Ничего не найдено</div>';
          return;
        }

        // Limit visible items for performance (show first 100 matches)
        const visible = filtered.slice(0, 100);
        
        for (const m of visible) {
          const item = document.createElement('div');
          item.className = 'model-browser-item';
          if (savedIds.has(m.id)) item.classList.add('already-saved');
          if (selected.has(m.id)) item.classList.add('selected');

          item.innerHTML = `
            <span class="model-browser-item-name">${m.name || m.id}</span>
            <span class="model-browser-item-id">${m.id}</span>
            ${savedIds.has(m.id) ? '<span class="model-browser-item-badge">добавлена</span>' : ''}
          `;

          if (!savedIds.has(m.id)) {
            item.addEventListener('click', () => {
              if (selected.has(m.id)) {
                selected.delete(m.id);
                item.classList.remove('selected');
              } else {
                selected.add(m.id);
                item.classList.add('selected');
              }
              updateCount();
            });
          }

          listEl.appendChild(item);
        }

        if (filtered.length > 100) {
          const more = document.createElement('div');
          more.className = 'model-browser-empty';
          more.textContent = `...и ещё ${filtered.length - 100}. Уточните поиск.`;
          listEl.appendChild(more);
        }
      }

      function updateCount() {
        const n = selected.size;
        countEl.textContent = `${n} выбрано`;
        addBtn.disabled = n === 0;
      }

      searchInput.addEventListener('input', () => renderList(searchInput.value));

      closeBtn.addEventListener('click', () => overlay.remove());
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });

      addBtn.addEventListener('click', () => {
        for (const id of selected) {
          const m = models.find(x => x.id === id);
          if (m) {
            const nameParts = m.id.split('/');
            const displayName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : m.name || m.id;
            vscode.postMessage({
              type: 'saveModel',
              model: { id: m.id, name: displayName, provider: m.provider, contextLength: m.contextLength }
            });
          }
        }
        overlay.remove();
      });

      // Escape key to close
      const escHandler = (e) => {
        if (e.key === 'Escape') {
          overlay.remove();
          document.removeEventListener('keydown', escHandler);
        }
      };
      document.addEventListener('keydown', escHandler);

      renderList();
    }

    function renderModels(models, selectedId = null) {
      dbg('[RenderModels] called. models:', models?.length, 'selectedId:', selectedId, 'currentUser:', currentUser);
      if (!modelDropdown) return;
      
      // Don't overwrite savedModels if they're already set and models is the same
      if (models && models.length > 0) {
        savedModels = models;
      }

      if (!selectedId && currentSelectedModelId) {
        selectedId = currentSelectedModelId;
      }

      // Auth disabled — no tier-based model restrictions
      if (selectedId) {
          // Respect the passed selectedId
      }

      currentSelectedModelId = selectedId;
      dbg('[RenderModels] Final currentSelectedModelId:', currentSelectedModelId);

      // Render Dropdown (grouped by provider)
      modelDropdown.innerHTML = '';
      if (!models || models.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'empty-models';
        emptyState.textContent = 'Нет сохранённых моделей. Добавьте их в настройках.';
        modelDropdown.appendChild(emptyState);
      } else {
        // Scrollable wrapper
        const scrollWrap = document.createElement('div');
        scrollWrap.className = 'model-dropdown-scroll';

        // Group models by provider
        const providerOrder = ['ollama', 'openrouter', 'openai', 'claude', 'gemini', 'deepseek', 'mistral', 'grok'];
        const providerLabels = {
          ollama: 'Ollama',
          openrouter: 'OpenRouter',
          openai: 'OpenAI',
          claude: 'Claude',
          gemini: 'Gemini',
          deepseek: 'DeepSeek',
          mistral: 'Mistral',
          grok: 'Grok'
        };
        
        const renderModelGroup = (groupModels, label) => {
          if (groupModels.length === 0) return;
          const groupLabel = document.createElement('div');
          groupLabel.className = 'model-group-label';
          groupLabel.textContent = label;
          scrollWrap.appendChild(groupLabel);
          
          groupModels.forEach(model => {
            const div = document.createElement('div');
            div.className = 'model-option';
            if (selectedId && model.id === selectedId) {
              div.classList.add('active');
            }
            div.innerHTML = `
              <span class="name">${model.name}</span>
              <span class="provider ${model.provider}">${providerLabels[model.provider] || model.provider}</span>
            `;
            div.addEventListener('click', () => {
            // Auth disabled — all models available regardless of tier
            
            // Allow selection
            currentSelectedModelId = model.id;
            configProvider = model.provider;
            vscode.postMessage({ type: 'setModel', provider: model.provider, id: model.id, name: model.name });
            setModelSelectorLabel(model.name);

            modelSelector?.classList.remove('attention');
            modelDropdown.classList.remove('visible');
          });
          scrollWrap.appendChild(div);
          });
        };
        
        providerOrder.forEach(prov => {
          const groupModels = models.filter(m => m.provider === prov || (prov === 'mistral' && m.provider === 'ashibalt'));
          renderModelGroup(groupModels, providerLabels[prov] || prov);
        });

        modelDropdown.appendChild(scrollWrap);
      }

      // If no model selected, or if current selection is invalid for tier, reset
      // But wait, we already handle this above with isFree check
      
      // Ensure label is correct
      const selectedModel = models && models.length > 0 ? models.find(model => model.id === currentSelectedModelId) : null;
      setModelSelectorLabel(selectedModel?.name || MODEL_PLACEHOLDER);

      // Render Settings Model List
      if (settingsModelList) {
        settingsModelList.innerHTML = '';
        if (models && models.length > 0) {
          models.forEach(model => {
            const div = document.createElement('div');
            div.className = 'settings-model-item';
            
            div.innerHTML = `
              <div class="model-info">
                <div class="model-name">${model.name}</div>
                <div class="model-id">${model.id}</div>
              </div>
              <span class="model-provider ${model.provider}">${
                { ollama: 'Ollama', openrouter: 'OpenRouter', openai: 'OpenAI', claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek', mistral: 'Mistral', grok: 'Grok' }[model.provider] || model.provider
              }</span>
              <button class="delete-model-btn" title="Удалить модель">
                <span class="codicon codicon-trash"></span>
              </button>
            `;
            const deleteBtn = div.querySelector('.delete-model-btn');
            if (deleteBtn) {
              deleteBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'deleteModel', id: model.id });
              });
            }
            settingsModelList.appendChild(div);
          });
        } else {
          settingsModelList.innerHTML = '<div style="color: var(--secondary-text); font-size: 11px; padding: 12px; text-align: center;">Нет сохранённых моделей</div>';
        }
      }

      // Render Assignment Selects
      const updateSelect = (select, category) => {
          if (!select) return;
          select.innerHTML = '<option value="">По умолчанию</option>';
          
          // Add "Disabled" option for autocomplete (code category)
          if (category === 'code') {
            const disabledOpt = document.createElement('option');
            disabledOpt.value = 'disabled';
            disabledOpt.textContent = 'Выключен';
            select.appendChild(disabledOpt);
          }
          
          if (models && models.length > 0) {
            models.forEach(model => {
                const opt = document.createElement('option');
                opt.value = model.id;
                opt.textContent = model.name;
                select.appendChild(opt);
            });
          }
          
          // Set selected value from config
          if (category === 'code' && currentCodeModelId) {
            select.value = currentCodeModelId;
          }
          
          select.onchange = () => {
              vscode.postMessage({ type: 'assignModel', category: category, modelId: select.value });
              if (category === 'code') {
                currentCodeModelId = select.value || null;
              }
          };
      };

      updateSelect(assignCodeSelect, 'code');
    }

    function handleCopyAction(messageEl) {
      const text = getAssistantMessageText(messageEl);
      copyToClipboard(text);
    }

    function getAssistantMessageText(messageEl) {
      if (!messageEl) return '';
      const parts = [];
      const reasoningText = messageEl.querySelector('.reasoning-text');
      if (reasoningText && reasoningText.textContent) {
        parts.push(reasoningText.textContent.trim());
      }
      // NEW: Use .message-content for assistant messages (new architecture)
      const messageContent = messageEl.querySelector('.message-content');
      if (messageContent) {
        // Get text from all content segments
        const segments = messageContent.querySelectorAll('.content-segment');
        segments.forEach(seg => {
          if (seg.textContent) {
            parts.push(seg.textContent.trim());
          }
        });
      } else {
        // Fallback to old .message-bubble
        const bubble = messageEl.querySelector('.message-bubble');
        if (bubble && bubble.textContent) {
          parts.push(bubble.textContent.trim());
        }
      }
      return parts.join('\n\n').trim();
    }

    function copyToClipboard(text) {
      if (!text) {
        return;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      } else {
        fallbackCopy(text);
      }
    }

    function fallbackCopy(text) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      try {
        document.execCommand('copy');
      } catch (e) {
        console.error('Failed to copy text', e);
      }
      document.body.removeChild(textarea);
    }

    // Context Logic (Visual Only)
    if (addCurrentFileBtn) {
        // In a real app, we would get the actual current file from the extension
        // For now, we just simulate adding the current file
        addCurrentFileBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'addCurrentFile' });
        });
    }

    function addContextChip(label, path, icon) {
      const chip = document.createElement('div');
      chip.className = 'context-chip';
      
      let iconHtml = '';
      if (icon && window.__ICONS_URI) {
          iconHtml = `<img src="${window.__ICONS_URI}/${icon}" class="file-icon" />`;
      } else {
          iconHtml = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.71 4.29l-3-3L10 1H4L3 2v12l1 1h9l1-1V5l-.29-.71zM10 5V2.41L12.59 5H10z"/></svg>`;
      }

      chip.innerHTML = `
        ${iconHtml}
        <span>${label}</span>
        <span class="remove-ctx">×</span>
      `;
      chip.querySelector('.remove-ctx').addEventListener('click', () => {
         vscode.postMessage({ type: 'removeContext', path: path });
         chip.remove();
      });
      contextBar.appendChild(chip);
    }

    // Settings Panel Logic
    function openSettings() {
      if (settingsPanel) {
        settingsPanel.classList.add('visible');
      }
      if (settingsOverlay) {
        settingsOverlay.classList.add('visible');
      }
    }

    function closeSettings() {
      // Cancel any pending debounced save and save IMMEDIATELY (no debounce)
      if (saveSettingsDebounce) { clearTimeout(saveSettingsDebounce); saveSettingsDebounce = null; }
      saveSettingsNow();
      if (settingsPanel) {
        settingsPanel.classList.remove('visible');
      }
      if (settingsOverlay) {
        settingsOverlay.classList.remove('visible');
      }
    }

    /** Immediate (non-debounced) settings save — used on panel close */
    function saveSettingsNow() {
      const autoRunTerminal = document.getElementById('auto-run-terminal');
      const ollamaUrlInput = document.getElementById('ollama-base-url');

      const providerSettings = {};
      document.querySelectorAll('.provider-accordion[data-provider]').forEach(acc => {
        const prov = acc.dataset.provider;
        const urlInput = acc.querySelector('.provider-url');
        const apiKeyInput = acc.querySelector('.provider-apikey');
        if (urlInput || apiKeyInput) {
          providerSettings[prov] = {};
          if (urlInput) providerSettings[prov].url = urlInput.value.trim();
          if (apiKeyInput) providerSettings[prov].apiKey = apiKeyInput.value.trim();
        }
      });

      const settings = {
        agentIterations: agentIterationsSlider ? parseInt(agentIterationsSlider.value, 10) || 5 : 5,
        autoRunTerminal: autoRunTerminal ? autoRunTerminal.checked : false,
        metricsEnabled: metricsToggle ? metricsToggle.checked : false,
        ollamaBaseUrl: ollamaUrlInput ? ollamaUrlInput.value.trim() : undefined,
        providerSettings
      };
      dbg('[Settings] saveSettingsNow — providerSettings:', JSON.stringify(providerSettings));
      vscode.postMessage({ type: 'saveSettings', ...settings });
    }

    if (settingsBtn) {
      settingsBtn.addEventListener('click', openSettings);
    }

    // ===== Report / Feedback Button =====
    const reportBtn = document.getElementById('report-btn');
    if (reportBtn) {
      reportBtn.addEventListener('click', showFeedbackDialog);
    }

    function showFeedbackDialog() {
      const existing = document.getElementById('feedback-overlay');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'feedback-overlay';
      overlay.className = 'model-browser-overlay'; // reuse overlay style

      const selectedModel = savedModels?.find(m => m.id === currentSelectedModelId);

      overlay.innerHTML = `
        <div class="feedback-dialog">
          <div class="feedback-header">
            <span class="feedback-title">Сообщить о проблеме</span>
            <button class="model-browser-close feedback-close">&times;</button>
          </div>
          <div class="feedback-body">
            <textarea class="feedback-textarea" placeholder="Опишите проблему..." rows="5"></textarea>
            <div class="feedback-meta">
              <span>Провайдер: <b>${selectedModel?.provider || '—'}</b></span>
              <span>Модель: <b>${selectedModel?.id || '—'}</b></span>
            </div>
            <label class="feedback-checkbox-row">
              <input type="checkbox" class="feedback-logs-check" checked>
              <span>Приложить последние логи</span>
            </label>
          </div>
          <div class="feedback-footer">
            <button class="btn btn-secondary feedback-cancel">Отмена</button>
            <button class="btn btn-primary feedback-send">
              <span class="codicon codicon-send"></span> Отправить
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const closeDialog = () => overlay.remove();
      overlay.querySelector('.feedback-close').addEventListener('click', closeDialog);
      overlay.querySelector('.feedback-cancel').addEventListener('click', closeDialog);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(); });

      overlay.querySelector('.feedback-send').addEventListener('click', () => {
        const desc = overlay.querySelector('.feedback-textarea').value.trim();
        if (!desc) {
          overlay.querySelector('.feedback-textarea').style.borderColor = '#f44336';
          return;
        }
        const includeLogs = overlay.querySelector('.feedback-logs-check').checked;

        vscode.postMessage({
          type: 'sendFeedback',
          description: desc,
          provider: selectedModel?.provider || '',
          model: selectedModel?.id || '',
          version: '0.1.0',
          os: navigator.platform || '',
          vscodeVersion: typeof acquireVsCodeApi !== 'undefined' ? 'web' : '',
          logs: includeLogs ? (window.__lastLogs || '') : ''
        });
        closeDialog();
      });

      // Escape
      const esc = (e) => { if (e.key === 'Escape') { closeDialog(); document.removeEventListener('keydown', esc); } };
      document.addEventListener('keydown', esc);
      setTimeout(() => overlay.querySelector('.feedback-textarea')?.focus(), 50);
    }

    if (closeSettingsBtn) {
      closeSettingsBtn.addEventListener('click', closeSettings);
    }

    if (settingsOverlay) {
      settingsOverlay.addEventListener('click', closeSettings);
    }

    // ===== Settings Tabs =====
    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabId = tab.dataset.tab;
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        const content = document.getElementById('tab-content-' + tabId);
        if (content) content.classList.add('active');
      });
    });

    // ===== Auto-save settings on any change =====
    let saveSettingsDebounce = null;
    function autoSaveSettings() {
      if (saveSettingsDebounce) clearTimeout(saveSettingsDebounce);
      saveSettingsDebounce = setTimeout(() => {
        const autoRunTerminal = document.getElementById('auto-run-terminal');
        const ollamaUrlInput = document.getElementById('ollama-base-url');
        
        const providerSettings = {};
        document.querySelectorAll('.provider-accordion[data-provider]').forEach(acc => {
          const prov = acc.dataset.provider;
          const urlInput = acc.querySelector('.provider-url');
          const apiKeyInput = acc.querySelector('.provider-apikey');
          if (urlInput || apiKeyInput) {
            providerSettings[prov] = {};
            if (urlInput) providerSettings[prov].url = urlInput.value.trim();
            if (apiKeyInput) providerSettings[prov].apiKey = apiKeyInput.value.trim();
          }
        });

        const settings = {
          agentIterations: agentIterationsSlider ? parseInt(agentIterationsSlider.value, 10) || 5 : 5,
          autoRunTerminal: autoRunTerminal ? autoRunTerminal.checked : false,
          metricsEnabled: metricsToggle ? metricsToggle.checked : false,
          ollamaBaseUrl: ollamaUrlInput ? ollamaUrlInput.value.trim() : undefined,
          providerSettings
        };
        vscode.postMessage({ type: 'saveSettings', ...settings });
      }, 400);
    }

    // Attach auto-save to all settings inputs
    const autoRunToggle = document.getElementById('auto-run-terminal');
    const autoRunWarning = document.getElementById('auto-run-warning');
    if (autoRunToggle) {
      // Show warning initially if checked
      if (autoRunWarning && autoRunToggle.checked) {
        autoRunWarning.style.display = '';
      }
      autoRunToggle.addEventListener('change', () => {
        if (autoRunWarning) {
          autoRunWarning.style.display = autoRunToggle.checked ? '' : 'none';
        }
        autoSaveSettings();
      });
    }

    // ===== Usage Metrics Toggle =====
    const metricsToggle = document.getElementById('metrics-toggle');
    const usageMetricsPanel = document.getElementById('usage-metrics-panel');
    const METRICS_KEY = 'ashibalt_usage_metrics';
    const METRICS_ENABLED_KEY = 'ashibalt_metrics_enabled';

    // Load metrics toggle state (default: ON for new users)
    if (metricsToggle) {
      const savedEnabled = localStorage.getItem(METRICS_ENABLED_KEY);
      const isEnabled = savedEnabled === null ? true : savedEnabled === 'true'; // default ON
      metricsToggle.checked = isEnabled;
      if (isEnabled) {
        if (usageMetricsPanel) usageMetricsPanel.style.display = '';
        loadAndRenderUsageMetrics();
        // Notify extension on init so metricsService starts
        const initMetrics = getLocalMetrics();
        vscode.postMessage({ type: 'metricsToggle', enabled: true, metrics: initMetrics });
      }
      metricsToggle.addEventListener('change', () => {
        const on = metricsToggle.checked;
        localStorage.setItem(METRICS_ENABLED_KEY, on ? 'true' : 'false');
        if (usageMetricsPanel) usageMetricsPanel.style.display = on ? '' : 'none';
        if (on) {
          loadAndRenderUsageMetrics();
          const currentMetrics = getLocalMetrics();
          vscode.postMessage({ type: 'metricsToggle', enabled: true, metrics: currentMetrics });
        } else {
          vscode.postMessage({ type: 'metricsToggle', enabled: false });
        }
        autoSaveSettings();
      });
    }

    /** Get current accumulated metrics from localStorage */
    function getLocalMetrics() {
      try {
        const saved = localStorage.getItem(METRICS_KEY);
        if (saved) {
          const m = JSON.parse(saved);
          // Migration: old schema -> new schema
          if (!m.inputTokens && m.tokensSpent) {
            m.inputTokens = m.tokensSpent;
            m.outputTokens = 0;
            delete m.tokensSpent;
          }
          if (!m.toolUsage) m.toolUsage = {};
          if (!m.inputTokens) m.inputTokens = 0;
          if (!m.outputTokens) m.outputTokens = 0;
          return m;
        }
      } catch (_) {}
      return { totalRequests: 0, inputTokens: 0, outputTokens: 0, toolUsage: {}, modelUsage: {} };
    }

    /**
     * Loads usage metrics from localStorage and renders them.
     * Metrics are accumulated locally by the webview and saved persistently.
     */
    function loadAndRenderUsageMetrics() {
      const metrics = getLocalMetrics();
      renderUsageMetrics(metrics);
    }

    function renderUsageMetrics(metrics) {
      const el = (id) => document.getElementById(id);

      const totalReqs = el('metric-total-requests');
      if (totalReqs) totalReqs.textContent = formatMetricNumber(metrics.totalRequests || 0);

      const inputTok = el('metric-input-tokens');
      if (inputTok) inputTok.textContent = formatMetricNumber(metrics.inputTokens || 0);

      const outputTok = el('metric-output-tokens');
      if (outputTok) outputTok.textContent = formatMetricNumber(metrics.outputTokens || 0);

      const favModel = el('metric-favorite-model');
      if (favModel) {
        const modelUsage = metrics.modelUsage || {};
        const entries = Object.entries(modelUsage);
        if (entries.length > 0) {
          entries.sort((a, b) => b[1] - a[1]);
          let name = entries[0][0];
          if (name.includes('/')) name = name.split('/').pop();
          favModel.textContent = name;
          favModel.title = entries[0][0];
        } else {
          favModel.textContent = '—';
        }
      }

    }

    function formatMetricNumber(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return String(n);
    }

    /**
     * Track a usage event (called after agent loop completes).
     * Accumulates locally: totalRequests++, filesEdited += count, tokensSpent += tokens.
     */
    function trackUsageEvent(data) {
      const metrics = getLocalMetrics();

      if (data.requests) metrics.totalRequests += data.requests;
      if (data.inputTokens) metrics.inputTokens += data.inputTokens;
      if (data.outputTokens) metrics.outputTokens += data.outputTokens;
      if (data.model) {
        metrics.modelUsage[data.model] = (metrics.modelUsage[data.model] || 0) + 1;
      }
      if (data.tool) {
        if (!metrics.toolUsage) metrics.toolUsage = {};
        metrics.toolUsage[data.tool] = (metrics.toolUsage[data.tool] || 0) + 1;
      }

      localStorage.setItem(METRICS_KEY, JSON.stringify(metrics));

      // Re-render if panel is visible
      if (usageMetricsPanel && usageMetricsPanel.style.display !== 'none') {
        renderUsageMetrics(metrics);
      }
    }

    // Agent iterations slider — auto-save on change (not input, to avoid spam)
    if (agentIterationsSlider && agentIterationsValue) {
      agentIterationsSlider.addEventListener('input', () => {
        agentIterationsValue.textContent = agentIterationsSlider.value;
      });
      agentIterationsSlider.addEventListener('change', autoSaveSettings);
    }

    // Provider inputs — auto-save on blur (when user leaves the input field)
    document.querySelectorAll('.provider-url, .provider-apikey').forEach(input => {
      input.addEventListener('change', autoSaveSettings);
    });

    // Ollama URL — auto-save on blur
    const ollamaUrlEl = document.getElementById('ollama-base-url');
    if (ollamaUrlEl) {
      ollamaUrlEl.addEventListener('change', autoSaveSettings);
    }

    // ===== Generic Provider UI =====

    // Fetch models buttons (all providers)
    document.querySelectorAll('.provider-fetch-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const provider = btn.dataset.provider;
        if (!provider) return;
        const accordion = btn.closest('.provider-accordion');
        if (!accordion) return;
        
        const urlInput = accordion.querySelector('.provider-url');
        const apiKeyInput = accordion.querySelector('.provider-apikey');
        
        const url = urlInput ? urlInput.value.trim() : '';
        const apiKey = apiKeyInput ? apiKeyInput.value.trim() : '';

        // Save URL if changed (for ollama backward compat)
        if (provider === 'ollama' && url) {
          vscode.postMessage({ type: 'saveSettings', ollamaBaseUrl: url });
        }

        btn.classList.add('loading');
        vscode.postMessage({ 
          type: 'fetchProviderModels', 
          provider, 
          url, 
          apiKey 
        });
        
        // Remove loading after timeout (in case no response)
        setTimeout(() => btn.classList.remove('loading'), 10000);
      });
    });

    // Clear All Models button
    if (clearAllModelsBtn) {
      clearAllModelsBtn.addEventListener('click', () => {
        if (confirm('Удалить все сохранённые модели?')) {
          vscode.postMessage({ type: 'clearAllModels' });
        }
      });
    }

    // Add model buttons (all providers)
    document.querySelectorAll('.provider-add-model-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const provider = btn.dataset.provider;
        if (!provider) return;
        const accordion = btn.closest('.provider-accordion');
        if (!accordion) return;

        const modelIdInput = accordion.querySelector('.provider-model-id');
        if (!modelIdInput) return;

        const modelId = modelIdInput.value.trim();
        if (!modelId) return;

        // Create display name from model ID
        const nameParts = modelId.split('/');
        const displayName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : modelId;
        const modelName = displayName.charAt(0).toUpperCase() + displayName.slice(1);

        vscode.postMessage({
          type: 'saveModel',
          model: {
            id: modelId,
            name: modelName,
            provider: provider
          }
        });

        modelIdInput.value = '';
      });
    });

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
          // Track cumulative token deltas (input/output separate) + iterations
          if (metricsToggle && metricsToggle.checked && message.metrics) {
            const inNow = message.metrics.inputTokens || 0;
            const outNow = message.metrics.outputTokens || 0;
            const inDelta = inNow - (window.__lastInputTokens || 0);
            const outDelta = outNow - (window.__lastOutputTokens || 0);
            const eventData = {};
            if (inDelta > 0) eventData.inputTokens = inDelta;
            if (outDelta > 0) eventData.outputTokens = outDelta;
            trackUsageEvent(eventData);
            window.__lastInputTokens = inNow;
            window.__lastOutputTokens = outNow;
          }
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
              if (msg.dataset.needsFooter) {
                const content = msg.dataset.raw || '';
                const modelName = msg.dataset.modelName || '';
                appendFooterToMessage(msg, content, modelName);
              }
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
          if (metricsDash) metricsDash.remove();
          window.__lastMetricsTokens = 0;
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
          renderHistory(message.sessions);
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
              sendBtn.innerHTML = '<span class="codicon codicon-debug-stop"></span>';
              sendBtn.dataset.state = 'stop';
              sendBtn.style.background = 'var(--vscode-errorForeground, #f44336)';
              sendBtn.style.color = '#fff';
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
              // Keep metrics dashboard at the bottom
              const md = document.getElementById('metrics-dashboard');
              if (md) chatContainer.appendChild(md);
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
              sendBtn.innerHTML = '<span class="codicon codicon-send"></span>';
              sendBtn.dataset.state = 'send';
              sendBtn.style.background = 'var(--accent-color)';
              sendBtn.style.color = 'var(--accent-fg)';
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
            if (metricsToggle && metricsToggle.checked) trackUsageEvent({ tool: 'read_file' });
          } else {
            showFileReadAction(message);
            if (metricsToggle && metricsToggle.checked) trackUsageEvent({ tool: 'read_file' });
          }
          break;
        case 'fileEditAction':
          if (message.fileAction) {
            showFileEditAction({
              ...message.fileAction,
              replyTo: message.id
            });
            if (metricsToggle && metricsToggle.checked) trackUsageEvent({ tool: 'edit_file' });
          }
          break;
        case 'fileCreateAction':
          if (message.fileAction) {
            showFileCreateAction({
              ...message.fileAction,
              replyTo: message.id
            });
            if (metricsToggle && metricsToggle.checked) trackUsageEvent({ tool: 'create_file' });
          }
          break;
        case 'fileDeleteAction':
          if (message.fileAction) {
            showFileDeleteAction({
              ...message.fileAction,
              replyTo: message.id
            });
            if (metricsToggle && metricsToggle.checked) trackUsageEvent({ tool: 'delete_file' });
          }
          break;
        case 'webSearchStart':
          showWebSearchLoading(message.id, message.query);
          break;
        case 'webSearchResult':
          showWebSearchResult(message.id, message.success, message.query, message.results, message.resultsCount);
          if (metricsToggle && metricsToggle.checked) trackUsageEvent({ tool: 'web_search' });
          break;
        case 'searchResult':
          showCodeSearchResult(message.id, message.success, message.query, message.mode, message.results, message.totalResults);
          if (metricsToggle && metricsToggle.checked) trackUsageEvent({ tool: 'search' });
          break;
        case 'terminalConfirm':
          showTerminalConfirmation(message.command, message.workingDir, message.id);
          break;
        case 'toolApproval':
          showToolApproval(message.toolName, message.args, message.id);
          break;
        case 'iterationConfirm':
          showIterationConfirmation();
          break;
        case 'terminalRunning':
          showTerminalRunning(message.id, message.command);
          break;
        case 'terminalResult':
          showTerminalResult(message.id, message.command, message.output, message.exitCode, message.success, message.rejected, message.error);
          if (metricsToggle && metricsToggle.checked) trackUsageEvent({ tool: 'terminal' });
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
      // Keep metrics dashboard at the bottom (re-append after new message)
      const metricsDash = document.getElementById('metrics-dashboard');
      if (metricsDash) chatContainer.appendChild(metricsDash);
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
     * Creates a compact tool action element for session history restore.
     * Handles: terminal, search, web_search, diagnose, list_files, fetch_url, run_tests, find_references
     */
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

    // Show file read action indicator under a message
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

    // Show list_files result indicator under a message
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
      }

      const toolLabels = {
        'read_file': 'Прочитать файл',
        'list_files': 'Список файлов',
        'search': 'Поиск',
        'web_search': 'Веб-поиск',
        'diagnose': 'Диагностика',
        'fetch_url': 'Загрузить URL'
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

    // Helper to get file icon name based on extension (mirrors iconMap.ts)
    function getFileIcon(filename) {
      if (!filename) return 'default_file.svg';
      const lowerFilename = filename.toLowerCase();
      
      // Check full filename first
      const filenameMap = {
        "package.json": "file_type_npm.svg",
        "package-lock.json": "file_type_npm.svg",
        "tsconfig.json": "file_type_tsconfig.svg",
        "jsconfig.json": "file_type_jsconfig.svg",
        "readme.md": "file_type_markdown.svg",
        "dockerfile": "file_type_docker.svg",
        "docker-compose.yml": "file_type_docker.svg",
        "docker-compose.yaml": "file_type_docker.svg",
        "vite.config.js": "file_type_vite.svg",
        "vite.config.ts": "file_type_vite.svg",
        "webpack.config.js": "file_type_webpack.svg",
        ".gitignore": "file_type_git.svg",
        ".env": "file_type_dotenv.svg",
        "yarn.lock": "file_type_yarn.svg",
        "pnpm-lock.yaml": "file_type_pnpm.svg"
      };
      
      if (filenameMap[lowerFilename]) {
        return filenameMap[lowerFilename];
      }
      
      // Check extension
      const extensionMap = {
        'ts': 'file_type_typescript.svg',
        'd.ts': 'file_type_typescriptdef.svg',
        'tsx': 'file_type_reactts.svg',
        'js': 'file_type_js.svg',
        'mjs': 'file_type_js.svg',
        'cjs': 'file_type_js.svg',
        'jsx': 'file_type_reactjs.svg',
        'json': 'file_type_json.svg',
        'md': 'file_type_markdown.svg',
        'css': 'file_type_css.svg',
        'scss': 'file_type_scss.svg',
        'sass': 'file_type_sass.svg',
        'less': 'file_type_less.svg',
        'html': 'file_type_html.svg',
        'htm': 'file_type_html.svg',
        'py': 'file_type_python.svg',
        'java': 'file_type_java.svg',
        'c': 'file_type_c.svg',
        'cpp': 'file_type_cpp.svg',
        'h': 'file_type_cheader.svg',
        'hpp': 'file_type_cppheader.svg',
        'go': 'file_type_go.svg',
        'rs': 'file_type_rust.svg',
        'rb': 'file_type_ruby.svg',
        'php': 'file_type_php.svg',
        'sh': 'file_type_shell.svg',
        'bash': 'file_type_shell.svg',
        'yml': 'file_type_yaml.svg',
        'yaml': 'file_type_yaml.svg',
        'xml': 'file_type_xml.svg',
        'sql': 'file_type_sql.svg',
        'svg': 'file_type_svg.svg',
        'png': 'file_type_image.svg',
        'jpg': 'file_type_image.svg',
        'jpeg': 'file_type_image.svg',
        'gif': 'file_type_image.svg',
        'txt': 'file_type_text.svg',
        'log': 'file_type_log.svg',
        'vue': 'file_type_vue.svg',
        'svelte': 'file_type_svelte.svg',
        'lua': 'file_type_lua.svg',
        'kt': 'file_type_kotlin.svg',
        'swift': 'file_type_swift.svg',
        'dart': 'file_type_dartlang.svg',
        'cs': 'file_type_csharp.svg',
        'toml': 'file_type_toml.svg',
        'ini': 'file_type_ini.svg',
        'env': 'file_type_dotenv.svg'
      };
      
      const parts = lowerFilename.split('.');
      if (parts.length > 1) {
        // Check for double extension like .d.ts
        if (parts.length > 2) {
          const doubleExt = parts.slice(-2).join('.');
          if (extensionMap[doubleExt]) {
            return extensionMap[doubleExt];
          }
        }
        const ext = parts.pop();
        if (ext && extensionMap[ext]) {
          return extensionMap[ext];
        }
      }
      return 'default_file.svg';
    }

    function escapeHtml(s) {
      if (!s) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function markLatestAssistantMessage() {
      const assistantMessages = chatContainer.querySelectorAll('.message.assistant');
      assistantMessages.forEach(msg => msg.classList.remove('is-latest'));
      if (assistantMessages.length > 0) {
        const lastAssistant = assistantMessages[assistantMessages.length - 1];
        lastAssistant.classList.add('is-latest');
      }
    }

    function removeLastAssistantMessage() {
      if (!chatContainer) return;
      // find last assistant message in DOM order
      const assistantNodes = Array.from(chatContainer.querySelectorAll('.message.assistant'));
      if (assistantNodes.length === 0) {
        // nothing to remove
        return;
      }
      const lastAssistant = assistantNodes[assistantNodes.length - 1];
      // Remove ONLY the assistant message, NOT the user message
      // This is used by "Retry" action which should keep the user message intact
      chatContainer.removeChild(lastAssistant);

      // Recalculate lastUserMessageId to the last remaining user message id in DOM
      const remainingUsers = Array.from(chatContainer.querySelectorAll('.message.user'));
      if (remainingUsers.length > 0) {
        lastUserMessageId = remainingUsers[remainingUsers.length - 1].dataset.msgId || null;
      } else {
        lastUserMessageId = null;
      }

      markLatestAssistantMessage();
      saveChatState();
    }

    function removeMessageById(messageId) {
      if (!chatContainer || !messageId) return;
      const target = chatContainer.querySelector(`.message[data-msg-id="${messageId}"]`);
      if (!target) return;
      const wasUser = target.classList.contains('user');
      chatContainer.removeChild(target);

      if (wasUser) {
        const remainingUsers = Array.from(chatContainer.querySelectorAll('.message.user'));
        if (remainingUsers.length > 0) {
          lastUserMessageId = remainingUsers[remainingUsers.length - 1].dataset.msgId || null;
        } else {
          lastUserMessageId = null;
        }
      }

      markLatestAssistantMessage();
      saveChatState();
    }

    // === Pending Changes Dashboard ===
    const pendingDashboard = document.getElementById('pending-changes-dashboard');
    const dashboardCount = document.getElementById('dashboard-count');
    const dashboardTotalStats = document.getElementById('dashboard-total-stats');
    const dashboardFiles = document.getElementById('dashboard-files');
    const dashboardBody = document.getElementById('dashboard-body');
    const dashboardToggle = document.getElementById('dashboard-toggle');
    const confirmAllBtn = document.getElementById('confirm-all-btn');
    const revertAllBtn = document.getElementById('revert-all-btn');

    let dashboardCollapsed = false;

    if (dashboardToggle) {
      dashboardToggle.addEventListener('click', () => {
        dashboardCollapsed = !dashboardCollapsed;
        dashboardToggle.classList.toggle('collapsed', dashboardCollapsed);
        dashboardBody.classList.toggle('collapsed', dashboardCollapsed);
      });
    }

    if (confirmAllBtn) {
      confirmAllBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'confirmAllSnapshots' });
      });
    }

    if (revertAllBtn) {
      revertAllBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'revertAllSnapshots' });
      });
    }

    function updatePendingDashboard(data) {
      if (!pendingDashboard) return;

      const { snapshots, stats } = data;
      const count = snapshots ? snapshots.length : 0;

      if (count === 0) {
        pendingDashboard.style.display = 'none';
        return;
      }

      pendingDashboard.style.display = 'block';

      // New architecture: each snapshot = one file with multiple changes
      const groupedFiles = snapshots.map(s => ({
        filePath: s.filePath,
        fileName: s.fileName,
        linesAdded: s.totalLinesAdded || s.linesAdded || 0,
        linesRemoved: s.totalLinesRemoved || s.linesRemoved || 0,
        snapshotId: s.id,
        changeCount: s.changes ? s.changes.length : 1
      }));
      
      dashboardCount.textContent = groupedFiles.length;

      // Update total stats in header
      if (dashboardTotalStats && stats) {
        dashboardTotalStats.innerHTML = `<span class="added">+${stats.totalAdded}</span> <span class="removed">-${stats.totalRemoved}</span>`;
      
        dashboardFiles.innerHTML = groupedFiles.map(f => `
          <div class="dashboard-file" data-path="${escapeHtml(f.filePath)}" data-id="${escapeHtml(f.snapshotId)}">
            <div class="dashboard-file-info">
              <span class="codicon codicon-file dashboard-file-icon"></span>
              <span class="dashboard-file-name" title="${escapeHtml(f.filePath)}">${escapeHtml(f.fileName)}</span>
              ${f.changeCount > 1 ? `<span class="dashboard-file-tool">${f.changeCount} изм.</span>` : ''}
            </div>
            <div class="dashboard-file-stats">
              <span class="added">+${f.linesAdded}</span>
              <span class="removed">-${f.linesRemoved}</span>
            </div>
            <div class="dashboard-file-actions">
              <button class="file-action-btn confirm" data-path="${escapeHtml(f.filePath)}" title="Подтвердить">
                <span class="codicon codicon-check"></span>
              </button>
              <button class="file-action-btn revert" data-path="${escapeHtml(f.filePath)}" title="Откатить">
                <span class="codicon codicon-discard"></span>
              </button>
            </div>
          </div>
        `).join('');

        // Add event listeners for individual file actions
        dashboardFiles.querySelectorAll('.file-action-btn.confirm').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const filePath = btn.dataset.path;
            vscode.postMessage({ type: 'confirmFile', filePath });
          });
        });

        dashboardFiles.querySelectorAll('.file-action-btn.revert').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const filePath = btn.dataset.path;
            vscode.postMessage({ type: 'revertFile', filePath });
          });
        });

        // Click on file row to open/navigate
        dashboardFiles.querySelectorAll('.dashboard-file').forEach(row => {
          row.addEventListener('click', () => {
            const filePath = row.dataset.path;
            vscode.postMessage({ type: 'openSnapshotFile', filePath });
          });
        });
      }
    }

    // Auth system disabled — initialize selectors as unlocked
    updateAuthUI(null);
    updateSelectorsForTier('pro');

    // Restore chat on load
    loadChatState();

    // Confirmation UI for iteration limit
    function showIterationConfirmation() {
      // Remove any existing confirmation dialog
      const existing = document.querySelector('.iteration-confirm-inline');
      if (existing) existing.remove();
      
      // Find target message to append to (last assistant message)
      const assistants = chatContainer.querySelectorAll('.message.assistant');
      const targetMsg = assistants.length > 0 ? assistants[assistants.length - 1] : chatContainer;
      
      const messageContent = targetMsg.querySelector('.message-content') || targetMsg;
      
      const actionEl = document.createElement('div');
      actionEl.className = 'iteration-confirm-inline';
      
      actionEl.innerHTML = `
        <div class="terminal-confirm-box">
          <div class="terminal-confirm-label">
            <span class="codicon codicon-sync"></span>
            Лимит итераций исчерпан. Продолжить?
          </div>
          <div class="terminal-confirm-actions">
            <button class="terminal-confirm-btn allow" id="iteration-confirm-yes">
              Продолжить (+5)
            </button>
            <button class="terminal-confirm-btn deny" id="iteration-confirm-no">
              Остановить
            </button>
          </div>
        </div>
      `;
      
      messageContent.appendChild(actionEl);
      
      // Add event handlers
      actionEl.querySelector('#iteration-confirm-yes').addEventListener('click', () => {
        vscode.postMessage({ type: 'iterationConfirmResponse', confirmed: true });
        actionEl.remove();
      });
      
      actionEl.querySelector('#iteration-confirm-no').addEventListener('click', () => {
        vscode.postMessage({ type: 'iterationConfirmResponse', confirmed: false });
        actionEl.remove();
      });
      
      scrollToBottom();
    }

    // ======== Metrics Dashboard ========
    function updateMetricsDashboard(metrics) {
      let dashboard = document.getElementById('metrics-dashboard');
      if (!dashboard) {
        dashboard = document.createElement('div');
        dashboard.id = 'metrics-dashboard';
        dashboard.className = 'metrics-dashboard';
        // Insert at end of chat container (sticky at bottom)
        const chatCtr = document.getElementById('chat-container');
        if (chatCtr) {
          chatCtr.appendChild(dashboard);
        }
      }

      const inputK = (metrics.inputTokens / 1000).toFixed(1);
      const outputK = (metrics.outputTokens / 1000).toFixed(1);
      const ctxK = (metrics.currentContextTokens / 1000).toFixed(1);
      const limitK = metrics.contextLimit ? Math.round(metrics.contextLimit / 1000) : null;
      const ctxDisplay = limitK ? `${ctxK}K/${limitK}K` : `${ctxK}K`;

      let cacheHtml = '';
      if (metrics.cachedTokens !== undefined && metrics.cachedTokens > 0) {
        const cachedK = (metrics.cachedTokens / 1000).toFixed(1);
        cacheHtml = `
        <span class="metrics-separator"></span>
        <span class="metrics-item metrics-cache" title="Кэшированных токенов (prompt cache hit)">
          <span class="codicon codicon-zap"></span> ${cachedK}K cache
        </span>`;
      } else {
        cacheHtml = `
        <span class="metrics-separator"></span>
        <span class="metrics-item metrics-no-cache" title="Модель или провайдер не поддерживает кэширование промптов">
          <span class="codicon codicon-circle-slash"></span> No cache
        </span>`;
      }

      dashboard.innerHTML = `
        <span class="metrics-item" title="API-вызовов в этой задаче">
          <span class="codicon codicon-arrow-swap"></span> ${metrics.apiCalls}
        </span>
        <span class="metrics-item" title="Входных токенов (суммарно)">
          <span class="codicon codicon-arrow-down"></span> ${inputK}K
        </span>
        <span class="metrics-item" title="Выходных токенов (суммарно)">
          <span class="codicon codicon-arrow-up"></span> ${outputK}K
        </span>
        <span class="metrics-item" title="Текущий контекст / Лимит модели">
          <span class="codicon codicon-database"></span> ${ctxDisplay}
        </span>${cacheHtml}
      `;
      dashboard.style.display = 'flex';
    }

    // ===== Session Switch Confirmation Dialog =====
    function showSessionSwitchDialog() {
      // Remove existing dialog if present
      const existing = document.getElementById('session-switch-dialog');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'session-switch-dialog';
      overlay.className = 'session-switch-overlay';
      overlay.innerHTML = `
        <div class="session-switch-card">
          <div class="session-switch-title">
            <span class="codicon codicon-warning"></span>
            Несохранённые изменения
          </div>
          <p class="session-switch-text">Есть ожидающие изменения файлов. Что сделать перед переключением?</p>
          <div class="session-switch-actions">
            <button class="btn btn-primary session-switch-btn" data-action="save">
              <span class="codicon codicon-save"></span> Сохранить
            </button>
            <button class="btn btn-secondary session-switch-btn" data-action="revert">
              <span class="codicon codicon-discard"></span> Откатить
            </button>
            <button class="btn btn-ghost session-switch-btn" data-action="cancel">Отмена</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      // Animate in
      requestAnimationFrame(() => overlay.classList.add('visible'));

      overlay.addEventListener('click', (e) => {
        const btn = e.target.closest('.session-switch-btn');
        if (!btn) return;
        const action = btn.dataset.action;
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 200);
        vscode.postMessage({ type: 'sessionSwitchConfirmed', action });
      });
    }
})();
