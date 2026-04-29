// Handlebars-lite variable substitution for email templates
export function substitute(text, vars) {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const val = key.split('.').reduce((o, k) => (o == null ? o : o[k]), vars);
    return val == null ? '' : String(val);
  });
}

// Link rewriting: replace every <a href="..."> with tracked URL /c/:sendId/:linkKey
// data-link-key="slug" on the <a> tag chooses the key; otherwise it's hashed.
import crypto from 'node:crypto';

export function rewriteLinks(html, { sendId, baseUrl }) {
  return html.replace(
    /<a\b([^>]*?)\shref=(['"])([^'"]+)\2([^>]*)>/gi,
    (_m, pre, q, href, post) => {
      const keyMatch = (pre + post).match(/data-link-key=(['"])([\w-]+)\1/i);
      const linkKey = keyMatch
        ? keyMatch[2]
        : crypto.createHash('md5').update(href).digest('hex').slice(0, 8);
      const tracked = `${baseUrl}/c/${sendId}/${encodeURIComponent(linkKey)}?u=${encodeURIComponent(href)}`;
      return `<a${pre} href=${q}${tracked}${q}${post}>`;
    }
  );
}

export function injectPixel(html, { sendId, baseUrl }) {
  const pixel = `<img src="${baseUrl}/p/${sendId}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;">`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${pixel}</body>`);
  return html + pixel;
}

export function canSpamFooter(address, unsubUrl) {
  return `
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e5e5;color:#888;font-size:12px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
    <div>${address}</div>
    <div style="margin-top:6px;"><a href="${unsubUrl}" style="color:#888;">Unsubscribe</a></div>
  </div>`;
}

// Best-effort HTML → plain text. Sent as the multipart/alternative text part —
// HTML-only emails are a strong spam signal even from warmed mailboxes.
export function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, '\n')
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+/gm, '')
    .trim();
}
