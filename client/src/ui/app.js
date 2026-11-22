const $ = (id) => document.getElementById(id);

const STATUS_LABELS = {
  idle: 'Не в сети',
  connecting: 'Подключение',
  connected: 'В сети',
  error: 'Ошибка',
};

const PANES = {
  nickname: ['paneNickname', 'Изменить ник'],
  diagnostics: ['paneDiagnostics', 'Диагностика'],
  settings: ['paneSettings', 'Настройки'],
  update: ['paneUpdate', 'Обновления'],
  about: ['paneAbout', 'О программе'],
};

// Settings, updates and the other utility panes live in their own windows.
// The query string selects the pane when such a window loads this page.
const TOOL_KIND = new URLSearchParams(location.search).get('tool');
const TOOL_SIZES = {
  nickname: [340, 300],
  settings: [360, 560],
  update: [360, 560],
  diagnostics: [400, 600],
  about: [340, 400],
};

const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';

let state = null;
let activeId = null;
let joinOpen = false;
let joinMode = 'join';
let joining = false;
let polling = false;
let modalKind = null;
let toastTimer = null;
// The settings window polls every couple of seconds; never overwrite a path
// the user is typing or has just picked but not saved yet.
let mcPathDirty = false;
let mcServerPathDirty = false;

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
    // Clipboard API can be blocked in a plain browser tab; fall back below.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.remove('show');
    toastTimer = setTimeout(() => {
      node.hidden = true;
    }, 220);
  }, 3400);
}

/* ------------------------------------------------------------------ render */

function networks() {
  return state?.networks || [];
}

function activeNetwork() {
  const list = networks();
  return list.find((item) => item.id === activeId) || list.find((item) => item.id === state?.activeId) || list[0] || null;
}

function render() {
  if (!state) return;
  document.body.classList.toggle('compact-peers', state.settings?.compactPeers === true);
  if (!networks().length) joinOpen = true;
  if (joinOpen) {
    applyView('join');
    $('joinBack').hidden = !networks().length;
  } else {
    applyView('app');
    renderTabs();
    renderHero();
    renderDirect();
    renderMinecraft();
    renderPeers();
    renderStatusbar();
  }
  renderMenu();
  renderModal();
}

function applyView(view) {
  $('joinView').hidden = view !== 'join';
  $('appView').hidden = view !== 'app';
  $('statusbar').hidden = view !== 'app';
  if (view === 'join' && !$('deviceName').value) $('deviceName').value = state?.deviceName || '';
}

function renderTabs() {
  $('netTabs').innerHTML = networks()
    .map((item) => {
      const current = item.id === activeNetwork()?.id;
      const dot = item.status === 'connected' ? 'on' : item.status === 'connecting' ? 'busy' : item.status === 'error' ? 'err' : '';
      return `
        <button type="button" class="net-tab ${current ? 'active' : ''}" data-net="${escapeHtml(item.id)}" role="tab"
                aria-selected="${current ? 'true' : 'false'}" title="${escapeHtml(item.network?.name || '')}">
          <span class="net-dot ${dot}"></span>
          <span class="net-tab-name">${escapeHtml(item.network?.name || 'Сеть')}</span>
        </button>`;
    })
    .join('');
}

function renderHero() {
  const net = activeNetwork();
  if (!net) return;
  const status = net.status || 'idle';
  const button = $('powerBtn');
  button.className = 'power-ring';
  if (status === 'connected') button.classList.add('on');
  else if (status === 'connecting') button.classList.add('busy');
  else if (status === 'error') button.classList.add('err');
  button.disabled = status === 'connecting';
  button.setAttribute('aria-pressed', status === 'connected' ? 'true' : 'false');
  button.title = status === 'connected' ? 'Отключить сеть' : 'Включить сеть';

  $('powerLabel').textContent = { connected: 'ON', connecting: '…', error: '!', idle: 'OFF' }[status] || 'OFF';
  $('selfName').textContent = net.self?.name || state.deviceName || 'Устройство';
  $('selfIp').textContent = status === 'connecting' ? 'подключение…' : net.self?.ip || '—';

  const pill = $('statusPill');
  pill.className = 'pill';
  if (status === 'connected') pill.classList.add('on');
  else if (status === 'connecting') pill.classList.add('busy');
  else if (status === 'error') pill.classList.add('err');
  $('statusText').textContent = STATUS_LABELS[status] || status;
}

