# Нагадування та регулярні задачі

Коли користувач просить нагадати, налаштувати розклад, регулярну задачу чи дайджест.

## Тригери

Активуй цей скіл, коли чуєш: «нагадай», «не забудь», «щодня», «щоранку»,
«дайджест», «регулярно», «щотижня», «вимкни нагадування», «мої нагадування»,
«прибери нагадування», «перенеси на», «через N хвилин».

## Інструмент

```bash
node ~/.agent/bot/scripts/manage-schedule.js <command> [args]
```

ЗАБОРОНЕНО:
- crontab — не використовувати
- CronCreate / CronDelete / CronList — це інструменти ІНШОЇ системи, НЕ бота. НІКОЛИ їх не використовуй
- Ручна правка schedules.json — лише через manage-schedule.js
- Вигадані ID — не вигадуй ID, скрипт генерує їх сам

ЄДИНИЙ спосіб створити нагадування: `node ~/.agent/bot/scripts/manage-schedule.js add ...`

## Два типи payload

| payload | Коли | Що відбувається під час спрацювання |
|---------|-------|---------------------------------|
| reminder | «нагадай», «не забудь» (простий текст) | Бот надсилає текст дослівно. Claude НЕ викликається. Безкоштовно |
| task | «надсилай дайджест», «аналізуй», «склади звіт» | Бот викликає Claude з prompt. Claude виконує задачу |

## Відповідність фраз користувача

| Фраза | type | payload | параметри |
|-------|------|---------|-----------|
| «нагадай завтра о 9 подзвонити мамі» | once | reminder | at: завтра 09:00 ISO, text: "Подзвонити мамі" |
| «через 30 хвилин нагадай про дзвінок» | once | reminder | at: now+30m ISO, text: "Про дзвінок" |
| «щодня о 8 ранку нагадуй пити воду» | daily | reminder | hour: 8, minute: 0, text: "Пити воду" |
| «щоранку о 10 надсилай дайджест новин про AI» | daily | task | hour: 10, minute: 0, prompt: "Знайди останні новини про AI..." |
| «щоп'ятниці о 18:00 надсилай підсумки тижня» | weekly | task | hour: 18, weekdays: [5], prompt: "Прочитай memory/ за тиждень..." |
| «щопонеділка й щосереди о 9 нагадуй про тренування» | weekly | reminder | hour: 9, weekdays: [1,3], text: "Тренування" |

## Приклади команд

### Створити разове нагадування
```bash
node ~/.agent/bot/scripts/manage-schedule.js add '{"name":"Подзвонити мамі","type":"once","at":"2026-05-15T09:00:00+02:00","payload":"reminder","text":"Подзвонити мамі"}'
```

### Створити щоденний дайджест
```bash
node ~/.agent/bot/scripts/manage-schedule.js add '{"name":"AI дайджест","type":"daily","hour":10,"minute":0,"payload":"task","prompt":"Знайди останні новини про AI за вчора й сьогодні. Склади дайджест із 5-7 пунктів."}'
```

### Створити щотижневе нагадування
```bash
node ~/.agent/bot/scripts/manage-schedule.js add '{"name":"Підсумки тижня","type":"weekly","hour":18,"minute":0,"weekdays":[5],"payload":"task","prompt":"Прочитай memory/ за останній тиждень, GOALS.md. Склади короткі підсумки."}'
```

### Переглянути всі
```bash
node ~/.agent/bot/scripts/manage-schedule.js list
```

### Знайти за текстом
```bash
node ~/.agent/bot/scripts/manage-schedule.js search "дайджест"
```

### Вимкнути / Увімкнути / Змінити / Видалити
```bash
node ~/.agent/bot/scripts/manage-schedule.js disable <id>
node ~/.agent/bot/scripts/manage-schedule.js enable <id>
node ~/.agent/bot/scripts/manage-schedule.js update <id> '{"hour":8,"minute":0}'
node ~/.agent/bot/scripts/manage-schedule.js remove <id>
```

## Правила

1. Визнач текст і час із фрази користувача. Timezone: використовуй timezone зі state.json
2. Для «через N хвилин» — обчисли поточний час + N хвилин, передай як ISO datetime
3. Після створення — повідом користувачеві: що створено, коли спрацює
4. Після видалення/вимкнення — підтверди, що саме прибрав
5. Якщо користувач каже «мої нагадування» — покажи список (list) з назвами й часом
6. Якщо незрозуміло, reminder чи task, — спитай. Якщо просто «нагадай» — reminder. Якщо «надсилай/роби» — task
7. weekdays: 1=Пн, 2=Вт, 3=Ср, 4=Чт, 5=Пт, 6=Сб, 7=Нд
