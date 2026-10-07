import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiPort = process.env.AGENTOS_PORT ?? '8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      '/metrics': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      '/fixtures': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
    },
  },
});
