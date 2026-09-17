/**
 * Client for Riigi Teataja's undocumented public API (no auth, no documented rate limit).
 *
 *   POST /kohtuteave/otsing/kohtulahendid        full-text + precise search, 30 per page
 *   GET  /kohtuteave/liigitus/{kood}/kohtulahendid   decisions under one taxonomy node
 *   GET  /kohtuteave/kohtulahendid/{failiId}/file    the PDF
 *
 * Throughput here is cleared with Riigi Teataja. Measured 2026-09-16: the search endpoint sustains
 * ~63 req/s at concurrency 20 with p50 153ms and no 429s, which is why the crawler parallelises
 * instead of pacing itself the way the aki.ee one has to. 429 still gets exponential backoff —
 * that is correctness, not courtesy; pushing through a throttle does not return data faster.
 */
import {MAX_RETRIES, searchBudget} from './limits';
import type {Candidate, Menetlus, Tier} from '../types';

const BASE = 'https://www.riigiteataja.ee/public-api/api/v1';
const UA = 'hy-capital-rt-ingest/1.0 (legal research corpus; contact https://github.com/HendrikMilton)';

export const PAGE_SIZE = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Errors worth another attempt: transport failures, throttling, and 5xx. */
const retryable = (status: number | null): boolean =>
	status === null || status === 429 || status === 408 || status >= 500;

interface RawResult {
	objektId: number;
	kohtuasjaNumber?: string;
	avalikustatudFailiId?: number;
	toiminguEsitajaAsutus?: string;
	lahendiKuulutamiseAeg?: string;
	menetlusLiikKlVaartus?: string;
	asjaKategooriaList?: {asjaKategooriaVaartus?: string; asjaAlakategooriaVaartus?: string}[];
	marksonaRajad?: {nimetuseAhel?: string}[];
	annotatsiooniMarksonaRajad?: {nimetuseAhel?: string}[];
}

interface SearchPage {
	kokku: number;
	tulemused: RawResult[];
}

/**
 * Every request the crawler makes goes through here, so the budget and the backoff are impossible
 * to route around. `countsAgainstBudget` is false only for PDF downloads, which are not searches.
 */
const request = async (
	url: string,
	init: RequestInit,
	countsAgainstBudget: boolean,
): Promise<Response> => {
	let lastError = '';
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		if (countsAgainstBudget) searchBudget.take();

		let res: Response | null = null;
		try {
			res = await fetch(url, {
				...init,
				headers: {'user-agent': UA, ...(init.headers ?? {})},
				signal: AbortSignal.timeout(90_000),
			});
		} catch (err) {
			lastError = String(err);
		}

		if (res?.ok) return res;
		const status = res?.status ?? null;
		lastError = status ? `HTTP ${status}` : lastError;
		if (!retryable(status)) throw new Error(`${url}: ${lastError}`);

		// Full jitter: a synchronised retry storm from 20 workers is what turns a blip into an outage.
		const backoff = Math.min(2 ** attempt * 1000, 30_000) * (0.5 + Math.random());
		await sleep(backoff);
	}
	throw new Error(`${url}: giving up after ${MAX_RETRIES} attempts (${lastError})`);
};

const TIER_PATTERNS: [RegExp, Tier][] = [
	// Match on the stem: the API writes the genitive ("Riigikohtu halduskolleegium",
	// "Tallinna Ringkonnakohtu tsiviilkolleegium"), never the nominative.
	[/riigikoh/i, 'riigikohus'],
	[/ringkonnakoh/i, 'ringkonnakohus'],
	[/maakoh|halduskoh/i, 'maakohus'],
];

export const tierOf = (court: string): Tier => {
	for (const [re, tier] of TIER_PATTERNS) if (re.test(court)) return tier;
	return 'maakohus';
};

const MENETLUS_PATTERNS: [RegExp, Menetlus][] = [
	[/tsiviil/i, 'tsiviil'],
	[/kriminaal/i, 'kriminaal'],
	[/haldus/i, 'haldus'],
	[/väärteo|vaarteo/i, 'vaarteo'],
	[/põhiseadus|pohiseadus/i, 'pohiseadus'],
];

/**
 * Case numbers encode the procedure in their first segment — 1-25-2883/69 is criminal — and unlike
 * `menetlusLiikKlVaartus` they are present on every decision. That field is only populated
 * reliably for Riigikohus, so trusting it alone labelled most of the maakohus and ringkonnakohus
 * bulk "muu" and made the filter useless for exactly the decisions there are most of.
 */
