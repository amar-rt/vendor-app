#!/bin/sh
set -e

# RDS's auto-managed master password comes back as separate
# username/password secrets (that's the only way AWS's native
# secret-injection mechanisms work — none of them can interpolate
# multiple values into one connection string). If DATABASE_URL wasn't
# passed directly (the Neon and EC2-manual-assembly paths both do pass it
# directly, so this is a no-op for them), assemble it here from the
# decomposed pieces instead.
if [ -z "$DATABASE_URL" ] && [ -n "$DB_HOST" ]; then
  export DATABASE_URL="postgresql://${DB_USERNAME}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT:-5432}/${DB_NAME}?sslmode=require"
fi

exec "$@"
