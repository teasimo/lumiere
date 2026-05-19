## Scenario to Temp Testfile Framework

Dieses Repo enthaelt jetzt ein Node-basiertes Generator-Framework, das aus Szenario-YAML-Dateien temporaere Playwright-Testfiles erzeugt.

Zielbild:
- Konkrete, manuell gepflegte Testfiles werden perspektivisch ersetzt.
- Test-Ausfuehrung basiert auf YAML-Szenarien.
- Generierte Testfiles liegen nur temporaer unter `temp/testfiles` und koennen danach fuer die weitere Playwright-Auswertung genutzt werden.

### Voraussetzungen

- Node.js 20+ (siehe `.nvmrc`)

### Setup

```bash
npm install
```

### Einzelnes Szenario generieren

```bash
npm run generate:testfile -- lunettes/tests/login.yaml
```

Ergebnis:
- `temp/testfiles/login.spec.js`

### Alle Szenarien generieren

```bash
npm run generate:testfiles:all
```

Optional:

```bash
npm run generate:testfiles:all -- --scenario-dir lunettes/tests --out-dir temp/testfiles
```

### Generierte Testfiles bereinigen

```bash
npm run clean:testfiles
```

### Implementierung

- Generator: `scripts/generate-tests-from-scenario.mjs`
- Template-Snippets: `scripts/generator/templates/spec-template.mjs`
- Zentrale Runtime fuer generierte Specs (Timeline/Step-Timestamps): `tests/e2e/support/generated-scenario-runtime.js`
- YAML-Parser: npm-Paket `yaml`

### Szenario direkt ausfuehren (Generate + Run)

Es gibt einen kombinierten Node-Command, der anhand der YAML-Datei das passende Temp-Testfile ermittelt:

- Wenn das Temp-Testfile bereits existiert: direkt ausfuehren
- Wenn es fehlt: zuerst generieren, dann ausfuehren
- Mit `--force`: Temp-Testfile immer neu generieren und danach ausfuehren
- Wenn YAML neuer als das generierte Temp-Testfile ist: Warnung in der Konsole (kein automatischer Rebuild)

Beispiele:

```bash
# nutzt vorhandenes temp/testfiles/<name>.spec.js, falls vorhanden
npm run check:testfile -- lunettes/tests/login.yaml

# erzwingt Neugenerierung vor dem Lauf
npm run check:testfile:force -- lunettes/tests/login.yaml

# Playwright-Argumente durchreichen
npm run check:testfile -- lunettes/tests/login.yaml -- --project=chromium --headed

# Video-Modus: zeichnet Video auf und wartet zwischen Steps gemaess YAML
npm run run:testfile:video -- lunettes/tests/login.yaml
```

Technisch:

- Runner-Skript: `scripts/run-generated-testfile.mjs`
- npm Scripts: `check:testfile`, `check:testfile:force`, `run:testfile:video`, `run:testfile:video:force`
- Runner-Playwright-Config: `playwright.generated.config.mjs` (stellt sicher, dass `temp/testfiles/*.spec.js` gefunden werden)
- Video-Playwright-Config: `playwright.generated.video.config.mjs` (aktiviert Video-Artefakte)
- Build-Metadaten pro Temp-Spec: `temp/testfiles/<name>.spec.js.meta.json` (enthaelt u. a. den YAML-Timestamp beim Build)

Im Video-Modus wird zusaetzlich die in der YAML definierte Step-Wartezeit genutzt:

```yaml
video:
	wait_between_steps: 1000
```

Die Wartezeit wird jeweils nach dem erfolgreich abgeschlossenen Step (inklusive `expected_results`) angewendet.

### Zentrale Konfiguration (Fallback)

Wenn Parameter nicht ueber CLI oder YAML gesetzt sind, werden sie aus der zentralen Datei `scenario.config.yaml` gelesen.

Format:

```yaml
scenario:
	defaults:
		scenario_path: lunettes/tests/login.yaml
		scenario_dir: lunettes/tests
		output_dir: temp/testfiles

	video:
		wait_between_steps: 0
		resolution:
			width: 1280
			height: 720
```

Prioritaet:

- CLI-Parameter haben Vorrang.
- YAML-Szenariowerte (z. B. `interaction.video.resolution`) haben danach Vorrang.
- Zentrale Config ist der Fallback.

### Profilbasiertes TTS fuer Scenario-Video

Neuer Command (nimmt vorhandenes Test-Video oder erzeugt es bei Bedarf):

```bash
npm run generate:video:tts -- lunettes/tests/login.yaml --profile=training-basic
```

Optional:

```bash
# erzwingt neue Video-Erzeugung vor TTS-Mux
npm run generate:video:tts:force -- lunettes/tests/login.yaml --profile=training-basic

# optionale Voice-Override
npm run generate:video:tts -- lunettes/tests/login.yaml --profile=training-basic --tts-voice=de-DE-Neural2-B
```

Auswertung der zentralen TTS-Profile (`scenario.config.yaml`):

- `tts[].profile`: Profilname fuer `--profile`
- `tts[].channels`: welche Didactic-Kanaele vorgelesen werden (`enabled`) und mit welchem `prefix`
- `tts[].timing.before_step`: Kanaele, die vor einem Step platziert werden
- `tts[].timing.after_step`: Kanaele, die nach einem Step platziert werden
- `tts[].pauses.before_action_ms`: Offset vor Step-Start
- `tts[].pauses.after_action_ms`: Offset nach Step-Ende
- `tts[].pauses.between_channels_ms`: Abstand zwischen Kanaelen innerhalb der Sequenz

Wichtig:

- Es werden nur Kanaele gelesen, die im Profil genannt und aktiv sind.
- Die Position erfolgt anhand der Step-Marker aus `yaml-step-timeline.json`.
- Ist eine Audio-Sequenz laenger als ihr geplanter Bereich, wird das Video am Ende der jeweiligen Sequenz per Hold-Frame verlaengert.

