CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  password_hash TEXT,
  created_at TEXT
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  body TEXT,
  created_at TEXT
);
