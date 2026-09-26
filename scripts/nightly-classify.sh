#!/usr/bin/env bash
# Nightly rt-dp-v2 classification on the Claude subscription. Classifies until the session limit makes
# claude -p fail (classify.ts then aborts cleanly), waits for the window to reset, and goes again —
# never past $DEADLINE (default 08:45), so the working day starts with a fresh session.
set -u
export PATH="/home/hendrik/.local/bin:/home/hendrik/.nvm/versions/node/v24.14.1/bin:$PATH"
cd /home/hendrik/Documents/hy-capital/mcp-rt || exit 1
LOG=data/nightly.log
exec 9>/tmp/mcp-rt-nightly.lock
flock -n 9 || exit 0

end=$(date -d "today ${DEADLINE:-08:45}" +%s)
[ "$end" -le "$(date +%s)" ] && end=$(date -d "tomorrow ${DEADLINE:-08:45}" +%s)
rows() { grep -c '"rt-dp-v2"' data/classified.jsonl; }

{
	echo "=== $(date -Is) loop start, deadline $(date -d "@$end" -Is), $(rows) v2 rows"
	while [ "$(date +%s)" -lt "$end" ]; do
		left=$((end - $(date +%s)))
		CLS_BACKEND=claude-code CLS_CC_MODEL=sonnet CLASSIFY_CONCURRENCY=4 \
			flock -n /tmp/mcp-rt-classify.lock \
			timeout "$left" npx ts-node --compiler-options '{"module":"commonjs"}' src/ingest/classify.ts \
			> data/nightly-run.log 2>&1
		rc=$?
		if [ "$rc" -eq 0 ]; then echo "=== $(date -Is) classification complete, $(rows) v2 rows"; break; fi
		echo "=== $(date -Is) run ended rc=$rc, $(rows) v2 rows; retrying in 15 min"
		sleep 900
	done
	echo "=== $(date -Is) loop end, $(rows) v2 rows"
} >> "$LOG" 2>&1
