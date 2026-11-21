import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { passwordHash } from '../auth.mjs';
import { jobStore } from '../jobs.mjs';
import { createDashboard } from '../server.mjs';

process.umask(0o077);
const scratch = mkdtempSync(join(tmpdir(), 'gps-dashboard-check-'));
after(() => rmSync(scratch, { force: true, recursive: true }));
const origin = 'https://dashboard.example.test';
const host = new URL(origin).host;
const publicRoot = join(scratch, 'web-root');
mkdirSync(publicRoot);
const photo = readFileSync(new URL('./synthetic-door.png', import.meta.url));
const ownerPassword = 'Synthetic-owner-password-for-testing';
const technicianPassword = 'Synthetic-technician-password-for-testing';
const key = 'synthetic-api-key-only';
const [ownerHash, technicianHash] = await Promise.all([passwordHash(ownerPassword), passwordHash(technicianPassword)]);
const credentials = {
  GPS_OWNER_PASSWORD_HASH: ownerHash, GPS_TECH_PASSWORD_HASH: technicianHash,
  OPENAI_API_KEY: key
};
const hosted = {
  ...credentials, NODE_ENV: 'production', GPS_PUBLIC_ORIGIN: origin, GPS_DOCUMENT_ROOT: publicRoot,
  GPS_INTAKE_TOKEN: 'an-intake-token-that-must-stay-disabled'
};

function app(t, name, options = {}) {
  const env = { ...hosted, GPS_DB_PATH: join(scratch, name, 'jobs.sqlite'), ...options };
  let dashboard = createDashboard(env);
  t.after(() => dashboard.close());
  return {
    get dashboard() { return dashboard; },
    env,
    restart(newEnv = env) {
      dashboard.close();
      dashboard = createDashboard(newEnv);
    }
  };
}

async function send(instance, path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const secured = Boolean(instance.env.GPS_PUBLIC_ORIGIN);
  const location = secured ? origin : 'http://127.0.0.1:4321';
  const requestHeaders = {
    host: secured ? host : '127.0.0.1:4321',
    ...(secured ? { '!~passenger-proto': 'https' } : {}),
    ...(method === 'POST' ? { origin: location } : {}),
    ...(cookie ? { cookie } : {})
  };
  let bytes = Buffer.alloc(0);
  if (body !== undefined) {
    const encoded = new Response(body);
    requestHeaders['content-type'] = encoded.headers.get('content-type');
    bytes = Buffer.from(await encoded.arrayBuffer());
    requestHeaders['content-length'] = String(bytes.length);
  }
  const req = Object.assign(Readable.from(bytes.length ? [bytes] : []), { method, url: path, headers: { ...requestHeaders, ...headers } });
  const responseHeaders = {};
  let response;
  const res = {
    setHeader(name, value) { responseHeaders[name] = value; },
    writeHead(status, values) {
      Object.assign(responseHeaders, values);
      this.status = status;
    },
    end(contents) {
      assert.equal(response, undefined, 'response was written more than once');
      response = new Response(contents, { status: this.status, headers: responseHeaders });
    }
  };
  await instance.dashboard.handle(req, res);
  assert.ok(response, 'handler must send a response');
  return response;
}

const post = (instance, path, cookie, fields, options = {}) => send(instance, path,
  { method: 'POST', body: new URLSearchParams(fields), cookie, ...options });
const sessionCookie = response => response.headers.get('set-cookie').split(';')[0];
const signIn = (instance, username, password, cookie) => post(instance, '/login', cookie, { username, password });

function value(page, name) {
  const field = page.match(new RegExp('name="' + name + '" value="([^"]+)"'))?.[1];
  assert.ok(field, name + ' should be present');
  return field;
}

const intake = {
  name: 'Taylor Example', email: 'taylor@example.test', phone: '850-555-0142', location: 'Fictional Sample Site',
  description: 'The closet door rubs. The customer asks for an adjustment.'
};

function intakeForm(csrf, overrides) {
  const form = new FormData();
  for (const [name, content] of Object.entries({ ...intake, ...overrides, _csrf: csrf })) form.set(name, content);
  form.set('photos', new Blob([photo], { type: 'image/png' }), 'synthetic-door.png');
  return form;
}

