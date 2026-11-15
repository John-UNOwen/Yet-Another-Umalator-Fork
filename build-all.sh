#!/bin/bash
# Build all applications for production deployment

set -e  # Exit on any error

echo "========================================="
echo "Building uma-tools applications..."
echo "========================================="

echo ""
echo "Generating static Canva guide pages (canva/<slug>/index.html)..."
node tools/gen-canva-static.mjs

echo ""
echo "Building umalator-global..."
cd umalator-global
node build.mjs
cd ..

echo ""
echo "Building umalator-global v2..."
cd umalator-global/v2
npx vite build
cd ../..

# Copy v2 dist to project root (v2 is the default landing page)
echo "Copying v2 to root..."
cp umalator-global/v2/dist/index.html ./index.html
cp umalator-global/v2/dist/favicon.svg ./favicon.svg 2>/dev/null || true
# globalsim.worker.js sits at the v2 dist root (worker.rollupOptions entryFileNames
# '[name].js') and the main bundle resolves it as ../globalsim.worker.js from
# /assets/, i.e. the site root — it must be copied here or the default engine 404s.
cp umalator-global/v2/dist/globalsim.worker.js ./globalsim.worker.js 2>/dev/null || true
rm -rf assets
cp -r umalator-global/v2/dist/assets ./assets

# NOTE: the JP v1 app and the classic Global v1 app were both retired; their
# routes (/umalator, /umalator-global) 301 to the v2 root via _redirects. The
# classic simulator glue (umalator/, uma-skill-tools-v1/, the classic worker) was
# removed once GlobalSim became the only engine, so there is nothing to build for
# them. The old `cd umalator && node build.mjs` step was deleted here for the same
# reason it broke Pages builds before: set -e aborted the whole deploy on it.

echo ""
echo "Building skill-visualizer (JP) → /skill-visualizer-jp/..."
cd skill-visualizer-jp
node build.mjs
cd ..

# Builds both Global v1 (/umalator-global/skill-visualizer/) and v2
# (/umalator-global/skill-visualizer/v2/).
# The v2 build is also surfaced at the clean URL /skill-visualizer/ via the
# _redirects rewrite at repo root.
echo ""
echo "Building skill-visualizer (Global v1 + v2)..."
cd umalator-global/skill-visualizer
node build.mjs
cd ../..

echo ""
echo "Building mechanics-explorer..."
cd umalator-global/mechanics-explorer
node build.mjs
cd ../..

echo ""
echo "Building team-trials..."
cd team-trials
node build.mjs
cd ..

echo ""
echo "Building release-timeline..."
cd release-timeline
node build.mjs
cd ..

echo ""
echo "Building build-planner..."
cd build-planner
../node_modules/.bin/esbuild app.tsx --bundle --external:node:assert --outfile=bundle.js
../node_modules/.bin/unassert bundle.js > bundle.2.js
rm -f bundle.2.js
cd ..

echo ""
echo "========================================="
echo "Build complete! All applications ready."
echo "========================================="
