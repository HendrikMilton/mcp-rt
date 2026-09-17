/**
 * S3 layout for the court corpus. Everything lives under one `rt/` prefix so the MCP server can
 * hold both corpora without either being able to see the other's keys.
 *
 *   rt/raw/{id}.pdf          every candidate, rejects included
 *   rt/text/{id}.txt         every candidate, rejects included
 *   rt/classified.jsonl      one line per candidate: the verdict, the model, the prompt version
 *   rt/index/                meta.json.gz + vectors.i8 + scales.f32 — survivors only
 *
 * Text is kept for rejects on purpose: re-thresholding or a prompt change then costs a classify
 * pass, not a re-crawl. Every access pattern at query time is a full scan of a ~3MB metadata blob,
 * so a file beats a table and there is no DynamoDB here.
 */
import {GetObjectCommand, PutObjectCommand, S3Client} from '@aws-sdk/client-s3';
import {gunzipSync, gzipSync} from 'zlib';
import {EMBED_DIM} from './bedrock';
import type {Chunk, Doc, Verdict} from '../types';

const REGION = process.env.AWS_REGION ?? 'eu-central-1';
export const BUCKET = process.env.RT_BUCKET ?? 'hycapital-rt-rag';
export const PREFIX = 'rt';

const s3 = new S3Client({region: REGION});

export const put = (key: string, body: Buffer | string, contentType: string) =>
	s3.send(new PutObjectCommand({Bucket: BUCKET, Key: key, Body: body, ContentType: contentType}));

export const getBytes = async (key: string): Promise<Buffer> => {
	const res = await s3.send(new GetObjectCommand({Bucket: BUCKET, Key: key}));
	return Buffer.from(await res.Body!.transformToByteArray());
};

export const putPdf = (id: string, pdf: Buffer) => put(`${PREFIX}/raw/${id}.pdf`, pdf, 'application/pdf');
export const putText = (id: string, text: string) =>
	put(`${PREFIX}/text/${id}.txt`, text, 'text/plain; charset=utf-8');

/** Extracted text already in S3, or null. Lets a fresh environment skip the download entirely. */
export const getText = async (id: string): Promise<string | null> => {
	try {
		return (await getBytes(`${PREFIX}/text/${id}.txt`)).toString('utf8');
	} catch {
		return null;
	}
};

const VERDICTS_KEY = `${PREFIX}/classified.jsonl`;

/**
 * The classification ledger. This is the artifact that makes the monthly run cost cents rather than
 * a hundred dollars: a candidate already carrying a verdict for the current prompt version is never
 * sent to a model again, and the file survives the Lambda's ephemeral /tmp.
 */
export const getVerdicts = async (): Promise<Verdict[]> => {
	let raw: string;
	try {
		raw = (await getBytes(VERDICTS_KEY)).toString('utf8');
	} catch {
		return [];
	}
	const out: Verdict[] = [];
	for (const line of raw.split('\n')) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as Verdict);
		} catch {
			/* a torn line from an interrupted flush — that id is simply reclassified */
		}
	}
	return out;
};

export const putVerdicts = (verdicts: Verdict[]): Promise<unknown> =>
	put(
		VERDICTS_KEY,
		verdicts.map((v) => JSON.stringify(v)).join('\n') + '\n',
		'application/x-ndjson',
	);

export interface StoredIndex {
	docs: Doc[];
	chunks: Chunk[];
	vectors: Int8Array;
	scales: Float32Array;
}

/** The index as it stands, so a rebuild can reuse vectors instead of re-embedding unchanged text. */
export const readIndex = async (): Promise<StoredIndex | null> => {
	try {
		const [metaGz, vecBuf, scaleBuf] = await Promise.all([
			getBytes(`${PREFIX}/index/meta.json.gz`),
			getBytes(`${PREFIX}/index/vectors.i8`),
			getBytes(`${PREFIX}/index/scales.f32`),
		]);
		const meta = JSON.parse(gunzipSync(metaGz).toString('utf8'));
		return {
			docs: meta.docs,
			chunks: meta.chunks,
			vectors: new Int8Array(vecBuf.buffer, vecBuf.byteOffset, vecBuf.length),
			scales: new Float32Array(scaleBuf.buffer, scaleBuf.byteOffset, scaleBuf.length / 4),
		};
	} catch {
		return null;
	}
};

/**
 * int8 quantisation: a unit vector scaled to +-127 plus one float scale per chunk. Costs ~1% cosine
 * error and cuts the index by 4x, which keeps the server's cold-start download under a second.
 */
export const quantize = (vec: number[]): {bytes: Int8Array; scale: number} => {
	let max = 0;
	for (const v of vec) max = Math.max(max, Math.abs(v));
	const scale = max / 127 || 1;
	const bytes = new Int8Array(vec.length);
	for (let i = 0; i < vec.length; i++) bytes[i] = Math.round(vec[i] / scale);
	return {bytes, scale};
};

export const writeIndex = async (
	docs: Doc[],
	chunks: Chunk[],
	vectors: number[][],
): Promise<{metaBytes: number; vectorBytes: number}> => {
	const bytes = new Int8Array(chunks.length * EMBED_DIM);
	const scales = new Float32Array(chunks.length);
	vectors.forEach((vec, i) => {
		const q = quantize(vec);
		bytes.set(q.bytes, i * EMBED_DIM);
		scales[i] = q.scale;
	});

	const meta = gzipSync(
		Buffer.from(JSON.stringify({builtAt: new Date().toISOString(), dim: EMBED_DIM, docs, chunks})),
	);

	await Promise.all([
		put(`${PREFIX}/index/meta.json.gz`, meta, 'application/gzip'),
		put(`${PREFIX}/index/vectors.i8`, Buffer.from(bytes.buffer), 'application/octet-stream'),
		put(`${PREFIX}/index/scales.f32`, Buffer.from(scales.buffer), 'application/octet-stream'),
	]);
	return {metaBytes: meta.length, vectorBytes: bytes.byteLength + scales.byteLength};
};