async function newJob(instance, owner, csrf, overrides) {
  const result = await send(instance, '/admin/intake', { method: 'POST', cookie: owner, body: intakeForm(csrf, overrides) });
  assert.equal(result.status, 303);
  const path = result.headers.get('location');
  assert.match(path, /^\/admin\/jobs\/GPS-[A-F0-9]{12}$/);
  return { path, id: path.split('/').at(-1), page: await (await send(instance, path, { cookie: owner })).text() };
}

function draft(csrf, page, fields = {}) {
  return {
    _csrf: csrf, revision: value(page, 'revision'), action: 'approve',
    title: 'Synthetic Door Adjustment', scope: 'Adjust alignment.', labor: 'One hour',
    tasks: 'Adjust door alignment.\nCheck the latch.',
    location: 'Fictional Work Location', amount: '52.50', ...fields
  };
}

test('secure startup guards, canonical HTTPS and sign-in boundaries', async t => {
  const a = app(t, 'auth');
  assert.throws(() => createDashboard({ ...a.env, GPS_PUBLIC_ORIGIN: 'http://dashboard.example.test' }), /Configure an HTTPS/);
  assert.throws(() => createDashboard({ ...a.env, GPS_ENABLE_WEBSITE_INTAKE: 'true' }), /intake is disabled/);
  assert.throws(() => createDashboard({ ...a.env, GPS_DB_PATH: join(publicRoot, 'jobs.sqlite') }), /outside|owner-only/);
  assert.throws(() => createDashboard({ ...a.env, GPS_TECH_PASSWORD_HASH: '' }), /Configure GPS_OWNER/);
  assert.throws(() => createDashboard({ ...a.env, GPS_TECH_PASSWORD_HASH: ownerHash }), /independently/);

  assert.equal((await send(a, '/', { headers: { '!~passenger-proto': undefined, 'x-forwarded-proto': 'https' } })).status, 403);
  assert.equal((await send(a, '/login', { headers: { host: 'other.example.test' } })).status, 403);
  assert.equal((await send(a, '//other.example.test/login')).status, 400);
  assert.equal((await send(a, '/admin')).headers.get('location'), '/login');
  assert.equal((await send(a, '/technician')).headers.get('location'), '/login');
  const publicPage = await send(a, '/login');
  assert.equal(publicPage.status, 200);
  assert.equal(publicPage.headers.get('cache-control'), 'no-store');
  assert.match(publicPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(publicPage.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.match(await publicPage.text(), /autocomplete="current-password"/);
  assert.equal((await post(a, '/login', undefined, { username: 'owner', password: ownerPassword },
    { headers: { origin: 'https://website.example.test' } })).status, 403);
  assert.equal((await post(a, '/login', undefined, { username: 'owner', password: ownerPassword },
    { headers: { origin: undefined } })).status, 403);
  assert.equal((await signIn(a, 'unknown', ownerPassword)).status, 401);
  assert.equal((await signIn(a, 'owner', technicianPassword)).status, 401);

  const ownerLogin = await signIn(a, 'owner', ownerPassword);
  assert.equal(ownerLogin.status, 303);
  assert.equal(ownerLogin.headers.get('location'), '/admin');
  const header = ownerLogin.headers.get('set-cookie');
  assert.match(header, /^__Host-gps_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/);
  const owner = sessionCookie(ownerLogin);
  const techLogin = await signIn(a, 'technician', technicianPassword);
  assert.equal(techLogin.headers.get('location'), '/technician');
  const tech = sessionCookie(techLogin);
  assert.notEqual(tech, owner);
  assert.equal((await send(a, '/technician', { cookie: owner })).status, 403);
  assert.equal((await send(a, '/admin/intake', { cookie: tech })).status, 403);
  assert.equal((await send(a, '/admin', { cookie: owner + '; ' + tech })).headers.get('location'), '/login');
  assert.equal((await send(a, '/admin', { cookie: owner.slice(0, -1) })).headers.get('location'), '/login');

  const ownerPage = await (await send(a, '/admin', { cookie: owner })).text();
  const ownerCSRF = value(ownerPage, '_csrf');
  const techCSRF = value(await (await send(a, '/technician', { cookie: tech })).text(), '_csrf');
  assert.notEqual(ownerCSRF, techCSRF);
  assert.equal((await post(a, '/logout', owner, { _csrf: techCSRF })).status, 403);
  const sharedAuth = createDashboard(a.env);
  try {
    const worker = { env: a.env, dashboard: sharedAuth };
    assert.equal((await send(worker, '/admin', { cookie: owner })).status, 200);
    const logout = await post(worker, '/logout', owner, { _csrf: ownerCSRF });
    assert.equal(logout.headers.get('location'), '/login');
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0; Secure$/);
    assert.equal((await send(a, '/admin', { cookie: owner })).headers.get('location'), '/login');
  } finally {
    sharedAuth.close();
  }
  a.restart({ ...a.env, GPS_TECH_PASSWORD_HASH: await passwordHash('Synthetic replacement technician password') });
  assert.equal((await send(a, '/technician', { cookie: tech })).headers.get('location'), '/login');
  a.restart();
  assert.equal((await send(a, '/technician', { cookie: tech })).headers.get('location'), '/login');
});

test('SQLite-backed sign-in throttling, idle and absolute expiration', async t => {
  const a = app(t, 'throttle');
  const owner = sessionCookie(await signIn(a, 'owner', ownerPassword));
  const tech = sessionCookie(await signIn(a, 'technician', technicianPassword));
  const db = new DatabaseSync(a.env.GPS_DB_PATH + '-auth');
  try {
    assert.equal(db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get(owner.split('=')[1]), undefined);
    db.prepare("UPDATE sessions SET idle_until = ? WHERE username = 'technician'").run(Date.now() - 1000);
    db.prepare("UPDATE sessions SET expires_at = ? WHERE username = 'owner'").run(Date.now() - 1000);
    assert.equal((await send(a, '/technician', { cookie: tech })).headers.get('location'), '/login');
    assert.equal((await send(a, '/admin', { cookie: owner })).headers.get('location'), '/login');
  } finally {
    db.close();
  }
  const attempts = await Promise.all([
    signIn(a, 'owner', 'synthetic incorrect password'),
    signIn(a, 'owner', 'synthetic incorrect password')
  ]);
  assert.deepEqual(attempts.map(response => response.status).sort(), [401, 429]);
  for (let attempt = 1; attempt < 8; attempt++) {
    assert.equal((await signIn(a, 'owner', 'synthetic incorrect password')).status, 401);
  }
  a.restart();
  const throttled = await signIn(a, 'owner', ownerPassword);
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get('retry-after'), '900');
  assert.equal((await signIn(a, 'technician', technicianPassword)).status, 303);
});

