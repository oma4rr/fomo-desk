/* Desk app shell. Skeleton: no API calls wired yet. */
async function deskFetch(url, opts = {}) {
  const headers = new Headers(opts.headers || {});
  headers.set("ngrok-skip-browser-warning", "1");
  return fetch(url, { ...opts, headers });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
