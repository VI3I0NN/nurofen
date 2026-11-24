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
  files: ['paneFiles', 'Передачи файлов'],
  friends: ['paneFriends', 'Друзья'],
  remote: ['paneRemote', 'Удалённая помощь'],
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
  play: [640, 700],
  files: [460, 620],
  friends: [420, 580],
  remote: [720, 560],
};

const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
const FRIEND_STAR = '<svg class="friend-star" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9Z"/></svg>';

let state = null;
let activeId = null;
let joinOpen = false;
let joinMode = 'join';
let joining = false;
let polling = false;
let modalKind = null;
let toastTimer = null;
let peersMarkup = null;
// Worlds seen on the previous poll, per network. A new address means a friend
// just opened one, which is worth a toast even when the window is in the
// background. The first poll of a network only sets the baseline.
const knownWorlds = new Map();
// The settings window polls every couple of seconds; never overwrite a path
// the user is typing or has just picked but not saved yet.
let mcPathDirty = false;
let mcServerPathDirty = false;
let filesDirDirty = false;
let pickedFile = null;
let fileSending = false;
let remoteConsentId = null;
let remoteStreamId = null;
let remoteFrameShown = false;
let remoteInputQueue = [];
let remoteInputTimer = 0;

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

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let size = bytes;
  let unit = -1;
  do {
    size /= 1024;
    unit += 1;
  } while (size >= 1024 && unit < units.length - 1);
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits).replace('.', ',')} ${units[unit]}`;
}

function formatSpeed(value) {
  const speed = Number(value) || 0;
  return speed > 0 ? `${formatBytes(speed)}/с` : '';
}

const FILE_STATUS = {
  offering: 'Отправляю запрос…',
  waiting: 'Ждёт подтверждения',
  pending: 'Входящий файл',
  accepted: 'Готов к приёму',
  done: 'Готово',
  declined: 'Отклонено',
  cancelled: 'Отменено',
  timeout: 'Нет ответа',
  error: 'Ошибка',
};

function fileStatus(transfer) {
  if (transfer.direction === 'in') {
    if (transfer.status === 'active') return 'Получение';
    if (transfer.status === 'done') return 'Получено';
  } else {
    if (transfer.status === 'active') return 'Отправка';
    if (transfer.status === 'done') return 'Отправлено';
  }
  if (transfer.status === 'accepted') {
    return transfer.direction === 'out' ? 'Получатель принял' : 'Готов к приёму';
  }
  return FILE_STATUS[transfer.status] || transfer.status;
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
  if (TOOL_KIND === 'play') {
    renderPlay();
    return;
  }
  if (TOOL_KIND && PANES[TOOL_KIND]) {
    renderModal();
    renderIncoming();
    return;
  }
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
    renderTransfers();
    renderStatusbar();
  }
  renderRemoteBanner();
  renderIncoming();
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

  $('powerLabel').textContent = { connected: 'Вкл', connecting: '…', error: '!', idle: 'Выкл' }[status] || 'Выкл';
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

/** The cached Server List Ping answer for one world address, if any. */
function worldStatus(address) {
  return address ? state?.minecraftStatus?.[address] || null : null;
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
  const statusLine = $('mcStatus');
  statusLine.hidden = true;
  statusLine.textContent = '';
  statusLine.className = 'mc-status';

  if (open) {
    $('mcState').textContent = serverReady ? 'сервер запущен' : 'мир открыт';
    $('mcState').classList.add('on');
    $('mcWorld').hidden = false;
    $('mcHint').hidden = true;
    const address = `${net.self.ip}:${sharedPort}`;
    $('mcAddr').textContent = address;
    $('mcAddr').title = address;

    // The game answers its own Server List Ping, so this line is the same
    // information a player sees in the multiplayer list.
    const status = worldStatus(address);
    if (status?.online) {
      const players = status.players || {};
      const meta = [];
      if (players.max) meta.push(`${players.online} из ${players.max}`);
      else if (players.online) meta.push(`${players.online} игроков`);
      if (status.version) meta.push(status.version);
      if (status.latency != null) meta.push(`${status.latency} мс`);
      statusLine.hidden = false;
      statusLine.classList.add('on');
      statusLine.innerHTML = `${status.motd ? `<span class="mc-motd">${escapeHtml(status.motd)}</span>` : ''}<span class="mc-meta">${escapeHtml(meta.join(' · '))}</span>`;
      statusLine.title = [status.motd, meta.join(' · ')].filter(Boolean).join('\n');
    } else if (status && !status.online) {
      statusLine.hidden = false;
      statusLine.classList.add('bad');
      statusLine.textContent = 'Мир не отвечает на запросы';
      statusLine.title = status.error || '';
    }
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
    paintPeers('<div class="empty">Пока никого нет.<br>Сообщите друзьям название сети и пароль.</div>');
    return;
  }

  const sorted = [...peers].sort((a, b) => {
    if (a.self !== b.self) return a.self ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return String(a.name || '').localeCompare(String(b.name || ''), 'ru');
  });

  const tunnelUp = net.status === 'connected';

  paintPeers(sorted
    .map((peer) => {
      const online = peer.self ? tunnelUp : peer.online;
      const ping = net.pings?.[peer.ip];
      const pingClass = ping == null ? '' : ping <= 80 ? 'good' : ping > 160 ? 'bad' : 'warn';
      const pingText = peer.self ? '—' : !tunnelUp || !online ? '—' : ping == null ? 'нет ответа' : `${ping} мс`;
      const mode = net.directModes?.[peer.ip];
      const routeLabel = net.direct && online && !peer.self
        ? (mode === 'direct' ? 'напрямую'
          : mode === 'trying' ? 'проверяю'
            : mode === 'stale' ? 'нужен перезапуск'
              : 'через сервер')
        : '';
      const pingTitle = `Время ответа участника${routeLabel ? `, соединение ${routeLabel}` : ''}; нет ответа может означать блокировку ICMP`;
      const world = tunnelUp && online && !peer.self && state.minecraftInstalled && peer.lanPort
        ? `${peer.ip}:${peer.lanPort}`
        : null;
      const status = worldStatus(world);
      const players = status?.online ? status.players || {} : null;
      const playersLabel = players
        ? (players.max ? `${players.online}/${players.max}` : `${players.online}`)
        : '';
      const playersTitle = players
        ? `${players.online}${players.max ? ` из ${players.max}` : ''} игроков${status.version ? ` · ${status.version}` : ''}${status.motd ? `\n${status.motd}` : ''}`
        : '';
      const playersChip = playersLabel
        ? `<span class="mc-players" title="${escapeHtml(playersTitle)}">${escapeHtml(playersLabel)}</span>`
        : '';
      const playButton = world
        ? `<button type="button" class="mc-play" data-play="${escapeHtml(world)}" data-name="${escapeHtml(peer.name)}" title="Добавить сервер ${escapeHtml(world)} в «Сетевую игру»">Добавить</button>`
        : '';
      const friend = !peer.self && friendIds().has(peer.id);
      return `
        <div class="peer ${online ? 'online' : ''}">
          <span class="avatar ${peerTone(peer.name)}">${escapeHtml(initials(peer.name))}</span>
          <div class="peer-main">
            <span class="name"><span class="name-text">${escapeHtml(peer.name)}</span>${friend ? `<span class="tag-friend" title="Друг">${FRIEND_STAR}</span>` : ''}${peer.self ? '<span class="tag-self">вы</span>' : ''}</span>
            <span class="peer-sub"><span class="ip">${escapeHtml(peer.ip)}</span>${playersChip}${playButton}</span>
          </div>
          <span class="peer-connection"><span class="presence ${online ? 'online' : ''}">${online ? 'В сети' : 'Не в сети'}</span><span class="ping ${pingClass}" title="${escapeHtml(pingTitle)}">${pingText}</span></span>
          <button type="button" class="copy" data-copy="${escapeHtml(peer.ip)}" title="Скопировать адрес"
                  aria-label="Скопировать адрес ${escapeHtml(peer.ip)}">${COPY_ICON}</button>
          ${online && !peer.self
            ? `<button type="button" class="copy" data-remote-peer="${escapeHtml(peer.id)}" data-remote-net="${escapeHtml(net.id)}" title="Удалённая помощь" aria-label="Удалённая помощь: ${escapeHtml(peer.name)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4M8 10l2.5 2.5L16 7"/></svg></button>`
            : ''}
        </div>`;
    })
    .join(''));
}

/**
 * Rebuilding the list every poll would swallow clicks: the button under the
 * pointer disappears between mousedown and mouseup. Only touch the DOM when
 * the markup really changed.
 */
function paintPeers(markup) {
  if (markup === peersMarkup) return;
  peersMarkup = markup;
  $('peers').innerHTML = markup;
}

/* --------------------------------------------------------- files and friends */

const FILE_TERMINAL = new Set(['done', 'declined', 'error', 'cancelled', 'timeout']);

/** Every online participant across all connected networks. */
function sendPeers() {
  const list = [];
  const seen = new Set();
  for (const net of networks()) {
    if (net.status !== 'connected') continue;
    for (const peer of net.peers || []) {
      if (peer.self || !peer.online) continue;
      const key = `${net.id}:${peer.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({
        networkId: net.id,
        peerId: peer.id,
        name: peer.name || peer.ip,
        ip: peer.ip,
        networkName: net.network?.name || '',
      });
    }
  }
  return list;
}

