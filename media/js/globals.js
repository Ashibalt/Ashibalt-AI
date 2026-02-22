/* ================================================================
   GLOBALS — инициализация, DOM-ссылки, переменные состояния,
             функции авторизации, обработчик вставки, saveChatState
   ================================================================ */
/* Extracted script for chatView webview. Requires marked.js and highlight.js to be available. */

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
    
    // SVG icons for send button states
    const SEND_ICON_SVG = '<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
    const STOP_ICON_SVG = '<svg width="12" height="12" fill="currentColor" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2"/></svg>';

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
    const assignCodeSelect = null; // removed from UI, kept to avoid ReferenceError
    const configPathDisplay = document.getElementById('config-path-display'); // may be null if element doesn't exist

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
    // Helper to render markdown content to HTML
    function renderMarkdown(content) {
      return marked.parse(content || '');
    }