(() => {
  'use strict';

  /* ===== Helpers & constants ===== */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const STORE = 'scouter.v1';
  const MAX_RECIPIENTS = 10000, MAX_SUBJECT = 200, MAX_BODY = 2000, PAGE = 100;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const DAY = 86400000;
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const SUBJECT_CHIPS = {
    quick: 'Quick question',
    partner: 'Partnership opportunity',
    offer: 'An exclusive offer for you'
  };
  const BODY_CHIPS = {
    basic: 'Hi {name},\n\nI wanted to introduce myself and share what we do. Do you have a few minutes to talk this week?\n\nBest regards',
    personal: 'Hi {name},\n\nI came across your work and thought we could help each other. I would love to hear more about what you are focused on right now.\n\nBest regards',
    invite: 'Hi {name},\n\nWe are hosting a short session and would be glad to have you join. Reply to this email and I will send the details.\n\nBest regards'
  };
  const BUILT_IN_TEMPLATES = [
    { id: 'followup', name: 'Follow-up Email', category: 'Sales', builtIn: true,
      description: "A gentle follow-up email for prospects who haven't responded.",
      subject: 'Following up',
      body: 'Hi {name},\n\nI am following up on my earlier message. Would you have a few minutes this week to talk?\n\nBest regards' },
    { id: 'offer', name: 'Special Offer', category: 'Marketing', builtIn: true,
      description: 'A promotional email template for special offers and limited-time deals.',
      subject: 'A limited-time offer for you',
      body: 'Hi {name},\n\nWe have a limited-time offer that I think you will like. Reply to this email and I will share the details.\n\nBest regards' }
  ];

  /* ===== State ===== */
  const fresh = () => ({
    emails: [],      // { id, e, n, b, s, t }  e=email n=name b=batch s=sent(0/1) t=sent time
    batches: {},     // batchId -> { subject, body }
    daily: {},       // 'YYYY-MM-DD' -> { g: generated, s: sent }
    sentTimes: [],   // timestamps of sends in the last 24h
    templates: [],   // custom templates
    theme: 'system',
    schedule: { enabled: false, date: '', time: '', fired: false },
    nextId: 1
  });

  let state = load();
  let filter = 'all';
  let range = 'daily';
  let shown = PAGE;
  let nameMap = {};   // names picked up from uploaded CSV rows
  let editingTpl = null;

  function load() {
    try { return Object.assign(fresh(), JSON.parse(localStorage.getItem(STORE) || '{}')); }
    catch (e) { return fresh(); }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); }
    catch (e) { toast('Browser storage is full. Clear old emails.', true); }
  }

  /* ===== Elements ===== */
  const el = {
    recipients: $('#recipients'), subject: $('#subject'), body: $('#body'),
    cValid: $('#cValid'), cInvalid: $('#cInvalid'), cTotal: $('#cTotal'),
    subjectCount: $('#subjectCount'), bodyCount: $('#bodyCount'),
    emailList: $('#emailList'), emptyState: $('#emptyState'), moreBtn: $('#moreBtn'),
    fileInput: $('#fileInput'), fileName: $('#fileName'),
    templateList: $('#templateList'), modal: $('#templateModal'),
    schedEnabled: $('#schedEnabled'), schedDate: $('#schedDate'), schedTime: $('#schedTime'), schedFields: $('#schedFields'),
    toast: $('#toast')
  };

  /* ===== Utilities ===== */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  let toastTimer;
  function toast(msg, isError) {
    el.toast.textContent = msg;
    el.toast.classList.toggle('error', !!isError);
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3200);
  }
  const pad = n => String(n).padStart(2, '0');
  const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const startOfWeek = d => addDays(startOfDay(d), -((d.getDay() + 6) % 7)); // Monday
  const fmtDate = d => `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;

  function nameFromEmail(email) {
    const first = email.split('@')[0].split(/[._\-+0-9]+/).filter(Boolean)[0] || 'there';
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  }

  function parseRecipients(text) {
    const parts = text.split(/[\s,;]+/).filter(Boolean);
    const seen = new Set();
    const valid = [];
    let invalid = 0;
    parts.forEach(p => {
      const e = p.toLowerCase();
      if (EMAIL_RE.test(e)) { if (!seen.has(e)) { seen.add(e); valid.push(e); } }
      else invalid++;
    });
    return { valid, invalid, total: parts.length };
  }

  /* ===== Activity log ===== */
  function bump(kind, n) {
    const k = dayKey(new Date());
    const d = state.daily[k] || (state.daily[k] = { g: 0, s: 0 });
    d[kind] += n;
    if (kind === 's') state.sentTimes.push(Date.now());
    const now = Date.now();
    state.sentTimes = state.sentTimes.filter(t => now - t < DAY);
    // keep roughly 14 months of history
    const cutoff = dayKey(new Date(now - 430 * DAY));
    Object.keys(state.daily).forEach(key => { if (key < cutoff) delete state.daily[key]; });
  }
  function dayTotals(date) {
    return state.daily[dayKey(date)] || { g: 0, s: 0 };
  }
  function rangeTotals(from, days) {
    let g = 0, s = 0;
    for (let i = 0; i < days; i++) {
      const t = dayTotals(addDays(from, i));
      g += t.g; s += t.s;
    }
    return { g, s };
  }
  function monthTotals(year, month) {
    const prefix = `${year}-${pad(month + 1)}-`;
    let g = 0, s = 0;
    Object.keys(state.daily).forEach(k => {
      if (k.startsWith(prefix)) { g += state.daily[k].g; s += state.daily[k].s; }
    });
    return { g, s };
  }

  /* ===== Form: counters & chips ===== */
  function updateCounts() {
    const r = parseRecipients(el.recipients.value);
    el.cValid.textContent = r.valid.length;
    el.cInvalid.textContent = r.invalid;
    el.cTotal.textContent = r.total;
    el.subjectCount.textContent = el.subject.value.length;
    el.bodyCount.textContent = el.body.value.length;
  }
  ['input', 'change'].forEach(ev => {
    el.recipients.addEventListener(ev, updateCounts);
    el.subject.addEventListener(ev, updateCounts);
    el.body.addEventListener(ev, updateCounts);
  });

  $$('.chips .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const target = chip.parentElement.dataset.target;
      if (target === 'subject') el.subject.value = SUBJECT_CHIPS[chip.dataset.chip];
      else el.body.value = BODY_CHIPS[chip.dataset.chip];
      updateCounts();
    });
  });

  /* ===== Generate ===== */
  $('#generateBtn').addEventListener('click', () => {
    const { valid } = parseRecipients(el.recipients.value);
    const subject = el.subject.value.trim();
    const body = el.body.value.trim();
    if (!valid.length) return toast('Add at least one valid email address.', true);
    if (valid.length > MAX_RECIPIENTS) return toast('Maximum is 10,000 recipients per batch.', true);
    if (!subject) return toast('Enter a subject line.', true);
    if (subject.length > MAX_SUBJECT) return toast('Subject is over 200 characters.', true);
    if (!body) return toast('Enter a message body.', true);
    if (body.length > MAX_BODY) return toast('Message is over 2000 characters.', true);

    const batchId = 'b' + Date.now();
    state.batches[batchId] = { subject, body };
    valid.forEach(e => {
      state.emails.push({ id: state.nextId++, e, n: nameMap[e] || nameFromEmail(e), b: batchId, s: 0, t: 0 });
    });
    bump('g', valid.length);
    if (state.schedule.enabled) state.schedule.fired = false;
    save();
    nameMap = {};
    el.recipients.value = '';
    updateCounts();
    filter = 'all';
    shown = PAGE;
    renderAll();
    toast(`${valid.length} email${valid.length === 1 ? '' : 's'} generated.`);
    $('#generatedSection').scrollIntoView();
  });

  /* ===== Upload CSV / TXT ===== */
  $('#chooseBtn').addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => {
    el.fileName.textContent = el.fileInput.files[0] ? el.fileInput.files[0].name : 'No file selected';
  });
  $('#uploadBtn').addEventListener('click', () => {
    const file = el.fileInput.files[0];
    if (!file) return toast('Choose a CSV or TXT file first.', true);
    if (file.size > 5 * 1024 * 1024) return toast('File is too large. Split it into smaller parts.', true);
    const reader = new FileReader();
    reader.onload = () => {
      const found = [];
      String(reader.result).split(/\r?\n/).forEach(line => {
        const cells = line.split(/[,;\t]/).map(c => c.trim().replace(/^"|"$/g, ''));
        const emailCell = cells.find(c => EMAIL_RE.test(c.toLowerCase()));
        if (!emailCell) return;
        const e = emailCell.toLowerCase();
        found.push(e);
        const nameCell = cells.find(c => c && c !== emailCell && !/@/.test(c) && /^[A-Za-z][A-Za-z .'-]*$/.test(c));
        if (nameCell) nameMap[e] = nameCell.split(' ')[0];
      });
      if (!found.length) return toast('No email addresses found in that file.', true);
      const existing = el.recipients.value.trim();
      const merged = (existing ? existing + '\n' : '') + found.join('\n');
      const r = parseRecipients(merged);
      if (r.valid.length > MAX_RECIPIENTS) {
        return toast('That would go over 10,000 recipients. Use a smaller file.', true);
      }
      el.recipients.value = merged;
      updateCounts();
      toast(`${found.length} addresses added to the form.`);
      $('#formSection').scrollIntoView();
    };
    reader.onerror = () => toast('Could not read that file.', true);
    reader.readAsText(file);
  });

  /* ===== Templates ===== */
  function allTemplates() { return BUILT_IN_TEMPLATES.concat(state.templates); }
  function renderTemplates() {
    el.templateList.innerHTML = allTemplates().map(t => `
      <div class="tpl">
        <div>
          <h5>${esc(t.name)}<span class="tag">${esc(t.category)}</span></h5>
          <p>${esc(t.description || t.subject)}</p>
        </div>
        <div class="tpl-actions">
          <button type="button" class="btn small primary" data-use="${t.id}">Use Template</button>
          ${t.builtIn ? '' : `<button type="button" class="btn small danger" data-del="${t.id}">Delete</button>`}
        </div>
      </div>`).join('');
  }
  el.templateList.addEventListener('click', ev => {
    const use = ev.target.closest('[data-use]');
    const del = ev.target.closest('[data-del]');
    if (use) {
      const t = allTemplates().find(x => x.id === use.dataset.use);
      if (!t) return;
      el.subject.value = t.subject;
      el.body.value = t.body;
      updateCounts();
      toast(`"${t.name}" loaded.`);
      $('#formSection').scrollIntoView();
    }
    if (del) {
      state.templates = state.templates.filter(x => x.id !== del.dataset.del);
      save(); renderTemplates();
      toast('Template deleted.');
    }
  });
  function openModal() {
    ['tplName', 'tplSubject', 'tplBody'].forEach(id => { $('#' + id).value = ''; });
    el.modal.hidden = false;
    $('#tplName').focus();
  }
  function closeModal() { el.modal.hidden = true; }
  $('#newTemplateBtn').addEventListener('click', openModal);
  $('#tplCancel').addEventListener('click', closeModal);
  el.modal.addEventListener('click', ev => { if (ev.target === el.modal) closeModal(); });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !el.modal.hidden) closeModal(); });
  $('#tplSave').addEventListener('click', () => {
    const name = $('#tplName').value.trim();
    const subject = $('#tplSubject').value.trim();
    const body = $('#tplBody').value.trim();
    if (!name || !subject || !body) return toast('Fill in the name, subject and body.', true);
    state.templates.push({
      id: 'c' + Date.now(), name, subject, body,
      category: $('#tplCategory').value, description: subject
    });
    save(); renderTemplates(); closeModal();
    toast('Template saved.');
  });

  /* ===== Schedule ===== */
  function renderSchedule() {
    el.schedEnabled.checked = state.schedule.enabled;
    el.schedDate.value = state.schedule.date;
    el.schedTime.value = state.schedule.time;
    el.schedFields.classList.toggle('off', !state.schedule.enabled);
  }
  el.schedEnabled.addEventListener('change', () => {
    state.schedule.enabled = el.schedEnabled.checked;
    state.schedule.fired = false;
    if (state.schedule.enabled && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    save(); renderSchedule();
  });
  el.schedDate.addEventListener('change', () => { state.schedule.date = el.schedDate.value; state.schedule.fired = false; save(); });
  el.schedTime.addEventListener('change', () => { state.schedule.time = el.schedTime.value; state.schedule.fired = false; save(); });

  function checkSchedule() {
    const s = state.schedule;
    if (!s.enabled || s.fired || !s.date || !s.time) return;
    if (new Date(`${s.date}T${s.time}`).getTime() > Date.now()) return;
    const pending = state.emails.filter(m => !m.s).length;
    if (!pending) return;
    s.fired = true;
    save();
    const msg = `Scheduled time reached. ${pending} email${pending === 1 ? ' is' : 's are'} ready to send.`;
    toast(msg);
    if ('Notification' in window && Notification.permission === 'granted') new Notification('Scouter', { body: msg });
    filter = 'pending';
    renderAll();
    $('#generatedSection').scrollIntoView();
  }
  setInterval(checkSchedule, 15000);

  /* ===== Generated emails list ===== */
  function mailtoFor(m) {
    const b = state.batches[m.b] || { subject: '', body: '' };
    const subject = b.subject.replace(/\{name\}/gi, m.n);
    const body = b.body.replace(/\{name\}/gi, m.n);
    return `mailto:${m.e}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }
  function visibleEmails() {
    return state.emails.filter(m => filter === 'all' || (filter === 'sent' ? m.s : !m.s));
  }
  function renderList() {
    const list = visibleEmails();
    const slice = list.slice(0, shown);
    el.emailList.innerHTML = slice.map(m => `
      <a class="email-item ${m.s ? 'clicked' : ''}" href="${esc(mailtoFor(m))}" data-id="${m.id}">
        <span class="avatar">${esc(m.e.charAt(0).toUpperCase())}</span>
        <span class="email-main"><b>${esc(m.e)}</b><span>${esc(m.n)}</span></span>
        <span class="badge">${m.s ? 'Sent' : 'Pending'}</span>
      </a>`).join('');
    el.emptyState.hidden = list.length > 0;
    if (!list.length && state.emails.length) {
      el.emptyState.querySelector('h3').textContent = `No ${filter} emails`;
    } else {
      el.emptyState.querySelector('h3').textContent = 'No Emails Generated';
    }
    el.moreBtn.hidden = list.length <= shown;
    if (!el.moreBtn.hidden) el.moreBtn.textContent = `Show more (${list.length - shown} left)`;
  }
  el.emailList.addEventListener('click', ev => {
    const a = ev.target.closest('.email-item');
    if (!a) return;
    const m = state.emails.find(x => x.id === Number(a.dataset.id));
    if (!m || m.s) return;
    m.s = 1; m.t = Date.now();
    bump('s', 1);
    save();
    setTimeout(renderAll, 0); // let the mail app open first
  });
  el.moreBtn.addEventListener('click', () => { shown += PAGE; renderList(); });
  $('#filterSeg').addEventListener('click', ev => {
    const b = ev.target.closest('button');
    if (!b) return;
    filter = b.dataset.filter;
    shown = PAGE;
    $$('#filterSeg button').forEach(x => x.classList.toggle('active', x === b));
    renderList();
  });
  $('#gotoFormBtn').addEventListener('click', () => { $('#formSection').scrollIntoView(); el.recipients.focus(); });

  /* ===== Stats & analytics ===== */
  function renderStats() {
    const total = state.emails.length;
    const sent = state.emails.filter(m => m.s).length;
    const rem = total - sent;
    const pct = total ? Math.round((sent / total) * 100) : 0;
    const now = Date.now();
    const sent24 = state.sentTimes.filter(t => now - t < DAY).length;

    $('#topSent').textContent = sent;
    $('#topPending').textContent = rem;
    $('#stSent').textContent = sent;
    $('#stRemaining').textContent = rem;
    $('#stTotal').textContent = total;
    $('#st24h').textContent = sent24;
    $('#progressBar').style.width = pct + '%';
    $('#progressText').textContent = pct;
    $('#anSent').textContent = sent;
    $('#anRem').textContent = rem;
    $('#donutText').textContent = pct + '%';
    $('#donut').style.background = total
      ? `conic-gradient(var(--accent) 0 ${pct}%, var(--line) ${pct}% 100%)`
      : 'var(--line)';

    const counts = {};
    state.emails.forEach(m => { const d = m.e.split('@')[1]; counts[d] = (counts[d] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    $('#domainList').innerHTML = top.length
      ? top.map(([d, n]) => `
          <div class="domain-row"><span>${esc(d)}</span><b>${n}</b>
          <div class="meter"><i style="width:${Math.round((n / top[0][1]) * 100)}%"></i></div></div>`).join('')
      : '<p class="muted">No data available</p>';
  }
  $('#clearBtn').addEventListener('click', () => {
    if (!state.emails.length) return toast('Nothing to clear.');
    if (!confirm('Clear all generated emails? Your activity history is kept.')) return;
    state.emails = []; state.batches = {};
    save(); shown = PAGE; renderAll();
    toast('Generated emails cleared.');
  });

  /* ===== Activity (daily / weekly / monthly) ===== */
  function activityRows() {
    const today = startOfDay(new Date());
    const rows = [];
    if (range === 'daily') {
      for (let i = 0; i < 7; i++) {
        const d = addDays(today, -i);
        const label = i === 0 ? 'Today' : i === 1 ? 'Yesterday' : i === 2 ? 'Day before yesterday' : WEEKDAYS[d.getDay()];
        rows.push({ label, sub: fmtDate(d), ...dayTotals(d) });
      }
    } else if (range === 'weekly') {
      const monday = startOfWeek(today);
      for (let i = 0; i < 8; i++) {
        const from = addDays(monday, -7 * i);
        const label = i === 0 ? 'This week' : i === 1 ? 'Last week' : `${i} weeks ago`;
        rows.push({ label, sub: `${fmtDate(from)} - ${fmtDate(addDays(from, 6))}`, ...rangeTotals(from, 7) });
      }
    } else {
      for (let i = 0; i < 12; i++) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const label = i === 0 ? 'This month' : i === 1 ? 'Last month' : MONTHS[d.getMonth()];
        rows.push({ label, sub: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, ...monthTotals(d.getFullYear(), d.getMonth()) });
      }
    }
    return rows;
  }
  function renderActivity() {
    const today = startOfDay(new Date());
    $('#actToday').textContent = dayTotals(today).s;
    $('#actWeek').textContent = rangeTotals(startOfWeek(today), 7).s;
    $('#actMonth').textContent = monthTotals(today.getFullYear(), today.getMonth()).s;

    const rows = activityRows();
    const max = Math.max(1, ...rows.map(r => Math.max(r.s, r.g)));
    $('#activityList').innerHTML = rows.map(r => `
      <div class="act-row">
        <div class="act-label">${esc(r.label)}<small>${esc(r.sub)}</small></div>
        <div class="act-bars">
          <i class="s" style="width:${(r.s / max) * 100}%"></i>
          <i class="g" style="width:${(r.g / max) * 100}%"></i>
        </div>
        <div class="act-num"><b>${r.s}</b> sent<br>${r.g} generated</div>
      </div>`).join('');
  }
  $('#activitySeg').addEventListener('click', ev => {
    const b = ev.target.closest('button');
    if (!b) return;
    range = b.dataset.range;
    $$('#activitySeg button').forEach(x => x.classList.toggle('active', x === b));
    renderActivity();
  });

  /* ===== Theme ===== */
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const resolved = state.theme === 'system' ? (darkQuery.matches ? 'dark' : 'light') : state.theme;
    document.documentElement.dataset.resolved = resolved;
    $$('#themeSeg button').forEach(b => b.classList.toggle('active', b.dataset.theme === state.theme));
  }
  $('#themeSeg').addEventListener('click', ev => {
    const b = ev.target.closest('button');
    if (!b) return;
    state.theme = b.dataset.theme;
    save(); applyTheme();
  });
  darkQuery.addEventListener('change', applyTheme);

  /* ===== Boot ===== */
  function renderAll() {
    renderStats();
    renderList();
    renderActivity();
  }
  $('#year').textContent = new Date().getFullYear();
  applyTheme();
  renderTemplates();
  renderSchedule();
  updateCounts();
  renderAll();
  checkSchedule();
  // refresh "today / yesterday" labels if the page stays open past midnight
  setInterval(renderActivity, 60000);
})();
