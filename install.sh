#!/usr/bin/env bash
#
# install.sh — ChatGPT Signup Bot auto-installer
#
# Mendeteksi distro dan versi VPS secara otomatis, lalu menginstal:
#   - Paket dasar (curl, git, ca-certificates, wget, tar, unzip)
#   - Node.js 22 LTS (via NodeSource, n, atau nvm sebagai fallback)
#   - Xvfb (display virtual untuk stealth browser)
#   - npm dependencies project
#   - Browser Playwright (Chromium + Firefox) + library sistem
#
# Distro yang didukung (dan semua varian/versi VPS-nya):
#   Debian 9/10/11/12+, Ubuntu 18/20/22/24+, Mint, Pop!_OS, Kali, Parrot
#   Fedora 36+, RHEL/CentOS/Rocky/Alma 7/8/9+, Amazon Linux 2/2023, Oracle Linux
#   Arch Linux, Manjaro, EndeavourOS
#   openSUSE Leap 15+, Tumbleweed, SLES
#   Alpine 3.14+
#   Void Linux
#   Gentoo (portage, best-effort)
#   Raspberry Pi OS, Armbian (ARM via apt)
#
# Cara pakai:
#   sudo bash install.sh        # direkomendasikan
#   bash install.sh             # bila sudah root
#

set -uo pipefail

# ── helpers ──────────────────────────────────────────────────────────────────
RED='\033[1;31m'; YEL='\033[1;33m'; GRN='\033[1;32m'; CYN='\033[1;36m'; RST='\033[0m'
log()  { printf "${GRN}[install]${RST} %s\n" "$*"; }
warn() { printf "${YEL}[warn]   ${RST} %s\n" "$*"; }
die()  { printf "${RED}[error]  ${RST} %s\n" "$*" >&2; exit 1; }
ok()   { printf "${CYN}[ok]     ${RST} %s\n" "$*"; }

# ── root / sudo ───────────────────────────────────────────────────────────────
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "Jalankan sebagai root, atau pasang sudo terlebih dahulu."
  SUDO="sudo"
fi

NODE_MAJOR=22
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── deteksi OS ────────────────────────────────────────────────────────────────
OS_ID="unknown"; OS_ID_LIKE=""; OS_NAME="unknown"; OS_VERSION_ID=""
detect_os() {
  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release 2>/dev/null || true
    OS_ID="${ID:-unknown}"
    OS_ID_LIKE="${ID_LIKE:-}"
    OS_NAME="${PRETTY_NAME:-$OS_ID}"
    OS_VERSION_ID="${VERSION_ID:-}"
  elif command -v lsb_release >/dev/null 2>&1; then
    OS_ID="$(lsb_release -si | tr '[:upper:]' '[:lower:]')"
    OS_NAME="$(lsb_release -sd)"
  elif [ -f /etc/redhat-release ]; then
    OS_ID="rhel"; OS_NAME="$(cat /etc/redhat-release)"
  elif [ -f /etc/alpine-release ]; then
    OS_ID="alpine"; OS_NAME="Alpine $(cat /etc/alpine-release)"
  else
    die "/etc/os-release tidak ditemukan — OS tidak dapat dideteksi."
  fi
  log "OS terdeteksi: $OS_NAME"
}

# ── deteksi package manager ───────────────────────────────────────────────────
PKG=""
detect_pm() {
  # Urutan penting: lebih spesifik dulu
  if   command -v dnf    >/dev/null 2>&1; then PKG=dnf
  elif command -v yum    >/dev/null 2>&1; then PKG=yum
  elif command -v apt-get>/dev/null 2>&1; then PKG=apt
  elif command -v zypper >/dev/null 2>&1; then PKG=zypper
  elif command -v pacman >/dev/null 2>&1; then PKG=pacman
  elif command -v xbps-install>/dev/null 2>&1; then PKG=xbps
  elif command -v emerge >/dev/null 2>&1; then PKG=portage
  elif command -v apk    >/dev/null 2>&1; then PKG=apk
  else die "Tidak ada package manager yang dikenali (apt/dnf/yum/zypper/pacman/xbps/apk/portage)."
  fi
  log "Package manager: $PKG"
}

