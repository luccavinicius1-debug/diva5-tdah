// ══════════════════════════════════════════════════════
//  DIVA-5 · Banco de Dados (SQLite)
// ══════════════════════════════════════════════════════
const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const fs       = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'diva5.db'));
db.pragma('journal_mode = WAL');

// ── Schema ──────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS admin (
    id            INTEGER PRIMARY KEY,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS links (
    token         TEXT PRIMARY KEY,
    patient_name  TEXT DEFAULT '',
    patient_email TEXT DEFAULT '',
    notes         TEXT DEFAULT '',
    used          INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    token         TEXT NOT NULL,
    patient_name  TEXT DEFAULT '',
    patient_email TEXT DEFAULT '',
    answers       TEXT,
    scores        TEXT,
    result        TEXT,
    patient_data  TEXT,
    created_at    TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ── Seed admin (senha padrão: diva2024) ─────────────
const existing = db.prepare('SELECT * FROM admin WHERE id = 1').get();
if (!existing) {
  const hash = bcrypt.hashSync('diva2024', 10);
  db.prepare('INSERT INTO admin (id, password_hash) VALUES (1, ?)').run(hash);
  console.log('🔑  Admin criado com senha padrão: diva2024');
}

// ── Funções ─────────────────────────────────────────
module.exports = {
  getAdmin() {
    return db.prepare('SELECT * FROM admin WHERE id = 1').get();
  },

  updateAdminPassword(newHash) {
    db.prepare('UPDATE admin SET password_hash = ? WHERE id = 1').run(newHash);
  },

  createLink({ token, patientName, patientEmail, notes }) {
    db.prepare(
      'INSERT INTO links (token, patient_name, patient_email, notes) VALUES (?, ?, ?, ?)'
    ).run(token, patientName, patientEmail, notes);
    return db.prepare('SELECT * FROM links WHERE token = ?').get(token);
  },

  getLink(token) {
    return db.prepare('SELECT * FROM links WHERE token = ?').get(token);
  },

  getAllLinks() {
    return db.prepare('SELECT * FROM links ORDER BY created_at DESC').all();
  },

  markLinkUsed(token) {
    db.prepare('UPDATE links SET used = 1 WHERE token = ?').run(token);
  },

  deleteLink(token) {
    db.prepare('DELETE FROM links WHERE token = ?').run(token);
    db.prepare('DELETE FROM reports WHERE token = ?').run(token);
  },

  saveReport({ token, patientName, patientEmail, answers, scores, result, patientData }) {
    db.prepare(
      'INSERT INTO reports (token, patient_name, patient_email, answers, scores, result, patient_data) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(token, patientName, patientEmail, answers, scores, result, patientData);
  },

  getReport(token) {
    const r = db.prepare('SELECT * FROM reports WHERE token = ?').get(token);
    if (!r) return null;
    return {
      ...r,
      answers:     JSON.parse(r.answers     || '{}'),
      scores:      JSON.parse(r.scores      || '{}'),
      result:      JSON.parse(r.result      || '{}'),
      patientData: JSON.parse(r.patient_data|| '{}'),
    };
  },

  getAllReports() {
    return db.prepare('SELECT id, token, patient_name, patient_email, created_at FROM reports ORDER BY created_at DESC').all();
  },

  deleteReport(token) {
    db.prepare('DELETE FROM reports WHERE token = ?').run(token);
  },
};
