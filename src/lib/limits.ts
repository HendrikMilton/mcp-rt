import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';
import {DATA} from './paths';

/**
 * Hard limits for the unattended ingest run.
 *
 * These are constants with abort paths, not things an operator remembers to check. The pipeline
 * runs for hours with nobody watching it; the failure modes worth guarding are a seed stage that
 * matches far more than expected, a classifier loop that burns Bedrock budget, and — the only
 * genuinely unbounded one — a crawler bug retrying forever against a government service.
 *
 * Breaching any of them throws LimitExceeded, which the orchestrator does not catch. Work already
 * flushed to S3 and to the local JSONL survives, so a raised limit resumes rather than restarts.
 */

/** Pool size ceiling. Expected ~18k; beyond this the seed set is matching something it shouldn't. */
export const MAX_CANDIDATES = 25_000;

/** Bedrock spend ceiling across embed + classify, tracked from real token usage. */
export const MAX_SPEND_USD = 150;

/** Total riigiteataja.ee search requests for the whole run. Runaway-retry guard. */
export const MAX_SEARCH_REQUESTS = 3_000;

/** Per-request attempts before giving up, with exponential backoff between them. */
export const MAX_RETRIES = 5;

/**
 * The spend ledger is persisted so MAX_SPEND_USD bounds the *run*, not one process. Ingest is
 * several commands — crawl, fetch, classify, audit, and reruns of each — and a cap that reset at
 * every process boundary would be a cap on nothing.
 */
const LEDGER = join(DATA, 'spend-ledger.json');

export class LimitExceeded extends Error {
	constructor(limit: string, value: number, cap: number) {
		super(`limit ${limit} exceeded: ${value.toFixed(2)} > ${cap}`);
		this.name = 'LimitExceeded';
	}
}

/**
 * Counts riigiteataja.ee search requests process-wide. Every call through the search client passes
 * here before the request goes out, so a retry loop trips the cap rather than spinning.
 */
class RequestBudget {
	private used = 0;

	take(): number {
		this.used += 1;
		if (this.used > MAX_SEARCH_REQUESTS) {
			throw new LimitExceeded('MAX_SEARCH_REQUESTS', this.used, MAX_SEARCH_REQUESTS);
		}
		return this.used;
	}

	get spent(): number {
		return this.used;
	}

	get remaining(): number {
		return MAX_SEARCH_REQUESTS - this.used;
	}
}

export const searchBudget = new RequestBudget();

/** USD per million tokens, Bedrock eu-central-1. */
const PRICING: Record<string, {input: number; output: number}> = {
	'eu.anthropic.claude-haiku-4-5-20251001-v1:0': {input: 1, output: 5},
	'eu.anthropic.claude-sonnet-4-6': {input: 3, output: 15},
	// Embed v4 bills per input token only; output is the vector.
	'eu.cohere.embed-v4:0': {input: 0.12, output: 0},
};

/**
 * Running Bedrock spend, accumulated from the usage each response reports rather than from an
 * estimate — an estimate cannot catch the failure it is meant to catch (a loop re-charging tokens
 * the estimate never predicted).
 */
class SpendMeter {
	private usd = 0;
	private byModel = new Map<string, {usd: number; calls: number; input: number; output: number}>();
	private loaded = false;

	/** Read once, lazily, so importing this module in a test does not touch the filesystem. */
	private load(): void {
		if (this.loaded) return;
		this.loaded = true;
		if (!existsSync(LEDGER)) return;
		try {
			const prior = JSON.parse(readFileSync(LEDGER, 'utf8'));
			this.usd = prior.usd ?? 0;
			for (const [model, row] of Object.entries(prior.byModel ?? {})) {
				this.byModel.set(model, row as {usd: number; calls: number; input: number; output: number});
			}
		} catch {
			// A torn ledger must not silently reset the cap to zero — refuse instead.
			throw new Error(`spend ledger at ${LEDGER} is unreadable; refusing to spend untracked`);
		}
	}

