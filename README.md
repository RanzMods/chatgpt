# ChatGPT Signup Bot — Browser Automation Learning Tool

A Node.js command-line tool for learning browser automation with Playwright.
It walks through the ChatGPT signup flow automatically using temporary email
addresses, randomly generated realistic profiles, and concurrent workers.

---

## Supported Operating Systems

The script works on any Linux VPS distribution. The auto-installer (`install.sh`)
detects your OS and installs all dependencies automatically.

| Distro Family                     | Status | Package Manager |
|-----------------------------------|--------|-----------------|
| **Ubuntu / Debian / Mint**        | Full   | apt             |
| **Fedora / CentOS / RHEL / Rocky / Alma** | Full | dnf / yum |
| **Arch / Manjaro**                | Full   | pacman          |
| **openSUSE Leap / Tumbleweed**    | Full   | zypper          |
| **Alpine**                        | Beta   | apk             |

> **Note:** Alpine (musl-based) is unsupported by Playwright's bundled Chromium
> and Firefox. The bot will install, but browser automation may not work on
> Alpine.

---

## Quick Start

```bash
git clone <repo-url> && cd chatgpt-signup-bot
sudo bash install.sh
npm start
```

`install.sh` will:
1. Detect your distro and package manager
2. Install Node.js 18+ (via NodeSource or nvm as fallback)
3. Install npm project dependencies
4. Install Xvfb (for headless stealth browser)
5. Install Playwright browsers (Chromium + Firefox) + system libraries

### Requirements

- **Node.js** 18 or higher (auto-installed by `install.sh`)
- **npm** (comes with Node.js)
- Internet connection
- Linux VPS with sudo/root access

---

## Setup (Manual)

If you prefer manual installation instead of `install.sh`:

### 1. Install Node.js 18+

**Ubuntu / Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Fedora / CentOS / RHEL:**
```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -
sudo dnf install -y nodejs
```

**Arch:**
```bash
sudo pacman -S nodejs npm
```

### 2. Install dependencies
```bash
npm install
```

### 3. Install browsers + system libraries
```bash
npx playwright install --with-deps chromium firefox
```

### 4. Install Xvfb (for stealth mode on headless VPS)
```bash
# Ubuntu/Debian
sudo apt install -y xvfb

# Fedora/CentOS/RHEL
sudo dnf install -y xorg-x11-server-Xvfb

# Arch
sudo pacman -S xorg-server-xvfb
```

---

## Configuration

A `config.json` file is included with defaults. Edit it before running:

```json
{
  "defaultPassword": "MyStr0ng!Pass2024",
  "headless": true,
  "slowMotion": 100,
  "timeout": 60000,
  "workers": 1,
  "stealth": true,
  "proxy": {
    "enabled": false,
    "host": "",
    "port": 44445,
    "username": "",
    "password": ""
  }
}
```

| Field             | Description                                                  |
|-------------------|--------------------------------------------------------------|
| `defaultPassword` | Password applied to every account created                    |
| `headless`        | `false` = show browser window, `true` = run in background    |
| `slowMotion`      | Milliseconds between each browser action (0 = fastest)       |
| `timeout`         | Maximum ms to wait for any page element or action            |
| `workers`         | How many browsers run in parallel (1 recommended to start)   |
| `stealth`         | `true` = anti-fingerprint extension + Chromium via Xvfb      |
| `proxy`           | HTTP proxy config (BrightData/ISP recommended for production)|

> If `config.json` is missing when you run the tool, a sample file is
> created automatically and the tool exits so you can review it first.

---

## Usage

```bash
npm start
```

Or with stealth mode:
```bash
npm run start:stealth
```

The tool will:

1. Show your current config settings
2. Ask **how many accounts** to create (1–50)
3. Ask for the **password** to use (defaults to `config.json` value)
4. Open browser and step through the signup flow for each account
5. Create a temporary email address via temp-mail.org
6. Wait for the email verification code automatically
7. Set up password and 2FA on the new account
8. Print live progress in the terminal
9. Save successful accounts to **`accounts.txt`** as `email:password:2FAkey`

### What you'll see

