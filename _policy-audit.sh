#!/bin/bash
cd "$(dirname "$0")"
echo "=== PROVIDER POLICY ACCEPTANCE ==="
OR=$(grep -rln "openrouter\.ai\|openrouterKey" --include=*.ts lib/ | grep -viE "^lib/cover|^lib/store\.ts|^lib/pipeline\.ts" | wc -l)
echo "OpenRouter reachable callsites outside cover: $OR"
BR=$(grep -rln "api\.search\.brave\.com" --include=*.ts lib/ | grep -viE "^lib/(braveSearch|brollWeb)\.ts" | wc -l)
echo "Brave reachable callsites outside search:    $BR"
AC=$(grep -rn "new Anthropic(" --include=*.ts lib/ | grep -icE "cover" || true)
echo "Anthropic cover-generation callsites:        $AC"
FB=$(grep -rn "serper\|google\.serper" --include=*.ts lib/ | wc -l)
echo "automatic provider fallbacks:                $FB"
python - <<'PY'
import io,re
s=io.open("lib/mediaLlm.ts",encoding="utf-8").read()
g=s.find("assertProvider("); r=s.find("client.messages.create")
b=io.open("lib/braveSearch.ts",encoding="utf-8").read()
gb=b.find("assertProvider("); rb=b.find("await fetch(url")
c=io.open("lib/coverProvider.ts",encoding="utf-8").read()
gc=c.find("assertProvider("); rc=c.find('await fetch("https://openrouter.ai')
ok = 0<=g<r and 0<=gb<rb and 0<=gc<rc
print("provider-policy check occurs before HTTP request: " + ("YES" if ok else "NO"))
PY
echo
echo "=== единственный транспорт Anthropic ==="
grep -rn "new Anthropic(" --include=*.ts lib/
