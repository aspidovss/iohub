"""Проверка сохранённого отчёта: номер, поля и не осталось ли в тексте имени пользователя."""
import pathlib
import re
import sys
import os

folder = pathlib.Path(os.environ["APPDATA"]) / "vision.io.hub.desktop" / "reports"
files = sorted(folder.glob("*.txt"), key=lambda p: p.stat().st_mtime)
if not files:
    print("папка reports пуста:", folder)
    sys.exit(1)

f = files[-1]
text = f.read_text(encoding="utf-8")
print("файл:", f.name, "размер:", len(text))

# Номер отчёта и его хвост: имя файла обязано кончиться теми же восемью символами.
ticket = re.search(r"HUB-\d{8}-[0-9A-F]{8}", text)
tail = ticket.group(0)[-8:] if ticket else ""

home = os.environ.get("USERPROFILE", "")
user = os.environ.get("USERNAME", "")
checks = {
    # Имя пользователя ищем именно в путях: короткое имя вроде «us» встречается
    # внутри обычных латинских слов (status, Devices), обычный поиск дал бы ложную тревогу.
    "имя пользователя в путях": (f"\\{user}\\" in text) or (f"Users\\{user}" in text),
    "домашняя папка в путях": bool(home) and home in text,
    "заголовок страницы iohub-desktop": "заголовок: iohub-desktop" in text,
    "версия программы": re.search(r"iohub-desktop \d+\.\d+\.\d+", text) is not None,
    "номер отчёта": ticket is not None,
    "время составления": "составлен " in text,
    "версия интерфейса": "интерфейс: " in text,
    "язык интерфейса": "язык интерфейса: " in text,
    "действия перед обращением": "действия перед обращением:" in text,
    "имя файла созвучно номеру": bool(tail) and f.stem.endswith(tail),
    "journal tail": "журнал, последние 200 строк" in text,
    "шум перечисления устройств убран": "дескриптор " not in text,
    "вендоров мыши/клавиатуры видно": "05ac:024f" in text,
}
for name, ok in checks.items():
    good = ok if name not in ("имя пользователя в путях", "домашняя папка в путях") else not ok
    print(("хорошо  " if good else "ПЛОХО   ") + name)
print("--- начало отчёта ---")
print("\n".join(text.splitlines()[:8]))
