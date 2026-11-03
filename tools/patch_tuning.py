import re,sys,shutil
p='src/style.css'
css=open(p,encoding='utf-8').read()
m='VISUAL TUNING v1'
if m not in css: sys.exit('marker not found')
if 'VISUAL TUNING v1.1' in css: sys.exit('already patched')
i=css.index(m)
head,tail=css[:i],css[i:]
rules=[('node border override',r'(?m)^\.node::before\s*\{[^}]*\}[ \t]*\n?'),
('selected card ring override',r'(?m)^\.node\.sel::before\s*\{[^}]*\}[ \t]*\n?'),
('fixed 30px toolbar height',r'(?m)^\.card-toolbar,\s*\n#tb\s*\{[^}]*height:\s*30px[^}]*\}[ \t]*\n?'),
('tree active tint',r'(?m)^\.tree-row\.active\s*\{[^}]*\}[ \t]*\n?')]
for name,rx in rules:
    tail,n=re.subn(rx,'',tail,count=1)
    print(('removed: ' if n else 'NOT FOUND: ')+name)
add='''
/* VISUAL TUNING v1.1 (delete this block to undo the fixes) */
.card-toolbar { height: auto; min-height: 30px; display: flex; flex-wrap: wrap; align-items: center; }
.tree-row.active { background: color-mix(in srgb, var(--acc) 14%, var(--panel)); color: var(--ink); font-weight: 600; box-shadow: inset 2px 0 0 var(--acc); }
.tree-row.active .icon, .tree-row.active .chevron { color: var(--acc); }
'''
shutil.copy(p,p+'.pre-v11')
open(p,'w',encoding='utf-8').write(head+tail.rstrip('\n')+'\n'+add)
print('patched; backup at',p+'.pre-v11')
