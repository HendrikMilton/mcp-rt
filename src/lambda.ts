/**
 * Ingest entrypoint. This function has no HTTP surface — the MCP endpoint that serves this corpus
 * is the one deployed for AKI, which reads the index from S3 and never writes it.
 */
export const handler = async (): Promise<{statusCode: number; body: string}> => {
	const {runIngest} = await import('./ingest/build');
	const report = await runIngest({fresh: true});
	return {statusCode: 200, body: JSON.stringify(report)};
};
