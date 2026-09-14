import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/pixelwalker-assets': {
        target: 'https://client.pixelwalker.net',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/pixelwalker-assets/, '')
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