function friendIds() {
  return new Set((state?.friends || []).map((friend) => friend.peerId));
}

function transfers() {
  return state?.files?.transfers || [];
}

function pendingTransfers() {
  return transfers().filter((item) => item.direction === 'in' && item.status === 'pending');
}

function remotePeers() {
  return sendPeers();
}

let remotePeerOptions = null;
let remoteMarkup = null;

function remoteSessionMeta(session) {
  if (!session) return '';
  const parts = [session.peerName, session.networkName];
  if (session.status === 'active') {
    parts.push(session.control ? 'просмотр и управление' : 'только просмотр');
    if (session.width && session.height) parts.push(`${session.width}×${session.height}`);
    if (session.fps) parts.push(`${session.fps} кадр/с`);
    if (session.kbps) parts.push(`${session.kbps} кбит/с`);
  } else if (session.status === 'connecting') parts.push('подключение…');
  else if (session.status === 'waiting') parts.push('ожидание согласия…');
  else if (session.terminal) parts.push(session.error || 'сеанс завершён');
  return parts.filter(Boolean).join(' · ');
}

function renderRemote() {
  const snapshot = state?.remote || {};
  const peers = remotePeers();
  const select = $('remotePeer');
  const options = peers.map((peer) => {
    const value = `${peer.networkId}|${peer.peerId}`;
    const label = `${peer.name} · ${peer.ip}${peer.networkName ? ` · ${peer.networkName}` : ''}`;
    return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  }).join('');
  if (options !== remotePeerOptions) {
    const previous = select.value || REMOTE_PRESET;
    select.innerHTML = options || '<option value="">Нет участников в сети</option>';
    if (previous && [...select.options].some((option) => option.value === previous)) select.value = previous;
    remotePeerOptions = options;
  }
  const busy = Boolean(snapshot.viewer && !snapshot.viewer.terminal);
  select.disabled = !peers.length || busy || !remoteEnabled();
  $('remoteRequestControl').disabled = select.disabled;
  $('remoteStart').disabled = select.disabled || !select.value || !snapshot.available;
  $('remoteStart').textContent = !remoteEnabled()
    ? 'Удалённая помощь отключена в настройках'
    : !snapshot.available ? 'Удалённая помощь недоступна'
      : busy ? 'Сеанс уже идёт'
        : 'Запросить помощь';

  const incoming = snapshot.incoming || [];
  $('remoteIncomingList').innerHTML = incoming.length
    ? incoming.map((request) => `<div class="remote-row"><b>${escapeHtml(request.peerName)}</b><span>${escapeHtml([request.networkName, request.controlRequested ? 'просит управление' : 'просит доступ к экрану'].filter(Boolean).join(' · '))}</span><small>${escapeHtml(request.peerIp || '')}</small></div>`).join('')
    : '<div class="remote-empty-list">Нет входящих запросов.</div>';

  const session = snapshot.viewer || snapshot.host;
  const view = $('remoteView');
  const isViewer = session?.role === 'viewer';
  const live = isViewer && !session.terminal;
  view.hidden = false;
  if (live && session.id !== remoteStreamId) {
    remoteStreamId = session.id;
    remoteFrameShown = false;
    $('remoteImage').src = `/api/remote/stream?id=${encodeURIComponent(session.id)}&at=${Date.now()}`;
  } else if (!live && remoteStreamId) {
    remoteStreamId = null;
    remoteFrameShown = false;
    $('remoteImage').removeAttribute('src');
  }
  $('remoteImage').hidden = !live;
  $('remoteImage').onload = () => {
    remoteFrameShown = true;
    $('remotePlaceholder').hidden = true;
  };
  $('remotePlaceholder').hidden = Boolean(live && (remoteFrameShown || session.frames > 0));
  $('remotePlaceholder').textContent = !session ? 'Экран появится после согласия.'
    : session.role === 'host' ? (session.terminal ? (session.error || 'Сеанс завершён.')
      : 'Ваш экран передаётся участнику. Остановите сеанс, чтобы прекратить.')
      : session.status === 'waiting' ? 'Запрос отправлен — ждём согласия…'
        : session.status === 'connecting' ? 'Начинаем сеанс…'
          : session.terminal ? (session.error || 'Сеанс завершён.')
            : 'Ожидание кадра…';
  $('remoteViewStatus').textContent = session ? remoteSessionMeta(session) : '';

  const markup = !session
    ? '<div class="remote-empty-list">Сеанс не активен.</div>'
    : `<div class="remote-session-card"><b>${escapeHtml(session.role === 'host' ? 'Помощь для' : 'Подключение к')} ${escapeHtml(session.peerName || 'участник')}</b><span>${escapeHtml(remoteSessionMeta(session))}</span>${session.error ? `<small>${escapeHtml(session.error)}</small>` : ''}<div class="remote-actions">${session.active && session.role === 'host' ? `<button type="button" class="ghost slim-ghost" data-remote-control="${escapeHtml(session.id)}" data-enabled="${session.control ? '0' : '1'}">${session.control ? 'Отключить управление' : 'Разрешить управление'}</button>` : ''}${session.canStop ? `<button type="button" class="danger slim-ghost" data-remote-stop="${escapeHtml(session.id)}">Остановить сеанс</button>` : ''}${session.canDismiss ? `<button type="button" class="ghost slim-ghost" data-remote-dismiss="${escapeHtml(session.id)}">Убрать</button>` : ''}</div></div>`;
  if (markup !== remoteMarkup) {
    remoteMarkup = markup;
    $('remoteSession').innerHTML = markup;
  }
}

