import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // index.html: the terminal viewer; landing.html: the homepage.
      input: { viewer: 'index.html', landing: 'landing.html' },
    },
  },
});
