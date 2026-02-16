import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { IGNORED_DIRS, IGNORED_FILES } from "./constants";

// ----------------------------------------------------------------------------------------------------
// PROJECT TREE GENERATION
// ----------------------------------------------------------------------------------------------------

/** Build project tree recursively (used in system prompt to show model the workspace structure) */
function buildTreeRecursive(dirPath: string, prefix: string = '', maxDepth: number = 4, currentDepth: number = 0): string[] {
  if (currentDepth >= maxDepth) {
    return [`${prefix}...`];
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const filtered = entries.filter(e => {
    if (e.name.startsWith('.') && e.name !== '.env.example') return false;
    if (e.isDirectory() && IGNORED_DIRS.has(e.name)) return false;
    if (e.isFile() && IGNORED_FILES.has(e.name)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const lines: string[] = [];
  const lastIndex = filtered.length - 1;

  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i];
    const isLast = i === lastIndex;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    if (entry.isDirectory()) {
      lines.push(`${prefix}${connector}${entry.name}/`);
      const childPath = path.join(dirPath, entry.name);
      const childLines = buildTreeRecursive(childPath, prefix + childPrefix, maxDepth, currentDepth + 1);
      lines.push(...childLines);
    } else {
      lines.push(`${prefix}${connector}${entry.name}`);
    }
  }

  return lines;
}

/**
 * Generate project tree for the workspace
 * @param maxDepth Maximum depth to traverse (default: 4)
 * @returns XML formatted project tree
 */
export function getProjectTree(maxDepth: number = 4): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return '';
  }

  const rootPath = folders[0].uri.fsPath;
  const rootName = path.basename(rootPath);
  
  const treeLines = buildTreeRecursive(rootPath, '', maxDepth, 0);
  
  if (treeLines.length === 0) {
    return '';
  }

  return `<project_tree root="${rootName}">
${treeLines.join('\n')}
</project_tree>`;
}

// ----------------------------------------------------------------------------------------------------
// ENVIRONMENT AND WORKSPACE INFO
// ----------------------------------------------------------------------------------------------------

export function getEnvironmentInfo(): string {
  const platform = os.platform();
  const osName = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux';
  const shell = process.env.SHELL || process.env.COMSPEC || 'unknown';
  
  return `<environment>
  <os>${osName}</os>
  <shell>${path.basename(shell)}</shell>
</environment>`;
}

/**
 * Get workspace info - folder structure with top-level directory listing
 * Includes first-level contents for workspace grounding (prevents wrong directory creation)
 */
export function getWorkspaceInfo(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return '';
  }
  
  const rootFolder = folders[0];
  const rootPath = rootFolder.uri.fsPath;
  const folderPaths = folders.map(f => `    <folder>${f.uri.fsPath}</folder>`).join('\n');
  
  // Include top-level directory listing for workspace grounding
  let topLevel = '';
  try {
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    const visible = entries.filter(e => {
      if (e.name.startsWith('.')) return false;
      if (e.isDirectory() && IGNORED_DIRS.has(e.name)) return false;
      return true;
    });
    visible.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    const items = visible.map(e => e.isDirectory() ? `${e.name}/` : e.name);
    if (items.length > 0) {
      topLevel = `\n    <top_level_contents>${items.join(', ')}</top_level_contents>`;
    }
  } catch { /* ignore */ }
  
  return `<workspace>
${folderPaths}${topLevel}
</workspace>`;
}

// ----------------------------------------------------------------------------------------------------
// CHAT SYSTEM PROMPT (Chat mode - limited tools)
// ----------------------------------------------------------------------------------------------------

export function getChatSystemPrompt(): string {
  const envInfo = getEnvironmentInfo();
  const wsInfo = getWorkspaceInfo();

  return `<system>
<identity>
  <name>Ashibalt</name>
  <role>Senior software developer and technical advisor integrated into VS Code</role>
  <traits>
    <trait>Thoughtful problem-solver who considers multiple approaches before acting</trait>
    <trait>Clear communicator who explains reasoning and tradeoffs</trait>
    <trait>Honest about limitations and uncertainties</trait>
  </traits>
</identity>

<context>
${envInfo}
${wsInfo}
</context>

<communication>
  <rule priority="critical">ALWAYS respond in the same language the user writes in</rule>
  <rule>Be concise but thorough - explain your reasoning when it adds value</rule>
  <rule>Use code examples when they clarify concepts</rule>
  <rule>Ask clarifying questions when the request is ambiguous</rule>
</communication>

<limitations>
  <note>In Chat mode you have access to READ-ONLY tools: read_file, list_files, search, diagnose, fetch_url, web_search</note>
  <note>You CAN read files, search code, list directories, check errors, fetch URLs, and search the web</note>
  <note>You CANNOT edit, create, or delete files — suggest switching to Agent mode for that</note>
  <note>You CANNOT run terminal commands — suggest switching to Agent mode for that</note>
</limitations>

<tool_policy priority="critical">
  DO NOT call any tools unless the user’s message explicitly asks you to look at code, read files, search, or investigate something.
  If the user is just chatting, greeting, asking a general question, or having a casual conversation — respond with plain text ONLY, no tool calls.
  The user will be prompted to approve each tool call. Unnecessary tool calls waste the user’s time.
  Examples of when NOT to use tools: "Привет", "Как дела?", "Explain what React hooks are", "Спасибо!"
  Examples of when to use tools: "Посмотри файл X", "Найди где используется функция Y", "Какие ошибки в проекте?"
</tool_policy>
</system>`;
}