async function flushRemoteInput() {
  remoteInputTimer = 0;
  const events = remoteInputQueue.splice(0, 64);
  const session = state?.remote?.viewer;
  if (events.length && session?.id) await api('/api/remote/input', { id: session.id, events }).catch(() => {});
}

function renderRemoteBanner() {
  const banner = $('remoteBanner');
  if (!banner) return;
  const snapshot = state?.remote || {};
  const session = snapshot.host || snapshot.viewer;
  if (!session || session.terminal) {
    banner.hidden = true;
    return;
  }
  const host = session.role === 'host';
  $('remoteBannerTitle').textContent = host
    ? `Удалённая помощь: ${session.peerName}`
    : `Подключение к ${session.peerName}`;
  $('remoteBannerMeta').textContent = remoteSessionMeta(session);
  const control = $('remoteBannerControl');
  control.hidden = !host || !session.controlRequested || !session.active;
  control.textContent = session.control ? 'Запретить управление' : 'Разрешить управление';
  $('remoteBannerOpen').hidden = !snapshot.viewer;
  banner.hidden = false;
}

function remoteCurrentSession() {
  const snapshot = state?.remote || {};
  return snapshot.host || snapshot.viewer || null;
}

async function remoteAction(route, body) {
  const result = await api(route, body);
  if (!result?.ok && result?.error) toast(result.error);
  await poll();
  renderModal();
  renderRemoteBanner();
  renderIncoming();
  return result;
}

function transferMeta(transfer) {
  const parts = [transfer.direction === 'out' ? `Для ${transfer.peerName}` : `От ${transfer.peerName}`];
  if (transfer.networkName) parts.push(transfer.networkName);
  parts.push(fileStatus(transfer));
  if (transfer.status === 'active') {
    if (transfer.percent) parts.push(`${transfer.percent}%`);
    const speed = formatSpeed(transfer.speed);
    if (speed) parts.push(speed);
  }
  if (transfer.error) parts.push(transfer.error);
  return parts.filter(Boolean).join(' · ');
}

function transferActions(transfer) {
  const id = escapeHtml(transfer.id);
  const actions = [];
  if (transfer.canAccept) {
    actions.push(`<button type="button" class="primary slim" data-transfer="${id}" data-transfer-action="accept">Принять</button>`);
  }
  if (transfer.canDecline) {
    actions.push(`<button type="button" class="ghost slim-ghost" data-transfer="${id}" data-transfer-action="decline">Отклонить</button>`);
  }
  if (transfer.canCancel && !transfer.canDecline) {
    actions.push(`<button type="button" class="ghost slim-ghost" data-transfer="${id}" data-transfer-action="cancel">Отменить</button>`);
  }
  if (transfer.canReveal) {
    actions.push(`<button type="button" class="ghost slim-ghost" data-transfer="${id}" data-transfer-action="reveal">Показать</button>`);
  }
  if (transfer.canDismiss) {
    actions.push(`<button type="button" class="ghost slim-ghost" data-transfer="${id}" data-transfer-action="dismiss">Убрать</button>`);
  }
  return actions.join('');
}

function transferRowMarkup(transfer) {
  const percent = transfer.status === 'done' ? 100 : transfer.percent || 0;
  const stateClass = FILE_TERMINAL.has(transfer.status) ? ` ${transfer.status}` : '';
  const meta = transferMeta(transfer);
  return `
    <div class="transfer-row${stateClass}">
      <div class="transfer-top">
        <span class="transfer-dir" aria-hidden="true">${transfer.direction === 'out' ? '↑' : '↓'}</span>
        <span class="transfer-name" title="${escapeHtml(transfer.name)}">${escapeHtml(transfer.name)}</span>
        <span class="transfer-size">${escapeHtml(formatBytes(transfer.size))}</span>
      </div>
      <div class="transfer-meta" title="${escapeHtml(meta)}">${escapeHtml(meta)}</div>
      <div class="transfer-bar"><span style="width:${percent}%"></span></div>
      <div class="transfer-actions">${transferActions(transfer)}</div>
    </div>`;
}

let transfersMarkup = null;

function renderTransfers() {
  const panel = $('transfersPanel');
  if (!panel) return;
  const list = transfers();
  panel.hidden = !list.length;
  if (!list.length) {
    if (transfersMarkup !== '') {
      transfersMarkup = '';
      $('transfersList').innerHTML = '';
    }
    $('transfersCount').textContent = '';
    return;
  }
  const active = list.filter((item) => !FILE_TERMINAL.has(item.status)).length;
  $('transfersCount').textContent = active ? `активных: ${active}` : `завершено: ${list.length}`;
  const markup = list.map(transferRowMarkup).join('');
  if (markup !== transfersMarkup) {
    transfersMarkup = markup;
    $('transfersList').innerHTML = markup;
  }
}

function renderIncoming() {
  const box = $('incoming');
  if (!box) return;
  const remoteIncoming = state?.remote?.incoming || [];
  const list = pendingTransfers();
  if (remoteIncoming.length) {
    const request = remoteIncoming[0];
    $('incomingRemoteTitle').textContent = `${request.peerName} просит подключиться`;
    $('incomingRemoteMeta').textContent = [request.networkName, request.controlRequested ? 'запрошено управление' : 'только экран'].filter(Boolean).join(' · ');
    if (remoteConsentId !== request.id) {
      remoteConsentId = request.id;
      $('incomingRemoteControl').checked = false;
    }
    $('incomingRemoteControl').disabled = !request.controlRequested;
    $('incomingRemoteAccept').textContent = $('incomingRemoteControl').checked
      ? 'Разрешить управление'
      : 'Разрешить просмотр';
    $('incomingRemote').hidden = false;
  } else {
    remoteConsentId = null;
    $('incomingRemote').hidden = true;
  }
  if (!list.length) {
    box.hidden = true;
    return;
  }
  const transfer = list[0];
  $('incomingTitle').textContent = transfer.name;
  $('incomingMeta').textContent = [
    transfer.peerName,
    formatBytes(transfer.size),
    transfer.networkName,
  ].filter(Boolean).join(' · ');
  const more = $('incomingMore');
  more.hidden = list.length < 2;
  more.textContent = list.length > 1 ? `Ещё запросов: ${list.length - 1}` : '';
  box.hidden = false;
}

