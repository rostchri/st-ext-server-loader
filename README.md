# st-ext-server-loader

SillyTavern server-plugin that **auto-loads server-side Express routes shipped
inside third-party extensions**. Lets extension authors put their backend code
in a `server/` subdirectory of the extension repo without needing a separate
ST-plugin install per extension.

## Why?

SillyTavern's architecture splits browser code (third-party extensions) from
server-side code (plugins) — they live in different directories with different
loaders. For extensions that need to do server-side things (CORS-free backend
calls, secret-bearing fetches, server-only secrets), this means shipping two
deliverables.

This loader removes that split by **discovering server-side code inside the
extension itself**:

```
<extension-root>/
├── manifest.json        ← browser-extension entry
├── index.js             ← browser code
└── server/              ← NEW — auto-discovered
    ├── package.json
    └── index.js         ← exports init(router), exit()
```

## Installation

This is a SillyTavern *server plugin*, not an extension. It must be present in
SillyTavern's `plugins/` directory at startup (it scans extensions on init,
**not** at runtime).

### Compose / Docker

```yaml
services:
  sillytavern:
    image: ghcr.io/sillytavern/sillytavern:<version>
    environment:
      - "SILLYTAVERN_ENABLESERVERPLUGINS=true"
    volumes:
      - ./plugins:/home/node/app/plugins:ro
```

```
./plugins/st-ext-server-loader/
├── package.json
└── index.js
```

### Manual

```sh
# In the SillyTavern container (or pre-built image):
cd /home/node/app/plugins
git clone https://github.com/rostchri/st-ext-server-loader.git
# Restart the container
```

Then verify `enableServerPlugins: true` in `config.yaml` (or set
`SILLYTAVERN_ENABLESERVERPLUGINS=true` as env-var — ST upstream maps this
automatically).

## Extension contract

An extension that wants a backend just adds a `server/` subdirectory with an
`index.js` that exports `init(router)` and `exit()`:

```js
// <extension-root>/server/index.js

async function init(router) {
    router.post('/generate', async (req, res) => {
        // Do server-side work here — fetch external APIs, read secrets,
        // proxy through internal networks, etc.
        const result = await fetch(process.env.MY_BACKEND_URL + '/foo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body),
        });
        const data = await result.json();
        res.json(data);
    });
}

async function exit() {
    // optional teardown
}

module.exports = { init, exit };
```

Routes are mounted under:

```
/api/plugins/st-ext-server-loader/ext/<extension-name>/<your-route>
```

From the browser extension:

```js
const r = await fetch(
    '/api/plugins/st-ext-server-loader/ext/<extension-name>/generate',
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ... }) },
);
const data = await r.json();
```

## Discovery roots

The loader scans two locations on startup:

| Path | Purpose |
|---|---|
| `/home/node/app/public/scripts/extensions/third-party/<ext>/server/index.js` | global third-party install |
| `/home/node/app/data/<user>/extensions/<ext>/server/index.js`                  | per-user install (via "Install from URL") |

For each discovered entry, the loader:
1. `require()`s the module (with cache-bust)
2. Calls `init(subRouter)`
3. Mounts `subRouter` at `/ext/<extension-name>`

## Status endpoint

```
GET /api/plugins/st-ext-server-loader/status
```

Returns a JSON list of which extensions were detected + mounted.

## Limitations

- **Restart required for extension updates**: Node.js caches required modules.
  When you update an extension's `server/` code via "Install from URL" or
  manual git pull, restart the SillyTavern container so the new code is
  picked up. (A `/reload` endpoint that hot-reloads is on the roadmap.)
- **Trust boundary**: Server plugins run with full Node.js privileges — they
  can read any file the ST process can. Only install extensions you trust.
  This loader does NOT add extra isolation. (ST's plugin docs note the same.)

## License

MIT — see [LICENSE](LICENSE).
