'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const MAX_FILE_MB = 20;
const MAX_TOTAL_MB = Number(process.env.MAX_TOTAL_MB || 700); // общий лимит хранилища
const SESSION_DAYS = 30;
const SECRET = process.env.SESSION_SECRET || 'dev-secret';
const isLocalDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb || !/\./.test((process.env.DATABASE_URL || '').split('@')[1] || '') ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 5),
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fd_users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS fd_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INT NOT NULL REFERENCES fd_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fd_files (
      id SERIAL PRIMARY KEY,
      owner_id INT NOT NULL REFERENCES fd_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INT NOT NULL,
      data BYTEA NOT NULL,
      share_token TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS fd_messages (
      id SERIAL PRIMARY KEY,
      sender_id INT NOT NULL REFERENCES fd_users(id) ON DELETE CASCADE,
      recipient_id INT NOT NULL REFERENCES fd_users(id) ON DELETE CASCADE,
      body TEXT,
      file_id INT REFERENCES fd_files(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      read_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS fd_messages_pair ON fd_messages (sender_id, recipient_id, id);
    CREATE INDEX IF NOT EXISTS fd_messages_rcpt ON fd_messages (recipient_id, id);
    CREATE SEQUENCE IF NOT EXISTS fd_rev_seq;
    ALTER TABLE fd_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
    ALTER TABLE fd_messages ADD COLUMN IF NOT EXISTS rev BIGINT;
    UPDATE fd_messages SET rev = nextval('fd_rev_seq') WHERE rev IS NULL;
    ALTER TABLE fd_messages ALTER COLUMN rev SET DEFAULT nextval('fd_rev_seq');
    CREATE INDEX IF NOT EXISTS fd_messages_rev ON fd_messages (rev);
  `);
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const hashToken = (t) => crypto.createHmac('sha256', SECRET).update(t).digest('hex');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function loadUser(req) {
  const t = req.cookies && req.cookies.fd_sid;
  if (!t) return null;
  const r = await pool.query(
    `SELECT u.id, u.username FROM fd_sessions s JOIN fd_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`, [hashToken(t)]);
  return r.rows[0] || null;
}
const auth = wrap(async (req, res, next) => {
  const u = await loadUser(req);
  if (!u) return res.status(401).json({ error: 'Нужно войти' });
  req.user = u; next();
});

async function startSession(res, req, userId) {
  const t = crypto.randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO fd_sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '${SESSION_DAYS} days')`, [hashToken(t), userId]);
  res.cookie('fd_sid', t, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 864e5, path: '/' });
}

// простая защита от перебора
const attempts = new Map();
function tooMany(key) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter((t) => now - t < 10 * 60e3);
  a.push(now); attempts.set(key, a);
  return a.length > 20;
}

const USER_RE = /^[a-zA-Z0-9_а-яА-ЯёЁ.-]{3,24}$/;

app.post('/api/register', wrap(async (req, res) => {
  if (tooMany('r' + req.ip)) return res.status(429).json({ error: 'Слишком много попыток, подождите' });
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!USER_RE.test(username)) return res.status(400).json({ error: 'Имя: 3–24 символа (буквы, цифры, _ . -)' });
  if (password.length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
  const exists = await pool.query('SELECT 1 FROM fd_users WHERE lower(username) = lower($1)', [username]);
  if (exists.rowCount) return res.status(409).json({ error: 'Такое имя уже занято' });
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query('INSERT INTO fd_users (username, pass_hash) VALUES ($1,$2) RETURNING id, username', [username, hash]);
  await startSession(res, req, r.rows[0].id);
  res.json({ user: r.rows[0] });
}));

app.post('/api/login', wrap(async (req, res) => {
  if (tooMany('l' + req.ip)) return res.status(429).json({ error: 'Слишком много попыток, подождите 10 минут' });
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const r = await pool.query('SELECT id, username, pass_hash FROM fd_users WHERE lower(username) = lower($1)', [username]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(password, u.pass_hash))) return res.status(401).json({ error: 'Неверное имя или пароль' });
  await startSession(res, req, u.id);
  res.json({ user: { id: u.id, username: u.username } });
}));

app.post('/api/logout', wrap(async (req, res) => {
  const t = req.cookies.fd_sid;
  if (t) await pool.query('DELETE FROM fd_sessions WHERE token_hash = $1', [hashToken(t)]);
  res.clearCookie('fd_sid', { path: '/' });
  res.json({ ok: true });
}));

app.get('/api/me', wrap(async (req, res) => {
  const u = await loadUser(req);
  res.json({ user: u, maxFileMb: MAX_FILE_MB });
}));

app.get('/api/users', auth, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const r = await pool.query(
    `SELECT id, username FROM fd_users WHERE id <> $1 AND ($2 = '' OR username ILIKE '%' || $2 || '%')
     ORDER BY username LIMIT 50`, [req.user.id, q.replace(/[%_\\]/g, '')]);
  res.json({ users: r.rows });
}));

