/**
 * Where the resumable working set lives.
 *
 * Locally that is `data/` in the repo, which is what makes a rerun free. In Lambda the bundle is
 * read-only and only /tmp is writable, so the same files land there — and because /tmp does not
 * survive between invocations, the Lambda path treats S3 as the real store and /tmp as a scratch
 * cache. See src/ingest/build.ts for how the monthly run stays incremental on top of that.
 */
import {mkdirSync} from 'fs';
import {join} from 'path';

export const IN_LAMBDA = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

export const DATA = process.env.DATA_DIR ?? (IN_LAMBDA ? '/tmp/rt' : join(__dirname, '../../data'));

export const ensureData = (): void => {
	mkdirSync(join(DATA, 'text'), {recursive: true});
	mkdirSync(join(DATA, 'pdf'), {recursive: true});
};
