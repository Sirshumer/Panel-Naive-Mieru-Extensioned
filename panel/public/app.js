/**
 * Panel Naive + Mieru — Frontend Application
 * Single-page app: login, dashboard, users, settings, monitoring, logs, diagnostics
 */
'use strict';

// ── State ─────────────────────────────────────────────────────
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

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Check existing session
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

  // Login form
  document.getElementById('login-form').addEventListener('submit', handleLogin);

  // Navigation
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      navigateTo(el.dataset.page);
    });
  });
});

// ── Login ─────────────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;

  btn.disabled = true;
  btn.innerHTML = '<span>Signing in…</span>';
  err.classList.add('hidden');

  try {
    const res = await api('POST', '/api/login', { username, password });
    state.authenticated = true;
    state.username = res.username;
    enterApp();
  } catch (ex) {
    err.textContent = ex.message || 'Invalid credentials';
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>Sign In</span>';
  }
}

function enterApp() {
  document.getElementById('page-login').classList.remove('active');
  document.getElementById('app').classList.remove('hidden');

  // Set sidebar username
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

// ── Navigation ────────────────────────────────────────────────
function navigateTo(page) {
  state.currentPage = page;

  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });

  document.querySelectorAll('.content-page').forEach(el => {
    el.classList.toggle('active', el.id === `page-${page}`);
  });

  const titles = {
    dashboard: 'Dashboard',
    users: 'Users',
    settings: 'Server Settings',
    monitoring: 'Monitoring',
    logs: 'Logs',
    diagnostics: 'Diagnostics',
  };
  document.getElementById('topbar-title').textContent = titles[page] || page;

  // Load page data
  switch (page) {
    case 'dashboard':  loadDashboard();  break;
    case 'users':      loadUsers();      break;
    case 'settings':   loadSettings();   break;
    case 'monitoring': loadMonitoring(); break;
    case 'logs':       loadLogs('caddy'); break;
    case 'diagnostics': break;
  }

  // Close sidebar on mobile
  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.remove('open');
  }
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

// ── Config ────────────────────────────────────────────────────
async function loadConfig() {
  try {
    state.config = await api('GET', '/api/config');
    document.getElementById('topbar-version').textContent = `v${state.config.version || '1.0.0'}`;
  } catch {}
}

// ── Dashboard ─────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const status = await api('GET', '/api/status');
    state.config = { ...state.config, ...{ domain: status.domain, serverIp: status.serverIp } };

    // Service status badges
    el('d-naive-status').innerHTML = badge(status.services.naive.active, 'Active', 'Inactive');
    el('d-mieru-status').innerHTML = badge(status.services.mieru.active, 'Active', 'Inactive');
    el('d-user-count').textContent  = status.panel.userCount;
    el('d-domain').textContent       = status.domain || '—';

    // CPU
    const cpu = status.system.cpuPercent || 0;
    el('d-cpu').textContent  = `${cpu}%`;
    setProgress('d-cpu-bar', cpu);

    // RAM
    const ramPct = status.system.ramTotalMB
      ? Math.round((status.system.ramUsedMB / status.system.ramTotalMB) * 100) : 0;
    el('d-ram').textContent = `${fmtMB(status.system.ramUsedMB)} / ${fmtMB(status.system.ramTotalMB)}`;
    setProgress('d-ram-bar', ramPct);

    // Disk
    const diskPct = status.system.diskTotalGB
      ? Math.round((status.system.diskUsedGB / status.system.diskTotalGB) * 100) : 0;
    el('d-disk').textContent = `${status.system.diskUsedGB} GB / ${status.system.diskTotalGB} GB`;
    setProgress('d-disk-bar', diskPct);

    // Sysinfo
    el('d-sysinfo').innerHTML = infoList([
      ['Domain',        status.domain],
      ['Server IP',     status.serverIp],
      ['OS',            status.system.os],
      ['Architecture',  status.system.arch],
      ['Uptime',        fmtUptime(status.system.uptime)],
      ['Naive Port',    state.config.naivePort],
      ['Mieru Ports',   `${state.config.mieruPortStart}–${state.config.mieruPortEnd}`],
      ['Naive Version', status.services.naive.version || '—'],
      ['Mieru Version', status.services.mieru.version || '—'],
    ]);

    document.getElementById('about-version').textContent = status.panel.version || '1.0.0';
  } catch (err) {
    console.error('Dashboard error:', err);
  }
}

