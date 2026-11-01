#!/usr/bin/env python3
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
app_path = os.path.join(ROOT, "src", "app.js")
html_path = os.path.join(ROOT, "src", "index.html")
css_path = os.path.join(ROOT, "src", "style.css")

with open(app_path, "r", encoding="utf-8") as f:
    app_src = f.read()
with open(html_path, "r", encoding="utf-8") as f:
    html_src = f.read()
with open(css_path, "r", encoding="utf-8") as f:
    css_src = f.read()

# 1. IDs used via $('#id') in app.js and missing in index.html
ids = sorted(set(re.findall(r"\$\(['\"`](#[a-zA-Z0-9_-]+)['\"`]\)", app_src)))
missing_ids = []
for raw_id in ids:
    clean_id = raw_id[1:]
    pattern = rf'id=[\'"]{re.escape(clean_id)}[\'"]'
    if not re.search(pattern, html_src):
        missing_ids.append(clean_id)

print(f"IDs used in app.js missing in index.html: {len(missing_ids)}")
for i in missing_ids:
    print(f"  #{i}")

# 2. JS-added classes with no CSS rule
classes = set(re.findall(r"classList\.(?:add|toggle|remove)\(['\"`]([a-zA-Z0-9_-]+)['\"`]\)", app_src))
for m in re.findall(r'class=[\'"`]([^\'"`]+)[\'"`]', app_src):
    for part in m.split():
        if "${" not in part and "`" not in part and part.strip():
            classes.add(part.strip())

missing_classes = []
for c in sorted(classes):
    pattern = rf"\.{re.escape(c)}\b"
    if not re.search(pattern, css_src):
        missing_classes.append(c)

print(f"JS-added classes with no CSS rule: {len(missing_classes)}")
for c in missing_classes:
    print(f"  .{c}")

# 3. Inline script or handler count in index.html
inline_scripts = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html_src, re.DOTALL)
inline_handlers = re.findall(r'\son[a-zA-Z]+\s*=', html_src)
total_inline = len(inline_scripts) + len(inline_handlers)
print(f"Inline script count: {len(inline_scripts)}")
print(f"Inline event handler count: {len(inline_handlers)}")
print(f"Total inline scripts or handlers: {total_inline}")
