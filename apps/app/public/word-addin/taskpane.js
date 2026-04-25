/* eslint-disable */
/*
 * Procur Word add-in — vanilla JS taskpane controller.
 *
 * Auth model: paste the long-lived token once, store it in browser
 * localStorage (origin-scoped to app.procur.app, per user/profile).
 * Token never leaves the device except as a Bearer header on API
 * calls back to app.procur.app.
 *
 * IMPORTANT: We deliberately do NOT use Office.context.document.settings
 * — those settings are persisted INSIDE the .docx file and travel with
 * the document. If a user paired in `proposal.docx` and emailed it to a
 * colleague, the colleague's Word would inherit the paired token and
 * impersonate the original user's company. localStorage stays on the
 * user's device.
 */
(function () {
  'use strict';

  // The taskpane is hosted under the same origin as the API. Always
  // call back to the page's own origin — works for prod (app.procur.app),
  // staging previews (vercel.app), and local dev (localhost) without
  // any build pipeline. Previously this was hardcoded to prod, which
  // forced devs to edit the file and broke staging entirely.
  var API_BASE = window.location.origin;

  var TOKEN_SETTING_KEY = 'procurAccessToken';

  var els = {};
  var state = {
    token: null,
    user: null,
    company: null,
    proposals: [],
    selectedProposalId: null,
    lastDraft: null, // { content, section }
  };

  // -----------------------------------------------------------------------
  // Office.js bootstrap
  // -----------------------------------------------------------------------

  Office.onReady(function (info) {
    if (info.host !== Office.HostType.Word) {
      // Add-in shouldn't load in non-Word hosts, but if it does, fail clearly.
      document.body.innerHTML =
        '<p style="padding:20px">Procur for Word only runs inside Microsoft Word.</p>';
      return;
    }
    cacheElements();
    bindEvents();
    showRoot();
    var token = readStoredToken();
    if (token) {
      tryAuth(token).catch(function () {
        showPairing();
      });
    } else {
      showPairing();
    }
  });

  function cacheElements() {
    [
      'root',
      'loading',
      'pairing',
      'tokenInput',
      'pairBtn',
      'pairError',
      'signedIn',
      'userName',
      'companyName',
      'signOutBtn',
      'proposalSelect',
      'sectionSelect',
      'instructionInput',
      'draftBtn',
      'draftStatus',
      'draftOutput',
      'draftHeading',
      'draftMeta',
      'draftContent',
      'insertBtn',
      'copyBtn',
      'insertStatus',
    ].forEach(function (id) {
      els[id] = document.getElementById(id);
    });
  }

  function bindEvents() {
    els.pairBtn.addEventListener('click', onPairClick);
    els.tokenInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') onPairClick();
    });
    els.signOutBtn.addEventListener('click', onSignOut);
    els.proposalSelect.addEventListener('change', onProposalChange);
    els.draftBtn.addEventListener('click', onDraftClick);
    els.insertBtn.addEventListener('click', onInsertClick);
    els.copyBtn.addEventListener('click', onCopyClick);
  }

  // -----------------------------------------------------------------------
  // UI states
  // -----------------------------------------------------------------------

  function showRoot() {
    els.root.classList.remove('hidden');
    els.loading.classList.add('hidden');
  }

  function showPairing() {
    els.pairing.classList.remove('hidden');
    els.signedIn.classList.add('hidden');
  }

  function showSignedIn() {
    els.pairing.classList.add('hidden');
    els.signedIn.classList.remove('hidden');
    els.userName.textContent =
      [state.user.firstName, state.user.lastName].filter(Boolean).join(' ') ||
      state.user.email;
    els.companyName.textContent = state.company.name;
  }

  // -----------------------------------------------------------------------
  // Token storage — browser localStorage on the app.procur.app origin.
  //
  // We deliberately avoid Office.context.document.settings because those
  // are persisted INSIDE the .docx file (CustomXMLParts) and travel with
  // the document. localStorage is origin-scoped to app.procur.app, per
  // user / browser profile, and cannot leak via document sharing.
  //
  // Key is fixed; if the user signs out via the unpair button we clear
  // the entry. Office's WebView2 (Win) / WKWebView (Mac) / Edge (web)
  // all support localStorage normally.
  // -----------------------------------------------------------------------

  function readStoredToken() {
    try {
      return window.localStorage.getItem(TOKEN_SETTING_KEY) || null;
    } catch (e) {
      return null;
    }
  }

  function writeStoredToken(token) {
    try {
      window.localStorage.setItem(TOKEN_SETTING_KEY, token);
    } catch (e) {
      console.warn('localStorage save failed', e);
    }
  }

  function clearStoredToken() {
    try {
      window.localStorage.removeItem(TOKEN_SETTING_KEY);
    } catch (e) {
      // ignore
    }
  }

  // -----------------------------------------------------------------------
  // API
  // -----------------------------------------------------------------------

  function api(path, init) {
    return fetch(API_BASE + path, Object.assign({}, init, {
      headers: Object.assign({}, (init && init.headers) || {}, {
        Authorization: 'Bearer ' + state.token,
        'content-type': 'application/json',
      }),
    })).then(function (res) {
      if (res.status === 401) {
        var err = new Error('unauthorized');
        err.status = 401;
        throw err;
      }
      if (!res.ok) {
        return res.text().then(function (t) {
          var err = new Error('Request failed: ' + res.status + ' ' + (t || ''));
          err.status = res.status;
          throw err;
        });
      }
      return res.json();
    });
  }

  function tryAuth(token) {
    state.token = token;
    return api('/api/word-addin/auth', { method: 'POST' })
      .then(function (data) {
        state.user = data.user;
        state.company = data.company;
        writeStoredToken(token);
        showSignedIn();
        return loadProposals();
      })
      .catch(function (err) {
        clearStoredToken();
        state.token = null;
        throw err;
      });
  }

  function loadProposals() {
    return api('/api/word-addin/proposals').then(function (data) {
      state.proposals = data.proposals || [];
      renderProposals();
    });
  }

  // -----------------------------------------------------------------------
  // Renderers
  // -----------------------------------------------------------------------

  function renderProposals() {
    if (state.proposals.length === 0) {
      els.proposalSelect.innerHTML = '<option value="">— No proposals yet —</option>';
      els.sectionSelect.innerHTML = '';
      return;
    }
    els.proposalSelect.innerHTML = state.proposals
      .map(function (p) {
        return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.title) + '</option>';
      })
      .join('');
    state.selectedProposalId = state.proposals[0].id;
    renderSections();
  }

  function renderSections() {
    var p = state.proposals.find(function (pp) {
      return pp.id === state.selectedProposalId;
    });
    if (!p || p.sections.length === 0) {
      els.sectionSelect.innerHTML =
        '<option value="">— No outline yet — open the proposal in Procur to generate one —</option>';
      return;
    }
    els.sectionSelect.innerHTML = p.sections
      .map(function (s) {
        var label = s.number ? s.number + ' · ' + s.title : s.title;
        return '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(label) + '</option>';
      })
      .join('');
  }

  // -----------------------------------------------------------------------
  // Event handlers
  // -----------------------------------------------------------------------

  function onPairClick() {
    var raw = (els.tokenInput.value || '').trim();
    if (!raw) {
      showPairError('Paste a token from app.procur.app/settings/word-addin.');
      return;
    }
    showPairError(null);
    els.pairBtn.disabled = true;
    tryAuth(raw)
      .catch(function (err) {
        showPairError(
          err.status === 401
            ? 'Token rejected. Make sure it&rsquo;s correct and not revoked.'
            : 'Could not reach Procur — check your network.',
        );
      })
      .finally(function () {
        els.pairBtn.disabled = false;
        els.tokenInput.value = '';
      });
  }

  function showPairError(msg) {
    if (!msg) {
      els.pairError.classList.add('hidden');
      els.pairError.textContent = '';
    } else {
      els.pairError.classList.remove('hidden');
      els.pairError.textContent = msg;
    }
  }

  function onSignOut() {
    clearStoredToken();
    state.token = null;
    state.user = null;
    state.company = null;
    state.proposals = [];
    state.selectedProposalId = null;
    state.lastDraft = null;
    els.draftOutput.classList.add('hidden');
    showPairing();
  }

  function onProposalChange() {
    state.selectedProposalId = els.proposalSelect.value;
    renderSections();
  }

  function onDraftClick() {
    if (!state.selectedProposalId) return;
    var sectionId = els.sectionSelect.value || null;
    var instruction = (els.instructionInput.value || '').trim();
    els.draftBtn.disabled = true;
    els.draftStatus.textContent = 'Drafting (this can take ~20–40s)…';
    els.draftOutput.classList.add('hidden');
    api('/api/word-addin/draft', {
      method: 'POST',
      body: JSON.stringify({
        proposalId: state.selectedProposalId,
        sectionId: sectionId,
        instruction: instruction,
      }),
    })
      .then(function (data) {
        state.lastDraft = data;
        els.draftHeading.textContent =
          (data.section && data.section.number ? data.section.number + ' · ' : '') +
          (data.section ? data.section.title : 'Draft');
        els.draftMeta.textContent =
          (data.wordCount || 0) + ' words' +
          (data.coverageNotes ? ' · ' + data.coverageNotes : '');
        els.draftContent.textContent = data.content || '';
        els.draftOutput.classList.remove('hidden');
        els.draftStatus.textContent = '';
        els.insertStatus.textContent = '';
      })
      .catch(function (err) {
        els.draftStatus.textContent = err.message || 'Draft failed.';
      })
      .finally(function () {
        els.draftBtn.disabled = false;
      });
  }

  function onInsertClick() {
    if (!state.lastDraft || !state.lastDraft.content) return;
    var content = state.lastDraft.content;
    els.insertStatus.textContent = 'Inserting…';
    Word.run(function (context) {
      var range = context.document.getSelection();
      // Replace the user's current selection (or insert at cursor when
      // nothing is selected — Range#insertText with 'Replace' handles both).
      content.split(/\n\s*\n/).forEach(function (para, idx) {
        if (idx === 0) {
          range.insertText(para, 'Replace');
        } else {
          range.insertParagraph(para, 'After');
        }
      });
      return context.sync();
    })
      .then(function () {
        els.insertStatus.textContent = 'Inserted.';
      })
      .catch(function (err) {
        els.insertStatus.textContent = 'Insert failed: ' + (err.message || err);
      });
  }

  function onCopyClick() {
    if (!state.lastDraft || !state.lastDraft.content) return;
    var content = state.lastDraft.content;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(content)
        .then(function () {
          els.insertStatus.textContent = 'Copied to clipboard.';
        })
        .catch(function () {
          fallbackCopy(content);
        });
    } else {
      fallbackCopy(content);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      els.insertStatus.textContent = 'Copied to clipboard.';
    } catch (e) {
      els.insertStatus.textContent = 'Copy failed.';
    }
    document.body.removeChild(ta);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
