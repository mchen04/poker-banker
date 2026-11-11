import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { z } from 'zod';
import type { Database, Transaction } from './db.js';
import { transaction } from './db.js';
import { ApiError } from './errors.js';
import type { AppContext, AppEnv, Banker } from './context.js';
import { username, password, loginPassword } from './validation.js';

const lifetime = 180 * 24 * 60 * 60;
const options = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const dummyHash = hash(randomBytes(32), options);
export const digest = (value: string) => createHash('sha256').update(value).digest();
const credentialsError = () => new ApiError(401, 'invalid_credentials', 'Credentials are invalid');

type AccountRow = Banker & { password_hash: string };
type Throttle = { key: string; failures: number; window_started_at: Date; locked_until: Date | null };

function cookie(c: AppContext, token: string) {
  setCookie(c, 'pb_session', token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: lifetime });
}
async function startSession(db: Transaction, banker: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query("INSERT INTO auth_sessions(id,banker_id,token_hash,expires_at) VALUES ($1,$2,$3,now() + interval '180 days')", [randomUUID(), banker, digest(token)]);
  return token;
}
async function newCodes(db: Transaction, banker: string) {
  await db.query('DELETE FROM recovery_codes WHERE banker_id = $1', [banker]);
  const codes = Array.from({ length: 10 }, () => randomBytes(16).toString('hex').match(/.{8}/g)!.join('-'));
  for (const code of codes) await db.query('INSERT INTO recovery_codes(id,banker_id,code_hash) VALUES ($1,$2,$3)', [randomUUID(), banker, digest(code)]);
  return codes;
}
async function checkPassword(stored: string | undefined, input: string) {
  const dummy = await dummyHash;
  const valid = await verify(stored ?? dummy, input);
  return !!stored && valid;
}

async function guarded<T>(pool: Database, user: string, ip: string, attempt: (db: Transaction, account: AccountRow | undefined) => Promise<T | undefined>): Promise<T> {
  const outcome = await transaction(pool, async db => {
    const keys = [`ip:${ip}`, `username:${user}`].sort();
    const states: Throttle[] = [];
    for (const key of keys) {
      await db.query('INSERT INTO login_throttle(key) VALUES ($1) ON CONFLICT DO NOTHING', [key]);
      const result = await db.query<Throttle>('SELECT * FROM login_throttle WHERE key = $1 FOR UPDATE', [key]);
      states.push(result.rows[0]!);
    }
    const now = Date.now();
    if (states.some(state => state.locked_until && state.locked_until.getTime() > now)) return { error: new ApiError(429, 'auth_locked', 'Try again later') };
    const account = await db.query<AccountRow>('SELECT id,username,password_hash FROM bankers WHERE username = $1 FOR UPDATE', [user]);
    const result = await attempt(db, account.rows[0]);
    if (result !== undefined) {
      await db.query('UPDATE login_throttle SET failures = 0, window_started_at = now(), locked_until = NULL WHERE key = ANY($1::text[])', [keys]);
      return { result };
    }
    let locked = false;
    for (const state of states) {
      const stale = !state.locked_until && now - state.window_started_at.getTime() >= 15 * 60 * 1000;
      const failures = (stale ? 0 : state.failures) + 1;
      const lock = failures % 5 === 0;
      const duration = Math.min(24 * 60, 15 * 2 ** Math.min(7, Math.floor(failures / 5) - 1));
      await db.query(`UPDATE login_throttle SET failures = $2,
        window_started_at = CASE WHEN $3 THEN now() ELSE window_started_at END,
        locked_until = CASE WHEN $4 THEN now() + ($5 * interval '1 minute') ELSE NULL END WHERE key = $1`,
      [state.key, failures, stale || lock || state.locked_until !== null, lock, duration]);
      locked ||= lock;
    }
    return { error: locked ? new ApiError(429, 'auth_locked', 'Try again later') : credentialsError() };
  });
  if ('error' in outcome) throw outcome.error;
  return outcome.result;
}

