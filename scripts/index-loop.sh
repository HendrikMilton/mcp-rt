#!/usr/bin/env bash
# Retry the court-index rebuild every 30 min until it completes. Bedrock's embedding cap refills
# gradually, and cached batches mean each attempt resumes where the last one stopped.
cd /home/hendrik/Documents/hy-capital/mcp-rt || exit 1
exec 8>/tmp/mcp-rt-index-loop.lock
flock -n 8 || exit 0
until [ -e data/index-v2.done ]; do
	scripts/daily-index.sh
	[ -e data/index-v2.done ] || sleep 1800
done