function renderDirect() {
  const net = activeNetwork();
  const toggle = $('directToggle');
  const hint = $('directHint');
  if (!net) {
    toggle.checked = false;
    toggle.disabled = true;
    hint.textContent = '';
    hint.classList.remove('on');
    return;
  }
  toggle.checked = Boolean(net.direct);
  toggle.disabled = net.status === 'connecting';
  hint.classList.toggle('on', Boolean(net.direct));
  if (!net.direct) {
    hint.textContent = 'Нужно включить у обоих';
    return;
  }
  if (net.status !== 'connected') {
    hint.textContent = 'Включится вместе с сетью';
    return;
  }
  const modes = Object.values(net.directModes || {});
  const direct = modes.filter((mode) => mode === 'direct').length;
  const trying = modes.filter((mode) => mode === 'trying').length;
  const stale = modes.filter((mode) => mode === 'stale').length;
  const relay = modes.filter((mode) => mode === 'relay').length;
  if (direct) {
    hint.textContent = `Напрямую: ${direct}`;
    return;
  }
  if (trying) {
    hint.textContent = 'Проверяю…';
    return;
  }
  if (stale) {
    const names = (net.peers || [])
      .filter((peer) => net.directModes?.[peer.ip] === 'stale')
      .map((peer) => peer.name);
    hint.textContent = names.length
      ? `У ${names.join(', ')} старая служба`
      : 'У участника старая служба';
    return;
  }
  if (relay) {
    hint.textContent = 'Прямой канал не поднялся';
    return;
  }
  const others = (net.peers || []).filter((peer) => !peer.self && peer.online);
  if (!others.length) hint.textContent = 'Нет других участников';
  else if (!others.some((peer) => peer.direct)) hint.textContent = 'У других режим выключен';
  else hint.textContent = 'Нет подходящих участников';
}

function renderMinecraft() {
  const panel = $('mcPanel');
  const installed = state?.minecraftInstalled === true;
  const mc = state?.minecraft || {};
  const server = state?.minecraftServer || {};
  panel.hidden = false;

  const net = activeNetwork();
  const connected = net?.status === 'connected' && Boolean(net?.self?.ip);
  const serverReady = server.running === true && Boolean(server.port);
  const lanOpen = installed && Boolean(mc.port) && connected;
  const sharedPort = serverReady ? server.port : (lanOpen ? mc.port : null);
  const open = Boolean(sharedPort) && connected;

  const pathLabel = $('mcPath');
  const shown = serverReady ? server.dir : (mc.dir || mc.configured || server.configured || '');
  pathLabel.textContent = shown;
  pathLabel.title = shown;
  pathLabel.hidden = !shown;

  if (open) {
    $('mcState').textContent = serverReady ? 'сервер запущен' : 'мир открыт';
    $('mcState').classList.add('on');
    $('mcWorld').hidden = false;
    $('mcHint').hidden = true;
    const address = `${net.self.ip}:${sharedPort}`;
    $('mcAddr').textContent = address;
    $('mcAddr').title = address;
    return;
  }

  $('mcWorld').hidden = true;
  $('mcHint').hidden = false;
  $('mcState').textContent = serverReady ? 'сервер запущен' : (installed ? 'не открыт' : 'не найден');
  $('mcState').classList.toggle('on', serverReady);

  if (serverReady) {
    $('mcHint').textContent = 'Включите сеть, чтобы поделиться сервером.';
  } else if (server.dir) {
    $('mcHint').textContent = `Сервер найден, но не запущен · порт ${server.port || 25565}.`;
  } else if (server.configured) {
    $('mcHint').textContent = 'Папка сервера не найдена — проверьте путь в настройках.';
  } else if (!installed) {
    $('mcHint').textContent = mc.configured
      ? 'В указанной папке Minecraft не найден — проверьте путь в настройках.'
      : 'Minecraft не найден — укажите папку в настройках.';
  } else {
    $('mcHint').textContent = connected
      ? 'Откройте мир и нажмите «Открыть для сети».'
      : 'Включите сеть, чтобы поделиться миром.';
  }
}

