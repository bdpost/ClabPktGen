#!/bin/bash
set -e

# Static routes from env var: STATIC_ROUTES=prefix|nh|dev[,prefix|nh|dev,...]
if [[ -n "${STATIC_ROUTES}" ]]; then
  while IFS='|' read -r pfx nh dev; do
    ip route add "$pfx" via "$nh" dev "$dev" 2>/dev/null || true
  done < <(tr ',' '\n' <<< "$STATIC_ROUTES")
fi

/usr/sbin/sshd

exec uvicorn main:app --host 0.0.0.0 --port 8080 --app-dir /app
