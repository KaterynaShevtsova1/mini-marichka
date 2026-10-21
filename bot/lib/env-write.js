// Локальний safe_env_write для user-бота.
// Портовано з bash-helpers provisioner/bot.js:276-374 (ENV_WRITE_HELPERS).
//
// Відмінності від bash-версії:
//  - не працює з chattr +i (наш .env не immutable)
//  - не використовує python3 fallback (усе на Node fs)
//  - атомарність через writeFile у .tmp + rename
//
// Формат запису: KEY="VALUE" (подвійні лапки) — сумісно і з bash `source`,
// і з systemd EnvironmentFile.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

function escapeValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function ensureDir(file) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readLines(file) {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8");
  if (raw === "") return [];
  const lines = raw.split("\n");
  // якщо файл закінчувався на \n, split дасть порожній хвостовий елемент — прибираємо
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

/**
 * Записати/оновити змінну KEY у файлі .env атомарно.
 * Видаляє всі наявні рядки, що починаються з `KEY=`, і додає один новий.
 *
 * @param {string} file - абсолютний шлях до .env
 * @param {string} key  - ім'я змінної (без =)
 * @param {string} value - значення (буде обгорнуте в подвійні лапки з екрануванням)
 * @returns {void} - кидає Error, якщо записати неможливо
 */
export function safeEnvWrite(file, key, value) {
  if (!file || !key) throw new Error("safeEnvWrite: file and key required");
  ensureDir(file);
  const lines = readLines(file).filter((l) => !l.startsWith(`${key}=`));
  lines.push(`${key}="${escapeValue(value)}"`);
  atomicWrite(file, lines.join("\n") + "\n");
}

/**
 * Видалити всі рядки зі змінною KEY з файлу .env атомарно.
 * Якщо файлу чи ключа немає — no-op (без помилки).
 *
 * @param {string} file - абсолютний шлях до .env
 * @param {string} key  - ім'я змінної
 */
export function safeEnvRemove(file, key) {
  if (!file || !key) throw new Error("safeEnvRemove: file and key required");
  if (!existsSync(file)) return;
  const lines = readLines(file).filter((l) => !l.startsWith(`${key}=`));
  atomicWrite(file, lines.length === 0 ? "" : lines.join("\n") + "\n");
}

/**
 * Прочитати значення змінної з .env (останнє входження, якщо їх кілька).
 * Знімає подвійні лапки, якщо вони є.
 *
 * @param {string} file
 * @param {string} key
 * @returns {string|null}
 */
export function safeEnvRead(file, key) {
  if (!existsSync(file)) return null;
  const lines = readLines(file);
  let val = null;
  for (const line of lines) {
    if (!line.startsWith(`${key}=`)) continue;
    let raw = line.slice(key.length + 1);
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      raw = raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    val = raw;
  }
  return val;
}