function peerTone(name) {
  let hash = 0;
  for (const char of String(name || '')) hash = (hash + char.charCodeAt(0)) % 5;
  return `tone-${hash + 1}`;
}

function initials(name) {
  const text = String(name || '?').trim();
  return (text[0] || '?').toUpperCase();
}

function renderPeers() {
  const net = activeNetwork();
  if (!net) return;
  const peers = net.peers || [];
  const onlineCount = peers.filter((peer) => peer.self ? net.status === 'connected' : peer.online).length;
  $('peersCount').textContent = peers.length ? `${onlineCount} из ${peers.length}` : '';

  if (!peers.length) {
    $('peers').innerHTML = '<div class="empty">Пока никого нет.<br>Сообщите друзьям название сети и пароль.</div>';
    return;
  }

  const sorted = [...peers].sort((a, b) => {
    if (a.self !== b.self) return a.self ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return String(a.name || '').localeCompare(String(b.name || ''), 'ru');
  });

  const tunnelUp = net.status === 'connected';

  $('peers').innerHTML = sorted
    .map((peer) => {
      const online = peer.self ? tunnelUp : peer.online;
      const ping = net.pings?.[peer.ip];
      const pingClass = ping == null ? '' : ping <= 80 ? 'good' : ping > 160 ? 'bad' : 'warn';
      const pingText = peer.self ? '—' : !tunnelUp || !online ? '—' : ping == null ? 'нет ответа' : `${ping} мс`;
      const mode = net.directModes?.[peer.ip];
      const routeText = net.direct && online && !peer.self
        ? (mode === 'direct' ? ' · напрямую'
          : mode === 'trying' ? ' · проверяю'
            : mode === 'stale' ? ' · нужен перезапуск'
              : ' · через сервер')
        : '';
      const world = tunnelUp && online && !peer.self && state.minecraftInstalled && peer.lanPort
        ? `${peer.ip}:${peer.lanPort}`
        : null;
      const playButton = world
        ? `<button type="button" class="mc-play" data-play="${escapeHtml(world)}" data-name="${escapeHtml(peer.name)}" title="Добавить мир ${escapeHtml(world)} в «Сетевую игру»">Зайти</button>`
        : '';
      return `
        <div class="peer ${online ? 'online' : ''}">
          <span class="avatar ${peerTone(peer.name)}">${escapeHtml(initials(peer.name))}</span>
          <div class="peer-main">
            <span class="name"><span class="name-text">${escapeHtml(peer.name)}</span>${peer.self ? '<span class="tag-self">вы</span>' : ''}</span>
            <span class="peer-sub"><span class="ip">${escapeHtml(peer.ip)}</span>${playButton}</span>
          </div>
          <span class="peer-connection"><span class="presence ${online ? 'online' : ''}">${online ? 'В сети' : 'Не в сети'}</span><span class="ping ${pingClass}" title="Время ответа участника; нет ответа может означать блокировку ICMP">${pingText}${routeText}</span></span>
          <button type="button" class="copy" data-copy="${escapeHtml(peer.ip)}" title="Скопировать адрес"
                  aria-label="Скопировать адрес ${escapeHtml(peer.ip)}">${COPY_ICON}</button>
        </div>`;
    })
    .join('');
}

function renderStatusbar() {
  const net = activeNetwork();
  if (!net) return;
  const left = $('statusLeft');
  const center = $('statusCenter');
  if (net.status === 'connected' && net.self?.ip) {
    left.textContent = `Сеть: ${net.self.ip}${net.port ? ` · udp/${net.port}` : ''}`;
    center.textContent = net.hubPing != null ? `До сервера ${net.hubPing} мс` : '';
  } else if (net.status === 'connecting') {
    left.textContent = 'Сеть: подключение…';
    center.textContent = '';
  } else if (net.status === 'error') {
    left.textContent = `Сеть: ${net.error || 'нет подключения'}`;
    center.textContent = '';
  } else {
    left.textContent = 'Сеть: не подключена';
    center.textContent = '';
  }
  left.title = net.network?.name ? `Сеть «${net.network.name}»` : '';

  const right = $('statusRight');
  const helper = state.helperStale && state.helperVersion ? ` · служба ${state.helperVersion}` : '';
  const version = state.version ? `v${state.version}${helper}` : '';
  const available = Boolean(state.update?.available);
  right.innerHTML = available
    ? `<span class="status-version">${escapeHtml(version)}</span><button type="button" class="update-note" data-update title="Открыть обновления">доступно обновление</button>`
    : `<span class="status-version">${escapeHtml(version)}</span>`;
  right.title = available
    ? 'Доступно обновление — нажмите, чтобы открыть'
    : state.helperVersion ? `Служба-помощник: ${state.helperVersion}` : '';
}

