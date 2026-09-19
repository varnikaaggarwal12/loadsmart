/**
 * password-toggle.js
 * Adds a Show/Hide (eye icon) button to every <input type="password">
 * on the page. Works automatically for login, registration, reset/change
 * password, confirm password, and any other password fields — no per-page
 * wiring needed. Just include this script on any page that has password
 * inputs.
 *
 * Passwords are masked by default. Clicking the eye toggles the input's
 * type between "password" and "text" and swaps the icon accordingly.
 */
(function () {
  var EYE_OPEN =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/>' +
    '</svg>';

  var EYE_CLOSED =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M3 3l18 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '<path d="M10.6 5.2C11.05 5.07 11.52 5 12 5c7 0 10.5 7 10.5 7-.66 1.32-1.62 2.66-2.86 3.83M6.6 6.6C4.02 8.1 2.3 10.4 1.5 12c0 0 3.5 7 10.5 7 1.62 0 3.03-.37 4.24-.94" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  function injectStyles() {
    if (document.getElementById('pw-toggle-styles')) return;
    var style = document.createElement('style');
    style.id = 'pw-toggle-styles';
    style.textContent =
      '.pw-toggle-wrap{position:relative;display:block;width:100%;}' +
      '.pw-toggle-wrap input.pw-toggle-input{width:100%;box-sizing:border-box;padding-right:42px !important;}' +
      '.pw-toggle-btn{position:absolute;top:50%;right:6px;transform:translateY(-50%);' +
      'display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;' +
      'background:transparent;border:none;cursor:pointer;color:#6b7a72;border-radius:6px;}' +
      '.pw-toggle-btn:hover{color:#2f3d35;background:rgba(0,0,0,0.05);}' +
      '.pw-toggle-btn:focus-visible{outline:2px solid #6b7a72;outline-offset:1px;}' +
      '.pw-toggle-btn svg{width:18px;height:18px;display:block;}' +
      '.pw-toggle-wrap input.pw-toggle-input::-ms-reveal,' +
      '.pw-toggle-wrap input.pw-toggle-input::-ms-clear{display:none;}';
    document.head.appendChild(style);
  }

  function makeToggleButton(input) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle-btn';
    btn.setAttribute('aria-label', 'Show password');
    btn.setAttribute('aria-pressed', 'false');
    // Keep this out of the normal tab flow between password fields so tabbing
    // between form inputs still behaves as users expect.
    btn.tabIndex = -1;
    btn.innerHTML = EYE_OPEN;

    btn.addEventListener('click', function () {
      var showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.innerHTML = showing ? EYE_OPEN : EYE_CLOSED;
      btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      btn.setAttribute('aria-pressed', showing ? 'false' : 'true');
      // Keep focus + caret position in the field after toggling.
      input.focus();
    });

    return btn;
  }

  function wireInput(input) {
    if (input.dataset.pwToggleInit) return;
    input.dataset.pwToggleInit = '1';
    input.classList.add('pw-toggle-input');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');

    var wrap = document.createElement('div');
    wrap.className = 'pw-toggle-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    wrap.appendChild(makeToggleButton(input));
  }

  function initPasswordToggles(root) {
    injectStyles();
    var scope = root || document;
    var inputs = scope.querySelectorAll('input[type="password"]');
    for (var i = 0; i < inputs.length; i++) {
      wireInput(inputs[i]);
    }
  }

  function start() {
    initPasswordToggles(document);

    // Cover fields that get shown/inserted later (e.g. a "forgot password"
    // modal that starts hidden, or fields added dynamically by page JS).
    if (window.MutationObserver) {
      var observer = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var node = added[j];
            if (node.nodeType !== 1) continue;
            if (node.matches && node.matches('input[type="password"]')) {
              wireInput(node);
            } else if (node.querySelectorAll) {
              initPasswordToggles(node);
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // Exposed in case any page wants to manually re-scan after injecting HTML.
  window.initPasswordToggles = initPasswordToggles;
})();
