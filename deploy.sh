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
# Save all template PNGs before branch switch (gitignored on main, tracked on hf)
cp "templates/Birthday Poster_Template.png"       /tmp/hf-birthday.png
cp "templates/New Employee Poster_Template.png"   /tmp/hf-newemployee.png
cp "templates/Work Anniversary_Template.png"      /tmp/hf-anniversary.png
cp "templates/Calling-Card-FRONT_Template.png"    /tmp/hf-cc-front.png
cp "templates/Calling-Card-BACK_Template.png"     /tmp/hf-cc-back.png
cp "templates/Multsys-ID-FRONT_Template.png"      /tmp/hf-id-front.png
cp "templates/Multsys-ID-BACK_Template.png"       /tmp/hf-id-back.png

git branch -D hf 2>/dev/null || true
git checkout --orphan hf
git lfs track "templates/*.png"
git add .gitattributes
git add .
git add -f \
  "templates/Birthday Poster_Template.png" \
  "templates/New Employee Poster_Template.png" \
  "templates/Work Anniversary_Template.png" \
  "templates/Calling-Card-FRONT_Template.png" \
  "templates/Calling-Card-BACK_Template.png" \
  "templates/Multsys-ID-FRONT_Template.png" \
  "templates/Multsys-ID-BACK_Template.png"
git commit -m "HF deploy"
git push hf hf:main --force
git checkout main

# Restore templates (removed by git checkout since they're gitignored on main)
cp /tmp/hf-birthday.png   "templates/Birthday Poster_Template.png"
cp /tmp/hf-newemployee.png "templates/New Employee Poster_Template.png"
cp /tmp/hf-anniversary.png "templates/Work Anniversary_Template.png"
cp /tmp/hf-cc-front.png   "templates/Calling-Card-FRONT_Template.png"
cp /tmp/hf-cc-back.png    "templates/Calling-Card-BACK_Template.png"
cp /tmp/hf-id-front.png   "templates/Multsys-ID-FRONT_Template.png"
cp /tmp/hf-id-back.png    "templates/Multsys-ID-BACK_Template.png"

echo ">>> Done. Live at https://awolffrommars-multisys-myop.hf.space"