# ── helper: jalankan package-manager install ──────────────────────────────────
pm_update() {
  case "$PKG" in
    apt)    $SUDO apt-get update -y -qq 2>/dev/null || true ;;
    dnf)    $SUDO dnf makecache -q 2>/dev/null || true ;;
    yum)    $SUDO yum makecache -q 2>/dev/null || true ;;
    pacman) $SUDO pacman -Sy --noconfirm 2>/dev/null || true ;;
    zypper) $SUDO zypper refresh -q 2>/dev/null || true ;;
    xbps)   $SUDO xbps-install -Su 2>/dev/null || true ;;
    apk)    $SUDO apk update -q 2>/dev/null || true ;;
    portage) ;;
  esac
}

pm_install() {
  case "$PKG" in
    apt)    DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq "$@" ;;
    dnf)    $SUDO dnf install -y -q "$@" ;;
    yum)    $SUDO yum install -y -q "$@" ;;
    pacman) $SUDO pacman -S --noconfirm --needed -q "$@" ;;
    zypper) $SUDO zypper --non-interactive install -y "$@" ;;
    xbps)   $SUDO xbps-install -y "$@" ;;
    apk)    $SUDO apk add --no-cache "$@" ;;
    portage) $SUDO emerge --ask=n "$@" ;;
  esac
}

# ── 1. paket dasar ────────────────────────────────────────────────────────────
install_base() {
  log "Memastikan paket dasar tersedia..."
  pm_update
  case "$PKG" in
    apt)    pm_install curl wget ca-certificates git gnupg lsb-release ;;
    dnf|yum) pm_install curl wget ca-certificates git gnupg2 ;;
    pacman) pm_install curl wget git gnupg ;;
    zypper) pm_install curl wget ca-certificates git gpg2 ;;
    xbps)   pm_install curl wget ca-certificates git gnupg ;;
    apk)    pm_install curl wget ca-certificates git gnupg ;;
    portage) pm_install net-misc/curl dev-vcs/git ;;
  esac
}

# ── 2a. Node.js via nvm (generic fallback) ────────────────────────────────────
install_node_via_nvm() {
  warn "Memasang Node $NODE_MAJOR via nvm (fallback)..."
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
  nvm install "$NODE_MAJOR"
  nvm alias default "$NODE_MAJOR"
  # Symlink ke /usr/local/bin agar tersedia secara global
  local bdir
  bdir="$(ls -d "$NVM_DIR/versions/node/v${NODE_MAJOR}."*/bin 2>/dev/null | sort -V | tail -n1)"
  if [ -n "$bdir" ]; then
    for c in node npm npx; do
      [ -f "$bdir/$c" ] && $SUDO ln -sf "$bdir/$c" "/usr/local/bin/$c" 2>/dev/null || true
    done
  fi
}

# ── 2b. Node.js via 'n' (ringan, pure-shell) ──────────────────────────────────
install_node_via_n() {
  warn "Memasang Node $NODE_MAJOR via 'n'..."
  curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | $SUDO bash -s -- "$NODE_MAJOR" \
    || install_node_via_nvm
}