function renderMenu() {
  const net = activeNetwork();
  const toggle = $('menuToggle');
  toggle.disabled = !net || net.status === 'connecting';
  toggle.textContent = net?.status === 'connected' ? 'Отключить сеть' : 'Включить сеть';
  $('menuLeave').disabled = !net;
}

/* ------------------------------------------------------------------- modal */

function openTool(kind) {
  if (!PANES[kind]) return;
  const [width, height] = TOOL_SIZES[kind] || [360, 560];
  const url = `?tool=${encodeURIComponent(kind)}`;
  const name = `nurofen-${kind}`;
  const features = `popup=yes,width=${width},height=${height}`;
  const existing = window.open(url, name, features);
  if (existing) existing.focus();
}

function openModal(kind) {
  if (kind === 'nickname') {
    $('nicknameInput').value = state?.deviceName || '';
    $('nicknameError').hidden = true;
  }
  const entry = PANES[kind];
  if (!entry) return;
  modalKind = kind;
  $('modalTitle').textContent = entry[1];
  Object.entries(PANES).forEach(([key, [id]]) => {
    $(id).hidden = key !== kind;
  });
  renderModal();
  $('modal').hidden = false;
  if (kind === 'update') checkForUpdates();
}

function closeModal() {
  if (TOOL_KIND) {
    window.close();
    return;
  }
  modalKind = null;
  $('modal').hidden = true;
}

function renderModal() {
  if (!modalKind || !state) return;
  if (modalKind === 'update') renderUpdatePane();
  else if (modalKind === 'diagnostics') renderDiagnostics();
  else if (modalKind === 'settings') renderSettings();
  else if (modalKind === 'about') renderAbout();
}

function renderSettings() {
  const settings = state.settings || {};
  $('setCompact').checked = settings.compactPeers === true;
  $('setAutoConnect').checked = settings.autoConnect !== false;
  const net = activeNetwork();
  $('setDirect').checked = Boolean(net?.direct);
  $('setDirect').disabled = !net;
  $('setNetwork').textContent = net?.network?.name || '—';

  const mc = state.minecraft || {};
  const input = $('setMcPath');
  if (!mcPathDirty && document.activeElement !== input) input.value = mc.configured || '';
  $('setMcDir').textContent = mc.dir ? 'найдена' : (mc.configured ? 'не найдена' : 'авто');
  $('setMcDir').title = mc.dir || mc.configured || '';

  const found = Array.isArray(mc.found) ? mc.found : [];
  const box = $('setMcFound');
  box.hidden = !found.length;
  box.innerHTML = found.length
    ? `<span class="mc-found-title">Найдено</span>${found.map((item) => {
      const label = item.instance ? `${item.launcher} · ${item.instance}` : item.launcher;
      return `<button type="button" class="mc-found-item" data-mc-path="${escapeHtml(item.path)}" title="${escapeHtml(item.path)}">${escapeHtml(label)}</button>`;
    }).join('')}`
    : '';

  const server = state.minecraftServer || {};
  const serverInput = $('setServerPath');
  if (!mcServerPathDirty && document.activeElement !== serverInput) serverInput.value = server.configured || '';
  $('setServerDir').textContent = server.running
    ? `запущен · ${server.port}`
    : server.dir ? 'найден, не запущен' : server.configured ? 'не найден' : 'не задана';
  $('setServerDir').classList.toggle('on', server.running === true);
  $('setServerDir').title = server.dir || server.configured || '';
}

