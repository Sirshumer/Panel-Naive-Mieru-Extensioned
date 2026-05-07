/**
 * Panel Naive + Mieru — Frontend Application v1.2.3
 * Bug 1 fix: ALL inline event handlers removed; wired via delegated addEventListener
 * Bug 10 fix: 401 auto-redirect to login; toast on every API error
 * v1.2.3: probe-secret setting, disabled-button+spinner on all submit handlers,
 *         dashboard shows caddy-naive version label, config version bump
 */
'use strict';

// ══════════════════════════════════════════════════════════════
// I18N SYSTEM
// ══════════════════════════════════════════════════════════════

const SUPPORTED_LANGS = ['ru', 'en'];
let locale = {};

async function loadLocale(lang) {
  try {
    const res = await fetch(`/locales/${lang}.json`);
    if (!res.ok) throw new Error('locale not found');
    locale = await res.json();
  } catch {
    locale = {};
  }
}

function t(key, vars) {
  const parts = key.split('.');
  let val = locale;
  for (const p of parts) {
    val = val?.[p];
    if (val === undefined) return key;
  }
  if (typeof val !== 'string') return key;
  if (vars) {
    Object.entries(vars).forEach(([k, v]) => {
      val = val.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    });
  }
  return val;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const translated = t(key);
    if (translated !== key) el.textContent = translated;
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const key = el.getAttribute('data-i18n-ph');
    const translated = t(key);
    if (translated !== key) el.placeholder = translated;
  });
  document.documentElement.lang = currentLang;
  const label = currentLang.toUpperCase();
  ['login-lang-btn', 'topbar-lang-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.textContent = label;
  });
}

// ══════════════════════════════════════════════════════════════
// THEME SYSTEM
// ══════════════════════════════════════════════════════════════

const MOON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
</svg>`;
const SUN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <circle cx="12" cy="12" r="5"/>
  <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
  <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
</svg>`;

let currentTheme = 'dark';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const isDark = theme === 'dark';
  const iconHtml = isDark ? SUN_SVG : MOON_SVG;
  ['login-theme-btn', 'topbar-theme-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.innerHTML = iconHtml;
  });
  localStorage.setItem('rixxx-theme', theme);
}

function toggleTheme() {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

// ══════════════════════════════════════════════════════════════
// LANGUAGE SWITCHING
// ══════════════════════════════════════════════════════════════

let currentLang = 'ru';

async function setLang(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) lang = 'ru';
  currentLang = lang;
  await loadLocale(lang);
  applyI18n();
  if (state.authenticated) {
    const titles = buildTitles();
    const titleEl = document.getElementById('topbar-title');
    if (titleEl) titleEl.textContent = titles[state.currentPage] || state.currentPage;
    navigateTo(state.currentPage);
  }
  localStorage.setItem('rixxx-lang', lang);
}

async function cycleLang() {
  const idx = SUPPORTED_LANGS.indexOf(currentLang);
  const next = SUPPORTED_LANGS[(idx + 1) % SUPPORTED_LANGS.length];
  await setLang(next);
}

function buildTitles() {
  return {
    dashboard:   t('nav.dashboard'),
    users:       t('nav.users'),
    settings:    t('nav.settings'),
    monitoring:  t('nav.monitoring'),
    logs:        t('nav.logs'),
    diagnostics: t('nav.diagnostics'),
  };
}

// ══════════════════════════════════════════════════════════════
// APP STATE
// ══════════════════════════════════════════════════════════════

const state = {
  authenticated: false,
  username: '',
  config: {},
  users: [],
  currentPage: 'dashboard',
  ws: null,
  wsReconnectTimer: null,
  selectedUserId: null,
};

let currentLogService = 'caddy';

// ══════════════════════════════════════════════════════════════
// INIT — wire ALL event listeners here (Bug 1: no inline handlers)
// ══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  // Restore persisted preferences FIRST
  const savedTheme = localStorage.getItem('rixxx-theme') || 'dark';
  const savedLang  = localStorage.getItem('rixxx-lang')  || 'ru';

  applyTheme(savedTheme);
  await setLang(savedLang);

  // ── Delegated click handler (Bug 1) ──────────────────────────
  document.addEventListener('click', handleDelegatedClick);

  // ── Log-lines select change (Bug 1: was onchange inline) ─────
  document.getElementById('log-lines')?.addEventListener('change', () => {
    loadLogs(currentLogService);
  });

  // ── Login form ────────────────────────────────────────────────
  document.getElementById('login-form').addEventListener('submit', handleLogin);

  // ── Sidebar navigation ────────────────────────────────────────
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      navigateTo(el.dataset.page);
    });
  });

  // ── Check existing session ────────────────────────────────────
  fetch('/api/me')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data && data.authenticated) {
        state.authenticated = true;
        state.username = data.username;
        enterApp();
      }
    })
    .catch(() => {});
});

/**
 * Central delegated click dispatcher — handles ALL data-action buttons
 * This replaces every inline onclick="..." in the HTML (Bug 1 fix)
 */
function handleDelegatedClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  switch (action) {
    // ── Global controls
    case 'toggle-pw':        togglePw(btn.dataset.target); break;
    case 'cycle-lang':       cycleLang(); break;
    case 'toggle-theme':     toggleTheme(); break;

    // ── Auth
    case 'logout':           logout(); break;

    // ── Sidebar toggle (mobile)
    case 'toggle-sidebar':   toggleSidebar(); break;

    // ── Users page
    case 'open-add-user':    openAddUser(); break;
    case 'close-user-modal': closeUserModal(); break;
    case 'save-user':        saveUser(); break;
    case 'edit-user':        openEditUser(btn.dataset.id); break;
    case 'delete-user':      deleteUser(btn.dataset.id, btn.dataset.username); break;
    case 'open-config':      openConfigDownload(btn.dataset.id); break;
    case 'close-config-modal': closeConfigModal(); break;
    case 'dl-naive-link':    downloadNaiveLink(); break;
    case 'dl-mieru-config':  downloadMieruConfig(); break;
    case 'dl-universal-config': downloadUniversalConfig(); break;

    // ── Dashboard service buttons
    case 'svc':              svcAction(btn.dataset.svc, btn.dataset.svcAction); break;

    // ── Settings page
    case 'change-naive-port':    changeNaivePort(); break;
    case 'change-mieru-ports':   changeMieruPorts(); break;
    case 'change-traffic-pattern': changeTrafficPattern(); break;
    case 'change-udp-mode':      changeUdpMode(); break;
    case 'change-language':      changeLanguage(); break;
    case 'change-password':      changePassword(); break;
    case 'change-probe-secret':  changeProbeSecret(); break;

    // ── Monitoring
    case 'refresh-stats':    refreshStats(); break;

    // ── Logs
    case 'load-logs':        loadLogs(btn.dataset.logSvc); break;
    case 'refresh-logs':     loadLogs(currentLogService); break;

    // ── Diagnostics
    case 'run-diagnostics':  runDiagnostics(); break;

    // ── Login / topbar lang + theme (also wired via data-action on the buttons)
    case 'lang':             cycleLang(); break;
    case 'theme':            toggleTheme(); break;
  }
}

// Wire lang + theme buttons via data-action (added as fallback; buttons already
// have data-action so the delegated handler above covers them too)
document.addEventListener('DOMContentLoaded', () => {
  ['login-lang-btn', 'topbar-lang-btn'].forEach(id => {
    document.getElementById(id)?.setAttribute('data-action', 'cycle-lang');
  });
  ['login-theme-btn', 'topbar-theme-btn'].forEach(id => {
    document.getElementById(id)?.setAttribute('data-action', 'toggle-theme');
  });
  document.getElementById('btn-logout')    ?.setAttribute('data-action', 'logout');
  document.getElementById('menu-toggle')   ?.setAttribute('data-action', 'toggle-sidebar');
});

// ══════════════════════════════════════════════════════════════
// LOGIN
// ══════════════════════════════════════════════════════════════

