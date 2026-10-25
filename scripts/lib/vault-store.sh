#!/usr/bin/env bash
# Shared helpers for the maintainer-only credential scripts (sourced, not executed).
# The agent that builds this repository never runs these scripts and never sees a secret value.
set -euo pipefail

die() { # die <exit-code> <message>
  printf '%s\n' "$2" >&2
  exit "$1"
}

refuse_in_ci() {
  if [ "${CI:-}" = "true" ]; then
    die 2 "$0 is maintainer-only: it handles a credential and never runs in CI"
  fi
}

# parse_args "$@" sets DRY_RUN and handles --help (calls the caller's usage function).
parse_args() {
  DRY_RUN=0
  local arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die 2 "unknown argument: $arg (try --help)" ;;
    esac
  done
}

# read_secret <prompt> sets SECRET_VALUE: hidden from the terminal, or one line from stdin when piped.
# More than one line is an error. The value is never printed.
read_secret() {
  SECRET_VALUE=""
  local extra=""
  if [ -t 0 ]; then
    printf '%s' "$1" >&2
    IFS= read -rs SECRET_VALUE || true
    printf '\n' >&2
  else
    IFS= read -r SECRET_VALUE || true
    if IFS= read -r extra; then
      die 2 "expected exactly one line of input"
    fi
  fi
}

# store_secret <vault> <secret-name> <origin>
# Sends SECRET_VALUE to `exo vault secret create` on stdin (never in argv or the environment), bound
# to <origin>. The flags used here are not verified against the pinned Exo yet (verification item
# V-14), so the command's help is checked first and a mismatch aborts before the value is sent.
store_secret() {
  local vault="$1" secret="$2" origin="$3"
  local exo_bin="${EXOS_EXO_BIN:-exo}"
  local root="${EXOS_EXO_ROOT:-${EXOS_STATE_DIR:-.exos-state}/exo}"

  if [ "$DRY_RUN" = "1" ]; then
    printf 'would run: %s --root %s vault secret create %s %s --origin %s\n' \
      "$exo_bin" "$root" "$vault" "$secret" "$origin"
    printf '(the value is read from standard input and is never put on the command line)\n'
    return 0
  fi

  local help
  if ! help="$("$exo_bin" vault secret create --help 2>&1)"; then
    die 1 "'$exo_bin vault secret create' is not available; check the pinned Exo (V-14). Nothing was stored."
  fi
  case "$help" in
    *--origin*) ;;
    *) die 1 "expected the flag --origin in '$exo_bin vault secret create --help'; this script's assumptions (V-14) need updating. Nothing was stored." ;;
  esac

  if ! printf '%s' "$SECRET_VALUE" | "$exo_bin" --root "$root" vault secret create "$vault" "$secret" --origin "$origin"; then
    die 1 "exo failed to store the secret; see its message above. The value was not printed."
  fi
  printf 'stored %s in vault %s (origin %s)\n' "$secret" "$vault" "$origin"
}
