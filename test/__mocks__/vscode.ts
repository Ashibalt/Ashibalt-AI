// Мок для VS Code API при unit-тестировании
// Этот файл подменяет реальный vscode модуль в тестах

export const Uri = {
  file: (path: string) => ({ fsPath: path, scheme: 'file', path }),
  parse: (uri: string) => ({ fsPath: uri, scheme: 'file', path: uri })
};

export const workspace = {
  workspaceFolders: [{ uri: Uri.file('/test-workspace') }],
  fs: {
    readFile: async () => Buffer.from(''),
    writeFile: async () => {},
    stat: async () => ({ type: 1 }),
    createDirectory: async () => {}
  },
  openTextDocument: async () => ({
    getText: () => '',
    lineAt: () => ({ text: '' }),
    lineCount: 10
  }),
  applyEdit: async () => true,
  getConfiguration: () => ({
    get: () => undefined,
    update: async () => {}
  })
};

export const window = {
  showInformationMessage: async () => {},
  showWarningMessage: async () => {},
  showErrorMessage: async () => {},
  createOutputChannel: () => ({
    appendLine: () => {},
    append: () => {},
    show: () => {},
    clear: () => {}
  }),
  activeTextEditor: undefined,
  visibleTextEditors: []
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: async () => {}
};

export const Range = class {
  constructor(
    public startLine: number,
    public startChar: number,
    public endLine: number,
    public endChar: number
  ) {}
};

export const Position = class {
  constructor(public line: number, public character: number) {}
};

export const Selection = class extends Range {
  constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
    super(startLine, startChar, endLine, endChar);
  }
};

export const TextEdit = {
  replace: (range: any, text: string) => ({ range, newText: text }),
  insert: (pos: any, text: string) => ({ position: pos, newText: text }),
  delete: (range: any) => ({ range, newText: '' })
};

export const WorkspaceEdit = class {
  private edits: Map<string, any[]> = new Map();
  
  replace(uri: any, range: any, text: string) {
    const key = uri.fsPath || uri;
    if (!this.edits.has(key)) this.edits.set(key, []);
    this.edits.get(key)!.push({ range, newText: text });
  }
  
  insert(uri: any, pos: any, text: string) {
    const key = uri.fsPath || uri;
    if (!this.edits.has(key)) this.edits.set(key, []);
    this.edits.get(key)!.push({ position: pos, newText: text });
  }
  
  delete(uri: any, range: any) {
    const key = uri.fsPath || uri;
    if (!this.edits.has(key)) this.edits.set(key, []);
    this.edits.get(key)!.push({ range, newText: '' });
  }
};

export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64
};

export const EventEmitter = class {
  private handlers: Function[] = [];
  event = (handler: Function) => {
    this.handlers.push(handler);
    return { dispose: () => {} };
  };
  fire(data: any) {
    this.handlers.forEach(h => h(data));
  }
};

export const Disposable = {
  from: (...disposables: any[]) => ({
    dispose: () => disposables.forEach(d => d.dispose?.())
  })
};

export const languages = {
  registerCompletionItemProvider: () => ({ dispose: () => {} }),
  createDiagnosticCollection: () => ({
    set: () => {},
    clear: () => {},
    delete: () => {},
    dispose: () => {}
  })
};

export const ExtensionContext = class {
  subscriptions: any[] = [];
  globalState = {
    get: () => undefined,
    update: async () => {}
  };
  workspaceState = {
    get: () => undefined,
    update: async () => {}
  };
  extensionPath = '/extension';
  extensionUri = Uri.file('/extension');
};

// Экспорт по умолчанию
export default {
  Uri,
  workspace,
  window,
  commands,
  Range,
  Position,
  Selection,
  TextEdit,
  WorkspaceEdit,
  FileType,
  EventEmitter,
  Disposable,
  languages,
  ExtensionContext
};
