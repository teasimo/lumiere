/**
 * Central Data Functions for Template Resolution
 *
 * These functions are available in all YAML templates via {{functionName()}} syntax.
 * Examples: {{randomNumber()}}, {{uuid()}}, {{timestamp()}}
 *
 * For app-specific functions, see <app>/env/data-functions.mjs
 */

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
