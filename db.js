import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { normalizePhone } from './util.js';

const REVIEW_FIELDS = new Set([
  'stars', 'author', 'text', 'lang', 'created_at', 'has_reply', 'status', 'draft',
  'final_reply', 'approved_reply', 'publish_was_edited', 'reply_state', 'policy_violation',
  'wa_message_id', 'priority', 'sort_negative', 'enqueued_at', 'published_at',
  'published_day', 'pending_full_text', 'themes'
]);

const ESTABLISHMENT_FIELDS = new Set([
  'name', 'type', 'city', 'contact', 'google_account_id', 'location_id', 'owner_phone',
  'google_tokens', 'style_guide', 'backlog_paused', 'daily_limit', 'onboarded_at',
  'pending_notice'
]);

const MIGRATION_V1 = `
CREATE TABLE establishments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'restaurant',
  city TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  google_account_id TEXT,
  location_id TEXT,
  owner_phone TEXT NOT NULL,
  google_tokens TEXT,
  style_guide TEXT NOT NULL DEFAULT '',
  backlog_paused INTEGER NOT NULL DEFAULT 0,
  daily_limit INTEGER NOT NULL DEFAULT 10,
  onboarded_at TEXT,
  pending_notice TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL,
  establishment_id INTEGER NOT NULL,
  stars INTEGER NOT NULL,
  author TEXT,
  text TEXT,
  lang TEXT,
  created_at TEXT,
  has_reply INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  draft TEXT,
  final_reply TEXT,
  approved_reply TEXT,
  publish_was_edited INTEGER NOT NULL DEFAULT 0,
  reply_state TEXT,
  policy_violation TEXT,
  wa_message_id TEXT,
  priority INTEGER NOT NULL DEFAULT 1,
  sort_negative INTEGER NOT NULL DEFAULT 0,
  enqueued_at TEXT,
  published_at TEXT,
  published_day TEXT,
  pending_full_text INTEGER NOT NULL DEFAULT 0,
  themes TEXT,
  UNIQUE (establishment_id, review_id),
  FOREIGN KEY (establishment_id) REFERENCES establishments(id)
);

CREATE TABLE learning_examples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  establishment_id INTEGER NOT NULL,
  review_id TEXT,
  stars INTEGER,
  review_text TEXT,
  themes TEXT,
  draft TEXT,
  final TEXT,
  was_edited INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (establishment_id) REFERENCES establishments(id)
);

CREATE TABLE wa_sessions (
  owner_phone TEXT PRIMARY KEY,
  last_inbound_at INTEGER,
  awaiting_edit_review_id TEXT,
  awaiting_edit_establishment_id INTEGER
);

CREATE TABLE followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  establishment_id INTEGER NOT NULL,
  review_id TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE wa_inbound (
  message_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

CREATE INDEX idx_est_phone ON establishments(owner_phone);
CREATE INDEX idx_est_location ON establishments(location_id);
CREATE INDEX idx_reviews_queue ON reviews(establishment_id, status, priority);
CREATE INDEX idx_examples_est ON learning_examples(establishment_id, created_at);
CREATE INDEX idx_followups_due ON followups(done, run_at);
`;

