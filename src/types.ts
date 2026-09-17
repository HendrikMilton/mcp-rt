/** Estonian court procedure type, as Riigi Teataja classifies it. */
export type Menetlus = 'tsiviil' | 'kriminaal' | 'haldus' | 'vaarteo' | 'pohiseadus' | 'muu';

/** Court tier, derived from the issuing body's name. */
export type Tier = 'maakohus' | 'ringkonnakohus' | 'riigikohus';

/** One court decision, as the seed stage found it. */
export interface Candidate {
	/** objektId, stringified. Stable across crawls. */
	id: string;
	/** Case number, e.g. "3-26-1048/10". */
	nr: string;
	/** avalikustatudFailiId — the id the PDF is served under, different from objektId. */
	fileId: number;
	court: string;
	tier: Tier;
	menetlus: Menetlus;
	/** ISO date the decision was pronounced. */
	date: string;
	year: number;
	/** RT's own case categories, where it sets any. */
	categories: string[];
	/** Taxonomy (märksõna) paths — populated for annotated decisions only, mostly Riigikohus. */
	marksonad: string[];
	/** Which seed channels matched, e.g. ["vocab:isikuandme*", "para:AvTS § 35"]. */
	channels: string[];
}

/** A classified candidate. Written for every candidate, rejects included. */
export interface Verdict {
	id: string;
	nr: string;
	vastus: 'JAH' | 'EI';
	kindlus: number;
	pohjus: string;
	model: string;
	escalated: boolean;
	promptVersion: string;
	at: string;
	chars: number;
}

/** A survivor, indexed and searchable. */
export interface Doc {
	id: string;
	nr: string;
	court: string;
	tier: Tier;
	menetlus: Menetlus;
	date: string;
	year: number;
	categories: string[];
	/** Statute citations extracted from the decision text, e.g. "AvTS § 35; IKÜM art 15". */
	norms?: string;
	/** Classifier confidence that this is a data-protection decision. */
	confidence: number;
	/** One-line Estonian reason from the classifier — doubles as a listing summary. */
	summary: string;
	pages?: number;
	url: string;
}

export interface Chunk {
	docId: string;
	section: string;
	text: string;
}
