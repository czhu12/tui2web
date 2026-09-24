// Small server-rendered pages: login, and "not found / ended" messages.

let siteUrl = 'http://localhost:8787';

/** Absolute base URL, needed for link-preview image tags. */
export function setSiteUrl(url: string) {
  siteUrl = url;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} · tui2web</title>
<meta property="og:site_name" content="tui2web">
<meta property="og:title" content="tui2web terminal session">
<meta property="og:description" content="A private link to a live terminal session. Open it to view and control the terminal.">
<meta property="og:image" content="${siteUrl}/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
  :root { --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --accent: #3fb950; --danger: #f85149; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: var(--bg); color: var(--text);
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; padding: 16px; }
  main { width: 100%; max-width: 380px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { color: var(--muted); margin: 0 0 16px; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 14px; color: var(--text); word-break: break-all; }
  label { display: block; font-size: 14px; color: var(--muted); margin-bottom: 6px; }
  input { width: 100%; padding: 12px; font-size: 16px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); }
  input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  button { width: 100%; margin-top: 12px; padding: 12px; font-size: 16px; font-weight: 600; border: 0; border-radius: 8px; background: var(--accent); color: #04260f; }
  .error { color: var(--danger); margin: 0 0 12px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function loginPage(opts: { sessionId: string; command: string; passwordEnabled: boolean; error: string | null }): string {
  const what = opts.passwordEnabled ? 'Password or token' : 'Token';
  const hint = opts.passwordEnabled
    ? 'Enter the password you set with <code>tui2web set-password</code>, or the token from the link printed in your terminal.'
    : 'Paste the token from the link printed in your terminal.';
  return layout(
    'Sign in',
    `<h1>Sign in</h1>
<p><code>${escapeHtml(opts.command)}</code></p>
<p>${hint}</p>
${opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : ''}
<form method="post" action="/session/${opts.sessionId}/login">
  <label for="secret">${what}</label>
  <input id="secret" name="secret" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">Open session</button>
</form>`,
  );
}

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
