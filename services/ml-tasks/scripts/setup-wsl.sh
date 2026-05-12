#!/usr/bin/env bash
# One-shot WSL2 setup for the procur ML GPU rig.
#
# Usage from WSL (Ubuntu):
#   bash /mnt/c/Users/<you>/procur_dashboard/services/ml-tasks/scripts/setup-wsl.sh
#
# Idempotent — safe to re-run. Skips steps that are already done.

set -euo pipefail

REPO_URL="https://github.com/cjkootch/procur_dashboard"
BRANCH="claude/trigger-project-ref"
REPO_DIR="$HOME/procur_dashboard"
WINDOWS_REPO="/mnt/c/Users/colek/procur_dashboard"

say() { printf "\n\033[1;36m→ %s\033[0m\n" "$*"; }

say "Procur GPU rig WSL setup"

# --- 1. System deps ---
say "Installing system packages (sudo)"
sudo apt update
sudo apt install -y curl git build-essential python3.10-venv

# --- 2. Node via nvm ---
if [ ! -d "$HOME/.nvm" ]; then
  say "Installing nvm"
  curl -sSf -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
fi
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if ! nvm ls 22 &> /dev/null; then
  say "Installing Node 22"
  nvm install 22
fi
nvm use 22

# --- 3. pnpm ---
if ! command -v pnpm &> /dev/null; then
  say "Installing pnpm 10"
  npm install -g pnpm@10
fi

say "Versions"
echo "  node:  $(node -v)"
echo "  pnpm:  $(pnpm -v)"

# --- 4. Clone repo ---
if [ ! -d "$REPO_DIR" ]; then
  say "Cloning repo"
  cd "$HOME"
  git clone "$REPO_URL"
fi
cd "$REPO_DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull origin "$BRANCH"

say "pnpm install"
pnpm install

# --- 5. Copy .env.local from Windows side ---
if [ -f "$WINDOWS_REPO/.env.local" ] && [ ! -f "$REPO_DIR/.env.local" ]; then
  say "Copying .env.local from Windows checkout"
  cp "$WINDOWS_REPO/.env.local" "$REPO_DIR/.env.local"
elif [ ! -f "$REPO_DIR/.env.local" ]; then
  echo "  (no .env.local found at $WINDOWS_REPO — you'll need to create $REPO_DIR/.env.local manually)"
fi

# --- 6. Python venv ---
ML_DIR="$REPO_DIR/services/ml-training"
cd "$ML_DIR"
if [ ! -d .venv ]; then
  say "Creating Python venv"
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

say "Installing Python deps (.[bge])"
pip install --upgrade pip
pip install -e '.[bge]'

say "Installing CUDA torch (cu126)"
pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cu126

# --- 7. Verify ---
say "Verifying torch + CUDA"
python -c "import torch; print(f'torch={torch.__version__} cuda={torch.cuda.is_available()} count={torch.cuda.device_count()}')"

cat <<'EOF'

═══ Setup complete ═══

Next:
  cd ~/procur_dashboard/services/ml-tasks
  npx trigger.dev@latest dev --skip-update-check

Watch for 'Local worker ready', then trigger ml.entity-embed from
the Trigger.dev dashboard.
EOF