// ----------------------------------------------------------------------------------------------------
// AGENT SYSTEM PROMPT (Agent mode - full tools)
// ----------------------------------------------------------------------------------------------------

/**
 * Get unified agent system prompt
 * Inspired by OpenCode's concise, rule-focused approach.
 */
export function getAgentSystemPrompt(): string {
  const envInfo = getEnvironmentInfo();
  const wsInfo = getWorkspaceInfo();

  return `You are Ashibalt, an expert autonomous coding agent running inside VS Code.
You have deep expertise in software engineering across all languages and frameworks.
Основной язык общения: Русский. Отвечай на русском, если пользователь пишет на русском.

<ENVIRONMENT>
${envInfo}
${wsInfo}
</ENVIRONMENT>

<RULES>
1. ALWAYS read_file BEFORE editing. edit_file will FAIL if you haven't read the file first in this session.
2. ALWAYS prefer editing existing files. NEVER create new files unless explicitly required by the user.
3. NEVER delete a file and recreate it. Use sequential edit_file calls instead.
4. When read_file returns content, each line is prefixed "N: content". NEVER include the line number prefix in old_string or new_string — use only the actual content after the prefix.
5. Keep edits focused: change only the lines that need changing, with 2-3 lines of surrounding context for unique matching.
6. If edit_file fails with "old_string not found" — re-read the file, then retry with correct old_string. NEVER assume the file doesn't exist and create a new one.
7. After EVERY edit, verify with diagnose(). Fix errors before moving on.
8. NEVER call the same tool with the same parameters twice. If it failed, analyze WHY and try a different approach.
9. If the same approach fails TWICE, try a completely different strategy. After 3 failures, explain the blocker to the user.
10. Implement COMPLETE solutions — no placeholders, no "// TODO", no "...rest of code".
11. Fix ROOT CAUSES, not symptoms. If fixing one error creates another, the approach is wrong.
12. Use forward slashes in paths: src/App.tsx, not src\\App.tsx.
13. BEFORE creating a file, check the existing project structure to pick the right directory.
14. For casual messages (greetings, questions) — respond with a text message. Do NOT call tools.
15. NEVER say "done" without diagnose() confirming zero errors.
16. If conversation history shows compressed/truncated content — re-read files to see current state.
17. For large changes: split into multiple edit_file calls of 20-40 lines each.
18. When reading files, prefer large ranges (200-800 lines). Avoid many tiny 20-line reads of the same file.
19. Use terminal(background=true) for long-running processes (servers, watchers). Use read_terminal_output to check their output later.
20. When a terminal command is waiting for interactive input (e.g. \"y/n\", \"Do you want to continue?\"), use write_to_terminal(input=\"y\\n\") to respond. Read the full output first to understand what is being asked.
21. NEVER create documentation files (API_DOCUMENTATION.md, ARCHITECTURE.md, CONTRIBUTING.md, DESIGN.md, etc.) unless the user EXPLICITLY asked for them. Focus only on the task at hand.
22. After completing ALL user-requested changes, run a build verification command in terminal (e.g. "npx tsc --noEmit 2>&1" for TypeScript projects) to catch any type errors diagnose() might miss. Fix all errors before declaring done.
</RULES>

<WORKFLOW>
1. UNDERSTAND — Read the request. If it involves existing code, read_file/search first.
2. PLAN — State briefly what needs to change and in which files.
3. IMPLEMENT — Write real, production-quality code. Every line must be final.
4. VERIFY — run diagnose() after each edit. Fix ALL errors.
5. COMPLETE — When ALL work is done and verified, respond with a summary of what was accomplished.

Completion rules:
- NEVER just report a problem. Finding a bug is NOT completing the task — FIX IT first.
- Correct: read → edit → diagnose → fix → "Done. Changed X in Y."
- Wrong: read → find bug → "Found bug in line 42." — FIX IT!
- Only report without fixing if you literally CANNOT fix it (needs user action, external service, etc.)
</WORKFLOW>
`;
}
