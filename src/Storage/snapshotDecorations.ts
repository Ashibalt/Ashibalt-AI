import * as vscode from 'vscode';
import { getSnapshotManager, FileSnapshot, FileChange } from '../Storage/snapshotManager';
import { logger } from '../logger';

// Decoration types for changed lines
let addedDecorationType: vscode.TextEditorDecorationType | null = null;
let removedLineDecorationType: vscode.TextEditorDecorationType | null = null;
let deletionMarkerDecorationType: vscode.TextEditorDecorationType | null = null;

// CodeLens provider for inline actions
let codeLensProvider: SnapshotCodeLensProvider | null = null;
let codeLensDisposable: vscode.Disposable | null = null;

// Track which files have decorations applied (normalized paths)
const decoratedFiles = new Set<string>();

// Status bar items for quick actions
let statusBarAccept: vscode.StatusBarItem | null = null;
let statusBarReject: vscode.StatusBarItem | null = null;
let statusBarDiff: vscode.StatusBarItem | null = null;

// Content provider for baseline documents (for diff view)
let baselineProvider: BaselineContentProvider | null = null;

// Debounce timer
let refreshDebounceTimer: NodeJS.Timeout | null = null;
const REFRESH_DEBOUNCE_MS = 300; // Increased from 150ms to reduce spam

// Track last refresh to avoid duplicate refreshes
let lastRefreshTime = 0;
const MIN_REFRESH_INTERVAL_MS = 200;

/**
 * Normalize file path for consistent comparison (Windows case-insensitive)
 */
function normalizePath(filePath: string): string {
  return filePath.toLowerCase().replace(/\\/g, '/');
}

/**
 * Content provider for showing baseline (original) file content in diff view
 */
class BaselineContentProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  
  provideTextDocumentContent(uri: vscode.Uri): string {
    // URI format: ashibalt-baseline:/path/to/file
    const filePath = uri.path;
    const snapshotManager = getSnapshotManager();
    const snapshot = snapshotManager.getSnapshotForFile(filePath);
    
    if (snapshot) {
      // For create_file snapshots, baselineContent is null (file didn't exist)
      // Show empty baseline so diff displays as "new file"
      return snapshot.baselineContent ?? '';
    }
    
    return '// No baseline available';
  }
  
  refresh(uri: vscode.Uri): void {
    this._onDidChange.fire(uri);
  }
}

/**
 * CodeLens provider for showing Save/Back buttons on changed lines
 */
class SnapshotCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const snapshotManager = getSnapshotManager();
    const snapshot = snapshotManager.getSnapshotForFile(document.uri.fsPath);
    
    if (!snapshot || snapshot.changes.length === 0) {
      return [];
    }

    const codeLenses: vscode.CodeLens[] = [];
    const lines = document.getText().split('\n');
    
    // Track which lines already have CodeLens to avoid duplicates
    const processedLines = new Set<number>();

    for (const change of snapshot.changes) {
      // Find current position of this change
      const startLine = findChangePosition(lines, change);
      
      // Skip if we already added CodeLens for this line
      if (processedLines.has(startLine)) {
        continue;
      }
      processedLines.add(startLine);
      
      if (startLine >= 0 && startLine < document.lineCount) {
        const range = new vscode.Range(startLine, 0, startLine, 0);
        
        // Count total changes at this position
        const changesAtLine = snapshot.changes.filter(c => 
          findChangePosition(lines, c) === startLine
        );
        
        // Aggregate stats
        let totalAdded = 0;
        let totalRemoved = 0;
        for (const c of changesAtLine) {
          totalAdded += c.newLines.length;
          totalRemoved += c.oldLines.length;
        }
        
        let changeInfo = '';
        if (totalAdded > 0 && totalRemoved > 0) {
          changeInfo = `${totalRemoved} → ${totalAdded}`;
        } else if (totalAdded > 0) {
          changeInfo = `+${totalAdded}`;
        } else if (totalRemoved > 0) {
          changeInfo = `-${totalRemoved}`;
        }
        
        // If multiple changes at same line, show count
        const changeCount = changesAtLine.length > 1 ? ` (${changesAtLine.length} edits)` : '';

        // Accept button (цвет задаётся через package.json contributes.colors или CSS)
        codeLenses.push(new vscode.CodeLens(range, {
          title: '✓ Accept',
          command: 'ashibalt.keepChange',
          arguments: [snapshot.id, change.id, document.uri.fsPath]
        }));

        // Reject button
        codeLenses.push(new vscode.CodeLens(range, {
          title: '✗ Reject',
          command: 'ashibalt.undoChange',
          arguments: [snapshot.id, change.id, document.uri.fsPath]
        }));
        
        // Show Diff button
        codeLenses.push(new vscode.CodeLens(range, {
          title: `Diff (${changeInfo})${changeCount}`,
          command: 'ashibalt.showDiff',
          arguments: [document.uri.fsPath]
        }));
      }
    }

    return codeLenses;
  }
}

