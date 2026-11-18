const $ = (id) => document.getElementById(id);

let state = null;
let view = 'join';
let joining = false;
let dismissedError = null;

async function api(route, body) {
  const res = await fetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function flash(button, label = 'скопировано') {
  const original = button.textContent;
  button.textContent = label;
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

function statusLabel(status) {
  return { idle: 'выключено', connecting: 'подключение', connected: 'в сети', error: 'ошибка' }[status] || status;
}

function render() {
  if (!state) return;
  const joined = state.profile.joined;
  const nextView = joined ? 'app' : 'join';
  if (nextView !== view) {
    view = nextView;
    $('joinView').hidden = view !== 'join';
    $('appView').hidden = view !== 'app';
    if (view === 'join') {
      $('serverUrl').value = state.profile.serverUrl || '';
      $('deviceName').value = state.profile.deviceName || '';
    }
  }

  // status pill
  const pill = $('statusPill');
  pill.className = 'pill';
  if (state.status === 'connected') pill.classList.add('on');
  else if (state.status === 'connecting') pill.classList.add('busy');
  else if (state.status === 'error') pill.classList.add('err');
  $('statusText').textContent = statusLabel(state.status);
  if (joined) {
    const name = state.profile.network?.name || '';
    const subnet = state.profile.network?.subnet || '';
    $('netName').textContent = subnet ? `${name} · ${subnet}` : name;
  }

  const toggle = $('toggle');
  toggle.setAttribute('aria-pressed', state.status === 'connected' ? 'true' : 'false');
  toggle.disabled = state.status === 'connecting';

  // error banner
  const banner = $('banner');
  if (state.error && state.error !== dismissedError) {
    banner.hidden = false;
    banner.textContent = state.error;
    banner.className = 'banner';
  } else {
    banner.hidden = true;
  }

  if (!joined) return;

  renderHero();
  renderPeers();
  renderNetwork();
  renderMinecraft();
  renderDiagnostics();
}

function renderHero() {
  const self = state.profile.self;
  const connecting = state.status === 'connecting';
  $('selfIp').textContent = connecting ? 'подключение…' : self?.ip || '—';
  $('selfIp').style.opacity = connecting ? '.55' : '1';

  const hints = {
    idle: 'сеть выключена — нажмите переключатель справа сверху',
    connecting: 'проверяю порты, это занимает до 10 секунд',
    connected: 'друзья подключаются к вам по этому адресу',
    error: 'нет подключения, подробности в диагностике',
  };
  $('selfHint').textContent = hints[state.status] || '';

  const online = (state.peers || []).filter((peer) => peer.online).length;
  $('onlineCount').textContent = String(state.status === 'connected' ? online : 0);
  $('portValue').textContent = state.port || '—';
  const pings = Object.values(state.pings || {}).filter((value) => typeof value === 'number');
  $('pingValue').textContent = pings.length ? `${Math.min(...pings)}` : '—';
}

function renderPeers() {
  const peers = state.peers || [];
  $('peersCount').textContent = peers.length ? `${peers.filter((p) => p.online).length} из ${peers.length}` : '';

  if (!peers.length) {
    $('peers').innerHTML = '<div class="empty">Пока никого нет. Отправьте друзьям код приглашения.</div>';
    return;
  }

  const sorted = [...peers].sort((a, b) => {
    if (a.self !== b.self) return a.self ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const tunnelUp = state.status === 'connected';

  $('peers').innerHTML = sorted
    .map((peer) => {
      const online = tunnelUp && peer.online;
      const ping = state.pings?.[peer.ip];
      const pingClass = ping == null ? '' : ping < 60 ? 'good' : ping > 200 ? 'bad' : '';
      const pingText = peer.self ? 'вы' : online ? (ping == null ? '—' : `${ping} мс`) : 'офлайн';
      const address = peer.lanPort ? `${peer.ip}:${peer.lanPort}` : null;
      const canJoin = !peer.self && online && address;
      return `
        <div class="peer ${online ? 'online' : ''}">
          <span class="dot"></span>
          <span class="name">${escapeHtml(peer.name)}${peer.self ? '<span class="self-tag">это вы</span>' : ''}${
            address && !peer.self ? '<span class="self-tag world">мир открыт</span>' : ''
          }</span>
          <span class="ip">${escapeHtml(peer.ip)}</span>
          <span class="ping ${pingClass}">${pingText}</span>
          ${canJoin ? `<button class="play" data-play="${escapeHtml(address)}" data-name="${escapeHtml(peer.name)}">Зайти</button>` : ''}
          <button class="copy" data-copy="${escapeHtml(peer.ip)}">IP</button>
        </div>`;
    })
    .join('');
}

function renderNetwork() {
  const p = state.profile;
  $('inviteCode').textContent = p.invite || '—';
  const host = p.server?.host || '';
  const port = p.server?.ports?.[0];
  $('serverAddr').textContent = host ? `${host}${port ? `:${port}` : ''}` : '—';
  $('subnet').textContent = p.network?.subnet || '—';
  $('mtu').textContent = String(p.mtu || 1280);
}

function renderMinecraft() {
  const self = state.profile.self;
  const mc = state.minecraft;
  const line = $('mcLine');
  const tag = $('mcTag');
  if (mc && mc.port && state.status === 'connected') {
    tag.textContent = 'открыт для сети';
    tag.className = 'tag live';
    line.hidden = false;
    $('mcAddr').textContent = `${self.ip}:${mc.port}`;
    $('mcText').innerHTML = 'Мир открыт. Друзья видят кнопку <b>«Зайти»</b> в списке — она добавит адрес в «Сетевую игру» сама.';
  } else {
    tag.textContent = 'не найден';
    tag.className = 'tag';
    line.hidden = true;
    $('mcText').innerHTML =
      'Откройте мир и нажмите <b>«Открыть для сети»</b> — адрес для друзей появится здесь.';
  }
}

function renderDiagnostics() {
  const good = (value) => (value ? 'ok' : 'bad');
  $('dHelper').textContent = state.helper ? 'работает' : 'нет';
  $('dHelper').className = good(state.helper);
  $('dAwg').textContent = state.awg ? 'установлен' : 'не найден';
  $('dAwg').className = good(state.awg);
  $('dIface').textContent = state.tunnel?.up ? 'поднят' : state.tunnel?.exists ? 'опущен' : 'нет';
  $('dIface').className = good(state.tunnel?.up);

  const lines = (state.log || []).slice(-12).map((entry) => {
    const time = new Date(entry.at).toLocaleTimeString('ru-RU', { hour12: false });
    return `${time}  ${entry.message}`;
  });
  $('logBox').textContent = lines.join('\n') || '—';
}

// ------------------------------------------------------------------ actions

$('toggle').addEventListener('click', async () => {
  if (!state) return;
  dismissedError = null;
  if (state.status === 'connected' || state.status === 'connecting') {
    await api('/api/disconnect');
  } else {
    const result = await api('/api/connect');
    if (result && result.ok === false) {
      state.error = result.error;
      state.status = 'error';
    }
  }
  poll();
});

$('joinBtn').addEventListener('click', async () => {
  if (joining) return;
  joining = true;
  const button = $('joinBtn');
  button.disabled = true;
  button.textContent = 'Подключаюсь…';
  $('joinError').hidden = true;
  try {
    const result = await api('/api/join', {
      serverUrl: $('serverUrl').value.trim(),
      invite: $('invite').value.trim(),
      name: $('deviceName').value.trim(),
    });
    if (!result.ok) {
      $('joinError').hidden = false;
      $('joinError').textContent = result.error === 'server_required'
        ? 'Укажите адрес сервера.'
        : result.error === 'invite_required'
          ? 'Введите код приглашения.'
          : result.error;
      return;
    }
    view = 'join';
    await poll();
    await api('/api/connect');
  } finally {
    joining = false;
    button.disabled = false;
    button.textContent = 'Подключиться';
  }
});

$('invite').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('joinBtn').click();
});

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-copy]');
  if (target) {
    await copy(target.dataset.copy);
    flash(target, 'ок');
  }
});

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-play]');
  if (!target) return;
  const address = target.dataset.play;
  const result = await api('/api/minecraft/add', { ip: address, name: `Nurofen · ${target.dataset.name || address}` });
  if (!result?.ok) {
    toast(result?.error === 'bad_address' ? 'Некорректный адрес мира' : 'Не удалось записать servers.dat');
    return;
  }
  await copy(address);
  toast(`Мир добавлен в «Сетевая игра» — ${address}`);
});