app.get('/api/conversations', auth, wrap(async (req, res) => {
  const me = req.user.id;
  const r = await pool.query(`
    WITH c AS (
      SELECT CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS other, MAX(id) AS last_id
      FROM fd_messages WHERE sender_id = $1 OR recipient_id = $1 GROUP BY 1
    )
    SELECT u.id, u.username, m.body, m.created_at, m.sender_id, f.name AS file_name, f.mime AS file_mime,
      (SELECT COUNT(*)::int FROM fd_messages x WHERE x.sender_id = u.id AND x.recipient_id = $1 AND x.read_at IS NULL AND u.id <> $1) AS unread
    FROM c JOIN fd_users u ON u.id = c.other JOIN fd_messages m ON m.id = c.last_id
    LEFT JOIN fd_files f ON f.id = m.file_id
    ORDER BY c.last_id DESC`, [me]);
  res.json({ conversations: r.rows });
}));

function msgRow(m) {
  return {
    id: m.id, sender_id: m.sender_id, recipient_id: m.recipient_id, body: m.body, created_at: m.created_at,
    edited_at: m.edited_at || null, rev: Number(m.rev || 0),
    file: m.file_id ? { id: m.file_id, name: m.file_name, mime: m.file_mime, size: m.file_size, share_token: m.share_token } : null,
  };
}
const MSG_SELECT = `SELECT m.*, f.name AS file_name, f.mime AS file_mime, f.size AS file_size, f.share_token
  FROM fd_messages m LEFT JOIN fd_files f ON f.id = m.file_id`;

async function findUser(name) {
  const r = await pool.query('SELECT id, username FROM fd_users WHERE lower(username) = lower($1)', [String(name || '')]);
  return r.rows[0];
}

app.get('/api/messages/:username', auth, wrap(async (req, res) => {
  const other = await findUser(req.params.username);
  if (!other) return res.status(404).json({ error: 'Пользователь не найден' });
  // since = последний известный клиенту rev: отдаём и новые, и изменённые сообщения
  const since = Number(req.query.since || 0);
  const after = Number(req.query.after || 0);
  const r = since > 0
    ? await pool.query(`${MSG_SELECT}
        WHERE ((m.sender_id = $1 AND m.recipient_id = $2) OR (m.sender_id = $2 AND m.recipient_id = $1)) AND m.rev > $3
        ORDER BY m.id DESC LIMIT 200`, [req.user.id, other.id, since])
    : await pool.query(`${MSG_SELECT}
        WHERE ((m.sender_id = $1 AND m.recipient_id = $2) OR (m.sender_id = $2 AND m.recipient_id = $1)) AND m.id > $3
        ORDER BY m.id DESC LIMIT 200`, [req.user.id, other.id, after]);
  await pool.query('UPDATE fd_messages SET read_at = now() WHERE sender_id = $1 AND recipient_id = $2 AND read_at IS NULL', [other.id, req.user.id]);
  res.json({ user: other, messages: r.rows.reverse().map(msgRow) });
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 } });

function fixName(n) {
  // multer отдаёт имя в latin1 — перекодируем в utf8 (кириллица)
  try { const d = Buffer.from(n, 'latin1').toString('utf8'); if (!d.includes('\uFFFD')) return d; } catch (e) {}
  return n;
}

