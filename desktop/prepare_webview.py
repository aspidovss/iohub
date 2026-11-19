"""Готовит webview/ из дампа SPA: чинит пути, внедряет шим WebHID, зонд оставляет отдельной страницей.

Запускать после любого изменения в vendor/io-web/ или webview/, затем пересобирать desktop/.
"""

import re
import shutil
import sys
from pathlib import Path

# Отчёт печатается по-русски, а консоль в сборочной среде может быть в кодировке
# Windows (cp1252/cp866) или вовсе без кодировки. Просим Python писать UTF-8, иначе
# сборка падает на последнем сообщении, когда вся работа уже сделана.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "vendor" / "io-web"
DST = ROOT / "webview"

# Сохранённая браузером копия указывает на файл .download, которого у нас нет.
BROKEN = re.compile(r"<script[^>]*\.download[^>]*>\s*</script>")
# Настоящее подключение модуля, которое оставил сборщик.
MODULE = re.compile(r'(<script type="module"[^>]*src="/assets/[^"]+\.js"></script>)')
SHIM = '<script src="./webhid-shim.js"></script>'

# Три правки в одном месте — в конфигурации ссылок бренда внутри собранного файла.
# Интерфейс читает эти поля через геттеры, поэтому значения можно подставить уже во время
# работы программы, а не зашивать в дамп.
#   legacy       — ссылка на «старый софт», в нашей программе кнопки быть не должно;
#                  адрес не выбрасываем, он переезжает в legacyHidden
#   firmware     — список прошивок: адреса у производителя в конфигурации нет
#                  (проверено по живой копии сайта), кладём в файл firmware.url
#   supportEmail — включает штатный канал «Почта» в форме «Сообщить об ошибке»
LINKS_ANCHOR = "links:{legacy:"
LINKS_PATCH = (
    "links:{legacy:null,"
    "get firmware(){return window.__iohubFirmwareLink||null},"
    "get supportEmail(){return window.__iohubSupportEmail||null},"
    "legacyHidden:"
)


# Более ранние виды этой же правки: если в webview/ лежит файл с ними, обновляем на месте.
LINKS_PREVIOUS = [
    "links:{get firmware(){return window.__iohubFirmwareLink||null},legacy:",
]

# Вывеска окна. Страница приносит заголовок бренда, а программа называется иначе;
# сам интерфейс заголовок не меняет, так что достаточно правки в index.html.
TITLE_OLD = "<title>IO Hub</title>"
TITLE_NEW = "<title>iohub-desktop</title>"


def patch_brand_links(assets: Path) -> str:
    """Перезаписывает конфигурацию ссылок бренда. Возвращает имя изменённого файла."""
    for f in sorted(assets.glob("index-*.js")):
        text = f.read_text(encoding="utf-8")
        if LINKS_PATCH in text:
            return f.name
        for old in LINKS_PREVIOUS:
            if old in text:
                f.write_text(text.replace(old, LINKS_PATCH, 1), encoding="utf-8")
                return f.name
        if text.count(LINKS_ANCHOR) == 1:
            f.write_text(text.replace(LINKS_ANCHOR, LINKS_PATCH, 1), encoding="utf-8")
            return f.name
    raise SystemExit("не нашёл конфигурацию ссылок в assets/index-*.js — проверь дамп интерфейса")


def main() -> None:
    if not (SRC / "index.html").is_file():
        raise SystemExit(f"нет дампа интерфейса: {SRC}\nсохрани страницу web.io.vision целиком и разверни её сюда")
    DST.mkdir(parents=True, exist_ok=True)

    # Зонд жил в index.html — переезжает, освобождая место приложению.
    probe = DST / "probe.html"
    current = DST / "index.html"
    if current.exists() and not probe.exists() and "webhid-shim.js" in current.read_text(encoding="utf-8"):
        current.replace(probe)

    for folder in ("assets", "devices"):
        src = SRC / folder
        if not src.is_dir():
            continue
        dst = DST / folder
        dst.mkdir(parents=True, exist_ok=True)
        for f in src.rglob("*"):
            if f.is_file():
                target = dst / f.relative_to(src)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, target)

    # Редактор однажды приписал шиму BOM. Браузеру он безразличен, а вот проверке файла
    # и диффам мешает — убираем, если он снова появится.
    shim = DST / "webhid-shim.js"
    if shim.exists() and shim.read_bytes().startswith(b"\xef\xbb\xbf"):
        shim.write_bytes(shim.read_bytes()[3:])

    # Краткая справка: лежит в docs/ и становится страницей help.html, которую шим
    # подсовывает окну «Справка». Отдельным файлом — чтобы текст можно было править,
    # не трогая код шима, и читать в репозитории глазами.
    help_src = ROOT / "docs" / "app-help.html"
    if help_src.is_file():
        shutil.copy2(help_src, DST / "help.html")

    html = (SRC / "index.html").read_text(encoding="utf-8")
    html = BROKEN.sub("", html)
    if SHIM not in html:
        if not MODULE.search(html):
            raise SystemExit("не нашёл подключение ES-модуля в index.html дампа — проверь разметку")
        html = MODULE.sub(SHIM + "\n    " + r"\1", html, count=1)
    html = "\n".join(ln for ln in html.splitlines() if "saved from url" not in ln)
    titled = TITLE_OLD in html
    if titled:
        html = html.replace(TITLE_OLD, TITLE_NEW)

    (DST / "index.html").write_text(html + "\n", encoding="utf-8")
    patched = patch_brand_links(DST / "assets")
    count = len([p for p in (DST / "assets").rglob("*") if p.is_file()])
    sign = "iohub-desktop" if titled else "как в дампе"
    help = "help.html" if (DST / "help.html").is_file() else "НЕТ"
    print(f"webview собран: index.html (шим внедрён), assets: {count}, "
          f"ссылки бренда: {patched}, вывеска окна: {sign}, зонд: probe.html, справка: {help}")


if __name__ == "__main__":
    main()
