import { defineConfig, Plugin } from 'vite';
import preact from '@preact/preset-vite';
import path from 'path';
import fs from 'fs';

const projectRoot = path.resolve(__dirname, '..');

function serveDevIndex(): Plugin {
	return {
		name: 'serve-dev-index',
		enforce: 'pre',
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				if (req.url === '/' || req.url === '/index.html') {
					const indexPath = path.join(__dirname, 'index.dev.html');
					if (fs.existsSync(indexPath)) {
						let html = fs.readFileSync(indexPath, 'utf-8');
						html = await server.transformIndexHtml(req.url, html);
						res.setHeader('Content-Type', 'text/html');
						res.end(html);
						return;
					}
				}
				next();
			});
		}
	};
}

// The asset base is CC_BASE_PATH (default '/uma-tools'; '' = served at root,
// no strip). With a custom base the legacy '/uma-tools' prefix is stripped too.
function serveUmaToolsAssets(): Plugin {
	const configuredBase = process.env.CC_BASE_PATH ?? '/uma-tools';
	const bases = [configuredBase, '/uma-tools'].filter(b => b);
	return {
		name: 'serve-uma-tools-assets',
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const url = req.url ?? '';
				const base = bases.find(b => url === b || url.startsWith(b + '/'));
				if (base) {
					const filePath = path.join(projectRoot, url.slice(base.length).split('?')[0] || '/');
					if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
						const ext = path.extname(filePath).toLowerCase();
						const mimeTypes: Record<string, string> = {
							'.png': 'image/png',
							'.jpg': 'image/jpeg',
							'.svg': 'image/svg+xml',
							'.webp': 'image/webp',
							'.woff2': 'font/woff2',
							'.css': 'text/css',
							'.js': 'application/javascript',
							'.json': 'application/json',
						};
						res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
						fs.createReadStream(filePath).pipe(res);
						return;
					}
				}
				next();
			});
		}
	};
}

export default defineConfig(({ mode }) => ({
	plugins: [serveDevIndex(), preact(), serveUmaToolsAssets()],
	base: mode === 'production' ? '/release-timeline/' : '/',
	server: {
		port: 5178,
		fs: { allow: [projectRoot] }
	},
	define: {
		CC_DEBUG: mode === 'development' ? 'true' : 'false',
		CC_GLOBAL: 'true',
		'globalThis.CC_BASE_PATH': JSON.stringify(process.env.CC_BASE_PATH ?? '/uma-tools'),
	},
	optimizeDeps: {
		include: ['preact', 'preact/hooks'],
	},
	build: {
		outDir: 'dist',
		sourcemap: mode === 'development',
		rollupOptions: {
			input: 'index.dev.html',
			output: {
				entryFileNames: 'bundle.js',
				chunkFileNames: '[name].js',
				assetFileNames: (assetInfo) => {
					if (assetInfo.name?.endsWith('.css')) return 'bundle.css';
					return 'assets/[name][extname]';
				},
			},
		},
	}
}));
