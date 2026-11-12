// Drives the Android app through its WebView (Chrome DevTools over adb) and the phone itself (adb key
// presses and window focus), then reports what passed. Run by scripts/android-smoke.sh in CI, on an emulator.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { _android as android } from 'playwright-core'

const OUT = process.env.OUT ?? 'smoke-out'
const PKG = process.env.PKG ?? 'com.tocfactory.game'
const results = []
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8' }).trim()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`)
}
const shot = (name) => writeFileSync(`${OUT}/${name}.png`, execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }))

// Playwright's Android support finds the app's WebView on the emulator and gives back a page to drive.
async function attach(device) {
  const webView = await device.webView({ pkg: PKG }, { timeout: 40000 })
  return webView.page()
}

const focus = () => adb('shell', 'dumpsys', 'window').split('\n').filter((l) => /mCurrentFocus/.test(l)).join(' ')
const back = async () => {
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
  await sleep(900)
}

try {
  const [device] = await android.devices()
  if (!device) throw new Error('no emulator found')
  let page = await attach(device)
  await page.getByText('Factory Fun').first().waitFor({ timeout: 20000 })
  check('app starts and shows the game', true)
  check('running inside the native app', await page.evaluate(() => Boolean(window.Capacitor?.isNativePlatform?.())))
  const home = await page.locator('body').innerText()
  for (const t of ['Trainer guide', 'My factory', 'Switch player', 'Full screen', 'Host a class', 'Join a class']) check(`home has no "${t}"`, !home.includes(t))
  check('home has the Start here card, levels, lab, free play, course, exam', ['Start here', 'Free play', 'Loading lab', 'Course guide', 'Exam and certificate'].every((t) => home.includes(t)))

  await page.locator('#nickname').fill('Sam')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: /Start level 0.1/ }).click()
  await page.getByRole('button', { name: /Start the shift/ }).click()
  await sleep(1500)
  await shot('level')
  check('a level opens and runs', (await page.locator('body').innerText()).includes('Shift clock'))

  // The system back button steps out of each screen, and closes the app only from home.
  await back()
  check('back leaves a level for the home screen', (await page.locator('body').innerText()).includes('Free play'))
  for (const [button, word] of [[/Free play/, 'free play'], [/Loading lab/, 'loading lab'], [/Course guide/, 'course guide'], [/Exam and certificate/, 'exam']]) {
    await page.getByRole('button', { name: button }).click()
    await sleep(900)
    const there = !(await page.locator('body').innerText()).includes('Loading lab') || word === 'loading lab'
    await back()
    check(`back leaves ${word} for the home screen`, (await page.locator('body').innerText()).includes('Free play') && there)
  }

  // The loading lab's explainer video, from inside the app's own files.
  await page.getByRole('button', { name: /Loading lab/ }).click()
  await sleep(800)
  const video = await page.evaluate(async () => {
    const v = document.querySelector('video')
    if (!v) return { found: false }
    v.preload = 'auto'
    v.load()
    await new Promise((r) => { v.addEventListener('loadeddata', r, { once: true }); v.addEventListener('error', r, { once: true }); setTimeout(r, 10000) })
    return { found: true, ready: v.readyState, error: v.error?.code ?? null, src: v.currentSrc.split('/').pop() }
  })
  check('explainer video loads in the WebView', video.found && video.ready >= 2, JSON.stringify(video))
  await back()

  // The certificate goes to Android's share sheet.
  const learner = await page.evaluate(() => JSON.parse(localStorage.getItem('toc-factory:learner')).id)
  await page.evaluate((id) => {
    const at = new Date().toISOString()
    localStorage.setItem(`toc-factory:exam:${id}`, JSON.stringify({ seen: {}, attempts: [{ at, correct: 36, asked: 40, passed: true }], current: null, certificate: { name: 'Sam Example', id: 'TOCF-TEST-0001', at, correct: 36, asked: 40 }, name: 'Sam Example' }))
  }, learner)
  await page.reload()
  await page.getByRole('button', { name: /Exam and certificate/ }).click()
  await page.getByRole('button', { name: /View my certificate/ }).click()
  await page.getByRole('button', { name: /Save or share the PDF/ }).waitFor()
  await page.waitForFunction(() => ![...document.querySelectorAll('.exam-actions button')].some((b) => b.disabled), null, { timeout: 20000 })
  await shot('certificate')
  await page.getByRole('button', { name: /Save or share the PDF/ }).click()
  let shareFocus = ''
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    shareFocus = focus()
    if (/Chooser|Resolver|intentresolver|sharesheet/i.test(shareFocus)) break
  }
  await shot('share-sheet')
  check("the certificate opens Android's share sheet", /Chooser|Resolver|intentresolver|sharesheet/i.test(shareFocus), shareFocus.trim().slice(0, 160))
  await back()
  await sleep(800)
  check('closing the share sheet returns to the certificate with no error', (await page.locator('body').innerText()).includes('Certificate'))

  // Progress is kept when the app is closed and opened again.
  adb('shell', 'am', 'force-stop', PKG)
  await sleep(1500)
  adb('shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1')
  page = await attach(device)
  await page.getByText('Factory Fun').first().waitFor({ timeout: 20000 })
  check('nickname and certificate are still there after closing and reopening', (await page.locator('body').innerText()).includes('Sam') && (await page.evaluate((id) => localStorage.getItem(`toc-factory:exam:${id}`) !== null, learner)))

  // Back from the home screen closes the app.
  await back()
  await sleep(2500)
  const alive = adb('shell', 'pidof', PKG).trim() !== ''
  check('back from the home screen closes the app', !alive)
  await device.close().catch(() => {})
} catch (error) {
  check('the run finished without an error', false, String(error?.stack ?? error).slice(0, 600))
  try { shot('failure') } catch { /* no screen to take */ }
}

writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2))
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
