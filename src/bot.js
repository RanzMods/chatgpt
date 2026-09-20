import { chromium, firefox } from 'playwright';
import { createTempMailOrgInbox } from './email.js';
import { generateProfile } from './profile.js';
import { generateTOTP } from './totp.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = join(__dirname, '..', 'extensions', 'anti-fingerprint');

export async function createAccount(config, logger, proxyOpt) {
  const { defaultPassword, timeout } = config;
  const proxy = proxyOpt ?? config.proxy;

  logger(`${config.stealth ? 'Stealth' : 'Standard'} session requested`);

  const profile = generateProfile();
  logger(`Profile: ${profile.displayName}, born ${profile.birthYear}-${profile.birthMonth}-${profile.birthDay}`);

  const { context, page, close } = await openSession(config, proxy, timeout, logger);
  let tmInbox = null;

  try {
    logger('Opening temp-mail.org in background tab...');
    tmInbox = await createTempMailOrgInbox(context, logger);

    // === Signup with inbox rotation ===
    // OpenAI/temp-mail delivery is flaky: if the verification email is not
    // received within the wait window, rotate to a brand-new inbox (new random
    // domain) and resubmit the signup so OpenAI re-sends the code.
    let email = tmInbox.address;
    let code = null;

    for (let rotation = 0; rotation < 3; rotation++) {
      if (rotation > 0) {
        logger(`Verification email not received — rotating to a fresh inbox & resending (${rotation}/3)...`);
        tmInbox.close().catch(() => {});
        tmInbox = await createTempMailOrgInbox(context, logger);
        email = tmInbox.address;
      }

      logger('Navigating to ChatGPT signup page...');
      await page.goto('https://chatgpt.com/auth/login#signup', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1800);

      const cookieBtn = page.locator('button:has-text("Accept all"), button:has-text("Accept"), button:has-text("Agree")');
      if (await cookieBtn.count() > 0) {
        await cookieBtn.first().click();
        await page.waitForTimeout(600);
      }

      logger('Entering email address...');
      const emailInput = page.locator('input[type="email"]').first();
      await emailInput.waitFor({ state: 'visible', timeout: 20000 });
      await emailInput.fill(email);
      await page.waitForTimeout(400);

      const continueBtn = page.locator('button').filter({ hasText: /^Continue$/ }).first();
      await continueBtn.click();
      logger('Submitted email, checking next step...');

      for (let i = 0; i < 25; i++) {
        await page.waitForTimeout(1000);
        const u = page.url();
        if (u.includes('password') || u.includes('email-verification')) break;
      }

      if (page.url().includes('password')) {
        logger('Password step reached, entering password...');
        const pwdInput = page.locator('input[type="password"]').first();
        await pwdInput.waitFor({ state: 'visible', timeout: 30000 });
        await pwdInput.fill(defaultPassword);
        const pwdSubmit = page.locator('button[type="submit"], button:has-text("Continue")').first();
        await pwdSubmit.click();
        logger('Submitted password, waiting for verification page...');
      }

      try {
        await page.waitForURL('**/email-verification**', { timeout: 60000 });
      } catch (e) {
        if (rotation === 2) throw new Error('Reached neither password nor verification page during signup');
        continue;
      }
      logger('Verification page loaded');

      // Keep the verification page alive while the code is being delivered
      // (reload resets any server-side session timeouts during long waits).
      const keepAlive = setInterval(() => {
        if (!page.isClosed() && page.url().includes('email-verification')) {
          page.reload().catch(() => {});
        }
      }, 40000);

      try {
        logger('Waiting for verification code from temp-mail.org...');
        code = await tmInbox.waitForCode(100000);
        logger(`Got verification code: ${code}`);
      } finally {
        clearInterval(keepAlive);
      }
      if (code) break;
    }

    if (!code) {
      throw new Error('Timed out waiting for verification code from temp-mail.org (all inbox rotations)');
    }

    const codeInput = page.locator('input[name="code"], input[inputmode="numeric"]').first();
    await codeInput.waitFor({ state: 'visible' });
    await codeInput.click();
    await codeInput.fill(code);
    await page.waitForTimeout(500);

    logger('Submitting verification code...');
    for (let attempt = 1; attempt <= 3; attempt++) {
      const codeSubmit = page.locator('button').filter({ hasText: /^Continue$/ }).first();
      if (await codeSubmit.count() > 0) {
        await codeSubmit.click().catch(() => {});
      } else {
        await codeInput.press('Enter').catch(() => {});
      }
      await page.waitForTimeout(4000);
      if (!page.url().includes('email-verification')) break;
    }

    await page.waitForURL('**/about-you**', { timeout: 45000 });
    logger('Reached about-you page! Filling profile info...');
    await page.waitForTimeout(1000);

    const nameInput = page
      .locator('input[name="name"], input[placeholder*="full name" i], input[placeholder*="name" i], input[name="firstName"], input[name="first_name"]')
      .first();
    if (await nameInput.count() > 0 && (await nameInput.isVisible())) {
      logger('Filling in name...');
      await nameInput.fill(profile.displayName);
    }

    const ageInput = page.locator('input[name="age"], input[placeholder*="age" i]').first();
    if (await ageInput.count() > 0 && (await ageInput.isVisible())) {
      logger('Filling in age...');
      await ageInput.fill(profile.age || '26');
    }

    const birthdayPresent =
      (await page.locator('select[name*="month" i], select[id*="month" i], input[placeholder*="YYYY" i], input[placeholder*="MM" i]').count()) > 0;
    if (birthdayPresent) {
      logger('Filling in birthday...');
      await fillBirthday(page, profile);
    }

    await page.waitForTimeout(1000);
    const aboutSubmit = page.locator('button[type="submit"]').first();
    await aboutSubmit.click();
    logger('Submitted about-you form! Waiting for completion...');

    // If password page appears after about-you (for flows that ask password after about-you)
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(1500);
      const u = page.url();
      const pwd = page.locator('input[type="password"]').first();
      if (await pwd.isVisible().catch(() => false)) {
        logger('Password field detected, entering password...');
        await pwd.fill(defaultPassword);
        const pwdBtn = page.locator('button[type="submit"], button:has-text("Continue")').first();
        await pwdBtn.click();
        logger('Submitted password!');
        await page.waitForTimeout(2000);
        break;
      }
      if (!u.includes('about-you')) break;
    }

    // Wait for redirect to ChatGPT main app
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(1500);
      const u = page.url();
      if (u.includes('chatgpt.com') && !/auth|login|verification|about-you/.test(u)) break;
    }

    const finalUrl = page.url();
    const finalBody = await page.locator('body').innerText().catch(() => '');

    const success =
      (finalUrl.includes('chatgpt.com') && !/auth|login|verification|about-you/.test(finalUrl)) ||
      finalBody.includes('New chat') ||
      finalBody.includes('Start a new chat') ||
      finalBody.includes('Chat history');

    if (!success) {
      throw new Error(`Signup incomplete. URL: ${finalUrl.slice(0, 80)}`);
    }

    logger('Account signup flow completed. Waiting for ChatGPT session to settle...');
    await page.waitForTimeout(3000);

    logger('Now configuring permanent password & 2FA...');
    try {
      await setupPassword(page, logger, tmInbox, defaultPassword);
    } catch (pwdErr) {
      logger(`Password setup warning: ${pwdErr.message}`, 'warn');
    }

    let mfaKey = null;
    try {
      mfaKey = await setup2FA(page, logger);
    } catch (mfaErr) {
      logger(`2FA setup warning: ${mfaErr.message}`, 'warn');
    }

    logger('Account process finished!', 'success');
    return { email: tmInbox.address, password: defaultPassword, mfaKey };
  } finally {
    if (tmInbox) await tmInbox.close().catch(() => {});
    await close();
  }
}

