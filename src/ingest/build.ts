/**
 * Orchestrates the whole ingest: recall -> download -> classify -> embed survivors -> write index.
 *
 * The ordering is the design. Classification runs before embedding, so only the ~10% that survive
 * are ever vectorised — that is what keeps the index at tens of MB rather than hundreds, and what
 * makes it affordable to keep the text of every reject.
 *
 * Each stage is resumable from disk (pool.json, data/text/, classified.jsonl), so a run that trips
 * a limit or dies halfway restarts from where it stopped rather than from the crawler.
 */
import {createHash} from 'crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import {DATA} from '../lib/paths';
import {EMBED_BATCH, EMBED_DIM, embedBatch} from '../lib/bedrock';
import {chunkDocument, chunkText, extractNorms} from '../lib/chunk';
import {MAX_CANDIDATES, LimitExceeded, spend} from '../lib/limits';
import {mapPool} from '../lib/pool';
import {decisionUrl, menetlusOf, tierOf} from '../lib/rt';
import {readIndex, writeIndex} from '../lib/store';
import type {Candidate, Chunk, Doc, Verdict} from '../types';
import {crawl} from './crawl';
import {fetchAll, localText, uploadAll} from './fetch';
import {classifyAll, flushVerdicts, hydrateVerdicts, loadVerdicts} from './classify';


const POOL = join(DATA, 'pool.json');

/** Pull the float vectors for chunk `i` back out of the quantised store. */
const dequantize = (vectors: Int8Array, scales: Float32Array, dim: number, i: number): number[] => {
	const out = new Array<number>(dim);
	const base = i * dim;
	for (let d = 0; d < dim; d++) out[d] = vectors[base + d] * scales[i];
	return out;
};

/** Enough to keep the embed stage moving without tripping Embed v4's tokens-per-minute throttle. */
const EMBED_CONCURRENCY = 6;

/** Reuse a pool from disk when one is there; the monthly Lambda run always crawls fresh. */
const loadPool = async (fresh: boolean): Promise<Candidate[]> => {
	if (!fresh && existsSync(POOL)) {
		const pool = JSON.parse(readFileSync(POOL, 'utf8'));
		console.log(`pool: ${pool.candidates.length} candidates from ${POOL}`);
		return pool.candidates;
	}
	const res = await crawl();
	writeFileSync(POOL, JSON.stringify(res, null, 1));
	console.log(`pool: ${res.candidates.length} candidates in ${res.searchRequests} search requests`);
	return res.candidates;
};

/** A survivor's index record. The classifier's reason doubles as the listing summary. */
const toDoc = (c: Candidate, v: Verdict, text: string, pages?: number): Doc => ({
	id: c.id,
	nr: c.nr,
	court: c.court,
	// Re-derived rather than trusted from the pool file: a pool written by an older crawler may
	// carry tiers from a looser pattern than the one in rt.ts today.
	tier: tierOf(c.court),
	// A pool written by an older crawler stored 'muu' wherever RT left menetlusLiikKlVaartus empty,
	// which is most of the maakohus and ringkonnakohus bulk, and 'haldus' for every pre-2013
	// Riigikohus number. Re-derive both from the case number rather than re-crawl for a field the
	// number already encodes.
	menetlus: c.menetlus === 'muu' || /^3-[1-4]-1-/.test(c.nr) ? menetlusOf('', c.nr) : c.menetlus,
	date: c.date,
	year: c.year,
	categories: c.categories,
	norms: extractNorms(text) || undefined,
	confidence: v.kindlus,
	summary: v.pohjus,
	pages,
	url: decisionUrl(c.id),
});

export interface IngestReport {
	candidates: number;
	fetched: number;
	classified: number;
	jah: number;
	ei: number;
	escalated: number;
	docs: number;
	chunks: number;
	indexBytes: number;
	spendUsd: number;
	searchRequests: number;
}