export function openDatabase(dbPath = process.env.DATABASE_PATH || './data/bot.sqlite') {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(path.resolve(dbPath));
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)`);
  const current = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version || 0;
  if (current < 1) {
    db.exec(MIGRATION_V1);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();
  }
}

function mapEstablishment(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    backlog_paused: Boolean(row.backlog_paused),
    daily_limit: Number(row.daily_limit)
  };
}

export function insertEstablishment(db, data) {
  const now = new Date().toISOString();
  const tokens = data.google_tokens ?? data.googleTokens ?? null;
  const info = db.prepare(`
    INSERT INTO establishments (
      name, type, city, contact, google_account_id, location_id, owner_phone,
      google_tokens, style_guide, backlog_paused, daily_limit, onboarded_at, created_at
    ) VALUES (
      @name, @type, @city, @contact, @google_account_id, @location_id, @owner_phone,
      @google_tokens, @style_guide, @backlog_paused, @daily_limit, @onboarded_at, @created_at
    )
  `).run({
    name: data.name,
    type: data.type || 'restaurant',
    city: data.city || '',
    contact: data.contact || '',
    google_account_id: data.google_account_id || data.googleAccountId || null,
    location_id: data.location_id || data.locationId || null,
    owner_phone: normalizePhone(data.owner_phone || data.ownerPhone),
    google_tokens: tokens == null ? null : (typeof tokens === 'string' ? tokens : JSON.stringify(tokens)),
    style_guide: data.style_guide || data.styleGuide || '',
    backlog_paused: data.backlog_paused || data.backlogPaused ? 1 : 0,
    daily_limit: data.daily_limit ?? data.dailyLimit ?? Number(process.env.DEFAULT_DAILY_LIMIT || 10),
    onboarded_at: data.onboarded_at || null,
    created_at: now
  });
  return getEstablishment(db, Number(info.lastInsertRowid));
}

export function getEstablishment(db, id) {
  return mapEstablishment(db.prepare('SELECT * FROM establishments WHERE id = ?').get(id));
}

export function listEstablishments(db) {
  return db.prepare('SELECT * FROM establishments ORDER BY id ASC').all().map(mapEstablishment);
}

export function listEstablishmentsByPhone(db, phone) {
  const normalized = normalizePhone(phone);
  return db.prepare('SELECT * FROM establishments WHERE owner_phone = ? ORDER BY id ASC').all(normalized).map(mapEstablishment);
}

export function findEstablishmentByLocation(db, locationId, accountId) {
  const rows = db.prepare('SELECT * FROM establishments WHERE location_id = ? ORDER BY id ASC').all(locationId).map(mapEstablishment);
  if (!accountId) return rows[0] || null;
  return rows.find((row) => row.google_account_id === accountId) || rows[0] || null;
}

export function updateEstablishment(db, id, patch) {
  const keys = Object.keys(patch).filter((key) => ESTABLISHMENT_FIELDS.has(key));
  if (!keys.length) return getEstablishment(db, id);
  const assignments = keys.map((key) => `${key} = @${key}`).join(', ');
  const params = { id };
  for (const key of keys) {
    let value = patch[key];
    if (key === 'backlog_paused') value = value ? 1 : 0;
    if (key === 'google_tokens' && value && typeof value !== 'string') value = JSON.stringify(value);
    params[key] = value;
  }
  db.prepare(`UPDATE establishments SET ${assignments} WHERE id = @id`).run(params);
  return getEstablishment(db, id);
}

export function getReview(db, establishmentId, reviewId) {
  return db.prepare('SELECT * FROM reviews WHERE establishment_id = ? AND review_id = ?').get(establishmentId, reviewId) || null;
}

export function countReviews(db, establishmentId) {
  return db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE establishment_id = ?').get(establishmentId).n;
}

export function insertReview(db, row) {
  const info = db.prepare(`
    INSERT INTO reviews (
      review_id, establishment_id, stars, author, text, lang, created_at, has_reply,
      status, draft, final_reply, approved_reply, publish_was_edited, reply_state,
      policy_violation, wa_message_id, priority, sort_negative, enqueued_at,
      published_at, published_day, pending_full_text, themes
    ) VALUES (
      @review_id, @establishment_id, @stars, @author, @text, @lang, @created_at, @has_reply,
      @status, @draft, @final_reply, @approved_reply, @publish_was_edited, @reply_state,
      @policy_violation, @wa_message_id, @priority, @sort_negative, @enqueued_at,
      @published_at, @published_day, @pending_full_text, @themes
    )
  `).run({
    review_id: row.review_id,
    establishment_id: row.establishment_id,
    stars: row.stars,
    author: row.author || null,
    text: row.text || '',
    lang: row.lang || null,
    created_at: row.created_at || null,
    has_reply: row.has_reply ? 1 : 0,
    status: row.status,
    draft: row.draft || null,
    final_reply: row.final_reply || null,
    approved_reply: row.approved_reply || null,
    publish_was_edited: row.publish_was_edited ? 1 : 0,
    reply_state: row.reply_state || null,
    policy_violation: row.policy_violation || null,
    wa_message_id: row.wa_message_id || null,
    priority: row.priority ?? 1,
    sort_negative: row.sort_negative ? 1 : 0,
    enqueued_at: row.enqueued_at || null,
    published_at: row.published_at || null,
    published_day: row.published_day || null,
    pending_full_text: row.pending_full_text ? 1 : 0,
    themes: row.themes || null
  });
  return getReview(db, row.establishment_id, row.review_id) || { id: Number(info.lastInsertRowid) };
}

export function updateReview(db, establishmentId, reviewId, patch) {
  const keys = Object.keys(patch).filter((key) => REVIEW_FIELDS.has(key));
  if (!keys.length) return getReview(db, establishmentId, reviewId);
  const params = { establishment_id: establishmentId, review_id: reviewId };
  for (const key of keys) {
    let value = patch[key];
    if (key === 'themes' && Array.isArray(value)) value = JSON.stringify(value);
    if (['has_reply', 'publish_was_edited', 'pending_full_text', 'sort_negative'].includes(key)) {
      value = value ? 1 : 0;
    }
    params[key] = value;
  }
  const assignments = keys.map((key) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE reviews SET ${assignments} WHERE establishment_id = @establishment_id AND review_id = @review_id`).run(params);
  return getReview(db, establishmentId, reviewId);
}

