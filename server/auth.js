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
  await store.atomic(async (tx) => {
    await tx.put('auth', { id: 'owner', username, passwordHash });
    for (const session of await tx.all('sessions')) await tx.delete('sessions', session.id);
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
  const sessionFor = async (req, tx) => {
    const token = cookieToken(req);
    if (!token) return null;
    const session = await tx.get('sessions', hashToken(token));
    if (!session) return null;
    if (session.expiresAt <= Date.now()) return null;
    return session;
  };
  app.get('/api/auth/session', async (req, res) => {
    const result = await store.atomic(async (tx) => {
      const owner = await tx.get('auth', 'owner');
      const session = await sessionFor(req, tx);
      return { configured: Boolean(owner), authenticated: Boolean(owner && session), ...(owner && session ? { username: owner.username } : {}) };
    });
    res.json(result);
  });
  const limits = { windowMs: 15 * 60 * 1000, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Please try again in 15 minutes.' } };
  const globalLimit = rateLimit({ ...limits, limit: 50, keyGenerator: () => 'owner-login' });
  const perIpLimit = rateLimit({ ...limits, limit: 10 });
  app.post('/api/auth/login', globalLimit, perIpLimit, async (req, res) => {
    if (production && !req.secure) return res.status(400).json({ error: 'HTTPS is required to sign in.' });
    const owner = await store.get('auth', 'owner');
    if (!owner) return res.status(503).json({ error: 'Owner login is not configured. Run npm run setup-owner in the server terminal.' });
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || username.length > 100 || typeof password !== 'string' || password.length > 256 || !password.length) return res.status(401).json({ error: 'Invalid username or password.' });
    const valid = await verifyPassword(password, username === owner.username ? owner.passwordHash : await dummyHash);
    if (!valid || username !== owner.username) return res.status(401).json({ error: 'Invalid username or password.' });
    const token = randomBytes(32).toString('hex');
    const saved = await store.atomic(async (tx) => {
      // A password reset during scrypt must not create a session for the old owner.
      const current = await tx.get('auth', 'owner');
      if (!current || current.username !== owner.username || current.passwordHash !== owner.passwordHash) return false;
      for (const session of await tx.all('sessions')) if (session.expiresAt <= Date.now()) await tx.delete('sessions', session.id);
      const previous = cookieToken(req);
      if (previous) await tx.delete('sessions', hashToken(previous));
      const sessions = await tx.all('sessions');
      for (const session of sessions.slice(0, Math.max(0, sessions.length - 19))) await tx.delete('sessions', session.id);
      await tx.put('sessions', { id: hashToken(token), expiresAt: Date.now() + sessionDuration });
      return true;
    });
    if (!saved) return res.status(401).json({ error: 'Invalid username or password.' });
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionDuration });
    res.json({ authenticated: true, username: owner.username });
  });
  app.post('/api/auth/logout', async (req, res) => {
    const token = cookieToken(req);
    if (token) await store.atomic((tx) => tx.delete('sessions', hashToken(token)));
    res.clearCookie(cookieName, cookieOptions);
    res.json({ ok: true });
  });
  app.use('/api', async (req, res, next) => {
    const authenticated = await store.atomic(async (tx) => Boolean(await tx.get('auth', 'owner') && await sessionFor(req, tx)));
    if (!authenticated) return res.status(401).json({ error: 'Please sign in to access your finances.' });
    next();
  });
}