/**
 * live-map.js
 * Load Smart — shared Leaflet live-tracking map module.
 *
 * Extracted out of views/portal/live-tracking.js so both the shipper Live
 * Tracking page AND the Admin Tracking page can show the same real map
 * (Leaflet + free OpenStreetMap tiles — no paid map API) instead of the
 * shipper side having one and the admin side having none, and so map code
 * only lives in one place.
 *
 * Also fixes the "full rebuild on every update" pattern the previous
 * single-page version had: `create()` builds the map ONCE; after that,
 * `updateCurrent()` moves the existing current-position marker in place
 * (Leaflet's `marker.setLatLng()`) instead of tearing down and recreating
 * the whole map — so a live GPS push moves the truck marker smoothly with
 * no flicker and no re-fetch of tiles. Call `render()` again only when the
 * origin/destination pins themselves need to (re)appear (e.g. first load,
 * or a newly-geocoded location) — it also uses incremental updates when
 * the existing map instance can be reused instead of rebuilding it.
 *
 * Usage:
 *   const liveMap = LSLiveMap.create(document.getElementById('trackingMap'));
 *   liveMap.render({ origin, destination, current }, { vehicleNumber, driverName, speedKph, headingDeg, accuracy, updatedAt, status });
 *   liveMap.updateCurrent({ lat, lon }, { speedKph, headingDeg, accuracy, updatedAt, status });
 *   liveMap.renderHistory(points); // points: [{lat,lng,createdAt}], chronological
 *   liveMap.destroy();
 */
(function (window) {
  'use strict';

  const ICONS_CACHE = {};
  function icon(kind) {
    if (ICONS_CACHE[kind]) return ICONS_CACHE[kind];
    const SPEC = {
      origin: { html: '🟢', size: 22, className: 'map-pin map-pin-origin' },
      destination: { html: '🏁', size: 22, className: 'map-pin map-pin-dest' },
      current: { html: '🚚', size: 28, className: 'map-pin map-pin-current' },
    }[kind];
    ICONS_CACHE[kind] = window.L.divIcon({ className: SPEC.className, html: SPEC.html, iconSize: [SPEC.size, SPEC.size] });
    return ICONS_CACHE[kind];
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleTimeString(); } catch (e) { return '—'; }
  }

  function currentPopupHtml(meta) {
    const m = meta || {};
    const statusLabel = { live: '🟢 Live', stale: '🟡 Last known location — tracking may have stopped', not_active: '⚪ Tracking not active', no_data: '⚪ Waiting for first GPS fix' }[m.status] || '';
    const lines = [
      '<b>Truck — current location</b>',
      m.vehicleNumber ? `Vehicle: ${m.vehicleNumber}` : null,
      m.driverName ? `Driver: ${m.driverName}` : null,
      m.speedKph != null ? `Speed: ${m.speedKph} km/h` : null,
      m.headingDeg != null ? `Heading: ${m.headingDeg}°` : null,
      m.accuracy != null ? `GPS accuracy: ±${m.accuracy}m` : null,
      m.updatedAt ? `Last update: ${fmtTime(m.updatedAt)}` : null,
      statusLabel,
    ].filter(Boolean);
    return lines.join('<br>');
  }

  function create(containerEl) {
    let map = null;
    let markers = { origin: null, destination: null, current: null };
    let routeLine = null;
    let historyLine = null;

    function ensureLeaflet() {
      if (typeof window.L === 'undefined') {
        containerEl.innerHTML = '<div class="map-unavailable">Map library did not load.</div>';
        return false;
      }
      return true;
    }

    function destroy() {
      if (map) { map.remove(); map = null; }
      markers = { origin: null, destination: null, current: null };
      routeLine = null;
      historyLine = null;
    }

    /** Full (re)build — call when the set of pins actually changes (first
     * render, or origin/destination coordinates newly resolved). Safe to
     * call repeatedly; tears down any previous instance on this element
     * first (Leaflet throws "already initialized" otherwise). */
    function render(coords, meta) {
      if (!containerEl) return;
      destroy();
      if (!ensureLeaflet()) return;

      const points = [];
      if (coords && coords.origin) points.push({ ...coords.origin, kind: 'origin', label: 'Origin' });
      if (coords && coords.current) points.push({ ...coords.current, kind: 'current', label: 'current' });
      if (coords && coords.destination) points.push({ ...coords.destination, kind: 'destination', label: 'Destination' });

      if (!points.length) {
        containerEl.innerHTML = '<div class="map-unavailable">Map unavailable — could not determine coordinates for this route yet.</div>';
        return;
      }

      map = window.L.map(containerEl, { scrollWheelZoom: false }).setView([points[0].lat, points[0].lon], 6);
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 18,
      }).addTo(map);

      points.forEach((p) => {
        const marker = window.L.marker([p.lat, p.lon], { icon: icon(p.kind) }).addTo(map);
        marker.bindPopup(p.kind === 'current' ? currentPopupHtml(meta) : p.label);
        markers[p.kind] = marker;
      });

      if (points.length > 1) {
        routeLine = window.L.polyline(points.map((p) => [p.lat, p.lon]), { color: '#0e3a24', weight: 3, dashArray: '6 8' }).addTo(map);
        map.fitBounds(points.map((p) => [p.lat, p.lon]), { padding: [30, 30] });
      }
    }

    /** Incremental update — moves the current-position marker in place and
     * refreshes its popup content, WITHOUT rebuilding the map or tiles.
     * This is the fast path a live GPS push should use. Falls back to a
     * full render() if there's no map/marker yet to update (e.g. this is
     * actually the first position ever received for this order). */
    function updateCurrent(current, meta) {
      if (!current || current.lat == null || current.lon == null) return;
      if (!map || !markers.current) {
        render({ origin: null, destination: null, current }, meta);
        return;
      }
      markers.current.setLatLng([current.lat, current.lon]);
      markers.current.setPopupContent(currentPopupHtml(meta));
      // Keep the route line's last point in sync too, so the dashed
      // origin->current->destination line still reflects the true
      // current position rather than a stale one.
      if (routeLine) {
        const latlngs = routeLine.getLatLngs();
        if (latlngs.length) latlngs[latlngs.length === 3 ? 1 : latlngs.length - 1] = window.L.latLng(current.lat, current.lon);
        routeLine.setLatLngs(latlngs);
      }
    }

    /** Draws (or replaces) a separate historical-route polyline from a
     * bounded, already-downsampled point list — see the /tracking-history
     * endpoint's `limit`/`since`/`until` params, which is what keeps this
     * bounded before it ever reaches the browser. */
    function renderHistory(points) {
      if (!map || !ensureLeaflet()) return;
      if (historyLine) { map.removeLayer(historyLine); historyLine = null; }
      if (!points || points.length < 2) return;
      const latlngs = points.map((p) => [p.lat, p.lng]);
      historyLine = window.L.polyline(latlngs, { color: '#2c5c8a', weight: 3, opacity: 0.7 }).addTo(map);
      window.L.circleMarker(latlngs[0], { radius: 5, color: '#1f7a3f', fillOpacity: 1 }).addTo(map).bindPopup('Trip start');
      window.L.circleMarker(latlngs[latlngs.length - 1], { radius: 5, color: '#8a2f1f', fillOpacity: 1 }).addTo(map).bindPopup('Latest point in this view');
    }

    function getMap() { return map; }

    return { render, updateCurrent, renderHistory, destroy, getMap };
  }

  window.LSLiveMap = { create };
})(window);