/**
 * Register commands for CodeLens actions
 */
export function registerSnapshotCommands(context: vscode.ExtensionContext): void {
  // Keep (confirm) a single change
  context.subscriptions.push(
    vscode.commands.registerCommand('ashibalt.keepChange', async (snapshotId: string, changeId: string, filePath: string) => {
      const snapshotManager = getSnapshotManager();
      const snapshot = snapshotManager.getSnapshotForFile(filePath);
      
      if (!snapshot) return;
      
      // If this is the only change, confirm the entire snapshot
      if (snapshot.changes.length === 1) {
        await snapshotManager.confirmSnapshot(snapshotId);
        vscode.window.showInformationMessage('Изменение подтверждено');
      } else {
        // Remove just this change from the snapshot (keep it in file)
        const changeIndex = snapshot.changes.findIndex(c => c.id === changeId);
        if (changeIndex !== -1) {
          const change = snapshot.changes[changeIndex];
          snapshot.changes.splice(changeIndex, 1);
          snapshot.totalLinesAdded -= change.newLines.length;
          snapshot.totalLinesRemoved -= change.oldLines.length;
          
          // If no more changes, remove the snapshot
          if (snapshot.changes.length === 0) {
            await snapshotManager.confirmSnapshot(snapshotId);
          }
          
          // Trigger refresh
          refreshAllDecorations();
          codeLensProvider?.refresh();
          vscode.window.showInformationMessage('Изменение подтверждено');
        }
      }
    })
  );

  // Undo (rollback) a single change
  context.subscriptions.push(
    vscode.commands.registerCommand('ashibalt.undoChange', async (snapshotId: string, changeId: string, filePath: string) => {
      const snapshotManager = getSnapshotManager();
      
      logger.log(`[Reject] Rolling back change ${changeId} in snapshot ${snapshotId}`);
      
      const success = await snapshotManager.rollbackChange(snapshotId, changeId);
      if (success) {
        vscode.window.showInformationMessage('Изменение откачено');
        // Refresh both CodeLens and decorations
        refreshAllDecorations();
        codeLensProvider?.refresh();
      } else {
        vscode.window.showErrorMessage('Не удалось откатить изменение');
      }
    })
  );

  // Keep all changes in file
  context.subscriptions.push(
    vscode.commands.registerCommand('ashibalt.keepAllChanges', async (filePath: string) => {
      const snapshotManager = getSnapshotManager();
      await snapshotManager.confirmFile(filePath);
      vscode.window.showInformationMessage('Все изменения подтверждены');
      codeLensProvider?.refresh();
    })
  );

  // Undo all changes in file
  context.subscriptions.push(
    vscode.commands.registerCommand('ashibalt.undoAllChanges', async (filePath: string) => {
      const snapshotManager = getSnapshotManager();
      await snapshotManager.rollbackFile(filePath);
      vscode.window.showInformationMessage('Все изменения откачены');
      codeLensProvider?.refresh();
    })
  );

  // Show diff between baseline and current file
  context.subscriptions.push(
    vscode.commands.registerCommand('ashibalt.showDiff', async (filePath: string) => {
      const snapshotManager = getSnapshotManager();
      const snapshot = snapshotManager.getSnapshotForFile(filePath);
      
      if (!snapshot) {
        vscode.window.showWarningMessage('Нет сохранённого baseline для сравнения');
        return;
      }
      
      // Create URIs for diff
      const currentUri = vscode.Uri.file(filePath);
      const baselineUri = vscode.Uri.parse(`ashibalt-baseline:${filePath}`);
      
      // Open diff editor
      const fileName = filePath.split(/[/\\]/).pop() || 'file';
      await vscode.commands.executeCommand('vscode.diff', 
        baselineUri, 
        currentUri, 
        `${fileName} (Original ↔ Modified)`
      );
    })
  );
  
  // Accept all changes for current file (from status bar)
  context.subscriptions.push(
    vscode.commands.registerCommand('ashibalt.acceptCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      
      const filePath = editor.document.uri.fsPath;
      const snapshotManager = getSnapshotManager();
      await snapshotManager.confirmFile(filePath);
      vscode.window.showInformationMessage('✓ Все изменения приняты');
      codeLensProvider?.refresh();
      updateStatusBar();
    })
  );
  
  // Reject all changes for current file (from status bar)
  context.subscriptions.push(
    vscode.commands.registerCommand('ashibalt.rejectCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      
      const filePath = editor.document.uri.fsPath;
      const snapshotManager = getSnapshotManager();
      await snapshotManager.rollbackFile(filePath);
      vscode.window.showInformationMessage('✗ Все изменения откачены');
      codeLensProvider?.refresh();
      updateStatusBar();
    })
  );
  
  // Show diff for current file (from status bar)
  context.subscriptions.push(
    vscode.commands.registerCommand('ashibalt.diffCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      
      await vscode.commands.executeCommand('ashibalt.showDiff', editor.document.uri.fsPath);
    })
  );
}

