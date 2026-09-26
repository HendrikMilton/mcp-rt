#!/usr/bin/env bash
# Daily court-index rebuild until it completes; each run gets as far as Bedrock's per-day embedding
# cap allows, and cached batches make the next run resume. Writes data/index-v2.done on success.
set -u
export PATH="/home/hendrik/.local/bin:/home/hendrik/.nvm/versions/node/v24.14.1/bin:$PATH"
cd /home/hendrik/Documents/hy-capital/mcp-rt || exit 1
[ -e data/index-v2.done ] && exit 0
{
	echo "=== $(date -Is) index run start, $(ls data/embed-cache | wc -l) cached batches"
	AWS_PROFILE=hycapital flock -n /tmp/mcp-rt-index.lock timeout 3h yarn -s ingest --index-only
	rc=$?
	[ "$rc" -eq 0 ] && touch data/index-v2.done
	echo "=== $(date -Is) index run end rc=$rc, $(ls data/embed-cache | wc -l) cached batches"
} >> data/index.log 2>&1