function fileCardMarkup(transfer) {
  const percent = transfer.status === 'done' ? 100 : transfer.percent || 0;
  const stateClass = FILE_TERMINAL.has(transfer.status) ? ` ${transfer.status}` : '';
  const meta = transferMeta(transfer);
  return `
    <div class="file-card${stateClass}">
      <div class="file-card-head">
        <span class="file-card-name" title="${escapeHtml(transfer.name)}">${escapeHtml(transfer.name)}</span>
        <span class="file-card-size">${escapeHtml(formatBytes(transfer.size))}</span>
      </div>
      <div class="file-card-meta" title="${escapeHtml(meta)}">${escapeHtml(meta)}</div>
      <div class="transfer-bar"><span style="width:${percent}%"></span></div>
      <div class="file-card-actions">${transferActions(transfer)}</div>
    </div>`;
}

const FILE_PRESET = (() => {
  const params = new URLSearchParams(location.search);
  const net = params.get('net');
  const peer = params.get('peer');
  return net && peer ? `${net}|${peer}` : '';
})();

const REMOTE_PRESET = FILE_PRESET;

let filePeerOptions = null;
let fileListMarkup = null;

function renderFiles() {
  const files = state?.files || {};
  const peers = sendPeers();
  const select = $('filePeer');
  const options = peers.map((peer) => {
    const value = `${peer.networkId}|${peer.peerId}`;
    const label = `${peer.name} · ${peer.ip}${peer.networkName ? ` · ${peer.networkName}` : ''}`;
    return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  }).join('');
  if (options !== filePeerOptions) {
    const previous = select.value || FILE_PRESET;
    select.innerHTML = options || '<option value="">Нет участников в сети</option>';
    if (previous && [...select.options].some((option) => option.value === previous)) {
      select.value = previous;
    }
    filePeerOptions = options;
  }
  select.disabled = !peers.length;

  const picked = $('filePicked');
  picked.textContent = pickedFile
    ? `${pickedFile.name} · ${formatBytes(pickedFile.size)}`
    : 'Файл не выбран';
  picked.classList.toggle('on', Boolean(pickedFile));
  picked.title = pickedFile?.path || '';

  const send = $('fileSend');
  send.disabled = fileSending || !pickedFile || !select.value;
  send.textContent = fileSending ? 'Отправляю…' : 'Отправить';

  const list = transfers();
  const markup = list.length
    ? list.map(fileCardMarkup).join('')
    : '<div class="file-empty">Передач пока нет.</div>';
  if (markup !== fileListMarkup) {
    fileListMarkup = markup;
    $('fileList').innerHTML = markup;
  }

  const input = $('fileDirPath');
  if (!filesDirDirty && document.activeElement !== input) {
    input.value = files.configured ? files.dir || '' : '';
  }
  $('fileDir').textContent = files.dir || '—';
  $('fileDir').title = files.dir || '';
}

function friendActions(friend) {
  const actions = [];
  if (friend.online && friend.networkId) {
    actions.push(`<button type="button" class="ghost slim-ghost" data-friend-file="${escapeHtml(friend.peerId)}" data-friend-net="${escapeHtml(friend.networkId)}">Файл</button>`);
  }
  if (friend.networkId) {
    actions.push(`<button type="button" class="ghost slim-ghost" data-friend-invite="${escapeHtml(friend.networkId)}" title="Скопировать ссылку-приглашение в сеть">Ссылка</button>`);
  }
  actions.push(`<button type="button" class="ghost slim-ghost" data-friend-remove="${escapeHtml(friend.peerId)}">Убрать</button>`);
  return actions.join('');
}

let friendsMarkup = null;

function renderFriends() {
  const peers = sendPeers();
  const friends = state?.friends || [];
  const known = friendIds();

  const peerRows = peers.map((peer) => {
    const isFriend = known.has(peer.peerId);
    const actions = [
      `<button type="button" class="ghost slim-ghost" data-friend-file="${escapeHtml(peer.peerId)}" data-friend-net="${escapeHtml(peer.networkId)}">Файл</button>`,
      isFriend
        ? `<button type="button" class="ghost slim-ghost" data-friend-remove="${escapeHtml(peer.peerId)}">Убрать</button>`
        : `<button type="button" class="ghost slim-ghost" data-friend-add="${escapeHtml(peer.peerId)}">В друзья</button>`,
    ].join('');
    const meta = [peer.ip, peer.networkName].filter(Boolean).join(' · ');
    return `
      <div class="friend-row">
        <span class="avatar ${peerTone(peer.name)}">${escapeHtml(initials(peer.name))}</span>
        <div class="friend-main">
          <span class="friend-name">${escapeHtml(peer.name)}</span>
          <span class="friend-meta">${escapeHtml(meta || 'в сети')}</span>
        </div>
        <div class="friend-actions">${actions}</div>
      </div>`;
  }).join('');

  const friendRows = friends.map((friend) => {
    const meta = friend.online
      ? [friend.ip, friend.networkName].filter(Boolean).join(' · ') || 'в сети'
      : `Не в сети${friend.networkName ? ` · ${friend.networkName}` : ''}`;
    return `
      <div class="friend-row">
        <span class="avatar ${peerTone(friend.name)}">${escapeHtml(initials(friend.name))}</span>
        <div class="friend-main">
          <span class="friend-name">${escapeHtml(friend.name)}</span>
          <span class="friend-meta">${escapeHtml(meta)}</span>
        </div>
        <div class="friend-actions">${friendActions(friend)}</div>
      </div>`;
  }).join('');

  $('friendCount').textContent = friends.length ? `· ${friends.length}` : '';
  const signature = `${peerRows}\u0000${friendRows}`;
  if (signature === friendsMarkup) return;
  friendsMarkup = signature;
  $('friendPeers').innerHTML = peerRows || '<div class="friend-empty">В этой сети сейчас никого нет.</div>';
  $('friendList').innerHTML = friendRows || '<div class="friend-empty">Пока никого нет. Добавьте участника из списка выше — он останется в профиле и после выхода из сети.</div>';
}

/* -------------------------------------------------------------------- play */

let playBuildsMarkup = null;
let playWorldsMarkup = null;
let playLaunching = false;

/** Worlds friends share over the network, in the same shape as the peer list. */
function playWorlds() {
  const list = [];
  const seen = new Set();
  for (const net of networks()) {
    if (net.status !== 'connected') continue;
    for (const peer of net.peers || []) {
      if (peer.self || !peer.online || !peer.lanPort) continue;
      const address = `${peer.ip}:${peer.lanPort}`;
      if (seen.has(address)) continue;
      seen.add(address);
      list.push({
        address,
        name: String(peer.name || peer.ip),
        network: net.network?.name || '',
        status: worldStatus(address),
      });
    }
  }
  return list;
}

