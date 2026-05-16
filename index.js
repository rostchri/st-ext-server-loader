/**
 * st-ext-server-loader
 *
 * SillyTavern server-plugin that auto-loads server-side Express routers
 * shipped INSIDE third-party extensions. Lets extension authors put their
 * backend code in a `server/` subdirectory of the extension repo without
 * needing a separate ST-plugin install per extension.
 *
 * Scans on startup:
 *   - /home/node/app/public/scripts/extensions/third-party/<ext>/server/index.js
 *     (global third-party extensions)
 *   - /home/node/app/data/<user>/extensions/<ext>/server/index.js
 *     (per-user installed extensions via "Install from URL")
 *
 * Each discovered extension's server/index.js MUST export an `init(router)`
 * function (Express router). Routes are mounted under
 *   /api/plugins/st-ext-server-loader/ext/<ext-name>/...
 *
 * @example
 *   // In <extension>/server/index.js:
 *   async function init(router) {
 *       router.post('/generate', (req, res) => res.send({ image: '...' }));
 *   }
 *   async function exit() {}
 *   module.exports = { init, exit };
 *
 *   // Browser-side fetch:
 *   await fetch('/api/plugins/st-ext-server-loader/ext/<ext-name>/generate', {...});
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

// Search roots — covers both global third-party and per-user installs.
const EXTENSION_ROOTS = [
    '/home/node/app/public/scripts/extensions/third-party',
    '/home/node/app/data', // per-user: data/<user>/extensions/<ext>
];

const LOG_PREFIX = '[st-ext-server-loader]';

/**
 * Find all `<ext>/server/index.js` files under a root.
 * For per-user data roots, descend one extra level into <user>/extensions/.
 */
function findServerEntries(root) {
    const results = [];
    if (!fs.existsSync(root)) return results;

    const isUserDataRoot = root.endsWith('/data');

    let extensionDirs = [];
    if (isUserDataRoot) {
        // /data/<user>/extensions/<ext>/server/index.js
        for (const user of safeReaddir(root)) {
            const extRoot = path.join(root, user, 'extensions');
            for (const ext of safeReaddir(extRoot)) {
                extensionDirs.push({ name: ext, dir: path.join(extRoot, ext), user });
            }
        }
    } else {
        // /third-party/<ext>/server/index.js
        for (const ext of safeReaddir(root)) {
            extensionDirs.push({ name: ext, dir: path.join(root, ext), user: null });
        }
    }

    for (const { name, dir, user } of extensionDirs) {
        const entry = path.join(dir, 'server', 'index.js');
        if (fs.existsSync(entry)) {
            results.push({ name, entry, user });
        }
    }
    return results;
}

function safeReaddir(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('.'))
            .map(d => d.name);
    } catch (e) {
        return [];
    }
}

/**
 * Load one extension's server module and mount its routes.
 * Returns the loaded module's `exit` callback (or null) for cleanup.
 */
async function loadExtensionServer({ name, entry, user }, parentRouter) {
    let mod;
    try {
        // Bust cache so reload-friendly during development.
        delete require.cache[require.resolve(entry)];
        mod = require(entry);
    } catch (e) {
        console.error(`${LOG_PREFIX} require failed for ${name} (${entry}):`, e);
        return null;
    }

    if (!mod || typeof mod.init !== 'function') {
        console.warn(`${LOG_PREFIX} ${name}: server/index.js has no init(router) export — skipped`);
        return null;
    }

    const subRouter = express.Router();
    try {
        await mod.init(subRouter);
    } catch (e) {
        console.error(`${LOG_PREFIX} ${name}.init() threw:`, e);
        return null;
    }

    // Mount under /ext/<name>/...
    parentRouter.use(`/ext/${name}`, subRouter);

    const userTag = user ? ` (user=${user})` : '';
    console.log(`${LOG_PREFIX} loaded ${name}${userTag} → /api/plugins/st-ext-server-loader/ext/${name}`);

    return typeof mod.exit === 'function' ? mod.exit : null;
}

// Track exit callbacks for shutdown.
const exitCallbacks = [];

async function init(router) {
    console.log(`${LOG_PREFIX} starting — scanning ${EXTENSION_ROOTS.length} root(s)`);

    // Status endpoint — list which extension backends are mounted.
    const status = { loaded: [], roots: EXTENSION_ROOTS };

    for (const root of EXTENSION_ROOTS) {
        const entries = findServerEntries(root);
        for (const e of entries) {
            const exitFn = await loadExtensionServer(e, router);
            if (exitFn) exitCallbacks.push({ name: e.name, exit: exitFn });
            status.loaded.push({ name: e.name, user: e.user, entry: e.entry });
        }
    }

    router.get('/status', (_req, res) => res.json(status));

    if (status.loaded.length === 0) {
        console.log(`${LOG_PREFIX} no extension backends found — nothing mounted`);
    } else {
        console.log(`${LOG_PREFIX} mounted ${status.loaded.length} extension backend(s)`);
    }
}

async function exit() {
    for (const { name, exit: exitFn } of exitCallbacks) {
        try {
            await exitFn();
        } catch (e) {
            console.warn(`${LOG_PREFIX} ${name}.exit() threw:`, e);
        }
    }
}

module.exports = {
    init,
    exit,
    info: {
        id: 'st-ext-server-loader',
        name: 'Extension Server Loader',
        description: 'Auto-loads server-side code from third-party extensions (looks for <ext>/server/index.js).',
    },
};
