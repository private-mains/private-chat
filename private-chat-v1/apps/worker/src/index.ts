export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  APP_NAME: string;
  APP_URL: string;
  MAX_FILE_SIZE_BYTES: string;
  SESSION_SECRET: string;
}

type User = {
  id: string;
  email: string;
  display_name: string;
  is_admin: number;
  is_active: number;
};

type Session = {
  id: string;
  user_id: string;
  expires_at: string;
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const COOKIE_NAME = 'private_chat_session';
const MAX_MESSAGE_LENGTH = 2000;
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path.startsWith('/api/')) {
        return withSecurityHeaders(await handleApi(request, env, url));
      }

      if (path.startsWith('/files/')) {
        return withSecurityHeaders(await handleFileDownload(request, env, url));
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return withSecurityHeaders(json({ error: 'Internal server error' }, 500));
    }
  },
};

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === '/api/health' && method === 'GET') {
    return json({ ok: true, app: env.APP_NAME, now: new Date().toISOString() });
  }

  if (path === '/api/auth/register' && method === 'POST') {
    return register(request, env);
  }

  if (path === '/api/auth/login' && method === 'POST') {
    return login(request, env);
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    return logout(request, env);
  }

  if (path === '/api/auth/me' && method === 'GET') {
    const auth = await requireUser(request, env);
    if (!auth.ok) return auth.response;
    return json({ user: auth.user });
  }

  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const user = auth.user;

  if (path === '/api/users' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (!q) return json({ users: [] });
    const stmt = env.DB.prepare(
      `SELECT id, email, display_name, is_admin, is_active
       FROM users
       WHERE is_active = 1 AND id != ? AND (lower(email) LIKE ? OR lower(display_name) LIKE ?)
       ORDER BY display_name ASC
       LIMIT 12`
    );
    const users = await stmt.bind(user.id, `%${q}%`, `%${q}%`).all<User>();
    return json({ users: users.results || [] });
  }

  if (path === '/api/conversations' && method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT c.id,
              c.updated_at,
              c.last_message_at,
              u.id AS other_user_id,
              u.display_name AS other_display_name,
              u.email AS other_email,
              (
                SELECT body
                FROM messages m
                WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
                ORDER BY m.created_at DESC
                LIMIT 1
              ) AS last_message_body,
              (
                SELECT m.id
                FROM messages m
                WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
                ORDER BY m.created_at DESC
                LIMIT 1
              ) AS last_message_id,
              cm.last_read_message_id AS my_last_read_message_id
       FROM conversations c
       JOIN conversation_members me ON me.conversation_id = c.id AND me.user_id = ?
       JOIN conversation_members other ON other.conversation_id = c.id AND other.user_id != ?
       JOIN users u ON u.id = other.user_id
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
       ORDER BY COALESCE(c.last_message_at, c.updated_at) DESC`
    ).bind(user.id, user.id, user.id).all<any>();

    return json({ conversations: rows.results || [] });
  }

  if (path === '/api/conversations' && method === 'POST') {
    const body = await readJson(request);
    const email = String(body?.email || '').trim().toLowerCase();
    if (!email) return json({ error: 'Client email is required' }, 400);
    if (email === user.email.toLowerCase()) return json({ error: 'You cannot chat with yourself' }, 400);

    const other = await env.DB.prepare(
      `SELECT id, email, display_name, is_admin, is_active FROM users WHERE lower(email) = ? LIMIT 1`
    ).bind(email).first<User>();

    if (!other || !other.is_active) return json({ error: 'Client not found' }, 404);

    const existing = await env.DB.prepare(
      `SELECT c.id
       FROM conversations c
       JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ?
       JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = ?
       WHERE c.type = 'direct'
       LIMIT 1`
    ).bind(user.id, other.id).first<{ id: string }>();

    if (existing) return json({ conversationId: existing.id, existing: true });

    const now = isoNow();
    const conversationId = randomId();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO conversations (id, type, created_by, created_at, updated_at) VALUES (?, 'direct', ?, ?, ?)`)
        .bind(conversationId, user.id, now, now),
      env.DB.prepare(`INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)`)
        .bind(conversationId, user.id, now),
      env.DB.prepare(`INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)`)
        .bind(conversationId, other.id, now),
    ]);

    return json({ conversationId, existing: false });
  }

  const convoMatch = path.match(/^\/api\/conversations\/([^/]+)(?:\/(messages|read|upload))?$/);
  if (convoMatch) {
    const conversationId = convoMatch[1];
    const action = convoMatch[2] || '';

    const allowed = await assertConversationMember(env, conversationId, user.id);
    if (!allowed) return json({ error: 'Conversation not found' }, 404);

    if (action === 'messages' && method === 'GET') {
      const before = url.searchParams.get('before') || '9999-12-31T23:59:59.999Z';
      const rows = await env.DB.prepare(
        `SELECT m.id, m.body, m.message_type, m.created_at, m.sender_id,
                a.id AS attachment_id, a.original_name, a.mime_type, a.size_bytes
         FROM messages m
         LEFT JOIN attachments a ON a.message_id = m.id
         WHERE m.conversation_id = ? AND m.deleted_at IS NULL AND m.created_at < ?
         ORDER BY m.created_at DESC
         LIMIT 30`
      ).bind(conversationId, before).all<any>();
      const messages = (rows.results || []).reverse().map(mapMessageRow);
      return json({ messages });
    }

    if (action === 'messages' && method === 'POST') {
      const body = await readJson(request);
      const text = String(body?.body || '').trim();
      if (!text) return json({ error: 'Message body is required' }, 400);
      if (text.length > MAX_MESSAGE_LENGTH) return json({ error: 'Message too long' }, 400);
      const message = await createMessage(env, conversationId, user.id, text, 'text');
      return json({ message }, 201);
    }

    if (action === 'read' && method === 'POST') {
      const body = await readJson(request);
      const messageId = String(body?.messageId || '').trim();
      if (!messageId) return json({ error: 'messageId is required' }, 400);
      await env.DB.prepare(
        `UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?`
      ).bind(messageId, conversationId, user.id).run();
      return json({ ok: true });
    }

    if (action === 'upload' && method === 'POST') {
      return uploadAttachment(request, env, user, conversationId);
    }
  }

  if (path === '/api/admin/users' && method === 'GET') {
    if (!user.is_admin) return json({ error: 'Forbidden' }, 403);
    const rows = await env.DB.prepare(
      `SELECT id, email, display_name, is_active, is_admin, created_at FROM users ORDER BY created_at DESC LIMIT 100`
    ).all();
    return json({ users: rows.results || [] });
  }

  return json({ error: 'Not found' }, 404);
}

