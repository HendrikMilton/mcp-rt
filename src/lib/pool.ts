/** Run `worker` over every item with at most `concurrency` in flight, preserving input order. */
export const mapPool = async <T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from({length: Math.min(concurrency, items.length)}, async () => {
		for (let i = next++; i < items.length; i = next++) {
			results[i] = await worker(items[i], i);
		}
	});
	await Promise.all(runners);
	return results;
};
