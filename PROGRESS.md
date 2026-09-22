# mcp-rt — current state and how to continue

Read this first. `HANDOFF.md` is the original design brief and is still accurate about *why* things
are built the way they are; this file is what is true *now*. Probe artifacts are in `research/`.

**Status:** live and serving. Court corpus 41% classified; the aki.ee guidance corpus is complete.
Nothing is running. Every stage resumes from disk — there is no work to redo, only work to
continue.

---

## What is deployed

One MCP endpoint, three corpora, ten tools. Connector URL:
`cd terraform && terraform output -raw aki_mcp_url` (registered in `~/.claude.json` user scope as
`aki`; the same URL is added in Claude Desktop).

| tool | corpus |
|---|---|
| `search_decisions`, `get_decision`, `list_decisions` | AKI, 657 decisions / 12,113 chunks |
| `search_court_decisions`, `get_court_decision`, `list_court_decisions` | courts, **1,136 decisions / 25,404 chunks, 2022–2026** |
| `search_guidance`, `get_guidance`, `list_guidance` | aki.ee guidance, **1,272 documents / 20,028 chunks** |
| `get_statute` | Riigi Teataja consolidated legislation, live (not indexed) |

Serving code is `mcp-aki/` — it holds all three corpora as `Corpus<D>` descriptors and caches them
separately, so a container answering only AKI questions never downloads the court index.
`mcp-rt/` is ingest only for the court corpus; guidance ingest lives in `mcp-aki/src/ingest/`.

## The guidance corpus (aki.ee), added 2026-09-22

The regulator's own manuals, FAQs, pages and attached PDFs — **normative** material, where the other
two corpora are **adjudicative**. That distinction is the whole reason it is a separate index: merged
into `search_decisions`, a paragraph of the üldjuhend would be cited as though it were binding, which
is the same failure class as the invented `KrMS § 64` that motivated `get_statute`.

```
sitemap             576 URLs, minus /en/ mirrors and the error pages -> 552
pages crawled       545
attachments         802 unique links, 732 kept on-site
final corpus      1,272 docs / 20,028 chunks / 17.0 MB text
index             s3://hycapital-aki-rag/guidance/  (30.7 MB vectors + 4.7 MB meta)
embed cost        ~$1.40
```

Rebuild: `yarn guidance` (crawl, resumable from disk) then `yarn ingest:guidance` (chunk + embed).
The crawl is the slow half at ~12 min; the build is a full rebuild every time, which is affordable
because everything is local by then.

**What the crawl cost to learn**, all now encoded in `guidance.ts`:

- **The sitemap's base URL is misconfigured** — every entry is `http://default/…` and must be
  rewritten to the real host or nothing resolves.
- **aki.ee serves missing pages with HTTP 200** and a "Lehte ei leitud" body. The status code cannot
  be trusted; `isSoftNotFound` checks the title. This cost real time — a page I sampled early to
  decide the extraction strategy was a soft 404, and its *navigation menu* was what made the
  guidance documents look like they were listed on the index pages.
- **The PDFs are not in the sitemap.** They hang off individual node pages, and the listing pages
  show only two "recent" highlights — so sampling a listing page suggests there are almost none.
- **`fetch` had no timeout.** One hung connection parks a serial crawl indefinitely; it sat at
  500/552 for hours looking like a slow page rather than a wedged one. 30s `AbortSignal.timeout`.
- **The sidebar widget links the same PDFs from every page**, so first-parent-wins types the whole
  attachment set from one arbitrary page. All parents are kept and a file with ≥20 of them is
  treated as chrome.
- **The same guidance is published at two paths** (legacy `/dokumendid/<slug>` and current
  `/documents/YYYY-MM/`), so both üldjuhendid were doubled. Deduped on text hash — two copies would
  pair up through the rerank pool and halve the distinct results a query can return.

**Chunking.** `chunkDocument` now takes a heading pattern. The AKI whitelist of 16 ALL-CAPS headings
matches nothing in a manual, so the AvTS üldjuhend collapsed into one `PREAMBUL` section of 136
chunks; `NUMBERED_HEADING_RE` gives it 83 sections. `excerptDocument` takes the same pattern, so
`get_guidance`'s `section` argument has something to match. 80-chunk cap per document, round-robin
across sections, same as the court corpus — 29 documents hit it.

