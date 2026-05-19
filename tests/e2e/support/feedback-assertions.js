import { expect } from '@playwright/test'

function getNotificationProbe(page) {
  return page.getByTestId('app-notification-probe')
}

async function readFeedbackSeq(probe) {
  return Number((await probe.getAttribute('data-feedback-seq')) || '0')
}

export async function runActionAndExpectFeedback(page, action, options = {}) {
  const {
    kind,
    message,
    timeout = 10_000,
  } = options

  const probe = getNotificationProbe(page)
  const beforeSeq = await readFeedbackSeq(probe)

  await action()

  await expect.poll(async () => readFeedbackSeq(probe), { timeout })
    .toBeGreaterThan(beforeSeq)

  if (kind) {
    await expect(probe).toHaveAttribute('data-feedback-kind', kind)
  }

  if (message) {
    await expect(probe).toHaveAttribute('data-feedback-message', message)
  }

  return { probe, beforeSeq }
}