async function dismissOnboarding(page, logger) {
  const candidates = [
    'Continue',
    'Start chatting',
    "Okay, let's go",
    'Start exploring',
    'Next',
    'Done',
    'Got it',
    'Maybe later',
  ];

  // Native <dialog> elements (post-signup modals) have no explicit role attribute.
  const modalSelector = 'dialog:visible, [role="dialog"]:visible';

  for (let i = 0; i < 4; i++) {
    if (await page.locator('[data-testid="security-tab"]').first().isVisible().catch(() => false)) return;
    const dialogCount = await page.locator(modalSelector).count().catch(() => 0);
    if (dialogCount === 0) break;

    let closed = false;
    for (const t of candidates) {
      const btn = page.locator(modalSelector).locator(`button:has-text("${t}")`).first();
      if (!(await btn.isVisible().catch(() => false))) continue;
      logger(`Dismissing modal (button "${t}")...`);
      await btn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(700);
      if (!(await page.locator(modalSelector).count().catch(() => 0))) {
        closed = true;
        break;
      }
    }
    if (!closed) {
      // Best effort: click the first visible button in the topmost modal
      const fallbackBtn = page.locator(modalSelector + ' button:visible').last();
      if (await fallbackBtn.isVisible().catch(() => false)) {
        const label = (await fallbackBtn.innerText().catch(() => '')).trim();
        if (label && label !== 'Cancel') {
          logger(`Dismissing modal (generic button "${label}")...`);
          await fallbackBtn.click({ force: true }).catch(() => {});
          await page.waitForTimeout(700);
        } else {
          break;
        }
      } else {
        break;
      }
    }
  }
}