export const runIngest = async (
	opts: {fresh?: boolean; indexOnly?: boolean} = {},
): Promise<IngestReport> => {
	const candidates = await loadPool(opts.fresh ?? false);
	if (candidates.length > MAX_CANDIDATES) {
		throw new LimitExceeded('MAX_CANDIDATES', candidates.length, MAX_CANDIDATES);
	}

	// --index-only builds the index from whatever is already classified, skipping the download and
	// classification stages entirely. Useful while classification is still being worked through in
	// nightly batches: the index is rebuilt from the verdicts on hand, and because embedding reuses
	// vectors by decision id, doing this early costs nothing later.
	const indexOnly = opts.indexOnly ?? false;

	const hydrated = await hydrateVerdicts();
	if (hydrated) console.log(`hydrated ${hydrated} verdicts from S3`);

	// Only two kinds of candidate need their text materialised: one with no verdict yet, which has
	// to be classified, and a survivor, whose text has to be chunked. On the monthly run that is a
	// few hundred decisions rather than 22k — which matters, because Lambda's /tmp is finite and
	// 22k decisions of Estonian legal text is ~450MB of it.
	const known = loadVerdicts();
	const needText = candidates.filter((c) => {
		const v = known.get(c.id);
		return !v || v.vastus === 'JAH';
	});
	let fetched = {fetched: 0, cached: 0, noText: 0, failed: 0, failures: []} as Awaited<
		ReturnType<typeof fetchAll>
	>;
	let cls = {classified: 0, resumed: known.size, jah: 0, ei: 0, escalated: 0, missingText: 0};

	if (indexOnly) {
		console.log(`\n== index-only: skipping fetch and classify, using ${known.size} verdicts ==`);
		for (const v of known.values()) {
			if (v.vastus === 'JAH') cls.jah += 1;
			else cls.ei += 1;
			if (v.escalated) cls.escalated += 1;
		}
	} else {
		console.log(`${needText.length} of ${candidates.length} candidates need text on disk`);

		console.log('\n== fetch ==');
		fetched = await fetchAll(needText);
		console.log(
			`fetched ${fetched.fetched} new, ${fetched.cached} cached, ` +
				`${fetched.noText} without a text layer, ${fetched.failed} failed`,
		);

		console.log('\n== classify ==');
		cls = await classifyAll(candidates);
		console.log(JSON.stringify(cls));
		console.log(`ledger: ${await flushVerdicts()} verdicts written to S3`);
	}

	console.log('\n== index survivors ==');
	const verdicts = loadVerdicts();
	const survivors = candidates.filter((c) => verdicts.get(c.id)?.vastus === 'JAH');
	console.log(`${survivors.length} survivors of ${candidates.length} candidates`);

	const docs: Doc[] = [];
	const chunks: Chunk[] = [];
	for (const c of survivors) {
		const text = localText(c.id);
		if (text === null) continue;
		const pieces = chunkDocument(text);
		if (pieces.length === 0) continue;
		docs.push(toDoc(c, verdicts.get(c.id)!, text));
		for (const p of pieces) chunks.push({docId: c.id, section: p.section, text: p.text});
	}

	// Reuse the vectors of decisions already in the index. Their text never changes — a published
	// decision is immutable — so re-embedding them would be pure cost, and the monthly run only has
	// to pay for whatever the courts published since.
	const previous = await readIndex();
	const reusable = new Map<string, number[][]>();
	if (previous) {
		const offsets = new Map<string, number[]>();
		previous.chunks.forEach((ch, i) => {
			const list = offsets.get(ch.docId) ?? [];
			list.push(i);
			offsets.set(ch.docId, list);
		});
		for (const [docId, idxs] of offsets) {
			reusable.set(
				docId,
				idxs.map((i) => dequantize(previous.vectors, previous.scales, EMBED_DIM, i)),
			);
		}
		console.log(`${reusable.size} decisions in the previous index`);
	}

	const docById = new Map(docs.map((d) => [d.id, d]));
	const chunksByDoc = new Map<string, Chunk[]>();
	for (const ch of chunks) {
		const list = chunksByDoc.get(ch.docId) ?? [];
		list.push(ch);
		chunksByDoc.set(ch.docId, list);
	}

	// A reused entry is only valid if the chunking produced the same number of pieces; anything else
	// means the chunker changed under us, and silently pairing old vectors with new text would lose
	// recall without failing.
	const toEmbed: {docId: string; chunk: Chunk}[] = [];
	let reused = 0;
	for (const [docId, list] of chunksByDoc) {
		if (reusable.get(docId)?.length === list.length) {
			reused += 1;
			continue;
		}
		reusable.delete(docId);
		for (const ch of list) toEmbed.push({docId, chunk: ch});
	}

	const flat = toEmbed.map(({docId, chunk}) => chunkText(docById.get(docId), chunk));
	const batches: string[][] = [];
	for (let i = 0; i < flat.length; i += EMBED_BATCH) batches.push(flat.slice(i, i + EMBED_BATCH));
	console.log(
		`reusing vectors for ${reused} decisions; embedding ${flat.length} chunks across ` +
			`${docs.length - reused} decisions`,
	);

	// Every embedded batch is kept on disk, keyed by its content, so a run stopped by Bedrock's
	// per-day token cap resumes where it stopped instead of re-paying for everything before it.
	const cacheDir = join(DATA, 'embed-cache');
	mkdirSync(cacheDir, {recursive: true});
	const cachedEmbed = async (batch: string[]): Promise<number[][]> => {
		const file = join(cacheDir, `${createHash('sha1').update(batch.join('\0')).digest('hex')}.f32`);
		if (existsSync(file)) {
			const buf = readFileSync(file);
			const all = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
			if (all.length === batch.length * EMBED_DIM) {
				return batch.map((_, i) => Array.from(all.subarray(i * EMBED_DIM, (i + 1) * EMBED_DIM)));
			}
		}
		const vecs = await embedBatch(batch, 'search_document');
		writeFileSync(file, Buffer.from(Float32Array.from(vecs.flat()).buffer));
		return vecs;
	};

	let done = 0;
	const embedded = (
		await mapPool(batches, EMBED_CONCURRENCY, async (batch) => {
			const vecs = await cachedEmbed(batch);
			done += batch.length;
			if (done % 2000 < EMBED_BATCH) {
				console.log(`  embedded ${done}/${flat.length} chunks, $${spend.spent.toFixed(2)} spent`);
			}
			return vecs;
		})
	).flat();

	// Reassemble in the order `chunks` is already in, which is the order the docs are in.
	const freshByDoc = new Map<string, number[][]>();
	toEmbed.forEach(({docId}, i) => {
		const list = freshByDoc.get(docId) ?? [];
		list.push(embedded[i]);
		freshByDoc.set(docId, list);
	});
	const vectors: number[][] = [];
	for (const doc of docs) {
		vectors.push(...(reusable.get(doc.id) ?? freshByDoc.get(doc.id) ?? []));
	}

	const sizes = await writeIndex(docs, chunks, vectors);
	await uploadAll(survivors);

	const report: IngestReport = {
		candidates: candidates.length,
		fetched: fetched.fetched + fetched.cached,
		classified: cls.classified + cls.resumed,
		jah: cls.jah,
		ei: cls.ei,
		escalated: cls.escalated,
		docs: docs.length,
		chunks: chunks.length,
		indexBytes: sizes.metaBytes + sizes.vectorBytes,
		spendUsd: Number(spend.spent.toFixed(2)),
		searchRequests: 0,
	};
	writeFileSync(join(DATA, 'report.json'), JSON.stringify(report, null, 1));
	console.log(
		`\nindex written: ${docs.length} decisions, ${chunks.length} chunks, ` +
			`${(report.indexBytes / 1e6).toFixed(1)}MB`,
	);
	console.log(spend.report());
	return report;
};

if (require.main === module) {
	runIngest({
		fresh: process.argv.includes('--fresh'),
		indexOnly: process.argv.includes('--index-only'),
	}).catch((err) => {
		console.error(err);
		console.log(spend.report());
		process.exit(1);
	});
}
