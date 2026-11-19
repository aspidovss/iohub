"""Ищет признаки портативной конфигурации через meta-теги и любые точки настройки ссылок."""
import re
from pathlib import Path

root = Path(__file__).resolve().parents[2] / "webview"
assets = root / "assets"
# главный бандл собирается с хэшем в имени и берётся как самый большой index-*.js
bundle_file = max(assets.glob("index-*.js"), key=lambda p: p.stat().st_size)
bundle = bundle_file.read_text(encoding="utf-8", errors="replace")
index = (root / "index.html").read_text(encoding="utf-8", errors="replace")
print(f"бандл: {bundle_file.name}")

print("=== meta-теги, о которых знает код ===")
for m in list(re.finditer(r"meta\[name=\\?[\"'`]([a-z0-9\-]+)", bundle))[:20]:
    seg = bundle[max(0, m.start() - 200):m.start() + 260].replace("\n", " ")
    print(" •", seg)
    print("-" * 30)

print()
print("=== meta-теги в index.html ===")
for m in re.finditer(r"<meta[^>]+>", index):
    print(" •", m.group(0))

print()
print("=== qo (портативный режим) ===")
m = re.search(r"function qo\(e\)", bundle)
if m:
    print(bundle[m.start():m.start() + 700].replace("\n", " "))
