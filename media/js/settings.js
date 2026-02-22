/* ================================================================
   SETTINGS — панель настроек, метрики использования,
              провайдеры, слайдер итераций
   ================================================================ */

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
      reportBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'sendFeedback' });
      });
    }

    if (closeSettingsBtn) {
      closeSettingsBtn.addEventListener('click', closeSettings);
    }

    if (settingsOverlay) {
      settingsOverlay.addEventListener('click', closeSettings);
    }

    // ===== Settings Nav (Variant C split-panel) =====
    document.querySelectorAll('.sp-nav-item').forEach(item => {
      item.addEventListener('click', () => {
        const tabId = item.dataset.tab;
        document.querySelectorAll('.sp-nav-item').forEach(i => i.classList.remove('active'));
        document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
        item.classList.add('active');
        const content = document.getElementById('tab-content-' + tabId);
        if (content) content.classList.add('active');
      });
    });

    // ===== Settings Tabs (legacy — kept for compatibility) =====
    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabId = tab.dataset.tab;
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.sp-nav-item').forEach(i => i.classList.remove('active'));
        document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        const navItem = document.querySelector(`.sp-nav-item[data-tab="${tabId}"]`);
        if (navItem) navItem.classList.add('active');
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
        loadAndRenderUsageMetrics();
        // Notify extension on init so metricsService starts
        const initMetrics = getLocalMetrics();
        vscode.postMessage({ type: 'metricsToggle', enabled: true, metrics: initMetrics });
      }
      metricsToggle.addEventListener('change', () => {
        const on = metricsToggle.checked;
        localStorage.setItem(METRICS_ENABLED_KEY, on ? 'true' : 'false');
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
