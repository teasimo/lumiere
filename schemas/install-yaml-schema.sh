#!/usr/bin/env bash
# Installiert die YAML Language Support Extension von Red Hat in der lokalen VS Code Instanz.
# Anschließend ist das Schema für alle YAML-Testdateien im Repo aktiv.

set -e

EXTENSION_ID="redhat.vscode-yaml"

if ! command -v code &>/dev/null; then
  echo "FEHLER: 'code' nicht im PATH gefunden."
  echo "Starte VS Code einmal manuell und aktiviere 'Shell Command: Install code command in PATH' (Befehlspalette)."
  exit 1
fi

if code --list-extensions | grep -q "^${EXTENSION_ID}$"; then
  echo "Extension '${EXTENSION_ID}' ist bereits installiert."
else
  echo "Installiere '${EXTENSION_ID}' ..."
  code --install-extension "${EXTENSION_ID}"
  echo "Fertig. Bitte VS Code neu starten oder das Fenster neu laden (Ctrl+Shift+P → 'Reload Window')."
fi

echo ""
echo "Die Schema-Bindung ist über .vscode/settings.json bereits konfiguriert."
echo "Alle YAML-Dateien unter neo/tests/ und lunettes/tests/ werden automatisch validiert."
