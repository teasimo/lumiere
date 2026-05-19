import { expect } from '@playwright/test'
const byTestId = (pageOrLocator, testId) => pageOrLocator.getByTestId(testId)

const requirementViewerTestIds = {
  plainTextEditor: 'anforderungsviewer-plaintext-editor',
  plainTextEditorContent: 'anforderungsviewer-plaintext-editor-content',
}

export async function expectPlaintextLineNumberMarkerForLine(page, _editorContent, {
  lineSubstring,
  expectedMarker,
  timeout = 10000,
}) {
  const editor = byTestId(page, requirementViewerTestIds.plainTextEditor)
  const editorContent = byTestId(page, requirementViewerTestIds.plainTextEditorContent)

  await expect(editorContent).toContainText(lineSubstring, { timeout })

  await expect.poll(async () => {
    return editor.evaluate((editorNode, {
      targetLineSubstring,
      marker,
    }) => {
      if (!editorNode) return '__no_editor__'

      const lineNodes = Array.from(editorNode.querySelectorAll('.cm-content .cm-line'))
      const targetLine = lineNodes.find((line) => String(line.textContent || '')
        .includes(targetLineSubstring))
      if (!targetLine) return '__line_not_found__'

      targetLine.scrollIntoView({
        block: 'center',
        inline: 'nearest',
      })

      const markerNodes = Array.from(editorNode.querySelectorAll(
        '.cm-lineNumbers .cm-gutterElement .cm-pt-line-number',
      ))
      if (!markerNodes.length) return '__no_marker_nodes__'

      const targetRect = targetLine.getBoundingClientRect()
      const targetY = targetRect.top + (targetRect.height / 2)

      let bestMarker = null
      let bestDistance = Number.POSITIVE_INFINITY

      markerNodes.forEach((node) => {
        const rect = node.getBoundingClientRect()
        const y = rect.top + (rect.height / 2)
        const distance = Math.abs(y - targetY)
        if (distance < bestDistance) {
          bestDistance = distance
          bestMarker = node
        }
      })

      if (!bestMarker) return '__marker_not_found__'

      const markerText = String(bestMarker.textContent || '').trim()
      const className = String(bestMarker.className || '')
      const hasPlusClass = className.includes('is-plus')
      const hasMinusClass = className.includes('is-minus')
      const hasPlannedMoveClass = className.includes('is-planned-move') || className
        .includes('is-move-in') || className.includes('is-move-out')

      if (marker === '+' && (markerText.includes('+') || hasPlusClass)) return '__ok__'
      if (marker === '-' && (markerText.includes('-') || hasMinusClass)) return '__ok__'
        const isMoveMarker = marker === 'move' || marker === '!'
        if (isMoveMarker && (markerText.includes('⇓') || markerText.includes('⇑') ||
          hasPlannedMoveClass)) return '__ok__'

      return `__marker_mismatch__:text=${markerText};class=${className};distance=${bestDistance}`
    }, {
      targetLineSubstring: lineSubstring,
      marker: expectedMarker,
    })
  }, {
    timeout,
  }).toBe('__ok__')
}
