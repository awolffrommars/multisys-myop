#!/bin/bash
set -e

if [ -z "$1" ]; then
  echo "Usage: ./deploy.sh \"your commit message\""
  exit 1
fi

MSG="$1"

echo ">>> Pushing to GitHub..."
git add .
git commit -m "$MSG"
git push origin main

echo ">>> Pushing to HuggingFace..."
# Save templates before branch switch (git checkout main removes them since hf commits them)
cp "templates/Birthday Poster_Template.png" /tmp/hf-birthday.png
cp "templates/New Employee Poster_Template.png" /tmp/hf-newemployee.png
cp "templates/Work Anniversary_Template.png" /tmp/hf-anniversary.png

git branch -D hf 2>/dev/null || true
git checkout --orphan hf
git lfs track "templates/*.png"
git add .gitattributes
git add .
git add -f "templates/Birthday Poster_Template.png" "templates/New Employee Poster_Template.png" "templates/Work Anniversary_Template.png"
git commit -m "HF deploy"
git push hf hf:main --force
git checkout main

# Restore templates (removed by git checkout since they're not tracked on main)
cp /tmp/hf-birthday.png "templates/Birthday Poster_Template.png"
cp /tmp/hf-newemployee.png "templates/New Employee Poster_Template.png"
cp /tmp/hf-anniversary.png "templates/Work Anniversary_Template.png"

echo ">>> Done. Live at https://awolffrommars-multisys-myop.hf.space"
