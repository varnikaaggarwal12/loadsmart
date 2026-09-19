  let allRecords = [];

  function escapeHtml(v){ return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function renderList(records, query) {
    const countLine = document.getElementById('countLine');
    const wrap = document.getElementById('tableWrap');

    if (!allRecords.length) {
      countLine.textContent = 'No complaints yet.';
      wrap.innerHTML = '<div class="empty-state">Nothing here yet — complaints submitted via Services &gt; Complaint will appear automatically.</div>';
      return;
    }
    if (!records.length) {
      countLine.textContent = '0 of ' + allRecords.length + ' complaints match your search.';
      wrap.innerHTML = LS.noResultsHtml('No complaints match "' + escapeHtml(query || '') + '".');
      return;
    }
    countLine.textContent = query
      ? records.length + ' of ' + allRecords.length + ' complaint' + (allRecords.length === 1 ? '' : 's') + ' match your search.'
      : records.length + ' complaint' + (records.length === 1 ? '' : 's') + ' on file.';

    // Backend already sorts newest-first (.sort({createdAt:-1})) — no
    // .reverse() here, so a new complaint lands at the top automatically.
    wrap.innerHTML = '<div class="cmp-card-grid">' + records.map(c => `
      <div class="cmp-card" data-id="${escapeHtml(c.id)}">
        <div class="cmp-top">
          <span class="cmp-id">${escapeHtml(c.id)}</span>
          <span class="cmp-status ${c.status || 'open'}">${c.status || 'open'}</span>
        </div>
        <div class="cmp-email">${escapeHtml(c.email)}</div>
        <div class="cmp-username">
          <span class="cmp-usertype">${c.userType === 'existing' ? 'Registered user' : 'New user'}</span>
          ${c.username ? ' &middot; Username: <b>' + escapeHtml(c.username) + '</b>' : ''}
        </div>
        <div class="cmp-message">${escapeHtml(c.message)}</div>
        <div class="cmp-foot">
          <span>${c.createdAt ? new Date(c.createdAt).toLocaleString() : '—'}</span>
          <button class="cmp-resolve-btn" onclick="toggleResolved('${c.id}', this)" ${c.status === 'resolved' ? 'disabled' : ''}>
            ${c.status === 'resolved' ? 'Resolved' : 'Mark Resolved'}
          </button>
        </div>
      </div>
    `).join('') + '</div>';
  }

  fetch('/api/complaints')
    .then(res => res.json())
    .then(records => {
      allRecords = records;
      renderList(allRecords, '');
    })
    .catch(() => {
      document.getElementById('countLine').textContent = 'Could not load data.';
    });

  LS.wireLocalSearch({
    inputEl: document.getElementById('complaintSearchInput'),
    getRecords: () => allRecords,
    fields: ['id', 'email', 'username', 'message'],
    onResults: (filtered, query) => renderList(filtered, query),
  });

  function toggleResolved(id, btn) {
    btn.disabled = true;
    fetch('/api/complaints/' + id + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    })
      .then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not update status.');
        return d;
      })
      .then(d => {
        const idx = allRecords.findIndex(c => c.id === id);
        if (idx !== -1) allRecords[idx].status = d.status;
        renderList(allRecords, document.getElementById('complaintSearchInput').value.trim());
      })
      .catch(err => { alert(err.message); btn.disabled = false; });
  }
