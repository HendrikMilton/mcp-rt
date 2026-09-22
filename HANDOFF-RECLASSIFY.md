# Handoff: reclassifying the court corpus with rt-dp-v2

Written 2026-09-22. Read `PROGRESS.md` first for the system as a whole; this file covers only the
reclassification that is currently half-done, and why it is happening.

## The short version

The live court index is wrong. Roughly half of its 1,136 decisions are not data-protection cases.
A new prompt (`rt-dp-v2`) is validated and a re-run is 12% done. Finish it, rebuild the index.

**Nothing is deployed from this work yet.** The lawyer is still searching the old v1 index.

## Why the corpus is wrong

The v1 classifier was Haiku 4.5 with escalation to Sonnet below confidence 0.9. Two things were
discovered on 2026-09-22:

1. **Haiku returned exactly 0.95 on 99.8% of all rows.** The confidence number was a constant, not a
   judgement, so the 0.9 escalation threshold never fired on merit — only 9.9% of rows escalated, and
   effectively by accident. Haiku's positives were never reviewed by anything.
2. **A 500-row agreement probe** (stratified, drawn from the 7,854 rows Haiku decided alone) found
   Sonnet rejecting **171 of 250** of Haiku's positives, while agreeing on 248 of 250 negatives. The
   divergence is one-directional, which is not what a merely stricter model looks like.

A 40-case adjudication of those flips, verified by reading source text:

| bucket | meaning | count |
|---|---|---|
| A | no data-protection content at all — debt claims, fraud evidence, malpractice records | 24 (60%) |
| B | substantively data protection; Sonnet was wrong to drop | 3 (8%) |
| C | privacy weighed under another framework (PS § 26, VÕS, AvTS, vangistusseadus) | 13 (32%) |

Only 5 of 40 were judged useful to a data-protection lawyer. Extrapolated: **~580 of the 1,136
indexed decisions do not belong**, and separately some genuinely relevant ones were being dropped.

Two concrete examples, both read in the source:

- `2-24-137256/8` — zero occurrences of isikuandme/IKÜM/eraelu in 24,654 chars. Haiku: JAH at 0.95.
- `2-25-1884/8` — claim against Apple, the Irish DPC and AKI over iCloud data access. Ruled on
  jurisdiction only, so an "is the dispute about processing" test throws it away. It belongs.

## What rt-dp-v2 changes

`src/ingest/classify.ts`. Three JAH clauses instead of one, an explicit inclusive bias, and a much
narrower EI rule:

1. substantive IKÜM/IKS processing, data-subject rights, disclosure, surveillance;
2. privacy weighed under **another** framework — põhiseadus § 26, VÕS defamation, AvTS access
   refused to protect someone's eraelu, prison searches, jälitustoimingud, press freedom;
3. a **procedural** ruling (jurisdiction, time limits, admissibility) where the proceeding itself is
   a data-protection matter — a claim against a DPA or controller, an appeal against an AKI decision.

Ends with `Kahtluse korral vasta JAH`.

**The first v2 draft failed validation and was rewritten.** It listed typical EI cases in detail,
which gave the model a rich exclusion vocabulary and a thin inclusion one; it scored B 0/3 and C
2/13 — stricter than v1-Sonnet, the opposite of the intent. If you edit this prompt, re-run the
validation below before trusting it.

## Validation (re-run this after any prompt edit)

Scored against the 40 adjudicated flips, all in `research/`:

```bash
python3 research/v2check.py                  # sonnet
CLS_MODEL=haiku python3 research/v2check.py  # haiku
```

It reads the PROMPT straight out of `src/ingest/classify.ts`, so it always validates the live prompt
rather than a copy that can drift. Supporting data: `v2_adjudicated40.jsonl` (the buckets),
`v2_flips40.json` (the sample), `v2_agreement500.jsonl` (the 500-row Haiku-vs-Sonnet probe),
`v2check_sonnet.json` / `v2check_haiku.json` (the runs below).

| | A (should drop) | B (should keep) | C (should keep) |
|---|---|---|---|
| Sonnet | 5/24 kept | **3/3** | 12/13 |
| Haiku | 10/24 kept | **3/3** | **13/13** |

Haiku matches or beats Sonnet on everything worth keeping and admits about twice the junk. Both are
acceptable; the user's call was that extra JAH is fine, since for a research corpus a false positive
costs a skim and a false negative costs a case.

