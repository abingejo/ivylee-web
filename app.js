// Ivy Lee Planner on the web: adds tasks and notes for the phone.
//
// The page talks only to Google (sign-in and Drive) - no server of its own
// and nothing that does AI, so an office network's AI blocking has nothing
// to stop. Each task or note is written as one small file in the app's
// hidden Drive folder (the one the phone backs up to); the app takes it in
// the next time it opens and deletes it (src/components/WebInbox.js).
// The phone's last backup is read, never written, for its categories,
// labels and lists.
'use strict';

const CLIENT_ID = '834966505149-b2rpkqu7644jjm5rrl64aqidt0425glu.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const BACKUP_FILE = 'ivylee-backup.json';
const INBOX_PREFIX = 'ivylee-inbox-';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const HINT_KEY = 'ivylee-web-signed-in';

const $ = (id) => document.getElementById(id);
const state = {
  token: null,
  expiresAt: 0,
  client: null,
  categories: [],
  labels: [],
  tasks: [],
  notes: [],
  day: 'today',
  minutes: 30,
  noteKind: 'text',
  view: 'tasks',
};

// ---- Sign-in -------------------------------------------------------------

let pendingToken = null;
function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    pendingToken = { resolve, reject };
    state.client.requestAccessToken({ prompt });
  });
}

function initClient() {
  state.client = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: (res) => {
      const p = pendingToken;
      pendingToken = null;
      if (res.error || !google.accounts.oauth2.hasGrantedAllScopes(res, SCOPE)) {
        p?.reject(new Error(res.error === 'access_denied' || !res.error ? 'Drive permission was not given.' : res.error_description || res.error));
        return;
      }
      state.token = res.access_token;
      state.expiresAt = Date.now() + (Number(res.expires_in) || 3600) * 1000;
      p?.resolve(state.token);
    },
    error_callback: (err) => {
      const p = pendingToken;
      pendingToken = null;
      p?.reject(new Error(err?.type === 'popup_closed' ? 'Sign-in was closed.' : 'Sign-in could not open - allow pop-ups for this page.'));
    },
  });
}

async function token() {
  if (state.token && Date.now() < state.expiresAt - 60 * 1000) return state.token;
  return requestToken('');
}

async function signIn(prompt) {
  $('signinError').hidden = true;
  try {
    await requestToken(prompt);
    localStorage.setItem(HINT_KEY, '1');
    $('welcome').hidden = true;
    $('app').hidden = false;
    $('signout').hidden = false;
    await Promise.all([loadBackup(), loadPending()]);
  } catch (e) {
    $('signinError').textContent = e.message;
    $('signinError').hidden = false;
  }
}

function signOut() {
  if (state.token) google.accounts.oauth2.revoke(state.token, () => {});
  state.token = null;
  localStorage.removeItem(HINT_KEY);
  location.reload();
}

// ---- Drive ---------------------------------------------------------------

