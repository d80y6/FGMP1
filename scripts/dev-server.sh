#!/bin/bash
cd /home/ubuntu/FGMP1
set -a
source .env
set +a
export DATABASE_URL="postgresql://fgmp_app:testapp123@127.0.0.1:5433/fgmp?schema=public"
export FGMP_MIGRATE_DATABASE_URL="postgresql://fgmp_migrate:testmigrate123@127.0.0.1:5433/fgmp?schema=public"
export FGMP_OPS_DATABASE_URL="postgresql://fgmp_ops:testops123@127.0.0.1:5433/fgmp?schema=public"
export NEXTAUTH_SECRET="seedtest-secret-abcdefghijklmnopqrstuvwxyz0123"
export PORT=3210
export HOSTNAME=127.0.0.1
exec bun run start