app.post('/api/messages/:username', auth, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Файл больше ${MAX_FILE_MB} МБ` });
      return res.status(400).json({ error: 'Ошибка загрузки: ' + err.message });
    }
    next();
  });
}, wrap(async (req, res) => {
  const other = await findUser(req.params.username);
  if (!other) return res.status(404).json({ error: 'Пользователь не найден' });
  const body = String(req.body.text || '').slice(0, 5000).trim();
  if (!body && !req.file) return res.status(400).json({ error: 'Пустое сообщение' });
  let fileId = null;
  if (req.file) {
    const tot = await pool.query('SELECT COALESCE(SUM(size),0)::bigint AS s FROM fd_files');
    if (Number(tot.rows[0].s) + req.file.size > MAX_TOTAL_MB * 1024 * 1024)
      return res.status(507).json({ error: 'Хранилище сайта заполнено, удалите старые файлы' });
    const name = fixName(req.file.originalname || 'file').slice(0, 200);
    const mime = (req.file.mimetype || 'application/octet-stream').slice(0, 100);
    const f = await pool.query('INSERT INTO fd_files (owner_id, name, mime, size, data) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.user.id, name, mime, req.file.size, req.file.buffer]);
    fileId = f.rows[0].id;
  }
  const m = await pool.query('INSERT INTO fd_messages (sender_id, recipient_id, body, file_id) VALUES ($1,$2,$3,$4) RETURNING id',
    [req.user.id, other.id, body || null, fileId]);
  const r = await pool.query(`${MSG_SELECT} WHERE m.id = $1`, [m.rows[0].id]);
  res.json({ message: msgRow(r.rows[0]) });
}));

app.patch('/api/messages/:id', auth, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const cur = await pool.query('SELECT sender_id, recipient_id, file_id FROM fd_messages WHERE id = $1', [id]);
  const m = cur.rows[0];
  if (!m || (m.sender_id !== req.user.id && m.recipient_id !== req.user.id)) return res.status(404).json({ error: 'Сообщение не найдено' });
  if (m.sender_id !== req.user.id) return res.status(403).json({ error: 'Изменять можно только свои сообщения' });
  const body = String(req.body.text == null ? '' : req.body.text).slice(0, 5000).trim();
  if (!body && !m.file_id) return res.status(400).json({ error: 'Текст не может быть пустым' });
  await pool.query("UPDATE fd_messages SET body = $1, edited_at = now(), rev = nextval('fd_rev_seq') WHERE id = $2", [body || null, id]);
  const r = await pool.query(`${MSG_SELECT} WHERE m.id = $1`, [id]);
  res.json({ message: msgRow(r.rows[0]) });
}));

function cleanName(newName, oldName) {
  let n = String(newName || '').replace(/[\u0000-\u001f\u007f\/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  const oldExt = (oldName.match(/\.[^.\s]{1,10}$/) || [''])[0];
  const newExt = (n.match(/\.[^.\s]{1,10}$/) || [''])[0];
  if (oldExt && !newExt) n += oldExt; // сохраняем расширение, если его стёрли
  if (!n || n === oldExt) return null;
  return n.slice(0, 200);
}

app.patch('/api/files/:id', auth, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const cur = await pool.query(`SELECT f.owner_id, f.name FROM fd_files f WHERE f.id = $1 AND (f.owner_id = $2 OR EXISTS
     (SELECT 1 FROM fd_messages m WHERE m.file_id = f.id AND (m.sender_id = $2 OR m.recipient_id = $2)))`, [id, req.user.id]);
  const f = cur.rows[0];
  if (!f) return res.status(404).json({ error: 'Файл не найден' });
  if (f.owner_id !== req.user.id) return res.status(403).json({ error: 'Переименовать можно только свои файлы' });
  const name = cleanName(req.body.name, f.name);
  if (!name) return res.status(400).json({ error: 'Введите имя файла' });
  await pool.query('UPDATE fd_files SET name = $1 WHERE id = $2', [name, id]);
  await pool.query("UPDATE fd_messages SET rev = nextval('fd_rev_seq') WHERE file_id = $1", [id]);
  const r = await pool.query(`${MSG_SELECT} WHERE m.file_id = $1 ORDER BY m.id LIMIT 1`, [id]);
  res.json({ name, message: r.rows[0] ? msgRow(r.rows[0]) : null });
}));

app.delete('/api/messages/:id', auth, wrap(async (req, res) => {
  const r = await pool.query('DELETE FROM fd_messages WHERE id = $1 AND sender_id = $2 RETURNING file_id', [Number(req.params.id) || 0, req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Не найдено' });
  if (r.rows[0].file_id) await pool.query('DELETE FROM fd_files WHERE id = $1', [r.rows[0].file_id]);
  res.json({ ok: true });
}));

const INLINE_MIME = /^(image\/(png|jpe?g|gif|webp|bmp|avif)|video\/(mp4|webm)|audio\/(mpeg|ogg|wav|webm|mp4))$/;
function sendFile(res, f, forceDownload) {
  const inline = !forceDownload && INLINE_MIME.test(f.mime);
  res.setHeader('Content-Type', inline ? f.mime : 'application/octet-stream');
  res.setHeader('Content-Length', f.data.length);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${f.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.end(f.data);
}

app.get('/api/files/:id', auth, wrap(async (req, res) => {
  const r = await pool.query(`SELECT f.* FROM fd_files f WHERE f.id = $1 AND (f.owner_id = $2 OR EXISTS
     (SELECT 1 FROM fd_messages m WHERE m.file_id = f.id AND (m.sender_id = $2 OR m.recipient_id = $2)))`, [Number(req.params.id) || 0, req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Файл не найден' });
  sendFile(res, r.rows[0], req.query.download === '1');
}));

app.post('/api/files/:id/share', auth, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const r = await pool.query(`SELECT f.id, f.share_token FROM fd_files f WHERE f.id = $1 AND (f.owner_id = $2 OR EXISTS
     (SELECT 1 FROM fd_messages m WHERE m.file_id = f.id AND (m.sender_id = $2 OR m.recipient_id = $2)))`, [id, req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Файл не найден' });
  let token = r.rows[0].share_token;
  if (!token) {
    token = crypto.randomBytes(12).toString('base64url');
    await pool.query('UPDATE fd_files SET share_token = $1 WHERE id = $2', [token, id]);
  }
  res.json({ url: `${req.protocol}://${req.get('host')}/s/${token}` });
}));

app.get('/s/:token', wrap(async (req, res) => {
  const r = await pool.query('SELECT name, mime, size, data FROM fd_files WHERE share_token = $1', [String(req.params.token)]);
  if (!r.rowCount) return res.status(404).send('Ссылка недействительна');
  sendFile(res, r.rows[0], req.query.download === '1');
}));

app.get('/healthz', (req, res) => res.send('ok'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Ошибка сервера' });
});

migrate().then(() => {
  setInterval(() => pool.query('DELETE FROM fd_sessions WHERE expires_at < now()').catch(() => {}), 3600e3);
  app.listen(PORT, () => console.log('Listening on ' + PORT));
}).catch((e) => { console.error('Migration failed', e); process.exit(1); });
