export function extractCode(text) {
  if (!text) return null;
  // Strip HTML and CSS before regex to prevent matching hex colors like #202123
  const clean = String(text)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  const patterns = [
    /code to continue[^\d]*(\d{6})/i,
    /verification code[^\d]*(\d{6})/i,
    /code[^\d]*(\d{6})/i,
    /\b(\d{6})\b/,
  ];
  for (const re of patterns) {
    const m = clean.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * Creates and manages a temporary inbox using temp-mail.org in a browser context.
 */
export async function createTempMailOrgInbox(context, logger = () => {}) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await getInboxOnce(context, logger);
    } catch (e) {
      if (attempt === 2) throw e;
      logger(`Temporary inbox load failed (${e.message}), retrying...`, 'warn');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function getInboxOnce(context, logger) {
  const tmPage = await context.newPage();
  let mailbox = null;
  let tmToken = null;

  tmPage.on('response', async (res) => {
    if (res.url().includes('temp-mail.org/mailbox') && res.request().method() === 'POST') {
      try {
        const data = await res.json();
        mailbox = data.mailbox;
        tmToken = data.token;
      } catch {}
    }
  });

  logger('Loading temp-mail.org...');
  await tmPage.goto('https://temp-mail.org/en/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  for (let i = 0; i < 30; i++) {
    await tmPage.waitForTimeout(800);
    if (mailbox && tmToken) break;
    const val = await tmPage.locator('#mail').inputValue().catch(() => '');
    if (val && !val.includes('Loading') && val.includes('@')) {
      mailbox = val.trim();
    }
    if (i === 8 && !mailbox) {
      await tmPage.locator('#mail').click().catch(() => {});
    }
  }

  if (!mailbox) {
    const title = await tmPage.title().catch(() => '');
    logger(`temp-mail.org load status: title="${title}"`);
    await tmPage.close().catch(() => {});
    throw new Error(`Failed to obtain temporary email address from temp-mail.org (page title: "${title}")`);
  }

  logger(`Temp-mail.org address: ${mailbox}`);

  // Small helper to run a page-side fetch with a hard deadline. Wrapping the
  // evaluate in a Node-side Promise.race guarantees the poll loop can never be
  // held hostage by a hung page/CDP call.
  const pageFetch = (url, init = {}, ms = 6000) =>
    Promise.race([
      tmPage.evaluate(
        async ({ url, init, ms }) => {
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), ms);
          try {
            const res = await fetch(url, { ...init, signal: ctrl.signal });
            if (!res.ok) return null;
            return await res.json();
          } catch {
            return null;
          } finally {
            clearTimeout(to);
          }
        },
        { url, init, ms }
      ),
      new Promise((resolve) => setTimeout(() => resolve(null), ms + 2000)),
    ]);

  const waitForCode = async (maxWait = 150000) => {
    logger('Polling temp-mail.org for verification email...');
    const deadline = Date.now() + maxWait;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const listData = await pageFetch('https://web2.temp-mail.org/messages', {
          headers: tmToken ? { Authorization: 'Bearer ' + tmToken } : {},
        });

        const msgs = (listData && listData.messages) || [];
        for (const msg of msgs) {
          const fullMsg = await pageFetch(`https://web2.temp-mail.org/messages/${msg._id}`, {
            headers: tmToken ? { Authorization: 'Bearer ' + tmToken } : {},
          });
          if (!fullMsg) continue;
          const combined = `${fullMsg.bodyText || ''} ${fullMsg.bodyHtml || ''} ${msg.subject || ''}`;
          const code = extractCode(combined);
          if (code) {
            return code;
          }
        }
      } catch (e) {}
    }
    throw new Error('Timed out waiting for verification code from temp-mail.org');
  };

  const close = async () => {
    await tmPage.close().catch(() => {});
  };

  return {
    address: mailbox,
    waitForCode,
    close,
  };
}