export async function authenticate(pool: Database, c: AppContext): Promise<Banker> {
  const token = getCookie(c, 'pb_session');
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(401, 'unauthorized', 'Sign in to continue');
  const result = await pool.query<Banker>(`UPDATE auth_sessions a SET last_seen_at = now(), expires_at = now() + interval '180 days'
    FROM bankers b WHERE a.banker_id = b.id AND a.token_hash = $1 AND a.expires_at > now() RETURNING b.id, b.username`, [digest(token)]);
  const banker = result.rows[0];
  if (!banker) throw new ApiError(401, 'unauthorized', 'Sign in to continue');
  c.header('X-PB-Banker-ID', banker.id);
  const expectedBanker = c.req.header('X-PB-Expected-Banker-ID');
  if (expectedBanker && expectedBanker !== banker.id) throw new ApiError(409, 'account_changed', 'Account changed. Sign in to check your saved work.');
  cookie(c, token);
  c.set('banker', banker);
  return banker;
}

export function authRoutes(pool: Database, ip: (c: AppContext) => string) {
  const router = new Hono<AppEnv>();
  router.post('/signup', async c => {
    const input = z.strictObject({ username, password }).parse(await c.req.json());
    const passwordHash = await hash(input.password, options);
    const result = await transaction(pool, async db => {
      const banker = { id: randomUUID(), username: input.username };
      const inserted = await db.query('INSERT INTO bankers(id,username,password_hash) VALUES ($1,$2,$3) ON CONFLICT (username) DO NOTHING RETURNING id', [banker.id, banker.username, passwordHash]);
      if (!inserted.rowCount) throw new ApiError(409, 'username_unavailable', 'Choose another username');
      const recovery_codes = await newCodes(db, banker.id);
      const token = await startSession(db, banker.id);
      return { banker, recovery_codes, token };
    });
    cookie(c, result.token);
    return c.json({ banker: result.banker, recovery_codes: result.recovery_codes });
  });
  router.post('/login', async c => {
    const input = z.strictObject({ username, password: loginPassword }).parse(await c.req.json());
    const result = await guarded(pool, input.username, ip(c), async (db, account) => {
      if (!await checkPassword(account?.password_hash, input.password) || !account) return;
      return { banker: { id: account.id, username: account.username }, token: await startSession(db, account.id) };
    });
    cookie(c, result.token);
    return c.json({ banker: result.banker });
  });
  router.post('/recover', async c => {
    const input = z.strictObject({ username, recovery_code: z.string().min(1).max(100), new_password: password }).parse(await c.req.json());
    const result = await guarded(pool, input.username, ip(c), async (db, account) => {
      const passwordHash = await hash(input.new_password, options);
      if (!account) return;
      const code = await db.query('UPDATE recovery_codes SET used_at = now() WHERE banker_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id', [account.id, digest(input.recovery_code)]);
      if (!code.rowCount) return;
      await db.query('UPDATE bankers SET password_hash = $2, password_changed_at = now() WHERE id = $1', [account.id, passwordHash]);
      await db.query('DELETE FROM auth_sessions WHERE banker_id = $1', [account.id]);
      return { banker: { id: account.id, username: account.username } };
    });
    deleteCookie(c, 'pb_session', { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
    return c.json(result);
  });
  router.use('*', async (c, next) => { await authenticate(pool, c); await next(); });
  router.get('/me', c => c.json({ banker: c.get('banker') }));
  router.post('/logout', async c => {
    const body = await c.req.text();
    z.strictObject({}).parse(body === '' ? {} : JSON.parse(body));
    await pool.query('DELETE FROM auth_sessions WHERE banker_id = $1 AND token_hash = $2', [c.get('banker').id, digest(getCookie(c, 'pb_session')!)]);
    deleteCookie(c, 'pb_session', { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
    return c.json({ ok: true });
  });
  router.post('/recovery-codes', async c => {
    const input = z.strictObject({ password: loginPassword }).parse(await c.req.json());
    const result = await guarded(pool, c.get('banker').username, ip(c), async (db, account) => {
      if (!account || !await checkPassword(account.password_hash, input.password)) return;
      return { recovery_codes: await newCodes(db, account.id) };
    });
    return c.json(result);
  });
  router.post('/password', async c => {
    const input = z.strictObject({ current_password: loginPassword, new_password: password }).parse(await c.req.json());
    await guarded(pool, c.get('banker').username, ip(c), async (db, account) => {
      if (!account || !await checkPassword(account.password_hash, input.current_password)) return;
      await db.query('UPDATE bankers SET password_hash = $2, password_changed_at = now() WHERE id = $1', [account.id, await hash(input.new_password, options)]);
      await db.query('DELETE FROM auth_sessions WHERE banker_id = $1 AND token_hash <> $2', [account.id, digest(getCookie(c, 'pb_session')!)]);
      return true;
    });
    return c.json({ ok: true });
  });
  return router;
}
