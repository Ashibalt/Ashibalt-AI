/**
 * tasksTool.ts — In-session task list management.
 *
 * Allows the agent to maintain a visible task checklist in the chat UI.
 * The webview displays the list as an interactive panel that updates live.
 *
 * Actions:
 *   set    — replace the full task list (array of strings)
 *   add    — append one or more tasks
 *   done   — mark task(s) as completed by index (0-based)
 *   update — change the text of a task by index
 *   clear  — remove all tasks
 */

export interface Task {
  text: string;
  done: boolean;
}

// In-memory task list — persists for the lifetime of the extension session.
// Cleared on "clear" action or when the user starts a new chat.
let currentTasks: Task[] = [];

/**
 * Reset tasks (call when starting a new chat session).
 */
export function resetTasks(): void {
  currentTasks = [];
}

/**
 * Get current tasks (for session restore).
 */
export function getCurrentTasks(): Task[] {
  return currentTasks;
}

/**
 * Main tasks tool handler.
 * @param args   Tool arguments from the model
 * @param postMessage  Function to send messages to the webview
 */
export async function tasksTool(args: any, postMessage?: (msg: any) => void): Promise<any> {
  const action: string = (args?.action ?? '').toLowerCase().trim();

  switch (action) {
    // ── set ──────────────────────────────────────────────────────────────────
    case 'set': {
      const items: string[] = Array.isArray(args.tasks) ? args.tasks : [];
      if (items.length === 0) {
        return { error: 'set requires a non-empty "tasks" array of strings.' };
      }
      currentTasks = items.map(t => ({ text: String(t), done: false }));
      break;
    }

    // ── add ──────────────────────────────────────────────────────────────────
    case 'add': {
      // Accepts either a single string (task) or an array (tasks)
      const toAdd: string[] = Array.isArray(args.tasks)
        ? args.tasks
        : args.task
          ? [String(args.task)]
          : [];
      if (toAdd.length === 0) {
        return { error: 'add requires "task" (string) or "tasks" (array of strings).' };
      }
      currentTasks.push(...toAdd.map(t => ({ text: String(t), done: false })));
      break;
    }

    // ── done ─────────────────────────────────────────────────────────────────
    case 'done': {
      // Accepts index (number) or indexes (array of numbers)
      const indices: number[] = Array.isArray(args.indexes)
        ? args.indexes
        : typeof args.index === 'number'
          ? [args.index]
          : [];
      if (indices.length === 0) {
        return { error: 'done requires "index" (number) or "indexes" (array of numbers).' };
      }
      const invalid = indices.filter(i => i < 0 || i >= currentTasks.length);
      if (invalid.length > 0) {
        return { error: `Index out of range: ${invalid.join(', ')}. Task count: ${currentTasks.length}.` };
      }
      for (const i of indices) {
        currentTasks[i].done = true;
      }
      break;
    }

    // ── update ───────────────────────────────────────────────────────────────
    case 'update': {
      const idx: number = typeof args.index === 'number' ? args.index : -1;
      if (idx < 0 || idx >= currentTasks.length) {
        return { error: `update requires a valid "index" (0-based). Task count: ${currentTasks.length}.` };
      }
      if (typeof args.text !== 'string') {
        return { error: 'update requires "text" (string) — the new task description.' };
      }
      currentTasks[idx].text = args.text;
      if (typeof args.done === 'boolean') {
        currentTasks[idx].done = args.done;
      }
      break;
    }

    // ── clear ────────────────────────────────────────────────────────────────
    case 'clear': {
      currentTasks = [];
      break;
    }

    default: {
      return {
        error: `Unknown action: "${action}". Valid actions: "set", "add", "done", "update", "clear".`
      };
    }
  }

  // Notify the webview to re-render the tasks panel
  if (postMessage) {
    postMessage({
      type: 'tasksUpdate',
      tasks: currentTasks
    });
  }

  // Build a text summary for the model
  const summary = formatTasksForModel(currentTasks);

  return {
    success: true,
    action,
    task_count: currentTasks.length,
    done_count: currentTasks.filter(t => t.done).length,
    tasks_summary: summary
  };
}

/**
 * Render tasks as a simple numbered list with ✅/☐ prefixes.
 */
function formatTasksForModel(tasks: Task[]): string {
  if (tasks.length === 0) return '(no tasks)';
  return tasks
    .map((t, i) => `${i + 1}. ${t.done ? '✅' : '☐'} ${t.text}`)
    .join('\n');
}

/**
 * Apply a tasks state update from an inline <tasks>...</tasks> JSON block
 * embedded in the model's text response. Called by agentLoop — avoids a
 * full tool-call round-trip just to flip a checkbox.
 *
 * Supported payload fields:
 *   done:   number[]                        — mark these 0-based indexes done
 *   update: {index, text?, done?}[]         — change text/done state by index
 *   clear:  boolean                         — wipe entire task list
 */
export function applyTasksInlineUpdate(
  payload: {
    done?: number[];
    update?: { index: number; text?: string; done?: boolean }[];
    clear?: boolean;
  },
  postMessage?: (msg: any) => void
): void {
  if (payload.clear) {
    currentTasks = [];
  }
  if (Array.isArray(payload.done)) {
    for (const idx of payload.done) {
      if (typeof idx === 'number' && idx >= 0 && idx < currentTasks.length) {
        currentTasks[idx].done = true;
      }
    }
  }
  if (Array.isArray(payload.update)) {
    for (const u of payload.update) {
      if (typeof u.index === 'number' && u.index >= 0 && u.index < currentTasks.length) {
        if (typeof u.text === 'string') currentTasks[u.index].text = u.text;
        if (typeof u.done === 'boolean') currentTasks[u.index].done = u.done;
      }
    }
  }
  if (postMessage) {
    postMessage({ type: 'tasksUpdate', tasks: currentTasks });
  }
}
