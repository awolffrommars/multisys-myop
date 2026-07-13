#!/bin/bash
set -e

if [ -z "$1" ]; then
  echo "Usage: ./deploy.sh \"your commit message\""
  exit 1
fi

MSG="$1"

TEMPLATES=(
  "templates/Birthday Poster_Template.png"
  "templates/New Employee Poster_Template.png"
  "templates/Work Anniversary_Template.png"
  "templates/Calling-Card-FRONT_Template.png"
  "templates/Calling-Card-BACK_Template.png"
  "templates/Multsys-ID-FRONT_Template.png"
  "templates/Multsys-ID-BACK_Template.png"
)

# Back up template PNGs to a session temp dir (gitignored on main, tracked on hf;
# git checkout deletes them from the working tree)
BACKUP_DIR="$(mktemp -d)"
for t in "${TEMPLATES[@]}"; do
  cp "$t" "$BACKUP_DIR/$(basename "$t")"
done

# Recovery: whatever happens mid-script, always end up back on main with the
# template PNGs restored — a failed HF push must never strand the repo on the
# orphan branch or lose the PNGs
restore() {
  git checkout main 2>/dev/null || git checkout -f main 2>/dev/null || true
  for t in "${TEMPLATES[@]}"; do
    [ -f "$t" ] || cp "$BACKUP_DIR/$(basename "$t")" "$t" 2>/dev/null || true
  done
}
trap restore EXIT

echo ">>> Pushing to GitHub..."
git add .
git diff --cached --quiet || git commit -m "$MSG"
git push origin main

echo ">>> Pushing to HuggingFace..."
# Ensure we're on main before deleting hf (can't delete the checked-out branch —
# a stranded previous run may have left us on it)
git checkout main 2>/dev/null || true
git branch -D hf 2>/dev/null || true
git checkout --orphan hf
git lfs track "templates/*.png"
git add .gitattributes
git add .
for t in "${TEMPLATES[@]}"; do
  git add -f "$t"
done
git commit -m "HF deploy"
git push hf hf:main --force
git checkout main

# trap also restores on success; clean up the backup afterwards
restore
trap - EXIT
rm -rf "$BACKUP_DIR"

echo ">>> Done. Live at https://awolffrommars-multisys-myop.hf.space"
