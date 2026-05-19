import { ROOT_URL } from "../support/test-helper"

export async function login(ui, username, password) {
  
  //Login
  await ui.fill('login-username-input', username)
  await ui.fill('login-password-input', password)
  await ui.action('login-submit-button')
}
