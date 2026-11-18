import { defineConfig, loadEnv, Plugin } from 'vite';
import preact from '@preact/preset-vite';
import path from 'path';
import fs from 'fs';

const rootDir = path.resolve(__dirname, '..');
const projectRoot = path.resolve(__dirname, '../..');

// Custom plugin to redirect data file imports to Global versions
// This matches esbuild's redirectData plugin behavior
function redirectDataFiles(): Plugin {
  // The engine resolves its data to the same Global files.
  const engineDataDirs = [
    path.join(projectRoot, 'uma-skill-tools/data'),
  ];

  return {
    name: 'redirect-data-files',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null;

      // Check if this is a relative import that would resolve to uma-skill-tools/data/
      if (source.startsWith('./') || source.startsWith('../')) {
        const resolvedPath = path.resolve(path.dirname(importer), source);

        // If the resolved path is within either engine's data/, redirect to umalator-global/
        for (const dataDir of engineDataDirs) {
          if (resolvedPath.startsWith(dataDir + path.sep)) {
            return path.join(rootDir, resolvedPath.slice(dataDir.length + 1));
          }
        }
      }

      return null;
    }
  };
}

// Custom plugin to serve site assets from project root.
// The asset base is CC_BASE_PATH (default '/uma-tools'; '' = served at root,
// no strip). With a custom base the legacy '/uma-tools' prefix is stripped too.
function serveUmaToolsAssets(): Plugin {
  const configuredBase = process.env.CC_BASE_PATH ?? '/uma-tools';
  const bases = [configuredBase, '/uma-tools'].filter(b => b);
  // CC_BASE_PATH='' means the site is served at root: asset requests (/icons/…,
  // /globalsim/…) come in with no prefix to strip.
  const rootMode = configuredBase === '';
  return {
    name: 'serve-uma-tools-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        const base = bases.find(b => url === b || url.startsWith(b + '/'));
        // Raw request URLs keep '..' segments, and path.join would normalize them
        // out of projectRoot — refuse them (same guard as mechanics-explorer).
        if ((base || rootMode) && url.includes('..')) { res.statusCode = 400; res.end('Bad request'); return; }
        // Root mode mirrors the root-fallback in mechanics-explorer/build.mjs: after an
        // app-dir/public miss, requests resolve against the repo root. Only ones with a
        // file extension are candidates (extensionless SPA routes keep falling through to
        // Vite's index.html), never /index.html, and never Vite-internal paths (/@…,
        // /node_modules/… — the repo-root node_modules/.vite cache really has such files).
        const assetPath = url.split('?')[0];
        let filePath: string;
        if (base) {
          filePath = path.join(projectRoot, url.slice(base.length).split('?')[0] || '/');
        } else if (rootMode && path.extname(assetPath) && assetPath !== '/index.html'
            && !assetPath.startsWith('/@') && !assetPath.startsWith('/node_modules/')
            && !fs.existsSync(path.join(rootDir, assetPath)) && !fs.existsSync(path.join(rootDir, 'public', assetPath))) {
          filePath = path.join(projectRoot, assetPath);
        } else {
          next();
          return;
        }
        // Belt-and-braces: join() already normalized, so anything landing outside
        // projectRoot here is not an asset we may serve.
        if (filePath !== projectRoot && !filePath.startsWith(projectRoot + path.sep)) {
          res.statusCode = 400; res.end('Bad request'); return;
        }
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          // Determine content type
          const ext = path.extname(filePath).toLowerCase();
          const mimeTypes: Record<string, string> = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.webp': 'image/webp',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.json': 'application/json',
          };
          res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
          fs.createReadStream(filePath).pipe(res);
          return;
        }
        next();
      });
    }
  };
}

export default defineConfig(({ mode }) => {
  // Load .env.local vars so OCR_PROXY_URL is available in process.env
  const env = loadEnv(mode, __dirname, '');

  return {
  plugins: [redirectDataFiles(), preact(), serveUmaToolsAssets()],

  // Use relative paths — v2 is served at root (/) in production
  // Can be overridden via VITE_BASE env var if needed
  base: process.env.VITE_BASE || './',

  // Dev server config. host: true binds every interface, so a phone or
  // laptop on the LAN can open http://<this-pc>:5173 (Windows may ask to
  // allow node through the Firewall on first run).
  server: {
    host: true,
    port: 5173,
    // Serve static files from project root (for icons/, fonts/, etc.)
    fs: {
      allow: [projectRoot]
    }
  },
  preview: {
    host: true,
    port: 4173,
  },

  resolve: {
    alias: {
      // Data file redirects for relative imports from umalator/
      // The redirectDataFiles() plugin handles imports from within uma-skill-tools/
      '../uma-skill-tools/data': rootDir,
      '../../uma-skill-tools/data': rootDir,
      '../data': rootDir,
      '../../data': rootDir,

      // Specific JSON file redirects
      'skill_meta.json': path.join(rootDir, 'skill_meta.json'),
      'umas.json': path.join(rootDir, 'umas.json'),
      'not-in-game.json': path.join(rootDir, 'not-in-game.json'),
      'career-unbuyable.json': path.join(rootDir, 'career-unbuyable.json'),
      'career-card-skills.json': path.join(rootDir, 'career-card-skills.json'),

      // Node assert mock - point to our local mock
      'node:assert': path.join(__dirname, 'mocks/assert.ts'),
    }
  },

  define: {
    CC_DEBUG: mode === 'development' ? 'true' : 'false',
    CC_GLOBAL: 'true',
    CC_DEV: (env.CF_PAGES_BRANCH === 'dev' || env.CC_DEV === 'true' || mode === 'development') ? 'true' : 'false',
    CC_OCR_PROXY: JSON.stringify(env.OCR_PROXY_URL || ''),
    CC_TURNSTILE_SITEKEY: JSON.stringify(env.TURNSTILE_SITEKEY || ''),
    CC_COW_SKIN: JSON.stringify(env.COW_SKIN || ''),
    'globalThis.CC_BASE_PATH': JSON.stringify(process.env.CC_BASE_PATH ?? '/uma-tools'),
  },

  // Optimize dependencies
  optimizeDeps: {
    include: ['preact', 'preact/hooks', 'd3', 'immutable'],
  },

  // Static assets in public/ are copied to dist root
  publicDir: 'public',

  build: {
    outDir: 'dist',
    // Generate sourcemaps for debugging
    sourcemap: mode === 'development',
  },

  // Worker configuration
  worker: {
    format: 'es',
    // Apply same plugins to workers
    plugins: () => [redirectDataFiles()],
    rollupOptions: {
      output: {
        entryFileNames: '[name].js'
      }
    }
  }
};
});