**Verified live against source text**, the same way the two earlier fabrications were caught:
`pattern: "15 tööpäeva"` on the üldjuhend returns the two occurrences that are really there (lines
449 and 455); a fabricated `AvTS § 999` is refused with an explicit do-not-cite; a news-shaped query
returns no news. One bug found doing this: the not-found message called every document "this
decision", which would have described guidance as a decision in the one place designed to stop
exactly that.

**Known limitations, neither blocking:**

- **893 of 1,272 documents are typed `muu`.** The PDFs live in one flat `/documents/YYYY-MM/` store,
  so their only type signal is the linking page, and the sidebar defeats that for most of them. They
  are all searchable; `type: "juhend"` merely under-reports at 28. Fixing it means reading the link's
  surrounding markup to tell a body link from a sidebar one.
- **Short HTML pages all chunk as `PREAMBUL`**, having no numbered headings. Harmless — they are
  short enough that the whole page is one or two chunks anyway.
- News is indexed but excluded from `search_guidance` unless `type: "news"` is passed, because dated
  announcements read as current obligation. `list_guidance` still reaches all 332.

## Where the numbers stand

```
pool              21,929 candidates (1,231 search requests, ~4 min)
in scope (2007+)  21,331
classified         8,713   41%    1,136 JAH (13.0%), 9.9% escalated to Sonnet
indexed            1,136   2022-2026
remaining         12,618   2007-2021, plus 40 undated
Bedrock spend     $65.82   of MAX_SPEND_USD 150
```

## The one blocker

**Finishing no longer fits in $150.** The measured rate has crept from $0.00656 to **$0.00744** per
decision as escalation rose from 8.2% to 9.9% — older decisions are more ambiguous, so more of them
reach Sonnet. Remaining 12,618 × $0.00744 = **$94**, total **$160**.

The pre-flight in `classifyAll` will refuse to start rather than abort part-way, so the next run
stops immediately with a clear message. To continue, one of:

- **raise `MAX_SPEND_USD`** in `src/lib/limits.ts` to ~170 (the constant is deliberately the user's
  decision, not a default to be nudged);
- **raise `MIN_YEAR`** in `src/ingest/classify.ts` — the lawyer set 2007 because pre-IKS practice is
  a different regime; 2012 or 2015 would cut the bill proportionally;
- **switch to Bedrock batch inference**, ~50% cheaper, which fixes the budget *and* the quota below.
  ~2h of rework: batch takes Anthropic-format JSONL in S3, not Converse calls. Quotas are healthy
  (100k records/job, 100 concurrent) and a Bedrock service role would need adding to terraform.

**A second, independent blocker: a Bedrock per-day token cap.** Roughly 25M Haiku input tokens, then
`ThrottlingException: Too many tokens per day` — not retryable, so the adaptive backoff cannot wait
it out. It is not in Service Quotas (only per-minute, 5M TPM, nowhere near), so it needs a Support
case. Observed allowance per session: 4,876 → 2,543 → 1,294 rows, so it is a rolling window rather
than a clean daily reset. Without lifting it, finishing takes several more sessions regardless of
budget.

## How to continue

```bash
cd mcp-rt
yarn ingest --index-only   # rebuild the index from whatever is already classified (free, ~1 min)
yarn classify              # next batch; stops itself on the daily cap, resumes free next time
yarn audit                 # adversarial out-of-pool sample
yarn verify                # sample rejects, re-ask Sonnet
yarn mine                  # mine vocabulary from confirmed positives (written, never run)
```

The usual loop is `yarn classify` then `yarn ingest --index-only`. Classification appends per row to
`data/classified.jsonl` and to S3, so an interrupted run never re-pays. Embedding reuses vectors by
decision id, so re-indexing early costs nothing later.

Deploying serving changes: `cd mcp-aki && ./scripts/build-lambda.sh && cd ../terraform &&
terraform apply`. The index lives in S3 and is picked up on the next Lambda cold start — no deploy
needed after a re-index.

## What was measured, and what it changed

- **Search parallelises**: 63 req/s at concurrency 20, zero 429s. `HANDOFF.md`'s "~8s/request
  serially, parallelism untested" is stale. Pool build is 4 minutes, not the projected 2.2 hours.
