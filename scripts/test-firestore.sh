#!/bin/sh
set -eu

if [ -z "${JAVA_HOME:-}" ] && command -v brew >/dev/null 2>&1; then
  for formula in openjdk@21 openjdk@17 openjdk; do
    prefix="$(brew --prefix "$formula" 2>/dev/null || true)"
    candidate="$prefix/libexec/openjdk.jdk/Contents/Home"
    if [ -x "$candidate/bin/java" ]; then
      JAVA_HOME="$candidate"
      break
    fi
  done
fi

if [ -n "${JAVA_HOME:-}" ]; then
  export JAVA_HOME
  export PATH="$JAVA_HOME/bin:$PATH"
fi

exec firebase emulators:exec --only firestore --project voxprotocol-emulator "npm run test:firestore:run"
