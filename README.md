# fomo-desk

Public static front-end for a private iPhone web app. GitHub Pages hosts these files. This repository has no tokens, session keys, or private data paths.

Live site: https://oma4rr.github.io/fomo-desk/

`config.json` will later hold only the public tunnel base URL (updated when that URL changes). The secret data path is never stored in this repo. On the phone, enter it once as a URL fragment (for example `https://oma4rr.github.io/fomo-desk/#<path>`) or in a first-run field; the app combines that path with the public base URL to load live data.
