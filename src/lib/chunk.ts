/**
 * Estonian court decisions carry a fixed skeleton of ALL-CAPS headings across all three tiers —
 * sampled maakohus, ringkonnakohus and Riigikohus decisions all use them. Splitting on those first
 * keeps the legal reasoning (KOLLEEGIUMI SEISUKOHT / KOHTU PÕHJENDUSED) in coherent pieces instead
 * of windowing across the boundary between the facts and the finding.
 *
 * Decisions that carry no headings at all — short procedural rulings, mostly — fall back to plain
 * windowing under a PREAMBUL section rather than being dropped.
 */
const HEADINGS = [
	'RESOLUTSIOON',
	'RIIGIKOHUS OTSUSTAB',
	'RIIGIKOHUS MÄÄRAB',
	'KOHUS OTSUSTAS',
	'KOHUS MÄÄRAS',
	'OTSUSTAS',
	'ASJAOLUD JA MENETLUSE KÄIK',
	'ASJAOLUD JA MENETLUSKÄIK',
	'ASJAOLUD',
	'MENETLUSE KÄIK',
	'MENETLUSKÄIK',
	'SÜÜDISTUSE SISU',
	'MENETLUSOSALISTE PÕHJENDUSED',
	'MENETLUSOSALISTE SEISUKOHAD',
	'MÄÄRUSKAEBEMENETLUSE POOLTE SEISUKOHAD',
	'KASSATSIOONIMENETLUSE POOLTE SEISUKOHAD',
	'APELLATSIOONIMENETLUSE POOLTE SEISUKOHAD',
	'POOLTE SEISUKOHAD',
	'KOLLEEGIUMI SEISUKOHT',
	'RINGKONNAKOHTU SEISUKOHT',
	'MAAKOHTU SEISUKOHT',
	'KOHTU SEISUKOHT',
	'KOHTU PÕHJENDUSED',
	'PÕHJENDUSED',
	'KOHTU HINNANG',
	'TÕENDID',
	'MENETLUSKULUD',
	'EDASIKAEBAMISE KORD',
	'VAIDLUSTAMISVIIDE',
];

// Longest first, so "ASJAOLUD JA MENETLUSE KÄIK" wins over the "ASJAOLUD" prefix.
const HEADING_RE = new RegExp(
	`\\n\\s*(${[...HEADINGS].sort((a, b) => b.length - a.length).join('|')})[:\\s]*\\n`,
	'g',
);

const MAX_CHARS = 1400;
const OVERLAP_CHARS = 200;

/**
 * Ceiling on chunks from one decision.
 *
 * Measured over a 1,097-decision sample of the real pool: median 18 chunks, p90 48, p99 169, max
 * 848. The tail is mass criminal judgments whose RESOLUTSIOON lists a sentence per defendant —
 * hundreds of near-identical passages that would take up a disproportionate share of the index and
 * crowd the retrieval pool without answering anything. A cap of 80 touches 3.1% of decisions and
 * removes 12% of chunks; the typical decision is untouched.
 *
 * What is dropped is chosen round-robin across sections rather than by truncating the document, so
 * a capped decision keeps coverage of its reasoning instead of stopping partway through its
 * operative part.
 */
const MAX_CHUNKS_PER_DOC = 80;
/** Below this a "section" is a stray heading echo in a table of contents, not a body. */
const MIN_SECTION_CHARS = 80;

export const cleanPdfText = (raw: string): string =>
	raw
		.replace(/\r/g, '')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

export const chunkDocument = (text: string): {section: string; text: string}[] => {
	const clean = cleanPdfText(text);
	const parts = clean.split(HEADING_RE);
	const sections: [string, string][] = [['PREAMBUL', parts[0] ?? '']];
	for (let i = 1; i < parts.length - 1; i += 2) {
		sections.push([parts[i].trim(), parts[i + 1] ?? '']);
	}

	const out: {section: string; text: string}[] = [];
	for (const [section, body] of sections) {
		const trimmed = body.trim();
		if (trimmed.length < MIN_SECTION_CHARS) continue;

		const sentences = trimmed.split(/(?<=[.;:])\s+/);
		let current = '';
		for (const sentence of sentences) {
			if (current.length + sentence.length > MAX_CHARS && current) {
				out.push({section, text: current.trim()});
				current = `${current.slice(-OVERLAP_CHARS)} `;
			}
			current += `${sentence} `;
		}
		if (current.trim()) out.push({section, text: current.trim()});
	}
	return out.length > MAX_CHUNKS_PER_DOC ? thinEvenly(out) : out;
};

/** Keep MAX_CHUNKS_PER_DOC pieces spread across sections, in document order. */
const thinEvenly = (chunks: {section: string; text: string}[]): {section: string; text: string}[] => {
	const bySection = new Map<string, number[]>();
	chunks.forEach((c, i) => {
		const list = bySection.get(c.section) ?? [];
		list.push(i);
		bySection.set(c.section, list);
	});

	const keep = new Set<number>();
	const queues = [...bySection.values()];
	for (let round = 0; keep.size < MAX_CHUNKS_PER_DOC; round++) {
		let progressed = false;
		for (const q of queues) {
			// Within a section, spread the picks across it rather than taking its first N.
			if (round >= q.length) continue;
			const stride = Math.max(1, Math.floor(q.length / Math.ceil(MAX_CHUNKS_PER_DOC / queues.length)));
			const pick = q[Math.min(q.length - 1, round * stride)];
			keep.add(pick);
			progressed = true;
			if (keep.size === MAX_CHUNKS_PER_DOC) break;
		}
		if (!progressed) break;
	}
	return chunks.filter((_, i) => keep.has(i));
};

/**
 * Statute citations, for the `norm` filter. Estonian decisions cite either
 * "<act abbreviation> § 35 lg 2 p 1" or, for EU law, "IKÜM art 15 lg 1".
 * Stored as a distinct, frequency-ordered list rather than every occurrence.
 */
const CITATION_RE = /\b([A-ZÄÖÜÕ][A-ZÄÖÜÕa-zäöüõ]{1,9})\s*(?:§|art\.?)\s*(\d+[0-9¹²³]*)/g;

export const extractNorms = (text: string, limit = 25): string => {
	const counts = new Map<string, number>();
	for (const [, act, num] of text.matchAll(CITATION_RE)) {
		const sep = /^(IKÜM|EIÕK|ELTL|ELPH)$/.test(act) ? 'art' : '§';
		const key = `${act} ${sep} ${num}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([k]) => k)
		.join('; ');
};

/**
 * Text handed to both BM25 and the embedder at ingest time.
 *
 * MUST stay byte-identical to `chunkText` in mcp-aki/src/lib/search.ts, which serves this index —
 * vectors built from one string and queried against another silently lose recall.
 */
export const chunkText = (doc: {nr: string; court: string} | undefined, chunk: {section: string; text: string}): string =>
	`${doc ? `${doc.nr} · ${doc.court}` : ''} | ${chunk.section}\n${chunk.text}`;