export function hasInFlight(db, establishmentId) {
  const row = db.prepare(`
    SELECT 1 AS ok FROM reviews
    WHERE establishment_id = ? AND status IN ('sent_to_owner', 'awaiting_edit', 'rejected')
    LIMIT 1
  `).get(establishmentId);
  return Boolean(row);
}

export function nextQueuedDecision(db, establishment) {
  const paused = establishment.backlog_paused ? 1 : 0;
  return db.prepare(`
    SELECT * FROM reviews
    WHERE establishment_id = ?
      AND status = 'queued'
      AND approved_reply IS NULL
      AND (priority = 0 OR ? = 0)
    ORDER BY priority ASC,
             CASE WHEN priority = 0 THEN enqueued_at END ASC,
             sort_negative DESC,
             created_at DESC,
             id ASC
    LIMIT 1
  `).get(establishment.id, paused) || null;
}

export function nextApproved(db, establishmentId) {
  return db.prepare(`
    SELECT * FROM reviews
    WHERE establishment_id = ? AND status = 'queued' AND approved_reply IS NOT NULL
    ORDER BY enqueued_at ASC, id ASC
    LIMIT 1
  `).get(establishmentId) || null;
}

export function queueStats(db, establishmentId) {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'queued' AND approved_reply IS NULL THEN 1 ELSE 0 END) AS total,
      SUM(CASE WHEN status = 'queued' AND approved_reply IS NULL AND sort_negative = 1 THEN 1 ELSE 0 END) AS negative
    FROM reviews WHERE establishment_id = ?
  `).get(establishmentId);
  return { total: Number(row.total || 0), negative: Number(row.negative || 0) };
}

export function publishedCountOn(db, establishmentId, day) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM reviews
    WHERE establishment_id = ? AND status = 'published' AND published_day = ?
  `).get(establishmentId, day).n;
}

export function listPendingFullText(db, establishmentId) {
  return db.prepare(`
    SELECT * FROM reviews
    WHERE establishment_id = ? AND pending_full_text = 1
    ORDER BY id ASC
  `).all(establishmentId);
}

export function insertExample(db, row) {
  const info = db.prepare(`
    INSERT INTO learning_examples (
      establishment_id, review_id, stars, review_text, themes, draft, final,
      was_edited, source, created_at
    ) VALUES (
      @establishment_id, @review_id, @stars, @review_text, @themes, @draft, @final,
      @was_edited, @source, @created_at
    )
  `).run({
    establishment_id: row.establishment_id,
    review_id: row.review_id || null,
    stars: row.stars ?? null,
    review_text: row.review_text || '',
    themes: Array.isArray(row.themes) ? JSON.stringify(row.themes) : (row.themes || '[]'),
    draft: row.draft || '',
    final: row.final || '',
    was_edited: row.was_edited ? 1 : 0,
    source: row.source || (row.was_edited ? 'edited' : 'accepted'),
    created_at: row.created_at || new Date().toISOString()
  });
  return Number(info.lastInsertRowid);
}