async function drive(url, opts = {}) {
  const send = async () => fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${await token()}` } });
  let res = await send();
  if (res.status === 401) {
    state.token = null;
    res = await send();
  }
  if (!res.ok && !(opts.method === 'DELETE' && res.status === 404)) {
    let reason = '';
    try {
      reason = (await res.json())?.error?.message || '';
    } catch (e) {
      /* not JSON */
    }
    throw new Error(`Google Drive said ${res.status}${reason ? `: ${reason}` : ''}`);
  }
  return res;
}

async function listFiles(q, extra = '') {
  const res = await drive(`${DRIVE}/files?spaces=appDataFolder&fields=files(id,name,createdTime,modifiedTime)&pageSize=100${extra}&q=${encodeURIComponent(q)}`);
  return (await res.json()).files || [];
}

const readFile = async (id) => (await drive(`${DRIVE}/files/${id}?alt=media`)).json();

async function createInboxFile(item) {
  const boundary = `ivylee${Date.now()}`;
  const meta = { name: `${INBOX_PREFIX}${item.id}.json`, parents: ['appDataFolder'] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(item)}\r\n--${boundary}--`;
  await drive(`${UPLOAD}/files?uploadType=multipart`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
}

// ---- What the phone has (its last backup) -------------------------------

const parse = (raw, fallback) => {
  try {
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch (e) {
    return fallback;
  }
};

async function loadBackup() {
  const files = await listFiles(`name='${BACKUP_FILE}'`);
  if (!files.length) {
    $('synced').textContent = 'No backup from the phone yet';
    fillSelects();
    renderPhone();
    return;
  }
  const snap = await readFile(files[0].id);
  const data = snap?.data || {};
  state.categories = parse(data['@ivylee/categories'], []);
  state.labels = parse(data['@ivylee/noteLabels'], []);
  state.tasks = parse(data['@ivylee/tasks'], []);
  state.notes = parse(data['@ivylee/notebook'], []);
  const at = snap.updatedAt ? new Date(snap.updatedAt) : null;
  $('synced').textContent = at ? `Phone last backed up ${when(at)}` : '';
  $('asOf').textContent = at ? `· as of ${when(at)}` : '';
  fillSelects();
  renderPhone();
}

function fillSelects() {
  const cat = $('taskCategory');
  const kept = localStorage.getItem('ivylee-web-category');
  cat.innerHTML = '';
  (state.categories.length ? state.categories : [{ id: '', name: 'First category on the phone' }]).forEach((c) => cat.add(new Option(c.name, c.id)));
  if (kept && state.categories.some((c) => c.id === kept)) cat.value = kept;
  const lab = $('noteLabel');
  lab.innerHTML = '';
  lab.add(new Option('No label', ''));
  state.labels.forEach((l) => lab.add(new Option(l.name, l.id)));
}

function renderPhone() {
  const ul = $('phoneList');
  ul.innerHTML = '';
  if (state.view === 'tasks') {
    const open = state.tasks
      .filter((t) => !t.completed && !t.dayViewOnly)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 40);
    if (!open.length) return empty(ul, 'No open tasks in the last backup.');
    open.forEach((t) => {
      const cat = state.categories.find((c) => c.id === t.categoryId);
      const bits = [cat?.name, t.schedule?.date ? dayWords(t.schedule.date) : null, t.schedule?.time ? clock(t.schedule.time) : null].filter(Boolean);
      ul.append(row(t.text, bits.join(' · ')));
    });
  } else {
    const notes = [...state.notes].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 40);
    if (!notes.length) return empty(ul, 'No notes in the last backup.');
    notes.forEach((n) => {
      const label = state.labels.find((l) => l.id === n.labelId);
      const preview = n.kind === 'list' ? (n.items || []).filter((i) => !i.done).map((i) => i.text).slice(0, 3).join(' · ') : (n.body || '').slice(0, 140);
      ul.append(row(n.title || preview.split('\n')[0] || 'Untitled', [label?.name, n.title ? preview : ''].filter(Boolean).join(' · ')));
    });
  }
}

// ---- On its way to the phone --------------------------------------------

async function loadPending() {
  const ul = $('pending');
  const files = await listFiles(`name contains '${INBOX_PREFIX}'`, '&orderBy=createdTime');
  ul.innerHTML = '';
  if (!files.length) return empty(ul, 'Nothing waiting.');
  const items = await Promise.all(files.map((f) => readFile(f.id).catch(() => null)));
  files.forEach((f, i) => {
    const it = items[i];
    if (!it) return;
    const name = it.kind === 'task' ? it.text : it.title || (it.body || (it.items || [])[0] || 'Note').split('\n')[0];
    const li = row(name, `${it.kind === 'task' ? 'Task' : 'Note'} · added ${when(new Date(it.createdAt))}`);
    const x = document.createElement('button');
    x.className = 'x';
    x.title = 'Remove before it reaches the phone';
    x.textContent = '×';
    x.onclick = async () => {
      if (!(await confirmRemove(`Remove "${name}"? It won't reach your phone.`))) return;
      try {
        await drive(`${DRIVE}/files/${f.id}`, { method: 'DELETE' });
        loadPending();
      } catch (e) {
        say(e.message, true);
      }
    };
    li.append(x);
    ul.append(li);
  });
}