test('owner intake, approval, field access, revocation and completion', async t => {
  const a = app(t, 'jobs');
  const owner = sessionCookie(await signIn(a, 'owner', ownerPassword));
  const tech = sessionCookie(await signIn(a, 'technician', technicianPassword));
  const ownerCSRF = value(await (await send(a, '/admin', { cookie: owner })).text(), '_csrf');
  const techCSRF = value(await (await send(a, '/technician', { cookie: tech })).text(), '_csrf');
  const first = await newJob(a, owner, ownerCSRF, { description: 'Exposed electrical wires close to the paint touch-up area.' });
  const work = '/technician/jobs/' + first.id;
  assert.match(first.page, /Potential electrical hazard/);
  assert.equal((await send(a, first.path, { cookie: tech })).status, 403);
  assert.equal((await send(a, first.path + '/photos/0', { cookie: tech })).status, 403);
  assert.equal((await send(a, first.path + '/photos/0')).headers.get('location'), '/login');
  const image = await send(a, first.path + '/photos/0', { cookie: owner });
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), photo);
  assert.equal((await send(a, work, { cookie: tech })).status, 404);
  assert.equal((await post(a, work + '/complete', tech, { _csrf: techCSRF, completionNote: 'test' })).status, 404);
  assert.equal((await post(a, first.path + '/assignment', owner,
    { _csrf: ownerCSRF, revision: value(first.page, 'revision'), assignment: 'assign' })).status, 409);
  for (const action of ['/review', '/analyze', '/assignment']) {
    assert.equal((await post(a, first.path + action, tech, { _csrf: techCSRF })).status, 403);
    assert.equal((await post(a, first.path + action, undefined, { _csrf: ownerCSRF })).status, 401);
  }
  assert.equal((await send(a, '/admin/intake', { method: 'POST', cookie: tech, body: intakeForm(techCSRF) })).status, 403);
  const bogusPhoto = intakeForm(ownerCSRF);
  bogusPhoto.set('photos', new Blob(['synthetic invalid photo'], { type: 'image/png' }), 'invalid.png');
  assert.equal((await send(a, '/admin/intake', { method: 'POST', cookie: owner, body: bogusPhoto })).status, 400);
  const oversized = intakeForm(ownerCSRF);
  oversized.set('photos', new Blob([Buffer.concat([photo, Buffer.alloc(2 * 1024 * 1024)])], { type: 'image/png' }), 'large.png');
  assert.equal((await send(a, '/admin/intake', { method: 'POST', cookie: owner, body: oversized })).status, 400);
  const fields = draft(ownerCSRF, first.page);
  assert.equal((await post(a, first.path + '/review', owner, { ...fields, _csrf: techCSRF })).status, 403);
  assert.equal((await post(a, first.path + '/review', owner, fields)).status, 400);
  assert.equal((await post(a, first.path + '/review', owner,
    { ...fields, action: 'reject', reviewNote: 'Hold for inspection.' })).status, 303);
  assert.equal((await post(a, first.path + '/review', owner, fields)).status, 409);
  assert.equal((await send(a, work, { cookie: tech })).status, 404);
  const rejected = await (await send(a, first.path, { cookie: owner })).text();
  assert.equal((await post(a, first.path + '/review', owner, draft(ownerCSRF, rejected,
    { safetyReviewed: 'yes', reviewNote: 'Synthetic test: paint work only after hazard clearance.' }))).status, 303);
  const approved = await (await send(a, first.path, { cookie: owner })).text();
  assert.match(approved, /\$52\.50/);
  assert.match(approved, /Unassigned/);
  assert.match(approved, /Invoice information/);
  const preview = await (await send(a, first.path + '/work-order', { cookie: owner })).text();
  assert.match(preview, /Adjust door alignment/);
  assert.doesNotMatch(preview, /Mark work complete/);
  assert.equal((await send(a, first.path + '/work-order', { cookie: tech })).status, 403);
  assert.equal((await send(a, work, { cookie: tech })).status, 404);
  assert.doesNotMatch(await (await send(a, '/technician', { cookie: tech })).text(), new RegExp(first.id));

  const assign = (page, assignment) => post(a, first.path + '/assignment', owner,
    { _csrf: ownerCSRF, revision: value(page, 'revision'), assignment });
  assert.equal((await assign(approved, 'assign')).status, 303);
  const visible = await (await send(a, work, { cookie: tech })).text();
  assert.match(visible, /Fictional Work Location/);
  assert.match(visible, /Adjust door alignment/);
  assert.doesNotMatch(visible, /52\.50|Taylor Example|taylor@example\.test|Fictional Sample Site|Invoice information|after hazard clearance/);
  assert.match(await (await send(a, '/technician', { cookie: tech })).text(), new RegExp(first.id));
  assert.equal((await send(a, work)).headers.get('location'), '/login');
  assert.equal((await send(a, '/work-orders/' + 'a'.repeat(48), { cookie: tech })).status, 404);
  assert.equal((await send(a, work + '/photos/0', { cookie: tech })).status, 404);
  const complete = (fields, cookie = tech) => post(a, work + '/complete', cookie, fields);
  const completion = { _csrf: techCSRF, revision: value(visible, 'revision'), completionNote: 'Adjusted synthetic door.' };
  assert.equal((await complete(completion, owner)).status, 403);
  assert.equal((await complete({ ...completion, _csrf: ownerCSRF })).status, 403);
  const assigned = await (await send(a, first.path, { cookie: owner })).text();
  assert.equal((await assign(assigned, 'unassign')).status, 303);
  assert.equal((await send(a, work, { cookie: tech })).status, 404);
  assert.equal((await complete(completion)).status, 404);
  const removed = await (await send(a, first.path, { cookie: owner })).text();
  assert.equal((await assign(removed, 'assign')).status, 303);
  assert.equal((await complete(completion)).status, 409);
  const reassigned = await (await send(a, work, { cookie: tech })).text();
  const current = { ...completion, revision: value(reassigned, 'revision') };
  assert.equal((await complete({ ...current, completionNote: '' })).status, 400);
  assert.equal((await complete(current)).status, 303);
  assert.equal((await complete(current)).status, 409);
  assert.match(await (await send(a, work, { cookie: tech })).text(), /Completion reported to V/);
  assert.match(await (await send(a, first.path, { cookie: owner })).text(), /Adjusted synthetic door/);

  const second = await newJob(a, owner, ownerCSRF, { name: 'Another Fictional Customer' });
  assert.equal((await post(a, second.path + '/review', owner,
    draft(ownerCSRF, second.page, { title: 'Second synthetic job', assignTechnician: 'yes' }))).status, 303);
  a.restart();
  assert.match(await (await send(a, '/technician', { cookie: tech })).text(), /Second synthetic job/);
  assert.equal((await send(a, second.path + '/photos/0', { cookie: owner })).status, 200);
  assert.equal(statSync(a.env.GPS_DB_PATH).mode & 0o077, 0);
  assert.equal(statSync(a.env.GPS_DB_PATH + '-auth').mode & 0o077, 0);
  assert.equal(statSync(dirname(a.env.GPS_DB_PATH)).mode & 0o077, 0);
});

