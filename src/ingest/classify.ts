/**
 * Precision stage: one stateless call per candidate, deciding whether a decision is *about* data
 * protection rather than merely containing personal data.
 *
 * Settings are measured, not guessed — scored against 87 labelled decisions (17 RT-annotated gold,
 * 70 random) in research/step4.json:
 *
 *   model          gold (17)   random (70) flagged   false positives
 *   Haiku 4.5      14          1                     1
 *   Sonnet 4.6     14          0                     0
 *   Nova Pro       14          7                     7
 *
 * Haiku with escalation to Sonnet below confidence 0.9 is the configuration used here. Haiku's only
 * error came at 0.85 and only 4 of 87 scored under 0.9, so escalation costs ~5% of the run and
 * catches exactly where the cheap model wavers. Haiku is also ~8x faster, which at 22k decisions
 * matters more than the money. Nova Pro failed by latching onto the boilerplate about requesting
 * anonymisation at publication — a trap present in ~7% of decisions, which the prompt names.
 *
 * Both Claudes reject the same three gold cases; those look like annotation edge cases rather than
 * model errors, so they are not treated as a recall ceiling to chase.
 *
 * Classification runs BEFORE embedding. That ordering is what keeps the index at ~58MB instead of
 * ~576MB, and it is why the pipeline can afford to keep every reject's text.
 */
import {appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import {DATA} from '../lib/paths';
import {HAIKU, SONNET, converse} from '../lib/bedrock';
import {EMBED_RESERVE_USD, MAX_SPEND_USD, projectedClassifyCost, spend} from '../lib/limits';
import {mapPool} from '../lib/pool';
import {getVerdicts, putVerdicts} from '../lib/store';
import type {Candidate, Verdict} from '../types';
import {localText} from './fetch';

export const PROMPT_VERSION = 'rt-dp-v1';

/** Confidence at or above which Haiku's answer stands on its own. */
const ESCALATE_BELOW = 0.9;

/**
 * 12k chars: the first 6k and the last 6k. Estonian decisions put the facts at the front and the
 * reasoning at the back, with procedural filler in the middle — the two ends carry the signal and
 * the median decision is only 10,369 chars anyway.
 */
const MAX_CHARS = 12_000;

/** Bedrock Converse tolerates a healthy amount of concurrency; the meter is the real limiter. */
const CONCURRENCY = Number(process.env.CLASSIFY_CONCURRENCY ?? 12);


const JSONL = join(DATA, 'classified.jsonl');

const PROMPT = `Allpool on väljavõte Eesti kohtulahendist.

Küsimus: kas see lahend käsitleb SISULISELT isikuandmete kaitse / privaatsuse / andmetöötluse õiguslikku küsimust?

JAH tähendab: vaidluse või põhjenduse osaks on isikuandmete töötlemise õiguspärasus, andmesubjekti õigused, andmete avaldamine/edastamine, jälgimine või eraelu puutumatuse riive õiguslik hindamine.

EI tähendab: isikuandmed või kaamerasalvestis esinevad lahendis üksnes taustal või tõendina, ilma et nende töötlemise õiguspärasust vaidlustataks või hinnataks. Samuti EI, kui ainus seos on lahendi avaldamisel nimede asendamise või anonüümimise standardklausel.

Vasta AINULT JSON-iga: {"vastus":"JAH"|"EI","kindlus":0.0-1.0,"pohjus":"<kuni 15 sona>"}

---
%TEXT%
---`;

/** Head and tail, with the elision marked so the model does not read across the cut. */
export const excerpt = (text: string, maxChars = MAX_CHARS): string => {
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars / 2);
	return `${text.slice(0, head)}\n[...]\n${text.slice(-(maxChars - head))}`;
};

interface Answer {
	vastus: 'JAH' | 'EI';
	kindlus: number;
	pohjus: string;
}

/** Models occasionally wrap the JSON in prose; take the outermost braces rather than fail the row. */
const parseAnswer = (raw: string): Answer | null => {
	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	if (start < 0 || end <= start) return null;
	try {
		const p = JSON.parse(raw.slice(start, end + 1));
		if (p.vastus !== 'JAH' && p.vastus !== 'EI') return null;
		return {
			vastus: p.vastus,
			kindlus: typeof p.kindlus === 'number' ? p.kindlus : 0,
			pohjus: String(p.pohjus ?? '').slice(0, 200),
		};
	} catch {
		return null;
	}
};

const askOnce = async (model: string, text: string): Promise<Answer | null> => {
	const {text: out} = await converse(model, PROMPT.replace('%TEXT%', excerpt(text)));
	return parseAnswer(out);
};

/** Haiku first; escalate to Sonnet only when Haiku is not confident. */
export const classifyOne = async (c: Candidate, text: string): Promise<Verdict> => {
	const base = {
		id: c.id,
		nr: c.nr,
		promptVersion: PROMPT_VERSION,
		at: new Date().toISOString(),
		chars: text.length,
	};

	const cheap = await askOnce(HAIKU, text);
	if (cheap && cheap.kindlus >= ESCALATE_BELOW) {
		return {...base, ...cheap, model: HAIKU, escalated: false};
	}

	const strong = await askOnce(SONNET, text);
	if (strong) return {...base, ...strong, model: SONNET, escalated: true};
	if (cheap) return {...base, ...cheap, model: HAIKU, escalated: false};
	return {...base, vastus: 'EI', kindlus: 0, pohjus: 'parse failed', model: SONNET, escalated: true};
};