// ---- Forms ----------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function taskDate() {
  const d = new Date();
  if (state.day === 'today') return keyOf(d);
  if (state.day === 'tomorrow') return keyOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
  if (state.day === 'custom') return $('taskDate').value || null;
  return null;
}

function minutesChosen() {
  const typed = parseInt($('taskMinutes').value, 10);
  return Number.isFinite(typed) && typed > 0 ? Math.min(typed, 1440) : state.minutes;
}

const BOXES = { '11': 'Do First', '01': 'Schedule', '10': 'Delegate', '00': 'Delete' };
function refreshTask() {
  const u = $('taskUrgent').checked;
  const i = $('taskImportant').checked;
  $('matrixBox').textContent = `Matrix box: ${BOXES[`${+u}${+i}`]}`;
  $('taskDate').hidden = state.day !== 'custom';
  $('timeField').hidden = state.day === 'none';
  const date = taskDate();
  const time = date ? $('taskTime').value : '';
  const len = lengthWords(minutesChosen());
  const cat = $('taskCategory').selectedOptions[0]?.textContent || '';
  $('taskTicket').textContent = [date ? dayWords(date) : 'No date', time ? clock(time) : null, len, BOXES[`${+u}${+i}`], cat, $('taskBigPush').checked ? 'Big push' : null]
    .filter(Boolean)
    .join(' · ');
}

async function submitTask(e) {
  e.preventDefault();
  const text = $('taskName').value.trim();
  if (!text) return;
  if (state.day === 'custom' && !$('taskDate').value) return say('Pick a date, or choose another day.', true);
  const date = taskDate();
  const item = {
    v: 1,
    kind: 'task',
    id: newId(),
    createdAt: new Date().toISOString(),
    text,
    categoryId: $('taskCategory').value || null,
    urgent: $('taskUrgent').checked,
    important: $('taskImportant').checked,
    bigPush: $('taskBigPush').checked,
    date,
    time: date && $('taskTime').value ? $('taskTime').value : null,
    minutes: minutesChosen(),
    subtasks: $('taskSubtasks').value.split('\n').map((s) => s.trim()).filter(Boolean),
  };
  await send(item, `Task added - "${text}" will be on your phone the next time the app opens.`, () => {
    $('taskName').value = '';
    $('taskSubtasks').value = '';
    $('taskTime').value = '';
    ['taskUrgent', 'taskImportant', 'taskBigPush'].forEach((id) => ($(id).checked = false));
    refreshTask();
    $('taskName').focus();
  });
}

async function submitNote(e) {
  e.preventDefault();
  const title = $('noteTitle').value.trim();
  const raw = $('noteBody').value;
  const list = state.noteKind === 'list';
  const items = list ? raw.split('\n').map((s) => s.replace(/^\s*([-*•]|\[ ?\])\s*/, '').trim()).filter(Boolean) : [];
  if (!title && !raw.trim()) return say('Write something first.', true);
  const item = {
    v: 1,
    kind: 'note',
    id: newId(),
    createdAt: new Date().toISOString(),
    noteKind: list ? 'list' : 'text',
    title,
    body: list ? '' : raw,
    items,
    labelId: $('noteLabel').value || null,
  };
  await send(item, 'Note added - it will be in Notes on your phone the next time the app opens.', () => {
    $('noteTitle').value = '';
    $('noteBody').value = '';
  });
}

