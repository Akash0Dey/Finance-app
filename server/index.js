import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openStore } from './database.js';

const store = await openStore();
const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 5) throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 5.');
const app = createApp(store, { production: process.env.NODE_ENV === 'production', publicOrigin: process.env.PUBLIC_ORIGIN, trustProxy: proxyHops || false });
if (!await store.get('auth', 'owner')) console.warn('Pocket is locked. Run npm run setup-owner with the same database configuration before signing in.');
const dist = fileURLToPath(new URL('../dist', import.meta.url));
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('/{*path}', (req, res) => res.sendFile(`${dist}/index.html`));
}
const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && process.env.NODE_ENV !== 'production') console.warn('Development HTTP is unencrypted. Use localhost; online deployment requires production mode and HTTPS.');
const port = Number(process.env.PORT || 3001);
const server = app.listen(port, host, () => console.log(`Pocket: port ${port} — owner login required`));
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    try { await store.close(); process.exit(0); }
    catch { console.error('Database cleanup failed during shutdown.'); process.exit(1); }
  });
});