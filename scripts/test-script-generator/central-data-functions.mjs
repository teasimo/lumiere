/**
 * Central Data Functions for Template Resolution
 *
 * These functions are available in all templates via {{functionName()}} syntax.
 * Examples: {{randomNumber()}}, {{uuid()}}, {{timestamp()}}
 *
 * For app-specific functions, see <app>/env/data-functions.mjs
 */

function padDatePart(value) {
  return String(value).padStart(2, '0')
}

function formatGermanDate(date) {
  return `${padDatePart(date.getDate())}.${padDatePart(date.getMonth() + 1)}.${date.getFullYear()}`
}

function createLocalDate() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function shiftDays(baseDate, amount) {
  const nextDate = new Date(baseDate)
  nextDate.setDate(nextDate.getDate() + amount)
  return nextDate
}

function shiftMonths(baseDate, amount) {
  const year = baseDate.getFullYear()
  const month = baseDate.getMonth()
  const day = baseDate.getDate()
  const targetMonthDate = new Date(year, month + amount, 1)
  const lastDayOfTargetMonth = new Date(targetMonthDate.getFullYear(), targetMonthDate.getMonth() + 1, 0).getDate()
  targetMonthDate.setDate(Math.min(day, lastDayOfTargetMonth))
  return targetMonthDate
}

function shiftYears(baseDate, amount) {
  return shiftMonths(baseDate, amount * 12)
}

function normalizeDateOffsetAmount(value, functionName) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    throw new Error(`${functionName} expects an integer amount.`)
  }
  return amount
}

export const centralDataFunctions = {
  /**
   * Generate a random integer between 0 and 999999
   */
  randomNumber() {
    return Math.floor(Math.random() * 1000000)
  },

  /**
   * Generate a UUID v4
   */
  uuid() {
    // Simple UUID v4 implementation for environments without crypto.randomUUID
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  },

  /**
   * Get current ISO timestamp
   */
  timestamp() {
    return new Date().toISOString()
  },

  /**
   * Get current date in YYYY-MM-DD format
   */
  dateToday() {
    return new Date().toISOString().split('T')[0]
  },

  heute() {
    return formatGermanDate(createLocalDate())
  },

  gestern() {
    return formatGermanDate(shiftDays(createLocalDate(), -1))
  },

  morgen() {
    return formatGermanDate(shiftDays(createLocalDate(), 1))
  },

  naechsteWoche() {
    return formatGermanDate(shiftDays(createLocalDate(), 7))
  },

  inXTagen(amount) {
    return formatGermanDate(shiftDays(createLocalDate(), normalizeDateOffsetAmount(amount, 'inXTagen')))
  },

  inXMonaten(amount) {
    return formatGermanDate(shiftMonths(createLocalDate(), normalizeDateOffsetAmount(amount, 'inXMonaten')))
  },

  inXJahren(amount) {
    return formatGermanDate(shiftYears(createLocalDate(), normalizeDateOffsetAmount(amount, 'inXJahren')))
  },

  naechstenMonat() {
    return formatGermanDate(shiftMonths(createLocalDate(), 1))
  },

  naechstesJahr() {
    return formatGermanDate(shiftYears(createLocalDate(), 1))
  },

  letzteWoche() {
    return formatGermanDate(shiftDays(createLocalDate(), -7))
  },

  vorXTagen(amount) {
    return formatGermanDate(shiftDays(createLocalDate(), -normalizeDateOffsetAmount(amount, 'vorXTagen')))
  },

  vorXMonaten(amount) {
    return formatGermanDate(shiftMonths(createLocalDate(), -normalizeDateOffsetAmount(amount, 'vorXMonaten')))
  },

  vorXJahren(amount) {
    return formatGermanDate(shiftYears(createLocalDate(), -normalizeDateOffsetAmount(amount, 'vorXJahren')))
  },

  letztenMonat() {
    return formatGermanDate(shiftMonths(createLocalDate(), -1))
  },

  letztesJahr() {
    return formatGermanDate(shiftYears(createLocalDate(), -1))
  },

  /**
   * Generate a slug from a string (or random if not called with string arg)
   */
  slug(text) {
    return String(text || `slug-${Math.random().toString(36).substring(7)}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  },
}