function selectedBuild(play) {
  const selected = play?.selected;
  if (!selected) return null;
  const launcher = (play.launchers || []).find((item) => item.id === selected.launcher);
  const instance = (launcher?.instances || []).find((item) => item.id === selected.instance);
  return launcher && instance ? { launcher, instance } : null;
}

function playBuildMarkup(play) {
  const launchers = play?.launchers || [];
  if (!launchers.length) {
    return '<div class="play-empty">Лаунчер не найден.<br>Установите Prism Launcher, PineconeMC или TLauncher Legacy — либо укажите путь к его .exe.</div>';
  }
  const selected = play.selected || {};
  return launchers.map((launcher) => {
    const instances = (launcher.instances || []).map((instance) => {
      const active = launcher.id === selected.launcher && instance.id === selected.instance;
      const meta = [
        instance.version ? `Minecraft ${instance.version}` : '',
        instance.loader ? `${instance.loader}${instance.loaderVersion ? ` ${instance.loaderVersion}` : ''}` : '',
      ].filter(Boolean).join(' · ');
      return `
        <button type="button" class="play-build ${active ? 'active' : ''}"
                data-play-build="${escapeHtml(launcher.id)}" data-play-instance="${escapeHtml(instance.id)}"
                ${launcher.available ? '' : 'disabled'}>
          <span class="play-build-dot" aria-hidden="true"></span>
          <span class="play-build-main">
            <span class="play-build-name">${escapeHtml(instance.name)}</span>
            <span class="play-build-meta">${escapeHtml(meta || instance.note || 'Сборка лаунчера')}</span>
          </span>
        </button>`;
    }).join('');
    const note = launcher.available ? '' : (launcher.note || 'не найден');
    return `
      <div class="play-group">
        <div class="play-group-head">
          <span class="play-group-name">${escapeHtml(launcher.name)}</span>
          ${note ? `<span class="play-group-note">${escapeHtml(note)}</span>` : ''}
        </div>
        ${instances || '<div class="play-empty small">В этом лаунчере нет сборок.</div>'}
      </div>`;
  }).join('');
}

function playWorldMarkup(worlds, play) {
  if (!worlds.length) {
    const connected = networks().some((net) => net.status === 'connected');
    return connected
      ? '<div class="play-empty">Пока никто не открыл мир.<br>Друг открывает мир для сети — он появится здесь.</div>'
      : '<div class="play-empty">Сеть не подключена.<br>Включите сеть — здесь появятся миры друзей.</div>';
  }
  const ready = Boolean(selectedBuild(play));
  return worlds.map((world) => {
    const status = world.status;
    const players = status?.online ? status.players || {} : null;
    const online = Number.isFinite(players?.online) ? players.online : null;
    const meta = [];
    if (online != null) meta.push(players.max ? `${online}/${players.max} игроков` : `${online} игроков`);
    if (status?.version) meta.push(status.version);
    if (world.network) meta.push(world.network);
    return `
      <div class="play-world">
        <div class="play-world-main">
          <span class="play-world-name">${escapeHtml(world.name)}</span>
          <span class="play-world-addr">${escapeHtml(world.address)}</span>
          <span class="play-world-meta">${escapeHtml(meta.join(' · ') || 'Мир открыт')}</span>
        </div>
        <button type="button" class="ghost slim-ghost" data-play-world="${escapeHtml(world.address)}"
                data-play-world-name="${escapeHtml(world.name)}" ${ready ? '' : 'disabled'}>Подключиться</button>
      </div>`;
  }).join('');
}

function renderPlay() {
  const play = state?.play || {};
  const builds = playBuildMarkup(play);
  if (builds !== playBuildsMarkup) {
    playBuildsMarkup = builds;
    $('playBuilds').innerHTML = builds;
  }

  const worlds = playWorlds();
  const worldMarkup = playWorldMarkup(worlds, play);
  if (worldMarkup !== playWorldsMarkup) {
    playWorldsMarkup = worldMarkup;
    $('playWorlds').innerHTML = worldMarkup;
  }
  $('playWorldsCount').textContent = worlds.length ? String(worlds.length) : '';

  const chosen = selectedBuild(play);
  const summary = $('playSelected');
  if (chosen) {
    const meta = [chosen.launcher.name, chosen.instance.loader].filter(Boolean).join(' · ');
    const version = chosen.instance.version
      ? `<code>Minecraft ${escapeHtml(chosen.instance.version)}</code>`
      : '';
    const parts = [escapeHtml(meta), version].filter(Boolean).join(' · ');
    summary.innerHTML = `<b>${escapeHtml(chosen.instance.name)}</b><span>${parts}</span>`;
  } else {
    summary.innerHTML = '<b>Сборка не выбрана</b><span>Выберите сборку выше</span>';
  }

  const launch = $('playLaunch');
  launch.disabled = playLaunching || !chosen;
  launch.textContent = playLaunching ? 'Запускаю…' : 'Играть';

  const input = $('playExePath');
  if (document.activeElement !== input) input.value = play.configuredExe || '';
}

async function launchPlay({ address = '', name = '' } = {}) {
  const chosen = selectedBuild(state?.play);
  if (!chosen || playLaunching) return;
  playLaunching = true;
  renderPlay();
  try {
    const result = await api('/api/play/launch', {
      launcher: chosen.launcher.id,
      instance: chosen.instance.id,
      address,
      name,
    });
    if (!result?.ok) {
      toast(result?.error || 'Не удалось запустить игру');
      return;
    }
    toast(result.message || 'Игра запускается');
    await poll();
  } catch {
    toast('Не удалось запустить игру');
  } finally {
    playLaunching = false;
    renderPlay();
  }
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
    ? `<span class="status-version" data-version>${escapeHtml(version)}</span><button type="button" class="update-note" data-update title="Открыть обновления">доступно обновление</button>`
    : `<span class="status-version" data-version>${escapeHtml(version)}</span>`;
  right.title = available
    ? 'Доступно обновление — нажмите, чтобы открыть'
    : state.helperVersion ? `Служба-помощник: ${state.helperVersion}` : '';
}

/* --------------------------------------------------------------- easter egg */

let versionClicks = 0;
let versionClickTimer = 0;
let eggTimer = 0;

// Five quick clicks on the version number in the status bar. Nothing depends
// on it, it is just a small joke for people who read version strings.
function countVersionClick() {
  if (TOOL_KIND) return;
  versionClicks += 1;
  clearTimeout(versionClickTimer);
  versionClickTimer = setTimeout(() => {
    versionClicks = 0;
  }, 2500);
  if (versionClicks < 5) return;
  versionClicks = 0;
  clearTimeout(versionClickTimer);
  showEgg();
}

