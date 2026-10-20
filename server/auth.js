import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { rateLimit } from 'express-rate-limit';

const scrypt = promisify(scryptCallback);
const sessionDuration = 12 * 60 * 60 * 1000;
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const hashOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, hashOptions);
  return `scrypt:${salt}:${key.toString('hex')}`;
}

async function verifyPassword(password, encoded) {
  const [, salt, expected] = encoded.split(':');
  const key = await scrypt(password, salt, 64, hashOptions);
  const stored = Buffer.from(expected, 'hex');
  return stored.length === key.length && timingSafeEqual(stored, key);
}

export async function setOwner(store, username, password) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.@-]{3,100}$/.test(username)) throw new Error('Username must be 3–100 letters, digits, or _.@- characters.');
  if (typeof password !== 'string' || password.length < 6 || password.length > 256) throw new Error('Use a unique password or passphrase between 6 and 256 characters.');
  const passwordHash = await hashPassword(password);
  store.atomic(() => {
    store.put('auth', { id: 'owner', username, passwordHash });
    for (const session of store.all('sessions')) store.delete('sessions', session.id);
  });
}

export function installAuth(app, store, { production = false } = {}) {
  const cookieName = production ? '__Host-pocket_session' : 'pocket_session';
  const cookieOptions = { httpOnly: true, secure: production, sameSite: 'strict', path: '/' };
  // Do password work even for an unknown username to avoid a fast username oracle.
  const dummyHash = hashPassword(randomBytes(32).toString('hex'));
  const cookieToken = (req) => {
    const entry = (req.get('cookie') ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
    const value = entry?.slice(cookieName.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
  };
  const sessionFor = (req) => {
    const token = cookieToken(req);
    if (!token) return null;
    const session = store.get('sessions', hashToken(token));
    if (!session) return null;
    if (session.expiresAt <= Date.now()) { store.delete('sessions', session.id); return null; }
    return session;
  };
  app.get('/api/auth/session', (req, res) => {
    const owner = store.get('auth', 'owner');
    const session = sessionFor(req);
    res.json({ configured: Boolean(owner), authenticated: Boolean(owner && session), ...(owner && session ? { username: owner.username } : {}) });
  });
  const limits = { windowMs: 15 * 60 * 1000, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Please try again in 15 minutes.' } };
  const globalLimit = rateLimit({ ...limits, limit: 50, keyGenerator: () => 'owner-login' });
  const perIpLimit = rateLimit({ ...limits, limit: 10 });
  app.post('/api/auth/login', globalLimit, perIpLimit, async (req, res) => {
    if (production && !req.secure) return res.status(400).json({ error: 'HTTPS is required to sign in.' });
    const owner = store.get('auth', 'owner');
    if (!owner) return res.status(503).json({ error: 'Owner login is not configured. Run npm run setup-owner in the server terminal.' });
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || username.length > 100 || typeof password !== 'string' || password.length > 256 || !password.length) return res.status(401).json({ error: 'Invalid username or password.' });
    const valid = await verifyPassword(password, username === owner.username ? owner.passwordHash : await dummyHash);
    if (!valid || username !== owner.username) return res.status(401).json({ error: 'Invalid username or password.' });
    for (const session of store.all('sessions')) if (session.expiresAt <= Date.now()) store.delete('sessions', session.id);
    const previous = cookieToken(req);
    if (previous) store.delete('sessions', hashToken(previous));
    // Bound the number of persisted sessions; signing in never reuses a supplied token.
    const sessions = store.all('sessions');
    for (const session of sessions.slice(0, Math.max(0, sessions.length - 19))) store.delete('sessions', session.id);
    const token = randomBytes(32).toString('hex');
    store.put('sessions', { id: hashToken(token), expiresAt: Date.now() + sessionDuration });
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionDuration });
    res.json({ authenticated: true, username: owner.username });
  });
  app.post('/api/auth/logout', (req, res) => {
    const token = cookieToken(req);
    if (token) store.delete('sessions', hashToken(token));
    res.clearCookie(cookieName, cookieOptions);
    res.json({ ok: true });
  });
  app.use('/api', (req, res, next) => {
    if (!store.get('auth', 'owner') || !sessionFor(req)) return res.status(401).json({ error: 'Please sign in to access your finances.' });
    next();
  });
}