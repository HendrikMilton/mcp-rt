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
 * Statute citations, for the `norm` filter.
 *
 * Captured to subsection precision — "AvTS § 35 lg 1 p 11", not just "AvTS § 35". The coarse form
 * made the filter unusable for the question lawyers actually ask: § 35 has twelve grounds and they
 * are different rules, so a lawyer looking for p 11 had to fall back to full-text search and hope.
 *
 * Both forms are kept for the same citation, so a `norm` filter matching on substring still works
 * at either precision — searching "AvTS § 35" continues to find a decision that only ever cites
 * "§ 35 lg 1 p 11". Narrowing what an existing search returns would be the worse failure.
 *
 * Superscripted paragraphs (KarS § 157²) are common in Estonian statutes and are a different
 * offence from the unsuperscripted one, so the index keeps them apart.
 */
const SUPERSCRIPT_DIGITS = '\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079';

/** "157 3" -> "157\u00b3"; an already-superscripted or plain number is returned unchanged. */
const superscriptTail = (num: string): string => {
	const detached = num.match(/^(\d+)\s+(\d)$/);
	if (detached) return detached[1] + SUPERSCRIPT_DIGITS[Number(detached[2])];
	return num.replace(/\s+/g, '');
};

const CITATION_RE =
	/\b([A-ZÄÖÜÕ][A-ZÄÖÜÕa-zäöüõ]{1,9})\s*(?:§|art\.?)\s*(\d+(?:[¹²³⁴-⁹]|\s\d(?=\s|$))?)((?:\s*(?:lg|lõige)\s*\d+)?(?:\s*(?:p|punkt)\s*\d+)?)/g;

export const extractNorms = (text: string, limit = 40): string => {
	const counts = new Map<string, number>();
	for (const [, act, num, rest] of text.matchAll(CITATION_RE)) {
		const sep = /^(IKÜM|EIÕK|ELTL|ELPH)$/.test(act) ? 'art' : '§';
		// PDF extraction renders a superscript as a detached plain digit ("§ 157 3"). Joining it
		// naively gives "§ 1573", naming a provision that does not exist — so the trailing digit is
		// restored as a superscript, which is how the statute and the lawyer both write it.
		const base = `${act} ${sep} ${superscriptTail(num)}`;
		counts.set(base, (counts.get(base) ?? 0) + 1);

		const detail = rest.trim().replace(/\s+/g, ' ').replace(/lõige/g, 'lg').replace(/punkt/g, 'p');
		if (detail) counts.set(`${base} ${detail}`, (counts.get(`${base} ${detail}`) ?? 0) + 1);
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
