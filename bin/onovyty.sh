#!/bin/bash
# Оновлення з шаблону курсу: правила, помічники, навички, скрипти, код бота.
# Її пам'ять (SOUL, MEMORY, GOALS, pravyla, memory/), «Контекст» і каруселі не чіпає.
set -euo pipefail
A=/home/agent; R=$A/repo
if grep -q '"onovlennia"[[:space:]]*:[[:space:]]*false' $A/workspace/komanda.json 2>/dev/null; then
  echo "Оновлення вимкнені власницею (komanda.json)."; exit 0
fi
cd $R
OLD=$(git rev-parse HEAD)
git fetch -q origin && git reset -q --hard origin/HEAD   # шаблон тільки читаємо, своїх змін тут немає
rsync -a "$R/agents/" $A/.claude/agents/
rsync -a "$R/skills/" $A/.claude/skills/
rsync -a --chmod=F755 "$R/bin/" $A/bin/
rsync -a "$R/shablony/" $A/shablony/
cp "$R/workspace/CLAUDE.md" $A/workspace/CLAUDE.md
rsync -a --exclude node_modules "$R/bot/" $A/.agent/bot/
# Бота перезапускаємо тільки якщо змінився його код: правила й навички він читає на кожному повідомленні
if ! git diff --quiet "$OLD" HEAD -- bot/; then
  (cd $A/.agent/bot && npm install --omit=dev --silent >/dev/null 2>&1) || true
  sudo /usr/bin/systemctl restart agent-bot && echo "Бота перезапущено (змінився код)."
fi
echo "Версія шаблону: $(cat $R/bot/VERSION) · $(git log -1 --format='%ad' --date=format:'%d.%m.%Y')"