	private flush(): void {
		try {
			mkdirSync(dirname(LEDGER), {recursive: true});
			writeFileSync(LEDGER, JSON.stringify(this.toJSON(), null, 1), 'utf8');
		} catch {
			/* a Lambda with a read-only bundle still enforces in-process; the ledger is best effort */
		}
	}

	record(modelId: string, inputTokens: number, outputTokens: number): void {
		this.load();
		const price = PRICING[modelId];
		if (!price) throw new Error(`no pricing for ${modelId} — refusing to spend untracked`);

		const cost = (inputTokens * price.input + outputTokens * price.output) / 1e6;
		this.usd += cost;

		const row = this.byModel.get(modelId) ?? {usd: 0, calls: 0, input: 0, output: 0};
		row.usd += cost;
		row.calls += 1;
		row.input += inputTokens;
		row.output += outputTokens;
		this.byModel.set(modelId, row);

		this.flush();
		if (this.usd > MAX_SPEND_USD) throw new LimitExceeded('MAX_SPEND_USD', this.usd, MAX_SPEND_USD);
	}

	get spent(): number {
		this.load();
		return this.usd;
	}

	get remaining(): number {
		return MAX_SPEND_USD - this.spent;
	}

	report(): string {
		const lines = [...this.byModel.entries()].map(
			([model, r]) =>
				`  ${model}: $${r.usd.toFixed(2)} over ${r.calls} calls ` +
				`(${r.input.toLocaleString()} in / ${r.output.toLocaleString()} out)`,
		);
		return [`Bedrock spend: $${this.usd.toFixed(2)} of $${MAX_SPEND_USD}`, ...lines].join('\n');
	}

	toJSON() {
		return {
			usd: Number(this.usd.toFixed(4)),
			byModel: Object.fromEntries(
				[...this.byModel].map(([m, r]) => [m, {...r, usd: Number(r.usd.toFixed(4))}]),
			),
		};
	}
}

export const spend = new SpendMeter();

/**
 * Budget held back for the embedding pass, which runs *after* classification and is the stage that
 * actually produces the index.
 *
 * Without a reservation the two stages race for the same dollar: classification would run to within
 * cents of the cap, succeed, and then embedding would abort — losing the index while keeping the
 * expensive half. Reserving up front makes the outcome deterministic and puts any shortfall where
 * it is cheapest to recover: classification is resumable per row from classified.jsonl, embedding
 * is not started until it can complete.
 *
 * Sized from the measured corpus rather than guessed: 14.3% of 21,926 candidates survive at ~21.9
 * chunks each — ~68,600 chunks, ~24M tokens, ~$2.88 at Embed v4's $0.12/M. Reserved at $4 for
 * headroom. Set it too high and it aborts a classification pass that would have fitted; the number
 * is only useful if it tracks what embedding actually costs.
 */
export const EMBED_RESERVE_USD = 4;

/**
 * Pre-flight check: classification cost is deterministic before the run starts, so refuse to begin
 * a run that cannot finish inside the budget instead of discovering it 80% of the way through.
 */
export const projectedClassifyCost = (candidates: number, escalationRate = 0.05): number => {
	// Measured on a 40-decision spread across the real pool, 2026-09-16: 4,853 input and 106 output
	// tokens per call. Estonian tokenises at roughly 2.1 chars/token, so the 12k-char excerpt costs
	// noticeably more than an English document of the same length would — an estimate carried over
	// from English would have under-projected this run by a third.
	const inputTokensEach = 4_900;
	const outputTokensEach = 110;
	const haiku = PRICING['eu.anthropic.claude-haiku-4-5-20251001-v1:0'];
	const sonnet = PRICING['eu.anthropic.claude-sonnet-4-6'];
	const per = (p: {input: number; output: number}) =>
		(inputTokensEach * p.input + outputTokensEach * p.output) / 1e6;
	return candidates * per(haiku) + candidates * escalationRate * per(sonnet);
};