```
╔══════════════════════════════════════╗
║     ChatGPT Signup Bot — Learning     ║
╚══════════════════════════════════════╝

Current config:
  headless    : true
  slowMotion  : 100ms
  timeout     : 60000ms
  workers     : 1
  stealth     : ON (anti-fingerprint extension)
  proxy       : enabled (http://brd.superproxy.io:44445)

Starting 1 account(s) with up to 1 worker(s)...
Results will be saved to: accounts.txt

[Worker 1] Starting with proxy: http://brd.superproxy.io:44445 (brd-customer-hl_33053f5e-zone-gpt2-country-us)
[Worker 1] Profile: Marilou Brekke, born 1991-06-21
[Worker 1] Temp-mail.org address: abc123xyz@dreameg.com
[Worker 1] Got verification code: 031256
[Worker 1] Account signup flow completed. Now configuring permanent password & 2FA...
[Worker 1] ✓ Password successfully set on account!
[Worker 1] ✓ 2FA Authenticator successfully enabled!
[Worker 1] ✓ Done — abc123xyz@dreameg.com [2FA Key: XKJZNBETS75U7Q4LYNEZ6WAUSXLGB5Y4]

  Progress: ████████████████████ 1/1  ✓ 1  ✗ 0

═══════════════════════════════════════
  Summary
═══════════════════════════════════════
  Total requested : 1
  Succeeded       : 1
  Failed          : 0
  Time taken      : 312.5s
  Saved to        : accounts.txt
═══════════════════════════════════════
```

### Output file

`accounts.txt` is appended to on each run:

```
abc123xyz@dreameg.com:R4nzMods_123:XKJZNBETS75U7Q4LYNEZ6WAUSXLGB5Y4
def456uvw@hideam.com:R4nzMods_123:LH7LY4U2OEMYZEAEVCBZDNXLMB3JU5AI
```

Format: `email:password:2FA_SECRET_KEY`

### Verifying accounts (fresh-browser login check)

Every account is created in a **brand-new browser** (fresh isolated profile), so
accounts never share cookies or fingerprints between runs. To confirm an account
is still active and not suspended/deactivated, the bot can log back in with the
saved credentials in another fresh browser:

```bash
xvfb-run -a node src/verify_all.js            # verify every account in accounts.txt
xvfb-run -a node src/verify_all.js --only abc123xyz@dreameg.com   # verify one account
```

Results are written to `verify_status.txt`:

```
abc123xyz@dreameg.com:OK
def456uvw@hideam.com:FAIL — password field never appeared (...)
```

- `OK` = the account logged in successfully with email + password + 2FA.
- `FAIL` = login failed (possibly suspended, deactivated, or the 2FA secret is invalid).
- Accounts are verified in a dedicated fresh browser so the check is independent
  of the session that created them.
- If the proxy is under heavy load, first page loads can stall. Run the
  verification pass later (e.g. the next day) for less throttling.

---

## How It Works

```
src/
  index.js   — CLI entry point, worker pool, progress display, proxy rotation
  config.js  — Loads and validates config.json, creates sample if missing
  bot.js     — Playwright browser automation (signup → password → 2FA)
  email.js   — temp-mail.org API: create inbox, poll for verification code
  profile.js — Generates realistic random names and birthdays with faker
  totp.js    — TOTP authenticator code generator (used to enable 2FA)
  verify.js  — Re-login health check (email + password + 2FA) in a fresh browser
  verify_all.js — Batch CLI for verify.js against all accounts in accounts.txt
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `config.json` created and tool exits | Edit config.json then run again |
| `Missing X server or $DISPLAY` | Install Xvfb: `sudo bash install.sh` or `sudo apt install xvfb` |
| Browser opens then closes immediately | Set `"headless": false` and `"slowMotion": 200` to debug visually |
| Verification code never arrives | temp-mail.org may be slow; try increasing `timeout` to `180000` |
| `registration_disallowed` error | Your IP is flagged; use ISP/residential proxy in config.json |
| Selector errors / wrong page | ChatGPT may have updated their UI; check selectors in `src/bot.js` |
| All accounts fail | Check internet + proxy connection, then try `npm start` again |

---

## Responsible Use Disclaimer

This tool is provided **for educational purposes only** — specifically to learn
browser automation techniques using Playwright.

- Automating account creation on third-party services may violate their
  **Terms of Service**. Review ChatGPT's ToS before use.
- Do **not** use this tool to create accounts at scale for spam, abuse,
  credential stuffing, or any activity that harms others or violates laws.
- The authors accept no liability for misuse of this software.
- Use responsibly, ethically, and only on services you are authorised to
  interact with programmatically.
