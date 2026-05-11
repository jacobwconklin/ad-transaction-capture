/**
 * captureGclid.js
 *
 * Paste into WPCode as a JavaScript snippet (type: JavaScript, load as module).
 *
 * What this does:
 *  1. Reads ?gclid=... from the URL; persists it in both localStorage and a
 *     90-day cookie so it survives across pages and storage mechanisms.
 *  2. Populates every input[name="hidden_gclid"] on the page, plus the
 *     WPForms-specific hidden GCLID field configured below.
 *  3. On form submit, intercepts the submission BEFORE WPForms processes it:
 *       a. POSTs { gclid } to the mapping REST API and awaits the response.
 *       b. Server inserts a row and returns { ref_id } (serial PK — no client-side generation).
 *       c. Injects ref_id into the hidden refId field so PHP can pass it to Authorize.net.
 *       d. Re-fires the submit event so WPForms takes over normally.
 *     On API failure the form still submits — payment is never blocked for analytics.
 *
 * Replace every UPPER_CASE placeholder before deploying.
 * API key is stored server-side in saveGclid.php — not exposed in page source.
 */

// ─── Configuration ────────────────────────────────────────────────────────
const CONFIG = {
  formId:       'FORM_ID',          // WPForms numeric form ID
  refIdFieldId: 'REF_ID_FIELD_ID',  // Numeric field ID of the hidden Ref ID field
};

const STORAGE_KEY = 'gclid';
const COOKIE_DAYS = 90;
// ──────────────────────────────────────────────────────────────────────────

// ── Storage helpers ───────────────────────────────────────────────────────

const setCookie = (name, value, days) => {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = name + '=' + encodeURIComponent(value) +
    '; expires=' + expires + '; path=/; SameSite=Lax';
};

const getCookie = (name) => {
  const match = document.cookie.match(
    new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)')
  );
  return match ? decodeURIComponent(match[1]) : null;
};

const saveGclid = (gclid) => {
  try { localStorage.setItem(STORAGE_KEY, gclid); } catch (e) {}
  setCookie(STORAGE_KEY, gclid, COOKIE_DAYS);
};

const loadGclid = () => {
  let value = null;
  try { value = localStorage.getItem(STORAGE_KEY); } catch (e) {}
  return value || getCookie(STORAGE_KEY) || null;
};

// ── URL capture ───────────────────────────────────────────────────────────

const readGclidFromUrl = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get('gclid') || null;
};

// ── WPForms helpers ───────────────────────────────────────────────────────

const getFormField = (formId, fieldId) =>
  document.getElementById('wpforms-' + formId + '-field_' + fieldId);

// POSTs { gclid } to the PHP proxy, which forwards to the mapping API server-side.
export const saveMapping = (gclid) =>
  fetch('/wp-json/gclid/v1/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gclid }),
  })
    .then((res) => {
      if (!res.ok) throw new Error('Mapping API returned HTTP ' + res.status);
      return res.json();
    })
    .then((data) => String(data.ref_id));

// ── Field population ──────────────────────────────────────────────────────

// Populates any generic input[name="hidden_gclid"] fields across the page.
const populateHiddenFields = (gclid) => {
  document.querySelectorAll('input[name="hidden_gclid"]').forEach((field) => {
    field.value = gclid;
  });
};

// ── Init (runs once DOM is ready) ─────────────────────────────────────────

const init = (gclid) => {
  // Broad population for any generic hidden_gclid inputs.
  populateHiddenFields(gclid);
  // Run again after a short delay to catch fields WPForms injects after render.
  setTimeout(() => { populateHiddenFields(gclid); }, 500);

  // Find the target form.
  const form = document.getElementById('wpforms-form-' + CONFIG.formId);
  if (!form) return;

  // Intercept submit in capture phase so we fire before WPForms' bubble-phase listener.
  let intercepted = false;

  form.addEventListener('submit', (e) => {

    // Second pass: WPForms is now taking over — let it through.
    if (intercepted) return;

    const currentGclid = loadGclid() || '';

    // No GCLID — nothing to track, submit normally.
    if (!currentGclid) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    saveMapping(currentGclid)
      .then((refId) => {
        const refIdField = getFormField(CONFIG.formId, CONFIG.refIdFieldId);
        if (refIdField) refIdField.value = refId;
      })
      .catch((err) => {
        console.warn('[gclid] Mapping save failed — proceeding without refId:', err);
      })
      .then(() => {
        intercepted = true;
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

  }, true);
};

// ── Main ──────────────────────────────────────────────────────────────────

// URL gclid takes precedence and resets storage (handles a new ad click with a different gclid).
const fromUrl = readGclidFromUrl();
if (fromUrl) saveGclid(fromUrl);

const gclid = loadGclid();
if (gclid) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(gclid); });
  } else {
    init(gclid);
  }

  // Also run when WPForms fires its own ready event (may fire after DOMContentLoaded).
  document.addEventListener('wpformsReady', () => { populateHiddenFields(gclid); });
}
