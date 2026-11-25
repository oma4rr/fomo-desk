# fomo-desk

Public static front-end for a private iPhone web app. GitHub Pages hosts these files. This repository has no tokens, session keys, or private data paths.

Live site: https://oma4rr.github.io/fomo-desk/

`config.json` holds only the public tunnel base URL (updated when that URL changes). The secret data path is never stored in this repo. On the phone, enter it once as a URL fragment (`https://oma4rr.github.io/fomo-desk/#d=<key>`); the app keeps it on the phone, removes it from the address bar, and combines that path with the public base URL to load live data.