async function register(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  const displayName = String(body?.displayName || '').trim();

  if (!isEmail(email)) return json({ error: 'Valid email is required' }, 400);
  if (displayName.length < 2) return json({ error: 'Display name must be at least 2 characters' }, 400);
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);

  const existing = await env.DB.prepare(`SELECT id FROM users WHERE lower(email) = ? LIMIT 1`).bind(email).first();
  if (existing) return json({ error: 'Email already exists' }, 409);

  const now = isoNow();
  const userId = randomId();
  const passwordHash = await hashPassword(password);
  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, is_verified, is_active, is_admin, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1, 0, ?, ?)`
  ).bind(userId, email, passwordHash, displayName, now, now).run();

  const session = await createSession(env, userId, request);
  return withSession(json({ ok: true, user: { id: userId, email, display_name: displayName, is_admin: 0, is_active: 1 } }, 201), session.cookie);
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');

  const user = await env.DB.prepare(
    `SELECT id, email, password_hash, display_name, is_admin, is_active FROM users WHERE lower(email) = ? LIMIT 1`
  ).bind(email).first<any>();

  if (!user || !user.is_active) return json({ error: 'Invalid email or password' }, 401);
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return json({ error: 'Invalid email or password' }, 401);

  const session = await createSession(env, user.id, request);
  return withSession(json({ ok: true, user: { id: user.id, email: user.email, display_name: user.display_name, is_admin: user.is_admin, is_active: user.is_active } }), session.cookie);
}

async function logout(request: Request, env: Env): Promise<Response> {
  const sessionId = getCookie(request, COOKIE_NAME);
  if (sessionId) {
    await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`).bind(isoNow(), sessionId).run();
  }
  const response = json({ ok: true });
  response.headers.append('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  return response;
}

