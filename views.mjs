import { draftFields, draftFromAnalysis, hazardLabels } from './jobs.mjs';

const statusLabels = {
  new: 'Intake received', review: 'Needs owner review', rejected: 'Rejected',
  approved: 'Approved', completed: 'Completed'
};
const escape = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const money = amount => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(amount));
const date = value => new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Chicago'
}).format(new Date(value));
const pill = status => `<span class="status ${escape(status)}">${escape(statusLabels[status])}</span>`;
const hidden = (key, value) => `<input type="hidden" name="${key}" value="${escape(value)}">`;
const message = error => error ? `<p class="error" role="alert">${escape(error)}</p>` : '';
const lines = (value, className = '') => `<p class="lines ${className}">${escape(value || '—')}</p>`;
const row = (label, value) => `<div><dt>${escape(label)}</dt><dd>${escape(value || '—')}</dd></div>`;

function page(title, content, { field = false, csrf } = {}) {
  const destination = field ? '/technician' : '/admin';
  const navigation = field ? '<a href="/technician">Work orders</a>'
    : '<a href="/admin">Jobs</a><a href="/admin/intake">New request</a>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · GPS Home Fix</title><link rel="stylesheet" href="/styles.css"></head>
<body><a class="skip" href="#main">Skip to content</a><header class="top"><div class="wrap top-inner">
${csrf ? `<a class="brand" href="${destination}">GPS Home Fix</a>` : '<span class="brand">GPS Home Fix</span>'}
${csrf ? `<nav aria-label="Main">${navigation}<form action="/logout" method="post">${hidden('_csrf', csrf)}
  <button class="signout" type="submit">Sign out</button></form></nav>` : ''}
</div></header><main id="main" class="wrap ${field ? 'field' : ''}">${content}</main></body></html>`;
}

export function loginPage(error) {
  return page('Sign in', `<div class="login"><div class="page-heading"><h1>Sign in</h1></div>
    <form class="panel form-panel" action="/login" method="post">${message(error)}
      <div class="control"><label for="username">Username</label>
        <input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required></div>
      <div class="control"><label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required></div>
      <button class="primary" type="submit">Sign in</button>
    </form></div>`);
}

export function errorPage(error, session) {
  const field = session?.role === 'technician';
  const back = session ? (field ? '<a href="/technician">Back to work orders</a>' : '<a href="/admin">Back to jobs</a>')
    : '<a href="/login">Sign in</a>';
  return page('Request could not be completed', `<h1>Request could not be completed</h1>${message(error)}
    <p>${back}</p>`, { field, csrf: session?.csrf });
}

export function home(jobs, csrf) {
  return page('Jobs', `
    <div class="page-heading"><div><h1>Jobs</h1><p>Review requests and prepare work orders for the technician.</p></div>
    <a class="button primary" href="/admin/intake">New request</a></div>
    <section class="panel queue" aria-label="Job queue">
      ${jobs.length ? `<ul class="job-list">${jobs.map(job =>
        `<li><a href="/admin/jobs/${job.id}">${escape(job.draft?.title || job.ai?.title || 'Customer request')}</a>
        <span class="job-meta">${escape(job.id)} · ${escape(job.original.name)} · ${escape(date(job.created))}</span>
        ${pill(job.status)}</li>`).join('')}</ul>`
        : '<div class="empty"><h2>No requests yet</h2><p>Add a request by hand or open a sample with fictional customer details.</p><a href="/admin/intake?sample">Open the sample request</a></div>'}
    </section>`, { csrf });
}

const demo = {
  name: 'Jordan Sample',
  email: 'jordan@example.test',
  phone: '850-555-0142',
  location: 'Pensacola, FL · fictional site, 100 Example Lane',
  description: 'An interior hollow-core closet door rubs at the top corner and the latch no longer catches. Two screws on the upper hinge appear loose. Please check the hinges, adjust the door alignment, and confirm the door closes smoothly. No visible water damage. The customer can provide a close-up of the hinge if needed.'
};

function field(label, key, value, opts = {}) {
  const { area, type = 'text', required, max = 5000, help } = opts;
  return `<div class="control"><label for="${key}">${escape(label)}</label>
    ${help ? `<small id="${key}-help">${escape(help)}</small>` : ''}
    ${area
      ? `<textarea id="${key}" name="${key}" rows="${area}" maxlength="${max}" ${required ? 'required' : ''}>${escape(value)}</textarea>`
      : `<input id="${key}" name="${key}" type="${type}" value="${escape(value)}" maxlength="${max}" ${required ? 'required' : ''} ${type === 'tel' ? 'inputmode="tel"' : ''} ${key === 'amount' ? 'inputmode="decimal"' : ''}
        ${help ? `aria-describedby="${key}-help"` : ''}>`}
  </div>`;
}

export function intakePage({ csrf, sample = false, values = sample ? demo : {}, error }) {
  return page('New request', `<div class="page-heading"><div><a class="back" href="/admin">← Jobs</a><h1>New request</h1>
    <p>Enter customer details and describe the repair.</p></div>
    <a class="button secondary" href="/admin/intake?sample">Load sample details</a></div>
    <form class="panel form-panel narrow" method="post" action="/admin/intake" enctype="multipart/form-data">
    ${hidden('_csrf', csrf)}${message(error)}
    ${field('Customer name', 'name', values.name, { required: true, max: 120 })}
    <div class="columns">
      ${field('Email', 'email', values.email, { type: 'email', max: 200 })}
      ${field('Phone', 'phone', values.phone, { type: 'tel', max: 40 })}
    </div>
    <p class="hint">Enter at least one way to contact the customer.</p>
    ${field('Service address or area', 'location', values.location, { required: true, max: 300 })}
    ${field('Repair description', 'description', values.description, { required: true, area: 6 })}
    <div class="control"><label for="photos">Photos <span class="hint">(optional)</span></label>
    <small id="photo-help">Up to 3 JPEG, PNG, or WebP images, 2 MB each.</small>
    <input id="photos" name="photos" type="file" multiple accept="image/jpeg,image/png,image/webp" aria-describedby="photo-help"></div>
    <button class="primary" type="submit">Create job ticket</button></form>`, { csrf });
}

function requestCard(job, photos) {
  const { original } = job;
  return `<section class="panel inset"><h2>Original request</h2><dl>
    ${row('Customer', original.name)}${row('Email', original.email)}${row('Phone', original.phone)}
    ${row('Service address or area', original.location)}</dl>
    ${lines(original.description)}
    ${photos.length ? `<div class="photos">${photos.map(({ position }) =>
      `<a href="/admin/jobs/${job.id}/photos/${position}"><img src="/admin/jobs/${job.id}/photos/${position}" alt="Open request photo ${position + 1}" loading="lazy" width="68" height="68"></a>`).join('')}</div>` : ''}
  </section>`;
}

function flagCard(flags) {
  if (!flags.length) return '';
  const unique = [...new Map(flags.map(flag => [`${flag.category}${flag.detail}`, flag])).values()];
  return `<section class="panel inset flags"><h2>Safety and service flags</h2><ul>${unique.map(flag =>
    `<li><strong>${escape(hazardLabels[flag.category])}</strong><br>${escape(flag.detail)}</li>`).join('')}</ul></section>`;
}

function historyCard(history) {
  return `<section class="panel inset"><h2>Activity</h2><ol class="history">${history.map(item =>
    `<li><strong>${escape(item.action)}</strong><span class="hint">${escape(item.actor)} · ${escape(date(item.time))}</span>
    ${item.details.note || item.details.draft?.reviewNote || item.details.reason
      ? lines(item.details.note || item.details.draft?.reviewNote || item.details.reason) : ''}</li>`).join('')}
    </ol></section>`;
}

const asRows = (keys, entry) => keys.map(key => row(draftFields[key], entry[key])).join('');

function originalAnalysis(job) {
  if (!job.ai) return '';
  const entered = draftFromAnalysis(job.ai, job.original.location);
  return `<details class="panel inset"><summary>Original AI recommendation</summary><dl>${asRows(Object.keys(draftFields), entered)}</dl></details>`;
}

function customerDrafts(job) {
  if (!job.draft) return '';
  const { title, scope, labor, amount, location } = job.draft;
  const estimate = [
    `Hi ${job.original.name},`, '', `Here is the proposed scope for ${title || job.id} at ${location || job.original.location}.`,
    '', scope || '[Scope to confirm]', '', `Estimated labor: ${labor || '[To confirm]'}`,
    `Estimated total: ${amount ? money(amount) : '[Owner to confirm]'}`,
    'Please reply with any questions or scope changes before scheduling.'
  ].join('\n');
  const invoice = [
    `Bill to: ${job.original.name}`, `Job reference: ${job.id}`,
    `Service location: ${location || job.original.location}`, '',
    'Work performed: [Verify against completion report]',
    'Labor and materials: [Confirm actual line items]',
    `Estimate reference: ${amount ? money(amount) : '[Owner to confirm]'}`,
    'Invoice date, taxes if applicable, amount due and payment terms: [Owner to confirm]'
  ].join('\n');
  return `<section class="panel inset"><h2>Customer drafts</h2><p class="hint">Review these before copying them into your customer communications.</p>
    <div class="columns"><div><h3>Estimate message</h3>${lines(estimate, 'draft-copy')}</div>
    <div><h3>Invoice information</h3>${lines(invoice, 'draft-copy')}</div></div></section>`;
}

function reviewForm(job, draft, flags, csrf, assignTechnician) {
  const panel = (name, keys) => `<fieldset><legend>${name}</legend>${keys.map(key =>
    field(draftFields[key], key, draft[key], key === 'title' ? { max: 160 } : { area: key === 'scope' || key === 'tasks' ? 4 : 2 })).join('')}</fieldset>`;
  return `<form class="panel form-panel" action="/admin/jobs/${job.id}/review" method="post">
    ${hidden('_csrf', csrf)}${hidden('revision', job.revision)}
    <h2>Review job draft</h2>
    ${panel('Scope', ['title', 'likelyRepair', 'questions', 'scope', 'uncertainties'])}
    ${panel('Estimate', ['labor', 'pricing', 'materials'])}
    ${field('Estimate amount (USD)', 'amount', draft.amount, { max: 12, help: 'Enter your own total before approval.' })}
    ${panel('Technician work order', ['tasks', 'tools', 'instructions'])}
    ${field('Work location', 'location', draft.location, { max: 300 })}
    ${field('Review note', 'reviewNote', draft.reviewNote, { area: 3, max: 2000 })}
    ${flags.length ? '<label class="check"><input type="checkbox" name="safetyReviewed" value="yes"> I reviewed the flags and explained the scope the technician can safely perform.</label>' : ''}
    <label class="check"><input type="checkbox" name="assignTechnician" value="yes" ${assignTechnician ? 'checked' : ''}> Assign to the technician on approval</label>
    <div class="actions">
      <button class="primary" name="action" value="approve">Approve scope and estimate</button>
      <button class="secondary" name="action" value="save">Save draft</button>
      <button class="secondary danger" name="action" value="reject">Reject</button>
    </div></form>`;
}

function approvedCard(job, csrf) {
  const assigned = job.assigned_to === 'technician';
  return `<section class="panel inset"><h2>Approved scope and estimate</h2><dl>
    ${row('Estimate amount', money(job.draft.amount))}
    ${asRows(['scope', 'labor', 'materials'], job.draft)}
    ${row('Review note', job.draft.reviewNote)}
    ${row('Assigned to', assigned ? 'Technician' : 'Unassigned')}</dl>
    <div class="actions"><a class="button primary" href="/admin/jobs/${job.id}/work-order">Preview work order</a>
    <form action="/admin/jobs/${job.id}/assignment" method="post">
      ${hidden('_csrf', csrf)}${hidden('revision', job.revision)}
      <button class="secondary" name="assignment" value="${assigned ? 'unassign' : 'assign'}">${assigned ? 'Remove assignment' : 'Assign to the technician'}</button>
    </form></div></section>`;
}

export function reviewPage({ job, flags, history, photos, csrf, entered, error, assignTechnician = false }) {
  const editable = ['new', 'review', 'rejected'].includes(job.status);
  return page(job.draft?.title || job.id, `
    <div class="page-heading"><div><a class="back" href="/admin">← Jobs</a><h1>${escape(job.draft?.title || job.id)}</h1>
    <p>${job.draft?.title ? `${escape(job.id)} · ` : ''}${escape(job.original.name)}</p></div>${pill(job.status)}</div>
    ${message(error)}
    <div class="job-layout">
      <aside aria-label="Intake and activity">${requestCard(job, photos)}${flagCard(flags)}${historyCard(history)}</aside>
      <div class="main-column">
        ${editable ? `<section class="panel inset"><h2>OpenAI analysis</h2>
        <p class="hint">${job.ai ? 'Another analysis updates the recommendation and keeps your current draft.' : 'Generate a draft from the repair description and any attached photos, or complete the draft manually.'}</p>
        <form action="/admin/jobs/${job.id}/analyze" method="post">${hidden('_csrf', csrf)}${hidden('revision', job.revision)}
        <button class="secondary">${job.ai ? 'Run analysis again' : 'Analyze request'}</button></form></section>
        ${originalAnalysis(job)}
        ${reviewForm(job, entered || job.draft || { location: job.original.location }, flags, csrf, assignTechnician)}`
          : approvedCard(job, csrf) + originalAnalysis(job)}
        ${customerDrafts(job)}
      </div>
    </div>`, { csrf });
}

function list(value, ordered = false) {
  const items = (value ?? '').split('\n').map(item => item.trim()).filter(Boolean);
  if (!items.length) return '<p class="hint">None listed.</p>';
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}>${items.map(item => `<li>${escape(item)}</li>`).join('')}</${tag}>`;
}

