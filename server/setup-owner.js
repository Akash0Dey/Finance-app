import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { openStore } from './database.js';
import { setOwner } from './auth.js';

if (!process.stdin.isTTY) {
  console.error('Run npm run setup-owner in an interactive server terminal. Passwords are never accepted as command-line arguments.');
  process.exit(1);
}
let hidden = false;
const output = new Writable({ write(chunk, encoding, done) { if (!hidden) process.stdout.write(chunk, encoding); done(); } });
const terminal = createInterface({ input: process.stdin, output, terminal: true });
let store;
try {
  if (process.argv.includes('--require-postgres') && !process.env.DATABASE_URL) throw new Error('Set DATABASE_URL in .env.neon before configuring the Neon owner. Nothing changed.');
  store = await openStore();
  console.log(process.env.DATABASE_URL ? 'Target: PostgreSQL (DATABASE_URL). Local SQLite is unchanged.' : 'Target: local SQLite.');
  console.log('Configure the only Pocket owner. Re-running this command replaces the login and signs out all devices.');
  const username = (await terminal.question('Username: ')).trim();
  process.stdout.write('Password / passphrase (6–256 characters; hidden): ');
  hidden = true;
  const password = await terminal.question('');
  hidden = false;
  process.stdout.write('\nConfirm password (hidden): ');
  hidden = true;
  const confirm = await terminal.question('');
  hidden = false;
  process.stdout.write('\n');
  if (password !== confirm) throw new Error('Passwords do not match. Nothing changed.');
  await setOwner(store, username, password);
  console.log('Owner login saved. Open Pocket and sign in. No server restart is needed.');
} catch (error) {
  hidden = false;
  console.error(`\n${error.message}`);
  process.exitCode = 1;
} finally {
  terminal.close();
  await store?.close();
}