async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;

  btn.disabled = true;
  btn.innerHTML = `<span>${t('login.signingIn') || '…'}</span>`;
  err.classList.add('hidden');

  try {
    const res = await api('POST', '/api/login', { username, password });
    state.authenticated = true;
    state.username = res.username;
    enterApp();
  } catch (ex) {
    err.textContent = ex.message || t('login.invalidCreds');
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<span>${t('login.signIn')}</span>`;
  }
}

function enterApp() {
  document.getElementById('page-login').classList.remove('active');
  document.getElementById('app').classList.remove('hidden');

  const uname = state.username || 'admin';
  document.getElementById('sidebar-uname').textContent = uname;
  document.getElementById('sidebar-avatar').textContent = uname[0].toUpperCase();

  loadConfig().then(() => {
    navigateTo('dashboard');
    connectWebSocket();
  });
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  state.authenticated = false;
  if (state.ws) state.ws.close();
  document.getElementById('app').classList.add('hidden');
  document.getElementById('page-login').classList.add('active');
  document.getElementById('login-pass').value = '';
}

// ══════════════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════════════

function navigateTo(page) {
  state.currentPage = page;

  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });
  document.querySelectorAll('.content-page').forEach(el => {
    el.classList.toggle('active', el.id === `page-${page}`);
  });

  const titles = buildTitles();
  document.getElementById('topbar-title').textContent = titles[page] || page;

  switch (page) {
    case 'dashboard':   loadDashboard();   break;
    case 'users':       loadUsers();       break;
    case 'settings':    loadSettings();    break;
    case 'monitoring':  loadMonitoring();  break;
    case 'logs':        loadLogs(currentLogService); break;
    case 'diagnostics': runDiagnostics();  break;
  }

  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.remove('open');
  }
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('open');
  let overlay = document.getElementById('sidebar-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'sidebar-overlay';
    overlay.className = 'sidebar-overlay';
    overlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('active');
    });
    document.body.appendChild(overlay);
  }
  overlay.classList.toggle('active', sidebar.classList.contains('open'));
}

// ══════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════

async function loadConfig() {
  try {
    state.config = await api('GET', '/api/config');
    document.getElementById('topbar-version').textContent = `v${state.config.version || '1.2.3'}`;
  } catch {}
}

// ══════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════

async function loadDashboard() {
  try {
    const status = await api('GET', '/api/status');
    state.config = { ...state.config, domain: status.domain, serverIp: status.serverIp };

    el('d-naive-status').innerHTML = badge(status.services.naive.active,
      t('dashboard.active'), t('dashboard.inactive'));
    el('d-mieru-status').innerHTML = badge(status.services.mieru.active,
      t('dashboard.active'), t('dashboard.inactive'));
    el('d-user-count').textContent = status.panel.userCount;
    el('d-domain').textContent     = status.domain || '—';

    const cpu = status.system.cpuPercent || 0;
    el('d-cpu').textContent = `${cpu}%`;
    setProgress('d-cpu-bar', cpu);

    const ramPct = status.system.ramTotalMB
      ? Math.round((status.system.ramUsedMB / status.system.ramTotalMB) * 100) : 0;
    el('d-ram').textContent = `${fmtMB(status.system.ramUsedMB)} / ${fmtMB(status.system.ramTotalMB)}`;
    setProgress('d-ram-bar', ramPct);

    const diskPct = status.system.diskTotalGB
      ? Math.round((status.system.diskUsedGB / status.system.diskTotalGB) * 100) : 0;
    el('d-disk').textContent = `${status.system.diskUsedGB} GB / ${status.system.diskTotalGB} GB`;
    setProgress('d-disk-bar', diskPct);

    el('d-sysinfo').innerHTML = infoList([
      [t('dashboard.domain'),       status.domain],
      [t('dashboard.serverIp'),     status.serverIp],
      [t('dashboard.os'),           status.system.os],
      [t('dashboard.architecture'), status.system.arch],
      [t('dashboard.uptime'),       fmtUptime(status.system.uptime)],
      [t('dashboard.naivePort'),    state.config.naivePort],
      [t('dashboard.mieruPorts'),   `${state.config.mieruPortStart}–${state.config.mieruPortEnd}`],
      [t('dashboard.naiveVersion'), status.services.naive.version || '—'],
      [t('dashboard.mieruVersion'), status.services.mieru.version || '—'],
    ]);

    document.getElementById('about-version').textContent = `v${status.panel.version || '1.2.3'}`;
  } catch (err) {
    console.error('Dashboard error:', err);
  }
}

// ══════════════════════════════════════════════════════════════
// USERS
// ══════════════════════════════════════════════════════════════

async function loadUsers() {
  const tbody = el('users-tbody');
  tbody.innerHTML = `<tr><td colspan="10" class="table-empty">${t('users.loading')}</td></tr>`;
  try {
    state.users = await api('GET', '/api/users');
    renderUsersTable(state.users);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" class="table-empty" style="color:var(--red)">${esc(err.message)}</td></tr>`;
  }
}

