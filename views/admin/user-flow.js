  let allSessions = [];
  let view = 'list'; // 'list' | 'detail'
  let detailSessionId = null;

  function escapeHtml(v){ return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function timeAgo(date) {
    const diffMs = Date.now() - new Date(date).getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.round(hours / 24) + 'd ago';
  }

  function renderStats(sessions) {
    document.getElementById('statTotalSessions').textContent = sessions.length;
    const recentCutoff = Date.now() - 30 * 60 * 1000;
    document.getElementById('statRecentSessions').textContent =
      sessions.filter(s => new Date(s.lastActivity).getTime() >= recentCutoff).length;
    document.getElementById('statLoggedOut').textContent = sessions.filter(s => s.loggedOut).length;
  }

  function renderList(sessions, query) {
    const root = document.getElementById('viewRoot');
    const countLine = document.getElementById('countLine');

    if (!allSessions.length) {
      countLine.textContent = 'No sessions recorded yet.';
      root.innerHTML = '<div class="empty-state">Nothing here yet — activity will appear automatically once visitors interact with the cookie-consent popup and browse the site.</div>';
      return;
    }
    if (!sessions.length) {
      countLine.textContent = '0 of ' + allSessions.length + ' sessions match your search.';
      root.innerHTML = LS.noResultsHtml('No sessions match "' + escapeHtml(query || '') + '".');
      return;
    }
    countLine.textContent = query
      ? sessions.length + ' of ' + allSessions.length + ' sessions match your search.'
      : sessions.length + ' session' + (sessions.length === 1 ? '' : 's') + ' on file.';

    root.innerHTML = '<div class="session-card-grid">' + sessions.map(s => `
      <div class="session-card" data-id="${escapeHtml(s.sessionId)}">
        <div class="sess-top">
          <span class="sess-user">${escapeHtml(s.username || 'Anonymous visitor')}</span>
          <span class="sess-usertype ${s.userType === 'anonymous' || !s.userType ? 'anonymous' : ''}">${escapeHtml(s.userType || 'anonymous')}</span>
        </div>
        <div class="sess-route">${escapeHtml(s.firstPage || '—')} → <b>${escapeHtml(s.lastPage || '—')}</b></div>
        <div class="sess-bottom">
          <span>${s.eventCount} event${s.eventCount === 1 ? '' : 's'} · last activity ${timeAgo(s.lastActivity)}</span>
          ${s.loggedOut ? '<span class="sess-logout-chip">Logged out</span>' : ''}
        </div>
      </div>
    `).join('') + '</div>';

    root.querySelectorAll('.session-card').forEach(card => {
      card.addEventListener('click', () => {
        view = 'detail';
        detailSessionId = card.getAttribute('data-id');
        loadDetail(detailSessionId);
      });
    });
  }

  function loadDetail(sessionId) {
    const root = document.getElementById('viewRoot');
    document.getElementById('countLine').textContent = '';
    root.innerHTML = '<div class="empty-state">Loading timeline…</div>';
    fetch('/api/admin/user-flow/' + encodeURIComponent(sessionId))
      .then(res => res.json())
      .then(events => renderDetail(sessionId, events))
      .catch(() => { root.innerHTML = '<div class="empty-state">Could not load this session\'s timeline.</div>'; });
  }

  function renderDetail(sessionId, events) {
    const root = document.getElementById('viewRoot');
    const summary = allSessions.find(s => s.sessionId === sessionId) || {};
    const first = events[0];
    const last = events[events.length - 1];

    root.innerHTML = `
      <button type="button" class="back-to-list-btn" id="ufBackBtn">← Back to all sessions</button>

      <div class="session-detail-head">
        <div>
          <h2>${escapeHtml(summary.username || 'Anonymous visitor')}</h2>
          <div class="sub">${escapeHtml(summary.userType || 'anonymous')} · Session ID <span style="font-family:monospace;">${escapeHtml(sessionId)}</span></div>
        </div>
        <div class="session-detail-stats">
          <div><b>${events.length}</b>Events</div>
          <div><b>${first ? new Date(first.timestamp).toLocaleTimeString() : '—'}</b>Started</div>
          <div><b>${last ? new Date(last.timestamp).toLocaleTimeString() : '—'}</b>Last activity</div>
        </div>
      </div>

      <div class="timeline">
        ${events.map(e => `
          <div class="timeline-row">
            <div class="timeline-time">${new Date(e.timestamp).toLocaleString()}</div>
            <div class="timeline-body">
              <div class="timeline-event event-${escapeHtml(e.eventType)}">${escapeHtml(e.eventType)}${e.action ? ' — ' + escapeHtml(e.action) : ''}</div>
              <div class="timeline-meta">
                ${e.page ? 'Page: ' + escapeHtml(e.page) : ''}
                ${e.previousPage ? ' · From: ' + escapeHtml(e.previousPage) : ''}
                ${e.metadata && Object.keys(e.metadata).length ? ' · ' + Object.entries(e.metadata).map(([k,v]) => escapeHtml(k) + '=' + escapeHtml(v)).join(', ') : ''}
              </div>
            </div>
          </div>
        `).join('') || '<div class="empty-state">No events recorded for this session.</div>'}
      </div>
    `;

    document.getElementById('ufBackBtn').addEventListener('click', () => {
      view = 'list'; detailSessionId = null;
      renderList(allSessions, document.getElementById('sessionSearchInput').value.trim());
    });
  }

  fetch('/api/admin/user-flow/sessions')
    .then(res => res.json())
    .then(sessions => {
      allSessions = sessions;
      renderStats(allSessions);
      renderList(allSessions, '');
    })
    .catch(() => {
      document.getElementById('countLine').textContent = 'Could not load data.';
    });

  LS.wireLocalSearch({
    inputEl: document.getElementById('sessionSearchInput'),
    getRecords: () => allSessions,
    fields: ['username', 'sessionId', 'userType', 'firstPage', 'lastPage'],
    onResults: (filtered, query) => {
      if (view === 'detail') return; // don't disturb an open detail view
      renderList(filtered, query);
    },
  });
