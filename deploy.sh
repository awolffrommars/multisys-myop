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
git branch -D hf 2>/dev/null || true
git checkout --orphan hf
git add .
git add -f "templates/Birthday Poster_Template.png" "templates/New Employee Poster_Template.png" "templates/Work Anniversary_Template.png"
git commit -m "HF deploy"
git push hf hf:main --force
git checkout main

echo ">>> Done. Live at https://awolffrommars-multisys-myop.hf.space"