export function listExamples(db, establishmentId, limit = 300) {
  return db.prepare(`
    SELECT * FROM learning_examples
    WHERE establishment_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(establishmentId, limit).map(mapExample);
}

export function listEditedExamples(db, establishmentId, limit = 20) {
  return db.prepare(`
    SELECT * FROM learning_examples
    WHERE establishment_id = ? AND was_edited = 1
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(establishmentId, limit).map(mapExample);
}

export function countEditedExamples(db, establishmentId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM learning_examples
    WHERE establishment_id = ? AND was_edited = 1
  `).get(establishmentId).n;
}

export function deleteExamplesForReview(db, establishmentId, reviewId) {
  db.prepare('DELETE FROM learning_examples WHERE establishment_id = ? AND review_id = ?').run(establishmentId, reviewId);
}

function mapExample(row) {
  let themes = [];
  try {
    themes = JSON.parse(row.themes || '[]');
  } catch {
    themes = [];
  }
  return { ...row, id: Number(row.id), was_edited: Boolean(row.was_edited), themes };
}

export function getSession(db, phone) {
  return db.prepare('SELECT * FROM wa_sessions WHERE owner_phone = ?').get(normalizePhone(phone)) || null;
}

export function touchSession(db, phone, atMs) {
  const owner = normalizePhone(phone);
  db.prepare(`
    INSERT INTO wa_sessions (owner_phone, last_inbound_at)
    VALUES (?, ?)
    ON CONFLICT(owner_phone) DO UPDATE SET last_inbound_at = excluded.last_inbound_at
  `).run(owner, atMs);
  return getSession(db, owner);
}

export function setAwaitingEdit(db, phone, reviewId, establishmentId) {
  const owner = normalizePhone(phone);
  db.prepare(`
    INSERT INTO wa_sessions (owner_phone, last_inbound_at, awaiting_edit_review_id, awaiting_edit_establishment_id)
    VALUES (?, NULL, ?, ?)
    ON CONFLICT(owner_phone) DO UPDATE SET
      awaiting_edit_review_id = excluded.awaiting_edit_review_id,
      awaiting_edit_establishment_id = excluded.awaiting_edit_establishment_id
  `).run(owner, reviewId, establishmentId);
}

export function clearAwaitingEdit(db, phone, reviewId) {
  const session = getSession(db, phone);
  if (!session) return;
  if (reviewId && session.awaiting_edit_review_id && session.awaiting_edit_review_id !== reviewId) return;
  db.prepare(`
    UPDATE wa_sessions
    SET awaiting_edit_review_id = NULL, awaiting_edit_establishment_id = NULL
    WHERE owner_phone = ?
  `).run(normalizePhone(phone));
}

export function rememberInbound(db, messageId, atMs) {
  if (!messageId) return true;
  try {
    db.prepare('INSERT INTO wa_inbound (message_id, received_at) VALUES (?, ?)').run(messageId, atMs);
    return true;
  } catch {
    return false;
  }
}

export function scheduleFollowup(db, row) {
  db.prepare(`
    INSERT INTO followups (establishment_id, review_id, run_at, kind, done, attempts)
    VALUES (?, ?, ?, ?, 0, 0)
  `).run(row.establishment_id, row.review_id, row.run_at, row.kind);
}

export function dueFollowups(db, nowMs) {
  return db.prepare(`
    SELECT * FROM followups WHERE done = 0 AND run_at <= ? ORDER BY run_at ASC, id ASC
  `).all(nowMs);
}

export function markFollowup(db, id, patch) {
  db.prepare(`
    UPDATE followups SET done = ?, attempts = ? WHERE id = ?
  `).run(patch.done ? 1 : 0, patch.attempts || 0, id);
}