/**
 * Initialize and update status bar items
 * DISABLED - status bar buttons removed per user request
 */
function updateStatusBar(): void {
  // Status bar items disabled
  return;
}

function hideStatusBar(): void {
  // Status bar items disabled
  return;
}

/**
 * Initialize decoration types (call once at extension activation)
 */
export function initDecorations(): void {
  // Added/modified lines - green tint (like git diff)
  addedDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(40, 167, 69, 0.15)',
    isWholeLine: true,
    overviewRulerColor: 'rgba(40, 167, 69, 0.6)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    // Green left border to clearly mark changed lines
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: 'rgba(40, 167, 69, 0.6)'
  });

  // Lines that were changed (replacement) - yellow/orange tint
  removedLineDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 193, 7, 0.12)',
    isWholeLine: true,
    overviewRulerColor: 'rgba(255, 193, 7, 0.6)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    // Yellow/orange left border for changed lines
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: 'rgba(255, 193, 7, 0.6)'
  });

  // Pure deletion marker (when lines were removed but nothing added)
  deletionMarkerDecorationType = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: 'rgba(220, 53, 69, 0.8)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    backgroundColor: 'rgba(220, 53, 69, 0.08)',
    isWholeLine: true,
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: 'rgba(220, 53, 69, 0.6)'
  });
}

/**
 * Apply decorations for a snapshot to the editor (compatibility method)
 * Also ensures the file is visible and decorations are applied immediately
 */
export function applySnapshotDecorations(snapshot: FileSnapshot): void {
  // Trigger refresh
  refreshAllDecorations();
  
  // If the file is not visible, we need to wait for it to be opened
  // The decoration listeners will handle this
}

/**
 * Find actual position of a change in the current file content
 * Improved algorithm: tries multiple strategies and validates results
 */
