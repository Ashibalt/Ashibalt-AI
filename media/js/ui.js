/* ================================================================
   UI — загрузка состояния, модель, режимы, отправка сообщений,
        история, браузер моделей, копирование, контекст
   ================================================================ */

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
      const selLabel = modelSelector.querySelector('.sel-label');
      if (!selLabel) return;
      const text = label?.trim();
      selLabel.textContent = text || MODEL_PLACEHOLDER;
      const isEmpty = !text || text === MODEL_PLACEHOLDER;
      modelSelector.classList.toggle('model-empty', isEmpty);
      modelSelector.classList.toggle('model-active', !isEmpty);
      if (!isEmpty) {
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
          vscode.postMessage({ type: 'openExternal', url: 'https://telegra.ph/Besplatno-1mlrd-tokenov-v-mesyac-02-17' });
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

    // Mode selector (Agent/Chat) — new dropdown-based design
    function updateModeSelectorUI() {
      if (!modeSelector) return;
      const label = modeSelector.querySelector('.sel-label') || document.getElementById('mode-label');
      if (label) {
        label.textContent = currentMode === 'agent' ? 'Agent' : 'Ask';
      }
      modeSelector.classList.toggle('active', currentMode === 'agent');
      modeSelector.title = currentMode === 'agent' 
        ? 'Режим агента: полный доступ к инструментам'
        : 'Режим чата: чтение файлов, поиск, диагностика';

      // Update dropdown items selection state
      const modeMenu = document.getElementById('mode-menu');
      if (modeMenu) {
        modeMenu.querySelectorAll('.dropdown-item').forEach(item => {
          const isSelected = item.dataset.val === currentMode;
          item.classList.toggle('selected', isSelected);
          item.setAttribute('aria-selected', String(isSelected));
        });
      }
    }

    // Mode dropdown setup
    if (modeSelector) {
      const modeMenu = document.getElementById('mode-menu');

      modeSelector.addEventListener('click', (e) => {
        e.stopPropagation();
        if (modelStreaming || modeLocked) return;
        if (!modeMenu) return;
        const isOpen = modeMenu.classList.contains('open');
        // Close all dropdowns first
        document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('open'));
        document.querySelectorAll('[aria-expanded]').forEach(b => b.setAttribute('aria-expanded', 'false'));
        if (!isOpen) {
          modeMenu.classList.add('open');
          modeSelector.setAttribute('aria-expanded', 'true');
        }
      });

      if (modeMenu) {
        modeMenu.querySelectorAll('.dropdown-item').forEach(item => {
          item.addEventListener('click', () => {
            if (modelStreaming || modeLocked) return;
            const val = item.dataset.val;
            if (val && val !== currentMode) {
              currentMode = val;
              dbg('[UI] Switching mode to:', currentMode);
              updateModeSelectorUI();
              vscode.postMessage({ type: 'modeChanged', mode: currentMode });
            }
            modeMenu.classList.remove('open');
            modeSelector.setAttribute('aria-expanded', 'false');
          });
        });
      }
      
      // Initialize UI
      updateModeSelectorUI();
    }

    // Close all dropdowns on outside click
    document.addEventListener('click', () => {
      document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('open'));
      document.querySelectorAll('[aria-expanded]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('open'));
        document.querySelectorAll('[aria-expanded]').forEach(b => b.setAttribute('aria-expanded', 'false'));
      }
    });

    // Auto-resize textarea and trigger autocomplete check
    if (messageInput) {
      messageInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
        // Toggle .ready class on send button based on content
        if (sendBtn && sendBtn.dataset.state !== 'stop') {
          sendBtn.classList.toggle('ready', this.value.trim().length > 0);
        }
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
        // Track user request for usage metrics (only requests count; model tracked via metricsUpdate)
        if (metricsToggle && metricsToggle.checked) {
          trackUsageEvent({ requests: 1 });
        }
        // Change button to Stop only if not an immediate command
        if (sendBtn && !isImmediateCommand(text)) {
          sendBtn.innerHTML = STOP_ICON_SVG;
          sendBtn.dataset.state = 'stop';
          sendBtn.classList.remove('ready');
          sendBtn.classList.add('streaming');
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
        sendBtn.innerHTML = SEND_ICON_SVG;
        sendBtn.dataset.state = 'send';
        sendBtn.classList.remove('streaming');
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

      // Filter chip logic
      const chips = document.querySelectorAll('.hs-chip');
      let activeFilter = 'all';
      chips.forEach(chip => {
        if (chip.classList.contains('active')) activeFilter = chip.dataset.filter || 'all';
        chip.onclick = () => {
          chips.forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          activeFilter = chip.dataset.filter || 'all';
          buildList();
        };
      });

      // Search input
      const searchInput = document.getElementById('history-search');
      if (searchInput) {
        searchInput.oninput = () => buildList();
      }

      function buildList() {
        historyList.innerHTML = '';
        const query = searchInput ? searchInput.value.toLowerCase() : '';
        sessions.forEach(session => {
          if (query && !session.title.toLowerCase().includes(query)) return;
          // Filter by mode (agent/chat). 'all' shows everything.
          if (activeFilter !== 'all') {
            const sessionMode = session.mode || 'agent'; // default to agent for legacy sessions
            if (activeFilter === 'agent' && sessionMode !== 'agent') return;
            if (activeFilter === 'chat' && sessionMode !== 'chat') return;
          }
          const item = document.createElement('div');
          item.className = 'history-item';

          // Dot
          const dot = document.createElement('span');
          dot.className = 'hi-dot';

          // Info
          const info = document.createElement('div');
          info.className = 'hi-info';

          const titleEl = document.createElement('div');
          titleEl.className = 'hi-title';
          titleEl.textContent = session.title;

          const subEl = document.createElement('div');
          subEl.className = 'hi-sub';
          const date = new Date(session.date);
          const now = new Date();
          const isToday = date.toDateString() === now.toDateString();
          const isYesterday = new Date(now - 86400000).toDateString() === date.toDateString();
          subEl.textContent = isToday
            ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : isYesterday
              ? 'Вчера'
              : date.toLocaleDateString();

          info.appendChild(titleEl);
          info.appendChild(subEl);

          // Delete button
          const delBtn = document.createElement('button');
          delBtn.className = 'hi-delete';
          delBtn.title = 'Удалить';
          delBtn.innerHTML = '<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>';
          delBtn.onclick = (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: 'deleteSession', sessionId: session.id });
          };

          item.appendChild(dot);
          item.appendChild(info);
          item.appendChild(delBtn);

          item.addEventListener('click', () => {
            vscode.postMessage({ type: 'loadSession', sessionId: session.id });
            historySidebar.classList.remove('visible');
          });
          historyList.appendChild(item);
        });

        if (historyList.children.length === 0) {
          const empty = document.createElement('div');
          empty.style.cssText = 'padding: 20px 14px; font-size: 12px; color: var(--secondary-text); text-align: center; opacity: 0.6;';
          empty.textContent = query ? 'Ничего не найдено' : 'История пуста';
          historyList.appendChild(empty);
        }
      }

      buildList();
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