const MENETLUS_BY_NR_PREFIX: Record<string, Menetlus> = {
	'1': 'kriminaal',
	'2': 'tsiviil',
	'3': 'haldus',
	'4': 'vaarteo',
	'5': 'pohiseadus',
};

export const menetlusOf = (label: string, nr = ''): Menetlus => {
	for (const [re, m] of MENETLUS_PATTERNS) if (re.test(label)) return m;
	return MENETLUS_BY_NR_PREFIX[nr.trim()[0] ?? ''] ?? 'muu';
};

/** Normalise one search hit. `channel` records which seed found it, for later recall analysis. */
export const toCandidate = (r: RawResult, channel: string): Candidate | null => {
	if (!r.objektId || !r.avalikustatudFailiId) return null;
	const court = r.toiminguEsitajaAsutus?.replace(/\s+/g, ' ').trim() ?? '';
	const date = (r.lahendiKuulutamiseAeg ?? '').slice(0, 10);
	const cats = (r.asjaKategooriaList ?? [])
		.map((c) => [c.asjaKategooriaVaartus, c.asjaAlakategooriaVaartus].filter(Boolean).join(' -> '))
		.filter(Boolean);
	const marks = [...(r.marksonaRajad ?? []), ...(r.annotatsiooniMarksonaRajad ?? [])]
		.map((m) => m.nimetuseAhel)
		.filter((x): x is string => Boolean(x));

	return {
		id: String(r.objektId),
		nr: r.kohtuasjaNumber ?? String(r.objektId),
		fileId: r.avalikustatudFailiId,
		court,
		tier: tierOf(court),
		menetlus: menetlusOf(r.menetlusLiikKlVaartus ?? '', r.kohtuasjaNumber ?? ''),
		date,
		year: Number(date.slice(0, 4)) || 0,
		categories: [...new Set(cats)],
		marksonad: [...new Set(marks)],
		channels: [channel],
	};
};

export interface SearchOptions {
	/** Full-text query. Wildcards work and matter: `isikuandme*` returns 2.7x what `isikuandmed` does. */
	text: string;
	searchAfter?: number;
}

/**
 * One page of full-text search.
 *
 * `morphSearch` is deliberately false. It is a no-op on this index — `isikuandmed` (2,963),
 * `isikuandmete` (3,466) and `isikuandmeid` (2,673) return different sets for one lemma — so the
 * seeds carry explicit wildcards instead of trusting the server to stem.
 */
export const searchPage = async ({text, searchAfter = 0}: SearchOptions): Promise<SearchPage> => {
	const body = {
		general: {
			searchInText: true,
			searchInTitle: false,
			searchText: text,
			searchText2: '',
			logicalOperator: 'AND',
			morphSearch: false,
			searchAfter,
			sort: 'kehtivuseAlgus',
			sortAscending: false,
		},
		precise: {
			kohtunik: null,
			ecliNr: '',
			menetluseTyyp: null,
			annotatsiooniSisu: null,
			kohus: [],
			menetlusliigid: [],
			seaduseSatted: {
				paragrahv: null,
				paragrahvPrimm: null,
				loige: null,
				loigePrimm: null,
				punkt: null,
				punktPrimm: null,
				seadustikKl: null,
			},
		},
	};

	const res = await request(
		`${BASE}/kohtuteave/otsing/kohtulahendid`,
		{method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)},
		true,
	);
	return (await res.json()) as SearchPage;
};

/** One page of decisions filed under a taxonomy node. */
export const taxonomyPage = async (kood: string, searchAfter = 0): Promise<SearchPage> => {
	const url =
		`${BASE}/kohtuteave/liigitus/${encodeURIComponent(kood)}/kohtulahendid` +
		`?searchAfter=${searchAfter}&sort=kehtivuseAlgus&sortAscending=false`;
	const res = await request(url, {method: 'GET'}, true);
	return (await res.json()) as SearchPage;
};

/** The published PDF. Downloads do not count against the search budget. */
export const fetchPdf = async (fileId: number): Promise<Buffer> => {
	const res = await request(
		`${BASE}/kohtuteave/kohtulahendid/${fileId}/file`,
		{method: 'GET', headers: {accept: 'application/pdf'}},
		false,
	);
	return Buffer.from(await res.arrayBuffer());
};

/** Public web URL for a decision — what a lawyer would open. */
export const decisionUrl = (id: string): string =>
	`https://www.riigiteataja.ee/kohtulahendid/detailid.html?id=${id}`;
