import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { createApp } from './app.js';
import { createStore } from './store.js';
import { hashPassword, setOwner } from './auth.js';

const username = 'test-owner';
// Deliberately public test-only credentials, never used in the real database.
const password = 'test-only-long-passphrase';
const passwordHash = await hashPassword(password);
function fixture(t, options = {}) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  store.put('auth', { id: 'owner', username, passwordHash });
  return { store, app: createApp(store, options) };
}
const login = (agent) => agent.post('/api/auth/login').send({ username, password });

test('anonymous reads, exports, mutations, demo and smart-entry are protected', async (t) => {
  const { app } = fixture(t);
  const api = request(app);
  for (const path of ['/api/state', '/api/export']) await api.get(path).expect(401);
  for (const path of ['/api/accounts', '/api/transactions', '/api/budgets', '/api/goals', '/api/investments', '/api/demo', '/api/smart-entry', '/api/goals/id/contributions']) await api.post(path).send({}).expect(401);
  await api.put('/api/accounts/id').send({}).expect(401);
  await api.delete('/api/accounts/id').send({}).expect(401);
  assert.deepEqual((await api.get('/api/auth/session')).body, { configured: true, authenticated: false });
});
test('unconfigured installation stays locked and has no public registration', async (t) => {
  const { app, store } = fixture(t);
  store.delete('auth', 'owner');
  await login(request(app)).expect(503);
  await request(app).post('/api/auth/register').send({ username, password }).expect(401);
  await request(app).get('/api/state').expect(401);
});
test('valid login creates an HttpOnly SameSite session, logout revokes it', async (t) => {
  const { app, store } = fixture(t);
  const agent = request.agent(app);
  const response = await login(agent).expect(200);
  const cookie = response.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  const token = cookie.split(';')[0].split('=')[1];
  assert.equal(store.all('sessions')[0].id, createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(store.all('sessions')).includes(token));
  await agent.get('/api/state').expect(200);
  assert.equal((await agent.get('/api/auth/session')).body.username, username);
  await agent.post('/api/auth/logout').send({}).expect(200);
  await agent.get('/api/state').expect(401);
  await request(app).get('/api/export').set('Cookie', cookie.split(';')[0]).expect(401);
});
test('wrong credentials use generic errors and cannot mint sessions', async (t) => {
  const { app, store } = fixture(t);
  for (const credentials of [{ username, password: 'incorrect' }, { username: 'somebody-else', password }, {}, { username, password: 'x'.repeat(300) }]) {
    const response = await request(app).post('/api/auth/login').send(credentials).expect(401);
    assert.equal(response.body.error, 'Invalid username or password.');
    assert.equal(response.headers['set-cookie'], undefined);
  }
  assert.equal(store.all('sessions').length, 0);
});
test('login attempts are rate limited', async (t) => {
  const { app } = fixture(t);
  for (let index = 0; index < 10; index++) await request(app).post('/api/auth/login').send({}).expect(401);
  await login(request(app)).expect(429);
});
test('expired and forged sessions fail; signing in rotates the old token', async (t) => {
  const { app, store } = fixture(t);
  const agent = request.agent(app);
  const first = await login(agent);
  const oldCookie = first.headers['set-cookie'][0].split(';')[0];
  await login(agent).expect(200);
  await request(app).get('/api/state').set('Cookie', oldCookie).expect(401);
  const session = store.all('sessions')[0];
  store.put('sessions', { ...session, expiresAt: Date.now() - 1 });
  await agent.get('/api/state').expect(401);
  await request(app).get('/api/state').set('Cookie', `pocket_session=${'0'.repeat(64)}`).expect(401);
  await request(app).get('/api/state').set('Cookie', 'pocket_session=%invalid').expect(401);
});
test('owner reset changes the hash and invalidates every device session', async (t) => {
  const { app, store } = fixture(t);
  const first = request.agent(app);
  const second = request.agent(app);
  await login(first).expect(200);
  await login(second).expect(200);
  await assert.rejects(setOwner(store, 'no', 'short'));
  await setOwner(store, 'new-owner', 'a-different-test-passphrase');
  assert.equal(store.all('sessions').length, 0);
  assert.notEqual(store.get('auth', 'owner').passwordHash, passwordHash);
  await first.get('/api/state').expect(401);
  await second.get('/api/state').expect(401);
  await login(request(app)).expect(401);
  await request(app).post('/api/auth/login').send({ username: 'new-owner', password: 'a-different-test-passphrase' }).expect(200);
});
test('owner password must be between 6 and 256 characters', async (t) => {
  const { store } = fixture(t);
  await assert.rejects(setOwner(store, 'new-owner', '12345'), /between 6 and 256 characters/);
  await setOwner(store, 'new-owner', '123456');
  assert.equal(store.get('auth', 'owner').username, 'new-owner');
});
test('production requires HTTPS origin, issues host-only Secure cookies and rejects CSRF', async (t) => {
  const { store } = fixture(t);
  assert.throws(() => createApp(store, { production: true }), /PUBLIC_ORIGIN/);
  assert.throws(() => createApp(store, { production: true, publicOrigin: 'http://pocket.example' }), /PUBLIC_ORIGIN/);
  const app = createApp(store, { production: true, publicOrigin: 'https://pocket.example', trustProxy: 1 });
  const api = request(app);
  await api.post('/api/auth/login').send({ username, password }).expect(403);
  await api.post('/api/auth/login').set('Origin', 'https://evil.example').send({ username, password }).expect(403);
  await api.post('/api/auth/login').set('Origin', 'https://pocket.example').send({ username, password }).expect(400);
  const response = await api.post('/api/auth/login').set('Origin', 'https://pocket.example').set('X-Forwarded-Proto', 'https').send({ username, password }).expect(200);
  assert.match(response.headers['set-cookie'][0], /^__Host-pocket_session=/);
  assert.match(response.headers['set-cookie'][0], /; Secure/);
  assert.doesNotMatch(response.headers['set-cookie'][0], /Domain=/);
  const cookie = response.headers['set-cookie'][0].split(';')[0];
  await api.get('/api/state').set('Cookie', cookie).expect(200);
  await api.post('/api/accounts').set('Origin', 'https://evil.example').set('Cookie', cookie).send({}).expect(403);
  await api.post('/api/auth/logout').set('Origin', 'https://pocket.example').set('Sec-Fetch-Site', 'cross-site').set('Cookie', cookie).send({}).expect(403);
});