function findChangePosition(lines: string[], change: FileChange): number {
  // Strategy 1: Find by context before + new content combination
  if (change.contextBefore.length > 0 && change.newLines.length > 0) {
    const contextLen = change.contextBefore.length;
    const newLen = change.newLines.length;
    
    for (let i = 0; i <= lines.length - contextLen - newLen; i++) {
      // Check if context matches
      let contextMatches = true;
      for (let j = 0; j < contextLen && contextMatches; j++) {
        if (lines[i + j] !== change.contextBefore[j]) {
          contextMatches = false;
        }
      }
      
      if (contextMatches) {
        // Check if new content follows
        let contentMatches = true;
        const contentStart = i + contextLen;
        for (let j = 0; j < newLen && contentMatches; j++) {
          if (lines[contentStart + j] !== change.newLines[j]) {
            contentMatches = false;
          }
        }
        
        if (contentMatches) {
          return contentStart; // 0-based line where new content starts
        }
      }
    }
  }
  
  // Strategy 2: Find by context before only
  if (change.contextBefore.length > 0) {
    const contextLen = change.contextBefore.length;
    
    for (let i = 0; i <= lines.length - contextLen; i++) {
      let matches = true;
      for (let j = 0; j < contextLen && matches; j++) {
        if (lines[i + j] !== change.contextBefore[j]) {
          matches = false;
        }
      }
      
      if (matches) {
        return i + contextLen; // 0-based line after context
      }
    }
  }
  
  // Strategy 3: Find by new content (if unique enough - at least 2 lines)
  if (change.newLines.length >= 2) {
    const newLen = change.newLines.length;
    let foundAt = -1;
    let foundCount = 0;
    
    for (let i = 0; i <= lines.length - newLen; i++) {
      let matches = true;
      for (let j = 0; j < newLen && matches; j++) {
        if (lines[i + j] !== change.newLines[j]) {
          matches = false;
        }
      }
      
      if (matches) {
        foundAt = i;
        foundCount++;
        if (foundCount > 1) break; // Not unique, don't use this strategy
      }
    }
    
    if (foundCount === 1 && foundAt !== -1) {
      return foundAt; // 0-based start of new content
    }
  }
  
  // Strategy 4: Fallback to cached position (convert 1-based to 0-based)
  const fallback = Math.max(0, change.cachedStartLine - 1);
  return fallback;
}

/**
 * Apply decorations for a file's snapshot to an editor
 * 
 * Минималистичный стиль - только цветные полоски слева:
 * - Зелёная полоска для добавленных строк
 * - Жёлтая полоска для изменённых строк (замена)
 * - Красная полоска для удалённых строк
 * 
 * Без hover, без inline аннотаций.
 */
function applyDecorationsToEditor(editor: vscode.TextEditor, snapshot: FileSnapshot): void {
  const filePath = editor.document.uri.fsPath;
  
  if (!addedDecorationType || !removedLineDecorationType || !deletionMarkerDecorationType) {
    initDecorations();
  }
  if (!addedDecorationType || !removedLineDecorationType || !deletionMarkerDecorationType) return;

  const addedRanges: vscode.DecorationOptions[] = [];
  const changedRanges: vscode.DecorationOptions[] = [];
  const deletionMarkerRanges: vscode.DecorationOptions[] = [];

  // Track which lines are already claimed to prevent overlapping decorations
  // Priority: changed (yellow) > added (green) > deleted (red)
  const claimedLines = new Map<number, 'changed' | 'added' | 'deleted'>();

  const lines = editor.document.getText().split('\n');
  const docLineCount = editor.document.lineCount;
  
  for (const change of snapshot.changes) {
    const startLine = findChangePosition(lines, change);
    const linesAdded = change.newLines.length;
    const linesRemoved = change.oldLines.length;
    

    // Validate startLine is within document bounds
    if (startLine < 0 || startLine >= docLineCount) {
      continue;
    }

    // Case 1: Replacement (removed + added) - жёлтая полоска (highest priority)
    if (linesRemoved > 0 && linesAdded > 0) {
      for (let i = 0; i < linesAdded; i++) {
        const line = startLine + i;
        if (line >= docLineCount) break;
        // Changed always wins (highest priority)
        claimedLines.set(line, 'changed');
      }
    }
    // Case 2: Pure addition (no removed lines) - зелёная полоска
    else if (linesAdded > 0) {
      for (let i = 0; i < linesAdded; i++) {
        const line = startLine + i;
        if (line >= docLineCount) break;
        // Only claim if not already claimed by higher priority
        if (!claimedLines.has(line)) {
          claimedLines.set(line, 'added');
        }
      }
    }
    // Case 3: Pure deletion (no added lines) - красная полоска на соседней строке
    else if (linesRemoved > 0) {
      const markerLine = Math.max(0, Math.min(startLine, docLineCount - 1));
      // Only claim if not already claimed by higher priority
      if (!claimedLines.has(markerLine)) {
        claimedLines.set(markerLine, 'deleted');
      }
    }
  }

  // Build decoration ranges from claimed lines (no overlaps possible)
  for (const [line, type] of claimedLines) {
    const range: vscode.DecorationOptions = {
      range: new vscode.Range(line, 0, line, lines[line]?.length || 0)
    };
    switch (type) {
      case 'changed': changedRanges.push(range); break;
      case 'added': addedRanges.push(range); break;
      case 'deleted': deletionMarkerRanges.push(range); break;
    }
  }

  // Apply base decorations
  editor.setDecorations(addedDecorationType, addedRanges);
  editor.setDecorations(removedLineDecorationType, changedRanges);
  editor.setDecorations(deletionMarkerDecorationType, deletionMarkerRanges);

  decoratedFiles.add(normalizePath(filePath));
}

