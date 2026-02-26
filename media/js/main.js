/* ================================================================
   MAIN — утилиты (getFileIcon, escapeHtml), маркер последнего
          сообщения, Pending Dashboard, инициализация, диалоги
   ================================================================ */

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

    // === Tasks Panel ===
    const tasksPanel = document.getElementById('tasks-panel');
    const tasksListEl = document.getElementById('tasks-list');
    const tasksPanelToggle = document.getElementById('tasks-panel-toggle');
    const tasksPanelBody = document.getElementById('tasks-panel-body');
    let tasksPanelCollapsed = false;

    if (tasksPanelToggle) {
      tasksPanelToggle.addEventListener('click', () => {
        tasksPanelCollapsed = !tasksPanelCollapsed;
        tasksPanelToggle.setAttribute('aria-expanded', String(!tasksPanelCollapsed));
        const ico = tasksPanelToggle.querySelector('.codicon');
        if (ico) ico.className = tasksPanelCollapsed ? 'codicon codicon-chevron-right' : 'codicon codicon-chevron-down';
        if (tasksPanelBody) tasksPanelBody.classList.toggle('collapsed', tasksPanelCollapsed);
      });
    }

    function renderTasksPanel(tasks) {
      if (!tasksPanel || !tasksListEl) return;
      if (!tasks || tasks.length === 0) {
        tasksPanel.style.display = 'none';
        return;
      }
      tasksPanel.style.display = 'block';
      const allDone = tasks.every(t => !!t.done);
      tasksListEl.innerHTML = tasks.map((t, i) => {
        const isDone = !!t.done;
        return `<li class="${isDone ? 'task-done' : ''}">
          <span class="task-check ${isDone ? 'done' : 'pending'} codicon ${isDone ? 'codicon-check' : 'codicon-circle-outline'}"></span>
          <span class="task-text">${escapeHtml(t.text)}</span>
        </li>`;
      }).join('');
      // Show/hide close button
      let closeBtn = tasksPanel.querySelector('.tasks-panel-close');
      if (!closeBtn) {
        closeBtn = document.createElement('button');
        closeBtn.className = 'tasks-panel-close';
        closeBtn.title = 'Закрыть задачи';
        closeBtn.innerHTML = '<span class="codicon codicon-close"></span>';
        closeBtn.addEventListener('click', () => {
          tasksPanel.style.display = 'none';
        });
        const header = tasksPanel.querySelector('.tasks-panel-header');
        if (header) header.appendChild(closeBtn);
      }
      closeBtn.style.display = allDone ? 'inline-flex' : 'none';
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
        const inputCtr = document.querySelector('.input-container');
        if (inputCtr) inputCtr.classList.remove('has-pending');
        return;
      }

      pendingDashboard.style.display = 'block';
      const inputCtr2 = document.querySelector('.input-container');
      if (inputCtr2) inputCtr2.classList.add('has-pending');

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
      if (!dashboard) return;

      const inputK = (metrics.inputTokens / 1000).toFixed(1);
      const outputK = (metrics.outputTokens / 1000).toFixed(1);
      const ctxK = (metrics.currentContextTokens / 1000).toFixed(1);
      const limitK = metrics.contextLimit ? Math.round(metrics.contextLimit / 1000) : null;
      const ctxDisplay = limitK ? `${ctxK}K/${limitK}K` : `${ctxK}K`;
      const cacheDisplay = metrics.cachedTokens !== undefined && metrics.cachedTokens > 0
        ? `${(metrics.cachedTokens / 1000).toFixed(1)}K`
        : 'No';
      const cacheClass = metrics.cachedTokens !== undefined && metrics.cachedTokens > 0 ? '' : ' metrics-no-cache';

      // Build per-model cost rows
      let costRowsHtml = '';
      if (metrics.modelCosts && typeof metrics.modelCosts === 'object') {
        for (const [fullModel, cost] of Object.entries(metrics.modelCosts)) {
          if (!cost || cost === 0) continue;
          const shortName = fullModel.includes('/') ? fullModel.split('/').pop() : fullModel;
          const costStr = cost < 0.001 ? `$${cost.toFixed(6)}` : `$${cost.toFixed(4)}`;
          costRowsHtml += `
        <div class="metrics-line metrics-cost-row" title="Стоимость запросов модели ${fullModel} в этой сессии">
          <span class="metrics-key">${shortName}:</span>
          <span class="metrics-value metrics-cost">${costStr}</span>
        </div>`;
        }
      }

      // Preserve current balance value if already shown
      const prevBalRow = dashboard.querySelector('.metrics-balance-row');
      const prevBalHtml = prevBalRow ? prevBalRow.outerHTML : '';

      dashboard.innerHTML = `
        <div class="metrics-line" title="Лимит итераций в сессии">
          <span class="metrics-key">Iteration:</span>
          <span class="metrics-value">${metrics.apiCalls}</span>
        </div>
        <div class="metrics-line" title="Входные токены (суммарно)">
          <span class="metrics-key">Input:</span>
          <span class="metrics-value">${inputK}K</span>
        </div>
        <div class="metrics-line" title="Выходные токены (суммарно)">
          <span class="metrics-key">Output:</span>
          <span class="metrics-value">${outputK}K</span>
        </div>
        <div class="metrics-line" title="Текущий контекст / лимит модели">
          <span class="metrics-key">Context:</span>
          <span class="metrics-value">${ctxDisplay}</span>
        </div>
        <div class="metrics-line" title="Кэшированные токены (prompt cache hit)">
          <span class="metrics-key">Cache hit:</span>
          <span class="metrics-value${cacheClass}">${cacheDisplay}</span>
        </div>${costRowsHtml}${prevBalHtml}
      `;

      if (metricsFabWrap) {
        metricsFabWrap.style.display = 'flex';
      }
    }

    // ======== Balance Display ========
    function updateBalanceDisplay(balance) {
      const dashboard = document.getElementById('metrics-dashboard');
      if (!dashboard) return;
      let balRow = dashboard.querySelector('.metrics-balance-row');
      if (!balRow) {
        balRow = document.createElement('div');
        balRow.className = 'metrics-line metrics-balance-row';
        balRow.title = 'Текущий баланс OpenRouter';
        dashboard.appendChild(balRow);
      }
      const balStr = typeof balance === 'number' ? `$${balance.toFixed(2)}` : '—';
      balRow.innerHTML = `<span class="metrics-key">Balance:</span><span class="metrics-value">${balStr}</span>`;
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