async function handleFileDownload(request: Request, env: Env, url: URL): Promise<Response> {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const attachmentId = url.pathname.split('/').pop() || '';

  const row = await env.DB.prepare(
    `SELECT a.id, a.r2_key, a.original_name, a.mime_type, a.size_bytes, m.conversation_id
     FROM attachments a
     JOIN messages m ON m.id = a.message_id
     WHERE a.id = ? LIMIT 1`
  ).bind(attachmentId).first<any>();

  if (!row) return new Response('Not found', { status: 404 });
  const allowed = await assertConversationMember(env, row.conversation_id, auth.user.id);
  if (!allowed) return new Response('Forbidden', { status: 403 });

  const object = await env.FILES.get(row.r2_key);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('content-type', row.mime_type);
  headers.set('content-length', String(row.size_bytes));
  headers.set('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
  return new Response(object.body, { headers });
}

async function uploadAttachment(request: Request, env: Env, user: User, conversationId: string): Promise<Response> {
  const form = await request.formData();
  const file = form.get('file');
  const caption = String(form.get('caption') || '').trim();
  if (!(file instanceof File)) return json({ error: 'File is required' }, 400);
  const maxFile = Number(env.MAX_FILE_SIZE_BYTES || '3145728');
  if (file.size > maxFile) return json({ error: 'File exceeds 3 MB limit' }, 400);
  const mimeType = file.type || 'application/octet-stream';
  if (!ALLOWED_MIME.has(mimeType)) return json({ error: 'File type not allowed' }, 400);

  const message = await createMessage(env, conversationId, user.id, caption || file.name, mimeType.startsWith('image/') ? 'image' : 'file');
  const attachmentId = randomId();
  const r2Key = `attachments/${conversationId}/${message.id}/${attachmentId}`;
  const bytes = await file.arrayBuffer();
  const checksum = await sha256Hex(bytes);

  await env.FILES.put(r2Key, bytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { originalName: file.name, uploaderId: user.id, conversationId },
  });

  await env.DB.prepare(
    `INSERT INTO attachments (id, message_id, uploader_id, r2_key, original_name, mime_type, size_bytes, checksum_sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(attachmentId, message.id, user.id, r2Key, file.name, mimeType, file.size, checksum, isoNow()).run();

  const fullMessage = await env.DB.prepare(
    `SELECT m.id, m.body, m.message_type, m.created_at, m.sender_id,
            a.id AS attachment_id, a.original_name, a.mime_type, a.size_bytes
     FROM messages m
     LEFT JOIN attachments a ON a.message_id = m.id
     WHERE m.id = ? LIMIT 1`
  ).bind(message.id).first<any>();

  return json({ message: mapMessageRow(fullMessage) }, 201);
}

async function createMessage(env: Env, conversationId: string, senderId: string, body: string, type: string) {
  const now = isoNow();
  const messageId = randomId();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, sender_id, body, message_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(messageId, conversationId, senderId, body, type, now),
    env.DB.prepare(`UPDATE conversations SET updated_at = ?, last_message_at = ? WHERE id = ?`).bind(now, now, conversationId),
  ]);
  return { id: messageId, conversation_id: conversationId, sender_id: senderId, body, message_type: type, created_at: now };
}

function mapMessageRow(row: any) {
  return {
    id: row.id,
    body: row.body,
    message_type: row.message_type,
    created_at: row.created_at,
    sender_id: row.sender_id,
    attachment: row.attachment_id
      ? {
          id: row.attachment_id,
          original_name: row.original_name,
          mime_type: row.mime_type,
          size_bytes: row.size_bytes,
          url: `/files/${row.attachment_id}`,
        }
      : null,
  };
}

async function requireUser(request: Request, env: Env): Promise<{ ok: true; user: User } | { ok: false; response: Response }> {
  const sessionId = getCookie(request, COOKIE_NAME);
  if (!sessionId) return { ok: false, response: json({ error: 'Unauthorized' }, 401) };
  const session = await env.DB.prepare(
    `SELECT id, user_id, expires_at FROM sessions WHERE id = ? AND revoked_at IS NULL LIMIT 1`
  ).bind(sessionId).first<Session>();
  if (!session) return { ok: false, response: json({ error: 'Unauthorized' }, 401) };
  if (new Date(session.expires_at).getTime() < Date.now()) {
    return { ok: false, response: json({ error: 'Session expired' }, 401) };
  }
  const user = await env.DB.prepare(
    `SELECT id, email, display_name, is_admin, is_active FROM users WHERE id = ? LIMIT 1`
  ).bind(session.user_id).first<User>();
  if (!user || !user.is_active) return { ok: false, response: json({ error: 'Unauthorized' }, 401) };
  return { ok: true, user };
}

async function createSession(env: Env, userId: string, request: Request) {
  const id = randomId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 14).toISOString();
  const ua = request.headers.get('user-agent') || '';
  const ip = request.headers.get('cf-connecting-ip') || '';
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, expires_at, created_at, revoked_at, ip_address, user_agent)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`
  ).bind(id, userId, expiresAt, now.toISOString(), ip, ua).run();
  const cookie = `${COOKIE_NAME}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 14}`;
  return { id, cookie };
}

async function assertConversationMember(env: Env, conversationId: string, userId: string) {
  const row = await env.DB.prepare(
    `SELECT 1 as ok FROM conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1`
  ).bind(conversationId, userId).first();
  return Boolean(row);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function withSession(response: Response, cookie: string) {
  response.headers.append('Set-Cookie', cookie);
  return response;
}

function getCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get('cookie') || '';
  const parts = cookieHeader.split(';').map((part) => part.trim());
  const found = parts.find((part) => part.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isoNow() {
  return new Date().toISOString();
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, key, 256);
  return `${toBase64(salt)}:${toBase64(new Uint8Array(bits))}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltB64, hashB64] = stored.split(':');
  if (!saltB64 || !hashB64) return false;
  const salt = fromBase64(saltB64);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, key, 256);
  const candidate = new Uint8Array(bits);
  const original = fromBase64(hashB64);
  return timingSafeEqual(candidate, original);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sha256Hex(data: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function withSecurityHeaders(response: Response) {
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'same-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  response.headers.set('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  return response;
}
