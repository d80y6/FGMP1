#!/bin/bash
# FGMP — create the three database roles (Phase 1, step 8)
#
# Runs once, on first init of the fgmp-db volume. Docker's entrypoint executes
# every *.sh in /docker-entrypoint-initdb.d in alphabetical order, so this runs
# before any *.sql file (which would otherwise run against a half-built
# role setup).
#
# A .sql file cannot read environment variables — psql does not substitute
# :'vars' from the environment. Wrapping in shell is what makes
# PGAPP_PASSWORD / PGOPS_PASSWORD / PGMIGRATE_PASSWORD injectable.

set -euo pipefail

: "${PGAPP_PASSWORD:?PGAPP_PASSWORD must be set}"
: "${PGOPS_PASSWORD:?PGOPS_PASSWORD must be set}"
# POSTGRES_PASSWORD is the superuser (POSTGRES_USER = fgmp_migrate) credential
# that docker-compose already sets for the data directory. Reuse it as the
# migrate role's password rather than introducing a second name for one secret.
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     --set=app_password="$PGAPP_PASSWORD" \
     --set=ops_password="$PGOPS_PASSWORD" \
     --set=migrate_password="$POSTGRES_PASSWORD" \
     --file /opt/fgmp/pg-init-roles.sql

echo 'FGMP: database roles provisioned'
