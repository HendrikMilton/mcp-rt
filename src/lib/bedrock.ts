/**
 * Bedrock calls for the ingest side: embedding survivors and classifying candidates.
 *
 * Every call routes its reported token usage through the spend meter, so MAX_SPEND_USD is enforced
 * against what Bedrock actually billed rather than against an estimate. Query-time embedding and
 * reranking live in mcp-aki, which serves both corpora.
 */
import {
	BedrockRuntimeClient,
	ConverseCommand,
	InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import {spend} from './limits';

const REGION = process.env.AWS_REGION ?? 'eu-central-1';

// Embed v4 is served only through an inference profile; the bare model id rejects on-demand calls.
export const EMBED_MODEL = process.env.EMBED_MODEL_ID ?? 'eu.cohere.embed-v4:0';
export const HAIKU = process.env.CLS_MODEL ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
export const SONNET = process.env.CLS_ESCALATE_MODEL ?? 'eu.anthropic.claude-sonnet-4-6';

export const EMBED_DIM = 1536;
export const EMBED_BATCH = 32;

/** Embed v4 throttles on tokens per minute, so a bulk ingest will hit it; adaptive backs off. */
const RETRY = {maxAttempts: 8, retryMode: 'adaptive' as const};
const runtime = new BedrockRuntimeClient({region: REGION, ...RETRY});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The SDK's own retries cover brief spikes; a sustained ingest needs longer, wider spacing. */
const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (err) {
			const name = (err as {name?: string}).name ?? '';
			if (attempt >= 6 || !/Throttling|TooManyRequests|ServiceUnavailable/i.test(name)) throw err;
			await sleep(Math.min(2 ** attempt * 1000, 30_000) * (0.5 + Math.random()));
		}
	}
};

export type InputType = 'search_document' | 'search_query';

/** One InvokeModel call. `texts` must be at most EMBED_BATCH long. */
export const embedBatch = async (texts: string[], inputType: InputType): Promise<number[][]> => {
	const res = await withRetry(() =>
		runtime.send(
			new InvokeModelCommand({
				modelId: EMBED_MODEL,
				contentType: 'application/json',
				body: JSON.stringify({
					texts,
					input_type: inputType,
					embedding_types: ['float'],
					output_dimension: EMBED_DIM,
					truncate: 'END',
				}),
			}),
		),
	);
	const parsed = JSON.parse(Buffer.from(res.body).toString('utf8'));
	// Cohere reports billed tokens on the response; fall back to a chars/4 estimate if absent so the
	// meter never silently stops counting.
	const billed =
		parsed?.meta?.billed_units?.input_tokens ??
		Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4);
	spend.record(EMBED_MODEL, billed, 0);
	return parsed.embeddings.float;
};

export interface ConverseResult {
	text: string;
	inputTokens: number;
	outputTokens: number;
}

/** One stateless Converse call at temperature 0. Used by the classifier, one call per decision. */
export const converse = async (
	modelId: string,
	prompt: string,
	maxTokens = 200,
): Promise<ConverseResult> => {
	const res = await withRetry(() =>
		runtime.send(
			new ConverseCommand({
				modelId,
				messages: [{role: 'user', content: [{text: prompt}]}],
				inferenceConfig: {maxTokens, temperature: 0},
			}),
		),
	);
	const inputTokens = res.usage?.inputTokens ?? 0;
	const outputTokens = res.usage?.outputTokens ?? 0;
	spend.record(modelId, inputTokens, outputTokens);
	return {
		text: res.output?.message?.content?.[0]?.text ?? '',
		inputTokens,
		outputTokens,
	};
};