function showEgg() {
  const egg = $('easterEgg');
  if (!egg) return;
  clearTimeout(eggTimer);
  egg.classList.remove('show');
  egg.hidden = false;
  void egg.offsetWidth; // restart the CSS animation
  egg.classList.add('show');
  eggTimer = setTimeout(() => {
    egg.hidden = true;
    egg.classList.remove('show');
  }, 2000);
}

function renderMenu() {
  const net = activeNetwork();
  const toggle = $('menuToggle');
  toggle.disabled = !net || net.status === 'connecting';
  toggle.textContent = net?.status === 'connected' ? 'Отключить сеть' : 'Включить сеть';
  $('menuLeave').disabled = !net;
}

/* ------------------------------------------------------------------- modal */

function openTool(kind, extra = {}) {
  if (kind !== 'play' && !PANES[kind]) return;
  const [width, height] = TOOL_SIZES[kind] || [360, 560];
  const params = new URLSearchParams({ tool: kind, ...extra });
  const url = `?${params.toString()}`;
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
  else if (modalKind === 'files') renderFiles();
  else if (modalKind === 'friends') renderFriends();
  else if (modalKind === 'remote') renderRemote();
}

function renderSettings() {
  const settings = state.settings || {};
  $('setCompact').checked = settings.compactPeers === true;
  $('setAutoConnect').checked = settings.autoConnect !== false;
  $('setNotify').checked = settings.notifyWorlds !== false;
  $('setRemoteAllowed').checked = settings.remoteAllowed !== false;
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
  if (result?.ok && state) {
    state.settings = result.settings;
    if (state.remote) state.remote.allowed = result.settings.remoteAllowed !== false;
  }
  render();
  renderModal();
}

function remoteEnabled() {
  return state?.settings?.remoteAllowed !== false && state?.remote?.allowed !== false;
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

async function inviteToNetwork() {
  const net = activeNetwork();
  if (!net) {
    toast('Сначала подключитесь к сети');
    return;
  }
  const result = await api('/api/invite/link', { id: net.id }).catch(() => null);
  if (!result?.ok) {
    // Profiles created before this feature did not keep the network password.
    // Re-entering it once is enough: the membership saves it on connect.
    if (String(result?.error || '').includes('Пароль')) {
      joinOpen = true;
      joinMode = 'join';
      $('joinError').hidden = true;
      $('networkName').value = net.network?.name || '';
      $('networkPassword').value = '';
      updateJoinMode();
      render();
      setTimeout(() => $('networkPassword').focus(), 60);
      toast('Введите пароль сети заново — он сохранится для ссылки');
      return;
    }
    toast(result?.error || 'Не удалось создать ссылку');
    return;
  }
  if (await copy(result.url)) toast('Ссылка-приглашение скопирована · внутри пароль сети');
  else toast(result.url);
}

/**
 * The shell passes `nurofen://join?...` to the backend, which keeps it until
 * the UI is ready. Filling the form is safer than joining silently: the user
 * still sees which network the link points to.
 */
function acceptInvite() {
  const invite = state?.invite;
  if (!invite) return;
  api('/api/invite/clear', {}).catch(() => {});
  joinOpen = true;
  joinMode = 'join';
  $('joinError').hidden = true;
  $('networkName').value = invite.name || '';
  $('networkPassword').value = invite.password || '';
  updateJoinMode();
  setTimeout(() => $('joinBtn').focus(), 60);
  toast(`Приглашение в «${invite.name}» — проверьте данные`);
}

/** Toast once per newly opened world; the first poll is the baseline. */
function announceWorlds() {
  const connected = new Set();
  const notify = state?.settings?.notifyWorlds !== false;
  for (const net of networks()) {
    if (net.status !== 'connected') continue;
    connected.add(net.id);
    const next = new Map();
    for (const peer of net.peers || []) {
      if (peer.self || !peer.online || !peer.lanPort) continue;
      next.set(`${peer.ip}:${peer.lanPort}`, peer.name || peer.ip);
    }
    const before = knownWorlds.get(net.id);
    if (before && notify) {
      for (const [address, name] of next) {
        if (!before.has(address)) toast(`${name} открыл мир — ${address}`);
      }
    }
    knownWorlds.set(net.id, new Set(next.keys()));
  }
  // A disconnected network starts from a fresh baseline on its next connect,
  // so reconnecting does not replay worlds that were already open.
  for (const id of knownWorlds.keys()) {
    if (!connected.has(id)) knownWorlds.delete(id);
  }
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
$('filesBtn').addEventListener('click', () => openTool('files'));
$('remoteBtn').addEventListener('click', () => openTool('remote'));
$('friendsBtn').addEventListener('click', () => openTool('friends'));
$('addNetBtn').addEventListener('click', openJoin);
$('joinBack').addEventListener('click', closeJoin);

$('playLaunch').addEventListener('click', () => launchPlay());

$('playRefresh').addEventListener('click', async () => {
  const button = $('playRefresh');
  button.disabled = true;
  button.classList.add('busy');
  try {
    const result = await api('/api/play/refresh');
    if (result?.ok && state) state.play = result.play;
    renderPlay();
  } finally {
    button.disabled = false;
    button.classList.remove('busy');
  }
});

$('playBuilds').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-play-build]');
  if (!button || button.disabled) return;
  const result = await api('/api/play/select', {
    launcher: button.dataset.playBuild,
    instance: button.dataset.playInstance,
  });
  if (!result?.ok) {
    toast(result?.error || 'Не удалось выбрать сборку');
    return;
  }
  if (state) state.play = result.play;
  renderPlay();
});

$('playWorlds').addEventListener('click', (event) => {
  const button = event.target.closest('[data-play-world]');
  if (!button || button.disabled) return;
  launchPlay({ address: button.dataset.playWorld, name: button.dataset.playWorldName || '' });
});

$('playExeBtn').addEventListener('click', () => {
  const row = $('playExeRow');
  row.hidden = !row.hidden;
  if (!row.hidden) $('playExePath').focus();
});

$('playExePath').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('playExeSave').click();
});

$('playExePick').addEventListener('click', async () => {
  const button = $('playExePick');
  button.disabled = true;
  try {
    const result = await api('/api/play/pick');
    if (result?.cancelled) return;
    if (!result?.path) {
      toast('Не удалось открыть выбор файла');
      return;
    }
    $('playExePath').value = result.path;
  } finally {
    button.disabled = false;
  }
});

$('playExeSave').addEventListener('click', async () => {
  const button = $('playExeSave');
  button.disabled = true;
  try {
    const result = await api('/api/play/exe', { path: $('playExePath').value.trim() });
    if (!result?.ok) {
      toast(result?.error || 'Не удалось сохранить путь');
      return;
    }
    if (state) state.play = result.play;
    const found = (result.play?.launchers || []).some((item) => item.available);
    toast(found ? 'Лаунчер найден' : 'Путь сохранён, но лаунчер не распознан');
    renderPlay();
  } finally {
    button.disabled = false;
  }
});