test('OpenAI stays owner-only and in progress analysis is shared across workers', async t => {
  const a = app(t, 'ai');
  const owner = sessionCookie(await signIn(a, 'owner', ownerPassword));
  const tech = sessionCookie(await signIn(a, 'technician', technicianPassword));
  const csrf = value(await (await send(a, '/admin', { cookie: owner })).text(), '_csrf');
  const job = await newJob(a, owner, csrf);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let calls = 0;
  const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer ' + key);
    const request = JSON.parse(options.body);
    assert.equal(request.store, false);
    assert.match(request.input[0].content[1].image_url, /^data:image\/png;base64,/);
    assert.doesNotMatch(options.body, /Taylor Example|taylor@example\.test|Fictional Sample Site/);
    calls++;
    if (calls === 1) return Response.json({ error: { code: 'temporary_failure' } }, { status: 503 });
    started.resolve();
    await release.promise;
    const response = Object.fromEntries(Object.entries(request.text.format.schema.properties).map(([field, spec]) =>
      [field, spec.type === 'array' ? [] : field === 'title' ? 'Synthetic AI Draft' : 'Fictional draft text.']));
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{
      type: 'output_text', text: JSON.stringify(response)
    }] }] });
  });
  let fields = { _csrf: csrf, revision: value(job.page, 'revision') };
  assert.equal((await post(a, job.path + '/analyze', tech, fields)).status, 403);
  assert.equal((await post(a, job.path + '/analyze', undefined, fields)).status, 401);
  assert.equal(mock.mock.callCount(), 0);
  assert.equal((await post(a, job.path + '/analyze', owner, fields)).status, 502);
  const before = await (await send(a, job.path, { cookie: owner })).text();
  assert.match(before, /Analysis failed/);
  assert.doesNotMatch(before, new RegExp(key));
  assert.equal((await post(a, job.path + '/review', owner,
    draft(csrf, before, { action: 'save', title: 'Owner’s saved draft' }))).status, 303);
  fields = { _csrf: csrf, revision: value(await (await send(a, job.path, { cookie: owner })).text(), 'revision') };

  const worker = createDashboard(a.env);
  const pending = post(a, job.path + '/analyze', owner, fields);
  try {
    await Promise.race([started.promise, pending.then(() => assert.fail('analysis did not reach the simulated API'))]);
    const another = { env: a.env, dashboard: worker };
    assert.equal((await post(another, job.path + '/analyze', owner, fields)).status, 409);
    assert.equal((await post(another, job.path + '/review', owner, { ...draft(csrf, job.page), ...fields })).status, 409);
    assert.equal(mock.mock.callCount(), 2);
  } finally {
    release.resolve();
    worker.close();
  }
  assert.equal((await pending).status, 303);
  const reviewed = await (await send(a, job.path, { cookie: owner })).text();
  assert.match(reviewed, /Synthetic AI Draft/);
  assert.match(reviewed, /<h1>Owner’s saved draft<\/h1>/);
});

