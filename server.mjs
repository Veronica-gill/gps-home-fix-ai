import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeJob } from './analysis.mjs';
import { authStore, matches, technician } from './auth.mjs';
import {
  bodyLimit, checkPhoto, draftFields, draftFromAnalysis, intakeFields, intakeFlags,
  jobStore, readText, WorkflowError
} from './jobs.mjs';
import { privateDirectory } from './storage.mjs';
import { errorPage, home, intakePage, loginPage, reviewPage, workList, workPage } from './views.mjs';

const css = readFileSync(new URL('./styles.css', import.meta.url));
const homeFor = role => role === 'owner' ? '/admin' : '/technician';
const usingHttps = env => env.NODE_ENV === 'production' || Boolean(env.GPS_PUBLIC_ORIGIN);

const commonHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};

function send(res, status, contents, type, headers = {}) {
  res.writeHead(status, { ...commonHeaders, 'Content-Type': type, ...headers });
  res.end(contents);
}
const html = (res, status, content, headers) => send(res, status, content, 'text/html; charset=utf-8', headers);
const json = (res, status, content) => send(res, status, JSON.stringify(content), 'application/json; charset=utf-8');
const redirect = (res, location, headers) => send(res, 303, '', 'text/plain', { Location: location, ...headers });

function isWithin(root, path) {
  const fromRoot = relative(root, path);
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith('..' + sep));
}

function configuration(env) {
  const secure = usingHttps(env);
  const port = Number(env.GPS_PORT ?? 4321);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid GPS_PORT.');
  const dbPath = env.GPS_DB_PATH || fileURLToPath(new URL('./data/jobs.sqlite', import.meta.url));
  if (!isAbsolute(dbPath)) throw new Error('GPS_DB_PATH must be an absolute path.');
  if (secure) {
    const origin = new URL(env.GPS_PUBLIC_ORIGIN ?? 'about:blank');
    if (origin.protocol !== 'https:' || origin.origin !== env.GPS_PUBLIC_ORIGIN ||
        origin.port || !env.GPS_DB_PATH || !isAbsolute(env.GPS_DOCUMENT_ROOT ?? '')) {
      throw new Error('Configure an HTTPS GPS_PUBLIC_ORIGIN and absolute GPS_DB_PATH and GPS_DOCUMENT_ROOT.');
    }
    const publicRoot = realpathSync(env.GPS_DOCUMENT_ROOT);
    const appRoot = realpathSync(dirname(fileURLToPath(import.meta.url)));
    if (isWithin(publicRoot, appRoot)) throw new Error('Store application code outside the web document root.');
    if (isWithin(publicRoot, dirname(dbPath)) || isWithin(appRoot, dirname(dbPath))) {
      throw new Error('Store the production database outside the web document root and application code.');
    }
    privateDirectory(dirname(dbPath));
    const dataRoot = realpathSync(dirname(dbPath));
    if (isWithin(publicRoot, dataRoot) || isWithin(appRoot, dataRoot)) {
      throw new Error('Store the production database outside the web document root and application code.');
    }
  }
  if (secure && env.GPS_ENABLE_WEBSITE_INTAKE === 'true') throw new Error('Website intake is disabled for the hosted pilot.');
  const intakeToken = env.GPS_ENABLE_WEBSITE_INTAKE === 'true' ? env.GPS_INTAKE_TOKEN ?? '' : '';
  if (env.GPS_ENABLE_WEBSITE_INTAKE === 'true' && intakeToken.length < 32) {
    throw new Error('Local website-intake tests require an intake token of at least 32 characters.');
  }
  const hosts = secure ? [new URL(env.GPS_PUBLIC_ORIGIN).host] : [`127.0.0.1:${port}`, `localhost:${port}`];
  return { secure, port, dbPath, intakeToken, hosts: new Set(hosts) };
}

