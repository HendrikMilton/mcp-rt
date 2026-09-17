import json, subprocess, sys, tempfile

API = "https://www.riigiteataja.ee/public-api/api/v1/kohtuteave/otsing/kohtulahendid"

def query(text="", in_text=True, morph=True, after=0, text2="", op="AND", precise=None, sort="kehtivuseAlgus"):
    body = {
        "general": {"searchInText": in_text, "searchInTitle": not in_text, "searchText": text,
                    "searchText2": text2, "logicalOperator": op, "morphSearch": morph,
                    "searchAfter": after, "sort": sort, "sortAscending": False},
        "precise": {"kohtunik": None, "ecliNr": "", "menetluseTyyp": None, "annotatsiooniSisu": None,
                    "kohus": [], "menetlusliigid": [],
                    "seaduseSatted": {"paragrahv": None, "paragrahvPrimm": None, "loige": None,
                                      "loigePrimm": None, "punkt": None, "punktPrimm": None,
                                      "seadustikKl": None}},
    }
    if precise: body["precise"].update(precise)
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as f:
        json.dump(body, f); p = f.name
    out = subprocess.run(['curl','-s','--max-time','60','-A','Mozilla/5.0','-H','Content-Type: application/json',
                          '-X','POST','-d','@'+p, API], capture_output=True, text=True).stdout
    try: return json.loads(out)
    except Exception: return {"kokku": -1, "tulemused": [], "raw": out[:200]}

if __name__ == '__main__':
    for t in ["andmekaitse", "isikuandmed", "isikuandmete kaitse", "isikuandmete kaitse üldmäärus",
              "IKÜM", "GDPR", "isikuandmete kaitse seadus", "Andmekaitse Inspektsioon",
              "eraelu puutumatus", "delikaatsed isikuandmed", "andmesubjekt", "privaatsus"]:
        r = query(t)
        print(f"{r['kokku']:>8}  full-text morph  '{t}'")
