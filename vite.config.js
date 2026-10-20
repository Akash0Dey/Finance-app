import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: { host: env.HOST || '127.0.0.1', proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } } },
    build: { rollupOptions: { output: { manualChunks: { charts: ['recharts'], react: ['react', 'react-dom'] } } } },
  };
});