async function openSettingsDialog(page, logger, section = 'security') {
  // "Real" settings are rendered inside a dialog/sheet (native <dialog> or
  // role=dialog). The bare SPA URL (#/settings) can render an empty frame
  // WITHOUT the dialog, so always require controls to be inside a visible one.
  const sheetSelector = 'dialog:visible, [role="dialog"]:visible';
  const inSettingsSheet = () =>
    page
      .locator(`${sheetSelector} [data-testid="security-tab"], ${sheetSelector} [data-testid="password-setting"], ${sheetSelector} [data-testid="mfa-authenticator-toggle"]`)
      .first()
      .isVisible()
      .catch(() => false);

  await dismissOnboarding(page, logger);

  if (await inSettingsSheet()) return;

  logger('Opening settings panel...');
  for (let attempt = 1; attempt <= 4; attempt++) {
    const profileBtn = page.locator('[data-testid="accounts-profile-button"]').last();
    try {
      await profileBtn.waitFor({ state: 'visible', timeout: 15000 });
      await profileBtn.click();
      await page.waitForTimeout(1200);

      const settingsItem = page.locator('[data-testid="settings-menu-item"], [role="menuitem"]:has-text("Settings")').first();
      if (!(await settingsItem.isVisible().catch(() => false))) {
        await profileBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(1200);
      }
      await settingsItem.waitFor({ state: 'visible', timeout: 10000 });
      await settingsItem.click();
      await page.waitForTimeout(2500);
    } catch (e) {
      logger(`Settings open attempt ${attempt}/4 failed (${e.message}) — retrying...`, 'warn');
      await dismissOnboarding(page, logger);
      continue;
    }

    if (await inSettingsSheet()) return;
  }

  // Last resort: navigate directly (some UI builds render the sheet for path URLs)
  logger('Profile menu did not open settings — trying direct settings URL...');
  await page.goto(`https://chatgpt.com/settings?section=${section}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await dismissOnboarding(page, logger);
  await page.waitForTimeout(1000);
  if (await inSettingsSheet()) return;

  throw new Error(`Could not open settings "${section}" section`);
}

async function setupPassword(page, logger, tmInbox, password) {
  logger('Adding permanent password to account...');
  await openSettingsDialog(page, logger, 'security');

  // Ensure the Security section is active
  const secTab = page.locator('[data-testid="security-tab"]').first();
  if (await secTab.isVisible().catch(() => false)) {
    await secTab.click({ force: true });
    await page.waitForTimeout(1500);
  }

  const pwdSetting = page.locator('[data-testid="password-setting"]').first();
  for (let tryOpen = 1; tryOpen <= 2; tryOpen++) {
    try {
      await pwdSetting.waitFor({ state: 'visible', timeout: 20000 });
      break;
    } catch (awaitError) {
      if (tryOpen === 2) throw awaitError;
      logger('Password setting not rendered — re-opening settings and retrying...', 'warn');
      await openSettingsDialog(page, logger, 'security');
      const tab = page.locator('[data-testid="security-tab"]').first();
      if (await tab.isVisible().catch(() => false)) {
        await tab.click({ force: true });
        await page.waitForTimeout(1500);
      }
    }
  }
  await pwdSetting.click({ force: true });
  logger('Initiated password setup, waiting for email confirmation code...');

  await page.waitForURL('**/email-verification**', { timeout: 35000 });
  const pwdCode = await tmInbox.waitForCode(120000);
  logger(`Got password setup code: ${pwdCode}`);

  const pwdCodeInput = page.locator('input[name="code"], input[inputmode="numeric"]').first();
  await pwdCodeInput.waitFor({ state: 'visible' });
  await pwdCodeInput.click();
  await pwdCodeInput.fill(pwdCode);
  await page.waitForTimeout(500);

  const pwdCodeSubmit = page.locator('button').filter({ hasText: /^Continue$/ }).first();
  if (await pwdCodeSubmit.count() > 0) await pwdCodeSubmit.click(); else await pwdCodeInput.press('Enter');

  await page.waitForURL('**/reset-password/new-password**', { timeout: 35000 });
  logger('Entering and saving new password...');

  const newPwd = page.locator('input[name="new-password"]').first();
  await newPwd.waitFor({ state: 'visible', timeout: 25000 });
  await newPwd.fill(password);

  const confirmPwd = page.locator('input[name="confirm-password"]').first();
  await confirmPwd.waitFor({ state: 'visible' });
  await confirmPwd.fill(password);

  await page.waitForTimeout(500);
  const savePwdBtn = page.locator('button[type="submit"], button:has-text("Continue")').first();
  await savePwdBtn.click();
  logger('Submitted password, waiting for redirect to ChatGPT...');

  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1500);
    const u = page.url();
    if (u.includes('chatgpt.com') && !u.includes('auth.openai.com')) break;
  }

  logger('✓ Password successfully set on account!', 'success');
  await page.waitForTimeout(4000);

  // Close any open dialog/modal so subsequent steps start clean
  const closeDialogBtn = page.locator('[role="dialog"] button[aria-label="Close"], [role="dialog"] [data-testid="close-button"]').first();
  if (await closeDialogBtn.isVisible().catch(() => false)) {
    await closeDialogBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(2000);
  }
}

async function setup2FA(page, logger) {
  logger('Setting up 2FA Authenticator on ChatGPT...');
  await openSettingsDialog(page, logger, 'security');

  // Ensure the Security section is active
  const secTab = page.locator('[data-testid="security-tab"]').first();
  if (await secTab.isVisible().catch(() => false)) {
    await secTab.click({ force: true });
    await page.waitForTimeout(1500);
  }

  // Click Authenticator App toggle
  logger('Activating Authenticator App MFA...');
  const mfaToggle = page.locator('[data-testid="mfa-authenticator-toggle"]').first();
  for (let tryOpen = 1; tryOpen <= 2; tryOpen++) {
    try {
      await mfaToggle.waitFor({ state: 'visible', timeout: 20000 });
      break;
    } catch (awaitError) {
      if (tryOpen === 2) throw awaitError;
      logger('MFA toggle not rendered — re-opening settings and retrying...', 'warn');
      await openSettingsDialog(page, logger, 'security');
      const tab = page.locator('[data-testid="security-tab"]').first();
      if (await tab.isVisible().catch(() => false)) {
        await tab.click({ force: true });
        await page.waitForTimeout(1500);
      }
    }
  }
  await mfaToggle.click({ force: true });
  await page.waitForTimeout(2500);

  // Click "Trouble scanning?" to view manual secret key
  const troubleBtn = page.locator('button:has-text("Trouble scanning?"), a:has-text("Trouble scanning?")').first();
  await troubleBtn.waitFor({ state: 'visible', timeout: 15000 });
  await troubleBtn.click({ force: true });
  await page.waitForTimeout(2000);

  // Extract secret key
  const dialogText = await page.locator('[role="dialog"]').last().innerText().catch(() => '');
  const secretMatch = dialogText.match(/\b([A-Z2-7]{16,64})\b/);
  if (!secretMatch) {
    throw new Error('Could not extract 2FA secret key from authenticator modal');
  }
  const secretKey = secretMatch[1];
  logger(`Extracted 2FA secret key: ${secretKey}`);

  // Generate and input TOTP verification code
  const totp = generateTOTP(secretKey);
  logger(`Generated TOTP verification code: ${totp}`);
  const totpInput = page.locator('input#totp_otp, input[name="totp_otp"]').first();
  await totpInput.waitFor({ state: 'visible', timeout: 10000 });
  await totpInput.fill(totp);
  await page.waitForTimeout(500);

  // Click Verify
  const verifyBtn = page.locator('[role="dialog"] button:has-text("Verify")').last();
  await verifyBtn.click();
  logger('Submitted TOTP verification code, awaiting confirmation...');
  await page.waitForTimeout(4000);

  logger('✓ 2FA Authenticator successfully enabled!', 'success');
  return secretKey;
}

export async function openSession(config, proxy, timeout, logger = () => {}) {
  if (config.stealth) return openChromiumStealth(config, proxy, timeout, logger);
  return openFirefox(config, proxy, timeout);
}

async function openFirefox(config, proxy, timeout) {
  const launchOpts = { headless: config.headless, slowMo: config.slowMotion };
  if (proxy) {
    launchOpts.proxy = {
      server: proxy.server,
      username: proxy.username,
      password: proxy.password,
    };
  }

  const browser = await firefox.launch(launchOpts);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  return { context, page, close: () => browser.close() };
}

async function openChromiumStealth(config, proxy, timeout, logger = () => {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'af-browser-'));
  const launchOpts = {
    headless: false,
    slowMo: config.slowMotion,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    colorScheme: 'light',
    ignoreHTTPSErrors: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.6834.160 Safari/537.36',
  };
  if (proxy) {
    launchOpts.proxy = {
      server: proxy.server,
      username: proxy.username,
      password: proxy.password,
      bypass: 'temp-mail.org, *.temp-mail.org, web2.temp-mail.org',
    };
  }

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Fresh browser profile per account — never reuse another session's profile
      const context = await chromium.launchPersistentContext(userDataDir, launchOpts);
      const page = context.pages()[0] ?? (await context.newPage());
      page.setDefaultTimeout(timeout);
      return { context, page, close: () => context.close() };
    } catch (err) {
      lastErr = err;
      logger(`Chromium launch attempt ${attempt}/3 failed (${err.message}) — cleaning up and retrying...`, 'warn');
      // Kill any leftover Chromium processes from a previous long session so they
      // can never block a fresh launch (e.g. "browser has been closed").
      try {
        spawnSync('pkill', ['-f', 'af-browser-'], { stdio: 'ignore' });
      } catch {}
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

async function fillBirthday(page, profile) {
  const monthSelect = page.locator('select[name*="month" i], select[id*="month" i]').first();
  if (await monthSelect.count() > 0) {
    await monthSelect.selectOption({ value: profile.birthMonth });
  } else {
    const monthInput = page.locator('input[name*="month" i], input[placeholder*="MM" i]').first();
    if (await monthInput.count() > 0) await monthInput.fill(profile.birthMonth);
  }

  const daySelect = page.locator('select[name*="day" i], select[id*="day" i]').first();
  if (await daySelect.count() > 0) {
    await daySelect.selectOption({ value: String(parseInt(profile.birthDay)) });
  } else {
    const dayInput = page.locator('input[name*="day" i], input[placeholder*="DD" i]').first();
    if (await dayInput.count() > 0) await dayInput.fill(profile.birthDay);
  }

  const yearSelect = page.locator('select[name*="year" i], select[id*="year" i]').first();
  if (await yearSelect.count() > 0) {
    await yearSelect.selectOption({ value: profile.birthYear });
  } else {
    const yearInput = page.locator('input[name*="year" i], input[placeholder*="YYYY" i]').first();
    if (await yearInput.count() > 0) await yearInput.fill(profile.birthYear);
  }

  const birthdayContinue = page.locator('button[type="submit"], button:has-text("Continue")').first();
  if (await birthdayContinue.count() > 0) await birthdayContinue.click();
}