/** Verdicts already on disk, so an interrupted run resumes instead of re-paying for them. */
export const loadVerdicts = (): Map<string, Verdict> => {
	const out = new Map<string, Verdict>();
	if (!existsSync(JSONL)) return out;
	for (const line of readFileSync(JSONL, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try {
			const v = JSON.parse(line) as Verdict;
			// A prompt change invalidates stored verdicts; the text is kept, so re-running is cheap.
			if (v.promptVersion === PROMPT_VERSION) out.set(v.id, v);
		} catch {
			/* a torn final line from an interrupted run — the id simply gets reclassified */
		}
	}
	return out;
};

export interface ClassifyStats {
	classified: number;
	resumed: number;
	jah: number;
	ei: number;
	escalated: number;
	missingText: number;
}

/**
 * Seed the local ledger from S3 before classifying. Without this the monthly Lambda run, whose
 * /tmp starts empty, would reclassify all ~22k candidates — a hundred dollars a month for a delta
 * of a few hundred decisions.
 */
export const hydrateVerdicts = async (): Promise<number> => {
	mkdirSync(DATA, {recursive: true});
	const local = loadVerdicts();
	const remote = await getVerdicts();
	const fresh = remote.filter((v) => v.promptVersion === PROMPT_VERSION && !local.has(v.id));
	if (fresh.length) {
		appendFileSync(JSONL, fresh.map((v) => JSON.stringify(v)).join('\n') + '\n', 'utf8');
	}
	return fresh.length;
};

/** Push the merged ledger back, so the next run in a fresh environment starts where this one ended. */
export const flushVerdicts = async (): Promise<number> => {
	const all = [...loadVerdicts().values()];
	if (all.length) await putVerdicts(all);
	return all.length;
};

export const classifyAll = async (candidates: Candidate[]): Promise<ClassifyStats> => {
	mkdirSync(DATA, {recursive: true});
	const done = loadVerdicts();

	const projected = projectedClassifyCost(candidates.length - done.size);
	const budget = MAX_SPEND_USD - EMBED_RESERVE_USD;
	console.log(
		`classify: ${candidates.length} candidates, ${done.size} already done; ` +
			`projected $${projected.toFixed(2)}, spent so far $${spend.spent.toFixed(2)}; ` +
			`budget $${budget} ($${MAX_SPEND_USD} less $${EMBED_RESERVE_USD} reserved for embedding)`,
	);
	if (projected + spend.spent > budget) {
		// Deterministic before the run starts: refuse rather than discover it 80% of the way through.
		throw new Error(
			`projected classify spend $${(projected + spend.spent).toFixed(2)} exceeds the ` +
				`$${budget} classification budget (MAX_SPEND_USD $${MAX_SPEND_USD} less ` +
				`$${EMBED_RESERVE_USD} reserved for embedding). Resume is free: verdicts already in ` +
				`classified.jsonl are never re-paid for.`,
		);
	}

	const stats: ClassifyStats = {
		classified: 0,
		resumed: done.size,
		jah: 0,
		ei: 0,
		escalated: 0,
		missingText: 0,
	};
	for (const v of done.values()) {
		if (v.vastus === 'JAH') stats.jah += 1;
		else stats.ei += 1;
		if (v.escalated) stats.escalated += 1;
	}

	const todo = candidates.filter((c) => !done.has(c.id));
	let n = 0;

	await mapPool(todo, CONCURRENCY, async (c) => {
		const text = localText(c.id);
		if (text === null) {
			stats.missingText += 1;
			return;
		}

		const verdict = await classifyOne(c, text);
		// Append per row: the meter or a limit can stop the run at any point and nothing is lost.
		appendFileSync(JSONL, `${JSON.stringify(verdict)}\n`, 'utf8');

		stats.classified += 1;
		if (verdict.vastus === 'JAH') stats.jah += 1;
		else stats.ei += 1;
		if (verdict.escalated) stats.escalated += 1;

		n += 1;
		if (n % 500 === 0) {
			console.log(
				`  ${n}/${todo.length} — ${stats.jah} JAH / ${stats.ei} EI, ` +
					`${stats.escalated} escalated, $${spend.spent.toFixed(2)} spent`,
			);
		}
	});

	writeFileSync(join(DATA, 'spend.json'), JSON.stringify(spend.toJSON(), null, 1));
	return stats;
};

if (require.main === module) {
	const pool = JSON.parse(readFileSync(join(DATA, 'pool.json'), 'utf8'));
	classifyAll(pool.candidates)
		.then((s) => {
			console.log(`\n${JSON.stringify(s)}`);
			console.log(spend.report());
		})
		.catch((err) => {
			console.error(err);
			console.log(spend.report());
			process.exit(1);
		});
}