$('playExeAuto').addEventListener('click', async () => {
  const result = await api('/api/play/exe', { path: '' });
  if (!result?.ok) {
    toast(result?.error || 'Не удалось вернуть автоопределение');
    return;
  }
  if (state) state.play = result.play;
  $('playExeRow').hidden = true;
  toast('Поиск лаунчеров снова автоматический');
  renderPlay();
});

/* ---------------------------------------------------------- file transfer ui */

async function onTransferAction(event) {
  const button = event.target.closest('[data-transfer-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.transferAction;
  const id = button.dataset.transfer;
  button.disabled = true;
  try {
    const result = await api(`/api/files/${action}`, { id });
    if (!result?.ok) toast(result?.error || 'Не удалось выполнить действие');
    else if (action === 'reveal') toast('Файл открыт в папке');
    await poll();
  } catch {
    toast('Не удалось связаться с клиентом');
  } finally {
    button.disabled = false;
  }
}

$('transfersList').addEventListener('click', onTransferAction);
$('fileList').addEventListener('click', onTransferAction);

async function decideIncoming(action) {
  const transfer = pendingTransfers()[0];
  if (!transfer) return;
  const button = action === 'accept' ? $('incomingAccept') : $('incomingDecline');
  button.disabled = true;
  try {
    const result = await api(`/api/files/${action}`, { id: transfer.id });
    if (!result?.ok) toast(result?.error || 'Не удалось ответить на запрос');
    await poll();
  } catch {
    toast('Не удалось связаться с клиентом');
  } finally {
    button.disabled = false;
  }
}

$('incomingAccept').addEventListener('click', () => decideIncoming('accept'));
$('incomingDecline').addEventListener('click', () => decideIncoming('decline'));

$('filePick').addEventListener('click', async () => {
  const button = $('filePick');
  button.disabled = true;
  try {
    const result = await api('/api/files/pick');
    if (result?.cancelled) return;
    if (!result?.ok || !result.path) {
      toast(result?.error || 'Не удалось выбрать файл');
      return;
    }
    pickedFile = { path: result.path, name: result.name || 'файл', size: result.size || 0 };
    renderFiles();
  } finally {
    button.disabled = false;
  }
});

$('fileSend').addEventListener('click', async () => {
  if (!pickedFile || fileSending) return;
  const [networkId, peerId] = $('filePeer').value.split('|');
  if (!networkId || !peerId) {
    toast('Выберите участника в сети');
    return;
  }
  const file = pickedFile;
  fileSending = true;
  renderFiles();
  try {
    const result = await api('/api/files/send', { networkId, peerId, path: file.path });
    if (!result?.ok) {
      toast(result?.error || 'Не удалось отправить файл');
      return;
    }
    toast(`Запрос отправлен · ${file.name}`);
    pickedFile = null;
    await poll();
  } catch {
    toast('Не удалось отправить файл');
  } finally {
    fileSending = false;
    renderFiles();
  }
});

$('fileDirPath').addEventListener('input', () => { filesDirDirty = true; });

$('fileDirPick').addEventListener('click', async () => {
  const button = $('fileDirPick');
  button.disabled = true;
  try {
    const result = await api('/api/files/pick-dir');
    if (result?.cancelled) return;
    if (!result?.path) {
      toast('Не удалось открыть выбор папки');
      return;
    }
    $('fileDirPath').value = result.path;
    filesDirDirty = true;
    toast('Папка выбрана — нажмите «Сохранить»');
  } finally {
    button.disabled = false;
  }
});

$('fileDirSave').addEventListener('click', async () => {
  const button = $('fileDirSave');
  button.disabled = true;
  try {
    const value = $('fileDirPath').value.trim();
    const result = await api('/api/settings', { ...(state?.settings || {}), filesDir: value });
    if (!result?.ok) {
      toast(result?.error || 'Не удалось сохранить папку');
      return;
    }
    if (state) state.settings = result.settings;
    filesDirDirty = false;
    toast(value ? `Принятые файлы: ${value}` : 'Папка по умолчанию — Загрузки\\Nurofen');
    await poll();
    renderFiles();
  } finally {
    button.disabled = false;
  }
});

$('fileDirAuto').addEventListener('click', async () => {
  const button = $('fileDirAuto');
  button.disabled = true;
  try {
    const result = await api('/api/settings', { ...(state?.settings || {}), filesDir: '' });
    if (!result?.ok) {
      toast(result?.error || 'Не удалось вернуть папку по умолчанию');
      return;
    }
    if (state) state.settings = result.settings;
    filesDirDirty = false;
    $('fileDirPath').value = '';
    toast('Принятые файлы сохраняются в Загрузки\\Nurofen');
    await poll();
    renderFiles();
  } finally {
    button.disabled = false;
  }
});

/* --------------------------------------------------------------- friend list */

async function onFriendAction(event) {
  const file = event.target.closest('[data-friend-file]');
  if (file) {
    openTool('files', { net: file.dataset.friendNet || '', peer: file.dataset.friendFile || '' });
    return;
  }
  const invite = event.target.closest('[data-friend-invite]');
  if (invite) {
    invite.disabled = true;
    try {
      const result = await api('/api/invite/link', { id: invite.dataset.friendInvite });
      if (!result?.ok) {
        toast(result?.error || 'Не удалось создать ссылку');
        return;
      }
      if (await copy(result.url)) toast('Ссылка-приглашение скопирована · внутри пароль сети');
      else toast(result.url);
    } catch {
      toast('Не удалось создать ссылку');
    } finally {
      invite.disabled = false;
    }
    return;
  }
  const add = event.target.closest('[data-friend-add]');
  const remove = event.target.closest('[data-friend-remove]');
  const button = add || remove;
  if (!button || button.disabled) return;
  const peerId = add ? add.dataset.friendAdd : remove.dataset.friendRemove;
  button.disabled = true;
  try {
    const result = await api(add ? '/api/friends/add' : '/api/friends/remove', { peerId });
    if (!result?.ok) toast(result?.error || 'Не удалось изменить список друзей');
    else toast(add ? 'Друг добавлен' : 'Убран из друзей');
    await poll();
    renderFriends();
  } catch {
    toast('Не удалось связаться с клиентом');
  } finally {
    button.disabled = false;
  }
}

$('friendPeers').addEventListener('click', onFriendAction);
$('friendList').addEventListener('click', onFriendAction);

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
  if (event.target.closest('[data-version]')) countVersionClick();
});

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.action;
    closeMenus();
    if (action === 'toggle') toggleConnection();
    else if (action === 'add') openJoin();
    else if (action === 'invite') inviteToNetwork();
    else if (action === 'nickname') openTool('nickname');
    else if (action === 'update') openTool('update');
    else if (action === 'diagnostics') openTool('diagnostics');
    else if (action === 'settings') openTool('settings');
    else if (action === 'about') openTool('about');
    else if (action === 'play') openTool('play');
    else if (action === 'files') openTool('files');
    else if (action === 'friends') openTool('friends');
    else if (action === 'remote') openTool('remote');
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
      toast(`Сервер добавлен в «Сетевая игра» — ${address}`);
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
$('setNotify').addEventListener('change', (event) => saveSettings({ notifyWorlds: event.target.checked }));
$('setRemoteAllowed').addEventListener('change', (event) => saveSettings({ remoteAllowed: event.target.checked }));
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