async function saveSettings(patch = {}) {
  const settings = { ...(state.settings || {}), ...patch };
  const result = await api('/api/settings', settings);
  if (result?.ok && state) state.settings = result.settings;
  render();
  renderModal();
}

async function saveDirect(value) {
  const net = activeNetwork();
  if (!net) return;
  const result = await api('/api/direct', { id: net.id, value });
  if (!result?.ok) toast(result?.error || 'Не удалось переключить прямые соединения');
  await poll();
  renderModal();
}

function renderUpdatePane() {
  const u = state.update || {};
  $('upCurrent').textContent = state.version || '—';
  $('upHelper').textContent = state.helper
    ? (state.helperVersion || '—') + (state.helperStale ? ' (старая)' : '')
    : 'не запущена';
  $('upLatest').textContent = u.checking ? 'проверяю…' : u.latest || '—';

  let text = 'Нажмите «Проверить снова», чтобы узнать о новой версии.';
  if (u.applying) text = u.progress || 'обновляю…';
  else if (u.error) text = u.error;
  else if (u.available) text = `Доступна версия ${u.latest}.${u.notes ? ` ${u.notes}` : ''}`;
  else if (u.checkedAt) text = 'Установлена последняя версия.';
  $('upText').textContent = text;

  const apply = $('upApply');
  apply.hidden = !u.available || u.applying;
  apply.disabled = Boolean(u.applying);
  apply.textContent = u.applying ? 'Обновляю…' : `Установить${u.latest ? ` ${u.latest}` : ''}`;
  $('upCheck').disabled = Boolean(u.checking || u.applying);
  const force = $('upForceHelper');
  force.disabled = Boolean(u.checking || u.applying);
  force.textContent = u.applying ? (u.progress || 'Обновляю…') : 'Принудительно обновить службу';
}

function renderDiagnostics() {
  const good = (value) => (value ? 'ok' : 'bad');
  $('dHelper').textContent = state.helper
    ? (state.helperStale
      ? `старая (${state.helperVersion || '?'}) — нажмите «Принудительно обновить службу»`
      : `работает${state.helperVersion ? ` (${state.helperVersion})` : ''}`)
    : 'нет';
  $('dHelper').className = state.helper ? (state.helperStale ? 'warn' : 'ok') : 'bad';
  $('dHelperFix').disabled = Boolean(state.update?.applying);
  $('dHelperFix').textContent = state.update?.applying
    ? (state.update.progress || 'Обновляю…')
    : 'Принудительно обновить службу';
  $('dAwg').textContent = state.awg ? 'установлен' : 'не найден';
  $('dAwg').className = good(state.awg);

  $('diagNetworks').innerHTML = networks()
    .map((net) => {
      const up = net.tunnel?.up;
      const label = up ? 'поднят' : net.status === 'error' ? 'ошибка' : net.status === 'connecting' ? 'подключение' : 'опущен';
      const ping = net.hubPing != null ? ` · ${net.hubPing} мс до сервера` : '';
      return `<div class="diag-row"><span>${escapeHtml(net.network?.name || 'Сеть')} · ${escapeHtml(net.interface || '')}${ping}</span><b class="${up ? 'ok' : 'bad'}">${label}</b></div>`;
    })
    .join('') || '<div class="diag-row"><span>Сети</span><b>нет</b></div>';

  const lines = (state.log || []).slice(-14).map((entry) => {
    const time = new Date(entry.at).toLocaleTimeString('ru-RU', { hour12: false });
    return `${time}  ${entry.message}`;
  });
  $('logBox').textContent = lines.join('\n') || '—';
}

function renderAbout() {
  $('aboutVersion').textContent = state.version || '—';
  $('aboutNetworks').textContent = String(networks().length);
}

async function checkForUpdates() {
  await api('/api/update/check');
  await poll();
}

async function applyUpdate() {
  const button = $('upApply');
  button.disabled = true;
  button.textContent = 'Обновляю…';
  const result = await api('/api/update/apply');
  if (!result?.ok) {
    toast(result?.error || 'Не удалось обновить клиент');
    await poll();
    return;
  }
  toast('Обновление установлено — клиент перезапустится');
}