let toastTimer = null;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.remove('show');
    toastTimer = setTimeout(() => { node.hidden = true; }, 220);
  }, 3800);
}

$('copyIp').addEventListener('click', async () => {
  if (state?.profile?.self && (await copy(state.profile.self.ip))) flash($('copyIp'), 'скопировано');
});

$('copyInvite').addEventListener('click', async () => {
  if (state?.profile?.invite && (await copy(state.profile.invite))) flash($('copyInvite'), 'скопировано');
});

$('copyMc').addEventListener('click', async () => {
  const address = $('mcAddr').textContent;
  if (address && (await copy(address))) flash($('copyMc'), 'скопировано');
});

$('leaveBtn').addEventListener('click', async () => {
  if (!confirm('Выйти из сети? Придётся заново вводить код приглашения.')) return;
  await api('/api/forget');
  view = 'join';
  dismissedError = null;
  poll();
});

$('phoneBtn').addEventListener('click', async () => {
  const name = prompt('Имя устройства (например, «Телефон Миши»)', 'Телефон');
  if (!name) return;
  const result = await api('/api/export-device', { name });
  if (!result.ok) {
    alert(result.error || 'Не удалось создать конфиг');
    return;
  }
  const blob = new Blob([result.config], { type: 'text/plain' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `nurofen-${result.ip}.conf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
});

async function poll() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    state = await res.json();
    render();
  } catch {
    // the app is stopping or restarting
  }
}

poll();
setInterval(poll, 1500);
