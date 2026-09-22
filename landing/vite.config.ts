import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import type {IncomingMessage, ServerResponse} from 'http';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

// The landing ships no favicon of its own: it serves the emulator's single
// favicon.ico from the repository root, so the two can never drift apart. In
// dev and preview the file is streamed from there; a production build emits it
// into dist, which tools/site-preview.js overlays onto the deployed site.
const REPO_FAVICON = path.resolve(__dirname, '..', 'favicon.ico');

function repoFavicon(): Plugin {
  const serveFavicon = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    if ((req.url || '').split('?')[0] !== '/favicon.ico' || !fs.existsSync(REPO_FAVICON)) {
      next();
      return;
    }
    res.setHeader('Content-Type', 'image/x-icon');
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(REPO_FAVICON).pipe(res);
  };
  return {
    name: 'yapdp-repo-favicon',
    configureServer(server) {
      server.middlewares.use(serveFavicon);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveFavicon);
    },
    generateBundle() {
      if (!fs.existsSync(REPO_FAVICON)) return;
      this.emitFile({
        type: 'asset',
        fileName: 'favicon.ico',
        source: fs.readFileSync(REPO_FAVICON),
      });
    },
  };
}

export default defineConfig(() => {
  return {
    base: "./",
    plugins: [react(), tailwindcss(), repoFavicon()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
