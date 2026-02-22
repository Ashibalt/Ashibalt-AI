/**
 * Shared ignore lists for project tree scanning.
 * Used by promptUtils (system prompt) and toolCalling (project_tree tool).
 */

/** Directories to skip when scanning project tree */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '__pycache__',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.nyc_output',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  'venv',
  '.venv',
  'env',
  '.env',
  'vendor',
  'target',
  'bin',
  'obj',
  '.idea',
  '.vscode',
  '.vs',
  'logs',
  'tmp',
  'temp',
  'bower_components',
]);

/** Files to skip when scanning project tree */
export const IGNORED_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.gitignore',
  '.gitattributes',
  '.gitkeep',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'poetry.lock',
]);