async function readBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw new WorkflowError(413, 'Request is too large.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new WorkflowError(413, 'Request is too large.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readForm(req, csrf, { limit = 768 * 1024, multipart = false } = {}) {
  const type = req.headers['content-type'] ?? '';
  const allowed = multipart ? /^multipart\/form-data(?:;|$)/i : /^application\/x-www-form-urlencoded(?:;|$)/i;
  if (!allowed.test(type)) throw new WorkflowError(415, 'Submit this request using the form.');
  const body = await readBody(req, limit);
  const form = await new Response(body, { headers: { 'Content-Type': type } }).formData()
    .catch(() => { throw new WorkflowError(400, 'The form could not be read.'); });
  if (csrf && !matches(form.get('_csrf'), csrf)) {
    throw new WorkflowError(403, 'This form expired. Reopen the page and try again.');
  }
  return form;
}

function formPhotos(form) {
  const files = form.getAll('photos').filter(file => typeof file !== 'string' && (file.size || file.name));
  if (files.length > 3) throw new WorkflowError(400, 'Attach at most 3 photos.');
  return Promise.all(files.map(async item => checkPhoto(Buffer.from(await item.arrayBuffer()), item.type)));
}

function jsonPhotos(photos = []) {
  if (!Array.isArray(photos) || photos.length > 3) throw new WorkflowError(400, 'Attach at most 3 photos.');
  return photos.map(photo => {
    if (typeof photo !== 'string') throw new WorkflowError(400, 'Photos must be base64 image data URLs.');
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(photo);
    if (!match) throw new WorkflowError(400, 'Photos must be base64 JPEG, PNG, or WebP data URLs.');
    return checkPhoto(Buffer.from(match[2], 'base64'), match[1]);
  });
}

function readDraft(form) {
  const draft = Object.fromEntries(Object.entries(draftFields).map(([field, label]) =>
    [field, readText(form.get(field), label, field === 'title' ? 160 : 5000)]));
  draft.location = readText(form.get('location'), 'Work location', 300);
  draft.reviewNote = readText(form.get('reviewNote'), 'Review note', 2000);
  const amount = readText(form.get('amount'), 'Estimate amount', 12);
  if (amount && !/^\d{1,7}(\.\d{1,2})?$/.test(amount)) {
    throw new WorkflowError(400, 'Enter a dollar amount with up to two decimal places.');
  }
  const [dollars, cents = ''] = amount.split('.');
  draft.amount = amount ? (Number(dollars) + Number(cents.padEnd(2, '0')) / 100).toFixed(2) : '';
  return draft;
}

function requireRevision(job, form) {
  if (form.get('revision') !== String(job.revision)) {
    throw new WorkflowError(409, 'This job changed. Reopen it to review the latest version.');
  }
}
const canReview = job => ['new', 'review', 'rejected'].includes(job.status);
const approvedWork = job => job.status === 'approved' || job.status === 'completed';
const readFlags = job => [...intakeFlags(job.original.description), ...(job.ai?.flags ?? [])];

export function createDashboard(env = process.env) {
  process.umask(0o077);
  const { secure, port, dbPath, hosts, intakeToken } = configuration(env);
  const auth = authStore(dbPath + '-auth', env, secure);
  let store;
  try {
    store = jobStore(dbPath);
  } catch (error) {
    auth.close();
    throw error;
  }
  const key = env.OPENAI_API_KEY;
  const model = env.GPS_OPENAI_MODEL || 'gpt-6-luna';

  const review = (job, session, options = {}) => reviewPage({
    job, flags: readFlags(job), history: store.history(job.id),
    photos: store.photoPositions(job.id), csrf: session.csrf, ...options
  });

  async function externalIntake(req, res) {
    if (req.method !== 'POST' || !intakeToken) throw new WorkflowError(404, 'Website intake is disabled.');
    if (!matches(req.headers.authorization, `Bearer ${intakeToken}`)) {
      throw new WorkflowError(401, 'A valid intake credential is required.');
    }
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
      throw new WorkflowError(415, 'Send application/json.');
    }
    const idempotencyKey = readText(req.headers['idempotency-key'], 'Idempotency-Key', 128, true);
    const body = await readBody(req, bodyLimit);
    let input;
    try { input = JSON.parse(body.toString('utf8')); } catch { /* handled below */ }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WorkflowError(400, 'Send a JSON object.');
    const result = store.create(intakeFields(input), jsonPhotos(input.photos), 'Website', idempotencyKey);
    return json(res, result.duplicate ? 200 : 201, { id: result.id });
  }

  async function runAnalysis(req, res, id, session) {
    const form = await readForm(req, session.csrf);
    const job = store.get(id);
    requireRevision(job, form);
    if (!canReview(job)) throw new WorkflowError(409, 'Analysis is unavailable for this job right now.');
    const token = store.beginAnalysis(job);
    try {
      const ai = await analyzeJob({ key, model, description: job.original.description, photos: store.photos(id) });
      const changes = { ai, status: 'review' };
      if (!job.draft) changes.draft = draftFromAnalysis(ai, job.original.location);
      store.update(job, changes, 'OpenAI', 'AI draft received', { ai }, token);
    } catch (error) {
      if (!(error instanceof WorkflowError)) throw error;
      if (error.status !== 409) store.failedAnalysis(id, error.message, token);
      return html(res, error.status, review(store.get(id), session, { error: error.message }));
    } finally {
      store.endAnalysis(id, token);
    }
    return redirect(res, `/admin/jobs/${id}`);
  }

  async function saveReview(req, res, id, session) {
    const form = await readForm(req, session.csrf);
    const job = store.get(id);
    requireRevision(job, form);
    if (!canReview(job)) throw new WorkflowError(409, 'This job cannot be edited right now.');
    const action = form.get('action');
    let draft;
    try {
      draft = readDraft(form);
      if (action === 'approve') {
        for (const [field, label] of Object.entries({ title: 'Job title', scope: 'Scope', labor: 'Labor estimate', tasks: 'Work order tasks', location: 'Work location', amount: 'Estimate amount' })) {
          if (!draft[field]) throw new WorkflowError(400, `${label} is required for approval.`);
        }
        const flags = readFlags(job);
        if (flags.length && (form.get('safetyReviewed') !== 'yes' || !draft.reviewNote)) {
          throw new WorkflowError(400, 'Confirm that you reviewed the safety flags and explain which scope is safe to assign.');
        }
        const assignedTo = form.get('assignTechnician') === 'yes' ? technician : null;
        store.update(job, { draft, status: 'approved', assignedTo }, session.actor, 'Approved scope and estimate',
          { draft, assignedTo, flagsAtApproval: flags, safetyReviewed: Boolean(flags.length) });
      } else if (action === 'reject') {
        if (!draft.reviewNote) throw new WorkflowError(400, 'Enter a review note explaining the rejection.');
        store.update(job, { draft, status: 'rejected' }, session.actor, 'Rejected draft', { draft });
      } else if (action === 'save') {
        store.update(job, { draft, status: 'review' }, session.actor, 'Saved draft edits', { draft });
      } else {
        throw new WorkflowError(400, 'Choose a review action.');
      }
    } catch (error) {
      if (!(error instanceof WorkflowError) || error.status !== 400) throw error;
      const entered = draft ?? Object.fromEntries([...Object.keys(draftFields), 'location', 'amount', 'reviewNote']
        .map(field => [field, typeof form.get(field) === 'string' ? form.get(field) : '']));
      return html(res, 400, review(job, session, { error: error.message, entered, assignTechnician: form.get('assignTechnician') === 'yes' }));
    }
    return redirect(res, `/admin/jobs/${id}`);
  }

  async function changeAssignment(req, res, id, session) {
    const form = await readForm(req, session.csrf, { limit: 4096 });
    const job = store.get(id);
    requireRevision(job, form);
    if (!approvedWork(job)) throw new WorkflowError(409, 'Approve the work order before assigning it.');
    const action = form.get('assignment');
    if (action !== 'assign' && action !== 'unassign') throw new WorkflowError(400, 'Choose an assignment action.');
    const assignedTo = action === 'assign' ? technician : null;
    if (assignedTo !== job.assigned_to) {
      store.update(job, { assignedTo }, session.actor, assignedTo ? 'Assigned to the technician' : 'Removed the technician’s assignment', { assignedTo });
    }
    return redirect(res, `/admin/jobs/${id}`);
  }

  async function ownerRoute(req, res, path, url, session) {
    const get = req.method === 'GET';
    const post = req.method === 'POST';
    if (path === '/admin' && get) return html(res, 200, home(store.list(), session.csrf));
    if (path === '/admin/intake' && get) return html(res, 200, intakePage({ csrf: session.csrf, sample: url.searchParams.has('sample') }));
    if (path === '/admin/intake' && post) {
      const form = await readForm(req, session.csrf, { limit: bodyLimit, multipart: true });
      const values = Object.fromEntries(form);
      try {
        const result = store.create(intakeFields(values), await formPhotos(form), session.actor);
        return redirect(res, `/admin/jobs/${result.id}`);
      } catch (error) {
        if (!(error instanceof WorkflowError) || error.status !== 400) throw error;
        return html(res, 400, intakePage({ csrf: session.csrf, values, error: error.message }));
      }
    }
    const match = /^\/admin\/jobs\/(GPS-[A-F0-9]{12})(?:\/(analyze|review|assignment|work-order|photos\/[0-2]))?$/.exec(path);
    if (!match) throw new WorkflowError(404, 'Page not found.');
    const [, id, action] = match;
    if (get && !action) return html(res, 200, review(store.get(id), session));
    if (post && action === 'analyze') return runAnalysis(req, res, id, session);
    if (post && action === 'review') return saveReview(req, res, id, session);
    if (post && action === 'assignment') return changeAssignment(req, res, id, session);
    if (get && action === 'work-order') {
      const job = store.get(id);
      if (!approvedWork(job)) throw new WorkflowError(404, 'Work order not found.');
      return html(res, 200, workPage(job, session.csrf, { owner: true }));
    }
    if (get && action?.startsWith('photos/')) {
      const photo = store.photo(id, Number(action.at(-1)));
      if (photo && ['image/jpeg', 'image/png', 'image/webp'].includes(photo.mime)) {
        return send(res, 200, Buffer.from(photo.bytes), photo.mime);
      }
    }
    throw new WorkflowError(404, 'Page not found.');
  }

  async function technicianRoute(req, res, path, session) {
    const get = req.method === 'GET';
    if (get && path === '/technician') return html(res, 200, workList(store.listForTechnician(session.username), session.csrf));
    const match = /^\/technician\/jobs\/(GPS-[A-F0-9]{12})(\/complete)?$/.exec(path);
    if (!match || !(get && !match[2] || req.method === 'POST' && match[2])) {
      throw new WorkflowError(404, 'Work order not found.');
    }
    const [, id] = match;
    const form = get ? null : await readForm(req, session.csrf, { limit: 32 * 1024 });
    const job = store.workForTechnician(id, session.username);
    if (get) return html(res, 200, workPage(job, session.csrf));
    requireRevision(job, form);
    if (job.status !== 'approved') throw new WorkflowError(409, 'This job is already marked complete.');
    let note;
    try {
      note = readText(form.get('completionNote'), 'Completion note', 2000, true);
    } catch (error) {
      if (!(error instanceof WorkflowError)) throw error;
      return html(res, 400, workPage(job, session.csrf, { error: error.message }));
    }
    store.complete(job, session.actor, note);
    return redirect(res, `/technician/jobs/${id}`);
  }

  async function handle(req, res) {
    let session;
    let path;
    try {
      const host = req.headers.host?.toLowerCase();
      if (!hosts.has(host)) throw new WorkflowError(403, 'Use the GPS Home Fix dashboard address.');
      // Passenger rejects client-supplied headers with the !~ prefix before proxying.
      if (secure && req.headers['!~passenger-proto'] !== 'https') {
        throw new WorkflowError(403, 'Use HTTPS to access the dashboard.');
      }
      if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) {
        throw new WorkflowError(400, 'Invalid request path.');
      }
      const origin = `${secure ? 'https' : 'http'}://${host}`;
      const url = new URL(req.url, origin);
      path = url.pathname.replace(/\/$/, '') || '/';
      if (path === '/api/intake') return await externalIntake(req, res);
      if (path.startsWith('/api/')) throw new WorkflowError(404, 'Page not found.');
      const get = req.method === 'GET';
      const post = req.method === 'POST';
      if (post && (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site')) {
        throw new WorkflowError(403, 'Submit this request from the dashboard.');
      }
      if (get && path === '/styles.css') return send(res, 200, css, 'text/css; charset=utf-8');

      session = auth.session(req.headers.cookie);
      if (get && path === '/') return redirect(res, session ? homeFor(session.role) : '/login');
      if (get && path === '/login') return session ? redirect(res, homeFor(session.role)) : html(res, 200, loginPage());
      if (post && path === '/login') {
        const form = await readForm(req, undefined, { limit: 4096 });
        const result = await auth.login(form.get('username'), form.get('password'), session);
        if (result.role) return redirect(res, homeFor(result.role), { 'Set-Cookie': result.cookie });
        if (result.throttled) {
          return html(res, 429, loginPage('Too many sign-in attempts. Try again in a few minutes.'), { 'Retry-After': '900' });
        }
        return html(res, 401, loginPage('The username or password is incorrect.'));
      }
      if (post && path === '/logout') {
        if (!session) throw new WorkflowError(401, 'Sign in to continue.');
        await readForm(req, session.csrf, { limit: 4096 });
        auth.revoke(session.tokenHash);
        return redirect(res, '/login', { 'Set-Cookie': auth.clearCookie });
      }
      const role = /^\/admin(?:\/|$)/.test(path) ? 'owner' : /^\/technician(?:\/|$)/.test(path) ? 'technician' : null;
      if (!role) throw new WorkflowError(404, 'Page not found.');
      if (!session) {
        if (get) return redirect(res, '/login');
        throw new WorkflowError(401, 'Sign in to continue.');
      }
      if (session.role !== role) throw new WorkflowError(403, 'This page is unavailable for your account.');
      return await (role === 'owner' ? ownerRoute(req, res, path, url, session) : technicianRoute(req, res, path, session));
    } catch (error) {
      const known = error instanceof WorkflowError;
      if (!known) console.error('GPS request failed:', error.code ?? error.name);
      const status = known ? error.status : 500;
      const message = known ? error.message : 'The dashboard could not complete this request. Try again.';
      if (path?.startsWith('/api/')) return json(res, status, { error: message });
      return html(res, status, errorPage(message, session));
    }
  }

  return { handle, port, close() { store.close(); auth.close(); } };
}

export function start() {
  if (usingHttps(process.env) && !globalThis.PhusionPassenger) {
    throw new Error('Start the hosted dashboard through Passenger.');
  }
  const { handle, port, close } = createDashboard();
  const server = createServer(handle);
  server.requestTimeout = 100_000;
  server.on('close', close);
  server.listen(port, '127.0.0.1', () => console.log('GPS Home Fix dashboard is ready.'));
  return server;
}

if (import.meta.main) start();
