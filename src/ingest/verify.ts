/**
 * Spot-check rejects for wrong "no"s.
 *
 * The 87-decision label set measured false positives (Haiku: 1 in 70 random) but says almost
 * nothing about false negatives, because the random sample contained no positives to miss. With
 * ~20k rejects on disk, a wrong-EI rate of even a few percent would be hundreds of decisions
 * silently absent from the corpus.
 *
 * This re-asks Sonnet — the stronger model, and the one whose disagreements would be escalated
 * during a live run — about a stratified sample of rejects. Stratified, not uniform: a reject that
 * came back at 0.95 is a different claim from one that came back at 0.7, and lumping them together
 * would hide whichever is worse.
 */
import {readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import {DATA} from '../lib/paths';
import {SONNET, converse} from '../lib/bedrock';
import {spend} from '../lib/limits';
import {mapPool} from '../lib/pool';
import type {Candidate, Verdict} from '../types';
import {localText} from './fetch';
import {PROMPT_VERSION, loadVerdicts} from './classify';


const PER_BAND = 40;

/** Confidence bands, so a wrong-EI rate can be attributed to where the classifier was unsure. */
const BANDS: [string, number, number][] = [
	['low  (<0.85)', 0, 0.85],
	['mid  (0.85-0.94)', 0.85, 0.95],
	['high (>=0.95)', 0.95, 1.01],
];

const PROMPT = `Allpool on väljavõte Eesti kohtulahendist.

Küsimus: kas see lahend käsitleb SISULISELT isikuandmete kaitse / privaatsuse / andmetöötluse õiguslikku küsimust?

JAH tähendab: vaidluse või põhjenduse osaks on isikuandmete töötlemise õiguspärasus, andmesubjekti õigused, andmete avaldamine/edastamine, jälgimine või eraelu puutumatuse riive õiguslik hindamine.

EI tähendab: isikuandmed või kaamerasalvestis esinevad lahendis üksnes taustal või tõendina, ilma et nende töötlemise õiguspärasust vaidlustataks või hinnataks. Samuti EI, kui ainus seos on lahendi avaldamisel nimede asendamise või anonüümimise standardklausel.

Vasta AINULT JSON-iga: {"vastus":"JAH"|"EI","kindlus":0.0-1.0,"pohjus":"<kuni 15 sona>"}

---
%TEXT%
---`;

const excerpt = (t: string): string =>
	t.length <= 12_000 ? t : `${t.slice(0, 6_000)}\n[...]\n${t.slice(-6_000)}`;

export const verify = async (): Promise<void> => {
	const pool = JSON.parse(readFileSync(join(DATA, 'pool.json'), 'utf8'));
	const byId = new Map((pool.candidates as Candidate[]).map((c) => [c.id, c]));
	const verdicts = [...loadVerdicts().values()].filter((v) => v.vastus === 'EI');
	console.log(`${verdicts.length} rejects on disk; sampling ${PER_BAND} from each confidence band`);

	const sample: Verdict[] = [];
	for (const [label, lo, hi] of BANDS) {
		const band = verdicts.filter((v) => v.kindlus >= lo && v.kindlus < hi);
		const step = Math.max(1, Math.floor(band.length / PER_BAND));
		const picked = band.filter((_, i) => i % step === 0).slice(0, PER_BAND);
		console.log(`  ${label}: ${band.length} rejects, checking ${picked.length}`);
		sample.push(...picked);
	}

	const rows = await mapPool(sample, 8, async (v) => {
		const text = localText(v.id);
		if (text === null) return {...v, second: 'SKIP', secondWhy: 'no text'};
		const {text: out} = await converse(SONNET, PROMPT.replace('%TEXT%', excerpt(text)));
		const start = out.indexOf('{');
		const end = out.lastIndexOf('}');
		if (start < 0 || end <= start) return {...v, second: 'SKIP', secondWhy: 'unparseable'};
		try {
			const p = JSON.parse(out.slice(start, end + 1));
			return {...v, second: p.vastus as string, secondConf: p.kindlus, secondWhy: p.pohjus};
		} catch {
			return {...v, second: 'SKIP', secondWhy: 'unparseable'};
		}
	});

	const scored = rows.filter((r) => r.second === 'JAH' || r.second === 'EI');
	const flipped = scored.filter((r) => r.second === 'JAH');

	console.log('\n--- rejects Sonnet would have kept ---');
	for (const r of flipped) {
		const c = byId.get(r.id);
		console.log(
			`  ${(c?.nr ?? r.id).padEnd(16)} Haiku EI@${r.kindlus.toFixed(2)} -> JAH@${
				(r as {secondConf?: number}).secondConf?.toFixed(2) ?? '?'
			}  ${String(r.secondWhy).slice(0, 80)}`,
		);
	}

	const perBand = BANDS.map(([label, lo, hi]) => {
		const inBand = scored.filter((r) => r.kindlus >= lo && r.kindlus < hi);
		const flips = inBand.filter((r) => r.second === 'JAH').length;
		return {band: label, checked: inBand.length, flipped: flips};
	});

	writeFileSync(
		join(DATA, 'verify.json'),
		JSON.stringify(
			{at: new Date().toISOString(), promptVersion: PROMPT_VERSION, perBand, rows},
			null,
			1,
		),
	);

	console.log('');
	for (const b of perBand) {
		const rate = b.checked ? (b.flipped / b.checked) * 100 : 0;
		console.log(`  ${b.band.padEnd(18)} ${b.flipped}/${b.checked} wrong "no" (${rate.toFixed(0)}%)`);
	}
	console.log(
		`\noverall ${flipped.length}/${scored.length} of sampled rejects would be kept by Sonnet.`,
	);
	console.log(spend.report());
};

if (require.main === module) {
	verify().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
