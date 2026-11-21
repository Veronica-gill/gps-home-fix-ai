import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { privateFile } from './storage.mjs';

export const draftFields = {
  title: 'Job title',
  likelyRepair: 'Likely repair and diagnosis',
  questions: 'Questions for the customer',
  scope: 'Proposed scope and exclusions',
  labor: 'Estimated labor and assumptions',
  pricing: 'Pricing considerations',
  materials: 'Materials',
  tools: 'Tools',
  uncertainties: 'Uncertainties',
  tasks: 'Work order tasks',
  instructions: 'Special instructions'
};

export const hazardLabels = {
  licensing: 'Licensing or permit concern',
  structural: 'Potential structural work',
  roofing: 'Potential roofing work',
  electrical: 'Potential electrical hazard',
  outside_scope: 'May be outside approved services',
  other: 'Other safety concern'
};

export class WorkflowError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function readText(value, label, limit, required = false) {
  if (value == null) value = '';
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) {
    throw new WorkflowError(400, `${label} must ${required ? 'contain 1 to ' : 'be at most '}${limit} characters.`);
  }
  return value.trim();
}

const twoMiB = 2 * 1024 * 1024;
export const bodyLimit = 9 * 1024 * 1024;
const signatures = {
  'image/jpeg': bytes => bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])),
  'image/png': bytes => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  'image/webp': bytes => bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
};

export function checkPhoto(bytes, type) {
  if (!Object.hasOwn(signatures, type) || !bytes.length || bytes.length > twoMiB || !signatures[type](bytes)) {
    throw new WorkflowError(400, 'Each photo must be a JPEG, PNG, or WebP image up to 2 MB.');
  }
  return { type, bytes };
}

export function intakeFields(fields) {
  const intake = {
    name: readText(fields.name, 'Customer name', 120, true),
    email: readText(fields.email, 'Email', 200),
    phone: readText(fields.phone, 'Phone', 40),
    location: readText(fields.location, 'Service address or area', 300, true),
    description: readText(fields.description, 'Repair description', 5000, true)
  };
  if (intake.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(intake.email)) {
    throw new WorkflowError(400, 'Enter a valid email address.');
  }
  if (!intake.email && !intake.phone) throw new WorkflowError(400, 'Enter an email address or phone number.');
  return intake;
}

export function intakeFlags(description) {
  const patterns = {
    licensing: /\b(permit|licensed|licensing|gas line|gas leak|breaker panel)\b/i,
    structural: /\b(structural|load[ -]bearing|foundation|sagging|joist|truss|support beam)\b/i,
    roofing: /\b(roof|roofing|shingles|flashing)\b/i,
    electrical: /\b(electric(?:al)?|wir(?:e|es|ing)|sparks?|breaker|outlet|exposed conductors?)\b/i,
    other: /\b(asbestos|lead paint|sewage|gas smell|gas leak|flooding)\b/i
  };
  return Object.entries(patterns).filter(([, pattern]) => pattern.test(description))
    .map(([category]) => ({ category, detail: 'Possible concern mentioned in the original request. Verify before assigning.' }));
}

const json = value => JSON.stringify(value);

