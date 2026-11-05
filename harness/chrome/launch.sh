#!/usr/bin/env bash
# Launch Google Chrome as the dedicated agent profile with NetLog recording.
#
#   harness/chrome/launch.sh <session-name>
#
# First run: install Claude in Chrome from the Web Store in this profile, sign in to
# claude.ai, grant it site access for the target systems only, and load OnlyRead via
# chrome://extensions → Developer mode → Load unpacked → <repo>/extension.
# Chrome 137+ ignores --load-extension, so that step is manual once per profile.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="${1:-session-$(date +%Y%m%d-%H%M%S)}"
PROFILE="${ONLYREAD_PROFILE:-$HOME/.onlyread-agent-profile}"
SESSION="$ROOT/sessions/$NAME"
mkdir -p "$SESSION" "$PROFILE"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
echo "profile: $PROFILE"
echo "netlog:  $SESSION/netlog.json"
echo "when done: quit Chrome cleanly, then"
echo "  python3 harness/site/sink_dump.py sessions/$NAME --domains <target domains>"
echo "  python3 harness/site/netlog.py sessions/$NAME/netlog.json"
echo "  python3 harness/site/label.py sessions/$NAME --labels apps/fixture/labels.jsonl"
echo "  python3 harness/site/compare.py sessions/$NAME --labels apps/fixture/labels.jsonl"
exec "$CHROME" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --silent-debugger-extension-api \
  --log-net-log="$SESSION/netlog.json" \
  --net-log-capture-mode=Default \
  "${@:2}"
