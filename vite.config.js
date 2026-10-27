import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  base: './',
  // The browser entry uses document.createElement; workers need the package's
  // DOM-free character table, also used by our Node analysis bundle.
  resolve: { alias: { 'decode-named-character-reference': fileURLToPath(import.meta.resolve('decode-named-character-reference')) } },
  build: { rolldownOptions: { input: ['index.html', 'diagram.html'] } },
});
