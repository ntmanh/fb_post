import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const SHOT_DIR = path.join(DATA_DIR, 'shots');
export const PROFILE_DIR = path.join(DATA_DIR, 'profiles');
for (const d of [DATA_DIR, UPLOAD_DIR, SHOT_DIR, PROFILE_DIR]) fs.mkdirSync(d, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'crm.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  fb_uid TEXT,
  status TEXT NOT NULL DEFAULT 'new',      -- new | logging_in | ok | expired | checkpoint
  note TEXT DEFAULT '',
  last_action_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'group',      -- group
  url TEXT NOT NULL UNIQUE,
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'post',       -- post | comment
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS image_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  images TEXT NOT NULL DEFAULT '[]',
  default_max INTEGER NOT NULL DEFAULT 3,  -- số ảnh mặc định bốc mỗi bài
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch TEXT,
  kind TEXT NOT NULL,                      -- post | comment
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL,               -- profile | group | post
  target_url TEXT,
  target_name TEXT,
  content TEXT NOT NULL,
  images TEXT NOT NULL DEFAULT '[]',       -- kho ảnh của task
  image_opts TEXT NOT NULL DEFAULT '{}',   -- cách chọn ảnh, xem images.js
  used_images TEXT,                        -- ảnh thực tế đã dùng ở lần chạy gần nhất
  scheduled_at INTEGER NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'none',     -- none | daily | weekly
  status TEXT NOT NULL DEFAULT 'pending',  -- draft | pending | running | done | error | paused
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  shot TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(status, scheduled_at);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  account_id INTEGER,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_task ON logs(task_id);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// Migration: thêm cột còn thiếu cho DB tạo từ phiên bản cũ
const MIGRATIONS = {
  tasks: {
    image_opts: "TEXT NOT NULL DEFAULT '{}'",
    used_images: 'TEXT',
    content_opts: "TEXT NOT NULL DEFAULT '{}'", // { templates: [{id, name, content}] } khi chọn nội dung ngẫu nhiên từ mẫu
    used_content: 'TEXT',                       // nội dung thực tế đã đăng ở lần chạy gần nhất
  },
  templates: {
    used: 'INTEGER NOT NULL DEFAULT 0',      // 1 = đã đăng từ mẫu này trong vòng hiện tại
    use_count: 'INTEGER NOT NULL DEFAULT 0', // tổng số lần đã đăng (thống kê)
    last_used_at: 'INTEGER',
  },
};
for (const [table, cols] of Object.entries(MIGRATIONS)) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  for (const [col, def] of Object.entries(cols)) if (!have.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

const DEFAULT_SETTINGS = {
  runner_enabled: '1',
  headless: '0',          // 1 = chạy ẩn trình duyệt
  max_concurrent: '2',    // số tài khoản chạy song song
  min_gap_seconds: '120', // khoảng nghỉ tối thiểu giữa 2 thao tác của cùng 1 tài khoản
  daily_limit: '20',      // số thao tác tối đa / tài khoản / ngày
  max_attempts: '2',      // số lần thử lại tự động khi lỗi
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

export const now = () => Date.now();

export function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
}

export function setSettings(obj) {
  const st = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(obj)) if (k in DEFAULT_SETTINGS) st.run(k, String(v));
  return getSettings();
}

export function log(message, { taskId = null, accountId = null, level = 'info' } = {}) {
  db.prepare('INSERT INTO logs(task_id, account_id, level, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, accountId, level, String(message), now());
}