/**
 * Clear decorations for a file
 */
function clearEditorDecorations(editor: vscode.TextEditor): void {
  if (addedDecorationType) editor.setDecorations(addedDecorationType, []);
  if (removedLineDecorationType) editor.setDecorations(removedLineDecorationType, []);
  if (deletionMarkerDecorationType) editor.setDecorations(deletionMarkerDecorationType, []);
}

/**
 * Remove decorations for a file
 */
export function clearDecorationsForFile(filePath: string): void {
  const normalizedPath = normalizePath(filePath);
  const editor = vscode.window.visibleTextEditors.find(
    e => normalizePath(e.document.uri.fsPath) === normalizedPath
  );

  if (editor) {
    clearEditorDecorations(editor);
  }

  decoratedFiles.delete(normalizedPath);
}

/**
 * Clear all decorations
 */
export function clearAllDecorations(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    clearEditorDecorations(editor);
  }
  decoratedFiles.clear();
}

/**
 * Refresh decorations for all pending snapshots (debounced).
 * Call this on extension activation and when editors change.
 * Multiple rapid calls are coalesced into one via debounce.
 */
export function refreshAllDecorations(): void {
  if (refreshDebounceTimer) {
    clearTimeout(refreshDebounceTimer);
  }
  refreshDebounceTimer = setTimeout(() => {
    refreshDebounceTimer = null;
    lastRefreshTime = Date.now();
    applyDecorationsToAllEditors();
  }, REFRESH_DEBOUNCE_MS);
}

/**
 * Apply decorations to all visible editors (no throttle)
 * Use this for critical events like editor focus change
 */
function applyDecorationsToAllEditors(): void {
  if (!addedDecorationType) {
    initDecorations();
  }
  
  const snapshotManager = getSnapshotManager();
  const snapshots = snapshotManager.getPendingSnapshots();

  // Skip logging and work when there are no pending snapshots and no decorated files
  if (snapshots.length === 0 && decoratedFiles.size === 0) {
    return;
  }
  
  // Create map of normalized filePath -> snapshot for quick lookup
  const snapshotByFile = new Map<string, FileSnapshot>();
  for (const snapshot of snapshots) {
    snapshotByFile.set(normalizePath(snapshot.filePath), snapshot);
  }

  // Apply decorations to each open editor
  for (const editor of vscode.window.visibleTextEditors) {
    // Skip non-file schemes (output, debug console, etc.)
    if (editor.document.uri.scheme !== 'file') {
      continue;
    }
    
    const filePath = editor.document.uri.fsPath;
    const normalizedPath = normalizePath(filePath);
    const snapshot = snapshotByFile.get(normalizedPath);
    
    if (snapshot && snapshot.changes.length > 0) {
      applyDecorationsToEditor(editor, snapshot);
    } else {
      // Clear decorations if no pending changes for this file
      clearEditorDecorations(editor);
      decoratedFiles.delete(normalizedPath);
    }
  }
}

