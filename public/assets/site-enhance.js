/**
 * site-enhance.js
 * Load Smart — premium interactive upgrade layer (vanilla JS, no build
 * step, matches the rest of this codebase's plain <script> style).
 *
 * Loaded after /index.js on the homepage only. Everything here is
 * organized into small, independent modules (one IIFE-scoped object per
 * feature) so each maps onto the "component" it stands in for:
 *
 *   LSReveal      -> scroll-triggered reveal animations (shared by every section)
 *   LSNav         -> sticky navbar shrink/blur + scrollspy + mobile menu
 *   LSLoader      -> short branded loading screen
 *   LSCounters    -> StatsSection count-up
 *   LSMagnetic    -> magnetic/responsive CTA buttons
 *   LSRouteMap    -> RouteMap (interactive network + animated routes)
 *   LSFleet       -> FleetShowcase (horizontal scroller + "Book This Truck")
 *   LSQuote       -> QuoteCalculator
 *   LSTracker     -> ShipmentTracker (mock timeline)
 *   LSTestimonials-> Testimonials carousel
 *   LSFooter      -> Footer newsletter form
 *   ChatService   -> API abstraction used by AIChatbot (services/chatService)
 *   LSChatbot     -> AIChatbot UI (ChatMessage/ChatInput/QuickActions/TypingIndicator
 *                    are the render functions inside this module)
 *
 * Respects `prefers-reduced-motion: reduce` throughout: every module checks
 * `LS_REDUCED_MOTION` before starting a JS-driven animation loop or CSS
 * transition-based reveal, and CSS itself also guards the purely-visual
 * keyframe animations (see site-enhance.css).
 */
