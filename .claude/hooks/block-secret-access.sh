#!/usr/bin/env bash
# PreToolUse hook: block Claude from reading or writing secret files.
# Covers Read / Edit / Write (file_path) and Bash (command).
# Secret patterns: .dev.vars* and .env / .env.* — but *.example templates are allowed.
set -euo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
target="$file $cmd"

# Strip allowed example templates so they never trigger the match.
scrubbed=$(printf '%s' "$target" | sed -E 's/\.(dev\.vars|env)\.example//g')

# .dev.vars (any suffix) — or .env as a path component / .env.<variant>.
secret_re='\.dev\.vars|(^|[^[:alnum:]_.])\.env(\.[[:alnum:]_-]+)?([^[:alnum:]_-]|$)'

if printf '%s' "$scrubbed" | grep -Eq "$secret_re"; then
  reason="Secret files (.dev.vars / .env) are off-limits by project policy. Use the .example template or wrangler secrets."
  jq -n --arg r "$reason" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
fi

exit 0
