"""Обновляет читалку в desktop/dist под свежую сборку.

Файл лежит рядом с артефактами и уходит в релиз, поэтому правится скриптом: так в нём
не остаётся старых номеров версии и старых описаний. Номер берётся из VERSION в корне
репозитория — он же стоит в теге релиза и показывает программа.
"""

import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
DIST = pathlib.Path(__file__).resolve().parent.parent / "dist"
p = DIST / "README.txt"

CREDITS = """Кому принадлежит интерфейс
--------------------------
Программа основана на веб-конфигураторе «IO Hub» с web.io.vision — его версия
указана внизу экрана настроек. Оригинальный разработчик и правообладатель —
IO Red Square. Интерфейс сделан командой White Core: Никита Дергачёв,
Кирилл Андреев, Максим Рощупкин, Дмитрий Ивлев. Наша часть — офлайн-оболочка:
хост, доступ к клавиатуре и скрипты сборки; она под лицензией MIT, интерфейс —
при себе и своих правах (подробности в NOTICE в репозитории).

"""


def main() -> None:
    if not p.is_file():
        raise SystemExit(f"нет файла {p} — сначала соберите и разложите артефакты")
    text = p.read_text(encoding="utf-8")

    # Любой прежний номер в именах файлов и в строке «Собрано: …».
    text = re.sub(r"iohub-desktop_[\d.]+_x64-setup\.exe", f"iohub-desktop_{VERSION}_x64-setup.exe", text)
    text = re.sub(r"iohub-desktop-[\d.]+-portable\.zip", f"iohub-desktop-{VERSION}-portable.zip", text)
    text = re.sub(r"(Собрано: )[^\n,]+, версия [\d.]+",
                  rf"\g<1>{today()}, версия {VERSION}", text)

    if "Кому принадлежит интерфейс" not in text:
        anchor = "Если что-то не работает\n-----------------------"
        if anchor in text:
            text = text.replace(anchor, CREDITS + anchor)
        else:
            text = text.rstrip() + "\n\n" + CREDITS

    p.write_text(text, encoding="utf-8")
    print(f"обновлено: {p} (версия {VERSION})")


def today() -> str:
    from datetime import date

    months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля",
              "августа", "сентября", "октября", "ноября", "декабря"]
    d = date.today()
    return f"{d.day} {months[d.month - 1]} {d.year}"


if __name__ == "__main__":
    main()
