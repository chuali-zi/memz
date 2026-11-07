#!/bin/sh
# Create one private, uniquely named backup. Never migrate or overwrite a backup.
fail() {
  printf '%s\n' 'Backup was not created; no migrations were run. Existing backups were preserved.' >&2
  exit 1
}

[ "$#" -eq 0 ] || fail
memz_backup_root=$(CDPATH= cd "$(dirname "$0")/.." 2>/dev/null && pwd -P) || fail
memz_backup_cwd=$(pwd -P) || fail
[ "$memz_backup_cwd" = "$memz_backup_root" ] || fail
[ -f compose.yml ] && [ -f db/schema.sql ] &&
  [ -f db/migrations/001-current-revision-integrity.sql ] &&
  [ -f db/migrations/002-create-idempotency.sql ] || fail

umask 077
mkdir -p backups 2>/dev/null || fail
memz_backup_work=$(mktemp -d "$memz_backup_root/backups/before-001.XXXXXXXXXX" 2>/dev/null) || fail
memz_backup_file=$memz_backup_work/memz.dump
cleanup() {
  # Only these two paths belong to this invocation. Never recursively remove.
  rm -f "$memz_backup_file" 2>/dev/null || :
  rmdir "$memz_backup_work" 2>/dev/null || :
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

docker compose exec -T db pg_dump -U postgres -d memz -Fc > "$memz_backup_file" 2>/dev/null || fail
[ -s "$memz_backup_file" ] || fail
printf '%s\n' "$memz_backup_file" || fail
trap - 0 HUP INT TERM
