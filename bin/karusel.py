#!/home/agent/.venv/bin/python
# Рендер HTML-каруселі в PNG 1080x1350, по файлу на слайд.
# Використання: ~/bin/karusel.py <carousel.html> <папка_для_png>
# Слайди шукаються за селектором .slide (або [data-slide]).
# Рендер по одній каруселі за раз: сервер має 1 ГБ пам’яті.
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

W, H = 1080, 1350
SELECTOR = ".slide, [data-slide]"

ISOLATE_JS = """
({ i, W, H, SELECTOR }) => {
  const s = document.querySelectorAll(SELECTOR)[i];
  const holder = document.createElement('div');
  holder.style.cssText = `position:fixed;inset:0;width:${W}px;height:${H}px;z-index:2147483647;overflow:hidden;background:#fff;`;
  const clone = s.cloneNode(true);
  Object.assign(clone.style, {
    transform: 'none', position: 'relative', left: '0', top: '0',
    width: `${W}px`, height: `${H}px`, opacity: '1', visibility: 'visible',
  });
  holder.appendChild(clone);
  document.body.appendChild(holder);
}
"""


def main():
    if len(sys.argv) != 3:
        print("Використання: ~/bin/karusel.py <carousel.html> <папка_для_png>")
        sys.exit(1)
    html = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[2]).resolve()
    out.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        kwargs = {}
        if os.path.exists("/opt/pw-browsers/chromium"):  # хмарна сесія Claude Code
            kwargs["executable_path"] = "/opt/pw-browsers/chromium"
        browser = p.chromium.launch(args=["--disable-dev-shm-usage"], **kwargs)
        page = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)

        page.goto(html.as_uri(), wait_until="networkidle")
        count = page.evaluate(f"document.querySelectorAll('{SELECTOR}').length")
        if not count:
            print("Не знайдено жодного .slide у HTML")
            sys.exit(2)

        for i in range(count):
            page.goto(html.as_uri(), wait_until="networkidle")
            page.evaluate("document.fonts.ready")
            page.evaluate(ISOLATE_JS, {"i": i, "W": W, "H": H, "SELECTOR": SELECTOR})
            page.wait_for_timeout(150)
            f = out / f"slide-{i + 1:02d}.png"
            page.screenshot(path=str(f), clip={"x": 0, "y": 0, "width": W, "height": H})
            print(f)
        browser.close()


if __name__ == "__main__":
    main()
