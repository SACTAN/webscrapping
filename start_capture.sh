#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  start_capture.sh
#  Double-click (Mac) or run directly (Linux) to launch the HTML Capture Utility.
#  Place this file in the SAME folder as capture.js
#
#  Mac setup (one time): right-click → Open With → Terminal
#  Then macOS will allow double-click in future.
# ─────────────────────────────────────────────────────────────────────────────

# Move to the folder where this script lives
cd "$(dirname "$0")"

echo ""
echo " ============================================================"
echo "  HTML Capture Utility  -  Starting..."
echo " ============================================================"
echo ""

# ── Check Node.js ─────────────────────────────────────────────────────────────
if ! command -v node &> /dev/null; then
    echo " [ERROR] Node.js is NOT installed."
    echo ""
    echo " Install it from https://nodejs.org  (LTS version, 18+)"
    echo " Or via Homebrew on Mac:  brew install node"
    echo ""
    read -p " Press Enter to exit..."
    exit 1
fi

NODE_VER=$(node -v)
echo " Node.js version : $NODE_VER"

# ── Auto-install dependencies if missing ─────────────────────────────────────
if [ ! -d "node_modules" ]; then
    echo ""
    echo " [SETUP] node_modules not found. Running npm install..."
    echo " (This happens only once)"
    echo ""
    npm install playwright
    if [ $? -ne 0 ]; then
        echo " [ERROR] npm install failed. Check your internet connection."
        read -p " Press Enter to exit..."
        exit 1
    fi
    echo ""
    echo " [SETUP] Installing Chromium browser..."
    npx playwright install chromium
    if [ $? -ne 0 ]; then
        echo " [ERROR] Chromium install failed."
        read -p " Press Enter to exit..."
        exit 1
    fi
    echo ""
    echo " [SETUP] Setup complete!"
    echo ""
fi

# ── Create output folder if missing ──────────────────────────────────────────
mkdir -p src/resources/html-pages

# ── Launch ────────────────────────────────────────────────────────────────────
echo " Output folder : $(pwd)/src/resources/html-pages/"
echo " Browser       : Chromium (Playwright)"
echo ""
echo " ============================================================"
echo "  Browser is opening... Navigate to any page."
echo "  Click the [Capture HTML] button for a manual snapshot."
echo "  Press Ctrl+C in this window to stop."
echo " ============================================================"
echo ""

node src/capture.js

echo ""
echo " [STOPPED] Capture utility has exited."
read -p " Press Enter to close..."
