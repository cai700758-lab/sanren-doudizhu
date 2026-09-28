export async function createRoom(page, { players = 3, skills = false } = {}) {
  await page.locator('#create-button').click();
  await page.locator(`#create-options label:has([name="room-size"][value="${players}"])`).click();
  await page.locator(`#create-options label:has([name="room-kind"][value="${skills ? 'skills' : 'classic'}"])`).click();
  await page.locator('#create-confirm').click();
  await page.locator('#game').waitFor({ state: 'visible' });
}
export async function joinRoom(page, code) {
  await page.locator('#join-button').click();
  await page.locator('#room-code').fill(code);
  await page.locator('#join-confirm').click();
  await page.locator('#game').waitFor({ state: 'visible' });
}