/* ----------------------------------------------------------------- actions */

async function toggleConnection() {
  const net = activeNetwork();
  if (!net) return;
  const result = await api('/api/toggle', { id: net.id });
  if (!result?.ok) toast(result?.error || 'Не удалось переключить сеть');
  poll();
}

async function leaveNetwork() {
  const net = activeNetwork();
  if (!net) return;
  if (!confirm(`Выйти из сети «${net.network?.name || ''}»? Для повторного входа понадобятся название и пароль.`)) return;
  const result = await api('/api/leave', { id: net.id });
  if (!result?.ok) {
    toast(result?.error || 'Не удалось выйти из сети');
    return;
  }
  activeId = result.activeId || null;
  closeModal();
  await poll();
}

function openJoin() {
  joinOpen = true;
  joinMode = 'join';
  $('joinError').hidden = true;
  $('networkName').value = '';
  $('networkPassword').value = '';
  updateJoinMode();
  render();
  setTimeout(() => $('networkName').focus(), 40);
}

function closeJoin() {
  if (!networks().length) return;
  joinOpen = false;
  $('joinError').hidden = true;
  render();
}

function updateJoinMode() {
  document.querySelectorAll('.mode-option').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === joinMode);
  });
  const creating = joinMode === 'create';
  $('formTitle').textContent = creating ? 'Создать сеть' : 'Подключиться к сети';
  $('formHint').textContent = creating
    ? 'Придумайте название и пароль. Друзья подключатся к этой сети по тем же данным.'
    : 'Введите название сети и пароль, который сообщил её создатель.';
  $('joinBtn').textContent = creating ? 'Создать и войти' : 'Подключиться';
}

/* ------------------------------------------------------------------ events */

$('powerBtn').addEventListener('click', toggleConnection);
$('editNickBtn').addEventListener('click', () => openTool('nickname'));
$('addNetBtn').addEventListener('click', openJoin);
$('joinBack').addEventListener('click', closeJoin);

$('directToggle').addEventListener('change', async (event) => {
  const net = activeNetwork();
  if (!net) return;
  const value = event.target.checked;
  event.target.disabled = true;
  try {
    await api('/api/direct', { id: net.id, value });
    await poll();
    toast(value ? 'Прямые соединения включены (бета)' : 'Прямые соединения выключены');
  } catch (error) {
    event.target.checked = !value;
    toast(error.message);
  } finally {
    event.target.disabled = false;
  }
});

$('joinBtn').addEventListener('click', async () => {
  if (joining) return;
  joining = true;
  const button = $('joinBtn');
  button.disabled = true;
  button.textContent = joinMode === 'create' ? 'Создаю сеть…' : 'Подключаюсь…';
  $('joinError').hidden = true;
  try {
    const result = await api('/api/join', {
      mode: joinMode,
      name: $('networkName').value.trim(),
      password: $('networkPassword').value,
      deviceName: $('deviceName').value.trim(),
    });
    if (!result.ok) {
      $('joinError').hidden = false;
      $('joinError').textContent = result.error;
      return;
    }
    $('networkPassword').value = '';
    $('networkName').value = '';
    joinOpen = false;
    activeId = result.id || null;
    await poll();
    toast(result.existing ? 'Эта сеть уже добавлена' : 'Сеть добавлена');
  } catch (error) {
    $('joinError').hidden = false;
    $('joinError').textContent = error.message || 'Не удалось связаться с сервером.';
  } finally {
    joining = false;
    button.disabled = false;
    updateJoinMode();
  }
});

document.querySelectorAll('.mode-option').forEach((button) => {
  button.addEventListener('click', () => {
    joinMode = button.dataset.mode;
    $('joinError').hidden = true;
    updateJoinMode();
  });
});

['networkName', 'networkPassword', 'deviceName'].forEach((id) => {
  $(id).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('joinBtn').click();
  });
});

document.querySelectorAll('.menu').forEach((menu) => {
  menu.querySelector('.menu-button').addEventListener('click', (event) => {
    event.stopPropagation();
    const open = menu.classList.contains('open');
    closeMenus();
    if (!open) menu.classList.add('open');
  });
});

