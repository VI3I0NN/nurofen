export const adminPage = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nurofen — панель</title>
<style>
  :root {
    --bg: #0b0e13;
    --panel: #12161d;
    --panel-2: #171d26;
    --line: #222b37;
    --text: #e7edf5;
    --muted: #8592a3;
    --ok: #35d07f;
    --warn: #f0b429;
    --bad: #ef5350;
    --accent: #4c8dff;
    --mono: ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 22px; border-bottom: 1px solid var(--line);
    background: #0d1117; position: sticky; top: 0; z-index: 5;
  }
  .mark {
    width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center;
    background: #10241b; border: 1px solid #1e4130; color: var(--ok);
    font-weight: 700; font-size: 13px;
  }
  header h1 { font-size: 14px; font-weight: 600; margin: 0; letter-spacing: .2px; }
  header .sub { color: var(--muted); font-size: 12px; }
  main { max-width: 1060px; margin: 0 auto; padding: 22px; display: grid; gap: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px;
  }
  .card h2 {
    margin: 0 0 10px; font-size: 11px; font-weight: 600; letter-spacing: .09em;
    text-transform: uppercase; color: var(--muted);
  }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 13px; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; font-family: var(--mono); font-size: 12.5px; }
  .stat { font-size: 22px; font-variant-numeric: tabular-nums; font-weight: 600; }
  .stat small { font-size: 12px; color: var(--muted); font-weight: 400; margin-left: 4px; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 999px;
    font-size: 12px; border: 1px solid var(--line); background: var(--panel-2); color: var(--muted);
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .dot.on { background: var(--ok); box-shadow: 0 0 0 3px rgba(53,208,127,.12); }
  .dot.off { background: #3d4757; }
  .netname { font-weight: 600; }
  .subnet { font-family: var(--mono); font-size: 12px; color: #9fe8bd; }
  button {
    font: inherit; font-size: 13px; padding: 7px 12px; border-radius: 7px; cursor: pointer;
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
  }
  button:hover { border-color: #33414f; background: #1b222c; }
  button.primary { background: #14361f; border-color: #275c36; color: #b7f5cd; }
  button.danger { color: #ffb4b4; border-color: #4a2323; background: #221314; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .07em; }
  tr:last-child td { border-bottom: 0; }
  td.mono { font-family: var(--mono); font-size: 12.5px; }
  .muted { color: var(--muted); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .create { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; margin-top: 12px; }
  .toast {
    position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
    background: #16202b; border: 1px solid var(--line); padding: 9px 16px; border-radius: 8px;
    font-size: 13px; opacity: 0; pointer-events: none; transition: opacity .18s;
  }
  .toast.show { opacity: 1; }
  input {
    font: inherit; font-family: var(--mono); padding: 8px 10px; border-radius: 7px;
    background: #0d121a; color: var(--text); border: 1px solid var(--line); width: 100%;
  }
  .login { max-width: 380px; margin: 80px auto; }
  @media (max-width: 640px) {
    .create { grid-template-columns: 1fr; }
    table { font-size: 12px; }
    th, td { padding: 6px; }
  }
</style>
</head>
<body>
<header>
  <div class="mark">N</div>
  <div>
    <h1>Nurofen</h1>
    <div class="sub">панель управления сервером</div>
  </div>
  <div style="margin-left:auto" id="health"></div>
</header>

<main id="root">
  <div class="card login" id="login">
    <h2>Токен администратора</h2>
    <p class="muted" style="margin-top:0">Лежит на сервере в <code>/etc/nurofen/nurofen.json</code> → <code>adminToken</code>.</p>
    <div class="row">
      <input id="token" type="password" placeholder="adminToken" autocomplete="off">
      <button class="primary" onclick="login()">Войти</button>
    </div>
  </div>
</main>

<div class="toast" id="toast"></div>

<script>
const state = { token: localStorage.getItem('nurofen-admin') || '', data: null };

function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'authorization': 'Bearer ' + state.token, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 401) { logout(); throw new Error('unauthorized'); }
  if (!res.ok) {
    let code = 'http ' + res.status;
    try { const body = await res.json(); if (body && body.error) code = body.error; } catch {}
    throw new Error(code);
  }
  return res.json();
}

function login() {
  state.token = document.getElementById('token').value.trim();
  localStorage.setItem('nurofen-admin', state.token);
  refresh().catch(() => toast('Неверный токен'));
}

function logout() {
  localStorage.removeItem('nurofen-admin');
  state.token = '';
  document.getElementById('root').innerHTML = '<div class="card login"><h2>Сессия истекла</h2><button onclick="location.reload()">Войти заново</button></div>';
}

const fmtBytes = (n) => {
  if (n === null || n === undefined) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return v.toFixed(i ? 1 : 0) + ' ' + units[i];
};

const ago = (iso) => {
  if (!iso) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return seconds + ' с назад';
  if (seconds < 3600) return Math.round(seconds / 60) + ' мин назад';
  return Math.round(seconds / 3600) + ' ч назад';
};

function render(data) {
  const online = data.peers.filter((peer) => peer.online).length;
  document.getElementById('health').innerHTML =
    '<span class="pill"><span class="dot ' + (data.awg.up ? 'on' : 'off') + '"></span>' +
    (data.awg.up ? 'туннель активен' : 'туннель выключен') + '</span>';

  document.getElementById('root').innerHTML = \`
    <div class="grid">
      <div class="card"><h2>Сети</h2><div class="stat">\${data.networks.length}</div></div>
      <div class="card"><h2>В сети</h2><div class="stat">\${online}<small>из \${data.peers.length}</small></div></div>
      <div class="card"><h2>Адресное пространство</h2><div class="stat" style="font-family:var(--mono);font-size:16px">\${data.subnet}</div></div>
      <div class="card"><h2>Порт AWG</h2><div class="stat">\${data.server.awgPort}<small>udp</small></div></div>
    </div>

    <div class="card">
      <h2>Сети пользователей</h2>
      \${data.networks.length ? \`<table>
        <thead><tr><th>Название</th><th>Подсеть</th><th>Устройств</th><th>Создана</th><th></th></tr></thead>
        <tbody>\${data.networks.map((net) => \`
          <tr>
            <td class="netname">\${escapeHtml(net.name)}</td>
            <td class="subnet">\${net.subnet}</td>
            <td>\${net.peers}</td>
            <td class="muted">\${ago(net.createdAt)}</td>
            <td style="text-align:right"><div class="row" style="justify-content:flex-end">
              <button onclick="setPassword('\${net.id}','\${escapeHtml(net.name)}')">Сменить пароль</button>
              <button class="danger" onclick="removeNetwork('\${net.id}','\${escapeHtml(net.name)}')">Удалить</button>
            </div></td>
          </tr>\`).join('')}</tbody>
      </table>\` : '<p class="muted" style="margin:0">Пока никто не создал сеть. Друзья делают это в клиенте Nurofen.</p>'}
      <div class="create">
        <input id="newNetName" type="text" placeholder="Название новой сети" maxlength="32">
        <input id="newNetPass" type="password" placeholder="Пароль (не короче 4 символов)" maxlength="64">
        <button class="primary" onclick="createNetwork()">Создать</button>
      </div>
    </div>

    <div class="card">
      <h2>Устройства</h2>
      \${data.peers.length ? \`<table>
        <thead><tr><th>Имя</th><th>Сеть</th><th>IP</th><th>Статус</th><th>Трафик</th><th>Активность</th><th></th></tr></thead>
        <tbody>\${data.peers.map((peer) => \`
          <tr>
            <td>\${escapeHtml(peer.name)}</td>
            <td class="muted">\${peer.network ? escapeHtml(peer.network.name) : '—'}</td>
            <td class="mono">\${peer.ip}</td>
            <td><span class="pill"><span class="dot \${peer.online ? 'on' : 'off'}"></span>\${peer.online ? 'онлайн' : 'офлайн'}</span></td>
            <td class="muted mono">↓\${fmtBytes(peer.rx)} ↑\${fmtBytes(peer.tx)}</td>
            <td class="muted">\${ago(peer.lastSeen)}</td>
            <td style="text-align:right"><button class="danger" onclick="kick('\${peer.id}','\${escapeHtml(peer.name)}')">Отключить</button></td>
          </tr>\`).join('')}</tbody>
      </table>\` : '<p class="muted" style="margin:0">Пока никто не подключился.</p>'}
    </div>

    <div class="grid">
      <div class="card">
        <h2>Обфускация (AmneziaWG)</h2>
        <dl class="kv">
          \${Object.entries(data.obfuscation).map(([key, value]) => '<dt>' + key + '</dt><dd>' + value + '</dd>').join('')}
        </dl>
      </div>
      <div class="card">
        <h2>Сервер</h2>
        <dl class="kv">
          <dt>адрес</dt><dd>\${data.server.publicHost}</dd>
          <dt>интерфейс</dt><dd>\${data.server.iface}</dd>
          <dt>пул портов</dt><dd>\${data.server.ports.join(', ')}</dd>
          <dt>MTU</dt><dd>\${data.server.mtu}</dd>
          <dt>API</dt><dd>\${location.host}</dd>
        </dl>
        <div class="row" style="margin-top:12px">
          <button onclick="restartTunnel()">Перезапустить туннель</button>
        </div>
      </div>
    </div>
  \`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refresh() {
  const data = await api('/api/v1/admin/overview');
  state.data = data;
  render(data);
}

async function createNetwork() {
  const name = document.getElementById('newNetName').value.trim();
  const password = document.getElementById('newNetPass').value;
  if (!name || password.length < 4) { toast('Нужны название и пароль от 4 символов'); return; }
  try {
    await api('/api/v1/admin/networks', { method: 'POST', body: JSON.stringify({ name, password }) });
    toast('Сеть создана');
    refresh();
  } catch (error) {
    toast(error.message === 'network_exists' ? 'Сеть с таким названием уже есть' : 'Не удалось создать сеть');
  }
}

async function setPassword(id, name) {
  const password = prompt('Новый пароль для сети «' + name + '» (не короче 4 символов)');
  if (password === null) return;
  if (password.length < 4) { toast('Пароль слишком короткий'); return; }
  try {
    await api('/api/v1/admin/networks/' + id + '/password', { method: 'POST', body: JSON.stringify({ password }) });
    toast('Пароль изменён');
    refresh();
  } catch {
    toast('Не удалось сменить пароль');
  }
}

async function removeNetwork(id, name) {
  if (!confirm('Удалить сеть «' + name + '»? Все устройства в ней потеряют доступ.')) return;
  try {
    await api('/api/v1/admin/networks/' + id, { method: 'DELETE' });
    toast('Сеть удалена');
    refresh();
  } catch {
    toast('Не удалось удалить сеть');
  }
}

async function kick(id, name) {
  if (!confirm('Отключить «' + name + '»?')) return;
  await api('/api/v1/admin/peers/' + id, { method: 'DELETE' });
  toast('Устройство отключено');
  refresh();
}

async function restartTunnel() {
  await api('/api/v1/admin/awg/restart', { method: 'POST' });
  toast('Туннель перезапущен');
  refresh();
}

if (state.token) {
  refresh().catch(() => {});
  setInterval(() => { refresh().catch(() => {}); }, 5000);
} else {
  document.getElementById('login').style.display = 'block';
}
</script>
</body>
</html>`;
