  const form = document.getElementById('marginForm');
  const marginTypeSelect = document.getElementById('marginType');
  const marginValueInput = document.getElementById('marginValue');
  const marginValueLabel = document.getElementById('marginValueLabel');
  const minMarginInput = document.getElementById('minMargin');
  const maxMarginInput = document.getElementById('maxMargin');
  const reasonInput = document.getElementById('reason');
  const submitBtn = document.getElementById('submitBtn');
  const currentBanner = document.getElementById('currentBanner');
  const errorBanner = document.getElementById('errorBanner');
  const historyWrap = document.getElementById('historyWrap');

  function escapeHtml(v){ return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function formatINR(n) { return n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN'); }
  function formatDateTime(v) { return v ? new Date(v).toLocaleString() : '—'; }

  function marginValueDisplay(marginType, marginValue) {
    if (marginValue == null) return '—';
    return marginType === 'FIXED' ? formatINR(marginValue) : (Number(marginValue) + '%');
  }

  function updateValueFieldForType() {
    const isPct = marginTypeSelect.value === 'PERCENTAGE';
    marginValueLabel.textContent = 'Margin Value (' + (isPct ? '%' : '₹') + ')';
    marginValueInput.placeholder = isPct ? 'e.g. 10' : 'e.g. 500';
  }
  marginTypeSelect.addEventListener('change', updateValueFieldForType);

  function renderCurrentBanner(cfg) {
    const minMaxNote = cfg.minMargin == null && cfg.maxMargin == null
      ? 'no min/max'
      : 'min ' + (cfg.minMargin != null ? formatINR(cfg.minMargin) : '—') + ', max ' + (cfg.maxMargin != null ? formatINR(cfg.maxMargin) : '—');
    currentBanner.innerHTML = 'Currently: <b>' + escapeHtml(cfg.marginType) + ' ' + escapeHtml(marginValueDisplay(cfg.marginType, cfg.marginValue)) + '</b>, ' + escapeHtml(minMaxNote) +
      '<span class="meta">Last changed by ' + escapeHtml(cfg.updatedBy || '—') + ' on ' + formatDateTime(cfg.updatedAt) + '</span>';
  }

  function renderHistory(history) {
    if (!history || !history.length) {
      historyWrap.innerHTML = '<div class="empty-state">No changes have been recorded yet.</div>';
      return;
    }
    historyWrap.innerHTML = `
      <table>
        <thead><tr><th>When</th><th>Changed By</th><th>Type</th><th>Value</th><th>Min</th><th>Max</th><th>Reason</th></tr></thead>
        <tbody>
          ${history.map(h => `
            <tr>
              <td>${formatDateTime(h.changedAt)}</td>
              <td>${escapeHtml(h.changedBy || '—')}</td>
              <td>${escapeHtml(h.marginType || '—')}</td>
              <td>${escapeHtml(marginValueDisplay(h.marginType, h.marginValue))}</td>
              <td>${h.minMargin != null ? formatINR(h.minMargin) : '—'}</td>
              <td>${h.maxMargin != null ? formatINR(h.maxMargin) : '—'}</td>
              <td class="hist-reason">${escapeHtml(h.reason || '—')}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  function loadConfig() {
    return fetch('/api/admin/margin-config?_=' + Date.now())
      .then(res => res.json())
      .then(cfg => {
        if (cfg.error) throw new Error(cfg.error);
        renderCurrentBanner(cfg);
        renderHistory(cfg.history);
        marginTypeSelect.value = cfg.marginType || 'PERCENTAGE';
        marginValueInput.value = cfg.marginValue != null ? cfg.marginValue : '';
        minMarginInput.value = cfg.minMargin != null ? cfg.minMargin : '';
        maxMarginInput.value = cfg.maxMargin != null ? cfg.maxMargin : '';
        updateValueFieldForType();
      })
      .catch(err => {
        currentBanner.textContent = 'Could not load current margin settings.';
        historyWrap.innerHTML = '<div class="empty-state">' + escapeHtml(err.message || 'Could not load history.') + '</div>';
      });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    errorBanner.style.display = 'none';

    const marginValue = Number(marginValueInput.value);
    if (!marginValueInput.value || !Number.isFinite(marginValue) || marginValue < 0) {
      errorBanner.textContent = 'Enter a valid, non-negative margin value.';
      errorBanner.style.display = 'block';
      return;
    }
    const minMargin = minMarginInput.value.trim() === '' ? null : Number(minMarginInput.value);
    const maxMargin = maxMarginInput.value.trim() === '' ? null : Number(maxMarginInput.value);
    if (minMargin != null && maxMargin != null && minMargin > maxMargin) {
      errorBanner.textContent = 'Minimum margin cannot be greater than maximum margin.';
      errorBanner.style.display = 'block';
      return;
    }

    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';

    fetch('/api/admin/margin-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        marginType: marginTypeSelect.value,
        marginValue,
        minMargin,
        maxMargin,
        reason: reasonInput.value.trim(),
      }),
    })
      .then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not update margin settings.');
        return d;
      })
      .then(() => {
        if (window.LS && LS.showSuccess) LS.showSuccess('Margin settings updated.');
        reasonInput.value = '';
        return loadConfig();
      })
      .catch(err => {
        errorBanner.textContent = err.message;
        errorBanner.style.display = 'block';
      })
      .finally(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      });
  });

  loadConfig();