export function jobStore(path) {
  privateFile(path);
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA trusted_schema = OFF;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      original TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      revision INTEGER NOT NULL DEFAULT 0,
      ai TEXT,
      draft TEXT,
      work_token TEXT UNIQUE,
      created TEXT NOT NULL,
      intake_key TEXT UNIQUE,
      intake_digest TEXT,
      assigned_to TEXT
    );
    CREATE TABLE IF NOT EXISTS photos (
      job_id TEXT NOT NULL REFERENCES jobs(id),
      position INTEGER NOT NULL,
      mime TEXT NOT NULL,
      bytes BLOB NOT NULL,
      PRIMARY KEY (job_id, position)
    );
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      time TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analysis_locks (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id),
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  const now = () => new Date().toISOString();
  const event = db.prepare('INSERT INTO events (job_id,time,actor,action,details) VALUES (?,?,?,?,?)');
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  transaction(() => {
    if (!db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'assigned_to')) {
      db.exec('ALTER TABLE jobs ADD COLUMN assigned_to TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS jobs_by_assignment ON jobs(assigned_to, status, created)');
  });

  function decode(row) {
    if (!row) throw new WorkflowError(404, 'Job not found.');
    return { ...row, original: JSON.parse(row.original), ai: JSON.parse(row.ai), draft: JSON.parse(row.draft) };
  }

  function get(id) {
    return decode(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
  }

  function workForTechnician(id, username) {
    const row = db.prepare(`SELECT id, status, revision, assigned_to, draft FROM jobs
      WHERE id = ? AND assigned_to = ? AND status IN ('approved', 'completed')`).get(id, username);
    if (!row) throw new WorkflowError(404, 'Work order not found.');
    return { ...row, draft: JSON.parse(row.draft) };
  }

  function create(original, photos, actor, intakeKey = null) {
    const digest = createHash('sha256').update(json(original));
    for (const photo of photos) digest.update(createHash('sha256').update(photo.type).update(photo.bytes).digest());
    const intakeDigest = digest.digest('hex');
    return transaction(() => {
      const previous = intakeKey && db.prepare('SELECT id, intake_digest FROM jobs WHERE intake_key = ?').get(intakeKey);
      if (previous) {
        if (previous.intake_digest !== intakeDigest) throw new WorkflowError(409, 'This intake key was used for a different request.');
        return { id: previous.id, duplicate: true };
      }
      const id = 'GPS-' + randomBytes(6).toString('hex').toUpperCase();
      db.prepare('INSERT INTO jobs (id,original,created,intake_key,intake_digest) VALUES (?,?,?,?,?)')
        .run(id, json(original), now(), intakeKey, intakeDigest);
      const insert = db.prepare('INSERT INTO photos (job_id,position,mime,bytes) VALUES (?,?,?,?)');
      photos.forEach((item, index) => insert.run(id, index, item.type, item.bytes));
      event.run(id, now(), actor, 'Request received', json({ photoCount: photos.length }));
      return { id, duplicate: false };
    });
  }

  function activeAnalysis(id) {
    return db.prepare('SELECT token FROM analysis_locks WHERE job_id = ? AND expires_at > ?').get(id, Date.now())?.token;
  }

  function beginAnalysis(job) {
    return transaction(() => {
      if (get(job.id).revision !== job.revision || activeAnalysis(job.id)) {
        throw new WorkflowError(409, 'Analysis is unavailable for this job right now.');
      }
      const token = randomBytes(32).toString('hex');
      db.prepare(`INSERT INTO analysis_locks VALUES (?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at`)
        .run(job.id, token, Date.now() + 120_000);
      return token;
    });
  }

  function update(job, changes, actor, action, details, analysisToken) {
    transaction(() => {
      if (activeAnalysis(job.id) !== analysisToken) {
        throw new WorkflowError(409, 'Analysis or another update is in progress. Reopen the job and try again.');
      }
      const assignedTo = Object.hasOwn(changes, 'assignedTo') ? changes.assignedTo : job.assigned_to;
      const result = db.prepare(`
        UPDATE jobs SET status=?, ai=?, draft=?, assigned_to=?, revision=revision+1
        WHERE id=? AND revision=?
      `).run(changes.status ?? job.status, json(changes.ai ?? job.ai),
        json(changes.draft ?? job.draft), assignedTo ?? null, job.id, job.revision);
      if (!result.changes) throw new WorkflowError(409, 'This job changed. Reopen it to review the latest version.');
      event.run(job.id, now(), actor, action, json(details));
    });
  }

  function complete(job, actor, note) {
    transaction(() => {
      const result = db.prepare(`UPDATE jobs SET status = 'completed', revision = revision + 1
        WHERE id = ? AND revision = ? AND assigned_to = ? AND status = 'approved'`)
        .run(job.id, job.revision, job.assigned_to);
      if (!result.changes) throw new WorkflowError(409, 'This work order changed. Reopen it and try again.');
      event.run(job.id, now(), actor, 'Reported work complete', json({ note }));
    });
  }

  return {
    create, get, update, beginAnalysis, complete, workForTechnician,
    close: () => db.close(),
    list: () => db.prepare('SELECT id, original, ai, draft, status, created FROM jobs ORDER BY created DESC').all().map(decode),
    listForTechnician: username => db.prepare(`SELECT id, status, draft FROM jobs
      WHERE assigned_to = ? AND status IN ('approved', 'completed')
      ORDER BY status = 'completed', created DESC`).all(username).map(row => ({ ...row, draft: JSON.parse(row.draft) })),
    photoPositions: id => db.prepare('SELECT position FROM photos WHERE job_id=? ORDER BY position').all(id),
    photo: (id, position) => db.prepare('SELECT mime, bytes FROM photos WHERE job_id=? AND position=?').get(id, position),
    photos: id => db.prepare('SELECT mime, bytes FROM photos WHERE job_id=? ORDER BY position').all(id),
    history: id => db.prepare('SELECT time,actor,action,details FROM events WHERE job_id=? ORDER BY seq DESC')
      .all(id).map(row => ({ ...row, details: JSON.parse(row.details) })),
    endAnalysis: (id, token) => db.prepare('DELETE FROM analysis_locks WHERE job_id = ? AND token = ?').run(id, token),
    failedAnalysis: (id, reason, token) => transaction(() => {
      if (activeAnalysis(id) === token) event.run(id, now(), 'OpenAI', 'Analysis failed', json({ reason }));
    })
  };
}

export function draftFromAnalysis(analysis, location) {
  const draft = {};
  for (const key of Object.keys(draftFields)) {
    const value = analysis[key];
    draft[key] = Array.isArray(value) ? value.join('\n') : value;
  }
  return { ...draft, location, amount: '', reviewNote: '' };
}
