# Установка сервера

## Требования

- VPS с публичным IPv4, 1 vCPU / 512 МБ RAM хватает на 10–20 человек.
- Ubuntu 22.04/24.04 или Debian 12+.
- Root-доступ (или sudo без пароля).
- Провайдер не блокирует UDP. Проверить заранее:
  `nc -u -v <ip> 9999` с домашней машины (не паникуйте, если молчит — UDP
  безответный; лучше проверять уже после установки через сам клиент).

## Установка

```bash
git clone https://github.com/VI3I0NN/nurofen.git
cd nurofen
sudo bash server/install/install.sh --host <публичный-ip>
```

Что произойдёт:

1. `apt-get` поставит `iptables`, `dkms`, заголовки ядра, `git`.
2. Node.js 22 — из NodeSource, если системного нет.
3. AmneziaWG — из PPA `ppa:amnezia/ppa` (Ubuntu) или сборкой из исходников с
   DKMS (Debian/если PPA недоступен).
4. Включится `net.ipv4.ip_forward`, загрузится модуль `amneziawg`.
5. Код сервера разложится в `/opt/nurofen`, состояние — в `/etc/nurofen`.
6. Случайный UDP-порт для туннеля, свободные порты из `443,500,4500,8443`
   добавятся в пул.
7. Запустится `nurofen.service`, откроются порты в `ufw` (если он активен).

В конце установщик печатает:

```
API / admin panel   http://<ip>:8787/admin
Admin token         <токен>
Invite code         ABCD-EFGH
Tunnel endpoint     <ip>:47231/udp
```

**Сохраните токен админа** — он в `/etc/nurofen/nurofen.json` и больше нигде.

## Параметры установщика

| Флаг | Значение по умолчанию | Зачем |
|---|---|---|
| `--host <ip>` | определяется автоматически | адрес, который увидят клиенты |
| `--port <udp>` | случайный 20000–60000 | основной порт туннеля |
| `--pool <list>` | `443,500,4500,8443` | дополнительные порты (занятые пропускаются) |
| `--api-port <tcp>` | `8787` | порт панели и API |
| `--no-firewall` | — | не трогать `ufw` |

## Проверка

```bash
systemctl status nurofen
journalctl -u nurofen -n 30 --no-pager
cd /opt/nurofen/server && node src/cli.js info
```

`cli.js info` покажет код приглашения, токен, адрес, пул портов и список устройств.

## Обновление

```bash
cd ~/nurofen && git pull
sudo bash server/install/install.sh --host <ip>   # идемпотентен
```

Состояние в `/etc/nurofen` не перезаписывается: ключи, код приглашения и
устройства сохраняются.

## Смена порта или параметров обфускации

```bash
cd /opt/nurofen/server
node src/cli.js ports 443,8443      # пул портов
node src/cli.js reseed              # новые Jc/S1/H1..H4 (клиенты переподключатся)
systemctl restart nurofen
```

После `reseed` всем клиентам нужно переподключиться: они получат новые параметры
при следующем `state`/`join`. Приватные ключи при этом не меняются.

## Удаление

```bash
sudo bash server/install/uninstall.sh
```

Остановит службу, опустит интерфейс, снесёт правила `iptables` и, если попросить,
`/etc/nurofen`.

## Если что-то не так

| Симптом | Что смотреть |
|---|---|
| `nurofen.service` падает | `journalctl -u nurofen -n 80`; чаще всего нет `awg` в PATH |
| Клиент не видит хаб | `awg show nurofen0` на сервере: есть ли handshake, приходят ли байты |
| Handshake есть, ping нет | `ufw` режет `in on nurofen0`; `sysctl net.ipv4.ip_forward` |
| Порт занят | `ss -lunp` и `--port` при переустановке |
| Модуль не собрался | ядро без заголовков: `apt install linux-headers-$(uname -r)` |

Docker на VPS не мешает: правила `NUROFEN_PORTS` живут в `nat PREROUTING` и не
конфликтуют с `DOCKER`-цепочками, пока вы не занимаете те же порты.
