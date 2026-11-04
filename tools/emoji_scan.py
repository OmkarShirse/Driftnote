import re,collections
rx=re.compile('[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\u25A0-\u25FF\u2300-\u23FF\uFE0F]')
for f in ('src/index.html','src/app.js','src/style.css'):
    try: lines=open(f,encoding='utf-8').read().split('\n')
    except OSError: continue
    hits=collections.defaultdict(list)
    for n,l in enumerate(lines,1):
        for ch in rx.findall(l):
            if ch!='\ufe0f': hits[ch].append(n)
    print(f, sum(len(v) for v in hits.values()),'occurrences')
    for ch,v in sorted(hits.items(),key=lambda x:-len(x[1])):
        print('  U+%04X %s x%d lines %s'%(ord(ch),ch,len(v),sorted(set(v))[:8]))
