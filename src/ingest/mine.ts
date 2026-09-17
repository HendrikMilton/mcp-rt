/**
 * Mine seed vocabulary from confirmed positives, then measure what it would actually add.
 *
 * The seed list was derived before any decision had been classified, so it encodes a prior about
 * how data-protection decisions are worded. The classified pool is the first chance to check that
 * prior against the corpus: terms that discriminate JAH from EI *inside the pool* are candidates
 * for reaching decisions outside it.
 *
 * The output is not a new seed list, it is a measured delta — for each proposed wildcard, its hit
 * count and how many of those hits the current pool does not already contain. A term that adds
 * nothing is worth knowing about; a term that adds thousands is worth a human looking at it before
 * it goes into seeds.json.
 */
import {readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import {DATA} from '../lib/paths';
import {mapPool} from '../lib/pool';
import {PAGE_SIZE, searchPage, toCandidate} from '../lib/rt';
import type {Candidate, Verdict} from '../types';
import {localText} from './fetch';
import {loadVerdicts} from './classify';


const RESEARCH = join(__dirname, '../../research');

/** Below this many positive documents a term is an artefact of one case, not vocabulary. */
const MIN_DF_JAH = 15;
/** Proposals to actually probe against the API. */
const TOP_N = 40;
/** How deep to sample each proposal's results when estimating what share is new. */
const SAMPLE_PAGES = 3;

const TOKEN_RE = /[a-zäöüõšž]{5,}/gi;

const docFrequencies = (ids: string[]): Map<string, number> => {
	const df = new Map<string, number>();
	for (const id of ids) {
		const text = localText(id);
		if (text === null) continue;
		for (const term of new Set((text.toLowerCase().match(TOKEN_RE) ?? []))) {
			df.set(term, (df.get(term) ?? 0) + 1);
		}
	}
	return df;
};

/** A wildcard covers a term if the term starts with the wildcard's literal prefix. */
const coveredBySeeds = (term: string, seeds: string[]): boolean =>
	seeds.some((s) => {
		const stem = s.replace(/\*$/, '').toLowerCase();
		return stem.length >= 4 && term.startsWith(stem.split(' ')[0]);
	});

/** Estonian inflects on the tail; an 8-char stem plus a wildcard catches the paradigm. */
const toWildcard = (term: string): string => (term.length > 8 ? `${term.slice(0, 8)}*` : term);

export const mine = async (): Promise<void> => {
	const pool = JSON.parse(readFileSync(join(DATA, 'pool.json'), 'utf8'));
	const candidates = pool.candidates as Candidate[];
	const inPool = new Set(candidates.map((c) => c.id));
	const verdicts = loadVerdicts();

	const jahIds = candidates.filter((c) => verdicts.get(c.id)?.vastus === 'JAH').map((c) => c.id);
	const eiIds = candidates.filter((c) => verdicts.get(c.id)?.vastus === 'EI').map((c) => c.id);
	// Same-size negative sample, spread across the pool rather than taken from the head, which is
	// date-sorted and would compare recent negatives against decades of positives.
	const step = Math.max(1, Math.floor(eiIds.length / Math.max(1, jahIds.length)));
	const eiSample = eiIds.filter((_, i) => i % step === 0).slice(0, jahIds.length);
	console.log(`mining over ${jahIds.length} positives against ${eiSample.length} negatives`);

	const dfJah = docFrequencies(jahIds);
	const dfEi = docFrequencies(eiSample);

	const seeds = JSON.parse(readFileSync(join(RESEARCH, 'seeds.json'), 'utf8')).vocabulary as string[];

	const scored = [...dfJah.entries()]
		.filter(([, n]) => n >= MIN_DF_JAH)
		.map(([term, n]) => ({
			term,
			lift: n / jahIds.length - (dfEi.get(term) ?? 0) / Math.max(1, eiSample.length),
			dfJah: n,
			dfEi: dfEi.get(term) ?? 0,
		}))
		.filter((r) => r.lift > 0.05 && !coveredBySeeds(r.term, seeds))
		.sort((a, b) => b.lift - a.lift);

	// Collapse inflections of one lemma to a single wildcard before spending requests on them.
	const proposals: {wildcard: string; lift: number; dfJah: number}[] = [];
	const taken = new Set<string>();
	for (const r of scored) {
		const w = toWildcard(r.term);
		if (taken.has(w)) continue;
		taken.add(w);
		proposals.push({wildcard: w, lift: r.lift, dfJah: r.dfJah});
		if (proposals.length >= TOP_N) break;
	}

	console.log(`probing ${proposals.length} proposed wildcards against the API`);
	const measured = await mapPool(proposals, 10, async (p) => {
		const first = await searchPage({text: p.wildcard});
		const total = first.kokku ?? 0;

		const offsets = [0, ...Array.from({length: SAMPLE_PAGES - 1}, (_, i) => (i + 1) * 300)].filter(
			(o) => o < total,
		);
		const pages = await mapPool(offsets, 3, (after) =>
			after === 0 ? Promise.resolve(first) : searchPage({text: p.wildcard, searchAfter: after}),
		);

		let seen = 0;
		let novel = 0;
		for (const page of pages) {
			for (const r of page.tulemused ?? []) {
				const c = toCandidate(r, 'mine');
				if (!c) continue;
				seen += 1;
				if (!inPool.has(c.id)) novel += 1;
			}
		}
		// Extrapolate the sampled novel share over the whole result set. Rough, but the question is
		// only whether a term is worth a human's attention.
		const novelShare = seen ? novel / seen : 0;
		return {...p, total, sampled: seen, novelShare, estimatedNew: Math.round(total * novelShare)};
	});

	measured.sort((a, b) => b.estimatedNew - a.estimatedNew);
	console.log('\nwildcard            hits   sampled  new%   est. new   lift  dfJAH');
	for (const m of measured.slice(0, 25)) {
		console.log(
			`${m.wildcard.padEnd(18)} ${String(m.total).padStart(6)} ${String(m.sampled).padStart(8)} ` +
				`${(m.novelShare * 100).toFixed(0).padStart(4)}% ${String(m.estimatedNew).padStart(9)} ` +
				`${m.lift.toFixed(2).padStart(6)} ${String(m.dfJah).padStart(6)}`,
		);
	}

	const totalNew = measured.reduce((n, m) => n + m.estimatedNew, 0);
	writeFileSync(
		join(DATA, 'mined-seeds.json'),
		JSON.stringify({at: new Date().toISOString(), positives: jahIds.length, measured}, null, 1),
	);
	console.log(
		`\nestimated ${totalNew} additional candidates across ${measured.length} proposals ` +
			`(overlapping — the union is smaller). Written to data/mined-seeds.json.`,
	);
	console.log(
		'Not merged into research/seeds.json: adding these would grow the pool past what one ' +
			'classification pass fits inside MAX_SPEND_USD, so it is a decision, not a step.',
	);
};

if (require.main === module) {
	mine().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
