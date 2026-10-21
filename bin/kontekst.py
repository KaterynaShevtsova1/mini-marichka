#!/usr/bin/env python3
"""«Контекст» з Notion: копія на сервер і запис у потрібний розділ сторінки.

  kontekst.py pull                              скопіювати всі сторінки «Контексту» в ~/workspace/kontekst/
  kontekst.py append <файл.md> "<розділ>" <текст|->   дописати текст у кінець розділу (- = з stdin)
  kontekst.py replace <файл.md> "<розділ>" <текст|->  замінити вміст розділу новим текстом

<файл.md> — назва з заголовка сторінки після «·» (positioning.md, voice_style.md, ...).
<розділ> — частина назви заголовка в сторінці («Так не кажу»). Немає такого — створю в кінці.
Ключ: NOTION_TOKEN у ~/.agent/.env. Сторінка: NOTION_KONTEKST_ID або пошук за назвою «Контекст».
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HOME = Path(os.environ.get("AGENT_HOME", "/home/agent"))
OUT = HOME / "workspace" / "kontekst"
API = os.environ.get("NOTION_API_BASE", "https://api.notion.com/v1")
VERSION = "2022-06-28"


def load_env():
    env = HOME / ".agent" / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf8").splitlines():
            m = re.match(r"\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$", line)
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip().strip('"').strip("'")


def call(method, path, body=None):
    token = os.environ.get("NOTION_TOKEN") or os.environ.get("NOTION_API_KEY")
    if not token:
        sys.exit("Немає ключа Notion (NOTION_TOKEN у ~/.agent/.env).")
    req = urllib.request.Request(
        API + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token}", "Notion-Version": VERSION,
                 "Content-Type": "application/json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                time.sleep(2 ** attempt)
                continue
            msg = e.read().decode(errors="replace")[:300]
            if e.code in (401, 403):
                sys.exit("Notion не пускає: ключ неправильний або сторінку «Контекст» не підключено до інтеграції.")
            if e.code == 404:
                sys.exit("Notion не бачить сторінку: підключи інтеграцію до сторінки «Контекст» (••• → Connections).")
            sys.exit(f"Notion помилка {e.code}: {msg}")
        except urllib.error.URLError as e:
            time.sleep(2 ** attempt)
            last = e
    sys.exit(f"Notion недоступний: {last}")


def children(block_id):
    out, cursor = [], None
    while True:
        q = f"/blocks/{block_id}/children?page_size=100" + (f"&start_cursor={cursor}" if cursor else "")
        r = call("GET", q)
        out += r.get("results", [])
        if not r.get("has_more"):
            return out
        cursor = r.get("next_cursor")


def plain(rich):
    return "".join(t.get("plain_text", t.get("text", {}).get("content", "")) for t in rich or [])


# ─── Notion → markdown ───────────────────────────────────────────────────────

def to_md(blocks, depth=0):
    lines, num = [], 0
    pad = "  " * depth
    for b in blocks:
        t = b.get("type")
        d = b.get(t, {}) or {}
        txt = plain(d.get("rich_text"))
        num = num + 1 if t == "numbered_list_item" else 0
        if t == "paragraph":
            lines.append(pad + txt if txt else "")
        elif t in ("heading_1", "heading_2", "heading_3"):
            lines += ["", "#" * int(t[-1]) + " " + txt]
        elif t == "bulleted_list_item":
            lines.append(f"{pad}- {txt}")
        elif t == "numbered_list_item":
            lines.append(f"{pad}{num}. {txt}")
        elif t == "to_do":
            lines.append(f"{pad}- [{'x' if d.get('checked') else ' '}] {txt}")
        elif t == "quote":
            lines.append(f"{pad}> {txt}")
        elif t == "callout":
            lines.append(f"{pad}> {txt}")
        elif t == "toggle":
            lines.append(f"{pad}▸ {txt}")
        elif t == "code":
            lines += ["```", txt, "```"]
        elif t == "divider":
            lines.append("---")
        elif t == "table_row":
            lines.append("| " + " | ".join(plain(c) for c in d.get("cells", [])) + " |")
        if b.get("has_children") and t not in ("child_page", "child_database"):
            lines += to_md(children(b["id"]), depth + (0 if t == "table" else 1))
    return lines


def file_name(title):
    m = re.search(r"([\w-]+\.md)\s*$", title)
    if m:
        return m.group(1)
    slug = re.sub(r"[^\w-]+", "-", title.lower()).strip("-")
    return (slug or "storinka") + ".md"


def find_root():
    pid = os.environ.get("NOTION_KONTEKST_ID", "").strip()
    if pid:
        return pid
    r = call("POST", "/search", {"query": "Контекст", "filter": {"property": "object", "value": "page"}})
    for p in r.get("results", []):
        props = p.get("properties", {})
        title = next((plain(v.get("title")) for v in props.values() if v.get("type") == "title"), "")
        if title.strip().lower() == "контекст":
            return p["id"]
    sys.exit("Не знайшла сторінку «Контекст». Перевір, що інтеграцію підключено саме до неї.")


def pages():
    return [(b["child_page"]["title"], b["id"]) for b in children(find_root()) if b.get("type") == "child_page"]


def pull_one(title, pid):
    md = "\n".join([f"# {title}", ""] + to_md(children(pid))).strip() + "\n"
    md = re.sub(r"\n{3,}", "\n\n", md)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / file_name(title)).write_text(md, encoding="utf8")
    return file_name(title)


def pull():
    got = [pull_one(t, i) for t, i in pages()]
    stamp = time.strftime("%Y-%m-%d %H:%M")
    (OUT / "README.md").write_text(
        f"Копія «Контексту» з Notion, {stamp}. Головна копія в Notion: правки тільки там.\n\n"
        + "\n".join(f"- {g}" for g in got) + "\n", encoding="utf8")
    print(f"Бачу «Контекст»: сторінок {len(got)} ({', '.join(got)}), копія в {OUT}")


# ─── markdown → Notion ───────────────────────────────────────────────────────

def rich(text):
    return [{"type": "text", "text": {"content": text[i:i + 1900]}} for i in range(0, len(text), 1900)] or []


def to_blocks(md):
    blocks = []
    for line in md.splitlines():
        s = line.rstrip()
        if not s.strip():
            continue
        if m := re.match(r"^(#{1,3})\s+(.*)", s):
            t = f"heading_{len(m.group(1))}"
            blocks.append({"type": t, t: {"rich_text": rich(m.group(2))}})
        elif m := re.match(r"^\s*- \[( |x)\]\s+(.*)", s):
            blocks.append({"type": "to_do", "to_do": {"rich_text": rich(m.group(2)), "checked": m.group(1) == "x"}})
        elif m := re.match(r"^\s*[-*•·]\s+(.*)", s):
            blocks.append({"type": "bulleted_list_item", "bulleted_list_item": {"rich_text": rich(m.group(1))}})
        elif m := re.match(r"^\s*\d+[.)]\s+(.*)", s):
            blocks.append({"type": "numbered_list_item", "numbered_list_item": {"rich_text": rich(m.group(1))}})
        elif m := re.match(r"^>\s?(.*)", s):
            blocks.append({"type": "quote", "quote": {"rich_text": rich(m.group(1))}})
        else:
            blocks.append({"type": "paragraph", "paragraph": {"rich_text": rich(s.strip())}})
    return blocks


def section(blocks, name):
    """(заголовок, блоки розділу) — розділ триває до наступного заголовка того ж чи вищого рівня."""
    want = name.strip().lower()
    for i, b in enumerate(blocks):
        t = b.get("type", "")
        if t.startswith("heading_") and want in plain(b[t].get("rich_text")).lower():
            level = int(t[-1])
            body = []
            for nb in blocks[i + 1:]:
                nt = nb.get("type", "")
                if nt.startswith("heading_") and int(nt[-1]) <= level:
                    break
                body.append(nb)
            return b, body
    return None, []


def page_by_file(fname):
    for title, pid in pages():
        if file_name(title) == fname or fname.lower() in title.lower():
            return title, pid
    sys.exit(f"У «Контексті» немає сторінки {fname}. Є: " + ", ".join(file_name(t) for t, _ in pages()))


def append_after(pid, after_id, blocks):
    for i in range(0, len(blocks), 90):
        body = {"children": blocks[i:i + 90]}
        if after_id:
            body["after"] = after_id
        r = call("PATCH", f"/blocks/{pid}/children", body)
        res = r.get("results") or []
        if after_id and res:
            after_id = res[-1]["id"]  # наступна пачка йде після останнього вставленого


def write(mode, fname, name, text):
    title, pid = page_by_file(fname)
    new = to_blocks(text)
    if not new:
        sys.exit("Порожній текст, нічого не записала.")
    blocks = children(pid)
    head, body = section(blocks, name)
    if head is None:
        append_after(pid, None, [{"type": "heading_2", "heading_2": {"rich_text": rich(name)}}] + new)
    else:
        if mode == "replace":
            for b in body:
                call("PATCH", f"/blocks/{b['id']}", {"archived": True})
            after = head["id"]
        else:
            after = (body[-1] if body else head)["id"]
        append_after(pid, after, new)
    pull_one(title, pid)
    print(f"Записала в «{title}», розділ «{name}» ({'замінила' if mode == 'replace' else 'дописала'}).")


def main():
    load_env()
    a = sys.argv[1:]
    if a[:1] == ["pull"]:
        return pull()
    if len(a) == 4 and a[0] in ("append", "replace"):
        text = sys.stdin.read() if a[3] == "-" else a[3]
        return write(a[0], a[1], a[2], text)
    print(__doc__)
    sys.exit(1)


if __name__ == "__main__":
    main()
