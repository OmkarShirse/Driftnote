import re
css=open('src/style.css',encoding='utf-8').read()
def parse(sel):
    d={}
    for m in re.finditer(sel+r'\s*\{([^{}]*)\}',css):
        for k,v in re.findall(r'(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\b',m.group(1)):
            if len(v)==4: v='#'+''.join(c*2 for c in v[1:])
            d[k]=v
    return d
def lum(h):
    c=[int(h[i:i+2],16)/255 for i in (1,3,5)]
    c=[x/12.92 if x<=0.03928 else ((x+0.055)/1.055)**2.4 for x in c]
    return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]
def cr(a,b):
    la,lb=sorted((lum(a),lum(b)),reverse=True)
    return (la+0.05)/(lb+0.05)
themes={'light':parse(r':root(?=\s*\{)'),'dark':parse(r':root\[data-theme="dark"\]')}
for t,v in themes.items():
    print(t,'theme')
    for fg in ('--ink','--mute','--faint','--acc','--ok','--bad'):
        for bg in ('--bg','--panel','--card-bg'):
            if fg in v and bg in v:
                r=cr(v[fg],v[bg])
                print(f'  {fg:7} on {bg:9} {v[fg]} {v[bg]} {r:5.2f} '+('OK' if r>=4.5 else 'LOW'))
