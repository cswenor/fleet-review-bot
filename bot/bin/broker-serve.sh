#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || -z "${OMP_AUTH_BROKER_TOKEN:-}" || "$OMP_AUTH_BROKER_TOKEN" == *[[:space:]]* ]]; then
  printf '%s\n' 'Broker boot requires a bind address and a non-empty bearer token without whitespace.' >&2
  exit 1
fi

umask 077
mkdir -p -m 0700 -- "$HOME/.omp"
chmod 0700 "$HOME/.omp"
token_file="$(mktemp "$HOME/.omp/.auth-broker.token.XXXXXX")"
trap 'rm -f -- "$token_file"' EXIT
printf '%s' "$OMP_AUTH_BROKER_TOKEN" > "$token_file"
chmod 0600 "$token_file"
mv -f -- "$token_file" "$HOME/.omp/auth-broker.token"
unset OMP_AUTH_BROKER_TOKEN
exec omp auth-broker serve --bind "$1"
