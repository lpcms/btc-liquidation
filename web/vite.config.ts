/**
 * Vite configuration.
 *
 * During development the dev server proxies /api and /ws to the backend on
 * port 3000 so the frontend and backend can run side by side. The production
 * build is emitted into ../server/public, which the unified server serves as
 * static files from a single port.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    build: {
        outDir: '../server/public',
        emptyOutDir: true,
    },
    server: {
        proxy: {
            '/api': 'http://127.0.0.1:3000',
            '/ws': {
                target: 'ws://127.0.0.1:3000',
                ws: true,
            },
        },
    },
});
