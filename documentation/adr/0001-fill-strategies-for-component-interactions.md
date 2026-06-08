# ADR 0001: Fill-Strategien als zentrales Pattern für Komponenten-Interaktionen

**Status:** Accepted

**Date:** 2026-05-19

---

## Problem

Die Testgenerierung aus XML-Szenarien muss verschiedenste UI-Komponenten mit unterschiedlichen Interaktionsmustern handhaben können:

- Standard-Eingabefelder (Text, Number)
- Quasar-Komponenten (q-field, q-select, q-editor, etc.)
- Komplexe, App-spezifische Komponenten (contenteditable-Editor mit besonderen Verhaltensweisen)
- Zukünftige Komponenten, deren Verhalten sich unterscheidet

Ohne ein strukturiertes Pattern führt dies zu:
- Duplizierten/verstreuten Interaktionslogiken
- Schwierigkeiten, neue Komponenten zu unterstützen
- Vermischung von Generator-Logik mit App-spezifischem Code

---

## Entscheidung

**Alle Komponenten-Interaktionen (fill, select, etc.) werden ausschließlich über Fill-Strategien abgewickelt.**

Diese Entscheidung gilt explizit für den **Testscript-Generator**. Der Video-Script-Generator konsumiert erzeugte Test-/Timeline-Artefakte, entscheidet aber nicht selbst über UI-Interaktionsstrategien.

Eine Fill-Strategie ist ein Objekt mit der Struktur:

```javascript
{
  name: 'strategie-name',
  async match({ testId, isSelect, elementInfo }) {
    // true, wenn diese Strategie für das Element zuständig ist
    return /* condition */
  },
  async run({ page, locator, expectedValue }) {
    // Führe die Interaktion aus
    return { handled: true }
  }
}
```

### Schichtenmodell

**1. Zentrale Strategien (`scripts/test-script-generator/central-fill-strategies.mjs`)**

Standard-Komponenten und generische Quasar-Komponenten, die nicht App-spezifisch sind:
- `quasar-native-input`: Standard `q-field` mit Text/Number Input
- `quasar-select`: Standard Quasar `q-select`-Komponente
- `generic-input`: HTML `<input>`, `<textarea>`
- `generic-contenteditable`: Standard contenteditable-Elemente (ohne spezielle Behavior)

Diese Strategien sind **wartbar**, **dokumentiert** und **versioniert** mit dem Testscript-Generator.

**2. App-spezifische Strategien (`<app>/env/fill-strategies.mjs`)**

App-Eigene Komponenten oder Quasar-Komponenten mit spezialisiertem Behavior:
- `idee-description-editor-contenteditable`: Lunettes-eigenes contenteditable-Element mit besonderen Dispatch-Anforderungen
- `app-spezifische-komponente`: Jedes App-eigene Verhalten

Diese Strategien werden vom Testscript-Generator **zur Laufzeit geladen** und haben Vorrang vor zentralen Strategien.

### Laden und Fallback

Der Testscript-Generator ([scripts/test-script-generator/templates/spec-template.mjs](../../scripts/test-script-generator/templates/spec-template.mjs)) lädt Strategien in dieser Reihenfolge:

1. **App-spezifische Strategien** (aus `<app>/env/fill-strategies.mjs`)
2. **Zentrale Strategien** (aus `scripts/test-script-generator/central-fill-strategies.mjs`)
3. **Fehler mit klarer Anleitung**, falls keine Strategie matched

---

## Konsequenzen

### ✅ Vorteile

- **Klare Separation of Concerns**: Testscript-Generator behandelt alle Komponenten einheitlich
- **Erweiterbar**: Neue Komponenten erfordern nur neue Strategien, nicht Testscript-Generator-Änderungen
- **Wartbar**: Quasar-Upgrades → zentrale Strategien anpassen, nicht überall
- **Testbar**: Jede Strategie kann isoliert getestet werden
- **Dokumentiert**: Jede Strategie erklärt ihr Verhalten und Match-Kriterien
- **App-agnostisch**: Testscript-Generator bleibt unabhängig von konkreten Apps

### ⚠️ Nachteile

- Strategien müssen sorgfältig im `match()`-Kriterium spezifiziert werden
- Fehlerhafte Match-Kriterien führen zu Laufzeit-Fehlern statt Early Detection
- Performance: `match()`-Funktionen werden sequenziell für jedes Element aufgerufen

---

## Implementierung

### Zentrale Strategien-Vorlage

```javascript
// scripts/test-script-generator/central-fill-strategies.mjs
export const centralFillStrategies = [
  {
    name: 'quasar-native-input',
    async match({ testId, isSelect, elementInfo }) {
      if (isSelect) return false
      const className = String(elementInfo?.className || '')
      return className.includes('q-field__native')
    },
    async run({ page, locator, expectedValue }) {
      if (!expectedValue) return { handled: false }
      await locator.click()
      await locator.selectAll()
      await locator.type(expectedValue, { delay: 40 })
      await page.keyboard.press('Tab')
      return { handled: true }
    }
  },
  // weitere zentrale Strategien...
]
```

### App-spezifische Strategien-Vorlage

```javascript
// lunettes/env/fill-strategies.mjs
export const fillStrategies = [
  {
    name: 'idee-description-editor-contenteditable',
    async match({ testId, elementInfo }) {
      return testId === 'idee-view-description-editor-input' && elementInfo?.contentEditable === 'true'
    },
    async run({ page, locator, expectedValue }) {
      // spezialisierte Implementierung
    }
  },
  // weitere App-spezifische Strategien...
]
```

---

## Alternativen (abgelehnt)

1. **Fallback auf Playwright's `fill()`-Methode**
   - Funktioniert für einfache Inputs, scheitert bei Model-Value-getriebenen Komponenten
   - Keine Möglichkeit für Framework-spezifische Events

2. **Konditionalelogik im Generator**
   - if-Ketten für jede Komponente im Generator-Template
   - Wird schnell unlesbar und wartbar
   - Bindet Generator an App-spezifisches Wissen

3. **Generische `elementInfo`-Analyse**
   - Z.B. "wenn `role=combobox`, dann select-ähnlich"
   - Zu grob: verschiedene Komponenten mit gleichem Role brauchen unterschiedliche Interaktionen

---

## Siehe auch

- [spec-template.mjs](../../scripts/test-script-generator/templates/spec-template.mjs) — Generator-Logik für Strategie-Laden
- [fill-strategies.mjs](../../lunettes/env/fill-strategies.mjs) — Beispiel App-spezifische Strategien
- [generate-tests-from-scenario-xml.mjs](../../scripts/test-script-generator/generate-tests-from-scenario-xml.mjs) — Strategie-Pfad-Auflösung
