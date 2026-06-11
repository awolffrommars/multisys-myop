const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'myop.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email        TEXT PRIMARY KEY,
    name         TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    requested_at INTEGER,
    approved_at  INTEGER,
    last_seen    INTEGER
  );
  CREATE TABLE IF NOT EXISTS history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email     TEXT,
    template       TEXT,
    employee_count INTEGER,
    employee_names TEXT,
    generated_at   INTEGER
  );
  CREATE TABLE IF NOT EXISTS render_errors (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email    TEXT,
    template      TEXT,
    employee_name TEXT,
    error_type    TEXT,
    error_message TEXT,
    occurred_at   INTEGER
  );
`);

// Add duration_ms column to history if it doesn't exist yet (safe migration)
try { db.exec(`ALTER TABLE history ADD COLUMN duration_ms INTEGER`); } catch {}

const s = {
  getUser:       db.prepare('SELECT * FROM users WHERE email = ?'),
  insertUser:    db.prepare('INSERT OR IGNORE INTO users (email, name, status, requested_at) VALUES (?, ?, ?, ?)'),
  setStatus:     db.prepare('UPDATE users SET status = ? WHERE email = ?'),
  approve:       db.prepare('UPDATE users SET status = ?, approved_at = ? WHERE email = ?'),
  touchSeen:     db.prepare('UPDATE users SET last_seen = ? WHERE email = ?'),
  byStatus:      db.prepare('SELECT * FROM users WHERE status = ? ORDER BY requested_at DESC'),
  allUsers:      db.prepare('SELECT * FROM users ORDER BY requested_at DESC'),
  insertHistory: db.prepare('INSERT INTO history (user_email, template, employee_count, employee_names, generated_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?)'),
  history:       db.prepare('SELECT * FROM history ORDER BY generated_at DESC LIMIT ?'),
  statsTpl:      db.prepare('SELECT template, COUNT(*) as batches, SUM(employee_count) as total FROM history GROUP BY template'),
  statsUser:     db.prepare('SELECT user_email, COUNT(*) as batches, SUM(employee_count) as total, AVG(CASE WHEN employee_count > 0 AND duration_ms IS NOT NULL THEN duration_ms * 1.0 / employee_count END) as avg_ms_per_poster FROM history GROUP BY user_email ORDER BY total DESC'),
  activity:      db.prepare(`SELECT strftime('%Y-%m-%d', generated_at/1000, 'unixepoch') as day, COUNT(*) as batches, SUM(employee_count) as posters FROM history WHERE generated_at > ? GROUP BY day ORDER BY day`),
  totalPosters:  db.prepare('SELECT COALESCE(SUM(employee_count), 0) as total FROM history'),
  insertError:   db.prepare('INSERT INTO render_errors (user_email, template, employee_name, error_type, error_message, occurred_at) VALUES (?, ?, ?, ?, ?, ?)'),
  recentErrors:  db.prepare('SELECT * FROM render_errors ORDER BY occurred_at DESC LIMIT ?'),
};

module.exports = {
  getUser:          (email)         => s.getUser.get(email),
  upsertPending:    (email, name)   => s.insertUser.run(email, name, 'pending', Date.now()),
  updateStatus:     (email, status) => {
    if (status === 'approved') s.approve.run(status, Date.now(), email);
    else s.setStatus.run(status, email);
  },
  updateLastSeen:   (email)         => s.touchSeen.run(Date.now(), email),
  getUsersByStatus: (status)        => s.byStatus.all(status),
  getAllUsers:       ()              => s.allUsers.all(),
  logHistory:       (email, tpl, count, names, durationMs) =>
    s.insertHistory.run(email, tpl, count, JSON.stringify(names), Date.now(), durationMs ?? null),
  logError:         (email, tpl, employeeName, errorType, errorMessage) =>
    s.insertError.run(email, tpl, employeeName ?? null, errorType, errorMessage, Date.now()),
  getHistory:       (limit = 200)   => s.history.all(limit),
  getErrors:        (limit = 50)    => s.recentErrors.all(limit),
  getStats:         () => ({
    byTemplate:   s.statsTpl.all(),
    byUser:       s.statsUser.all(),
    activity:     s.activity.all(Date.now() - 30 * 24 * 60 * 60 * 1000),
    totalPosters: s.totalPosters.get().total,
  }),
};