- **There is no märksõna field on the search body.** Ten plausible spellings all silently returned
  the unfiltered 725,792. Taxonomy is a separate endpoint,
  `GET /kohtuteave/liigitus/{kood}/kohtulahendid`, found by reading the site's Angular bundle.
- **Decisions are twice as long as recorded**: median 20,555 chars against 10,369, mean 30,377,
  p99 190k, max 2.3M. This drove both the cost overrun and an 80-chunk cap per decision, chosen
  round-robin across sections so a capped decision keeps coverage of its reasoning.
- **Estonian tokenises at ~2.45 chars/token**, so the 12k-char excerpt costs ~4,900 tokens, not the
  4,000 assumed. With a 21.9k pool and 9.9% escalation, classification is ~2x the $75 estimate.
- **Gold set reproduces exactly**: 14/17, same three rejects. The classifier config is the one that
  was measured; do not change model, excerpt size or the 0.9 escalation threshold without re-running
  `research/step4.json`.

## Validation done

- **Adversarial out-of-pool sample** (`data/audit.json`): 3 of 50 near-miss decisions classified JAH.
  Read in the source: two are genuine leaks (a `turvakaamera` vocabulary gap; a `kutsesaladus` case
  the taxonomy node could not reach because märksõnad exist only for annotated decisions), one is a
  classifier false positive on the anonymisation-at-publication clause. **~4% leak in the region
  deliberately chosen to be hardest** — not a corpus-wide rate, and the corpus-wide rate remains
  unmeasured because a uniform sample of 50 could not distinguish 0% from 3% at this base rate.
- **Reject spot-check** (`data/verify.json`): **2.5% wrong-no** (3 of 120, stratified). 0% in the
  low-confidence band, 5% in `>=0.95` — which holds 94% of rejects and never escalates. So raising
  the escalation threshold would not catch them. All three flips came back at low Sonnet confidence,
  so they are borderline rather than clear misses. Extrapolates to ~160 decisions missing so far.
- **Live answers verified against source text** three times. Two fabrications were found and fixed by
  tooling rather than prompting: a cited `KrMS § 64` that appears nowhere in the decision, and a
  claim that AvTS ends at § 58 when it runs to § 69. Both were the same shape — correct conclusion,
  invented statutory hook, no tool able to check it. After adding `pattern` and `get_statute`, a
  later answer cited 9 decisions and 12 statutory provisions with zero errors.

## Still open

- [ ] Finish classification, 2007–2021 (blocked on the budget/quota decision above)
- [ ] `yarn mine` — written, never run; proposes new seed wildcards with a measured delta
- [ ] Tell the lawyer her `annotatsiooniSisu` search returns ~10% of full text
      (`"KrMS § 214"`: 8 there vs 86 in full text, re-confirmed 2026-09-16)
- [ ] Optional: raise the API Lambda's memory if the court index grows much past ~150MB
- [ ] Guidance: type the 893 `muu` PDFs properly by reading body vs sidebar links
- [ ] Guidance re-crawl is manual; the AKI decisions crawl has a monthly EventBridge rule, this does not

## Log

**2026-09-16/17** — built, deployed, 41% classified. Surprises are in *What was measured* above.
The three that cost the most time: the search endpoint parallelising after the brief said it was
untested; the missing märksõna field sending me into the site's JS bundle; and the corpus being
twice as long as recorded, which is the root of the entire cost overrun.

**2026-09-17** — added `get_statute` after a live answer invented a statutory fact nothing could
check. Two bugs in that fix were caught by testing it against the case that motivated it: counting
bare `§` cross-references made AvTS look like it ran to § 107, and concatenating a superscript
rendered `§ 32¹` as `§ 321`, naming a provision that does not exist. The same superscript bug then
turned up in `extractNorms` and was fixed there too.

**2026-09-22** — added the aki.ee guidance corpus, 1,272 documents, live. Jev (TypeSafe) was
evaluated as a cheaper classifier for the court corpus and rejected: it ties Haiku on the 87-case
gold set (14/17, 1 false positive) but agrees on only 55% of the 1,136 JAH across the 8,713 already
classified, and the vendor documents lower accuracy outside English. The 87-case test had no power
to show that — full numbers in `research/`.

**2026-09-17** — norms indexed to lg/p precision at the lawyer's request, both precisions stored so
`AvTS § 35` still matches a decision citing only `§ 35 lg 1 p 11`. Narrowing an existing search
would have been the worse failure.
