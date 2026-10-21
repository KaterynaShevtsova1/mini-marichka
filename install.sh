#!/bin/bash
# Встановлення Міні-Марічки на чистий сервер Ubuntu 24.04 (запускається від root один раз).
# Налаштування беремо з /root/mini-marichka.env (його кладе туди «розгорни» при створенні сервера):
#   BOT_TOKEN, OWNER_ID, NOTION_TOKEN, NOTION_KONTEKST_ID (можна порожнім), DEFAULT_TZ, REPO_URL
# Кожен крок пише власниці в Telegram, щоб вона бачила, що відбувається.
# Повторний запуск безпечний: пам'ять і файли власниці не перезаписуються.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive

CONF=/root/mini-marichka.env
[ -f "$CONF" ] || { echo "Немає $CONF"; exit 1; }
set -a; . "$CONF"; set +a
REPO_URL=${REPO_URL:-https://github.com/katerynashevtsova1/mini-marichka.git}
DEFAULT_TZ=${DEFAULT_TZ:-Europe/Kyiv}
A=/home/agent

tg() {
  [ -n "${BOT_TOKEN:-}" ] && [ -n "${OWNER_ID:-}" ] || return 0
  curl -s -m 15 "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${OWNER_ID}" --data-urlencode "text=$1" >/dev/null || true
}
fail() { tg "❌ Встановлення зупинилось: $1. Напиши про це в чат курсу, розгорнемо разом."; echo "FAIL: $1"; exit 1; }

tg "⏳ Сервер увімкнувся, починаю встановлення. Це 10-15 хвилин, я писатиму, що роблю."

# 1. Запасна пам'ять: на сервері 1 ГБ, Claude і браузер для каруселей без неї не вміщаються
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile \
    && echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
timedatectl set-timezone "$DEFAULT_TZ" 2>/dev/null || true

# 2. Програми
tg "⏳ 1/5 Ставлю програми…"
for i in 1 2 3; do apt-get update -qq && break; sleep 10; done
apt-get install -y -qq git curl rsync python3-venv ufw cron >/dev/null || fail "не поставились програми"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 || fail "не завантажився Node.js"
  apt-get install -y -qq nodejs >/dev/null || fail "не поставився Node.js"
fi
command -v claude >/dev/null || npm install -g --silent @anthropic-ai/claude-code >/dev/null 2>&1 || fail "не поставився Claude Code"
ufw allow OpenSSH >/dev/null 2>&1; ufw --force enable >/dev/null 2>&1

# 3. Користувач agent і файли з шаблону
tg "⏳ 2/5 Розкладаю свої файли…"
id agent >/dev/null 2>&1 || useradd -m -s /bin/bash agent
if [ -d $A/repo/.git ]; then
  sudo -u agent -H git -C $A/repo pull -q --ff-only || true
else
  sudo -u agent -H git clone -q "$REPO_URL" $A/repo || fail "не скачався шаблон з GitHub"
fi
R=$A/repo
sudo -u agent -H mkdir -p $A/.agent/bot $A/.claude/agents $A/.claude/skills $A/bin $A/shablony \
  $A/workspace/memory $A/workspace/kontekst $A/workspace/karuseli $A/workspace/.media $A/projects
sudo -u agent -H rsync -a --exclude node_modules "$R/bot/" $A/.agent/bot/
sudo -u agent -H rsync -a "$R/agents/" $A/.claude/agents/
sudo -u agent -H rsync -a "$R/skills/" $A/.claude/skills/
sudo -u agent -H rsync -a --chmod=F755 "$R/bin/" $A/bin/
sudo -u agent -H rsync -a "$R/shablony/" $A/shablony/
sudo -u agent -H cp "$R/workspace/CLAUDE.md" $A/workspace/CLAUDE.md
[ -f $A/.claude/settings.json ] || sudo -u agent -H cp "$R/settings.server.json" $A/.claude/settings.json
[ -f $A/workspace/memory/README.md ] || sudo -u agent -H cp "$R/workspace/memory/README.md" $A/workspace/memory/README.md

# Ключі: один файл, бачить тільки agent
ENVF=$A/.agent/.env
touch $ENVF
setkey() { grep -v "^$1=" $ENVF > $ENVF.tmp || true; echo "$1=$2" >> $ENVF.tmp; mv $ENVF.tmp $ENVF; }
setkey BOT_TOKEN "$BOT_TOKEN"
setkey OWNER_ID "$OWNER_ID"
setkey NOTION_TOKEN "${NOTION_TOKEN:-}"
setkey NOTION_KONTEKST_ID "${NOTION_KONTEKST_ID:-}"
setkey DEFAULT_TZ "$DEFAULT_TZ"
setkey AGENT_HOME "$A"
chown agent:agent $ENVF && chmod 600 $ENVF

(cd $A/.agent/bot && sudo -u agent -H npm install --omit=dev --silent >/dev/null 2>&1) || fail "не встановились частини бота"

# 4. Бот як служба: працює цілодобово і сам піднімається після перезавантаження
tg "⏳ 3/5 Вмикаю бота…"
cp $A/.agent/bot/agent-bot.service /etc/systemd/system/agent-bot.service
echo "agent ALL=(root) NOPASSWD: /usr/bin/systemctl restart agent-bot, /bin/systemctl restart agent-bot" > /etc/sudoers.d/agent-bot
chmod 440 /etc/sudoers.d/agent-bot
systemctl daemon-reload && systemctl enable -q agent-bot && systemctl restart agent-bot || fail "бот не запустився"

# Щоночі: копія «Контексту» о 03:00, оновлення з шаблону о 04:00
CRON="0 3 * * * $A/bin/kontekst.py pull >> $A/kontekst.log 2>&1
0 4 * * * $A/bin/onovyty.sh >> $A/onovyty.log 2>&1"
echo "$CRON" | crontab -u agent -

# 5. «Контекст» з Notion
tg "⏳ 4/5 Перевіряю доступ до твого «Контексту» в Notion…"
if OUT=$(sudo -u agent -H AGENT_HOME=$A $A/bin/kontekst.py pull 2>&1); then
  tg "✅ $(echo "$OUT" | tail -1 | sed 's|, копія в .*||')"
else
  tg "⚠️ «Контекст» поки не бачу: $(echo "$OUT" | tail -1). Бот працює, це можна виправити пізніше."
fi

# 6. Браузер для каруселей Марка (найдовший крок, бот уже працює)
tg "⏳ 5/5 Ставлю програму, якою Марко робить картинки каруселей. Це найдовше, до 10 хвилин."
sudo -u agent -H python3 -m venv $A/.venv >/dev/null 2>&1
KARUSEL=ok
sudo -u agent -H $A/.venv/bin/pip install -q playwright >/dev/null 2>&1 || KARUSEL=""
[ -n "$KARUSEL" ] && { $A/.venv/bin/python -m playwright install-deps chromium >/dev/null 2>&1 || true; }
[ -n "$KARUSEL" ] && { sudo -u agent -H $A/.venv/bin/python -m playwright install chromium >/dev/null 2>&1 || KARUSEL=""; }

date -Is > /root/.mini-marichka-done
if [ -n "$KARUSEL" ]; then
  tg "🎉 Готово! Усе встановлено. Напиши мені /start, і познайомимось."
else
  tg "🎉 Я працюю! Напиши мені /start, і познайомимось. Одне не встало: програма для картинок каруселей, тому Марко поки дає тільки HTML. Напиши про це в чат курсу, доставимо."
  echo "WARN: karusel"
fi
echo "OK"