# ── 2c. Node.js: coba NodeSource dulu, fallback ke n/nvm ─────────────────────
install_node_distro() {
  case "$PKG" in
    # ── Debian / Ubuntu / turunannya ──────────────────────────────────────────
    apt)
      log "Memasang Node $NODE_MAJOR via NodeSource (deb)..."
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash - \
        && $SUDO apt-get install -y nodejs \
        || install_node_via_n
      ;;
    # ── RHEL / CentOS 7 (yum, bukan dnf) ─────────────────────────────────────
    yum)
      local maj="${OS_VERSION_ID%%.*}"
      if [ "${maj:-0}" -le 7 ] 2>/dev/null; then
        # CentOS/RHEL 7: NodeSource RPM
        log "Memasang Node $NODE_MAJOR via NodeSource (rpm, el7)..."
        curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash - \
          && $SUDO yum install -y nodejs \
          || install_node_via_n
      else
        log "Memasang Node $NODE_MAJOR via NodeSource (rpm)..."
        curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash - \
          && $SUDO yum install -y nodejs \
          || install_node_via_n
      fi
      ;;
    # ── Fedora / RHEL 8-9+ (dnf) ─────────────────────────────────────────────
    dnf)
      log "Memasang Node $NODE_MAJOR via NodeSource (rpm)..."
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash - \
        && $SUDO dnf install -y nodejs \
        || install_node_via_n
      ;;
    # ── Arch / Manjaro ────────────────────────────────────────────────────────
    pacman)
      log "Memasang nodejs npm via pacman..."
      pm_install nodejs npm
      ;;
    # ── openSUSE ─────────────────────────────────────────────────────────────
    zypper)
      log "Memasang nodejs22 via zypper..."
      pm_install nodejs22 npm22 2>/dev/null \
        || pm_install nodejs npm \
        || install_node_via_n
      ;;
    # ── Void Linux ────────────────────────────────────────────────────────────
    xbps)
      log "Memasang nodejs via xbps..."
      pm_install nodejs
      ;;
    # ── Alpine ────────────────────────────────────────────────────────────────
    apk)
      log "Memasang nodejs npm via apk..."
      pm_install nodejs npm
      ;;
    # ── Gentoo ────────────────────────────────────────────────────────────────
    portage)
      log "Memasang nodejs via portage..."
      pm_install net-libs/nodejs
      ;;
    *)
      install_node_via_n
      ;;
  esac
}

ensure_node() {
  local node_maj=0 node_ver=""
  if command -v node >/dev/null 2>&1; then
    node_ver="$(node -v 2>/dev/null || echo v0)"
    node_maj="$(printf '%s' "$node_ver" | sed 's/^v//; s/\..*//')"
    node_maj="${node_maj:-0}"
    if [ "$node_maj" -ge 18 ] && command -v npm >/dev/null 2>&1; then
      ok "Node.js $node_ver sudah terpasang (>=18)."
      return
    fi
    warn "Node.js $node_ver terlalu lama (<18). Upgrade ke Node $NODE_MAJOR..."
  else
    warn "Node.js belum terpasang. Menginstal Node $NODE_MAJOR..."
  fi

  install_node_distro

  # Verifikasi; bila masih <18 → nvm
  node_ver="$(node -v 2>/dev/null || echo v0)"
  node_maj="$(printf '%s' "$node_ver" | sed 's/^v//; s/\..*//')"
  if [ "${node_maj:-0}" -lt 18 ]; then
    warn "Node setelah install masih <18. Fallback ke nvm..."
    $SUDO "${PKG:-apt}" remove -y nodejs npm 2>/dev/null || true
    install_node_via_nvm
  fi

  # Sumber ulang PATH bila node ada di ~/.nvm atau /usr/local
  export PATH="$HOME/.nvm/versions/node/v${NODE_MAJOR}.0/bin:/usr/local/bin:$PATH"
  ok "Node.js: $(node -v 2>/dev/null || echo '?') | npm: $(npm -v 2>/dev/null || echo '?')"
}

# ── 3. Xvfb ──────────────────────────────────────────────────────────────────
install_xvfb() {
  if command -v xvfb-run >/dev/null 2>&1; then
    ok "xvfb-run sudah tersedia."
    return
  fi
  log "Memasang Xvfb (display virtual untuk stealth browser)..."
  case "$PKG" in
    apt)    pm_install xvfb ;;
    dnf|yum)
      # nama paket berbeda per versi RHEL
      pm_install xorg-x11-server-Xvfb 2>/dev/null \
        || pm_install xorg-x11-server 2>/dev/null \
        || warn "Gagal pasang Xvfb — coba: $SUDO dnf install xorg-x11-server-Xvfb"
      # buat wrapper xvfb-run bila belum ada (RHEL 8 kadang tidak menyertakannya)
      if ! command -v xvfb-run >/dev/null 2>&1; then
        $SUDO bash -c 'cat > /usr/local/bin/xvfb-run <<"XRUN"
