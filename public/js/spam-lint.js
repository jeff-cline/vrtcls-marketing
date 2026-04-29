// Live spam-risk linter for the template editor.
// Pure client-side. Attaches window.SpamLint.check(opts) -> { score, label, color, issues, counts }.
// Rules are tuned for the kind of warmed-mailbox 1:1-style outreach this app sends —
// false positives bias toward "warn early" since the cost of landing in spam is high.

(function () {
  const SPAMMY_PHRASES = [
    'free', 'guarantee', 'guaranteed', 'act now', 'limited time', 'click here',
    'buy now', 'order now', 'urgent', '100% free', 'risk free', 'risk-free',
    'cash bonus', 'winner', 'congratulations', 'as seen on', 'no obligation',
    'no fees', 'double your', 'earn money', 'make money', 'work from home',
    'lowest price', 'best price', 'offer expires', 'call now', 'only $',
    'this isn\'t spam', 'dear friend', 'dear customer', 'viagra'
  ];

  function stripTags(html) {
    return String(html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hostnameOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return null; }
  }

  function check(opts) {
    const subject = (opts && opts.subject) || '';
    const body = (opts && opts.body) || '';
    const fromDomain = (opts && opts.fromDomain) ? String(opts.fromDomain).replace(/^www\./, '') : null;
    const issues = [];

    // ---------- SUBJECT ----------
    if (!subject.trim()) {
      issues.push({ sev: 'high', msg: 'Subject is empty.' });
    } else {
      if (subject.length > 70) {
        issues.push({ sev: 'low', msg: `Subject is ${subject.length} chars. Most clients truncate after ~50–60.` });
      }
      const capWords = subject.match(/\b[A-Z]{3,}\b/g) || [];
      if (capWords.length) {
        issues.push({ sev: 'med', msg: `ALL-CAPS in subject: ${capWords.slice(0, 3).join(', ')}` });
      }
      if (/!{2,}/.test(subject)) issues.push({ sev: 'med', msg: 'Multiple "!" in subject.' });
      if (/^\s*(re:|fwd?:)/i.test(subject)) issues.push({ sev: 'high', msg: 'Subject starts with "Re:" / "Fwd:" — fake-reply trick is a known spam signal.' });
      if (/\$/.test(subject)) issues.push({ sev: 'med', msg: 'Dollar sign in subject scores spammy.' });
      if (/100\s*%/.test(subject)) issues.push({ sev: 'med', msg: '"100%" in subject scores spammy.' });
      const subjLower = subject.toLowerCase();
      const subjHits = SPAMMY_PHRASES.filter((p) => subjLower.includes(p));
      if (subjHits.length) {
        issues.push({ sev: 'med', msg: `Spammy phrase(s) in subject: ${subjHits.slice(0, 3).join(', ')}` });
      }
    }

    // ---------- BODY (text) ----------
    const bodyText = stripTags(body);
    if (!bodyText) {
      issues.push({ sev: 'high', msg: 'Body has no readable text after stripping HTML.' });
    } else {
      if (bodyText.length < 200) {
        issues.push({ sev: 'low', msg: `Body is only ${bodyText.length} chars of text. Very short emails can score spammy unless clearly 1:1.` });
      }
      const bodyLower = bodyText.toLowerCase();
      const bodyHits = SPAMMY_PHRASES.filter((p) => bodyLower.includes(p));
      if (bodyHits.length >= 3) {
        issues.push({ sev: 'high', msg: `${bodyHits.length} spammy phrases in body: ${bodyHits.slice(0, 5).join(', ')}…` });
      } else if (bodyHits.length) {
        issues.push({ sev: 'med', msg: `Spammy phrase(s) in body: ${bodyHits.join(', ')}` });
      }
      const exclam = (bodyText.match(/!/g) || []).length;
      if (exclam > 5) issues.push({ sev: 'med', msg: `${exclam} exclamation marks in body — drop most.` });
      const capRuns = bodyText.match(/\b[A-Z]{4,}\b/g) || [];
      if (capRuns.length) issues.push({ sev: 'med', msg: `ALL-CAPS run(s) in body: ${capRuns.slice(0, 3).join(', ')}` });
    }

    // ---------- LINKS ----------
    const links = [...body.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)];
    if (links.length > 6) {
      issues.push({ sev: 'med', msg: `${links.length} links in body — high link count is a spam signal. Aim for 1–3.` });
    }

    // ---------- IMAGES ----------
    const imgs = [...body.matchAll(/<img\b[^>]*src=["']([^"']+)["']/gi)];
    if (imgs.length) {
      const externals = imgs.filter((m) => /^https?:\/\//i.test(m[1]));
      if (externals.some((m) => /placehold\.co|placeholder\.com|via\.placeholder/i.test(m[1]))) {
        issues.push({ sev: 'high', msg: 'Placeholder image (placehold.co) — replace or remove before sending.' });
      }
      if (externals.length && fromDomain) {
        const offDomain = externals.filter((m) => {
          const h = hostnameOf(m[1]);
          return h && h !== fromDomain;
        });
        if (offDomain.length) {
          issues.push({
            sev: 'high',
            msg: `${offDomain.length} image(s) hosted off-domain (not on ${fromDomain}). Gmail will show "third-party content needs to load" — the warning that hurts your inbox placement.`,
          });
        }
      } else if (externals.length) {
        issues.push({
          sev: 'med',
          msg: `${externals.length} external image(s). If they\'re not on your sending domain, Gmail will warn "third-party content needs to load".`,
        });
      }
      if (imgs.length >= 2 && bodyText.length < 300) {
        issues.push({ sev: 'med', msg: `Image-heavy with little text (${imgs.length} images, ${bodyText.length} chars of text). Image-only emails score spammy.` });
      }
    }

    // ---------- HIDDEN TEXT / DEPRECATED ----------
    if (/color\s*:\s*#?(fff(fff)?|white)/i.test(body) && /background[^;"']*:\s*#?(fff(fff)?|white)/i.test(body)) {
      issues.push({ sev: 'high', msg: 'White-on-white styling detected — classic hidden-text trigger.' });
    }
    if (/<font\b/i.test(body)) {
      issues.push({ sev: 'low', msg: '<font> is deprecated — use inline <span style> instead.' });
    }

    // ---------- CTA TRACKING (informational) ----------
    const aTags = [...body.matchAll(/<a\b([^>]*)href=["'][^"']+["']([^>]*)>/gi)];
    if (aTags.length) {
      const tracked = aTags.filter((m) => /data-link-key=/i.test((m[1] || '') + (m[2] || '')));
      if (tracked.length === 0) {
        issues.push({ sev: 'low', msg: 'No <a> has data-link-key — clicks will hash to a random key on the dashboard.' });
      }
    }

    // ---------- Score ----------
    const counts = { high: 0, med: 0, low: 0 };
    issues.forEach((i) => { if (counts[i.sev] != null) counts[i.sev]++; });
    let score, label, color;
    if (counts.high >= 1 || counts.med >= 4) {
      score = 'poor'; label = 'High spam risk'; color = 'danger';
    } else if (counts.med >= 1 || counts.low >= 3) {
      score = 'fair'; label = 'Some risk — review'; color = 'warning';
    } else {
      score = 'good'; label = 'Looks clean'; color = 'success';
    }
    return { score, label, color, issues, counts };
  }

  // Render a Bootstrap-styled panel into a target element.
  function renderInto(el, result) {
    if (!el) return;
    const sevBadge = (s) => ({ high: 'danger', med: 'warning', low: 'secondary' }[s] || 'secondary');
    const sevLabel = (s) => ({ high: 'High', med: 'Med', low: 'Low' }[s] || s);
    const items = result.issues.length === 0
      ? '<li class="text-success small">No issues detected. Looks like a clean send.</li>'
      : result.issues.map((i) => (
          `<li class="small mb-1"><span class="badge bg-${sevBadge(i.sev)} me-2" style="font-size:10px;">${sevLabel(i.sev)}</span>${escapeHtml(i.msg)}</li>`
        )).join('');
    el.innerHTML = `
      <div class="d-flex align-items-center gap-2 mb-2">
        <span class="badge bg-${result.color} fw-bold" style="font-size:12px;">Spam check: ${result.label}</span>
        <span class="text-muted small">
          ${result.counts.high} high · ${result.counts.med} medium · ${result.counts.low} low
        </span>
      </div>
      <ul class="list-unstyled mb-0">${items}</ul>
    `;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Auto-wire any element with [data-spam-panel] to its sibling subject/body fields.
  // Convention: data-spam-panel="ID" pairs with input[name="subject"] and textarea[name="body_html"]
  // inside the same <form>.
  function autoWire(root) {
    root = root || document;
    root.querySelectorAll('[data-spam-panel]').forEach((panel) => {
      const form = panel.closest('form');
      if (!form) return;
      const subjEl = form.querySelector('input[name="subject"]');
      const bodyEl = form.querySelector('textarea[name="body_html"]');
      const fromDomain = panel.getAttribute('data-from-domain') || null;
      const update = () => {
        const result = check({
          subject: subjEl ? subjEl.value : '',
          body: bodyEl ? bodyEl.value : '',
          fromDomain,
        });
        renderInto(panel, result);
      };
      if (subjEl) subjEl.addEventListener('input', update);
      if (bodyEl) bodyEl.addEventListener('input', update);
      update();
    });
  }

  window.SpamLint = { check, renderInto, autoWire };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { autoWire(); });
  } else {
    autoWire();
  }
})();
