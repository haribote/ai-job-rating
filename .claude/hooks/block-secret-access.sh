#!/usr/bin/env bash
# PreToolUse hook: 秘匿ファイルへの読み書きを拒否する。
# Read/Edit/Write の file_path と Bash の command が対象。.dev.vars* と .env 系を検出し、*.example 雛形は許可。
set -euo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
target="$file $cmd"

# *.example 雛形は誤検出を避けるため除去する
scrubbed=$(printf '%s' "$target" | sed -E 's/\.(dev\.vars|env)\.example//g')

# .dev.vars（任意サフィックス）と .env / .env.<variant>
secret_re='\.dev\.vars|(^|[^[:alnum:]_.])\.env(\.[[:alnum:]_-]+)?([^[:alnum:]_-]|$)'

if printf '%s' "$scrubbed" | grep -Eq "$secret_re"; then
  reason="Secret files (.dev.vars / .env) are off-limits by project policy. Use the .example template or wrangler secrets."
  jq -n --arg r "$reason" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
fi

exit 0