(function () {
  'use strict';

  var LS_REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function qs(sel, ctx) { return (ctx || document).querySelector(sel); }
  function qsa(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function on(el, ev, fn, opts) { if (el) el.addEventListener(ev, fn, opts || false); }

  /* =====================================================================
     LSLoader — short branded loading screen. Never blocks more than
     ~900ms; skipped entirely under reduced motion (CSS already hides it,
     this just guarantees the DOM node is removed so it can't intercept
     clicks on very old browsers that ignore prefers-reduced-motion).
     ===================================================================== */
  var LSLoader = {
    init: function () {
      var loader = document.getElementById('lsLoader');
      if (!loader) return;
      if (LS_REDUCED_MOTION) { loader.remove(); return; }
      var hide = function () {
        loader.classList.add('ls-loader-hide');
        setTimeout(function () { if (loader.parentNode) loader.remove(); }, 500);
      };
      // Whichever comes first: the page finishing load, or a short cap —
      // so a slow image/video never turns this into an "unnecessary intro".
      var capTimer = setTimeout(hide, 900);
      window.addEventListener('load', function () { clearTimeout(capTimer); setTimeout(hide, 150); }, { once: true });
    }
  };

  /* =====================================================================
     LSReveal — one shared IntersectionObserver powering every
     scroll-triggered reveal on the page (fade+translate, scale, staggered
     groups). Reveals once and stops observing — a returning scroll-up
     shouldn't re-hide content the visitor already saw.
     ===================================================================== */
  var LSReveal = {
    init: function () {
      // Staggered groups: give each child an increasing --ls-delay first.
      qsa('[data-stagger]').forEach(function (group) {
        var children = qsa(':scope > .ls-reveal', group);
        children.forEach(function (child, i) {
          child.style.setProperty('--ls-delay', Math.min(i * 0.08, 0.56) + 's');
        });
      });

      var targets = qsa('.ls-reveal');
      if (LS_REDUCED_MOTION || !('IntersectionObserver' in window)) {
        targets.forEach(function (t) { t.classList.add('ls-in'); });
        return;
      }
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('ls-in');
            io.unobserve(entry.target);
          }
        });
      }, { threshold: 0.14, rootMargin: '0px 0px -6% 0px' });
      targets.forEach(function (t) { io.observe(t); });
    }
  };

  /* =====================================================================
     LSNav — sticky shrink/blur on scroll, scrollspy active link, mobile
     hamburger -> full-screen slide-in panel.
     ===================================================================== */
  var LSNav = {
    init: function () {
      this.initScrollShrink();
      this.initScrollspy();
      this.initMobileMenu();
      this.initDropdownAutoClose();
      this.initInPageLinks();
    },
    initScrollShrink: function () {
      var header = qs('header');
      if (!header) return;
      var last = -1;
      function update() {
        var scrolled = window.scrollY > 18;
        if (scrolled !== last) {
          header.classList.toggle('ls-nav-scrolled', scrolled);
          last = scrolled;
        }
      }
      update();
      window.addEventListener('scroll', update, { passive: true });
    },
    initScrollspy: function () {
      var links = qsa('a[data-spy]');
      if (!links.length || !('IntersectionObserver' in window)) return;
      var map = {};
      links.forEach(function (a) { map[a.getAttribute('data-spy')] = a; });
      var sections = Object.keys(map).map(function (id) { return document.getElementById(id); }).filter(Boolean);
      if (!sections.length) return;
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          var link = map[entry.target.id];
          if (!link) return;
          if (entry.isIntersecting) {
            links.forEach(function (a) { a.classList.remove('ls-active'); });
            link.classList.add('ls-active');
          }
        });
      }, { rootMargin: '-40% 0px -50% 0px', threshold: 0 });
      sections.forEach(function (s) { io.observe(s); });
    },
    initMobileMenu: function () {
      var btn = document.getElementById('lsHamburger');
      var panel = document.getElementById('lsMobilePanel');
      var closeBtn = document.getElementById('lsMobilePanelClose');
      if (!btn || !panel) return;
      function open() {
        panel.classList.add('ls-open');
        btn.classList.add('ls-open');
        btn.setAttribute('aria-expanded', 'true');
        document.body.style.overflow = 'hidden';
      }
      function close() {
        panel.classList.remove('ls-open');
        btn.classList.remove('ls-open');
        btn.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
      }
      on(btn, 'click', function () { panel.classList.contains('ls-open') ? close() : open(); });
      on(closeBtn, 'click', close);
      qsa('a', panel).forEach(function (a) { on(a, 'click', close); });
      on(document, 'keydown', function (e) { if (e.key === 'Escape' && panel.classList.contains('ls-open')) close(); });
    },
    initDropdownAutoClose: function () {
      // The Portal dropdown's Shipper/Broker/Carrier/Admin links open a
      // modal or navigate away, but (unlike the About/Contact/Complaint
      // items already handled in index.js) never closed the dropdown menu
      // itself — harmless once a modal's own backdrop covers it, but worth
      // tidying up so it doesn't stay open underneath.
      var dropdown = document.getElementById('servicesDropdown');
      if (!dropdown) return;
      qsa('#servicesMenu a[data-role]').forEach(function (a) {
        on(a, 'click', function () { dropdown.classList.remove('open'); });
      });
    },
    initInPageLinks: function () {
      // Smooth-scroll for any nav/CTA link that points at an #id on this
      // same page (html{scroll-behavior:smooth} already does the actual
      // scroll — this just closes the mobile panel first, if open, and
      // accounts for the sticky header's height).
      qsa('a[href^="#"]').forEach(function (a) {
        on(a, 'click', function (e) {
          var id = a.getAttribute('href').slice(1);
          var target = id && document.getElementById(id);
          if (!target) return;
          e.preventDefault();
          var headerH = (qs('header') && qs('header').offsetHeight) || 0;
          var top = target.getBoundingClientRect().top + window.pageYOffset - headerH - 14;
          window.scrollTo({ top: top, behavior: LS_REDUCED_MOTION ? 'auto' : 'smooth' });
        });
      });
    }
  };

  /* =====================================================================
     LSCounters — StatsSection count-up, starts only once the section
     scrolls into view (never before).
     ===================================================================== */
  var LSCounters = {
    init: function () {
      var cards = qsa('.stat-number[data-target]');
      if (!cards.length) return;
      if (LS_REDUCED_MOTION || !('IntersectionObserver' in window)) {
        cards.forEach(function (el) { this.setFinal(el); }, this);
        return;
      }
      var self = this;
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            self.animate(entry.target);
            io.unobserve(entry.target);
          }
        });
      }, { threshold: 0.4 });
      cards.forEach(function (el) { io.observe(el); });
    },
    setFinal: function (el) {
      var target = Number(el.getAttribute('data-target'));
      var suffix = el.getAttribute('data-suffix') || '';
      el.textContent = target.toLocaleString('en-IN') + suffix;
    },
    animate: function (el) {
      var target = Number(el.getAttribute('data-target'));
      var suffix = el.getAttribute('data-suffix') || '';
      var duration = 1600;
      var start = null;
      function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
      function step(ts) {
        if (start === null) start = ts;
        var progress = Math.min((ts - start) / duration, 1);
        var value = Math.round(easeOutCubic(progress) * target);
        el.textContent = value.toLocaleString('en-IN') + suffix;
        if (progress < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }
  };

  /* =====================================================================
     LSMagnetic — subtle magnetic pull for [data-magnetic] CTA buttons.
     Desktop, fine-pointer only; skipped under reduced motion.
     ===================================================================== */
  var LSMagnetic = {
    init: function () {
      if (LS_REDUCED_MOTION) return;
      if (!window.matchMedia || !window.matchMedia('(pointer: fine)').matches) return;
      qsa('[data-magnetic]').forEach(function (el) {
        on(el, 'mousemove', function (e) {
          var r = el.getBoundingClientRect();
          var x = (e.clientX - r.left - r.width / 2) * 0.28;
          var y = (e.clientY - r.top - r.height / 2) * 0.35;
          el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
        });
        on(el, 'mouseleave', function () { el.style.transform = ''; });
      });
    }
  };

  /* =====================================================================
     RouteMap — interactive logistics network.
     ===================================================================== */
  var ROUTE_CITIES = [
    { id: 'delhi', name: 'Delhi', x: 42, y: 18, hub: true, status: 'Distribution Hub', eta: '—', distance: '0 km', vehicles: '38 trucks staged' },
    { id: 'mumbai', name: 'Mumbai', x: 20, y: 55, status: 'In Transit', eta: '6h 40m', distance: '1,415 km', vehicles: '12 en route' },
    { id: 'bangalore', name: 'Bengaluru', x: 34, y: 82, status: 'Out for Delivery', eta: '1h 10m', distance: '2,150 km', vehicles: '9 en route' },
    { id: 'chennai', name: 'Chennai', x: 47, y: 85, status: 'In Transit', eta: '9h 05m', distance: '2,180 km', vehicles: '7 en route' },
    { id: 'kolkata', name: 'Kolkata', x: 72, y: 42, status: 'Picked Up', eta: '11h 20m', distance: '1,470 km', vehicles: '11 en route' },
    { id: 'hyderabad', name: 'Hyderabad', x: 42, y: 66, status: 'In Transit', eta: '5h 15m', distance: '1,570 km', vehicles: '8 en route' },
    { id: 'ahmedabad', name: 'Ahmedabad', x: 16, y: 38, status: 'Out for Delivery', eta: '2h 30m', distance: '950 km', vehicles: '6 en route' },
    { id: 'pune', name: 'Pune', x: 24, y: 62, status: 'Delivered', eta: 'Completed', distance: '1,450 km', vehicles: '5 en route' }
  ];

  var LSRouteMap = {
    init: function () {
      var canvas = document.getElementById('lsRouteCanvas');
      var nodesLayer = document.getElementById('lsRouteNodes');
      var svg = document.getElementById('lsRouteLines');
      var panel = document.getElementById('lsRouteInfoPanel');
      if (!canvas || !nodesLayer || !svg || !panel) return;

      var hub = ROUTE_CITIES.filter(function (c) { return c.hub; })[0];
      var self = this;

      // Draw curved dashed lines from the hub to every other city, and
      // animate a moving "shipment" dot along three of them (kept to
      // three so the map reads as premium, not busy).
      ROUTE_CITIES.forEach(function (city, i) {
        if (city.hub) return;
        var midX = (hub.x + city.x) / 2 + (i % 2 === 0 ? 4 : -4);
        var midY = (hub.y + city.y) / 2 - 6;
        var pathId = 'lsRoutePath-' + city.id;
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('id', pathId);
        path.setAttribute('d', 'M ' + hub.x + ' ' + hub.y + ' Q ' + midX + ' ' + midY + ' ' + city.x + ' ' + city.y);
        path.setAttribute('class', 'hub-line');
        svg.appendChild(path);

        if (!LS_REDUCED_MOTION && i < 4) {
          var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          dot.setAttribute('r', '0.9');
          dot.setAttribute('fill', '#ffd27a');
          dot.style.filter = 'drop-shadow(0 0 3px rgba(255,210,122,0.9))';
          var anim = document.createElementNS('http://www.w3.org/2000/svg', 'animateMotion');
          anim.setAttribute('dur', (5 + i * 1.3).toFixed(1) + 's');
          anim.setAttribute('repeatCount', 'indefinite');
          anim.setAttribute('rotate', 'auto');
          var mpath = document.createElementNS('http://www.w3.org/2000/svg', 'mpath');
          mpath.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#' + pathId);
          anim.appendChild(mpath);
          dot.appendChild(anim);
          svg.appendChild(dot);
        }

        var node = document.createElement('button');
        node.type = 'button';
        node.className = 'route-node';
        node.style.left = city.x + '%';
        node.style.top = city.y + '%';
        node.setAttribute('data-city', city.id);
        node.setAttribute('aria-label', city.name + ' — ' + city.status);
        node.innerHTML = '<span class="rn-dot"></span><span class="rn-label">' + city.name + '</span>';
        on(node, 'click', function () { self.select(city, node); });
        nodesLayer.appendChild(node);
      });

      // Hub node itself
      var hubNode = document.createElement('button');
      hubNode.type = 'button';
      hubNode.className = 'route-node hub';
      hubNode.style.left = hub.x + '%';
      hubNode.style.top = hub.y + '%';
      hubNode.setAttribute('aria-label', hub.name + ' — Distribution Hub');
      hubNode.innerHTML = '<span class="rn-dot"></span><span class="rn-label">' + hub.name + ' · HUB</span>';
      on(hubNode, 'click', function () { self.select(hub, hubNode); });
      nodesLayer.appendChild(hubNode);

      this.panel = panel;
      // Default selection so the panel isn't empty on load.
      this.select(ROUTE_CITIES[1], qsa('.route-node', nodesLayer)[0]);
    },
    select: function (city, node) {
      qsa('.route-node.active').forEach(function (n) { n.classList.remove('active'); });
      if (node) node.classList.add('active');
      this.panel.innerHTML =
        '<h3>' + city.name + '</h3>' +
        '<p class="rip-sub">' + (city.hub ? 'Central distribution hub' : 'Live shipment lane from Delhi') + '</p>' +
        '<span class="route-info-status"><span class="dot"></span>' + city.status + '</span>' +
        '<div class="route-info-grid">' +
          '<div class="rig-item"><span class="k">Distance from hub</span><span class="v">' + city.distance + '</span></div>' +
          '<div class="rig-item"><span class="k">ETA</span><span class="v">' + city.eta + '</span></div>' +
          '<div class="rig-item"><span class="k">Fleet status</span><span class="v">' + city.vehicles + '</span></div>' +
          '<div class="rig-item"><span class="k">Network node</span><span class="v">' + (city.hub ? 'Hub' : 'Destination') + '</span></div>' +
        '</div>' +
        '<p class="rip-note">Illustrative network view — hover or select any city to preview live route status. Real per-shipment tracking is available once you log in to your Shipper Portal.</p>';
    }
  };

  /* =====================================================================
     FleetShowcase — "Book This Truck" hands the vehicle off to the quote
     calculator instead of duplicating a booking flow that already exists
     behind login.
     ===================================================================== */
  var LSFleet = {
    init: function () {
      qsa('.fleet-book-btn').forEach(function (btn) {
        on(btn, 'click', function () {
          var vehicle = btn.getAttribute('data-vehicle');
          var select = document.getElementById('quoteVehicle');
          var quoteSection = document.getElementById('quote-calculator');
          if (select && vehicle) {
            select.value = vehicle;
            select.dispatchEvent(new Event('change'));
          }
          if (quoteSection) {
            var headerH = (qs('header') && qs('header').offsetHeight) || 0;
            var top = quoteSection.getBoundingClientRect().top + window.pageYOffset - headerH - 14;
            window.scrollTo({ top: top, behavior: LS_REDUCED_MOTION ? 'auto' : 'smooth' });
          }
          var pickup = document.getElementById('quotePickup');
          if (pickup) setTimeout(function () { pickup.focus(); }, LS_REDUCED_MOTION ? 0 : 550);
        });
      });
    }
  };

  /* =====================================================================
     QuoteCalculator — real distance where possible (reuses the site's own
     public /api/estimate/distance endpoint), mock/illustrative pricing on
     top of it. Always clearly labeled as an estimate.
     ===================================================================== */
  var QUOTE_VEHICLES = {
    'Mini Truck':       { base: 1500, perKm: 18, payload: '750 kg' },
    'Pickup':           { base: 1800, perKm: 20, payload: '1.5 tons' },
    '14-ft Truck':      { base: 3200, perKm: 28, payload: '4 tons' },
    '17-ft Truck':      { base: 4200, perKm: 34, payload: '7 tons' },
    '19-ft Truck':      { base: 5200, perKm: 40, payload: '9 tons' },
    '32-ft Container':  { base: 9000, perKm: 55, payload: '18 tons' },
    'Trailer':          { base: 12000, perKm: 65, payload: '25+ tons' }
  };
  var QUOTE_CARGO_MULTIPLIER = {
    'General Cargo': 1, 'Fragile Goods': 1.15, 'Perishable / Cold Chain': 1.25,
    'Heavy Machinery': 1.35, 'Hazardous Material': 1.5, 'Livestock': 1.2
  };

  function hashString(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
    return Math.abs(h);
  }

  var LSQuote = {
    init: function () {
      var form = document.getElementById('quoteForm');
      if (!form) return;
      this.resultEl = document.getElementById('quoteResult');
      this.priceEl = document.getElementById('quotePriceValue');
      this.submitBtn = document.getElementById('quoteSubmitBtn');
      on(form, 'submit', this.onSubmit.bind(this));
    },
    onSubmit: function (e) {
      e.preventDefault();
      var pickup = qs('#quotePickup').value.trim();
      var destination = qs('#quoteDestination').value.trim();
      var cargo = qs('#quoteCargo').value;
      var weight = Number(qs('#quoteWeight').value);
      var vehicle = qs('#quoteVehicle').value;

      var errorEl = document.getElementById('quoteError');
      errorEl.style.display = 'none';
      if (!pickup || !destination) { this.showError('Enter both a pickup and a destination.'); return; }
      if (!weight || weight <= 0) { this.showError('Enter a valid cargo weight (in tons).'); return; }

      this.submitBtn.disabled = true;
      this.submitBtn.textContent = 'Calculating…';
      var self = this;

      this.getDistance(pickup, destination).then(function (distanceKm) {
        self.renderResult({ pickup: pickup, destination: destination, cargo: cargo, weight: weight, vehicle: vehicle, distanceKm: distanceKm });
      }).finally(function () {
        self.submitBtn.disabled = false;
        self.submitBtn.textContent = 'Calculate Estimate';
      });
    },
    getDistance: function (pickup, destination) {
      return fetch('/api/estimate/distance?pickup=' + encodeURIComponent(pickup) + '&destination=' + encodeURIComponent(destination))
        .then(function (res) { if (!res.ok) throw new Error('geocode failed'); return res.json(); })
        .then(function (data) { return data.distanceKm; })
        .catch(function () {
          // Deterministic fallback so a flaky/offline geocoder never blocks
          // the demo — same two city names always produce the same
          // illustrative distance.
          var seed = hashString(pickup.toLowerCase() + '>' + destination.toLowerCase());
          return 180 + (seed % 1820);
        });
    },
    showError: function (msg) {
      var errorEl = document.getElementById('quoteError');
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
    },
    renderResult: function (data) {
      var vSpec = QUOTE_VEHICLES[data.vehicle] || QUOTE_VEHICLES['14-ft Truck'];
      var multiplier = QUOTE_CARGO_MULTIPLIER[data.cargo] || 1;
      var raw = (vSpec.base + vSpec.perKm * data.distanceKm) * multiplier + (data.weight * 180);
      var price = Math.max(900, Math.round(raw / 50) * 50);
      var avgSpeed = 38; // km/h, incl. loading/halts — illustrative
      var hours = data.distanceKm / avgSpeed;
      var transitLabel = hours < 20 ? Math.round(hours) + ' hrs' : Math.round(hours / 24) + ' days';

      this.resultEl.classList.remove('qr-empty');
      this.resultEl.innerHTML =
        '<span class="quote-estimate-tag">Estimated quote · not final</span>' +
        '<div class="quote-price-row"><span class="quote-price" id="quotePriceValue">₹0</span><span class="quote-price-label">approx. total</span></div>' +
        '<div class="quote-detail-grid">' +
          '<div><span class="k">Route</span><span class="v">' + escapeHtml(data.pickup) + ' → ' + escapeHtml(data.destination) + '</span></div>' +
          '<div><span class="k">Distance</span><span class="v">' + data.distanceKm.toLocaleString('en-IN') + ' km</span></div>' +
          '<div><span class="k">Transit time</span><span class="v">' + transitLabel + '</span></div>' +
          '<div><span class="k">Recommended truck</span><span class="v">' + data.vehicle + ' (' + vSpec.payload + ')</span></div>' +
        '</div>' +
        '<div class="quote-cta-row">' +
          '<a href="/register/shipper" class="qcta-primary">Get exact quote →</a>' +
          '<a href="/login/shipper" class="qcta-secondary">Log in &amp; book</a>' +
        '</div>';

      this.animatePrice(document.getElementById('quotePriceValue'), price);
    },
    animatePrice: function (el, target) {
      if (LS_REDUCED_MOTION) { el.textContent = '₹' + target.toLocaleString('en-IN'); return; }
      var start = null; var duration = 900;
      function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
      function step(ts) {
        if (start === null) start = ts;
        var progress = Math.min((ts - start) / duration, 1);
        el.textContent = '₹' + Math.round(easeOutCubic(progress) * target).toLocaleString('en-IN');
        if (progress < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }
  };

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* =====================================================================
     ShipmentTracker — mock, deterministic-per-token demo timeline. The
     real per-account tracking dashboard already exists behind shipper
     login (see the hero's Live Tracking Dashboard mock and
     /portal/shipper/live-tracking) — this is the public, no-login preview
     the marketing page needs.
     ===================================================================== */
  var TRACK_STAGES = ['Order Confirmed', 'Picked Up', 'In Transit', 'Distribution Center', 'Out for Delivery', 'Delivered'];
  var TRACK_ROUTES = [
    ['Delhi', 'Mumbai'], ['Bengaluru', 'Chennai'], ['Ahmedabad', 'Pune'],
    ['Kolkata', 'Hyderabad'], ['Jaipur', 'Lucknow'], ['Surat', 'Nagpur']
  ];
  var TRACK_DRIVERS = ['R. Kumar', 'S. Verma', 'A. Singh', 'M. Iyer', 'P. Nair', 'D. Chauhan'];
  var TRACK_ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#0c2c1c" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var LSTracker = {
    init: function () {
      var form = document.getElementById('trackingForm');
      if (!form) return;
      on(form, 'submit', this.onSubmit.bind(this));
      // Pre-fill with a friendly example so first-time visitors immediately
      // understand the format, without pretending it's their real order.
      var input = document.getElementById('trackingIdInput');
      if (input && !input.value) input.setAttribute('placeholder', 'e.g. LS4820193765');

      this.initModeTabs();

      var phoneForm = document.getElementById('trackingPhoneForm');
      if (phoneForm) on(phoneForm, 'submit', this.onPhoneSubmit.bind(this));
    },
    onSubmit: function (e) {
      e.preventDefault();
      var input = document.getElementById('trackingIdInput');
      var value = input.value.trim();
      var errorEl = document.getElementById('trackingError');
      errorEl.style.display = 'none';
      if (!value) { errorEl.textContent = 'Enter a tracking / consignment number to continue.'; errorEl.style.display = 'block'; return; }
      this.render(value);
    },

    /* ---- Track by phone number: a SEPARATE tab from the Token No. box
       above. Unlike that box (which is an illustrative, client-side-only
       demo — see the big comment on `render` below), this one calls a
       real server endpoint (GET /api/tracking/public/by-phone) and shows
       actual shipments linked to that mobile number. No login required,
       and the response is intentionally limited to route/status only
       (see toPublicTrackingSummary in server_load.js) — never invoices,
       documents, or company details. */
    initModeTabs: function () {
      var tabs = qsa('.tracking-mode-tab', document.getElementById('trackingModeTabs'));
      if (!tabs.length) return;
      var tokenForm = document.getElementById('trackingForm');
      var tokenHint = document.getElementById('trackingTokenHint');
      var tokenResult = document.getElementById('trackingResult');
      var tokenError = document.getElementById('trackingError');
      var phoneForm = document.getElementById('trackingPhoneForm');
      var phoneHint = document.getElementById('trackingPhoneHint');
      var phoneResult = document.getElementById('trackingPhoneResult');
      var phoneError = document.getElementById('trackingPhoneError');
      var intro = document.getElementById('trackingModeIntro');

      function setMode(mode) {
        tabs.forEach(function (t) {
          var active = t.getAttribute('data-mode') === mode;
          t.classList.toggle('active', active);
          t.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        var isToken = mode === 'token';
        tokenForm.style.display = isToken ? '' : 'none';
        tokenHint.style.display = isToken ? '' : 'none';
        if (!isToken) { tokenError.style.display = 'none'; }
        phoneForm.style.display = isToken ? 'none' : '';
        phoneHint.style.display = isToken ? 'none' : '';
        if (isToken) { phoneError.style.display = 'none'; }
        intro.textContent = isToken
          ? 'Enter any tracking / consignment number to preview the live journey timeline.'
          : 'Enter your registered mobile number to see your real shipments — no login required.';
      }

      tabs.forEach(function (t) {
        on(t, 'click', function () { setMode(t.getAttribute('data-mode')); });
      });
    },

    onPhoneSubmit: function (e) {
      e.preventDefault();
      var input = document.getElementById('trackingPhoneInput');
      var value = input.value.trim();
      var errorEl = document.getElementById('trackingPhoneError');
      var resultEl = document.getElementById('trackingPhoneResult');
      errorEl.style.display = 'none';
      var digits = value.replace(/\D/g, '');
      if (digits.length < 7) {
        errorEl.textContent = 'Enter at least the last 7 digits of your registered mobile number.';
        errorEl.style.display = 'block';
        return;
      }
      var submitBtn = e.target.querySelector('button[type="submit"]');
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Searching…'; }
      fetch('/api/tracking/public/by-phone?phone=' + encodeURIComponent(digits))
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.error) { errorEl.textContent = data.error; errorEl.style.display = 'block'; return; }
          this.renderPhoneResults(data.orders || [], digits);
        }.bind(this))
        .catch(function () {
          errorEl.textContent = 'Could not reach the tracking service right now. Please try again.';
          errorEl.style.display = 'block';
        })
        .finally(function () {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Find My Shipments'; }
        });
    },

    renderPhoneResults: function (orders, digits) {
      var resultEl = document.getElementById('trackingPhoneResult');
      resultEl.classList.add('tr-show');
      if (!orders.length) {
        resultEl.innerHTML = '<div class="tracking-phone-empty">No shipments found for a mobile number ending in ' +
          escapeHtml(digits.slice(-4)) + '. Double-check the number, or ' +
          '<a href="/login/shipper">log in to your Shipper Portal</a> for full account access.</div>';
        resultEl.scrollIntoView({ behavior: LS_REDUCED_MOTION ? 'auto' : 'smooth', block: 'nearest' });
        return;
      }
      resultEl.innerHTML = '<div class="tracking-phone-list">' + orders.map(function (o) {
        return '<div class="tracking-phone-card">' +
          '<div class="tracking-phone-card-head">' +
            '<h4>' + escapeHtml(o.pickup || '—') + ' → ' + escapeHtml(o.destination || '—') + '</h4>' +
            '<span class="tracking-status-chip">' + escapeHtml(o.status || 'Booked') + '</span>' +
          '</div>' +
          '<div class="tracking-phone-meta">' +
            '<span>Token No. ' + escapeHtml(o.tokenNo || '—') + '</span>' +
            '<span>' + escapeHtml(o.material || '—') + (o.weight != null ? ' · ' + o.weight + ' tons' : '') + '</span>' +
            (o.currentLocation ? '<span>📍 ' + escapeHtml(o.currentLocation) + '</span>' : '') +
          '</div>' +
          (o.remarks ? '<p class="tracking-phone-note">📝 ' + escapeHtml(o.remarks) + '</p>' : '') +
        '</div>';
      }).join('') + '</div>' +
      '<p class="tracking-note">Showing your ' + orders.length + ' most recent shipment' + (orders.length === 1 ? '' : 's') +
        '. For invoices, POD, and full details, <a href="/login/shipper">log in to your Shipper Portal</a>.</p>';
      resultEl.scrollIntoView({ behavior: LS_REDUCED_MOTION ? 'auto' : 'smooth', block: 'nearest' });
    },
    render: function (token) {
      var seed = hashString(token.toUpperCase());
      var route = TRACK_ROUTES[seed % TRACK_ROUTES.length];
      var driver = TRACK_DRIVERS[seed % TRACK_DRIVERS.length];
      // Bias toward an "in progress" stage (index 1-4) — a freshly typed
      // demo token reading as fully delivered on the first try feels less
      // like a live network.
      var stageIndex = 1 + (seed % (TRACK_STAGES.length - 2));
      var progressPct = Math.round(((stageIndex + 1) / TRACK_STAGES.length) * 100);
      var truckNo = 'LS-' + (10000 + (seed % 89999));
      var totalKm = 300 + (seed % 1400);
      var remainingKm = Math.max(8, Math.round(totalKm * (1 - progressPct / 100)));
      var etaHours = Math.max(1, Math.round(remainingKm / 42));

      var timelineHtml = TRACK_STAGES.map(function (label, i) {
        var cls = i < stageIndex ? 'done' : (i === stageIndex ? 'current' : '');
        return '<div class="tr-stage ' + cls + '">' +
          '<span class="tr-stage-dot">' + (i <= stageIndex ? TRACK_ICON_CHECK : '') + '</span>' +
          '<span class="tr-stage-label">' + label + '</span>' +
        '</div>';
      }).join('');

      var card = document.getElementById('trackingResult');
      card.classList.add('tr-show');
      card.innerHTML =
        '<div class="tracking-card">' +
          '<div class="tracking-card-head">' +
            '<div><h3>' + route[0] + ' → ' + route[1] + '</h3><span class="tracking-token">Token No. ' + escapeHtml(token.toUpperCase()) + '</span></div>' +
            '<span class="tracking-status-chip">' + TRACK_STAGES[stageIndex] + '</span>' +
          '</div>' +
          '<div class="tr-timeline"><div class="tr-timeline-fill" id="trTimelineFill"></div>' + timelineHtml + '</div>' +
          '<div class="tr-progress-row"><div class="tr-progress-bar"><span id="trProgressBar"></span></div><span class="tr-progress-pct" id="trProgressPct">0%</span></div>' +
          '<div class="tr-info-grid">' +
            '<div><span class="k">Driver / Truck</span><span class="v">' + driver + ' · ' + truckNo + '</span></div>' +
            '<div><span class="k">Current location</span><span class="v">Near ' + route[0] + '–' + route[1] + ' corridor</span></div>' +
            '<div><span class="k">Distance remaining</span><span class="v">' + remainingKm.toLocaleString('en-IN') + ' km</span></div>' +
            '<div><span class="k">Estimated delivery</span><span class="v">' + etaHours + ' hrs</span></div>' +
          '</div>' +
          '<p class="tracking-note">Illustrative demo based on your tracking number — this page has no login. To track a real Load Smart shipment, <a href="/login/shipper">log in to your Shipper Portal</a>.</p>' +
        '</div>';

      requestAnimationFrame(function () {
        var fill = document.getElementById('trTimelineFill');
        var bar = document.getElementById('trProgressBar');
        var pct = document.getElementById('trProgressPct');
        var fillPct = Math.round((stageIndex / (TRACK_STAGES.length - 1)) * 90);
        if (fill) fill.style.width = fillPct + '%';
        if (bar) bar.style.width = progressPct + '%';
        if (pct && !LS_REDUCED_MOTION) {
          var start = null;
          function step(ts) {
            if (start === null) start = ts;
            var progress = Math.min((ts - start) / 900, 1);
            pct.textContent = Math.round(progress * progressPct) + '%';
            if (progress < 1) requestAnimationFrame(step);
          }
          requestAnimationFrame(step);
        } else if (pct) {
          pct.textContent = progressPct + '%';
        }
      });

      card.scrollIntoView({ behavior: LS_REDUCED_MOTION ? 'auto' : 'smooth', block: 'nearest' });
    }
  };

  /* =====================================================================
     Testimonials — autoplay carousel, arrows, dots, swipe, pause on
     interaction.
     ===================================================================== */
  var LSTestimonials = {
    init: function () {
      var viewport = document.getElementById('testimonialViewport');
      if (!viewport) return;
      this.slides = qsa('.testimonial-slide', viewport);
      this.dots = qsa('.testimonial-dots button');
      this.index = 0;
      this.autoplayMs = 5500;
      this.timer = null;

      on(document.getElementById('testimonialPrev'), 'click', this.prev.bind(this));
      on(document.getElementById('testimonialNext'), 'click', this.next.bind(this));
      this.dots.forEach(function (dot, i) {
        on(dot, 'click', function () { this.goTo(i); this.restartAutoplay(); }.bind(this));
      }, this);

      // Swipe support
      var startX = null;
      on(viewport, 'touchstart', function (e) { startX = e.touches[0].clientX; this.stopAutoplay(); }.bind(this), { passive: true });
      on(viewport, 'touchend', function (e) {
        if (startX === null) return;
        var dx = e.changedTouches[0].clientX - startX;
        if (Math.abs(dx) > 40) { dx < 0 ? this.next() : this.prev(); }
        startX = null;
        this.restartAutoplay();
      }.bind(this));

      on(viewport, 'mouseenter', this.stopAutoplay.bind(this));
      on(viewport, 'mouseleave', this.restartAutoplay.bind(this));

      this.goTo(0);
      this.restartAutoplay();
    },
    goTo: function (i) {
      this.index = (i + this.slides.length) % this.slides.length;
      this.slides.forEach(function (s, idx) { s.classList.toggle('active', idx === this.index); }, this);
      this.dots.forEach(function (d, idx) { d.classList.toggle('active', idx === this.index); d.setAttribute('aria-current', idx === this.index ? 'true' : 'false'); }, this);
    },
    next: function () { this.goTo(this.index + 1); },
    prev: function () { this.goTo(this.index - 1); },
    stopAutoplay: function () { if (this.timer) { clearInterval(this.timer); this.timer = null; } },
    restartAutoplay: function () {
      this.stopAutoplay();
      if (LS_REDUCED_MOTION) return;
      this.timer = setInterval(this.next.bind(this), this.autoplayMs);
    }
  };

  /* =====================================================================
     Footer newsletter — posts to /api/newsletter (best-effort server log,
     see server_load.js); always resolves gracefully client-side either way.
     ===================================================================== */
  var LSFooter = {
    init: function () {
      var form = document.getElementById('newsletterForm');
      if (!form) return;
      on(form, 'submit', function (e) {
        e.preventDefault();
        var input = document.getElementById('newsletterEmail');
        var email = input.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          if (window.LS && LS.showError) LS.showError('Enter a valid email address.');
          return;
        }
        var btn = form.querySelector('button');
        var originalText = btn.textContent;
        btn.disabled = true;
        fetch('/api/newsletter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email })
        }).catch(function () { /* still confirm — best-effort, non-critical */ })
          .finally(function () {
            btn.disabled = false;
            btn.textContent = originalText;
            input.value = '';
            if (window.LS && LS.showSuccess) LS.showSuccess('You\'re subscribed!', { sub: 'We\'ll email you freight tips and network updates.' });
          });
      });
    }
  };

  /* =====================================================================
     ChatService — the API abstraction layer. Swap the fetch below for a
     call to Claude / OpenAI / Gemini / a custom logistics backend later
     WITHOUT touching any UI code in LSChatbot — that's the entire point
     of keeping this as one small function with one contract:
     Request:  { message: string, conversation: Array<{role, content}> }
     Response: { message: string, action?: string, payload?: object }
     No API key ever lives in this file — see server_load.js's POST
     /api/chat handler and .env.example for where a real provider key
     would be read from process.env on the SERVER side only.
     ===================================================================== */
  var ChatService = {
    sendMessage: function (message, conversation) {
      return fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message, conversation: conversation || [] })
      }).then(function (res) {
        if (!res.ok) throw new Error('Chat service returned ' + res.status);
        return res.json();
      });
    },
    // Local fallback so the widget still works if the network request
    // fails (offline demo, dev server not running the /api/chat route,
    // etc.) — same response shape as the real endpoint.
    mockReply: function (message) {
      return mockChatIntent(message);
    }
  };

  // Shared rule-based intent matcher — intentionally simple/readable so it
  // doubles as living documentation of what the real backend should be
  // able to understand once it's wired to a genuine LLM. See the
  // equivalent (server-authoritative) version in server_load.js.
  function mockChatIntent(raw) {
    var msg = String(raw || '').toLowerCase();
    var trackingMatch = raw.match(/\bLS\d{6,}\b/i);

    if (/track|where.*(shipment|order|package|load)|shipment.*status/.test(msg)) {
      return {
        message: trackingMatch
          ? 'I can help you track ' + trackingMatch[0].toUpperCase() + '. Opening the tracking widget for you now.'
          : 'I can help you track a shipment — enter your Token/Consignment number in the tracking box and I\'ll pull up its live status.',
        action: 'TRACK_SHIPMENT',
        payload: trackingMatch ? { trackingId: trackingMatch[0].toUpperCase() } : {}
      };
    }
    if (/quote|cost|price|how much|charge|rate/.test(msg)) {
      return {
        message: 'Freight cost depends on route, cargo type, weight and truck size. I\'ve opened our quote calculator — fill in pickup, destination and cargo details for an instant estimate.',
        action: 'OPEN_QUOTE',
        payload: {}
      };
    }
    if (/deliver|eta|arrive|when will/.test(msg)) {
      return {
        message: 'Delivery estimates depend on your specific shipment. Try the Track Shipment box with your Token/Order number, or use the quote calculator to see estimated transit time for a new booking.',
        action: 'TRACK_SHIPMENT',
        payload: {}
      };
    }
    if (/service|offer|what.*(do you|can you)|full truck|part load|cold chain|warehous/.test(msg)) {
      return {
        message: 'We offer Full Truck Load, Part Load, Express Delivery, Last Mile Delivery, Warehousing, Container Transport and Cold Chain Logistics. Scrolling you to our services now.',
        action: 'SHOW_SERVICES',
        payload: {}
      };
    }
    if (/support|agent|human|talk to (someone|support|a person)|help me|complaint|problem/.test(msg)) {
      return {
        message: 'Sure — I\'ve opened our Contact panel with a direct number to the Load Smart team. You can also file a complaint from the Services menu if something went wrong.',
        action: 'CONTACT_SUPPORT',
        payload: {}
      };
    }
    if (/hi|hello|hey|good (morning|afternoon|evening)/.test(msg)) {
      return { message: 'Hello! I\'m the Load Smart logistics assistant. I can help you track a shipment, get a freight quote, check delivery estimates, or connect you with support — what do you need?' };
    }
    return {
      message: 'I can help with tracking a shipment, freight quotes, delivery estimates, our services, or connecting you to support. Try one of the quick options below, or ask me in your own words.'
    };
  }

  /* =====================================================================
     AIChatbot — launcher + panel. ChatMessage / ChatInput / QuickActions /
     TypingIndicator are the render() helpers below, kept as separate
     functions (their own "component") even without a framework.
     ===================================================================== */
  var LSChatbot = (function () {
    var state = {
      open: false,
      loading: false,
      conversation: [], // {role: 'user'|'assistant', content}
      lastUserMessage: null
    };
    var els = {};

    var QUICK_ACTIONS = [
      'Track my shipment', 'Get a freight quote', 'Delivery estimate', 'Available services', 'Talk to support'
    ];

    function ChatMessage(role, content, opts) {
      opts = opts || {};
      var wrap = document.createElement('div');
      wrap.className = 'ls-msg ' + (role === 'user' ? 'ls-msg-user' : 'ls-msg-bot') + (opts.error ? ' ls-msg-error' : '');
      var bubble = document.createElement('div');
      bubble.className = 'ls-msg-bubble';
      bubble.textContent = content;
      wrap.appendChild(bubble);
      if (opts.retry) {
        var retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'ls-chat-retry';
        retryBtn.textContent = 'Retry';
        on(retryBtn, 'click', opts.retry);
        var col = document.createElement('div');
        col.style.display = 'flex';
        col.style.flexDirection = 'column';
        col.style.gap = '4px';
        col.appendChild(bubble);
        col.appendChild(retryBtn);
        wrap.innerHTML = '';
        wrap.appendChild(col);
      }
      return wrap;
    }

    function TypingIndicator() {
      var wrap = document.createElement('div');
      wrap.className = 'ls-msg ls-msg-bot';
      wrap.id = 'lsTypingIndicator';
      wrap.innerHTML = '<div class="ls-typing"><span></span><span></span><span></span></div>';
      return wrap;
    }

    function QuickActions(container, onPick) {
      container.innerHTML = '';
      QUICK_ACTIONS.forEach(function (label) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ls-chip';
        chip.textContent = label;
        on(chip, 'click', function () { onPick(label); });
        container.appendChild(chip);
      });
    }

    function scrollToBottom() {
      els.messages.scrollTop = els.messages.scrollHeight;
    }

    function appendMessage(role, content, opts) {
      var node = ChatMessage(role, content, opts);
      els.messages.appendChild(node);
      scrollToBottom();
      return node;
    }

    function setLoading(isLoading) {
      state.loading = isLoading;
      els.send.disabled = isLoading;
      var existing = document.getElementById('lsTypingIndicator');
      if (isLoading && !existing) {
        els.messages.appendChild(TypingIndicator());
        scrollToBottom();
      } else if (!isLoading && existing) {
        existing.remove();
      }
    }

    function handleAction(action, payload) {
      payload = payload || {};
      if (action === 'TRACK_SHIPMENT') {
        var section = document.getElementById('tracking-demo');
        if (section) section.scrollIntoView({ behavior: LS_REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
        var input = document.getElementById('trackingIdInput');
        if (input && payload.trackingId) {
          input.value = payload.trackingId;
          var form = document.getElementById('trackingForm');
          if (form) form.dispatchEvent(new Event('submit', { cancelable: true }));
        } else if (input) {
          setTimeout(function () { input.focus(); }, LS_REDUCED_MOTION ? 0 : 500);
        }
      } else if (action === 'OPEN_QUOTE') {
        var qsec = document.getElementById('quote-calculator');
        if (qsec) qsec.scrollIntoView({ behavior: LS_REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
        var pickup = document.getElementById('quotePickup');
        if (pickup) setTimeout(function () { pickup.focus(); }, LS_REDUCED_MOTION ? 0 : 500);
      } else if (action === 'SHOW_SERVICES') {
        var ssec = document.getElementById('services-grid');
        if (ssec) ssec.scrollIntoView({ behavior: LS_REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
      } else if (action === 'CONTACT_SUPPORT') {
        if (window.openSimpleModal) window.openSimpleModal('contactModal');
      }
    }

    function sendUserMessage(text) {
      text = text.trim();
      if (!text || state.loading) return;
      state.lastUserMessage = text;
      appendMessage('user', text);
      state.conversation.push({ role: 'user', content: text });
      els.input.value = '';
      autoGrow(els.input);
      setLoading(true);

      var minDelay = new Promise(function (resolve) { setTimeout(resolve, 420); }); // believable "thinking" pause

      Promise.all([ChatService.sendMessage(text, state.conversation).catch(function () { return ChatService.mockReply(text); }), minDelay])
        .then(function (results) {
          var data = results[0];
          setLoading(false);
          appendMessage('assistant', data.message);
          state.conversation.push({ role: 'assistant', content: data.message });
          if (data.action) handleAction(data.action, data.payload);
        })
        .catch(function () {
          setLoading(false);
          appendMessage('assistant', 'Sorry — I couldn\'t reach the assistant just now.', {
            error: true,
            retry: function () { sendUserMessage(state.lastUserMessage); }
          });
        });
    }

    function autoGrow(textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 90) + 'px';
    }

    function open() {
      state.open = true;
      els.panel.setAttribute('data-open', 'true');
      els.launcher.setAttribute('aria-expanded', 'true');
      var badge = document.getElementById('lsChatBadge');
      if (badge) badge.classList.add('hide');
      setTimeout(function () { els.input.focus(); }, LS_REDUCED_MOTION ? 0 : 260);
    }
    function close() {
      state.open = false;
      els.panel.setAttribute('data-open', 'false');
      els.launcher.setAttribute('aria-expanded', 'false');
    }

    function init() {
      els.launcher = document.getElementById('lsChatLauncher');
      els.panel = document.getElementById('lsChatPanel');
      els.close = document.getElementById('lsChatClose');
      els.messages = document.getElementById('lsChatMessages');
      els.quick = document.getElementById('lsChatQuick');
      els.input = document.getElementById('lsChatInput');
      els.send = document.getElementById('lsChatSend');
      els.form = document.getElementById('lsChatForm');
      if (!els.launcher || !els.panel) return;

      QuickActions(els.quick, function (label) { sendUserMessage(label); });
      appendMessage('assistant', 'Hi! I\'m the Load Smart logistics assistant. Ask me about tracking a shipment, freight quotes, delivery estimates, or our services.');

      on(els.launcher, 'click', function () { state.open ? close() : open(); });
      on(els.launcher, 'keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.open ? close() : open(); } });
      on(els.close, 'click', close);
      on(document, 'keydown', function (e) { if (e.key === 'Escape' && state.open) close(); });

      on(els.form, 'submit', function (e) { e.preventDefault(); sendUserMessage(els.input.value); });
      on(els.input, 'input', function () { autoGrow(els.input); });
      on(els.input, 'keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendUserMessage(els.input.value); }
      });
    }

    return { init: init };
  })();

  /* =====================================================================
     Boot — DOM ready
     ===================================================================== */
  function boot() {
    var yearEl = document.getElementById('lsFooterYear');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    LSLoader.init();
    LSNav.init();
    LSReveal.init();
    LSCounters.init();
    LSMagnetic.init();
    LSRouteMap.init();
    LSFleet.init();
    LSQuote.init();
    LSTracker.init();
    LSTestimonials.init();
    LSFooter.init();
    LSChatbot.init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
