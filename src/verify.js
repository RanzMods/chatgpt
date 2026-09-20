import { generateTOTP } from './totp.js';
import { openSession } from './bot.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a promise but bails out with the given error message if it does not
 * settle within `ms`. The underlying operation keeps running but is ignored —
 * protective against proxy connections that black-hole instead of timing out.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * Verifies that a freshly-created account is still active by logging back in with
 * the saved email/password/2FA in a brand-new browser session. This catches
 * accounts that were immediately deactivated/suspended or whose credentials were
 * never properly applied.
 */
export async function verifyAccount(config, proxy, account, logger = () => {}) {
  const fail = (reason) => ({ ok: false, reason });
  let session = null;
  try {
    session = await openSession(config, proxy, config.timeout || 60000, logger);
    const { page } = session;

    // Reuse the same signup-flavored login URL that the signup flow reliably loads
    // (a blank/black-holed first load otherwise stalls verification).
    let pageLoaded = false;
    for (let attempt = 1; attempt <= 3 && !pageLoaded; attempt++) {
      try {
        await withTimeout(
          page.goto('https://chatgpt.com/auth/login#signup', { waitUntil: 'domcontentloaded', timeout: 90000 }),
          95000,
          'login page load'
        );
        pageLoaded = true;
      } catch (e) {
        if (attempt === 3) throw e;
        logger(`Login page slow load (${e.message.split('\n')[0]}) — retrying...`, 'warn');
        await sleep(3000);
      }
    }
    await sleep(2500);

    const cookieBtn = page.locator('button:has-text("Accept all"), button:has-text("Accept"), button:has-text("Agree")');
    if ((await cookieBtn.count()) > 0) {
      await cookieBtn.first().click().catch(() => {});
      await sleep(600);
    }

    const emailInput = page.locator('input[type="email"], input[name="username"], input#email-input').first();
    await withTimeout(emailInput.waitFor({ state: 'visible' }), 45000, 'email input wait');
    await emailInput.fill(account.email);
    await sleep(500);
    const contBtn = page.locator('button[type="submit"], button:has-text("Continue")').first();
    await contBtn.click();

    // Existing accounts land on a password field (possibly after a redirect to
    // auth.openai.com). Poll for the password input with generous budget.
    const pwdInput = page.locator('input[type="password"], input[name="password"]').first();
    let pwdReady = false;
    for (let i = 0; i < 40 && !pwdReady; i++) {
      await sleep(1500);
      pwdReady = await pwdInput.isVisible().catch(() => false);
    }
    if (!pwdReady) {
      return fail(`password field never appeared (url=${page.url().slice(0, 120)})`);
    }
    await pwdInput.fill(account.password);
    const signIn = page
      .locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Continue")')
      .first();
    await signIn.click();
    await sleep(2500);

    const totpInput = page.locator('input#totp_otp, input[name="totp_otp"], input[inputmode="numeric"]').first();
    if (await totpInput.isVisible().catch(() => false)) {
      if (!account.mfaKey) return fail('2FA challenge appeared but no mfaKey was stored');
      // Tolerate ±1 time-step drift so clock skew never fails a valid account
      let verified = false;
      for (const offset of [0, -1, 1]) {
        const code = generateTOTP(account.mfaKey, Date.now() + offset * 30000);
        await totpInput.fill(code);
        await sleep(500);
        const vBtn = page.locator('button[type="submit"], button:has-text("Verify"), button:has-text("Continue")').first();
        await vBtn.click();
        await sleep(2000);
        const still = page.locator('input#totp_otp, input[name="totp_otp"]').first();
        if (!(await still.isVisible().catch(() => false))) {
          verified = true;
          break;
        }
      }
      if (!verified) return fail('TOTP 2FA code was rejected during verification');
    }

    let landed = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1500);
      const u = page.url();
      if (u.startsWith('https://chatgpt.com/') && !u.includes('auth.openai') && !u.includes('auth.login')) {
        landed = true;
        break;
      }
    }
    if (!landed) return fail(`login did not complete (url=${page.url().slice(0, 120)})`);

    const composer = page.locator('#prompt-textarea, [data-testid="composer"] textarea, form textarea').first();
    const authed = (await composer.isVisible().catch(() => false)) || page.url().slice(0, 40) === 'https://chatgpt.com/';
    if (!authed) return fail('landed on chatgpt.com but session does not appear authenticated');

    logger('✓ Account verified — fresh login with email+password+2FA succeeded', 'success');
    return { ok: true };
  } catch (e) {
    return fail(`error during verification: ${e.message}`);
  } finally {
    if (session) await session.close().catch(() => {});
  }
}