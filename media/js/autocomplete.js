/* ================================================================
   AUTOCOMPLETE — система автодополнения для / и # в поле ввода
   ================================================================ */

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
