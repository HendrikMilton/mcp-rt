/**
 * Download and extract text for every candidate — rejects included, which is the point: the
 * classifier's threshold and prompt are the parts most likely to change, and keeping the text means
 * changing either of them never re-crawls riigiteataja.ee.
 *
 * Downloads run at concurrency 25. Measured 0.11s/file 8-way with zero 429s, and throughput is
 * cleared with Riigi Teataja; unlike aki.ee this endpoint does not need a serial crawler.
 *
 * Resumable: a candidate whose text is already on local disk is skipped entirely, so a rerun after
 * an interruption costs nothing.
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import {DATA} from '../lib/paths';
import pdfParse from 'pdf-parse';
import {mapPool} from '../lib/pool';
import {fetchPdf} from '../lib/rt';
import {exists, getText, pdfKey, putPdf, putText, textKey} from '../lib/store';
import type {Candidate} from '../types';

const DOWNLOAD_CONCURRENCY = Number(process.env.DOWNLOAD_CONCURRENCY ?? 25);
/** Below this, pdf-parse produced nothing usable — a scan, or a stub cover page. */
const MIN_TEXT_CHARS = 400;


const TEXT_DIR = join(DATA, 'text');
const PDF_DIR = join(DATA, 'pdf');

/**
 * Set while the bucket does not exist yet, or to iterate locally. Both artifacts are kept on disk
 * either way, so `yarn fetch --upload-only` can push them afterwards without refetching.
 */
const SKIP_UPLOAD = process.env.SKIP_UPLOAD === '1';

export const textPath = (id: string): string => join(TEXT_DIR, `${id}.txt`);
export const pdfPath = (id: string): string => join(PDF_DIR, `${id}.pdf`);
export const localText = (id: string): string | null =>
	existsSync(textPath(id)) ? readFileSync(textPath(id), 'utf8') : null;

export interface FetchStats {
	fetched: number;
	cached: number;
	noText: number;
	failed: number;
	failures: {id: string; nr: string; reason: string}[];
}

const one = async (c: Candidate, stats: FetchStats): Promise<void> => {
	if (localText(c.id) !== null) {
		stats.cached += 1;
		return;
	}

	// A fresh environment — the monthly Lambda, whose /tmp starts empty — finds most of the pool
	// already extracted in S3. Pulling the text back is far cheaper than refetching and reparsing
	// the PDF, and it means the recurring run only downloads what the courts published since.
	const stored = await getText(c.id);
	if (stored !== null) {
		writeFileSync(textPath(c.id), stored, 'utf8');
		stats.cached += 1;
		return;
	}

	let pdf: Buffer;
	try {
		pdf = await fetchPdf(c.fileId);
	} catch (err) {
		stats.failed += 1;
		stats.failures.push({id: c.id, nr: c.nr, reason: `download: ${String(err).slice(0, 120)}`});
		return;
	}

	const parsed = await pdfParse(pdf).catch(() => null);
	const text = (parsed?.text ?? '').trim();

	if (text.length < MIN_TEXT_CHARS) {
		// Every decision sampled had a text layer, so this is rare enough not to warrant an OCR path;
		// it is recorded rather than silently dropped so a later run can revisit if it is not.
		stats.noText += 1;
		stats.failures.push({id: c.id, nr: c.nr, reason: `no text layer (${text.length} chars)`});
		return;
	}

	writeFileSync(pdfPath(c.id), pdf);
	writeFileSync(textPath(c.id), text, 'utf8');
	if (!SKIP_UPLOAD) await Promise.all([putPdf(c.id, pdf), putText(c.id, text)]);
	stats.fetched += 1;
};

export const fetchAll = async (candidates: Candidate[]): Promise<FetchStats> => {
	mkdirSync(TEXT_DIR, {recursive: true});
	mkdirSync(PDF_DIR, {recursive: true});
	const stats: FetchStats = {fetched: 0, cached: 0, noText: 0, failed: 0, failures: []};

	let done = 0;
	await mapPool(candidates, DOWNLOAD_CONCURRENCY, async (c) => {
		await one(c, stats);
		done += 1;
		if (done % 1000 === 0) {
			console.log(
				`  ${done}/${candidates.length} — ${stats.fetched} new, ${stats.cached} cached, ` +
					`${stats.noText} no text, ${stats.failed} failed`,
			);
		}
	});

	writeFileSync(join(DATA, 'fetch-failures.json'), JSON.stringify(stats.failures, null, 1));
	return stats;
};

/**
 * Push already-downloaded artifacts to S3. Used once the bucket exists, after a SKIP_UPLOAD run,
 * and again after each classification batch to publish the new survivors' text.
 *
 * A decision published by a court never changes, so anything already in the bucket is skipped on
 * sight — without that, every batch re-uploaded the whole corpus and the upload came to dominate
 * the run.
 */
export const uploadAll = async (candidates: Candidate[]): Promise<number> => {
	const have = candidates.filter((c) => existsSync(textPath(c.id)));
	let n = 0;
	let skipped = 0;
	await mapPool(have, DOWNLOAD_CONCURRENCY, async (c) => {
		// Checked independently: the text is what get_court_decision serves and is written first,
		// so a run interrupted between the two would otherwise leave the PDF permanently unarchived.
		const [hasText, hasPdf] = await Promise.all([exists(textKey(c.id)), exists(pdfKey(c.id))]);
		if (hasText && hasPdf) {
			skipped += 1;
			return;
		}
		if (!hasText) await putText(c.id, readFileSync(textPath(c.id), 'utf8'));
		if (!hasPdf && existsSync(pdfPath(c.id))) await putPdf(c.id, readFileSync(pdfPath(c.id)));
		n += 1;
		if (n % 500 === 0) console.log(`  uploaded ${n} (${skipped} already stored)`);
	});
	console.log(`uploaded ${n}, skipped ${skipped} already in S3`);
	return n;
};

if (require.main === module) {
	const pool = JSON.parse(readFileSync(join(DATA, 'pool.json'), 'utf8'));
	if (process.argv.includes('--upload-only')) {
		uploadAll(pool.candidates)
			.then((n) => console.log(`uploaded ${n} decisions to S3`))
			.catch((err) => {
				console.error(err);
				process.exit(1);
			});
	} else
	fetchAll(pool.candidates)
		.then((s) =>
			console.log(
				`\nfetched ${s.fetched}, cached ${s.cached}, no text ${s.noText}, failed ${s.failed}`,
			),
		)
		.catch((err) => {
			console.error(err);
			process.exit(1);
		});
}
