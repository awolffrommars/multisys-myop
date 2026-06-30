const { createClient } = require('@libsql/client');
const path = require('path');

const url       = process.env.TURSO_URL || `file:${path.join(__dirname, '..', 'data', 'myop.db')}`;
const authToken = process.env.TURSO_AUTH_TOKEN;

const client = createClient({ url, authToken });

async function init() {
  await client.batch([
    `CREATE TABLE IF NOT EXISTS users (
      email        TEXT PRIMARY KEY,
      name         TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      requested_at INTEGER,
      approved_at  INTEGER,
      last_seen    INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email     TEXT,
      template       TEXT,
      employee_count INTEGER,
      employee_names TEXT,
      generated_at   INTEGER,
      duration_ms    INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS render_errors (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email    TEXT,
      template      TEXT,
      employee_name TEXT,
      error_type    TEXT,
      error_message TEXT,
      occurred_at   INTEGER
    )`,
  ], 'write');
}

module.exports = {
  init,

  getUser: async (email) => {
    const r = await client.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
    return r.rows[0] ?? null;
  },

  upsertPending: async (email, name) => {
    await client.execute({
      sql:  'INSERT OR IGNORE INTO users (email, name, status, requested_at) VALUES (?, ?, ?, ?)',
      args: [email, name, 'pending', Date.now()],
    });
  },

  updateStatus: async (email, status) => {
    if (status === 'approved') {
      await client.execute({ sql: 'UPDATE users SET status = ?, approved_at = ? WHERE email = ?', args: [status, Date.now(), email] });
    } else {
      await client.execute({ sql: 'UPDATE users SET status = ? WHERE email = ?', args: [status, email] });
    }
  },

  updateLastSeen: async (email) => {
    await client.execute({ sql: 'UPDATE users SET last_seen = ? WHERE email = ?', args: [Date.now(), email] });
  },

  getUsersByStatus: async (status) => {
    const r = await client.execute({ sql: 'SELECT * FROM users WHERE status = ? ORDER BY requested_at DESC', args: [status] });
    return r.rows;
  },

  getAllUsers: async () => {
    const r = await client.execute('SELECT * FROM users ORDER BY requested_at DESC');
    return r.rows;
  },

  logHistory: async (email, tpl, count, names, durationMs) => {
    await client.execute({
      sql:  'INSERT INTO history (user_email, template, employee_count, employee_names, generated_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
      args: [email, tpl, count, JSON.stringify(names), Date.now(), durationMs ?? null],
    });
  },

  logError: async (email, tpl, employeeName, errorType, errorMessage) => {
    await client.execute({
      sql:  'INSERT INTO render_errors (user_email, template, employee_name, error_type, error_message, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [email, tpl, employeeName ?? null, errorType, errorMessage, Date.now()],
    });
  },

  getHistory: async (days = 30) => {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const r = await client.execute({ sql: 'SELECT * FROM history WHERE generated_at > ? ORDER BY generated_at DESC', args: [since] });
    return r.rows;
  },

  getErrors: async (limit = 50) => {
    const r = await client.execute({ sql: 'SELECT * FROM render_errors ORDER BY occurred_at DESC LIMIT ?', args: [limit] });
    return r.rows;
  },

  getStats: async () => {
    const [tpl, usr, act, tot] = await Promise.all([
      client.execute('SELECT template, COUNT(*) as batches, SUM(employee_count) as total FROM history GROUP BY template'),
      client.execute('SELECT user_email, COUNT(*) as batches, SUM(employee_count) as total, AVG(CASE WHEN employee_count > 0 AND duration_ms IS NOT NULL THEN duration_ms * 1.0 / employee_count END) as avg_ms_per_poster FROM history GROUP BY user_email ORDER BY total DESC'),
      client.execute({ sql: `SELECT strftime('%Y-%m-%d', generated_at/1000, 'unixepoch') as day, COUNT(*) as batches, SUM(employee_count) as posters FROM history WHERE generated_at > ? GROUP BY day ORDER BY day`, args: [Date.now() - 30 * 24 * 60 * 60 * 1000] }),
      client.execute('SELECT COALESCE(SUM(employee_count), 0) as total FROM history'),
    ]);
    return {
      byTemplate:   tpl.rows,
      byUser:       usr.rows,
      activity:     act.rows,
      totalPosters: tot.rows[0]?.total || 0,
    };
  },
};
