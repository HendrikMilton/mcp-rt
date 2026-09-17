/**
 * Recall stage: build the candidate pool.
 *
 * Data-protection decisions are under ~1.4% of Riigi Teataja's 725,752 and the site has no topic
 * filter, so the pool is a union of three independent channels against RT's own index. Searching
 * `andmekaitse` finds 703 — most relevant decisions never use the word, which is why none of the
 * channels is trusted alone:
 *
 *   vocabulary  wildcards over inflected forms (`isikuandme*`), since the index is literal
 *   paragraphs  full-text hits on statute citations ("AvTS § 35"), 69 paragraphs with measured counts
 *   taxonomy    85 nodes of the 6,268-node classification tree
 *
 * The taxonomy channel returns little on its own — märksõnad are only populated for annotated
 * decisions, mostly Riigikohus — but it reaches decisions whose wording no vocabulary seed predicts,
 * which is exactly the leak the other two channels cannot see.
 *
 * Deduped on objektId, keeping every channel that matched so recall can be attributed afterwards.
 */
import {readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import {LimitExceeded, MAX_CANDIDATES, searchBudget} from '../lib/limits';
import {mapPool} from '../lib/pool';
import {PAGE_SIZE, searchPage, taxonomyPage, toCandidate} from '../lib/rt';
import type {Candidate} from '../types';

/** Measured 63 req/s at 20 with zero 429s; 16 leaves headroom for the shared retry path. */
const SEARCH_CONCURRENCY = Number(process.env.SEARCH_CONCURRENCY ?? 16);

/**
 * A single seed matching more than this is not a data-protection signal, it is a broken query —
 * abort rather than pull 100k decisions into the pool on the back of one bad wildcard.
 */
const MAX_HITS_PER_SEED = 12_000;

interface Seeds {
	vocabulary: string[];
	paragraphs: Record<string, number>;
	taxonomy: {path: string; kood: string}[];
}

export interface Seed {
	channel: string;
	kind: 'text' | 'taxonomy';
	query: string;
}

const RESEARCH = join(__dirname, '../../research');

export const loadSeeds = (): Seed[] => {
	const seeds: Seeds = JSON.parse(readFileSync(join(RESEARCH, 'seeds.json'), 'utf8'));
	return [
		...seeds.vocabulary.map((v) => ({channel: `vocab:${v}`, kind: 'text' as const, query: v})),
		// Paragraph counts in seeds.json were measured as full-text hits, not through the precise
		// seaduseSatted filter — that filter reads satteSeosed, which RT only populates for Riigikohus.
		...Object.keys(seeds.paragraphs).map((p) => ({
			channel: `para:${p}`,
			kind: 'text' as const,
			query: `"${p}"`,
		})),
		...seeds.taxonomy.map((t) => ({
			channel: `tax:${t.path}`,
			kind: 'taxonomy' as const,
			query: t.kood,
		})),
	];
};

const fetchPage = (seed: Seed, after: number) =>
	seed.kind === 'text'
		? searchPage({text: seed.query, searchAfter: after})
		: taxonomyPage(seed.query, after);

/** Every page of one seed. The first page's `kokku` gives the page count up front. */
const runSeed = async (seed: Seed): Promise<{hits: Candidate[]; total: number}> => {
	const first = await fetchPage(seed, 0);
	const total = first.kokku ?? 0;
	if (total > MAX_HITS_PER_SEED) {
		throw new LimitExceeded(`seed ${seed.channel} hits`, total, MAX_HITS_PER_SEED);
	}

	const hits = (first.tulemused ?? [])
		.map((r) => toCandidate(r, seed.channel))
		.filter((c): c is Candidate => c !== null);
	if (total <= PAGE_SIZE) return {hits, total};

	const offsets: number[] = [];
	for (let after = PAGE_SIZE; after < total; after += PAGE_SIZE) offsets.push(after);

	// Pages within one seed run in parallel too — the endpoint sustains it and a 271-page seed
	// serially would dominate the whole crawl.
	const pages = await mapPool(offsets, SEARCH_CONCURRENCY, (after) => fetchPage(seed, after));
	for (const page of pages) {
		for (const r of page.tulemused ?? []) {
			const c = toCandidate(r, seed.channel);
			if (c) hits.push(c);
		}
	}
	return {hits, total};
};

export interface CrawlResult {
	candidates: Candidate[];
	perChannel: Record<string, {total: number; unique: number}>;
	searchRequests: number;
}

export const crawl = async (): Promise<CrawlResult> => {
	const seeds = loadSeeds();
	console.log(`${seeds.length} seeds across 3 channels; budget ${searchBudget.remaining} requests`);

	const byId = new Map<string, Candidate>();
	const perChannel: Record<string, {total: number; unique: number}> = {};

	// Seeds run one at a time, but each fans its own pages out; that keeps in-flight requests near
	// SEARCH_CONCURRENCY instead of multiplying seeds by pages.
	for (const [i, seed] of seeds.entries()) {
		const {hits, total} = await runSeed(seed);
		let fresh = 0;
		for (const c of hits) {
			const existing = byId.get(c.id);
			if (existing) {
				if (!existing.channels.includes(c.channels[0])) existing.channels.push(c.channels[0]);
			} else {
				byId.set(c.id, c);
				fresh += 1;
			}
		}
		perChannel[seed.channel] = {total, unique: fresh};

		if (byId.size > MAX_CANDIDATES) {
			throw new LimitExceeded('MAX_CANDIDATES', byId.size, MAX_CANDIDATES);
		}
		if ((i + 1) % 10 === 0 || i === seeds.length - 1) {
			console.log(
				`  [${i + 1}/${seeds.length}] ${seed.channel} — ${total} hits, +${fresh} new; ` +
					`pool ${byId.size}, ${searchBudget.spent} requests used`,
			);
		}
	}

	const candidates = [...byId.values()].sort((a, b) => b.date.localeCompare(a.date));
	return {candidates, perChannel, searchRequests: searchBudget.spent};
};

if (require.main === module) {
	crawl()
		.then((res) => {
			const out = join(RESEARCH, '..', 'data', 'pool.json');
			writeFileSync(out, JSON.stringify(res, null, 1));
			const byChannelKind = (prefix: string) =>
				Object.entries(res.perChannel)
					.filter(([k]) => k.startsWith(prefix))
					.reduce((n, [, v]) => n + v.unique, 0);
			console.log(
				`\npool: ${res.candidates.length} unique candidates in ${res.searchRequests} requests\n` +
					`  vocab ${byChannelKind('vocab:')} · para ${byChannelKind('para:')} · ` +
					`tax ${byChannelKind('tax:')} (unique-at-first-sight, order dependent)\n` +
					`written to ${out}`,
			);
		})
		.catch((err) => {
			console.error(err);
			process.exit(1);
		});
}