#!/bin/bash
Xvfb :99 -screen 0 1280x1024x24 &
XVFB_PID=$!
export DISPLAY=:99
"$@"
EXIT_CODE=$?
kill $XVFB_PID 2>/dev/null
exit $EXIT_CODE
XRUN
chmod +x /usr/local/bin/xvfb-run'
      fi
      ;;
    pacman) pm_install xorg-server-xvfb ;;
    zypper)
      pm_install xvfb-run 2>/dev/null \
        || pm_install xorg-x11-server 2>/dev/null \
        || warn "Pasang Xvfb manual: zypper install xvfb-run"
      ;;
    xbps)   pm_install xvfb ;;
    apk)
      pm_install xvfb xvfb-run 2>/dev/null \
        || pm_install xvfb 2>/dev/null \
        || warn "Alpine: xvfb mungkin butuh repo community."
      ;;
    portage) pm_install x11-apps/xdpyinfo x11-base/xorg-server ;;
  esac
  command -v xvfb-run >/dev/null 2>&1 \
    && ok "xvfb-run terpasang." \
    || warn "xvfb-run belum tersedia. Stealth mode membutuhkannya — instal manual jika perlu."
}

# ── 4. npm dependencies ───────────────────────────────────────────────────────
install_npm_deps() {
  log "Menginstal dependency npm project..."
  npm install --no-fund --no-audit
}

# ── 5. Playwright browsers ───────────────────────────────────────────────────
install_playwright() {
  log "Menginstal Playwright browsers + library sistem (chromium, firefox)..."
  case "$PKG" in
    apk)
      warn "Alpine (musl libc) tidak didukung penuh oleh browser bawaan Playwright."
      warn "Browser mungkin gagal berjalan. Gunakan distro glibc (Debian/Ubuntu) untuk hasil terbaik."
      ;;
    portage)
      warn "Gentoo: pastikan USE flags x11 aktif. Playwright mungkin perlu install manual."
      ;;
  esac

  if [ "$SUDO" = "sudo" ]; then
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
      $SUDO --preserve-env=PLAYWRIGHT_BROWSERS_PATH \
      npx playwright install --with-deps chromium firefox 2>&1 \
      || npx playwright install --with-deps chromium firefox 2>&1
  else
    npx playwright install --with-deps chromium firefox 2>&1
  fi
}

# ── 6. (Opsional) pastikan EPEL tersedia di RHEL/CentOS lama ─────────────────
ensure_epel() {
  [ "$PKG" = "yum" ] || [ "$PKG" = "dnf" ] || return 0
  local maj="${OS_VERSION_ID%%.*}"
  if [ "${maj:-0}" -le 9 ] 2>/dev/null && ! rpm -q epel-release >/dev/null 2>&1; then
    log "Mengaktifkan EPEL (Extra Packages for Enterprise Linux)..."
    $SUDO "$PKG" install -y epel-release 2>/dev/null || true
    # RHEL 8/9 butuh crb/powertools
    if [ "${maj:-0}" -ge 8 ]; then
      $SUDO "$PKG" config-manager --set-enabled crb 2>/dev/null \
        || $SUDO "$PKG" config-manager --set-enabled powertools 2>/dev/null || true
    fi
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  echo
  log "=== ChatGPT Signup Bot — Auto Installer ==="
  echo

  detect_os
  detect_pm
  ensure_epel      # RHEL/CentOS: aktifkan EPEL sebelum install paket
  install_base
  ensure_node
  install_xvfb
  install_npm_deps
  install_playwright

  echo
  log "================================================================"
  ok  "Instalasi selesai!"
  log "Jalankan bot dengan:"
  printf "${CYN}    npm start${RST}\n"
  echo
  log "Untuk verifikasi akun setelah pembuatan:"
  printf "${CYN}    xvfb-run -a node src/verify_all.js${RST}\n"
  log "================================================================"
  echo
}

main "$@"