// ── Users ─────────────────────────────────────────────────────
async function loadUsers() {
  const tbody = el('users-tbody');
  tbody.innerHTML = '<tr><td colspan="9" class="table-empty">Loading…</td></tr>';
  try {
    state.users = await api('GET', '/api/users');
    renderUsersTable(state.users);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="table-empty" style="color:var(--red)">${err.message}</td></tr>`;
  }
}

function renderUsersTable(users) {
  const tbody = el('users-tbody');
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-empty">No users yet. Click "Add User" to create one.</td></tr>';
    return;
  }
  tbody.innerHTML = users.map(u => {
    const protocols = Array.isArray(u.protocols) ? u.protocols : JSON.parse(u.protocols || '[]');
    const hasNaive  = protocols.includes('naive');
    const hasMieru  = protocols.includes('mieru');
    const expBadge  = u.expiry
      ? (new Date(u.expiry) < new Date()
          ? `<span class="badge badge-red">Expired</span>`
          : `<span class="badge badge-yellow">${fmtDate(u.expiry)}</span>`)
      : `<span class="badge badge-gray">Never</span>`;

    const quotaPct = u.quotaMB > 0 ? Math.min(100, Math.round((u.usedMB / u.quotaMB) * 100)) : 0;
    const quotaStr = u.quotaMB > 0
      ? `<div class="quota-bar"><div class="quota-fill${quotaPct>80?' warn':''}" style="width:${quotaPct}%"></div></div> ${quotaPct}%`
      : '<span class="badge badge-gray">Unlimited</span>';

    return `<tr>
      <td><strong>${esc(u.username)}</strong></td>
      <td>${esc(u.email)}</td>
      <td>${expBadge}</td>
      <td>${hasNaive ? '<span class="badge badge-blue">✓</span>' : '<span class="badge badge-gray">—</span>'}</td>
      <td>${hasMieru ? '<span class="badge badge-blue">✓</span>' : '<span class="badge badge-gray">—</span>'}</td>
      <td>${fmtNum(u.usedMB)}</td>
      <td>${u.quotaMB > 0 ? fmtNum(u.quotaMB) : '∞'}</td>
      <td>${quotaStr}</td>
      <td class="table-empty">${fmtDate(u.lastSeen)}</td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn btn-xs btn-secondary" onclick="openEditUser('${u.id}')">Edit</button>
          <button class="btn btn-xs btn-ghost" onclick="openConfigDownload('${u.id}')">Config</button>
          <button class="btn btn-xs btn-danger" onclick="deleteUser('${u.id}','${esc(u.username)}')">Del</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  // Fix last-active column index — rebuild properly
  tbody.querySelectorAll('tr').forEach((tr, i) => {
    const tds = tr.querySelectorAll('td');
    if (tds.length >= 9 && tds[8]) {
      tds[8].textContent = fmtDate(users[i]?.lastSeen);
      tds[8].classList.remove('table-empty');
    }
  });
}

function openAddUser() {
  state.selectedUserId = null;
  el('user-modal-title').textContent = 'Add User';
  el('user-id').value = '';
  el('u-username').value = '';
  el('u-email').value = '';
  el('u-password').value = '';
  el('u-expiry').value = '';
  el('u-quota').value = '0';
  el('p-naive').checked = true;
  el('p-mieru').checked = true;
  el('u-pass-hint').textContent = 'Required for new user';
  el('user-modal-error').classList.add('hidden');
  el('user-modal').classList.remove('hidden');
}

function openEditUser(id) {
  const user = state.users.find(u => u.id === id);
  if (!user) return;
  state.selectedUserId = id;
  const protocols = Array.isArray(user.protocols) ? user.protocols : JSON.parse(user.protocols || '[]');

  el('user-modal-title').textContent = 'Edit User';
  el('user-id').value = id;
  el('u-username').value = user.username;
  el('u-email').value = user.email;
  el('u-password').value = '';
  el('u-expiry').value = user.expiry ? user.expiry.slice(0, 16) : '';
  el('u-quota').value = user.quotaMB || 0;
  el('p-naive').checked = protocols.includes('naive');
  el('p-mieru').checked = protocols.includes('mieru');
  el('u-pass-hint').textContent = 'Leave blank to keep current password';
  el('user-modal-error').classList.add('hidden');
  el('user-modal').classList.remove('hidden');
}

function closeUserModal() {
  el('user-modal').classList.add('hidden');
}

async function saveUser() {
  const id = el('user-id').value;
  const username = el('u-username').value.trim();
  const email    = el('u-email').value.trim();
  const password = el('u-password').value;
  const expiry   = el('u-expiry').value ? new Date(el('u-expiry').value).toISOString() : null;
  const quotaMB  = parseInt(el('u-quota').value, 10) || 0;
  const protocols = [];
  if (el('p-naive').checked) protocols.push('naive');
  if (el('p-mieru').checked) protocols.push('mieru');

  if (!username || !email) return showUserError('Username and email are required');
  if (!id && !password)    return showUserError('Password is required for new users');
  if (password && password.length < 8) return showUserError('Password must be at least 8 characters');
  if (!protocols.length)   return showUserError('Select at least one protocol');

  const body = { email, username, expiry, protocols, quotaMB };
  if (password) body.password = password;

  try {
    if (id) {
      await api('PUT', `/api/users/${id}`, body);
      toast('User updated successfully', 'success');
    } else {
      await api('POST', '/api/users', body);
      toast('User created successfully', 'success');
    }
    closeUserModal();
    loadUsers();
  } catch (err) {
    showUserError(err.message);
  }
}

function showUserError(msg) {
  const errEl = el('user-modal-error');
  errEl.textContent = msg;
  errEl.classList.remove('hidden');
}

async function deleteUser(id, username) {
  if (!confirm(`Delete user "${username}"? This will remove their access immediately.`)) return;
  try {
    await api('DELETE', `/api/users/${id}`);
    toast(`User ${username} deleted`, 'success');
    loadUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Config downloads ──────────────────────────────────────────
function openConfigDownload(id) {
  state.selectedUserId = id;
  el('cfg-password').value = '';
  el('naive-link-box').classList.add('hidden');
  el('naive-link-box').textContent = '';
  el('config-modal').classList.remove('hidden');
}

function closeConfigModal() {
  el('config-modal').classList.add('hidden');
}

async function downloadNaiveLink() {
  const password = el('cfg-password').value;
  if (!password) { toast('Enter the user password first', 'error'); return; }
  try {
    const data = await api('GET', `/api/users/${state.selectedUserId}/naive-link?password=${encodeURIComponent(password)}`);
    el('naive-link-box').textContent = data.link;
    el('naive-link-box').classList.remove('hidden');
    copyToClipboard(data.link);
    toast('Naive link copied to clipboard', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

async function downloadMieruConfig() {
  const password = el('cfg-password').value;
  if (!password) { toast('Enter the user password first', 'error'); return; }
  try {
    const res = await fetch(`/api/users/${state.selectedUserId}/mieru-config?password=${encodeURIComponent(password)}`);
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const fn = cd.match(/filename="(.+)"/)?.[1] || 'mieru-config.json';
    downloadBlob(blob, fn);
    toast('Mieru config downloaded', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

async function downloadUniversalConfig() {
  const password = el('cfg-password').value;
  if (!password) { toast('Enter the user password first', 'error'); return; }
  try {
    const res = await fetch(`/api/users/${state.selectedUserId}/universal-config?password=${encodeURIComponent(password)}`);
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const fn = cd.match(/filename="(.+)"/)?.[1] || 'universal-config.json';
    downloadBlob(blob, fn);
    toast('Universal config downloaded', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

// ── Server Settings ───────────────────────────────────────────
async function loadSettings() {
  try {
    const cfg = await api('GET', '/api/config');
    state.config = cfg;
    el('s-naive-port').value  = cfg.naivePort   || 443;
    el('s-mieru-start').value = cfg.mieruPortStart || 2012;
    el('s-mieru-end').value   = cfg.mieruPortEnd   || 2022;
    el('s-mtu').value         = cfg.mtu || 1350;
    const pattern = cfg.trafficPattern || 'NOOP';
    const radio = document.querySelector(`input[name="traffic-pattern"][value="${pattern}"]`);
    if (radio) radio.checked = true;
    document.getElementById('about-version').textContent = cfg.version || '1.0.0';
  } catch {}
}

async function changeNaivePort() {
  const port = parseInt(el('s-naive-port').value, 10);
  try {
    const res = await api('POST', '/api/settings/naive-port', { port });
    showMsg('naive-port-msg', res.message || 'Port updated', true);
    state.config.naivePort = port;
    toast('NaiveProxy port updated — clients need new configs', 'info');
  } catch (err) {
    showMsg('naive-port-msg', err.message, false);
  }
}

async function changeMieruPorts() {
  const portStart = parseInt(el('s-mieru-start').value, 10);
  const portEnd   = parseInt(el('s-mieru-end').value, 10);
  if (!confirm('Changing Mieru ports will restart the Mieru service. Continue?')) return;
  try {
    const res = await api('POST', '/api/settings/mieru-ports', { portStart, portEnd });
    showMsg('mieru-port-msg', res.message || 'Ports updated', true);
    toast('Mieru ports updated — service restarted, clients need new configs', 'info');
  } catch (err) {
    showMsg('mieru-port-msg', err.message, false);
  }
}

async function changeTrafficPattern() {
  const pattern = document.querySelector('input[name="traffic-pattern"]:checked')?.value || 'NOOP';
  const mtu = parseInt(el('s-mtu').value, 10);
  try {
    const res = await api('POST', '/api/settings/traffic-pattern', { pattern, mtu });
    showMsg('traffic-msg', `Pattern: ${res.pattern}, MTU: ${res.mtu}`, true);
    toast('Traffic pattern updated', 'success');
  } catch (err) {
    showMsg('traffic-msg', err.message, false);
  }
}

async function changePassword() {
  const current = el('s-cur-pass').value;
  const newPass  = el('s-new-pass').value;
  const confirm2 = el('s-new-pass2').value;
  if (!current || !newPass) return showMsg('pw-msg', 'All fields required', false);
  if (newPass !== confirm2)  return showMsg('pw-msg', 'Passwords do not match', false);
  if (newPass.length < 8)   return showMsg('pw-msg', 'New password must be at least 8 characters', false);
  try {
    await api('POST', '/api/config/password', { current, newPass });
    showMsg('pw-msg', 'Password changed successfully', true);
    el('s-cur-pass').value = '';
    el('s-new-pass').value = '';
    el('s-new-pass2').value = '';
    toast('Password changed', 'success');
  } catch (err) {
    showMsg('pw-msg', err.message, false);
  }
}

// ── Monitoring ────────────────────────────────────────────────
async function loadMonitoring() {
  refreshStats();
}

async function refreshStats() {
  try {
    const [status, stats] = await Promise.all([
      api('GET', '/api/status'),
      api('GET', '/api/stats/users'),
    ]);

    // Metric chips (may be updated by WS too)
    el('m-cpu').textContent   = `${status.system.cpuPercent}%`;
    el('m-ram').textContent   = `${fmtMB(status.system.ramUsedMB)}/${fmtMB(status.system.ramTotalMB)}`;
    el('m-naive').innerHTML   = badge(status.services.naive.active, 'Active', 'Inactive');
    el('m-mieru').innerHTML   = badge(status.services.mieru.active, 'Active', 'Inactive');
    el('m-uptime').textContent = fmtUptime(status.system.uptime);

    renderTrafficTable(stats);
  } catch (err) {
    console.error('Monitoring error:', err);
  }
}

function renderTrafficTable(stats) {
  const tbody = el('traffic-tbody');
  if (!stats.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No users yet</td></tr>';
    return;
  }
  tbody.innerHTML = stats.map(u => {
    const quotaMB = u.quotaMB || 0;
    const usedMB  = u.usedMB || 0;
    const pct     = quotaMB > 0 ? Math.min(100, Math.round((usedMB / quotaMB) * 100)) : 0;
    const warn    = pct > 80;
    const danger  = pct > 95;
    const quotaCell = quotaMB > 0
      ? `<div style="display:flex;align-items:center;gap:8px">
          <div class="quota-bar"><div class="quota-fill${danger?' danger':warn?' warn':''}" style="width:${pct}%"></div></div>
          <span style="font-size:11px;color:${danger?'var(--red)':warn?'var(--yellow)':'var(--text-muted)'}">${pct}%</span>
         </div>`
      : '<span class="badge badge-gray">Unlimited</span>';

    return `<tr>
      <td><strong>${esc(u.username)}</strong></td>
      <td>${fmtNum(u.uploadMB)}</td>
      <td>${fmtNum(u.downloadMB)}</td>
      <td>${fmtNum(usedMB)}</td>
      <td>${quotaMB > 0 ? fmtNum(quotaMB) : '∞'}</td>
      <td>${quotaCell}</td>
      <td>${u.expiry ? fmtDate(u.expiry) : '—'}</td>
      <td>${fmtDate(u.lastSeen)}</td>
    </tr>`;
  }).join('');
}

// ── Logs ──────────────────────────────────────────────────────
async function loadLogs(service) {
  currentLogService = service;
  ['caddy', 'mieru', 'panel'].forEach(s => {
    el(`log-btn-${s}`)?.classList.toggle('active', s === service);
  });
  const lines = el('log-lines')?.value || 100;
  el('log-content').textContent = 'Loading…';
  try {
    const data = await api('GET', `/api/logs/${service}?lines=${lines}`);
    el('log-content').textContent = data.logs || '(empty)';
    el('log-content').scrollTop = el('log-content').scrollHeight;
  } catch (err) {
    el('log-content').textContent = `Error: ${err.message}`;
  }
}

// ── Diagnostics ───────────────────────────────────────────────
async function runDiagnostics() {
  el('diag-ports').innerHTML   = '<p class="text-muted">Checking…</p>';
  el('diag-config').innerHTML  = '<p class="text-muted">Checking…</p>';
  el('diag-mita-status').textContent = 'Loading…';
  el('diag-mita-config').textContent = 'Loading…';

  try {
    const data = await api('GET', '/api/diagnostics');

    // Ports
    el('diag-ports').innerHTML = `
      <div class="info-list">
        <div class="info-row">
          <span>NaiveProxy port ${state.config.naivePort || 443}</span>
          <span>${data.ports?.naive ? '<span class="badge badge-green">Open</span>' : '<span class="badge badge-red">Closed</span>'}</span>
        </div>
        <div class="info-row">
          <span>Mieru port ${state.config.mieruPortStart || 2012}</span>
          <span>${data.ports?.mieru ? '<span class="badge badge-green">Open</span>' : '<span class="badge badge-red">Closed</span>'}</span>
        </div>
      </div>`;

    // Config validation
    el('diag-config').innerHTML = data.caddyConfigValid
      ? '<span class="badge badge-green">Caddyfile valid ✓</span>'
      : `<span class="badge badge-red">Caddyfile invalid</span><pre class="mini-log mt-2">${esc(data.caddyConfigError || '')}</pre>`;

    el('diag-mita-status').textContent = data.mitaStatus   || '(no output)';
    el('diag-mita-config').textContent = data.mitaConfig   || '(no output)';
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Service control ───────────────────────────────────────────
async function svcAction(service, action) {
  try {
    await api('POST', `/api/service/${service}/${action}`);
    toast(`${service}: ${action} OK`, 'success');
    setTimeout(loadDashboard, 1500);
  } catch (err) {
    toast(`${service} ${action} failed: ${err.message}`, 'error');
  }
}

// ── WebSocket: live metrics ───────────────────────────────────
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
          // Update monitoring chips if on that page
          if (state.currentPage === 'monitoring') {
            el('m-cpu').textContent  = `${msg.cpu}%`;
            el('m-ram').textContent  = `${fmtMB(msg.ramUsedMB)}/${fmtMB(msg.ramTotalMB)}`;
            el('m-naive').innerHTML  = badge(msg.naive, 'Active', 'Inactive');
            el('m-mieru').innerHTML  = badge(msg.mieru, 'Active', 'Inactive');
          }
          // Update dashboard service indicators if on that page
          if (state.currentPage === 'dashboard') {
            el('d-naive-status').innerHTML = badge(msg.naive, 'Active', 'Inactive');
            el('d-mieru-status').innerHTML = badge(msg.mieru, 'Active', 'Inactive');
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

// ── HTTP helper ───────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(path, opts);
  const ct  = res.headers.get('Content-Type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();

  if (!res.ok) {
    const msg = (typeof data === 'object' && data.error) ? data.error : String(data);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return data;
}

// ── UI helpers ────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
    return new Date(iso).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric'
    });
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
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select(); document.execCommand('copy');
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
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = {
    success: '✓',
    error:   '✗',
    info:    'ℹ',
  };
  toast.innerHTML = `<span style="font-weight:700;font-size:14px">${icons[type] || 'ℹ'}</span><span>${esc(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}
