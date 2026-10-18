# Gram Tracker

Offline calorie tracker for people who weigh everything: bowl tare subtraction, recipes per 100 g cooked,
and on-device reading of nutrition labels and product names. Your data never leaves the phone.

- `app/` – the app itself (HTML/JS, works offline; label reading uses bundled Tesseract)
- `android/` – the Android shell that bundles `app/` and installs updates from this repo
- `updates/manifest.json` – the latest version; the app's **Settings → Check for updates** reads it

Updates: `python release.py X.Y.Z "notes"` then `python publish.py`.