Note this is the *same* Haiku that collapsed under v1. The v1 failure was mostly the prompt.

## State right now

```
pool                 21,331 candidates in scope (2007-2026, MIN_YEAR drops 598 pre-2007)
classified (v2)       2,549   11.9%   463 JAH (18.2%), 2,086 EI
remaining            18,782
classified (v1)       8,713   superseded, ignored via promptVersion, still in the file
indexed (live)        1,136 decisions / 25,404 chunks, built 2026-09-17 from v1 verdicts
```

Backup of the v1 verdicts: `data/classified.v1.backup.jsonl`.

## How to run it

```bash
cd mcp-rt
CLS_BACKEND=claude-code CLS_CC_MODEL=haiku CLASSIFY_CONCURRENCY=4 \
  npx ts-node --compiler-options '{"module":"commonjs"}' src/ingest/classify.ts
```

`CLS_BACKEND=claude-code` drives the Claude Code CLI headless instead of Bedrock. It is isolated
deliberately — `--setting-sources ''`, `--strict-mcp-config`, an explicit `--system-prompt` —
because without those the CLI loads the user's CLAUDE.md and a global response-style rule rewrites
the classifier's output. Verified: no CLAUDE.md, no MCP, no project instructions reach it.

Resumable per row. `loadVerdicts` filters on `promptVersion`, so v1 rows are invisible and a restart
never re-pays for a v2 row.

### Two things that will bite

**1. There is a `cli failed` bug and it is not fixed.** When the plan limit is hit, `claude -p`
fails; after 3 retries `classifyOne` writes `{vastus:"EI", kindlus:0, pohjus:"cli failed"}`. That row
then counts as classified and is never retried — silently poisoning the corpus with false negatives.
Nothing has been poisoned yet (`grep -c 'cli failed' data/classified.jsonl` → 0) only because the run
was killed manually before it hit the wall. **Fix this before any unattended run**: throw instead of
returning a verdict, so the run aborts and resumes cleanly.

**2. Plan limits, not money, are the constraint.** Measured with Sonnet: 2,549 rows consumed one
entire 5-hour session window, and the weekly "All models" bar moved ~9 points. At that rate the full
21,331 needs ~8 session windows — roughly two days, and most of a week's budget. Haiku should be
cheaper per call but this is **unverified**; a 40-call sample was too small to move the usage bar.
Measure it early rather than assuming.

There is no CLI for usage. `claude -p "/usage"` returns nothing — it is interactive-only. The only
readout is claude.ai → Settings → Usage, which can be driven with the Chrome tools.

## When classification finishes

```bash
yarn ingest --index-only     # rebuild from the v2 verdicts, reuses vectors by decision id
```

Then sanity-check before telling anyone it is live:

- corpus size should land near **1,600 decisions** (18.2% JAH of 21,331), up from 1,136, and should
  now cover **2007–2021**, which is entirely absent today — the v1 run went newest-first and stopped.
- spot-check that `2-24-137256/8` is **gone** and `2-25-1884/8` is **present**.
- re-run the live verification from `PROGRESS.md`: a `pattern` lookup that exists, and a fabricated
  one that must be refused.

Serving needs no deploy — the index is read from S3 on the next Lambda cold start.

## What was ruled out, so it is not re-litigated

**Jev (TypeSafe).** Evaluated as a cheaper classifier. Ties Haiku on the 87-case gold set (14/17, 1
false positive) and then agrees on only 55% of the 1,136 positives across the 8,713. `research/jev_eval.json`
has the numbers. The lesson is about the test, not the vendor: the gold set has 17 positives, all
Riigikohus, and a 95% CI on 14/17 spans roughly 59–94%. It cannot distinguish a good classifier from
one that misses half the corpus. **Do not validate a classifier on the gold 87 alone.**

**Indexing all 21,331 candidates** instead of filtering. Needs a retrieval backend change — 477k
chunks is 733 MB of vectors and 1.6 GB of BM25 postings against a 2 GB Lambda. Written up separately
in `mcp-aki/RETRIEVAL-MIGRATION.md`. Not needed for this work: ~1,600 decisions is ~37k chunks.

## Uncommitted

`src/ingest/classify.ts` carries the v2 prompt, `PROMPT_VERSION = 'rt-dp-v2'`, and the
`CLS_BACKEND=claude-code` path. Not committed — the `cli failed` fix belongs in the same commit.
