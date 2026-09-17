/**
 * Adversarial out-of-pool sample — the only measure of what the seed stage misses.
 *
 * The seed set found 15 of 17 gold decisions, but the gold set is positives-only and the 70-decision
 * random sample produced no positives at all, so neither says anything about leak. A uniform random
 * sample would not either: at a base rate under 1.4%, finding one positive in 50 draws is luck.
 *
 * So this samples where the seeds are weakest on purpose. Every term below is near-miss vocabulary —
 * the wording a data-protection decision plausibly uses while containing none of the 19 seed
 * wildcards — and every decision sampled is confirmed absent from the pool before it is classified.
 *
 * The number this produces is therefore not the corpus-wide leak rate. It is the leak rate in the
 * region deliberately chosen to be hardest, which is the useful direction to be wrong in: a low
 * number here is evidence, a high one is a reason to mine vocabulary and re-crawl.
 */
import {readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import {DATA} from '../lib/paths';
import pdfParse from 'pdf-parse';
import {spend} from '../lib/limits';
import {mapPool} from '../lib/pool';
import {fetchPdf, searchPage, toCandidate} from '../lib/rt';
import type {Candidate} from '../types';
import {classifyOne} from './classify';


const SAMPLE_SIZE = 50;

/**
 * Near-miss terms, chosen to have no overlap with any seed wildcard in research/seeds.json.
 * `videovalv*` is a seed, `turvakaamera` is not; `jälgimisseade*` is a seed, `jälitustoiming` is not.
 */
const NEAR_MISS = [
	'jälitustoiming',
	'päring registrist',
	'saladuse hoidmise kohustus',
	'konfidentsiaalsuskohustus',
	'sideandmed',
	'kõneeristus',
	'turvakaamera',
	'salvestis',
	'ärisaladus',
	'teabenõue',
	'pangasaladus',
	'maksusaladus',
	'asukohaandmed',
	'biomeetriline',
	'e-kirjade lugemine',
	'patsiendi andmed',
	'nime avalikustamine',
	'läbiotsimine arvutis',
];

/** Spread the draw across each term's result set rather than taking the newest 30. */
const OFFSETS = [0, 300, 900, 2100];

export const runAudit = async (): Promise<void> => {
	const pool = JSON.parse(readFileSync(join(DATA, 'pool.json'), 'utf8'));
	const inPool = new Set<string>((pool.candidates as Candidate[]).map((c) => c.id));
	console.log(`pool has ${inPool.size} candidates; drawing ${SAMPLE_SIZE} decisions from outside it`);

	const queries = NEAR_MISS.flatMap((term) => OFFSETS.map((after) => ({term, after})));
	const pages = await mapPool(queries, 12, async ({term, after}) => {
		const page = await searchPage({text: term, searchAfter: after});
		return {term, results: page.tulemused ?? []};
	});

	// Round-robin across terms so one high-volume term cannot dominate the sample.
	const byTerm = new Map<string, Candidate[]>();
	for (const {term, results} of pages) {
		const list = byTerm.get(term) ?? [];
		for (const r of results) {
			const c = toCandidate(r, `audit:${term}`);
			if (c && !inPool.has(c.id) && !list.some((x) => x.id === c.id)) list.push(c);
		}
		byTerm.set(term, list);
	}

	const sample: Candidate[] = [];
	const seen = new Set<string>();
	for (let round = 0; sample.length < SAMPLE_SIZE && round < 40; round++) {
		for (const list of byTerm.values()) {
			const c = list[round];
			if (c && !seen.has(c.id)) {
				seen.add(c.id);
				sample.push(c);
				if (sample.length === SAMPLE_SIZE) break;
			}
		}
	}
	console.log(`sampled ${sample.length} out-of-pool decisions across ${byTerm.size} near-miss terms`);

	const rows = await mapPool(sample, 8, async (c) => {
		const pdf = await fetchPdf(c.fileId).catch(() => null);
		if (!pdf) return {...c, vastus: 'ERR' as const, kindlus: 0, pohjus: 'download failed'};
		const text = ((await pdfParse(pdf).catch(() => null))?.text ?? '').trim();
		if (text.length < 400) {
			return {...c, vastus: 'ERR' as const, kindlus: 0, pohjus: 'no text layer'};
		}
		const v = await classifyOne(c, text);
		return {...c, vastus: v.vastus, kindlus: v.kindlus, pohjus: v.pohjus, escalated: v.escalated};
	});

	const scored = rows.filter((r) => r.vastus !== 'ERR');
	const leaked = scored.filter((r) => r.vastus === 'JAH');

	console.log('\n--- leaked (data protection, but absent from the pool) ---');
	for (const r of leaked) {
		console.log(`  ${r.nr.padEnd(16)} ${r.channels[0].padEnd(34)} ${r.kindlus.toFixed(2)} ${r.pohjus}`);
	}

	const byTermLeak = new Map<string, {n: number; jah: number}>();
	for (const r of scored) {
		const term = r.channels[0].replace('audit:', '');
		const row = byTermLeak.get(term) ?? {n: 0, jah: 0};
		row.n += 1;
		if (r.vastus === 'JAH') row.jah += 1;
		byTermLeak.set(term, row);
	}

	const out = {
		at: new Date().toISOString(),
		sampled: rows.length,
		scored: scored.length,
		leaked: leaked.length,
		leakRate: scored.length ? leaked.length / scored.length : 0,
		byTerm: Object.fromEntries(byTermLeak),
		rows,
	};
	writeFileSync(join(DATA, 'audit.json'), JSON.stringify(out, null, 1));

	console.log(
		`\n${leaked.length} of ${scored.length} scored out-of-pool decisions are data protection ` +
			`(${(out.leakRate * 100).toFixed(0)}% of the adversarial sample).`,
	);
	console.log(spend.report());
};

if (require.main === module) {
	runAudit().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
