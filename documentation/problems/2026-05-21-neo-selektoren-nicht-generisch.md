# Problembericht: Neo-Tests mit nicht-generischer Komponentenansteuerung

Datum: 2026-05-21
Bereich: neo/tests

## Problem
In den Neo-Tests sind einige Komponenten nicht stabil/generisch per technischer ID ansteuerbar. Stattdessen werden sichtbare Texte oder textbasierte Labels verwendet. Besonders kritisch sind Selektoren, die konkrete fachliche Namen (z. B. Schuelername) enthalten muessen.

## Befund

### 1. Kritisch: Namensabhaengige Selektoren (nicht generisch)
Komponente: Schuelerauswahl in Mehrfachauswahl

- Datei: neo/tests/sus/aufforderungsschreiben-create.yaml:80
  - aria-label: "{{schueler.nachname}}, {{schueler.vorname}} markieren"
- Datei: neo/tests/sus/aufforderungsschreiben-create.yaml:85
  - expected_results target aria-label: "{{schueler.nachname}}, {{schueler.vorname}} markieren"

Bewertung:
- Direkt von konkreten Personenstammdaten abhaengig.
- Erhoeht Fragilitaet bei UI-Textaenderungen, Formatierungsunterschieden und Lokalisierung.

### 2. Relevant: Textbasierte statt ID-basierte Ansteuerung

Komponente: Aktionsmenueeintrag
- Datei: neo/tests/sus/aufforderungsschreiben-create.yaml:101
  - text: "Aufforderung zur Schulanmeldung (Nur Verknuepfungscode)"

Komponente: Dialog-Buttons
- Datei: neo/tests/sus/aufforderungsschreiben-create.yaml:107
  - text: "Ja"
- Datei: neo/tests/sus/sps/verknuepfen.yaml:87
  - text: "OK"

Komponente: Filterfeld
- Datei: neo/tests/login.yaml:77
  - text: "Schnellfilter"

Komponente: Mehrfachauswahl-Trigger
- Datei: neo/tests/sus/aufforderungsschreiben-create.yaml:63
  - aria-label: "Mehrfachauswahl"

Bewertung:
- Nicht namensabhaengig, aber weiterhin an sichtbaren Text gekoppelt.
- Potenziell instabil bei Label-/Wording-Aenderungen.

## Zusammenfassung
- Hauptproblem ist die namensabhaengige Schuelermarkierung in der Mehrfachauswahl.
- Darueber hinaus existieren mehrere textgebundene Interaktionen (Menueeintrag, Dialogbuttons, Filter), die nicht ueber generische data-id erfolgen.
- Grossteil der Neo-Tests ist bereits gut per data-id strukturiert; die genannten Stellen sind Ausnahmen mit erhoehtem Wartungsrisiko.

## Empfehlung
- Fuer Schuelerauswahl und Menue-/Dialogaktionen stabile technische Selektoren (bevorzugt data-id) bereitstellen.
- Text-/Label-basierte Selektoren nur als Fallback verwenden.
- Bestehende fragliche Schritte schrittweise auf technische IDs umstellen.
