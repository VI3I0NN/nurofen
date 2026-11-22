// Public landing page with the Windows client installer.
// Everything is inline: the server has no static file directory of its own.

export const downloadPage = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Nurofen — скачать для Windows</title>
<style>
  :root {
    --bg: #0b0e13;
    --surface: #131820;
    --line: #232c38;
    --text: #e8eef6;
    --muted: #8a97a8;
    --green: #3ddc84;
    --green-dim: #1c3b2a;
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0;
    display: grid;
    place-items: center;
    padding: 32px 18px;
    background:
      radial-gradient(900px 500px at 50% -10%, #16212b 0%, transparent 70%),
      var(--bg);
    color: var(--text);
    font: 15px/1.6 -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { width: 100%; max-width: 520px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 26px; }
  .mark { width: 30px; height: 30px; color: var(--green); flex: 0 0 auto; }
  .brand-name { font-weight: 650; letter-spacing: .2px; font-size: 17px; }
  .brand-sub { color: var(--muted); font-size: 12px; }
  h1 { margin: 0 0 10px; font-size: 27px; line-height: 1.25; letter-spacing: -.3px; }
  .lead { margin: 0 0 26px; color: var(--muted); font-size: 14.5px; }
  .panel {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 20px;
  }
  .download {
    display: flex; align-items: center; justify-content: center; gap: 10px;
    min-height: 52px; padding: 14px 18px;
    border-radius: 10px; border: 1px solid #2d5f42;
    background: var(--green-dim); color: #bef7d5;
    font-size: 15px; font-weight: 600; text-decoration: none;
    transition: background .15s ease;
  }
  .download:hover { background: #235038; }
  .download svg { width: 19px; height: 19px; flex: 0 0 auto; }
  .meta {
    margin: 12px 0 0; text-align: center;
    color: var(--muted); font-size: 12.5px;
  }
  .meta.hint { margin-top: 6px; font-size: 12px; color: #9d8c62; }
  .steps { margin: 24px 0 0; padding: 0; list-style: none; counter-reset: step; }
  .steps li {
    counter-increment: step;
    position: relative;
    padding: 0 0 16px 34px;
    color: #c7d2df; font-size: 14px;
  }
  .steps li:last-child { padding-bottom: 0; }
  .steps li::before {
    content: counter(step);
    position: absolute; left: 0; top: 1px;
    width: 22px; height: 22px; border-radius: 50%;
    display: grid; place-items: center;
    background: #1a212b; border: 1px solid var(--line);
    color: var(--green); font: 600 11px/1 ui-monospace, Consolas, monospace;
  }
  .steps b { color: var(--text); font-weight: 600; }
  .note {
    margin: 22px 0 0; padding-top: 18px;
    border-top: 1px solid var(--line);
    color: var(--muted); font-size: 13px;
  }
  code {
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 12.5px; color: #c7d2df;
  }
  @media (max-width: 420px) {
    h1 { font-size: 23px; }
    .panel { padding: 16px; }
  }
</style>
</head>
<body>
<main>
  <div class="brand">
    <svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 17.5 12 5l7 12.5" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="5" cy="17.5" r="2.4" fill="currentColor"/>
      <circle cx="19" cy="17.5" r="2.4" fill="currentColor"/>
      <circle cx="12" cy="5" r="2.4" fill="currentColor"/>
    </svg>
    <div>
      <div class="brand-name">Nurofen</div>
      <div class="brand-sub">виртуальная локальная сеть</div>
    </div>
  </div>

  <h1>Скачайте Nurofen<br>и подключитесь к друзьям</h1>
  <p class="lead">
    Сеть для игр и файлов: у каждого свой адрес вида <code>10.66.0.x</code>,
    как будто компьютеры стоят в одной комнате. Сетей можно создать сколько
    нужно — они не пересекаются.
  </p>

  <div class="panel">
    <a class="download" href="/dl/NurofenSetup.exe" download>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/>
      </svg>
      Скачать для Windows
    </a>
    <p class="meta">Windows 10/11 · x64 · установщик попросит права администратора</p>
    <p class="meta">Отдельное окно на Electron: браузер на компьютере не нужен.</p>
    <p class="meta hint">SmartScreen может предупредить, потому что файл без платной подписи:
      нажмите «Подробнее» → «Выполнить в любом случае».</p>
  </div>

  <ol class="steps">
    <li>Запустите скачанный <b>NurofenSetup.exe</b> и дождитесь окончания установки.
        Интернет нужен: установщик докачает Node.js и AmneziaWG, если их нет.</li>
    <li>Откроется Nurofen, уже настроенный на сервер. Создайте сеть или введите
        название и пароль существующей сети.</li>
    <li>Нажмите круглую кнопку питания в карточке устройства и отправьте друзьям свой
        адрес <code>10.66.0.x</code>. Закрытие окна прячет клиент в трей — сеть
        продолжает работать.</li>
    <li>Нужна ещё одна сеть — нажмите <b>«+»</b> над карточкой устройства. Сети
        работают одновременно, вкладки только переключают, какую из них видно.</li>
    <li>Клиент сам сообщит о новой версии в меню <b>«Система → Обновления…»</b> и
        обновится без повторной установки программы.</li>
  </ol>

  <p class="note">
    Nurofen — не VPN «в интернет»: он создаёт отдельную сеть только для участников.
    Удалить программу можно через «Программы и компоненты».<br>
    Разработчик — VI3I0NN.
  </p>
</main>
</body>
</html>`;
