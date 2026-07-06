(() => {
  'use strict';

  const CHANNEL = 'player-panel-map-bridge';
  const VERSION = 1;
  const PROVIDER = 'bluemap';
  const BRIDGE_VERSION = 6;
  const BRIDGE_ATTR = 'data-player-panel-map-bridge-v6';
  const STYLE_ID = 'player-panel-bluemap-lite-v6';

  let pickerActive = false;
  let pickerMode = 'exact';
  let mobileMode = false;
  let parentOrigin = '';
  let parentSession = '';
  let parentServerId = '';
  let overlay = null;
  let crosshair = null;
  let observer = null;
  let centerTimer = null;
  let pendingSelectionUntil = 0;
  let resolving = false;
  let flatViewAttempted = false;
  let lastCenter = null;
  let lastCenterSignature = '';
  let lastSelectedSignature = '';
  let lastExactSignature = '';
  let gesture = null;
  let lastInteractionAt = 0;
  let lastInteractionPoint = null;
  let interactionSequence = 0;
  let pendingInteractionSequence = 0;
  let popupMarkerHookInstalled = false;
  let centerProbeTimer = null;

  window.__PLAYER_PANEL_BLUEMAP_BRIDGE__ = {
    version: BRIDGE_VERSION,
    loadedAt: new Date().toISOString(),
    capabilities: ['quick-xz', 'safe-height', 'exact-xyz', 'single-selection', 'mobile-lite', 'flat-view-attempt', 'ios-touch', 'click-fallback', 'camera-center-fallback', 'popup-marker-hook']
  };
  console.info('[Player Panel] BlueMap bridge v6 loaded');

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeText(raw) {
    return String(raw || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function parseXYZ(raw) {
    const text = normalizeText(raw);
    if (!text || text.length > 600) return null;
    const match = text.match(/(?:\bblock\s*:\s*)?\bx\s*[:=]?\s*(-?\d+(?:\.\d+)?)\D+?\by\s*[:=]?\s*(-?\d+(?:\.\d+)?)\D+?\bz\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i);
    if (!match) return null;
    const x = finite(match[1]);
    const y = finite(match[2]);
    const z = finite(match[3]);
    return [x, y, z].every(Number.isFinite) ? { x, y, z, raw: text } : null;
  }

  function parseXZ(raw) {
    const text = normalizeText(raw);
    if (!text || text.length > 500) return null;
    const match = text.match(/\bx\s*[:=]?\s*(-?\d+(?:\.\d+)?)\D+?\bz\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i);
    if (!match) return null;
    const x = finite(match[1]);
    const z = finite(match[2]);
    return [x, z].every(Number.isFinite) ? { x, z, raw: text } : null;
  }

  function visible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function detectMapId() {
    const candidates = [
      window.bluemap?.map?.id,
      window.bluemap?.map?.mapId,
      window.bluemap?.mapViewer?.map?.id,
      window.bluemap?.mapViewer?.map?.mapId,
      window.bluemap?.settings?.map,
      window.bluemap?.selectedMap?.id
    ];
    for (const value of candidates) {
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    try {
      const url = new URL(window.location.href);
      for (const key of ['map', 'mapId', 'world']) {
        const value = url.searchParams.get(key);
        if (value) return value;
      }
      const hash = decodeURIComponent(url.hash || '');
      for (const pattern of [/(?:^|[?&#/])(?:map|mapId|world)=([^&#/]+)/i, /(?:^|#)([a-zA-Z0-9_.-]+):(?:-?\d|$)/]) {
        const match = hash.match(pattern);
        if (match) return match[1];
      }
    } catch (_) { /* ignore */ }
    return '';
  }

  function post(type, payload = {}) {
    if (!window.parent || window.parent === window || !parentOrigin || !parentSession) return;
    window.parent.postMessage({
      channel: CHANNEL,
      version: VERSION,
      type,
      provider: PROVIDER,
      mapId: detectMapId(),
      bridgeVersion: BRIDGE_VERSION,
      session: parentSession,
      serverId: parentServerId,
      ...payload
    }, parentOrigin);
  }

  function updateOverlay(message, actionLabel = '') {
    const detail = overlay?.querySelector('[data-player-panel-map-detail]');
    if (detail) detail.textContent = message;
    const action = overlay?.querySelector('[data-player-panel-map-action]');
    if (action) {
      action.textContent = actionLabel || (mobileMode ? 'Use visible center' : 'Use selected X/Z');
      action.hidden = pickerMode !== 'quick' || !lastCenter;
      action.disabled = resolving;
    }
  }

  function showOverlay() {
    if (overlay || !document.body) return;
    overlay = document.createElement('aside');
    overlay.setAttribute(BRIDGE_ATTR, '');
    overlay.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'left:12px', 'bottom:12px',
      'max-width:min(480px,calc(100vw - 24px))', 'padding:10px 12px',
      'border:1px solid rgba(255,255,255,.24)', 'border-radius:10px',
      'background:rgba(10,15,25,.92)', 'color:#fff', 'font:13px/1.35 system-ui,sans-serif',
      'box-shadow:0 8px 30px rgba(0,0,0,.35)'
    ].join(';');
    const title = document.createElement('strong');
    title.textContent = 'Player Panel picker connected';
    title.style.display = 'block';
    const detail = document.createElement('span');
    detail.setAttribute('data-player-panel-map-detail', '');
    detail.style.cssText = 'display:block;margin-top:3px;opacity:.84';
    const action = document.createElement('button');
    action.type = 'button';
    action.setAttribute('data-player-panel-map-action', '');
    action.hidden = true;
    action.style.cssText = 'display:block;width:100%;margin-top:8px;padding:7px 10px;border:0;border-radius:7px;cursor:pointer;background:#3b82f6;color:#fff;font:700 13px/1.2 system-ui,sans-serif';
    action.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (lastCenter && !resolving) sendXZ(lastCenter, true, 'overlay-button-v6');
    }, true);
    overlay.append(title, detail, action);
    document.body.append(overlay);
    updateModePresentation();
  }

  function hideOverlay() {
    overlay?.remove();
    overlay = null;
  }

  function ensureCrosshair() {
    if (crosshair || !document.body) return;
    crosshair = document.createElement('div');
    crosshair.setAttribute('data-player-panel-map-crosshair-v6', '');
    crosshair.setAttribute('aria-hidden', 'true');
    crosshair.style.cssText = [
      'position:fixed', 'z-index:2147483646', 'left:50%', 'top:50%',
      'width:22px', 'height:22px', 'transform:translate(-50%,-50%)',
      'pointer-events:none', 'filter:drop-shadow(0 1px 2px rgba(0,0,0,.9))'
    ].join(';');
    crosshair.innerHTML = '<span style="position:absolute;left:10px;top:2px;width:2px;height:18px;background:#fff;border-radius:2px"></span><span style="position:absolute;left:2px;top:10px;width:18px;height:2px;background:#fff;border-radius:2px"></span>';
    document.body.append(crosshair);
  }

  function hideCrosshair() {
    crosshair?.remove();
    crosshair = null;
  }

  function installLiteCss() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      html.player-panel-map-lite *, html.player-panel-map-lite *::before, html.player-panel-map-lite *::after {
        animation-duration: 0.001ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.001ms !important;
        backdrop-filter: none !important;
      }
      html.player-panel-map-lite [${BRIDGE_ATTR}] { backdrop-filter:none !important; }
    `;
    document.head?.append(style);
  }

  function reduceRendererResolution() {
    if (!mobileMode) return false;
    const roots = [window.bluemap, window.BlueMap, window.mapViewer].filter(Boolean);
    const seen = new WeakSet();
    let visited = 0;
    let changed = false;
    function walk(value, depth) {
      if (!value || (typeof value !== 'object' && typeof value !== 'function') || depth > 4 || visited > 700) return;
      if (seen.has(value)) return;
      seen.add(value); visited += 1;
      try {
        if (typeof value.setPixelRatio === 'function') {
          const current = typeof value.getPixelRatio === 'function' ? Number(value.getPixelRatio()) : Infinity;
          if (!Number.isFinite(current) || current > 1) {
            value.setPixelRatio(1);
            changed = true;
          }
        }
      } catch (_) { /* ignore */ }
      let keys = [];
      try { keys = Object.keys(value).slice(0, 120); } catch (_) { return; }
      for (const key of keys) {
        if (/^(parent|children|domElement)$/i.test(key)) continue;
        let child;
        try { child = value[key]; } catch (_) { continue; }
        walk(child, depth + 1);
      }
    }
    for (const root of roots) walk(root, 0);
    return changed;
  }

  function attemptFlatView() {
    if (flatViewAttempted || pickerMode !== 'quick') return false;
    flatViewAttempted = true;
    const pattern = /(?:flat|2d|top(?:[- ]?down)?|orthographic|vista\s+plana|plano)/i;
    for (const element of document.querySelectorAll('button,[role="button"],a')) {
      if (!visible(element) || element.closest(`[${BRIDGE_ATTR}]`)) continue;
      const label = normalizeText([
        element.getAttribute('aria-label'), element.getAttribute('title'),
        element.getAttribute('data-tooltip'), element.textContent
      ].filter(Boolean).join(' '));
      if (!pattern.test(label)) continue;
      try { element.click(); return true; } catch (_) { /* continue */ }
    }
    return false;
  }

  function applyLiteMode() {
    installLiteCss();
    document.documentElement.classList.toggle('player-panel-map-lite', mobileMode && pickerMode === 'quick');
    if (pickerMode === 'quick') {
      window.setTimeout(attemptFlatView, 250);
      window.setTimeout(attemptFlatView, 1200);
    }
    if (mobileMode) {
      window.setTimeout(reduceRendererResolution, 400);
      window.setTimeout(reduceRendererResolution, 1800);
    }
  }

  function updateModePresentation() {
    if (!pickerActive) return;
    if (pickerMode === 'quick') {
      ensureCrosshair();
      updateOverlay(lastCenter
        ? `X ${lastCenter.x}, Z ${lastCenter.z}. Tap another point or use “Use visible center”.`
        : 'Quick X/Z mode: tap a point or move the map under the crosshair and use the button; Minecraft will calculate Y.');
    } else {
      hideCrosshair();
      updateOverlay('Exact 3D mode: wait for geometry and click the X/Y/Z block.');
    }
    applyLiteMode();
  }

  function sendXYZ(location, reason) {
    if (!pickerActive || pickerMode !== 'exact') return false;
    const parsed = typeof location === 'string' ? parseXYZ(location) : location;
    const x = finite(parsed?.x); const y = finite(parsed?.y); const z = finite(parsed?.z);
    if (![x, y, z].every(Number.isFinite)) return false;
    const signature = `${x}|${y}|${z}|${detectMapId()}`;
    if (signature === lastExactSignature) return true;
    lastExactSignature = signature;
    post('coordinates', { x, y, z, raw: parsed.raw || '', reason });
    updateOverlay(`Exact coordinates sent: ${x}, ${y}, ${z}`);
    return true;
  }

  function sendXZ(location, selected, reason) {
    if (!pickerActive || pickerMode !== 'quick') return false;
    const parsed = typeof location === 'string' ? parseXZ(location) : location;
    const x = finite(parsed?.x); const z = finite(parsed?.z);
    if (![x, z].every(Number.isFinite)) return false;
    lastCenter = { x, z, raw: parsed.raw || '' };
    const signature = `${x}|${z}|${detectMapId()}`;
    if (!selected) {
      if (signature === lastCenterSignature) return true;
      lastCenterSignature = signature;
      post('center', { x, z, raw: parsed.raw || '', selected: false, reason });
      updateOverlay(`X ${x}, Z ${z}.`, 'Use selected X/Z');
      return true;
    }
    if (resolving || signature === lastSelectedSignature) return true;
    lastSelectedSignature = signature;
    resolving = true;
    post('center', { x, z, raw: parsed.raw || '', selected: true, reason });
    updateOverlay(`X/Z enviados: ${x}, ${z}. Calculando Y…`, 'Calculando altura…');
    return true;
  }

  function elementCandidates(root = document) {
    const result = [];
    if (root instanceof Element) result.push(root);
    if (root?.querySelectorAll) root.querySelectorAll('div,section,aside,article,span,p').forEach((node) => result.push(node));
    return result;
  }

  function smallestPopup(root, kind) {
    let best = null;
    for (const element of elementCandidates(root)) {
      if (!(element instanceof Element) || !visible(element)) continue;
      if (element.closest(`[${BRIDGE_ATTR}]`)) continue;
      const text = normalizeText(element.textContent);
      if (!text || text.length > 300) continue;
      let location = null;
      if (kind === 'exact') {
        if (!/\bblock\s*:/i.test(text)) continue;
        location = parseXYZ(text);
      } else {
        if (!/\b(?:position|position)\s*:/i.test(text) || /\by\s*[:=]/i.test(text)) continue;
        location = parseXZ(text);
      }
      if (!location) continue;
      if (!best || text.length < best.text.length) best = { element, text, location };
    }
    return best;
  }

  function findHudXZ() {
    let best = null;
    for (const element of elementCandidates(document)) {
      if (!(element instanceof Element) || !visible(element)) continue;
      if (element.closest(`[${BRIDGE_ATTR}]`)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.top > Math.max(180, window.innerHeight * 0.25)) continue;
      const text = normalizeText(element.textContent);
      if (!text || text.length > 100 || /\b(?:block|position|position)\s*:/i.test(text) || /\by\s*[:=]/i.test(text)) continue;
      const location = parseXZ(text);
      if (!location) continue;
      if (!best || text.length < best.text.length) best = { element, text, location };
    }
    return best;
  }

  function locationSignature(location) {
    const x = finite(location?.x);
    const z = finite(location?.z);
    return [x, z].every(Number.isFinite) ? `${x}|${z}|${detectMapId()}` : '';
  }

  function readBlueMapCenter() {
    const bm = window.bluemap;
    const candidates = [
      ['controls-target', bm?.mapViewer?.controls?.target],
      ['controls-center', bm?.mapViewer?.controls?.center],
      ['controls-map-center', bm?.mapViewer?.controls?.mapCenter],
      ['controls-focus', bm?.mapViewer?.controls?.focus],
      ['viewer-target', bm?.mapViewer?.target],
      ['viewer-center', bm?.mapViewer?.center],
      ['viewer-map-center', bm?.mapViewer?.mapCenter],
      ['map-target', bm?.map?.target],
      ['map-center', bm?.map?.center]
    ];

    try {
      const controls = bm?.mapViewer?.controls;
      if (typeof controls?.getTarget === 'function') {
        candidates.unshift(['controls-get-target', controls.getTarget()]);
      }
      if (typeof controls?.getCenter === 'function') {
        candidates.unshift(['controls-get-center', controls.getCenter()]);
      }
    } catch (_) { /* ignore */ }

    for (const [source, value] of candidates) {
      const x = finite(value?.x);
      const z = finite(value?.z);
      if ([x, z].every(Number.isFinite) && Math.abs(x) <= 30000000 && Math.abs(z) <= 30000000) {
        return { x, z, raw: source, source };
      }
    }
    return null;
  }

  function bestQuickLocation({ allowLast = true } = {}) {
    const quickPopup = smallestPopup(document, 'quick');
    if (quickPopup?.location) return { ...quickPopup.location, source: 'position-popup' };

    const exactPopup = smallestPopup(document, 'exact');
    if (exactPopup?.location) {
      return {
        x: exactPopup.location.x,
        z: exactPopup.location.z,
        raw: exactPopup.location.raw,
        source: 'block-popup'
      };
    }

    const internalCenter = readBlueMapCenter();
    if (internalCenter) return internalCenter;

    const hud = findHudXZ();
    if (hud?.location) return { ...hud.location, source: 'hud' };

    return allowLast && lastCenter ? { ...lastCenter, source: 'last-known' } : null;
  }

  function installPopupMarkerHook() {
    if (popupMarkerHookInstalled) return true;
    const marker = window.bluemap?.popupMarker;
    if (!marker || typeof marker.open !== 'function') return false;

    const original = marker.open;
    if (original?.__playerPanelV6) {
      popupMarkerHookInstalled = true;
      return true;
    }

    function wrappedOpen(...args) {
      const result = original.apply(this, args);
      window.setTimeout(() => {
        if (!pickerActive) return;
        const position = this?.position || marker?.position;
        const x = finite(position?.x);
        const y = finite(position?.y);
        const z = finite(position?.z);
        if (![x, z].every(Number.isFinite)) return;

        if (pickerMode === 'quick') {
          sendXZ({ x, z, raw: 'bluemap.popupMarker.position' }, true, 'popup-marker-v6');
        } else if (Number.isFinite(y)) {
          sendXYZ({ x, y, z, raw: 'bluemap.popupMarker.position' }, 'popup-marker-v6');
        }
      }, 0);
      return result;
    }
    wrappedOpen.__playerPanelV6 = true;
    marker.open = wrappedOpen;
    popupMarkerHookInstalled = true;
    return true;
  }

  function scheduleHookProbe() {
    for (const delay of [0, 250, 800, 1800, 3500]) {
      window.setTimeout(installPopupMarkerHook, delay);
    }
  }

  function currentEventPoint(event) {
    const touch = event?.changedTouches?.[0] || event?.touches?.[0];
    if (touch) return { x: Number(touch.clientX), y: Number(touch.clientY) };
    const x = Number(event?.clientX);
    const y = Number(event?.clientY);
    return [x, y].every(Number.isFinite) ? { x, y } : null;
  }

  function sameRecentInteraction(point) {
    const now = Date.now();
    const previous = lastInteractionPoint;
    const close = point && previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 18;
    if (now - lastInteractionAt < 420 && (!point || !previous || close)) return true;
    lastInteractionAt = now;
    lastInteractionPoint = point;
    return false;
  }

  function beginGesture(event) {
    if (!pickerActive || !isMapInteraction(event)) return;
    const point = currentEventPoint(event);
    if (!point) return;
    gesture = {
      x: point.x,
      y: point.y,
      startedAt: Date.now(),
      moved: false,
      multi: Boolean(event.touches && event.touches.length > 1)
    };
  }

  function moveGesture(event) {
    if (!gesture) return;
    const point = currentEventPoint(event);
    if (!point) return;
    if (Math.hypot(point.x - gesture.x, point.y - gesture.y) > 16) gesture.moved = true;
    if (event.touches && event.touches.length > 1) gesture.multi = true;
  }

  function endGesture(event, reason) {
    const current = gesture;
    gesture = null;
    if (!pickerActive || !isMapInteraction(event)) return;
    const point = currentEventPoint(event);
    if (sameRecentInteraction(point)) return;

    const elapsed = current ? Date.now() - current.startedAt : 0;
    const isTap = !current || (!current.moved && !current.multi && elapsed < 1000);
    if (!isTap) {
      window.setTimeout(updatePassiveCenter, 180);
      window.setTimeout(updatePassiveCenter, 600);
      return;
    }

    interactionSequence += 1;
    pendingInteractionSequence = interactionSequence;
    pendingSelectionUntil = Date.now() + 2800;
    scheduleSelectionScan(reason || 'mobile-tap-v6', interactionSequence);
  }

  function scanSelection(sequence = pendingInteractionSequence) {
    if (!pickerActive || Date.now() > pendingSelectionUntil) return false;
    if (sequence && pendingInteractionSequence && sequence !== pendingInteractionSequence) return false;

    if (pickerMode === 'quick') {
      const quickPopup = smallestPopup(document, 'quick');
      if (quickPopup?.location) {
        pendingSelectionUntil = 0;
        return sendXZ(quickPopup.location, true, 'position-popup-v6');
      }

      const exactPopup = smallestPopup(document, 'exact');
      if (exactPopup?.location) {
        pendingSelectionUntil = 0;
        return sendXZ({
          x: exactPopup.location.x,
          z: exactPopup.location.z,
          raw: exactPopup.location.raw
        }, true, 'block-popup-xz-v6');
      }
      return false;
    }

    const popup = smallestPopup(document, 'exact');
    if (!popup) return false;
    pendingSelectionUntil = 0;
    return sendXYZ(popup.location, 'map-click-v6');
  }

  function updatePassiveCenter() {
    if (!pickerActive || pickerMode !== 'quick' || resolving) return;
    installPopupMarkerHook();
    const location = bestQuickLocation({ allowLast: false });
    if (location) {
      const reason = `${location.source || 'candidate'}-center-v6`;
      sendXZ(location, false, reason);
    }
  }

  function mobileTapFallback(sequence) {
    if (!pickerActive || pickerMode !== 'quick' || resolving) return false;
    if (sequence && sequence !== pendingInteractionSequence) return false;
    if (Date.now() > pendingSelectionUntil) return false;

    const location = bestQuickLocation({ allowLast: false });
    if (!location) {
      updateOverlay('Could not read X/Z from the click. Move the map under the crosshair and press “Use visible center”.');
      return false;
    }

    pendingSelectionUntil = 0;
    return sendXZ(location, true, `mobile-${location.source || 'fallback'}-v6`);
  }

  function scheduleSelectionScan(reason = 'interaction-v6', sequence = pendingInteractionSequence) {
    for (const delay of [0, 40, 100, 200, 380, 650, 1000, 1600, 2400]) {
      window.setTimeout(() => {
        if (scanSelection(sequence)) return;
        if (pickerMode === 'quick' && mobileMode && delay >= 650) {
          if (mobileTapFallback(sequence)) return;
        }
        if (delay >= 380) updatePassiveCenter();
      }, delay);
    }
  }

  function startCenterTimer() {
    stopCenterTimer();
    centerTimer = window.setInterval(updatePassiveCenter, mobileMode ? 550 : 900);
    centerProbeTimer = window.setInterval(installPopupMarkerHook, 1800);
  }

  function stopCenterTimer() {
    if (centerTimer) clearInterval(centerTimer);
    if (centerProbeTimer) clearInterval(centerProbeTimer);
    centerTimer = null;
    centerProbeTimer = null;
  }

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(() => {
      if (!pickerActive) return;
      if (!scanSelection()) updatePassiveCenter();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
  }

  function setMode(data) {
    pickerMode = data?.mode === 'quick' ? 'quick' : 'exact';
    mobileMode = Boolean(data?.mobile);
    lastCenter = null;
    lastCenterSignature = '';
    lastSelectedSignature = '';
    lastExactSignature = '';
    pendingSelectionUntil = 0;
    resolving = false;
    flatViewAttempted = false;
    gesture = null;
    pendingInteractionSequence = 0;
    updateModePresentation();
    scheduleHookProbe();
    startCenterTimer();
    updatePassiveCenter();
  }

  function isMapInteraction(event) {
    const target = event.target;
    if (!(target instanceof Element)) return true;
    if (target.closest(`[${BRIDGE_ATTR}]`)) return false;
    if (target.closest('button,a,input,select,textarea,[role="button"],[role="menu"],[role="dialog"]')) return false;
    return true;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.channel !== CHANNEL || Number(data.version || 0) !== VERSION) return;
    parentOrigin = event.origin;
    parentSession = String(data.session || '');
    parentServerId = data.serverId ?? '';

    if (data.type === 'picker:start') {
      pickerActive = true;
      setMode(data);
      showOverlay();
      startObserver();
      startCenterTimer();
      scheduleHookProbe();
      post('ready', {
        capabilities: ['quick-xz-popup', 'hud-center-xz', 'safe-height', 'exact-xyz', 'single-selection', 'mobile-lite', 'flat-view-attempt', 'reduced-pixel-ratio', 'ios-touch', 'click-fallback', 'camera-center-fallback', 'popup-marker-hook'],
        bridgeVersion: BRIDGE_VERSION
      });
    } else if (data.type === 'picker:set-mode') {
      setMode(data);
    } else if (data.type === 'picker:request-center') {
      installPopupMarkerHook();
      updatePassiveCenter();
      const location = bestQuickLocation({ allowLast: true });
      if (location) {
        sendXZ(location, Boolean(data.selected), `parent-${location.source || 'request'}-v6`);
      } else {
        post('center-unavailable', {
          selected: Boolean(data.selected),
          message: 'BlueMap does not expose an X/Z position yet. Move the map slightly and try again.'
        });
      }
    } else if (data.type === 'picker:resolve-result') {
      resolving = false;
      if (data.ok) {
        const position = data.position || {};
        updateOverlay(`Safe position: ${position.x}, ${position.y}, ${position.z}.`, 'Use selected X/Z');
      } else {
        lastSelectedSignature = '';
        updateOverlay(data.message || 'A safe height could not be calculated.', 'Retry X/Z');
      }
    } else if (data.type === 'picker:stop') {
      pickerActive = false;
      stopObserver();
      stopCenterTimer();
      hideOverlay();
      hideCrosshair();
      document.documentElement.classList.remove('player-panel-map-lite');
      parentSession = '';
      parentServerId = '';
      parentOrigin = '';
    }
  });

  document.addEventListener('pointerdown', beginGesture, true);
  document.addEventListener('pointermove', moveGesture, true);
  document.addEventListener('pointerup', (event) => endGesture(event, 'pointer-tap-v6'), true);
  document.addEventListener('pointercancel', (event) => {
    if (!gesture) return;
    const current = gesture;
    if (!current.moved && !current.multi && Date.now() - current.startedAt < 1000) {
      gesture = current;
      endGesture(event, 'pointer-cancel-tap-v6');
    } else {
      gesture = null;
      window.setTimeout(updatePassiveCenter, 220);
    }
  }, true);

  document.addEventListener('touchstart', beginGesture, { capture: true, passive: true });
  document.addEventListener('touchmove', moveGesture, { capture: true, passive: true });
  document.addEventListener('touchend', (event) => endGesture(event, 'touch-tap-v6'), { capture: true, passive: true });
  document.addEventListener('touchcancel', () => { gesture = null; }, { capture: true, passive: true });

  document.addEventListener('click', (event) => {
    if (!pickerActive || !isMapInteraction(event)) return;
    const point = currentEventPoint(event);
    if (sameRecentInteraction(point)) return;
    interactionSequence += 1;
    pendingInteractionSequence = interactionSequence;
    pendingSelectionUntil = Date.now() + 2800;
    scheduleSelectionScan('click-fallback-v6', interactionSequence);
  }, true);

  document.addEventListener('copy', () => {
    if (!pickerActive) return;
    window.setTimeout(() => {
      const selection = window.getSelection?.()?.toString?.();
      if (pickerMode === 'quick') {
        const parsed = parseXZ(selection);
        if (parsed) sendXZ(parsed, true, 'copy-v6');
      } else {
        const parsed = parseXYZ(selection);
        if (parsed) sendXYZ(parsed, 'copy-v6');
      }
    }, 0);
  }, true);
})();
