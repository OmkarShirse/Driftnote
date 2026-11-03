#!/usr/bin/env python3
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
app_path = os.path.join(ROOT, "src", "app.js")
html_path = os.path.join(ROOT, "src", "index.html")
css_path = os.path.join(ROOT, "src", "style.css")
allow_path = os.path.join(ROOT, "tools", "check.allow")

with open(app_path, "r", encoding="utf-8") as f:
    app_src = f.read()
with open(html_path, "r", encoding="utf-8") as f:
    html_src = f.read()
with open(css_path, "r", encoding="utf-8") as f:
    css_src = f.read()

allowed = set()
if os.path.exists(allow_path):
    with open(allow_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                allowed.add(line.lstrip("#."))

# 1. IDs used in app.js via $('#id'), $$('#id'), getElementById('id'), querySelector('#id')
ids = set()
for m in re.findall(r"\$\(['\"`](#[a-zA-Z0-9_-]+)['\"`]\)", app_src):
    ids.add(m[1:])
for m in re.findall(r"\$\$\(['\"`](#[a-zA-Z0-9_-]+)", app_src):
    ids.add(m[1:])
for m in re.findall(r"querySelector(?:All)?\(['\"`](#[a-zA-Z0-9_-]+)", app_src):
    ids.add(m[1:])
for m in re.findall(r"getElementById\(['\"`]([a-zA-Z0-9_-]+)['\"`]\)", app_src):
    ids.add(m)

missing_ids = []
for clean_id in sorted(ids):
    pattern = rf'id=[\'"]{re.escape(clean_id)}[\'"]'
    if not re.search(pattern, html_src):
        if clean_id not in allowed:
            missing_ids.append(clean_id)

print(f"IDs used in app.js missing in index.html: {len(missing_ids)}")
for i in missing_ids:
    print(f"  #{i}")

# (d) Duplicate IDs in index.html
all_html_ids = re.findall(r'id=[\'"]([^\'"]+)[\'"]', html_src)
seen = set()
dup_ids = []
for i in all_html_ids:
    if i in seen and i not in dup_ids:
        dup_ids.append(i)
    seen.add(i)
dup_ids.sort()
print(f"Duplicate IDs in index.html: {len(dup_ids)}")
for i in dup_ids:
    print(f"  #{i}")

# 2. Classes
classes = set(re.findall(r"classList\.(?:add|toggle|remove)\(['\"`]([a-zA-Z0-9_-]+)['\"`]\)", app_src))
for m in re.findall(r'class=[\'"`]([^\'"`]+)[\'"`]', app_src):
    for part in m.split():
        if "${" not in part and "`" not in part and part.strip():
            classes.add(part.strip())

# (a) element.className = '...' and className +=
# For templated names like 'a ' + (x ? 'b' : 'c') extract every quoted literal
for expr in re.findall(r'className\s*(?:\+)?=\s*([^;\n]+)', app_src):
    for lit in re.findall(r'[\'"]([^\'"]*)[\'"]', expr):
        for part in lit.split():
            part = part.strip()
            if part and re.match(r'^[a-zA-Z0-9_-]+$', part):
                classes.add(part)

# (b) classes in index.html class attributes
for m in re.findall(r'class=[\'"]([^\'"]+)[\'"]', html_src):
    for part in m.split():
        part = part.strip()
        if part:
            classes.add(part)

# (e) classes referenced in CSS-only state selectors are ignored
state_classes = set()
for sel in re.findall(r'([^{}]+)\{', css_src):
    if re.search(r':[a-zA-Z-]+', sel):
        for c in re.findall(r'\.([a-zA-Z0-9_-]+)', sel):
            state_classes.add(c)

filtered_classes = {c for c in classes if c not in state_classes and c not in allowed}

missing_classes = []
for c in sorted(filtered_classes):
    pattern = rf"\.{re.escape(c)}\b"
    if not re.search(pattern, css_src):
        missing_classes.append(c)

print(f"Classes with no CSS rule: {len(missing_classes)}")
for c in missing_classes:
    print(f"  .{c}")

# 3. Inline script or handler count in index.html
inline_scripts = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html_src, re.DOTALL)
inline_handlers = re.findall(r'\son[a-zA-Z]+\s*=', html_src)
total_inline = len(inline_scripts) + len(inline_handlers)
print(f"Inline script count: {len(inline_scripts)}")
print(f"Inline event handler count: {len(inline_handlers)}")
print(f"Total inline scripts or handlers: {total_inline}")

if missing_ids or missing_classes or dup_ids:
    sys.exit(1)