function renderUsersTable(users) {
  const tbody = el('users-tbody');
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="table-empty">${t('users.noUsers')}</td></tr>`;
    return;
  }
  tbody.innerHTML = users.map(u => {
    // Bug 7 fix: protocols is already an array from server (parsed in GET /api/users)
    const protocols = Array.isArray(u.protocols) ? u.protocols : safeParseJSON(u.protocols, []);
    const hasNaive  = protocols.includes('naive');
    const hasMieru  = protocols.includes('mieru');
    const expBadge  = u.expiry
      ? (new Date(u.expiry) < new Date()
          ? `<span class="badge badge-red">${t('users.expired')}</span>`
          : `<span class="badge badge-yellow">${fmtDate(u.expiry)}</span>`)
      : `<span class="badge badge-gray">${t('users.never')}</span>`;

    const quotaPct = u.quotaMB > 0 ? Math.min(100, Math.round((u.usedMB / u.quotaMB) * 100)) : 0;
    const quotaStr = u.quotaMB > 0
      ? `<div class="quota-bar"><div class="quota-fill${quotaPct>80?' warn':''}" style="width:${quotaPct}%"></div></div> ${quotaPct}%`
      : `<span class="badge badge-gray">${t('users.unlimited')}</span>`;

    // Bug 1 fix: use data-action + data-id instead of onclick="..."
    return `<tr>
      <td><strong>${esc(u.username)}</strong></td>
      <td>${esc(u.email)}</td>
      <td>${expBadge}</td>
      <td>${hasNaive ? '<span class="badge badge-blue">✓</span>' : '<span class="badge badge-gray">—</span>'}</td>
      <td>${hasMieru ? '<span class="badge badge-blue">✓</span>' : '<span class="badge badge-gray">—</span>'}</td>
      <td>${fmtNum(u.usedMB)}</td>
      <td>${u.quotaMB > 0 ? fmtNum(u.quotaMB) : '∞'}</td>
      <td>${quotaStr}</td>
      <td>${fmtLastSeen(u.lastSeen)}</td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn btn-xs btn-secondary" data-action="edit-user"   data-id="${u.id}">${t('users.edit')}</button>
          <button class="btn btn-xs btn-ghost"     data-action="open-config" data-id="${u.id}">${t('users.config')}</button>
          <button class="btn btn-xs btn-danger"    data-action="delete-user" data-id="${u.id}" data-username="${esc(u.username)}">${t('users.delete')}</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function openAddUser() {
  state.selectedUserId = null;
  el('user-modal-title').textContent = t('users.addTitle');
  el('user-id').value      = '';
  el('u-username').value   = '';
  el('u-email').value      = '';
  el('u-password').value   = '';
  el('u-expiry').value     = '';
  el('u-quota').value      = '0';
  el('p-naive').checked    = true;
  el('p-mieru').checked    = true;
  el('u-pass-hint').textContent = t('users.passwordHintNew');
  el('user-modal-error').classList.add('hidden');
  el('user-modal').classList.remove('hidden');
}

function openEditUser(id) {
  const user = state.users.find(u => u.id === id);
  if (!user) return;
  state.selectedUserId = id;
  // Bug 7 fix: protocols already an array from server
  const protocols = Array.isArray(user.protocols) ? user.protocols : safeParseJSON(user.protocols, []);

  el('user-modal-title').textContent = t('users.editTitle');
  el('user-id').value    = id;
  el('u-username').value = user.username;
  el('u-email').value    = user.email;
  el('u-password').value = '';
  el('u-expiry').value   = user.expiry ? user.expiry.slice(0, 16) : '';
  el('u-quota').value    = user.quotaMB || 0;
  el('p-naive').checked  = protocols.includes('naive');
  el('p-mieru').checked  = protocols.includes('mieru');
  el('u-pass-hint').textContent = t('users.passwordHintEdit');
  el('user-modal-error').classList.add('hidden');
  el('user-modal').classList.remove('hidden');
}

function closeUserModal() { el('user-modal').classList.add('hidden'); }

async function saveUser() {
  const id       = el('user-id').value;
  const username = el('u-username').value.trim();
  const email    = el('u-email').value.trim();
  const password = el('u-password').value;
  const expiry   = el('u-expiry').value ? new Date(el('u-expiry').value).toISOString() : null;
  const quotaMB  = parseInt(el('u-quota').value, 10) || 0;
  const protocols = [];
  if (el('p-naive').checked) protocols.push('naive');
  if (el('p-mieru').checked) protocols.push('mieru');

  if (!username || !email)  return showUserError(t('users.usernameRequired'));
  if (!id && !password)     return showUserError(t('users.passwordRequired'));
  if (password && password.length < 8) return showUserError(t('users.passwordTooShort'));
  if (!protocols.length)    return showUserError(t('users.protocolRequired'));

  const body = { email, username, expiry, protocols, quotaMB };
  if (password) body.password = password;

  // v1.2.3: disabled-button + spinner pattern
  const saveBtn = el('btn-save-user');
  setBtnBusy(saveBtn, true);

  try {
    if (id) {
      const res = await api('PUT', `/api/users/${id}`, body);
      toast(t('users.updated'), 'success');
      if (res.servicesReloaded === false) {
        toast(t('users.serviceReloadWarning') || 'Service reload failed — check logs', 'error');
      }
    } else {
      const res = await api('POST', '/api/users', body);
      toast(t('users.created'), 'success');
      if (res.servicesReloaded === false) {
        toast(t('users.serviceReloadWarning') || 'Service reload failed — check logs', 'error');
      }
    }
    closeUserModal();
    loadUsers();
  } catch (err) {
    showUserError(err.message);
  } finally {
    setBtnBusy(saveBtn, false);
  }
}

function showUserError(msg) {
  const errEl = el('user-modal-error');
  errEl.textContent = msg;
  errEl.classList.remove('hidden');
}

async function deleteUser(id, username) {
  if (!confirm(t('users.deleteConfirm', { name: username }))) return;
  try {
    await api('DELETE', `/api/users/${id}`);
    toast(t('users.deleted', { name: username }), 'success');
    loadUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════
// CLIENT CONFIGS + QR CODE
// ══════════════════════════════════════════════════════════════

function openConfigDownload(id) {
  state.selectedUserId = id;
  el('cfg-password').value = '';
  el('naive-link-box').classList.add('hidden');
  el('naive-link-box').textContent = '';
  el('qr-container').classList.add('hidden');
  el('config-modal').classList.remove('hidden');
}

function closeConfigModal() { el('config-modal').classList.add('hidden'); }

async function downloadNaiveLink() {
  const password = el('cfg-password').value;
  if (!password) { toast(t('config.enterPassword'), 'error'); return; }
  try {
    const data = await api('GET',
      `/api/users/${state.selectedUserId}/config/naive?password=${encodeURIComponent(password)}`);

    el('naive-link-box').textContent = data.link;
    el('naive-link-box').classList.remove('hidden');
    copyToClipboard(data.link);
    toast(t('config.naiveCopied'), 'success');
    generateQR(data.link);
  } catch (err) { toast(err.message, 'error'); }
}

async function generateQR(text) {
  const container = el('qr-container');
  const canvas    = el('qr-canvas');
  if (!container || !canvas) return;

  if (typeof QRCode !== 'undefined') {
    try {
      await QRCode.toCanvas(canvas, text, {
        width: 200, margin: 2,
        color: {
          dark:  currentTheme === 'dark' ? '#e4e4e7' : '#18181b',
          light: currentTheme === 'dark' ? '#1a1a1d' : '#f5f5f7',
        }
      });
      container.classList.remove('hidden');
    } catch (err) {
      console.warn('QR generation failed:', err);
    }
  }
}

async function downloadMieruConfig() {
  const password = el('cfg-password').value;
  if (!password) { toast(t('config.enterPassword'), 'error'); return; }
  try {
    const res = await fetch(
      `/api/users/${state.selectedUserId}/config/mieru?password=${encodeURIComponent(password)}`,
      { credentials: 'include' });
    if (res.status === 401) { redirectToLogin(); return; }
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const cd   = res.headers.get('Content-Disposition') || '';
    const fn   = cd.match(/filename="(.+)"/)?.[1] || 'mieru-config.json';
    downloadBlob(blob, fn);
    toast(t('config.mieruDownloaded'), 'success');
  } catch (err) { toast(err.message, 'error'); }
}

async function downloadUniversalConfig() {
  const password = el('cfg-password').value;
  if (!password) { toast(t('config.enterPassword'), 'error'); return; }
  try {
    const res = await fetch(
      `/api/users/${state.selectedUserId}/config/universal?password=${encodeURIComponent(password)}`,
      { credentials: 'include' });
    if (res.status === 401) { redirectToLogin(); return; }
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const cd   = res.headers.get('Content-Disposition') || '';
    const fn   = cd.match(/filename="(.+)"/)?.[1] || 'universal-config.json';
    downloadBlob(blob, fn);
    toast(t('config.universalDownloaded'), 'success');
  } catch (err) { toast(err.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════
// SERVER SETTINGS
// ══════════════════════════════════════════════════════════════

async function loadSettings() {
  try {
    const cfg = await api('GET', '/api/config');
    state.config = cfg;
    el('s-naive-port').value  = cfg.naivePort     || 443;
    el('s-mieru-start').value = cfg.mieruPortStart || 2012;
    el('s-mieru-end').value   = cfg.mieruPortEnd   || 2022;
    el('s-mtu').value         = cfg.mtu || 1400;
    const pattern = cfg.trafficPattern || 'NOOP';
    const radio = document.querySelector(`input[name="traffic-pattern"][value="${pattern}"]`);
    if (radio) radio.checked = true;
    const udpBox = el('s-udp-enabled');
    if (udpBox) udpBox.checked = cfg.udpEnabled === true;
    const langSel = el('s-language-select');
    if (langSel) langSel.value = cfg.language || currentLang || 'ru';
    // v1.2.3: probe secret (masked)
    const probeEl = el('s-probe-secret');
    if (probeEl) probeEl.placeholder = cfg.probeSecret ? '••••••••' : (t('settings.probeSecretPlaceholder') || 'Enter probe secret');
    document.getElementById('about-version').textContent = `v${cfg.version || '1.2.3'}`;
  } catch {}
}

async function changeNaivePort() {
  const port = parseInt(el('s-naive-port').value, 10);
  if (!port || port < 1 || port > 65535) {
    showMsg('naive-port-msg', t('settings.invalidPort') || 'Invalid port (1–65535)', false); return;
  }
  const btn = document.querySelector('[data-action="change-naive-port"]');
  setBtnBusy(btn, true);
  try {
    const res = await api('POST', '/api/settings/naive-port', { port });
    showMsg('naive-port-msg', res.message || 'Port updated', true);
    state.config.naivePort = port;
    toast(t('toast.naivePortUpdated') || `NaiveProxy port → ${port}`, 'info');
  } catch (err) {
    showMsg('naive-port-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

async function changeMieruPorts() {
  const portStart = parseInt(el('s-mieru-start').value, 10);
  const portEnd   = parseInt(el('s-mieru-end').value, 10);
  if (!confirm(t('settings.mieruPortConfirm') || 'Apply Mieru port change?')) return;
  const btn = document.querySelector('[data-action="change-mieru-ports"]');
  setBtnBusy(btn, true);
  try {
    const res = await api('POST', '/api/settings/mieru-ports', { portStart, portEnd });
    showMsg('mieru-port-msg', res.message || 'Ports updated', true);
    toast(t('toast.mieruPortsUpdated') || `Mieru ports → ${portStart}–${portEnd}`, 'info');
  } catch (err) {
    showMsg('mieru-port-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

async function changeUdpMode() {
  const enabled = el('s-udp-enabled')?.checked || false;
  const btn = document.querySelector('[data-action="change-udp-mode"]');
  setBtnBusy(btn, true);
  try {
    const res = await api('POST', '/api/settings/udp-toggle', { enabled });
    showMsg('udp-msg', res.message || t('settings.udpUpdated'), true);
    state.config.udpEnabled = enabled;
    toast(t('settings.udpUpdated') || `UDP ${enabled ? 'enabled' : 'disabled'}`, 'info');
  } catch (err) {
    showMsg('udp-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

async function changeTrafficPattern() {
  const pattern = document.querySelector('input[name="traffic-pattern"]:checked')?.value || 'NOOP';
  const mtu = parseInt(el('s-mtu').value, 10);
  const btn = document.querySelector('[data-action="change-traffic-pattern"]');
  setBtnBusy(btn, true);
  try {
    const res = await api('POST', '/api/settings/traffic-pattern', { pattern, mtu });
    showMsg('traffic-msg', `${t('settings.trafficPatternLabel')}: ${res.pattern}, MTU: ${res.mtu}`, true);
    toast(t('toast.trafficPatternUpdated') || 'Traffic pattern updated', 'success');
  } catch (err) {
    showMsg('traffic-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

async function changePassword() {
  const current  = el('s-cur-pass').value;
  const newPass  = el('s-new-pass').value;
  const confirm2 = el('s-new-pass2').value;
  if (!current || !newPass || !confirm2)
    return showMsg('pw-msg', t('settings.allFieldsRequired'), false);
  if (newPass !== confirm2)
    return showMsg('pw-msg', t('settings.passwordMismatch'), false);
  if (newPass.length < 8)
    return showMsg('pw-msg', t('settings.passwordTooShort'), false);
  const btn = document.querySelector('[data-action="change-password"]');
  setBtnBusy(btn, true);
  try {
    await api('POST', '/api/config/password', { current, newPass });
    showMsg('pw-msg', t('settings.passwordChanged'), true);
    el('s-cur-pass').value  = '';
    el('s-new-pass').value  = '';
    el('s-new-pass2').value = '';
    toast(t('settings.passwordChanged'), 'success');
  } catch (err) {
    showMsg('pw-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

// v1.2.3: Probe secret update — rebuilds Caddyfile and reloads Caddy
async function changeProbeSecret() {
  const secret = el('s-probe-secret')?.value?.trim();
  if (!secret || secret.length < 8) {
    showMsg('probe-secret-msg', t('settings.probeSecretTooShort') || 'Probe secret must be at least 8 characters', false);
    return;
  }
  const btn = document.querySelector('[data-action="change-probe-secret"]');
  setBtnBusy(btn, true);
  try {
    const res = await api('POST', '/api/settings/probe-secret', { probeSecret: secret });
    showMsg('probe-secret-msg', res.message || t('settings.probeSecretUpdated') || 'Probe secret updated', true);
    el('s-probe-secret').value = '';
    el('s-probe-secret').placeholder = '••••••••';
    state.config.probeSecret = secret;
    toast(t('settings.probeSecretUpdated') || 'Probe secret updated — Caddy reloaded', 'success');
  } catch (err) {
    showMsg('probe-secret-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

async function changeLanguage() {
  const sel = el('s-language-select');
  if (!sel) return;
  const lang = sel.value;
  try {
    await api('POST', '/api/settings/language', { language: lang });
    await setLang(lang);
    toast((t('settings.applyLanguage') || 'Language') + ': ' + lang.toUpperCase(), 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════
// MONITORING
// ══════════════════════════════════════════════════════════════

async function loadMonitoring() { refreshStats(); }

async function refreshStats() {
  try {
    const [status, stats] = await Promise.all([
      api('GET', '/api/status'),
      api('GET', '/api/stats/users'),
    ]);

    el('m-cpu').textContent    = `${status.system.cpuPercent}%`;
    el('m-ram').textContent    = `${fmtMB(status.system.ramUsedMB)}/${fmtMB(status.system.ramTotalMB)}`;
    el('m-naive').innerHTML    = badge(status.services.naive.active, t('monitoring.active'), t('monitoring.inactive'));
    el('m-mieru').innerHTML    = badge(status.services.mieru.active, t('monitoring.active'), t('monitoring.inactive'));
    el('m-uptime').textContent = fmtUptime(status.system.uptime);

    renderTrafficTable(stats);
  } catch (err) {
    console.error('Monitoring error:', err);
  }
}

function renderTrafficTable(stats) {
  const tbody = el('traffic-tbody');
  if (!stats.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="table-empty">${t('monitoring.noUsers')}</td></tr>`;
    return;
  }
  tbody.innerHTML = stats.map(u => {
    const quotaMB = u.quotaMB || 0;
    const usedMB  = u.usedMB  || 0;
    const pct     = quotaMB > 0 ? Math.min(100, Math.round((usedMB / quotaMB) * 100)) : 0;
    const warn    = pct > 80;
    const danger  = pct > 95;
    const quotaCell = quotaMB > 0
      ? `<div style="display:flex;align-items:center;gap:8px">
          <div class="quota-bar"><div class="quota-fill${danger?' danger':warn?' warn':''}" style="width:${pct}%"></div></div>
          <span style="font-size:11px;color:${danger?'var(--red)':warn?'var(--yellow)':'var(--text-muted)'}">${pct}%</span>
         </div>`
      : `<span class="badge badge-gray">${t('monitoring.unlimited')}</span>`;

    return `<tr>
      <td><strong>${esc(u.username)}</strong></td>
      <td>${fmtNum(u.uploadMB)}</td>
      <td>${fmtNum(u.downloadMB)}</td>
      <td>${fmtNum(usedMB)}</td>
      <td>${quotaMB > 0 ? fmtNum(quotaMB) : '∞'}</td>
      <td>${quotaCell}</td>
      <td>${u.expiry ? fmtDate(u.expiry) : '—'}</td>
      <td>${fmtLastSeen(u.lastSeen)}</td>
    </tr>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════
// LOGS
// ══════════════════════════════════════════════════════════════

async function loadLogs(service) {
  currentLogService = service || currentLogService;
  ['caddy', 'mieru', 'panel'].forEach(s => {
    el(`log-btn-${s}`)?.classList.toggle('active', s === currentLogService);
  });
  const lines = el('log-lines')?.value || 100;
  el('log-content').textContent = t('logs.loading') || 'Loading…';
  try {
    const data = await api('GET', `/api/logs/${currentLogService}?lines=${lines}`);
    el('log-content').textContent = data.logs || '(empty)';
    el('log-content').scrollTop = el('log-content').scrollHeight;
  } catch (err) {
    el('log-content').textContent = `Error: ${err.message}`;
  }
}

// ══════════════════════════════════════════════════════════════
// DIAGNOSTICS
// ══════════════════════════════════════════════════════════════

async function runDiagnostics() {
  el('diag-ports').innerHTML  = `<p class="text-muted">${t('diagnostics.checking') || '…'}</p>`;
  el('diag-config').innerHTML = `<p class="text-muted">${t('diagnostics.checking') || '…'}</p>`;
  el('diag-mita-status').textContent = t('logs.loading') || '…';
  el('diag-mita-config').textContent = t('logs.loading') || '…';

  try {
    const data = await api('GET', '/api/diagnostics');

    el('diag-ports').innerHTML = `
      <div class="info-list">
        <div class="info-row">
          <span>${t('diagnostics.naivePort', { port: state.config.naivePort || 443 })}</span>
          <span>${data.ports?.naive
            ? `<span class="badge badge-green">${t('diagnostics.open')}</span>`
            : `<span class="badge badge-red">${t('diagnostics.closed')}</span>`}</span>
        </div>
        <div class="info-row">
          <span>${t('diagnostics.mieruPort', { port: state.config.mieruPortStart || 2012 })}</span>
          <span>${data.ports?.mieru
            ? `<span class="badge badge-green">${t('diagnostics.open')}</span>`
            : `<span class="badge badge-red">${t('diagnostics.closed')}</span>`}</span>
        </div>
      </div>`;

    // v1.2.3: caddy-forwardproxy-naive — show Caddyfile + probe_secret status
    const naiveOk = data.naiveVersionOk && data.naiveConfigExists;
    const caddyfileUsers = data.caddyfileUsers ?? data.htpasswdUsers ?? 0;
    const probeSet = data.probeSecretSet ? '✓ set' : '✗ not set';
    el('diag-config').innerHTML = naiveOk
      ? `<span class="badge badge-green">${t('diagnostics.caddyValid') || 'Caddyfile valid ✓'}</span>
         <small style="display:block;margin-top:4px;color:var(--text-muted)">${esc(data.naiveVersion || '')}</small>
         <small style="color:var(--text-muted)">Caddyfile users: ${caddyfileUsers} &nbsp;|&nbsp; probe_secret: ${probeSet}</small>`
      : `<span class="badge badge-red">${t('diagnostics.naiveInvalid') || 'caddy-naive WARN'}</span>
         <pre class="mini-log mt-2">${esc(data.naiveVersion || 'binary not found or version empty')}</pre>`;

    el('diag-mita-status').textContent = data.mitaStatus  || t('diagnostics.noOutput') || '—';
    el('diag-mita-config').textContent = data.mitaConfig  || t('diagnostics.noOutput') || '—';
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════
// SERVICE CONTROL
// ══════════════════════════════════════════════════════════════

async function svcAction(service, action) {
  try {
    await api('POST', `/api/service/${service}/${action}`);
    toast(t('service.actionOk', { service, action }) || `${service} ${action} OK`, 'success');
    setTimeout(loadDashboard, 1500);
  } catch (err) {
    toast(t('service.actionFail', { service, action, msg: err.message }) || err.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════
// WEBSOCKET — live metrics
// ══════════════════════════════════════════════════════════════

function connectWebSocket() {
  if (state.wsReconnectTimer) clearTimeout(state.wsReconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/ws`;

  try {
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.onopen = () => {
      document.getElementById('ws-dot').className = 'status-dot connected';
    };

    ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'metrics') {
          if (state.currentPage === 'monitoring') {
            el('m-cpu').textContent  = `${msg.cpu}%`;
            el('m-ram').textContent  = `${fmtMB(msg.ramUsedMB)}/${fmtMB(msg.ramTotalMB)}`;
            el('m-naive').innerHTML  = badge(msg.naive, t('monitoring.active'), t('monitoring.inactive'));
            el('m-mieru').innerHTML  = badge(msg.mieru, t('monitoring.active'), t('monitoring.inactive'));
          }
          if (state.currentPage === 'dashboard') {
            el('d-naive-status').innerHTML = badge(msg.naive, t('dashboard.active'), t('dashboard.inactive'));
            el('d-mieru-status').innerHTML = badge(msg.mieru, t('dashboard.active'), t('dashboard.inactive'));
            const cpuEl = el('d-cpu');
            if (cpuEl) { cpuEl.textContent = `${msg.cpu}%`; setProgress('d-cpu-bar', msg.cpu); }
          }
        }
      } catch {}
    };

    ws.onclose = () => {
      document.getElementById('ws-dot').className = 'status-dot error';
      state.ws = null;
      state.wsReconnectTimer = setTimeout(connectWebSocket, 5000);
    };
    ws.onerror = () => ws.close();
  } catch {
    state.wsReconnectTimer = setTimeout(connectWebSocket, 5000);
  }
}

// ══════════════════════════════════════════════════════════════
// HTTP HELPER (Bug 10: 401 auto-redirect; toast on all errors)
// ══════════════════════════════════════════════════════════════

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body) opts.body = JSON.stringify(body);

  const res  = await fetch(path, opts);

  // Bug 10: auto-redirect on 401
  if (res.status === 401) {
    redirectToLogin();
    throw new Error(t('login.invalidCreds') || 'Session expired');
  }

  const ct   = res.headers.get('Content-Type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();

  if (!res.ok) {
    const msg = (typeof data === 'object' && data.error) ? data.error : String(data);
    const errMsg = msg || `HTTP ${res.status}`;
    toast(errMsg, 'error');   // Bug 10: always show toast on error
    throw new Error(errMsg);
  }
  return data;
}

// Redirect back to login screen (Bug 10)
function redirectToLogin() {
  if (!state.authenticated) return;
  state.authenticated = false;
  if (state.ws) { state.ws.close(); state.ws = null; }
  document.getElementById('app').classList.add('hidden');
  document.getElementById('page-login').classList.add('active');
  toast(t('login.sessionExpired') || 'Session expired — please log in again', 'error');
}

// ══════════════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════════════

function el(id) { return document.getElementById(id); }

/**
 * v1.2.3: disabled-button + spinner pattern for all submit handlers.
 * Prevents double-submit and gives visual feedback during async ops.
 */
function setBtnBusy(btn, busy) {
  if (!btn) return;
  if (busy) {
    btn.dataset.origText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${btn.dataset.origText}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.origText) {
      btn.innerHTML = btn.dataset.origText;
      delete btn.dataset.origText;
    }
  }
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Safe JSON.parse with fallback */
function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function badge(active, trueLabel, falseLabel) {
  return active
    ? `<span class="badge badge-green">● ${trueLabel}</span>`
    : `<span class="badge badge-red">● ${falseLabel}</span>`;
}

function infoList(rows) {
  return rows.map(([k, v]) =>
    `<div class="info-row"><span>${esc(k)}</span><span>${esc(String(v ?? '—'))}</span></div>`
  ).join('');
}

function setProgress(id, pct) {
  const el2 = document.getElementById(id);
  if (!el2) return;
  const p = Math.max(0, Math.min(100, pct));
  el2.style.width = `${p}%`;
  el2.classList.toggle('warn',   p > 70 && p <= 85);
  el2.classList.toggle('danger', p > 85);
}

function showMsg(id, text, ok) {
  const el2 = document.getElementById(id);
  if (!el2) return;
  el2.textContent = text;
  el2.className = `msg-inline ${ok ? 'ok' : 'err'}`;
  el2.classList.remove('hidden');
  setTimeout(() => el2.classList.add('hidden'), 6000);
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const opts = { day: '2-digit', month: 'short', year: 'numeric' };
    return new Date(iso).toLocaleDateString(currentLang === 'ru' ? 'ru-RU' : 'en-GB', opts);
  } catch { return iso; }
}

/** Blocker 14: "Last seen N min/h/d ago" */
function fmtLastSeen(iso) {
  if (!iso) return '—';
  try {
    const diffMs  = Date.now() - new Date(iso).getTime();
    if (diffMs < 0) return fmtDate(iso);
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1)  return currentLang === 'ru' ? 'только что' : 'just now';
    if (diffMin < 60) return currentLang === 'ru' ? `${diffMin} мин. назад` : `${diffMin} min ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24)   return currentLang === 'ru' ? `${diffH} ч. назад`   : `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    return currentLang === 'ru' ? `${diffD} д. назад` : `${diffD}d ago`;
  } catch { return iso; }
}

function fmtMB(mb) {
  if (!mb) return '0 MB';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function fmtNum(n) {
  if (n === undefined || n === null) return '0';
  return parseFloat(n).toFixed(1);
}

function fmtUptime(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function togglePw(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
}

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {});
  } else {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const t_el = document.createElement('div');
  t_el.className = `toast ${type}`;
  const icons = { success: '✓', error: '✗', info: 'ℹ' };
  t_el.innerHTML = `<span style="font-weight:700;font-size:14px">${icons[type] || 'ℹ'}</span><span>${esc(message)}</span>`;
  container.appendChild(t_el);
  setTimeout(() => {
    t_el.style.opacity = '0';
    t_el.style.transform = 'translateX(20px)';
    t_el.style.transition = 'all 0.3s';
    setTimeout(() => t_el.remove(), 300);
  }, 4000);
}
