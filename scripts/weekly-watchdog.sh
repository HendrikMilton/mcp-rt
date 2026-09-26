#!/usr/bin/env bash
# Every 5 min: read weekly plan usage from a one-word headless call; at >= WEEKLY_STOP (0.9) stop the
# classification loop so the week's remaining allowance stays with the user. Exits once it stops it.
set -u
export PATH="/home/hendrik/.local/bin:/home/hendrik/.nvm/versions/node/v24.14.1/bin:$PATH"
cd /home/hendrik/Documents/hy-capital/mcp-rt || exit 1
LOG=data/nightly.log
STOP=${WEEKLY_STOP:-0.9}
while pgrep -f '[n]ightly-classify.sh' >/dev/null; do
	u=$(cd /tmp && timeout 120 claude -p hi --model haiku --setting-sources '' --strict-mcp-config \
		--mcp-config '{"mcpServers":{}}' --output-format stream-json --verbose < /dev/null 2>/dev/null |
		python3 -c 'import sys,json
for l in sys.stdin:
    try: e=json.loads(l)
    except Exception: continue
    if e.get("type")=="rate_limit_event":
        print(e["rate_limit_info"].get("unifiedWindows",{}).get("seven_day",{}).get("utilization","")); break')
	if [ -n "$u" ] && python3 -c "import sys; sys.exit(0 if float('$u') >= $STOP else 1)"; then
		echo "=== $(date -Is) weekly usage $u >= $STOP, stopping classification" >> "$LOG"
		pkill -f '[n]ightly-classify.sh'
		pkill -f 'ts-node.*src/ingest/classify.ts'
		pkill -f 'claude -p Allpool'
		exit 0
	fi
	sleep 300
done