async function send(item, done, reset) {
  const buttons = document.querySelectorAll('button.primary');
  buttons.forEach((b) => (b.disabled = true));
  say('Adding…');
  try {
    await createInboxFile(item);
    say(done);
    reset();
    loadPending();
  } catch (err) {
    say(`Not added: ${err.message}`, true);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

// ---- Small things ---------------------------------------------------------

function say(text, bad) {
  const s = $('status');
  s.textContent = text;
  s.classList.toggle('error', !!bad);
}

function row(title, sub) {
  const li = document.createElement('li');
  const box = document.createElement('div');
  const t = document.createElement('div');
  t.className = 'name';
  t.textContent = title;
  box.append(t);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'muted small';
    s.textContent = sub;
    box.append(s);
  }
  li.append(box);
  return li;
}

function empty(ul, text) {
  const li = document.createElement('li');
  li.className = 'muted small';
  li.textContent = text;
  ul.append(li);
}

function clock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

function dayWords(key) {
  const today = keyOf(new Date());
  const t = new Date();
  const tomorrow = keyOf(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1));
  if (key === today) return 'Today';
  if (key === tomorrow) return 'Tomorrow';
  return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function lengthWords(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m} min`;
}

function when(d) {
  const day = dayWords(keyOf(d));
  return `${day === 'Today' ? 'today' : day === 'Tomorrow' ? 'tomorrow' : day}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function confirmRemove(text) {
  const dlg = $('confirm');
  $('confirmText').textContent = text;
  dlg.showModal();
  return new Promise((resolve) => {
    $('confirmYes').onclick = () => (dlg.close(), resolve(true));
    $('confirmNo').onclick = () => (dlg.close(), resolve(false));
    dlg.oncancel = () => resolve(false);
  });
}

function chips(containerId, attr, onPick) {
  $(containerId).addEventListener('click', (e) => {
    const b = e.target.closest(`button[${attr}]`);
    if (!b) return;
    $(containerId).querySelectorAll(`button[${attr}]`).forEach((x) => x.classList.toggle('on', x === b));
    onPick(b.getAttribute(attr), b);
  });
}

// ---- Wiring ---------------------------------------------------------------

function wire() {
  $('signin').onclick = () => signIn(localStorage.getItem(HINT_KEY) ? '' : 'consent');
  $('signout').onclick = signOut;

  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === b));
    $('taskForm').hidden = b.dataset.tab !== 'task';
    $('noteForm').hidden = b.dataset.tab !== 'note';
    say('');
  });

  chips('dayChips', 'data-day', (day) => {
    state.day = day;
    refreshTask();
  });
  chips('lengthChips', 'data-min', (m) => {
    state.minutes = Number(m);
    $('taskMinutes').value = '';
    refreshTask();
  });
  $('taskMinutes').addEventListener('input', () => {
    $('lengthChips').querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', !$('taskMinutes').value && Number(x.dataset.min) === state.minutes));
    refreshTask();
  });
  ['taskUrgent', 'taskImportant', 'taskBigPush', 'taskTime', 'taskDate'].forEach((id) => $(id).addEventListener('change', refreshTask));
  $('taskCategory').addEventListener('change', () => {
    localStorage.setItem('ivylee-web-category', $('taskCategory').value);
    refreshTask();
  });
  $('taskForm').addEventListener('submit', submitTask);

  document.querySelector('#noteForm .chips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    document.querySelectorAll('#noteForm .chips button').forEach((x) => x.classList.toggle('on', x === b));
    state.noteKind = b.dataset.kind;
    $('noteBody').placeholder = state.noteKind === 'list' ? 'One item per line' : 'Write it down…';
  });
  $('noteForm').addEventListener('submit', submitNote);

  document.querySelector('#app > section.card:last-child .chips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    state.view = b.dataset.view;
    renderPhone();
  });

  // Back to the page after a while: what the phone took in has gone.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.token && Date.now() < state.expiresAt - 60 * 1000) loadPending().catch(() => {});
  });

  refreshTask();
}

window.addEventListener('load', () => {
  wire();
  const ready = () => {
    if (!window.google?.accounts?.oauth2) return setTimeout(ready, 100);
    initClient();
  };
  ready();
});
