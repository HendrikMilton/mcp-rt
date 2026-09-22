"""Score a classifier prompt against the 40 adjudicated flips.

The buckets in v2_adjudicated40.jsonl were set by adjudication and spot-checked against source text
(see HANDOFF-RECLASSIFY.md): A = no data-protection content, should come back EI; B and C both
belong in the corpus and should come back JAH.

Reads whatever PROMPT is currently in src/ingest/classify.ts, so it validates the live prompt rather
than a copy that can drift. Re-run after ANY prompt edit — the first rt-dp-v2 draft looked sensible
and scored B 0/3.

    python3 research/v2check.py            # sonnet
    CLS_MODEL=haiku python3 research/v2check.py

Reference scores:            A (drop)   B (keep)   C (keep)
    sonnet                    5/24       3/3        12/13
    haiku                    10/24       3/3        13/13
"""
import os
import json,subprocess,threading,time,sys
from concurrent.futures import ThreadPoolExecutor
MCP='/home/hendrik/Documents/hy-capital/mcp-rt'
S='/home/hendrik/Documents/hy-capital/mcp-rt/research'
src=open(f'{MCP}/src/ingest/classify.ts',encoding='utf-8').read()
PROMPT=src[src.index('const PROMPT = `')+len('const PROMPT = `'):src.index('---`;')+3]
adj={x['id']:x for x in (json.loads(l) for l in open(f'{S}/v2_adjudicated40.jsonl') if l.strip()) if x.get('kat')}
def ex(t,n=12000):
    if len(t)<=n: return t
    h=n//2; return t[:h]+"\n[...]\n"+t[-(n-h):]
lock=threading.Lock(); out=[]
def go(i):
    t=open(f'{MCP}/data/text/{i}.txt',encoding='utf-8',errors='replace').read()
    cmd=['claude','-p',PROMPT.replace('%TEXT%',ex(t)),'--model',os.environ.get('CLS_MODEL','sonnet'),
         '--system-prompt','Sa oled klassifitseerija. Väljasta ainult nõutud JSON.',
         '--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--output-format','json']
    for a in range(3):
        try:
            p=subprocess.run(cmd,capture_output=True,text=True,timeout=300,cwd=S)
            raw=json.loads(p.stdout).get('result','')
            j=json.loads(raw[raw.find('{'):raw.rfind('}')+1])
            if j.get('vastus') in ('JAH','EI'):
                with lock: out.append({'id':i,'v2':j['vastus'],'kat':adj[i]['kat'],'nr':adj[i]['nr']})
                return
        except Exception: time.sleep(2**a)
    with lock: out.append({'id':i,'v2':'ERR','kat':adj[i]['kat'],'nr':adj[i]['nr']})
with ThreadPoolExecutor(max_workers=4) as e: list(e.map(go,list(adj)))
json.dump(out,open(f"{S}/v2check_{os.environ.get('CLS_MODEL','sonnet')}_out.json",'w'),indent=1)
for k,lab in [('A','A should be EI'),('B','B should be JAH'),('C','C should be JAH')]:
    s2=[x for x in out if x['kat']==k]; jah=sum(1 for x in s2 if x['v2']=='JAH')
    print(f'  {lab:18s}: {jah}/{len(s2)} JAH')