export function workList(jobs, csrf) {
  return page('Work orders', `<div class="page-heading"><h1>Work orders</h1></div>
    <section class="panel queue" aria-label="Assigned work orders">
      ${jobs.length ? `<ul class="job-list">${jobs.map(job =>
        `<li><a href="/technician/jobs/${job.id}">${escape(job.draft.title)}</a>
        <span class="job-meta">${escape(job.id)}</span>${pill(job.status)}</li>`).join('')}</ul>`
        : '<div class="empty"><p>No work orders assigned yet.</p></div>'}
    </section>`, { field: true, csrf });
}

export function workPage(job, csrf, { owner = false, error } = {}) {
  const { draft } = job;
  const back = owner ? `<a class="back" href="/admin/jobs/${job.id}">← Job details</a>`
    : '<a class="back" href="/technician">← Work orders</a>';
  return page('Work order', `
    <div class="work-page"><div class="page-heading"><div>${back}<p class="ref">${escape(job.id)}</p><h1>${escape(draft.title)}</h1></div>${pill(job.status)}</div>
    ${message(error)}
    <section class="panel inset work-detail"><h2>Location</h2>${lines(draft.location)}</section>
    <section class="panel inset work-detail"><h2>What to do</h2>${list(draft.tasks, true)}</section>
    <section class="panel inset work-detail"><h2>What to bring</h2><h3>Tools</h3>${list(draft.tools)}
      <h3>Materials</h3>${list(draft.materials)}</section>
    <section class="panel inset work-detail"><h2>Special instructions</h2>${list(draft.instructions)}</section>
    ${!owner && job.status === 'approved'
      ? `<form class="panel form-panel" action="/technician/jobs/${job.id}/complete" method="post">
      ${hidden('_csrf', csrf)}${hidden('revision', job.revision)}
      <h2>Report completion</h2>${field('What was completed?', 'completionNote', '', { area: 3, required: true, max: 2000 })}
      <button class="primary">Mark work complete</button></form>`
      : job.status === 'completed' ? '<p class="status completed">Completion reported to V</p>' : ''}
    </div>`, { field: !owner, csrf });
}
