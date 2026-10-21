import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
export default defineConfig({
  publicDir: false,
  plugins: [
    {
      name: 'alphaforge-user-ui-assets',
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const fileName =
            request.url === '/user-ui.css'
              ? 'user-ui.css'
              : request.url === '/user-ui.js'
                ? 'user-ui.js'
                : null;
          if (!fileName) return next();
          try {
            response.statusCode = 200;
            response.setHeader(
              'content-type',
              fileName.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
            );
            response.end(await readFile(new URL(`../../build/ui-import/${fileName}`, import.meta.url)));
          } catch {
            next();
          }
        });
      },
      async generateBundle() {
        for (const fileName of ['user-ui.css', 'user-ui.js']) {
          this.emitFile({
            type: 'asset',
            fileName,
            source: await readFile(new URL(`../../build/ui-import/${fileName}`, import.meta.url)),
          });
        }
      },
    },
  ],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      input: {
        product: fileURLToPath(new URL('./index.html', import.meta.url)),
      },
    },
  },
  server: { host: '127.0.0.1' },
});
