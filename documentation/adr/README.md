# Architecture Decision Records (ADR)

Dieses Verzeichnis dokumentiert wichtige Architektur-Entscheidungen für das Lumiere Test-Generator-Projekt.

## Format

Jede ADR folgt der [ADR-Template](https://github.com/joelparkerhenderson/architecture_decision_record):

- **Status**: Proposed, Accepted, Deprecated, Superseded
- **Date**: Datum der Entscheidung
- **Context**: Das Problem oder die Situation
- **Decision**: Was wurde entschieden?
- **Consequences**: Positive und negative Auswirkungen
- **Alternatives**: Was wurde in Betracht gezogen?

## Current ADRs

### [ADR 0001: Fill-Strategien als zentrales Pattern für Komponenten-Interaktionen](./0001-fill-strategies-for-component-interactions.md)

**Status**: Accepted

**Summary**: Alle UI-Komponenten-Interaktionen (fill, select, etc.) werden über ein plugin-basiertes Fill-Strategy-Pattern abgewickelt. Dies ermöglicht es dem Generator, app-agnostisch zu bleiben, während app-spezifische Verhalten über env-spezifische Strategien injiziert werden.

**Key Points**:
- Zentrale Strategien für Standard-Quasar-Komponenten
- App-spezifische Strategien für Custom-Komponenten
- Zur Laufzeit geladen, App-Strategien haben Vorrang
- Klares Fehler-Feedback bei fehlender Strategie

**Related Files**:
- [scripts/generator/central-fill-strategies.mjs](../scripts/generator/central-fill-strategies.mjs) — zentrale Quasar-Strategien
- [lunettes/env/fill-strategies.mjs](../lunettes/env/fill-strategies.mjs) — Beispiel: app-spezifische Strategien
- [scripts/generator/templates/spec-template.mjs](../scripts/generator/templates/spec-template.mjs) — Generator nutzt Strategien

---

## Neue ADR hinzufügen

1. Neue Datei erstellen: `000X-titel-mit-bindestrichen.md`
2. ADR-Template verwenden (siehe [ADR 0001](./0001-fill-strategies-for-component-interactions.md))
3. Dieses README aktualisieren
4. Im Projekt diskutieren und akzeptieren lassen

