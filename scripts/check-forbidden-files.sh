#!/usr/bin/env bash
# Block files that are dangerous by TYPE, which pattern-based scanners miss.
#
# gitleaks finds secrets that look like secrets (AWS keys, tokens, PEM blocks).
# It won't necessarily flag a Terraform state file, a .env, or a database dump —
# yet in a public repo those leak infrastructure detail, connection strings, and
# credentials just as effectively. This is the complementary check.
#
# Usage:
#   check-forbidden-files.sh staged   # the staged diff (pre-commit)
#   check-forbidden-files.sh tracked  # everything committed (CI)
set -euo pipefail

MODE="${1:-tracked}"

case "$MODE" in
  staged)  FILES=$(git diff --cached --name-only --diff-filter=ACMR) ;;
  tracked) FILES=$(git ls-files) ;;
  *) echo "usage: $0 [staged|tracked]" >&2; exit 2 ;;
esac

# Patterns are matched against the full path.
FORBIDDEN='(^|/)\.env$|(^|/)\.env\.[^/]*$|\.tfstate$|\.tfstate\.backup$|(^|/)terraform\.tfvars$|[^/]*\.auto\.tfvars$|\.pem$|\.p12$|\.pfx$|(^|/)id_(rsa|dsa|ecdsa|ed25519)$|(^|/)\.npmrc$|(^|/)\.pypirc$|(^|/)credentials$|\.kdbx$|\.sql\.gz$|\.dump$'
# Legitimate exceptions: sample/templated files that contain placeholders only.
ALLOWED='\.env\.example$|\.tfvars\.example$|\.env\.sample$'

HITS=""
for f in $FILES; do
  if echo "$f" | grep -qE "$FORBIDDEN" && ! echo "$f" | grep -qE "$ALLOWED"; then
    HITS="$HITS  $f\n"
  fi
done

if [ -n "$HITS" ]; then
  echo "✖ Refusing: these files must never be committed (this repo is public):" >&2
  printf "$HITS" >&2
  cat >&2 <<'EOF'
They commonly hold credentials, connection strings, or infrastructure state.
Fix: remove from the commit and add to .gitignore, e.g.
    git rm --cached <file>
If a file is genuinely a placeholder, name it *.example (e.g. .env.example).
EOF
  exit 1
fi

echo "✓ no forbidden file types ($MODE)"
