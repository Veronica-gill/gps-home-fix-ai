import { chmodSync, linkSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { privateFile } from '../storage.mjs';

function open(path, readOnly = true) {
  const db = new DatabaseSync(path, { readOnly });
  db.exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000;');
  return db;
}

function verifyDatabase(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').get()) throw new Error('SQLite integrity check failed.');
  return {
    jobs: db.prepare('SELECT count(*) AS count FROM jobs').get().count,
    photos: db.prepare('SELECT count(*) AS count FROM photos').get().count,
    events: db.prepare('SELECT count(*) AS count FROM events').get().count
  };
}

async function copyDatabase(source, destination, restore) {
  privateFile(destination);
  const scratch = mkdtempSync(join(dirname(destination), '.gps-copy-'));
  const temporary = join(scratch, 'jobs.sqlite');
  try {
    await backup(source, temporary);
    chmodSync(temporary, 0o600);
    const copy = open(temporary, !restore);
    let summary;
    try {
      if (restore && copy.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'analysis_locks' AND type = 'table'").get()) {
        copy.exec('DELETE FROM analysis_locks');
      }
      summary = verifyDatabase(copy);
    } finally {
      copy.close();
    }
    // Publish only a fully checked copy. The link fails if the destination already exists.
    linkSync(temporary, destination);
    return summary;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const [action, sourcePath, destination, ...extra] = process.argv.slice(2);
try {
  if (!['backup', 'restore', 'verify'].includes(action) || !isAbsolute(sourcePath ?? '') || extra.length ||
      (action === 'verify' ? destination !== undefined : !isAbsolute(destination ?? ''))) {
    throw new Error('Usage: node scripts/database.mjs verify /absolute/file.sqlite, or backup|restore /absolute/source.sqlite /absolute/new.sqlite');
  }
  process.umask(0o077);
  privateFile(sourcePath, { mustExist: true });
  const source = open(sourcePath);
  try {
    const counts = action === 'verify' ? verifyDatabase(source) : await copyDatabase(source, destination, action === 'restore');
    console.log(`Verified SQLite integrity. Jobs: ${counts.jobs}. Photos: ${counts.photos}. Activity entries: ${counts.events}.`);
  } finally {
    source.close();
  }
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'The destination already exists. Choose a new path.' : error.message);
  process.exitCode = 1;
}
