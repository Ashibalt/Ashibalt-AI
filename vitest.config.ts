import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      // Мок для vscode модуля при тестировании
      'vscode': path.resolve(__dirname, './test/__mocks__/vscode.ts')
    }
  }
});
