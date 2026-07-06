(() => {
  'use strict';

  const CHANNEL = 'player-panel-map-bridge';
  const VERSION = 1;
  const PROVIDER = 'squaremap';
  const MARKER_ID = 'player-panel-squaremap-selection-marker';
  const MARKER_STYLE_ID = 'player-panel-squaremap-selection-marker-style';

  const query = new URLSearchParams(location.search);
  const thumbnailMode = query.get('panelThumb') === '1';
  const thumbnailId = query.get('thumbId') || '';
  const THUMBNAIL_CHANNEL = 'player-panel-squaremap-thumbnail';
  let thumbnailSnapshotSent = false;
  const thumbnailTarget = {
    x: Number(query.get('x')),
    z: Number(query.get('z')),
    zoom: Number(query.get('zoom'))
  };

  let session = '';
  let serverId = 0;
  let pickerActive = false;
  let worldId = query.get('world') || 'minecraft:overworld';
  let last = null;
  let gesture = null;
  let lastSent = '';
  let lastSentAt = 0;
  let lastInteractionPoint = null;
  let lastInteractionAt = 0;

  let markerElement = null;
  let markerMap = null;
  let markerLatLng = null;
  let markerFallbackPoint = null;
  let markerLocation = null;
  let markerState = 'reading';
  let markerResult = null;
  let markerEventsBound = false;

  function post(type, payload = {}) {
    if (!session || window.parent === window) return;
    window.parent.postMessage({
      channel: CHANNEL,
      version: VERSION,
      provider: PROVIDER,
      type,
      session,
      serverId,
      world: worldId,
      ...payload
    }, '*');
  }

  function numbers(text) {
    return [...String(text || '').matchAll(/-?\d+(?:\.\d+)?/g)]
      .map((match) => Number(match[0]))
      .filter(Number.isFinite);
  }

  function mapElement() {
    return document.querySelector('.leaflet-container') || document.getElementById('map');
  }

  function coordinatesElement() {
    return document.querySelector('.coordinates, .leaflet-control.coordinates, [class*="coordinates"]');
  }

  function readCoordinatesControl() {
    const node = coordinatesElement();
    const values = numbers(node?.textContent);
    if (values.length < 2) return null;
    return {
      x: values[0],
      z: values[1],
      raw: node.textContent.trim(),
      source: 'squaremap-coordinates'
    };
  }

  function squaremapObject() {
    return window.squaremap || window.Squaremap || window.squareMap || null;
  }

  function isLeafletMap(candidate) {
    return Boolean(
      candidate
      && typeof candidate.getCenter === 'function'
      && typeof candidate.containerPointToLatLng === 'function'
      && typeof candidate.latLngToContainerPoint === 'function'
      && typeof candidate.on === 'function'
      && typeof candidate.off === 'function'
    );
  }

  function scanForLeafletMap(value, depth = 0, seen = new Set()) {
    if (!value || depth > 4) return null;
    const type = typeof value;
    if (type !== 'object' && type !== 'function') return null;
    if (seen.has(value)) return null;
    seen.add(value);

    if (isLeafletMap(value)) return value;
    if (isLeafletMap(value.ctx)) return value.ctx;
    if (isLeafletMap(value.context)) return value.context;

    let keys = [];
    try {
      keys = Array.isArray(value)
        ? value.keys()
        : Object.getOwnPropertyNames(value).slice(0, 100);
    } catch (_) {
      return null;
    }

    for (const key of keys) {
      let child;
      try {
        child = value[key];
      } catch (_) {
        continue;
      }
      if (!child || child === window || child === document || child === value) continue;
      const found = scanForLeafletMap(child, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }

  function installThumbnailStyles() {
    if (!thumbnailMode) return;
    let style = document.getElementById('player-panel-squaremap-thumbnail-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'player-panel-squaremap-thumbnail-style';
      document.head.append(style);
    }
    style.textContent = `
      html, body { width:100% !important; height:100% !important; margin:0 !important; overflow:hidden !important; background:#0b1320 !important; }
      .leaflet-container, #map { width:100% !important; height:100% !important; min-height:100% !important; }
      .leaflet-control-container, .leaflet-top, .leaflet-bottom, .leaflet-control,
      .coordinates, [class*="coordinates"], [class*="control"], header, nav, footer,
      button, input, select, textarea, .sidebar, .menu, .toolbar,
      #player-panel-squaremap-overlay, #player-panel-squaremap-selection-marker { display:none !important; visibility:hidden !important; opacity:0 !important; pointer-events:none !important; }
      * { scrollbar-width:none !important; }
      *::-webkit-scrollbar { display:none !important; }
    `;
    document.documentElement.dataset.playerPanelThumbnail = '1';
  }

  function centerThumbnailMap() {
    if (!thumbnailMode) return false;
    const map = findLeafletMap();
    if (!map) return false;
    const target = locationToLatLng(map, thumbnailTarget);
    if (!target) return false;
    let zoom = Number(thumbnailTarget.zoom);
    try {
      const minZoom = Number(map.getMinZoom?.());
      const maxZoom = Number(map.getMaxZoom?.());
      if (!Number.isFinite(zoom)) zoom = Number(map.getZoom?.());
      if (Number.isFinite(minZoom)) zoom = Math.max(minZoom, zoom);
      if (Number.isFinite(maxZoom)) zoom = Math.min(maxZoom, zoom);
      if (typeof map.setView === 'function') map.setView(target, zoom, { animate: false });
      else if (typeof map.panTo === 'function') map.panTo(target, { animate: false });
      map.invalidateSize?.({ animate: false });
      return true;
    } catch (_) {
      return false;
    }
  }

  function captureThumbnailImage() {
    const mapNode = mapElement();
    if (!mapNode) return null;
    const mapRect = mapNode.getBoundingClientRect();
    if (mapRect.width < 2 || mapRect.height < 2) return null;

    const tileMeta = [...mapNode.querySelectorAll('img.leaflet-tile, .leaflet-tile-container img, img[src*="tile"]')]
      .filter((image) => image.complete && image.naturalWidth > 0)
      .map((image) => {
        const rect = image.getBoundingClientRect();
        if (!(rect.right > mapRect.left && rect.bottom > mapRect.top && rect.left < mapRect.right && rect.top < mapRect.bottom)) return null;
        let effectiveOpacity = 1;
        let node = image;
        while (node && node !== mapNode) {
          try {
            const style = getComputedStyle(node);
            const opacity = Number.parseFloat(style.opacity || '1');
            if (Number.isFinite(opacity)) effectiveOpacity *= opacity;
            if (style.display === 'none' || style.visibility === 'hidden') effectiveOpacity = 0;
          } catch (_) {
            // Keep the opacity calculated up to this point.
          }
          node = node.parentElement;
        }
        return { image, rect, effectiveOpacity };
      })
      .filter(Boolean);
    if (!tileMeta.length) return null;

    // During Leaflet fade transitions, visible tiles often have opacity < 1.
    // Use the most visible layer, but draw the original pixels at 100%
    // to avoid a translucent black overlay in the capture.
    const maxOpacity = Math.max(...tileMeta.map((item) => item.effectiveOpacity));
    const threshold = Math.max(0.01, maxOpacity - 0.08);
    const candidates = tileMeta
      .filter((item) => item.effectiveOpacity >= threshold)
      .slice(0, 48);
    if (!candidates.length) return null;

    const pixelRatio = Math.max(1, Math.min(2, Number(window.devicePixelRatio) || 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(mapRect.width * pixelRatio));
    canvas.height = Math.max(1, Math.round(mapRect.height * pixelRatio));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return null;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.imageSmoothingEnabled = false;
    context.fillStyle = '#0b1320';
    context.fillRect(0, 0, mapRect.width, mapRect.height);

    let drawn = 0;
    context.globalAlpha = 1;
    for (const item of candidates) {
      const { image, rect } = item;
      try {
        context.drawImage(image, rect.left - mapRect.left, rect.top - mapRect.top, rect.width, rect.height);
        drawn += 1;
      } catch (_) {
        // The image may still be changing during a zoom transition.
      }
    }
    if (!drawn) return null;

    try {
      const imageDataUrl = canvas.toDataURL('image/png');
      if (!imageDataUrl.startsWith('data:image/')) return null;
      return { width: mapRect.width, height: mapRect.height, imageDataUrl };
    } catch (_) {
      // A canvas tainted by an external origin cannot be exported.
      return null;
    }
  }

  function postThumbnailSnapshot(snapshot) {
    if (!thumbnailMode || thumbnailSnapshotSent || window.parent === window || !snapshot?.imageDataUrl) return;
    thumbnailSnapshotSent = true;
    window.parent.postMessage({
      channel: THUMBNAIL_CHANNEL,
      type: 'snapshot',
      thumbId: thumbnailId,
      width: snapshot.width,
      height: snapshot.height,
      imageDataUrl: snapshot.imageDataUrl
    }, '*');
  }

  function postThumbnailUnavailable() {
    if (!thumbnailMode || thumbnailSnapshotSent || window.parent === window) return;
    thumbnailSnapshotSent = true;
    window.parent.postMessage({ channel: THUMBNAIL_CHANNEL, type: 'unavailable', thumbId: thumbnailId }, '*');
  }

  function scheduleThumbnailMode() {
    if (!thumbnailMode) return;
    installThumbnailStyles();
    let attempts = 0;
    const trySnapshot = () => {
      if (thumbnailSnapshotSent) return;
      attempts += 1;
      centerThumbnailMap();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const snapshot = captureThumbnailImage();
        if (snapshot) {
          postThumbnailSnapshot(snapshot);
          return;
        }
        if (attempts >= 24) {
          postThumbnailUnavailable();
          return;
        }
        window.setTimeout(trySnapshot, 250);
      }));
    };
    window.setTimeout(trySnapshot, 300);
  }

  function findLeafletMap() {
    const sm = squaremapObject();
    const direct = [
      sm?.map,
      sm?.leafletMap,
      window.map,
      window.leafletMap
    ];
    for (const candidate of direct) {
      if (isLeafletMap(candidate)) return candidate;
    }

    const map = mapElement();
    if (!map) return null;

    const eventProperties = [];
    try {
      for (const key of Object.getOwnPropertyNames(map)) {
        if (/leaflet|event/i.test(key)) {
          try {
            eventProperties.push(map[key]);
          } catch (_) {
            // Ignore inaccessible DOM properties.
          }
        }
      }
    } catch (_) {
      // Continue with a shallow scan of the element itself.
    }

    for (const registry of eventProperties) {
      const found = scanForLeafletMap(registry);
      if (found) return found;
    }
    return scanForLeafletMap(map, 0);
  }

  function readLeafletCenter() {
    const sm = squaremapObject();
    const candidates = [findLeafletMap(), sm?.map, sm?.leafletMap, window.map];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.getCenter !== 'function') continue;
      try {
        const center = candidate.getCenter();
        if (!center) continue;
        if (typeof sm?.toPoint === 'function') {
          const point = sm.toPoint(center);
          const x = Number(point?.x);
          const z = Number(point?.z);
          if (Number.isFinite(x) && Number.isFinite(z)) {
            return { x, z, source: 'squaremap-api-center' };
          }
        }

        const scale = Number(candidate.options?.scale);
        if (Number.isFinite(scale) && scale > 0) {
          const x = Number(center.lng) / scale;
          const z = -Number(center.lat) / scale;
          if (Number.isFinite(x) && Number.isFinite(z)) {
            return { x, z, source: 'leaflet-scaled-center' };
          }
        }
      } catch (_) {
        // Try another candidate.
      }
    }
    return null;
  }

  function dispatchMouseMove(point) {
    const map = mapElement();
    if (!map || !point) return;
    map.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      view: window
    }));
  }

  function formatCoordinate(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return Number.isInteger(number) ? String(number) : number.toFixed(1);
  }

  function ensureMarkerStyles() {
    if (document.getElementById(MARKER_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = MARKER_STYLE_ID;
    style.textContent = `
      #${MARKER_ID} {
        --pp-marker-color: #f59e0b;
        position: absolute;
        left: 0;
        top: 0;
        z-index: 1000002;
        width: 44px;
        height: 58px;
        transform: translate3d(-9999px, -9999px, 0) translate(-50%, -100%);
        transform-origin: 50% 100%;
        pointer-events: none;
        filter: drop-shadow(0 5px 7px rgba(0, 0, 0, .45));
        transition: opacity .15s ease;
      }
      #${MARKER_ID}[data-state="success"] { --pp-marker-color: #22c55e; }
      #${MARKER_ID}[data-state="error"] { --pp-marker-color: #ef4444; }
      #${MARKER_ID}[data-state="reading"],
      #${MARKER_ID}[data-state="pending"] { --pp-marker-color: #f59e0b; }
      #${MARKER_ID} .pp-squaremap-marker-pin {
        position: absolute;
        left: 50%;
        top: 0;
        width: 34px;
        height: 42px;
        transform: translateX(-50%);
      }
      #${MARKER_ID} .pp-squaremap-marker-pin svg {
        display: block;
        width: 34px;
        height: 42px;
        overflow: visible;
      }
      #${MARKER_ID} .pp-squaremap-marker-pin path {
        fill: var(--pp-marker-color);
        stroke: #fff;
        stroke-width: 2.2;
      }
      #${MARKER_ID} .pp-squaremap-marker-pin circle {
        fill: #fff;
      }
      #${MARKER_ID} .pp-squaremap-marker-ring {
        position: absolute;
        left: 50%;
        bottom: 0;
        width: 22px;
        height: 10px;
        border: 3px solid var(--pp-marker-color);
        border-radius: 50%;
        transform: translateX(-50%);
        background: rgba(255, 255, 255, .2);
      }
      #${MARKER_ID}[data-state="reading"] .pp-squaremap-marker-ring,
      #${MARKER_ID}[data-state="pending"] .pp-squaremap-marker-ring {
        animation: pp-squaremap-marker-pulse 1.15s ease-out infinite;
      }
      #${MARKER_ID} .pp-squaremap-marker-label {
        position: absolute;
        left: 50%;
        bottom: 57px;
        transform: translateX(-50%);
        min-width: max-content;
        max-width: min(260px, 80vw);
        padding: 6px 9px;
        border: 1px solid rgba(255,255,255,.7);
        border-radius: 8px;
        background: rgba(15, 23, 42, .94);
        color: #fff;
        font: 700 12px/1.25 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-align: center;
        box-shadow: 0 5px 18px rgba(0,0,0,.35);
        white-space: nowrap;
      }
      #${MARKER_ID} .pp-squaremap-marker-label small {
        display: block;
        margin-top: 2px;
        color: rgba(255,255,255,.78);
        font-size: 10px;
        font-weight: 600;
      }
      @keyframes pp-squaremap-marker-pulse {
        0% { transform: translateX(-50%) scale(.75); opacity: 1; }
        100% { transform: translateX(-50%) scale(1.7); opacity: 0; }
      }
    `;
    document.head.append(style);
  }

  function ensureMarkerElement() {
    const map = mapElement();
    if (!map) return null;
    ensureMarkerStyles();

    markerElement = document.getElementById(MARKER_ID);
    if (markerElement && markerElement.parentElement !== map) {
      markerElement.remove();
      markerElement = null;
    }
    if (markerElement) return markerElement;

    markerElement = document.createElement('div');
    markerElement.id = MARKER_ID;
    markerElement.dataset.state = 'reading';
    markerElement.setAttribute('role', 'img');
    markerElement.setAttribute('aria-live', 'polite');
    markerElement.innerHTML = `
      <div class="pp-squaremap-marker-label">
        <span>Selecting point…</span>
        <small>Player Panel</small>
      </div>
      <div class="pp-squaremap-marker-pin" aria-hidden="true">
        <svg viewBox="0 0 34 42">
          <path d="M17 1.5C8.45 1.5 1.5 8.45 1.5 17c0 11.65 15.5 23.5 15.5 23.5S32.5 28.65 32.5 17C32.5 8.45 25.55 1.5 17 1.5Z"/>
          <circle cx="17" cy="17" r="5.2"/>
        </svg>
      </div>
      <div class="pp-squaremap-marker-ring" aria-hidden="true"></div>
    `;
    map.append(markerElement);
    return markerElement;
  }

  function markerLabel() {
    return markerElement?.querySelector('.pp-squaremap-marker-label');
  }

  function setMarkerVisual(state, location = markerLocation, result = markerResult) {
    const marker = ensureMarkerElement();
    if (!marker) return;

    markerState = state || markerState;
    markerLocation = location || markerLocation;
    markerResult = result || null;
    marker.dataset.state = markerState;

    const x = Number(markerLocation?.x);
    const z = Number(markerLocation?.z);
    const y = Number(markerResult?.y);
    const label = markerLabel();

    let title = 'Selecting point…';
    let detail = 'Player Panel';

    if (markerState === 'pending') {
      title = Number.isFinite(x) && Number.isFinite(z)
        ? `X ${formatCoordinate(x)} · Z ${formatCoordinate(z)}`
        : 'Selected position';
      detail = 'Calculando altura segura…';
    } else if (markerState === 'success') {
      title = [x, y, z].every(Number.isFinite)
        ? `X ${formatCoordinate(x)} · Y ${formatCoordinate(y)} · Z ${formatCoordinate(z)}`
        : 'Safe position confirmed';
      detail = 'Destination ready to save';
    } else if (markerState === 'error') {
      title = Number.isFinite(x) && Number.isFinite(z)
        ? `X ${formatCoordinate(x)} · Z ${formatCoordinate(z)}`
        : 'The position could not be resolved';
      detail = 'Select another point or enter Y manually';
    }

    if (label) {
      label.innerHTML = '';
      const main = document.createElement('span');
      main.textContent = title;
      const small = document.createElement('small');
      small.textContent = detail;
      label.append(main, small);
    }
    marker.setAttribute('aria-label', `${title}. ${detail}`);
  }

  function unbindMarkerMapEvents() {
    if (!markerMap || !markerEventsBound) return;
    for (const event of ['move', 'zoom', 'viewreset', 'resize', 'moveend', 'zoomend']) {
      try {
        markerMap.off(event, updateMarkerPosition);
      } catch (_) {
        // Ignore stale maps.
      }
    }
    markerEventsBound = false;
  }

  function bindMarkerMapEvents(map) {
    if (!map || !isLeafletMap(map)) return;
    if (markerMap === map && markerEventsBound) return;
    unbindMarkerMapEvents();
    markerMap = map;
    for (const event of ['move', 'zoom', 'viewreset', 'resize', 'moveend', 'zoomend']) {
      try {
        markerMap.on(event, updateMarkerPosition);
      } catch (_) {
        // A missing event does not prevent the marker from working.
      }
    }
    markerEventsBound = true;
  }

  function pointInsideMap(point) {
    const map = mapElement();
    if (!map || !point) return null;
    const rect = map.getBoundingClientRect();
    return {
      x: Number(point.x) - rect.left,
      y: Number(point.y) - rect.top
    };
  }

  function locationToLatLng(map, location) {
    const x = Number(location?.x);
    const z = Number(location?.z);
    const scale = Number(map?.options?.scale);
    if (![x, z, scale].every(Number.isFinite) || scale <= 0) return null;
    return { lat: -z * scale, lng: x * scale };
  }

  function updateMarkerPosition() {
    const marker = markerElement || ensureMarkerElement();
    const mapNode = mapElement();
    if (!marker || !mapNode) return;

    let point = null;
    if (markerMap && markerLatLng) {
      try {
        const projected = markerMap.latLngToContainerPoint(markerLatLng);
        const x = Number(projected?.x);
        const y = Number(projected?.y);
        if (Number.isFinite(x) && Number.isFinite(y)) point = { x, y };
      } catch (_) {
        // Fall back to the original screen point.
      }
    }
    if (!point && markerFallbackPoint) point = markerFallbackPoint;
    if (!point) return;

    marker.style.transform =
      `translate3d(${Math.round(point.x)}px, ${Math.round(point.y)}px, 0) translate(-50%, -100%)`;
  }

  function showSelectionMarker(location, screenPoint, state = 'pending', result = null) {
    markerLocation = location || markerLocation;
    markerState = state;
    markerResult = result;

    const marker = ensureMarkerElement();
    if (!marker) return;

    const map = findLeafletMap();
    const localPoint = pointInsideMap(screenPoint);

    markerLatLng = null;
    markerFallbackPoint = localPoint;

    if (map) {
      bindMarkerMapEvents(map);
      try {
        if (localPoint) {
          markerLatLng = map.containerPointToLatLng(localPoint);
        } else if (location) {
          markerLatLng = locationToLatLng(map, location);
        }
      } catch (_) {
        markerLatLng = null;
      }
    }

    setMarkerVisual(state, markerLocation, result);
    updateMarkerPosition();
  }

  function clearSelectionMarker() {
    unbindMarkerMapEvents();
    markerElement?.remove();
    markerElement = null;
    markerMap = null;
    markerLatLng = null;
    markerFallbackPoint = null;
    markerLocation = null;
    markerResult = null;
    markerState = 'reading';
  }

  function readAt(point, selected, reason) {
    if (selected) {
      showSelectionMarker(last, point, 'reading');
    }

    dispatchMouseMove(point);
    const delays = [0, 32, 90, 180];

    for (const delay of delays) {
      setTimeout(() => {
        const location = readCoordinatesControl() || readLeafletCenter();
        if (!location) return;

        last = location;
        if (selected) {
          showSelectionMarker(location, point, 'pending');
        }

        const signature =
          `${Math.round(location.x * 1000)}|${Math.round(location.z * 1000)}|${selected}`;
        const now = Date.now();

        if (selected && signature === lastSent && now - lastSentAt < 700) return;
        if (selected) {
          lastSent = signature;
          lastSentAt = now;
        }
        post('center', {
          ...location,
          selected: Boolean(selected),
          reason
        });
      }, delay);
    }
  }

  function centerPoint() {
    const map = mapElement();
    if (!map) return null;
    const rect = map.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  }

  function isMapEvent(event) {
    const map = mapElement();
    return Boolean(map && event.target && map.contains(event.target));
  }

  function eventPoint(event) {
    const touch = event.changedTouches?.[0] || event.touches?.[0];
    return touch
      ? { x: touch.clientX, y: touch.clientY }
      : { x: event.clientX, y: event.clientY };
  }

  function isDuplicateInteraction(point) {
    const now = Date.now();
    const previous = lastInteractionPoint;
    const close = point && previous
      && Math.hypot(point.x - previous.x, point.y - previous.y) < 24;
    if (close && now - lastInteractionAt < 650) return true;
    lastInteractionPoint = point;
    lastInteractionAt = now;
    return false;
  }

  function startGesture(event) {
    if (!pickerActive || !isMapEvent(event)) return;
    const point = eventPoint(event);
    gesture = {
      ...point,
      moved: false,
      at: Date.now(),
      multi: Boolean(event.touches && event.touches.length > 1)
    };
  }

  function moveGesture(event) {
    if (!gesture) return;
    const point = eventPoint(event);
    if (Math.hypot(point.x - gesture.x, point.y - gesture.y) > 14) {
      gesture.moved = true;
      if (!markerMap && markerElement) clearSelectionMarker();
    }
    if (event.touches && event.touches.length > 1) gesture.multi = true;
  }

  function endGesture(event) {
    if (!gesture) return;
    const current = gesture;
    gesture = null;

    if (
      !pickerActive
      || !isMapEvent(event)
      || current.moved
      || current.multi
      || Date.now() - current.at > 1000
    ) return;

    const point = eventPoint(event);
    if (isDuplicateInteraction(point)) return;
    readAt(point, true, 'squaremap-touch');
  }

  function addOverlay() {
    if (document.getElementById('player-panel-squaremap-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'player-panel-squaremap-overlay';
    overlay.textContent = 'Tap the map: the pin marks the selected point';
    overlay.style.cssText =
      'position:fixed;left:10px;bottom:10px;z-index:999999;padding:8px 11px;border-radius:8px;background:rgba(15,23,42,.9);color:#fff;font:600 12px system-ui;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.35)';
    document.body.append(overlay);
  }

  function removeOverlay() {
    document.getElementById('player-panel-squaremap-overlay')?.remove();
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.channel !== CHANNEL || Number(data.version) !== VERSION) return;

    if (data.type === 'picker:start') {
      session = String(data.session || '');
      serverId = Number(data.serverId || 0);
      pickerActive = true;
      worldId = String(data.world || data.worldId || worldId || 'minecraft:overworld');
      clearSelectionMarker();
      addOverlay();
      post('ready', {
        capabilities: [
          'quick-xz',
          'touch',
          'leaflet-center',
          'coordinate-control',
          'selection-marker',
          'marker-safe-position-state'
        ],
        provider: PROVIDER
      });
      setTimeout(() => readAt(centerPoint(), false, 'initial-center'), 350);
      return;
    }

    if (data.session !== session) return;

    if (data.type === 'picker:stop') {
      pickerActive = false;
      clearSelectionMarker();
      removeOverlay();
    } else if (data.type === 'picker:request-center') {
      const point = centerPoint();
      if (point) {
        readAt(point, Boolean(data.selected), 'center-button');
      } else if (last) {
        if (data.selected) showSelectionMarker(last, null, 'pending');
        post('center', {
          ...last,
          selected: Boolean(data.selected),
          reason: 'last-known'
        });
      } else {
        post('center-unavailable', {
          message: 'squaremap has not reported the center position yet.'
        });
      }
    } else if (data.type === 'picker:resolve-result') {
      if (data.ok) {
        const position = data.position || {};
        markerResult = position;
        setMarkerVisual('success', markerLocation || last, position);
      } else {
        setMarkerVisual('error', markerLocation || last, null);
      }
      updateMarkerPosition();
    }
  });

  if (thumbnailMode) {
    scheduleThumbnailMode();
    console.info('[Player Panel] squaremap bridge v6 thumbnail mode loaded');
    return;
  }

  document.addEventListener('touchstart', startGesture, {
    capture: true,
    passive: true
  });
  document.addEventListener('touchmove', moveGesture, {
    capture: true,
    passive: true
  });
  document.addEventListener('touchend', endGesture, {
    capture: true,
    passive: true
  });
  document.addEventListener('pointerdown', startGesture, true);
  document.addEventListener('pointermove', moveGesture, true);
  document.addEventListener('pointerup', endGesture, true);
  document.addEventListener('click', (event) => {
    if (!pickerActive || !isMapEvent(event)) return;
    const point = eventPoint(event);
    if (isDuplicateInteraction(point)) return;
    readAt(point, true, 'squaremap-click');
  }, true);

  console.info('[Player Panel] squaremap bridge v6 loaded');
})();