function closeMenus() {
  document.querySelectorAll('.menu.open').forEach((menu) => menu.classList.remove('open'));
}

document.addEventListener('click', (event) => {
  if (!event.target.closest('.menu')) closeMenus();
});

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.action;
    closeMenus();
    if (action === 'toggle') toggleConnection();
    else if (action === 'add') openJoin();
    else if (action === 'nickname') openTool('nickname');
    else if (action === 'update') openTool('update');
    else if (action === 'diagnostics') openTool('diagnostics');
    else if (action === 'settings') openTool('settings');
    else if (action === 'about') openTool('about');
    else if (action === 'leave') leaveNetwork();
    else if (action === 'quit') api('/api/quit');
  });
});

document.addEventListener('click', async (event) => {
  if (event.target.closest('[data-update]')) {
    openTool('update');
    return;
  }
  const play = event.target.closest('[data-play]');
  if (play) {
    const address = play.dataset.play;
    play.disabled = true;
    try {
      const result = await api('/api/minecraft/add', { ip: address, name: `Nurofen · ${play.dataset.name || address}` });
      if (!result?.ok) {
        toast(result?.error || 'Не удалось записать servers.dat');
        return;
      }
      await copy(address);
      toast(`Мир добавлен в «Сетевая игра» — ${address}`);
    } finally {
      play.disabled = false;
    }
    return;
  }
  const tab = event.target.closest('[data-net]');
  if (tab) {
    activeId = tab.dataset.net;
    await api('/api/select', { id: activeId });
    render();
    return;
  }
  const target = event.target.closest('[data-copy]');
  if (target) {
    if (await copy(target.dataset.copy)) toast(`Скопировано: ${target.dataset.copy}`);
  }
});

$('copyMc').addEventListener('click', async () => {
  const address = $('mcAddr').textContent;
  if (address && address !== '—' && (await copy(address))) toast(`Скопировано: ${address}`);
});

$('modalClose').addEventListener('click', closeModal);
$('modal').addEventListener('click', (event) => {
  if (event.target === $('modal')) closeModal();
});

$('upCheck').addEventListener('click', async () => {
  await checkForUpdates();
  renderUpdatePane();
});

$('upApply').addEventListener('click', applyUpdate);

async function forceHelperUpdate(button) {
  button.disabled = true;
  button.textContent = 'Принудительно обновляю…';
  try {
    const result = await api('/api/helper/restart');
    if (result?.ok) {
      toast(result.message || `Служба обновлена до ${result.version || result.helperVersion || 'текущей версии'}`);
    } else {
      toast(result?.error || 'Не удалось принудительно обновить службу');
    }
    await poll();
    renderModal();
  } catch (error) {
    toast(error.message || 'Не удалось обновить службу');
  } finally {
    button.disabled = false;
    button.textContent = 'Принудительно обновить службу';
  }
}

$('dHelperFix').addEventListener('click', () => forceHelperUpdate($('dHelperFix')));
$('upForceHelper').addEventListener('click', () => forceHelperUpdate($('upForceHelper')));

$('setCompact').addEventListener('change', (event) => saveSettings({ compactPeers: event.target.checked }));
$('setAutoConnect').addEventListener('change', (event) => saveSettings({ autoConnect: event.target.checked }));
$('setDirect').addEventListener('change', (event) => saveDirect(event.target.checked));
$('setNickname').addEventListener('click', () => openTool('nickname'));

$('setMcPath').addEventListener('input', () => { mcPathDirty = true; });

$('setMcPick').addEventListener('click', async () => {
  const button = $('setMcPick');
  button.disabled = true;
  try {
    const result = await api('/api/minecraft/pick');
    if (result?.cancelled) return;
    if (!result?.path) {
      toast('Не удалось открыть выбор папки');
      return;
    }
    $('setMcPath').value = result.path;
    mcPathDirty = true;
    toast(result.ok ? 'Папка выбрана — нажмите «Сохранить путь»' : 'В этой папке Minecraft не найден');
  } finally {
    button.disabled = false;
  }
});