/**
 * Debounced refresh - prevents too many refreshes when multiple events fire
 */
function debouncedRefresh(): void {
  if (refreshDebounceTimer) {
    clearTimeout(refreshDebounceTimer);
  }
  refreshDebounceTimer = setTimeout(() => {
    refreshDebounceTimer = null;
    lastRefreshTime = Date.now();
    applyDecorationsToAllEditors();
    codeLensProvider?.refresh();
    updateStatusBar();
  }, REFRESH_DEBOUNCE_MS);
}

/**
 * Setup listeners for editor changes to refresh decorations
 */
export function setupDecorationListeners(context: vscode.ExtensionContext): void {
  // Initialize decorations
  initDecorations();
  
  // Register baseline content provider for diff view
  baselineProvider = new BaselineContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('ashibalt-baseline', baselineProvider)
  );
  
  // Status bar items DISABLED - user requested to remove them
  // statusBarDiff = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103);
  // statusBarDiff.command = 'ashibalt.diffCurrentFile';
  // context.subscriptions.push(statusBarDiff);
  
  // statusBarAccept = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
  // statusBarAccept.command = 'ashibalt.acceptCurrentFile';
  // context.subscriptions.push(statusBarAccept);
  
  // statusBarReject = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  // statusBarReject.command = 'ashibalt.rejectCurrentFile';
  // context.subscriptions.push(statusBarReject);
  
  // Register CodeLens provider for inline Keep/Undo buttons
  codeLensProvider = new SnapshotCodeLensProvider();
  codeLensDisposable = vscode.languages.registerCodeLensProvider(
    { scheme: 'file' }, // All files
    codeLensProvider
  );
  context.subscriptions.push(codeLensDisposable);
  
  // Register commands for CodeLens actions
  registerSnapshotCommands(context);
  
  // Refresh when active editor changes (immediate, NO throttle - critical for UX)
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        // Apply decorations immediately without throttle
        applyDecorationsToAllEditors();
        codeLensProvider?.refresh();
      }
      updateStatusBar();
    })
  );

  // Refresh when visible editors change (immediate, NO throttle)
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => {
      applyDecorationsToAllEditors();
      codeLensProvider?.refresh();
      updateStatusBar();
    })
  );

  // Refresh when document content changes (debounced)
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      // Skip non-file schemes
      if (e.document.uri.scheme !== 'file') return;
      
      // Only refresh if this file has pending changes
      const snapshotManager = getSnapshotManager();
      const snapshot = snapshotManager.getSnapshotForFile(e.document.uri.fsPath);
      if (snapshot) {
        debouncedRefresh();
      }
    })
  );

  // Listen for snapshot changes
  const snapshotManager = getSnapshotManager();
  const unsubscribe = snapshotManager.onChange(() => {
    // Debounced refresh when snapshots change
    debouncedRefresh();
  });
  
  context.subscriptions.push({ dispose: unsubscribe });
  
  // Initial status bar update
  updateStatusBar();
}

/**
 * Dispose decoration types (call on extension deactivation)
 */
export function disposeDecorations(): void {
  // Clear debounce timer
  if (refreshDebounceTimer) {
    clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = null;
  }
  
  if (addedDecorationType) {
    addedDecorationType.dispose();
    addedDecorationType = null;
  }
  if (removedLineDecorationType) {
    removedLineDecorationType.dispose();
    removedLineDecorationType = null;
  }
  if (deletionMarkerDecorationType) {
    deletionMarkerDecorationType.dispose();
    deletionMarkerDecorationType = null;
  }
  if (codeLensDisposable) {
    codeLensDisposable.dispose();
    codeLensDisposable = null;
  }
  codeLensProvider = null;
  decoratedFiles.clear();
}
