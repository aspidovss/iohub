"""Готовит текст релиза на GitHub: раздел из CHANGELOG.md + указание на базу и авторов.

Номер берётся из VERSION, чтобы описание релиза, тег и версия в программе всегда
сходились. Раздел CHANGELOG ищется по заголовку «## <версия>» и берётся до следующего
заголовка такого же уровня.

Запуск:
    python desktop/tools/release-notes.py [TAG]   # TAG вида v0.8.5.1, по умолчанию — VERSION
Результат печатается в stdout; в CI перенаправляется в файл для gh release create.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
VERSION = ROOT / "VERSION"
CHANGELOG = ROOT / "CHANGELOG.md"

BASE = "Интерфейс конфигуратора (веб-приложение web.io.vision), на котором основана эта сборка"
CREDITS = [
    "Оригинальный разработчик и правообладатель: IO Red Square («IO by Red Square», web.io.vision)",
    "Разработчик интерфейса White Core: Никита Дергачёв, Кирилл Андреев, Максим Рощупкин, Дмитрий Ивлев",
]
TAIL = [
    "Программа неофициальная: она не связана с производителем, не одобрена им и не "
    "поддерживается им. Собственный код оболочки — под лицензией MIT, интерфейс "
    "принадлежит его правообладателю (см. NOTICE).",
    "Установка и описание: README.md. Почта: iohub@aspidov.ru · Задачи: "
    "https://github.com/aspidovss/iohub/issues",
]


def version(tag: str) -> str:
    """Номер без буквы v: v0.8.5.1 -> 0.8.5.1; если тега нет — содержимое VERSION."""
    if tag:
        return tag.strip().lstrip("vV")
    return VERSION.read_text(encoding="utf-8").strip()


def section(text: str, ver: str) -> str:
    """Раздел CHANGELOG про версию ver: от её заголовка до следующего заголовка «## »."""
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if re.match(rf"^## {re.escape(ver)}\b", line):
            start = i + 1
        elif start is not None and line.startswith("## "):
            return "\n".join(lines[start:i]).strip()
    return "\n".join(lines[start:]).strip() if start is not None else ""


def interface_version() -> str:
    """Версия интерфейса прямо из дампа vendor/io-web — тот же источник, что у сборки.

    Считать её из номера релиза надёжно только пока у производителя четыре части; если
    производитель вернётся к трём, наши правки (0.9.0.2) выдали бы неверную базу.
    """
    sys.path.insert(0, str(ROOT / "desktop"))
    try:
        import prepare_webview as pw

        return pw.ui_version(pw.SRC / "assets")
    except Exception:
        return ""


def main() -> int:
    tag = sys.argv[1] if len(sys.argv) > 1 else ""
    ver = version(tag)
    body = section(CHANGELOG.read_text(encoding="utf-8"), ver) if CHANGELOG.is_file() else ""
    # Наши правки поверх той же базы добавляют пятую часть (0.8.5.1.2) — база при этом 0.8.5.1.
    parts = ver.split(".")
    ui = interface_version() or (".".join(parts[:4]) if len(parts) > 4 else ver)

    head = f"Основано на интерфейсе {ui}."
    if ver != ui:
        head += f" Номер {ver} — наши правки поверх той же базы, интерфейс тот же."
    out = [head, ""]
    out += [f"* {c}" for c in CREDITS]
    out += ["", BASE + " — не наш код, он распространяется своим правом; наша часть — "
            "офлайн-оболочка, мост WebHID и скрипты сборки.", ""]
    if body:
        out += [body, ""]
    out += TAIL
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