/* ------------------------------------------------------------------ remote */

$('remoteStart').addEventListener('click', async () => {
  const target = $('remotePeer').value;
  if (!target) return;
  const [networkId, peerId] = target.split('|');
  const button = $('remoteStart');
  button.disabled = true;
  const result = await api('/api/remote/start', {
    networkId,
    peerId,
    control: $('remoteRequestControl').checked,
  }).catch(() => null);
  if (!result?.ok) {
    toast(result?.error || 'Не удалось запросить помощь');
    button.disabled = false;
    return;
  }
  $('remoteRequestControl').checked = false;
  await poll();
  renderRemote();
});

$('incomingRemoteControl').addEventListener('change', () => {
  $('incomingRemoteAccept').textContent = $('incomingRemoteControl').checked
    ? 'Разрешить управление'
    : 'Разрешить просмотр';
});

$('incomingRemoteAccept').addEventListener('click', async () => {
  const request = (state?.remote?.incoming || [])[0];
  if (!request) return;
  $('incomingRemoteAccept').disabled = true;
  try {
    await remoteAction('/api/remote/accept', { id: request.id, control: $('incomingRemoteControl').checked });
  } finally {
    $('incomingRemoteAccept').disabled = false;
  }
});

$('incomingRemoteDecline').addEventListener('click', async () => {
  const request = (state?.remote?.incoming || [])[0];
  if (!request) return;
  await remoteAction('/api/remote/decline', { id: request.id });
});

$('remoteBannerOpen').addEventListener('click', () => openTool('remote'));

$('remoteBannerStop').addEventListener('click', () => {
  const session = remoteCurrentSession();
  if (session) remoteAction('/api/remote/stop', { id: session.id });
});

$('remoteBannerControl').addEventListener('click', () => {
  const session = state?.remote?.host;
  if (session) remoteAction('/api/remote/control', { id: session.id, control: !session.control });
});

document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-remote-stop],[data-remote-dismiss],[data-remote-control]');
  if (!action) {
    const peer = event.target.closest('[data-remote-peer]');
    if (!peer) return;
    openTool('remote', { net: peer.dataset.remoteNet, peer: peer.dataset.remotePeer });
    return;
  }
  if (action.dataset.remoteStop) {
    remoteAction('/api/remote/stop', { id: action.dataset.remoteStop });
    return;
  }
  if (action.dataset.remoteDismiss) {
    remoteAction('/api/remote/dismiss', { id: action.dataset.remoteDismiss });
    return;
  }
  if (action.dataset.remoteControl) {
    remoteAction('/api/remote/control', {
      id: action.dataset.remoteControl,
      control: action.dataset.enabled === '1',
    });
  }
});

const REMOTE_VK = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  ContextMenu: 93,
};

const remoteTyped = new Map();

function remoteImageRect() {
  const image = $('remoteImage');
  const rect = image.getBoundingClientRect();
  const session = state?.remote?.viewer;
  const naturalWidth = image.naturalWidth || session?.width || 1280;
  const naturalHeight = image.naturalHeight || session?.height || 720;
  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
  };
}

function remotePoint(event) {
  const box = remoteImageRect();
  if (!box.width || !box.height) return null;
  return {
    x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
    y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)),
  };
}

function sendRemoteEvents(events) {
  const session = state?.remote?.viewer;
  if (!session?.active || !session.control || !events.length) return;
  remoteInputQueue.push(...events);
  if (!remoteInputTimer) remoteInputTimer = setTimeout(flushRemoteInput, 30);
}

$('remoteImage').addEventListener('mousemove', (event) => {
  const point = remotePoint(event);
  if (point) sendRemoteEvents([{ t: 'm', x: point.x, y: point.y }]);
});

$('remoteImage').addEventListener('mousedown', (event) => {
  const point = remotePoint(event);
  if (!point) return;
  const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left';
  sendRemoteEvents([{ t: 'm', x: point.x, y: point.y }, { t: 'b', b: button, d: true }]);
  event.preventDefault();
});

$('remoteImage').addEventListener('mouseup', (event) => {
  const point = remotePoint(event);
  const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left';
  sendRemoteEvents([...(point ? [{ t: 'm', x: point.x, y: point.y }] : []), { t: 'b', b: button, d: false }]);
  event.preventDefault();
});

$('remoteImage').addEventListener('contextmenu', (event) => event.preventDefault());

$('remoteImage').addEventListener('wheel', (event) => {
  const session = state?.remote?.viewer;
  if (!session?.active || !session.control) return;
  event.preventDefault();
  const delta = Math.max(-2400, Math.min(2400, Math.round(-event.deltaY)));
  if (delta) sendRemoteEvents([{ t: 'w', d: delta }]);
}, { passive: false });

function remoteKeyDown(event) {
  const session = state?.remote?.viewer;
  if (!session?.active || !session.control) return;
  const key = event.key;
  if (!key || key === 'Dead' || key === 'Unidentified' || key === 'Process') return;
  event.preventDefault();
  const id = event.code || key;
  const printable = key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey;
  if (printable) {
    remoteTyped.set(id, 'u');
    sendRemoteEvents([{ t: 'u', c: key.codePointAt(0) }]);
    return;
  }
  const vk = event.keyCode || REMOTE_VK[key] || 0;
  if (!vk) return;
  remoteTyped.set(id, 'k');
  sendRemoteEvents([{ t: 'k', vk, d: true }]);
}

function remoteKeyUp(event) {
  const session = state?.remote?.viewer;
  if (!session?.active || !session.control) return;
  const id = event.code || event.key;
  const mode = remoteTyped.get(id);
  remoteTyped.delete(id);
  if (!mode || mode === 'u') return;
  const vk = event.keyCode || REMOTE_VK[event.key] || 0;
  event.preventDefault();
  if (vk) sendRemoteEvents([{ t: 'k', vk, d: false }]);
}

$('remoteImage').addEventListener('keydown', remoteKeyDown);
$('remoteImage').addEventListener('keyup', remoteKeyUp);

/* -------------------------------------------------------------------- poll */

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    state = await res.json();
    // Utility windows share the same page; only the main window may open the
    // join form or raise toasts, otherwise an invite would be cleared there.
    if (!TOOL_KIND) {
      acceptInvite();
      announceWorlds();
    }
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

if (TOOL_KIND === 'play') {
  document.body.classList.add('play-window');
  document.title = 'Nurofen Play';
  $('playView').hidden = false;
  $('playExeRow').hidden = true;
} else if (TOOL_KIND && PANES[TOOL_KIND]) {
  document.body.classList.add('tool-window');
  document.body.dataset.tool = TOOL_KIND;
  document.title = `${PANES[TOOL_KIND][1]} — Nurofen`;
  openModal(TOOL_KIND);
}

poll();
setInterval(poll, 1500);