$('setMcSave').addEventListener('click', async () => {
  const button = $('setMcSave');
  button.disabled = true;
  try {
    const value = $('setMcPath').value.trim();
    const result = await api('/api/minecraft/path', { dir: value });
    if (!result?.ok) {
      toast(result?.error || 'Не удалось сохранить путь');
      return;
    }
    mcPathDirty = false;
    toast(result.dir ? `Папка Minecraft: ${result.dir}` : 'Путь сброшен — поиск автоматический');
    await poll();
    renderModal();
  } finally {
    button.disabled = false;
  }
});

$('setMcAuto').addEventListener('click', async () => {
  $('setMcPath').value = '';
  mcPathDirty = false;
  const result = await api('/api/minecraft/path', { dir: '' });
  if (!result?.ok) {
    toast('Не удалось сбросить путь');
    return;
  }
  toast('Поиск Minecraft снова автоматический');
  await poll();
  renderModal();
});

$('setMcFound').addEventListener('click', (event) => {
  const item = event.target.closest('[data-mc-path]');
  if (!item) return;
  $('setMcPath').value = item.dataset.mcPath;
  mcPathDirty = true;
});

$('setServerPath').addEventListener('input', () => { mcServerPathDirty = true; });

$('setServerPick').addEventListener('click', async () => {
  const button = $('setServerPick');
  button.disabled = true;
  try {
    const result = await api('/api/minecraft/pick');
    if (result?.cancelled) return;
    if (!result?.path) {
      toast('Не удалось открыть выбор папки');
      return;
    }
    $('setServerPath').value = result.path;
    mcServerPathDirty = true;
    toast('Папка выбрана — нажмите «Сохранить путь»');
  } finally {
    button.disabled = false;
  }
});

$('setServerSave').addEventListener('click', async () => {
  const button = $('setServerSave');
  button.disabled = true;
  try {
    const value = $('setServerPath').value.trim();
    const result = await api('/api/minecraft/server', { dir: value });
    if (!result?.ok) {
      toast(result?.error || 'Не удалось сохранить путь сервера');
      return;
    }
    mcServerPathDirty = false;
    toast(result.running
      ? `Сервер запущен на порту ${result.port}`
      : result.dir ? 'Папка сервера сохранена — сервер не запущен' : 'Путь к серверу убран');
    await poll();
    renderModal();
  } finally {
    button.disabled = false;
  }
});

$('setServerClear').addEventListener('click', async () => {
  $('setServerPath').value = '';
  mcServerPathDirty = false;
  const result = await api('/api/minecraft/server', { dir: '' });
  if (!result?.ok) {
    toast(result?.error || 'Не удалось убрать путь сервера');
    return;
  }
  toast('Путь к серверу убран');
  await poll();
  renderModal();
});

$('nicknameSave').addEventListener('click', async () => {
  $('nicknameSave').disabled = true;
  $('nicknameError').hidden = true;
  const name = $('nicknameInput').value.trim();
  if (name.length < 2 || name.length > 32) {
    $('nicknameError').textContent = 'Ник должен содержать от 2 до 32 символов.';
    $('nicknameError').hidden = false;
    $('nicknameSave').disabled = false;
    return;
  }
  try {
    const result = await api('/api/rename', { name });
    if (!result.ok) throw new Error(result.error || 'Не удалось изменить ник');
    closeModal();
    await poll();
    toast('Ник изменён');
  } catch (error) {
    $('nicknameError').textContent = error.message;
    $('nicknameError').hidden = false;
  } finally { $('nicknameSave').disabled = false; }
});

$('nicknameInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('nicknameSave').click();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeMenus();
  if (!$('modal').hidden) closeModal();
  else if (joinOpen) closeJoin();
});

/* -------------------------------------------------------------------- poll */

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    state = await res.json();
    const list = networks();
    if (!activeId || !list.some((item) => item.id === activeId)) {
      activeId = state.activeId || list[0]?.id || null;
    }
    render();
  } catch {
    // the app is stopping or restarting
  } finally {
    polling = false;
  }
}

if (TOOL_KIND && PANES[TOOL_KIND]) {
  document.body.classList.add('tool-window');
  document.title = `${PANES[TOOL_KIND][1]} — Nurofen`;
  openModal(TOOL_KIND);
}

poll();
setInterval(poll, 1500);
