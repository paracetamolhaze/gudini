#!/bin/sh
set -eu
export DISPLAY=:99
# A docker restart keeps /tmp but kills the previous X server.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
# This container is the sole owner of the profile. Recreating it changes the hostname, and Chromium
# would otherwise treat the stopped container's locks as live.
rm -f /app/data/x-browser/profile/SingletonLock /app/data/x-browser/profile/SingletonCookie /app/data/x-browser/profile/SingletonSocket
Xvfb "$DISPLAY" -screen 0 1280x900x24 -nolisten tcp &
display_pid=$!
attempt=0
while [ ! -S /tmp/.X11-unix/X99 ]; do
  kill -0 "$display_pid" 2>/dev/null || exit 1
  attempt=$((attempt + 1))
  [ "$attempt" -lt 100 ] || exit 1
  sleep 0.1
done
exec "$@"