test('public intake is dormant and the existing contract remains available in an explicit loopback test', async t => {
  const a = app(t, 'disabled');
  const body = JSON.stringify({ ...intake, photos: ['data:image/png;base64,' + photo.toString('base64')] });
  const headers = { authorization: 'Bearer ' + hosted.GPS_INTAKE_TOKEN, 'idempotency-key': 'synthetic-only', 'content-type': 'application/json' };
  assert.equal((await send(a, '/api/intake', { method: 'POST', body, headers })).status, 404);
  assert.equal((await send(a, '/api/jobs')).status, 404);
  const local = app(t, 'loopback', { NODE_ENV: 'test', GPS_PUBLIC_ORIGIN: '', GPS_ENABLE_WEBSITE_INTAKE: 'true' });
  assert.equal((await send(local, '/api/intake', { method: 'POST', body, headers: { ...headers, authorization: '' } })).status, 401);
  const first = await send(local, '/api/intake', { method: 'POST', body, headers });
  assert.equal(first.status, 201);
  const duplicate = await send(local, '/api/intake', { method: 'POST', body, headers });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await first.json(), await duplicate.json());
  assert.equal((await send(local, '/api/intake', { method: 'POST', body: body.replace('closet door', 'hall door'), headers })).status, 409);
});

test('legacy SQLite migration, private online backup, and restore to a new database', async t => {
  const path = join(scratch, 'legacy', 'jobs.sqlite');
  mkdirSync(dirname(path), { mode: 0o700 });
  const db = new DatabaseSync(path);
  const oldToken = 'a'.repeat(48);
  const id = 'GPS-0123456789AB';
  const oldDraft = { title: 'Fictional legacy job', location: 'Fictional legacy location', tasks: 'Check door alignment.', amount: '45' };
  db.exec(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY, original TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
    revision INTEGER NOT NULL DEFAULT 0, ai TEXT, draft TEXT, work_token TEXT UNIQUE,
    created TEXT NOT NULL, intake_key TEXT UNIQUE, intake_digest TEXT
  )`);
  db.prepare('INSERT INTO jobs (id,original,status,draft,work_token,created) VALUES (?,?,?,?,?,?)')
    .run(id, JSON.stringify(intake), 'approved', JSON.stringify(oldDraft), oldToken, new Date().toISOString());
  db.close();

  const a = app(t, 'legacy');
  const owner = sessionCookie(await signIn(a, 'owner', ownerPassword));
  const tech = sessionCookie(await signIn(a, 'technician', technicianPassword));
  const ownerCSRF = value(await (await send(a, '/admin', { cookie: owner })).text(), '_csrf');
  const oldAdmin = '/admin/jobs/' + id;
  const oldWork = '/technician/jobs/' + id;
  const oldPage = await (await send(a, oldAdmin, { cookie: owner })).text();
  assert.match(oldPage, /Fictional legacy job/);
  assert.match(oldPage, /Unassigned/);
  assert.equal((await send(a, '/work-orders/' + oldToken, { cookie: tech })).status, 404);
  assert.equal((await send(a, oldWork, { cookie: tech })).status, 404);
  assert.equal((await post(a, oldAdmin + '/assignment', owner,
    { _csrf: ownerCSRF, revision: value(oldPage, 'revision'), assignment: 'assign' })).status, 303);
  assert.equal((await send(a, oldWork, { cookie: tech })).status, 200);
  const job = await newJob(a, owner, ownerCSRF);
  const active = jobStore(path);
  try { active.beginAnalysis(active.get(job.id)); } finally { active.close(); }

  const cli = fileURLToPath(new URL('../scripts/database.mjs', import.meta.url));
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const backup = join(scratch, 'backups', 'verified.sqlite');
  const restore = join(scratch, 'restored', 'jobs.sqlite');
  assert.match(run('backup', path, backup), /Jobs: 2\. Photos: 1\. Activity entries: 2/);
  assert.match(run('verify', backup), /SQLite integrity/);
  assert.throws(() => run('backup', path, backup), /destination already exists/);
  assert.throws(() => run('restore', backup, path), /destination already exists/);
  assert.match(run('restore', backup, restore), /Jobs: 2\. Photos: 1\. Activity entries: 2/);
  assert.equal(statSync(backup).mode & 0o077, 0);
  assert.equal(statSync(restore).mode & 0o077, 0);
  const recovered = jobStore(restore);
  try {
    assert.equal(recovered.get(id).assigned_to, 'technician');
    assert.deepEqual(Buffer.from(recovered.photo(job.id, 0).bytes), photo);
    assert.equal(recovered.history(job.id)[0].action, 'Request received');
    assert.ok(recovered.beginAnalysis(recovered.get(job.id)), 'restore clears stale analysis locks');
  } finally {
    recovered.close();
  }
  const copy = app(t, 'restored');
  assert.equal((await send(copy, '/admin', { cookie: owner })).headers.get('location'), '/login');
  const restoredOwner = sessionCookie(await signIn(copy, 'owner', ownerPassword));
  assert.match(await (await send(copy, oldAdmin, { cookie: restoredOwner })).text(), /Fictional legacy job/);
});
