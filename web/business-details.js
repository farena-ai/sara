// E6 (docs/BUSINESS_TOOLS.md): Settings → You → Business details. What goes at the top of the
// invoices and quotes she makes (name, address, contact, tax ID, a logo from the Library), how to
// pay, the currency, the default tax rate and payment terms. Each person's own (household members
// have their own). The ? tips come from tips.json like every other setting.
import { t } from './naming.js';
import { api, el } from './setup-card.js';

const $ = (sel) => document.querySelector(sel);

export async function loadBusinessDetails() {
  if (!$('#biz-name')) return;
  let r;
  try {
    r = await api('/business');
  } catch {
    return; // not on the demo
  }
  const d = r.details;
  $('#biz-name').value = d.name ?? '';
  $('#biz-email').value = d.email ?? '';
  $('#biz-phone').value = d.phone ?? '';
  $('#biz-tax-id').value = d.taxId ?? '';
  $('#biz-address').value = d.address ?? '';
  $('#biz-payment').value = d.payment ?? '';
  $('#biz-tax').value = String(d.taxRatePct ?? 0);
  $('#biz-due').value = String(d.dueDays ?? 30);
  const cur = $('#biz-currency');
  cur.replaceChildren(...r.currencies.map((c) => Object.assign(el('option', '', c), { value: c })));
  cur.value = d.currency ?? 'USD';
  const logo = $('#biz-logo');
  logo.replaceChildren(Object.assign(el('option', '', t('No logo')), { value: '' }), ...r.pictures.map((p) => Object.assign(el('option', '', p.name), { value: String(p.id) })));
  logo.value = d.logoDocId ? String(d.logoDocId) : '';
  $('#biz-status').textContent = r.pictures.length ? '' : t('To add a logo, put a picture of it in your Library first.');
}

export async function saveBusinessDetails() {
  if (!$('#biz-name')) return;
  const r = await api('/business', {
    method: 'PUT',
    body: {
      name: $('#biz-name').value.trim(),
      email: $('#biz-email').value.trim(),
      phone: $('#biz-phone').value.trim(),
      taxId: $('#biz-tax-id').value.trim(),
      address: $('#biz-address').value.trim(),
      payment: $('#biz-payment').value.trim(),
      currency: $('#biz-currency').value,
      taxRatePct: Number($('#biz-tax').value || 0),
      dueDays: Number($('#biz-due').value || 30),
      logoDocId: $('#biz-logo').value ? Number($('#biz-logo').value) : null,
    },
  });
  $('#biz-tax').value = String(r.details.taxRatePct);
  $('#biz-due').value = String(r.details.dueDays);
}
