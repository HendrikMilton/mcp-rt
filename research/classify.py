import json, subprocess, tempfile, os, sys

FILE_API = "https://www.riigiteataja.ee/public-api/api/v1/kohtuteave/kohtulahendid/{}/file"
CACHE = 'rt/pdfs'
os.makedirs(CACHE, exist_ok=True)

PROMPT = """Allpool on väljavõte Eesti kohtulahendist.

Küsimus: kas see lahend käsitleb SISULISELT isikuandmete kaitse / privaatsuse / andmetöötluse õiguslikku küsimust?

JAH tähendab: vaidluse või põhjenduse osaks on isikuandmete töötlemise õiguspärasus, andmesubjekti õigused, andmete avaldamine/edastamine, jälgimine või eraelu puutumatuse riive õiguslik hindamine.

EI tähendab: isikuandmed või kaamerasalvestis esinevad lahendis üksnes taustal või tõendina, ilma et nende töötlemise õiguspärasust vaidlustataks või hinnataks.

Vasta AINULT JSON-iga: {"vastus":"JAH"|"EI","kindlus":0.0-1.0,"pohjus":"<kuni 15 sona>"}

---
%s
---"""

def get_text(fid, max_chars=6000):
    p = f"{CACHE}/{fid}.pdf"
    if not os.path.exists(p) or os.path.getsize(p) < 500:
        subprocess.run(['curl','-s','--max-time','60','-A','Mozilla/5.0','-o',p,FILE_API.format(fid)],
                       capture_output=True)
    if not os.path.exists(p) or os.path.getsize(p) < 500: return ''
    t = subprocess.run(['pdftotext','-q','-nopgbrk',p,'-'],capture_output=True,text=True).stdout.strip()
    if len(t) <= max_chars: return t
    head = max_chars // 2
    return t[:head] + "\n[...]\n" + t[-(max_chars - head):]

MODEL = os.environ.get('CLS_MODEL', 'eu.amazon.nova-pro-v1:0')

def classify(text):
    if not text: return {"vastus":"?","kindlus":0,"pohjus":"no text"}
    body = {"messages":[{"role":"user","content":[{"text":PROMPT % text}]}],
            "inferenceConfig":{"maxTokens":200,"temperature":0}}
    with tempfile.NamedTemporaryFile('w',suffix='.json',delete=False,encoding='utf-8') as f:
        json.dump(body,f); p=f.name
    r = subprocess.run(['aws','bedrock-runtime','converse','--profile','hycapital','--region','eu-central-1',
        '--model-id',MODEL,'--cli-input-json','file://'+p],capture_output=True,text=True)
    if r.returncode != 0: return {"vastus":"ERR","kindlus":0,"pohjus":r.stderr[:80]}
    out = json.loads(r.stdout)['output']['message']['content'][0]['text']
    s = out[out.find('{'): out.rfind('}')+1]
    try: return json.loads(s)
    except Exception: return {"vastus":"?","kindlus":0,"pohjus":out[:60]}
