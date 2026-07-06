'use strict';

const state = {
  csrf: '', view: 'dashboard', selectedUuid: null, players: [], whitelist: [], bans: [], bansSupported: null, details: null, playerFilter: 'all', playerSearch: '',
  server: {}, worlds: [], selectedWorld: '', places: [], inventory: {},
  alerts: [], history: [], sessions: [], poll: null, lastAlertId: 0, alertsInitialized: false,
  alertsPausedAt: 0, alertsSyncing: false, suppressAlertNotificationsUntil: 0,
  serverRequestSeq: 0, weatherDirty: false, weatherDraft: '', weatherDraftWorld: '',
  crafty: {}, craftyLoading: false, user: null, users: [], availablePermissions: [], accountSessions: [], accountTab: 'self',
  installPrompt: null, swRegistration: null, reloadingForUpdate: false, pushConfig: null, pushSubscription: null, metrics: null, metricsLastLoad: 0, system: null, systemLastLoad: 0, connections: null, liveSource: null, liveConnected: false, liveRefreshTimer: null, liveDisconnectTimer: null, livePlayersRevision: -1, livePlayersUpdatedAt: 0,
  dashboardLayout: null, dashboardLayoutDraft: null, dashboardEditing: false, dashboardDraggedWidget: null, dashboardDragArmed: null, dashboardDropTarget: null, dashboardResizeActive: false, dashboardMasonryObserver: null, dashboardMasonryFrame: null,
  craftyRefreshTimer: null, craftyRefreshTick: 0,
  craftyConnections: [], craftyConnectionDraftId: 0, craftyDiscoveredServers: [],
  addServerMethod: '', addServerDiscovery: [], addServerBusy: false,
  serverEditorOpen: false, wizardCraftyConnectionId: 0,
  inventoryLiveTimer: null, inventoryLiveBusy: false, inventoryFingerprint: '', inventoryUpdatedAt: 0,
  worldSceneTimer: null, worldLiveUpdatedAt: 0, runtimeState: '',
  themePreference: 'auto',
  servers: [], currentServerId: 0, timeZone: 'UTC', minecraftAuthMode: 'online', blueMapLoadedUrl: '',
  placeMapPickerActive: false, placeMapBridgeReady: false, placeMapPickerUrl: '', placeMapBridgeOrigin: '', placeMapBridgeSession: '', placeMapHandshakeTimer: null, placeMapHandshakeAttempts: 0, placeMapMode: 'exact', placeMapProvider: '', placeMapCenter: null, placeMapResolving: false, placeMapBridgeCapabilities: [],
  dirtyFormScopes: new Set(), onboarding: null, onboardingActive: false, onboardingInitialProfileId: 0
};
const $ = (id) => document.getElementById(id);
const loginView = $('loginView');
const appView = $('appView');

const THEME_STORAGE_KEY = 'player-panel-theme';
const THEME_LABELS = { auto: 'Auto', dark: 'Oscuro', light: 'Claro' };
const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
let themeTransitionTimer = null;
function normalizedThemePreference(value) { return ['auto', 'light', 'dark'].includes(value) ? value : 'auto'; }
function effectiveTheme(preference = state.themePreference) { return preference === 'auto' ? (systemThemeQuery.matches ? 'dark' : 'light') : preference; }
function syncThemePicker() {
  const currentLabel = THEME_LABELS[state.themePreference] || 'Auto';
  const label = $('themeMenuLabel');
  if (label) label.textContent = currentLabel;
  const button = $('themeMenuButton');
  if (button) {
    button.setAttribute('aria-label', `Current theme: ${currentLabel}. Change theme`);
    button.title = `Current theme: ${currentLabel}`;
  }
  document.querySelectorAll('[data-theme-choice]').forEach((button) => {
    const selected = button.dataset.themeChoice === state.themePreference;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}
function setThemeMenuOpen(open) {
  const menu = $('themeMenu');
  const button = $('themeMenuButton');
  if (!menu || !button) return;
  menu.classList.toggle('hidden', !open);
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
  $('themePicker')?.classList.toggle('open', open);
}
function commitTheme(preference, persist) {
  state.themePreference = normalizedThemePreference(preference);
  const resolved = effectiveTheme();
  document.documentElement.dataset.themePreference = state.themePreference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  syncThemePicker();
  const meta = $('themeColorMeta');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#f2f5f9' : '#111827');
  if (persist) localStorage.setItem(THEME_STORAGE_KEY, state.themePreference);
}
function applyTheme(preference, persist = true, animate = true) {
  const normalized = normalizedThemePreference(preference);
  const previousResolved = document.documentElement.dataset.theme || effectiveTheme(state.themePreference);
  const nextResolved = effectiveTheme(normalized);
  const update = () => commitTheme(normalized, persist);
  if (!animate || previousResolved === nextResolved || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return;
  }
  if (typeof document.startViewTransition === 'function') {
    document.startViewTransition(update);
    return;
  }
  document.documentElement.classList.add('theme-transition');
  update();
  clearTimeout(themeTransitionTimer);
  themeTransitionTimer = window.setTimeout(() => document.documentElement.classList.remove('theme-transition'), 360);
}
applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || 'auto', false, false);
systemThemeQuery.addEventListener?.('change', () => { if (state.themePreference === 'auto') applyTheme('auto', false, true); });

// Browser notifications are only for alerts detected while the page is active.
// Web Push remains responsible for background/locked-device notifications.
const ALERT_NOTIFICATION_MAX_AGE_SECONDS = 20;
const ALERT_BACKGROUND_RESYNC_MS = 7000;

function alertTimestampSeconds(alert) {
  const raw = alert?.ts ?? alert?.timestamp ?? 0;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1000000000000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  const parsed = Date.parse(String(raw || ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}
function alertIsRecent(alert) {
  const timestamp = alertTimestampSeconds(alert);
  if (!timestamp) return false;
  const age = Math.floor(Date.now() / 1000) - timestamp;
  return age >= -5 && age <= ALERT_NOTIFICATION_MAX_AGE_SECONDS;
}
function newestAlertId(alerts) {
  return Math.max(0, ...(alerts || []).map((alert) => Number(alert.id) || 0));
}
async function syncAlertCursor() {
  if (!state.user || state.alertsSyncing) return;
  state.alertsSyncing = true;
  try {
    const data = await request('/api/local/alerts?since=0&limit=1');
    state.lastAlertId = Math.max(state.lastAlertId, newestAlertId(data.alerts || []));
    state.alertsInitialized = true;
  } catch (_) {
    // A later polling cycle will retry.
  } finally {
    state.alertsSyncing = false;
  }
}

function show(el, visible = true) { if (el) el.classList.toggle('hidden', !visible); }
function safeNumber(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function stripMinecraftFormatting(value) { return String(value || '').replace(/§[0-9A-FK-ORX]/gi, '').trim(); }
function playerName(player) { return stripMinecraftFormatting(player?.name || player?.player || player?.displayName) || 'Player'; }
function normalizePlayer(player) { return { ...(player || {}), name: playerName(player) }; }
function initials(name) { return String(name || '?').slice(0, 2).toUpperCase(); }
function formatBool(value) { return value ? 'Yes' : 'No'; }
function panelDateTimeFormat(options = {}) {
  return new Intl.DateTimeFormat(navigator.language || 'es', { ...options, timeZone: state.timeZone || 'UTC' });
}
function formatDate(timestamp) {
  if (!timestamp) return '—';
  return panelDateTimeFormat( { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(Number(timestamp) * 1000));
}
function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(safeNumber(seconds)));
  const days = Math.floor(total / 86400); const hours = Math.floor((total % 86400) / 3600); const minutes = Math.floor((total % 3600) / 60);
  return `${days ? `${days}d ` : ''}${hours}h ${minutes}m`;
}
function formatTicks(ticks) { return formatDuration(Math.floor(safeNumber(ticks) / 20)); }
function formatBytes(value) {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'string' && /[a-z]/i.test(value)) return value;
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return String(value);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = bytes; let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  const decimals = unit === 0 ? 0 : (amount >= 100 ? 0 : amount >= 10 ? 1 : 2);
  return `${amount.toFixed(decimals)} ${units[unit]}`;
}
function formatLocation(location) {
  if (!location || !location.world) return '—';
  return `${location.world}: ${location.x}, ${location.y}, ${location.z}`;
}
function prettyMaterial(material) {
  return String(material || '').toLowerCase().split('_').filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
function avatarUrl(player) {
  const identifier = playerName(player) !== 'Player' ? playerName(player) : (player?.uuid || 'MHF_Steve');
  return `/media/player/${encodeURIComponent(identifier)}.png`;
}
function itemImageUrl(material) { return `/media/item/${encodeURIComponent(String(material || 'UNKNOWN'))}.png?v=1.10.19`; }
function fillAvatar(container, player) {
  const name = playerName(player); container.textContent = '';
  const image = document.createElement('img'); image.src = avatarUrl(player); image.alt = `Avatar for ${name}`; image.loading = 'lazy';
  image.addEventListener('error', () => { container.textContent = initials(name); }, { once: true });
  container.append(image);
}
function toast(message, error = false) {
  const el = $('toast'); el.textContent = message; el.classList.toggle('error', error); show(el, true);
  clearTimeout(el._timer); el._timer = setTimeout(() => show(el, false), 4200);
}

const FORM_SCOPE_FIELDS = {
  'system-profile': ['systemServerName', 'systemServerDefault'],
  'plugin-connection': ['pluginConnectionEnabled', 'pluginConnectionUrl', 'pluginConnectionToken', 'pluginConnectionVerifyTls'],
  'crafty-installation': ['craftyInstallationName', 'craftyInstallationUrl', 'craftyInstallationUsername', 'craftyInstallationPassword', 'craftyInstallationToken', 'craftyInstallationPanelUrl', 'craftyInstallationVerifyTls'],
  'crafty-connection': ['craftyConnectionEnabled', 'craftyConnectionAssignment', 'craftyDiscoveredServerSelect', 'craftyConnectionServerId'],
  'bluemap-connection': ['blueMapConnectionEnabled', 'blueMapConnectionUrl', 'blueMapConnectionMapId'],
  'squaremap-connection': ['squareMapConnectionEnabled', 'squareMapConnectionUrl', 'squareMapConnectionWorldId'],
  'system-retention': ['systemMetricsRetention', 'systemBackupRetention', 'systemAuditRetention', 'systemAlertRetention', 'systemTimezone'],
  'account-password': ['currentPassword', 'newPassword'],
  'account-2fa-setup': ['twoFactorCode'],
  'account-2fa-disable': ['disable2faPassword'],
  'user-editor': ['panelUserId', 'panelUsername', 'panelDisplayName', 'panelRole', 'panelPassword', 'panelActive'],
};
function scopeElements(scope) {
  const fixed = (FORM_SCOPE_FIELDS[scope] || []).map((id) => $(id)).filter(Boolean);
  if (scope === 'push-preferences') fixed.push(...document.querySelectorAll('#pushPreferences input[type="checkbox"]'));
  if (scope === 'user-editor') fixed.push(...document.querySelectorAll('#allowPermissions input, #denyPermissions input'));
  return fixed;
}
function scopeIsDirty(scope) { return state.dirtyFormScopes.has(scope); }
function markScopeDirty(scope) {
  state.dirtyFormScopes.add(scope);
  scopeElements(scope).forEach((element) => element.closest('.panel')?.classList.add('form-has-draft'));
}
function clearScopeDirty(scope) {
  state.dirtyFormScopes.delete(scope);
  const panels = new Set(scopeElements(scope).map((element) => element.closest('.panel')).filter(Boolean));
  for (const panel of panels) {
    const stillDirty = [...state.dirtyFormScopes].some((dirtyScope) => scopeElements(dirtyScope).some((element) => element.closest('.panel') === panel));
    panel.classList.toggle('form-has-draft', stillDirty);
  }
}
function clearScopes(scopes) { for (const scope of scopes) clearScopeDirty(scope); }
function controlProtected(element, scope) { return Boolean(element && (scopeIsDirty(scope) || document.activeElement === element)); }
function setGuardedValue(id, value, scope) {
  const element = $(id); if (!element || controlProtected(element, scope)) return false;
  element.value = value ?? ''; return true;
}
function setGuardedChecked(id, value, scope) {
  const element = $(id); if (!element || controlProtected(element, scope)) return false;
  element.checked = Boolean(value); return true;
}
function bindFormDraftProtection() {
  for (const [scope, ids] of Object.entries(FORM_SCOPE_FIELDS)) {
    for (const id of ids) {
      const element = $(id); if (!element || element.dataset.draftGuardBound === '1') continue;
      const eventName = element.matches('select, input[type="checkbox"], input[type="radio"]') ? 'change' : 'input';
      element.addEventListener(eventName, () => markScopeDirty(scope));
      if (eventName !== 'input' && element.matches('input:not([type="checkbox"]):not([type="radio"]), textarea')) element.addEventListener('input', () => markScopeDirty(scope));
      element.dataset.draftGuardBound = '1';
    }
  }
  document.querySelectorAll('#pushPreferences input[type="checkbox"]').forEach((element) => {
    if (element.dataset.draftGuardBound === '1') return;
    element.addEventListener('change', () => markScopeDirty('push-preferences'));
    element.dataset.draftGuardBound = '1';
  });
}

const DASHBOARD_OPTIONAL_WIDGETS = ['cpu', 'memory', 'tps', 'uptime'];
const DASHBOARD_DEFAULT_ORDER = ['world', 'online', 'unread-alerts', 'attention', 'sessions', 'actions', 'plugin-metrics', 'cpu', 'memory', 'tps', 'uptime', 'alerts', 'online-players', 'recent-sessions'];
const DASHBOARD_DEFAULT_HIDDEN = [...DASHBOARD_OPTIONAL_WIDGETS, 'recent-sessions'];
const DASHBOARD_WIDGET_KIND = {
  world: 'world', online: 'stat', 'unread-alerts': 'stat', attention: 'stat', sessions: 'stat', actions: 'stat', 'plugin-metrics': 'stat',
  cpu: 'stat', memory: 'stat', tps: 'stat', uptime: 'stat',
  alerts: 'panel', 'online-players': 'panel', 'recent-sessions': 'panel'
};
const DASHBOARD_DEFAULT_SIZES = Object.fromEntries(DASHBOARD_DEFAULT_ORDER.map((id) => [id, {
  cols: DASHBOARD_WIDGET_KIND[id] === 'world' ? 12 : DASHBOARD_WIDGET_KIND[id] === 'panel' ? 6 : 2,
  height: 0
}]));
const DASHBOARD_WIDTH_STEPS = [2, 3, 4, 6, 8, 9, 12];
function dashboardMinCols(id) { return DASHBOARD_WIDGET_KIND[id] === 'world' ? 6 : DASHBOARD_WIDGET_KIND[id] === 'panel' ? 4 : 2; }
function dashboardMinHeight(id) { return DASHBOARD_WIDGET_KIND[id] === 'world' ? 390 : DASHBOARD_WIDGET_KIND[id] === 'panel' ? 240 : 112; }
function dashboardSize(id, raw = {}) {
  const fallback = DASHBOARD_DEFAULT_SIZES[id] || { cols: 12, height: 0 };
  const minCols = dashboardMinCols(id);
  const cols = Math.max(minCols, Math.min(12, Math.round(safeNumber(raw.cols, fallback.cols))));
  let height = Math.round(safeNumber(raw.height, fallback.height));
  if (height > 0) height = Math.max(dashboardMinHeight(id), Math.min(900, height)); else height = 0;
  return { cols, height };
}
function normalizeDashboardLayout(layout = {}) {
  const sourceVersion = Math.max(0, Math.floor(safeNumber(layout.version, 0)));
  const order = [];
  for (const id of Array.isArray(layout.order) ? layout.order : []) if (DASHBOARD_DEFAULT_ORDER.includes(id) && !order.includes(id)) order.push(id);
  for (const id of DASHBOARD_DEFAULT_ORDER) if (!order.includes(id)) order.push(id);
  const hidden = [];
  for (const id of Array.isArray(layout.hidden) ? layout.hidden : []) if (DASHBOARD_DEFAULT_ORDER.includes(id) && !hidden.includes(id)) hidden.push(id);
  if (sourceVersion < 3) for (const id of DASHBOARD_OPTIONAL_WIDGETS) if (!hidden.includes(id)) hidden.push(id);
  if (sourceVersion < 4 && !hidden.includes('recent-sessions')) hidden.push('recent-sessions');
  const rawSizes = layout.sizes && typeof layout.sizes === 'object' ? layout.sizes : {};
  const sizes = Object.fromEntries(DASHBOARD_DEFAULT_ORDER.map((id) => [id, dashboardSize(id, rawSizes[id])]));
  return { version: 4, order, hidden, sizes, updatedAt: layout.updatedAt || null };
}
function cloneDashboardLayout(layout) { return normalizeDashboardLayout(JSON.parse(JSON.stringify(layout || {}))); }
function activeDashboardLayout() { return state.dashboardEditing ? state.dashboardLayoutDraft : state.dashboardLayout; }
function dashboardWidget(id) { return document.querySelector(`[data-dashboard-widget="${CSS.escape(id)}"]`); }
function availableDashboardWidget(id) {
  const widget = dashboardWidget(id);
  return Boolean(widget && !widget.classList.contains('hidden'));
}
function dashboardViewportWidth() {
  const canvasWidth = $('dashboardCanvas')?.getBoundingClientRect().width || 0;
  return Math.max(320, canvasWidth || window.innerWidth || 320);
}
function dashboardEffectiveCols(id, savedCols) {
  const width = dashboardViewportWidth();
  const kind = DASHBOARD_WIDGET_KIND[id];
  if (width <= 520) return kind === 'stat' ? Math.max(6, savedCols) : 12;
  if (width <= 900) return kind === 'stat' ? Math.max(6, savedCols) : 12;
  if (width <= 1180) return kind === 'stat' ? Math.max(4, savedCols) : Math.max(6, savedCols);
  return savedCols;
}
function dashboardCanUseFixedHeight() {
  return dashboardViewportWidth() > 960;
}
function classifyDashboardWidget(widget) {
  if (!widget) return;
  const width = widget.getBoundingClientRect().width;
  widget.classList.toggle('dashboard-width-compact', width > 0 && width < 390);
  widget.classList.toggle('dashboard-width-medium', width >= 390 && width < 760);
  widget.classList.toggle('dashboard-width-wide', width >= 760);
}
function updateDashboardMasonry() {
  state.dashboardMasonryFrame = null;
  const canvas = $('dashboardCanvas');
  if (!canvas) return;
  const style = getComputedStyle(canvas);
  const rowHeight = Math.max(1, safeNumber(parseFloat(style.gridAutoRows), 8));
  const rowGap = Math.max(0, safeNumber(parseFloat(style.rowGap), 12));
  canvas.querySelectorAll('[data-dashboard-widget]').forEach((widget) => {
    classifyDashboardWidget(widget);
    if (widget.classList.contains('dashboard-user-hidden') || widget.classList.contains('hidden')) {
      widget.style.removeProperty('grid-row-end');
      return;
    }
    const height = Math.max(1, widget.getBoundingClientRect().height);
    const rows = Math.max(1, Math.ceil((height + rowGap) / (rowHeight + rowGap)));
    if (widget.dataset.dashboardRows !== String(rows)) {
      widget.dataset.dashboardRows = String(rows);
      widget.style.gridRowEnd = `span ${rows}`;
    }
  });
}
function scheduleDashboardMasonry() {
  if (state.dashboardMasonryFrame) cancelAnimationFrame(state.dashboardMasonryFrame);
  state.dashboardMasonryFrame = requestAnimationFrame(updateDashboardMasonry);
}
function prepareDashboardMasonry() {
  if (state.dashboardMasonryObserver || !window.ResizeObserver) {
    scheduleDashboardMasonry();
    return;
  }
  state.dashboardMasonryObserver = new ResizeObserver(() => scheduleDashboardMasonry());
  document.querySelectorAll('[data-dashboard-widget]').forEach((widget) => state.dashboardMasonryObserver.observe(widget));
  const canvas = $('dashboardCanvas');
  if (canvas) state.dashboardMasonryObserver.observe(canvas);
  scheduleDashboardMasonry();
}
function dashboardVisualWidgets(excludeId = '') {
  return [...document.querySelectorAll('[data-dashboard-widget]')]
    .filter((widget) => widget.dataset.dashboardWidget !== excludeId && !widget.classList.contains('dashboard-user-hidden') && !widget.classList.contains('hidden'))
    .sort((a, b) => {
      const ar = a.getBoundingClientRect(); const br = b.getBoundingClientRect();
      const rowTolerance = Math.min(36, Math.max(12, Math.min(ar.height, br.height) * .12));
      if (Math.abs(ar.top - br.top) > rowTolerance) return ar.top - br.top;
      return ar.left - br.left;
    });
}
function dashboardDropTargetAt(clientX, clientY) {
  const widgets = dashboardVisualWidgets(state.dashboardDraggedWidget);
  if (!widgets.length) return null;
  let nearest = null; let nearestDistance = Number.POSITIVE_INFINITY;
  for (const widget of widgets) {
    const rect = widget.getBoundingClientRect();
    const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
    const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    const distance = Math.hypot(dx, dy);
    if (distance < nearestDistance) { nearest = widget; nearestDistance = distance; }
  }
  if (!nearest) return null;
  const rect = nearest.getBoundingClientRect();
  const edgeBand = Math.min(72, Math.max(28, rect.height * .22));
  let after;
  if (clientY <= rect.top + edgeBand) after = false;
  else if (clientY >= rect.bottom - edgeBand) after = true;
  else after = clientX >= rect.left + rect.width / 2;
  return { targetId: nearest.dataset.dashboardWidget, after };
}
function closeDashboardSizeMenus(except = null) {
  document.querySelectorAll('.dashboard-size-menu.is-open').forEach((menu) => {
    if (menu !== except) menu.classList.remove('is-open');
  });
}
function dashboardSizeLabel(id, layout = activeDashboardLayout()) {
  const size = dashboardSize(id, layout?.sizes?.[id]);
  return `${size.cols}/12 · ${size.height ? `${size.height}px` : 'automatic height'}`;
}
function updateDashboardSizeMenu(id, widget, layout = activeDashboardLayout()) {
  const label = widget?.querySelector('.dashboard-size-current');
  if (label) label.textContent = dashboardSizeLabel(id, layout);
}
function applyDashboardWidgetSize(widget, id, layout = activeDashboardLayout()) {
  if (!widget) return;
  const size = dashboardSize(id, layout?.sizes?.[id]);
  widget.style.setProperty('--dashboard-cols', String(dashboardEffectiveCols(id, size.cols)));
  widget.dataset.dashboardSavedCols = String(size.cols);
  widget.dataset.dashboardSavedHeight = String(size.height);
  const useFixedHeight = size.height > 0 && dashboardCanUseFixedHeight();
  widget.classList.toggle('dashboard-responsive-auto-height', size.height > 0 && !useFixedHeight);
  if (useFixedHeight) {
    widget.style.height = `${size.height}px`;
    widget.classList.add('dashboard-fixed-height');
  } else {
    widget.style.removeProperty('height');
    widget.classList.remove('dashboard-fixed-height');
  }
  updateDashboardSizeMenu(id, widget, layout);
  scheduleDashboardMasonry();
}
function renderDashboardHiddenWidgets() {
  const container = $('dashboardHiddenWidgets');
  if (!container) return;
  container.textContent = '';
  const layout = activeDashboardLayout() || normalizeDashboardLayout();
  const hidden = layout.hidden.filter((id) => availableDashboardWidget(id));
  show($('dashboardHiddenPanel'), state.dashboardEditing);
  if (!hidden.length) {
    const empty = document.createElement('span'); empty.className = 'dashboard-hidden-empty'; empty.textContent = 'No hidden cards.'; container.append(empty); return;
  }
  for (const id of hidden) {
    const widget = dashboardWidget(id);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'dashboard-restore-widget';
    button.textContent = `+ ${widget?.dataset.dashboardTitle || id}`;
    button.addEventListener('click', () => restoreDashboardWidget(id));
    container.append(button);
  }
}
function clearDashboardDropTarget() {
  state.dashboardDropTarget = null;
  document.querySelectorAll('.dashboard-drop-before, .dashboard-drop-after').forEach((item) => item.classList.remove('dashboard-drop-before', 'dashboard-drop-after'));
}
function setDashboardDropTarget(targetId, after) {
  clearDashboardDropTarget();
  const target = dashboardWidget(targetId);
  if (!target) return;
  state.dashboardDropTarget = { targetId, after: Boolean(after) };
  target.classList.add(after ? 'dashboard-drop-after' : 'dashboard-drop-before');
}
function applyDashboardLayout(layout = activeDashboardLayout()) {
  const canvas = $('dashboardCanvas');
  if (!canvas) return;
  const normalized = normalizeDashboardLayout(layout || {});
  for (const id of normalized.order) {
    const widget = dashboardWidget(id);
    if (widget) canvas.append(widget);
  }
  document.querySelectorAll('[data-dashboard-widget]').forEach((widget) => {
    const id = widget.dataset.dashboardWidget;
    widget.classList.toggle('dashboard-user-hidden', normalized.hidden.includes(id));
    widget.draggable = state.dashboardEditing && !normalized.hidden.includes(id) && !state.dashboardResizeActive;
    widget.setAttribute('aria-grabbed', state.dashboardDraggedWidget === id ? 'true' : 'false');
    applyDashboardWidgetSize(widget, id, normalized);
  });
  $('dashboardView')?.classList.toggle('dashboard-edit-mode', state.dashboardEditing);
  if ($('dashboardLayoutHint')) $('dashboardLayoutHint').textContent = state.dashboardEditing ? 'Drag on desktop or use the arrows and size button.' : 'Organize the information that matters most to you.';
  show($('editDashboardBtn'), !state.dashboardEditing);
  show($('dashboardEditControls'), state.dashboardEditing);
  renderDashboardHiddenWidgets();
  scheduleDashboardMasonry();
}
function updateDashboardSize(id, patch) {
  if (!state.dashboardEditing) return;
  const layout = cloneDashboardLayout(state.dashboardLayoutDraft);
  const current = dashboardSize(id, layout.sizes[id]);
  layout.sizes[id] = dashboardSize(id, { ...current, ...patch });
  state.dashboardLayoutDraft = layout;
  applyDashboardWidgetSize(dashboardWidget(id), id, layout);
}
function stepDashboardWidth(id, direction) {
  const layout = cloneDashboardLayout(state.dashboardLayoutDraft);
  const current = dashboardSize(id, layout.sizes[id]);
  const allowed = DASHBOARD_WIDTH_STEPS.filter((value) => value >= dashboardMinCols(id));
  let index = allowed.findIndex((value) => value >= current.cols);
  if (index < 0) index = allowed.length - 1;
  if (direction < 0 && allowed[index] >= current.cols) index -= 1;
  if (direction > 0 && allowed[index] <= current.cols) index += 1;
  index = Math.max(0, Math.min(allowed.length - 1, index));
  updateDashboardSize(id, { cols: allowed[index] });
}
function stepDashboardHeight(id, direction) {
  const layout = cloneDashboardLayout(state.dashboardLayoutDraft);
  const current = dashboardSize(id, layout.sizes[id]);
  const base = current.height || Math.max(dashboardMinHeight(id), Math.round(dashboardWidget(id)?.getBoundingClientRect().height || dashboardMinHeight(id)));
  updateDashboardSize(id, { height: Math.max(dashboardMinHeight(id), Math.min(900, base + direction * 80)) });
}
function resetDashboardWidgetSize(id) {
  if (!state.dashboardEditing) return;
  const layout = cloneDashboardLayout(state.dashboardLayoutDraft);
  layout.sizes[id] = { ...DASHBOARD_DEFAULT_SIZES[id] };
  state.dashboardLayoutDraft = layout;
  applyDashboardWidgetSize(dashboardWidget(id), id, layout);
}
function prepareDashboardResizeHandle(widget, id) {
  const resizeHandle = document.createElement('button');
  resizeHandle.type = 'button'; resizeHandle.className = 'dashboard-resize-handle'; resizeHandle.title = 'Drag to resize'; resizeHandle.setAttribute('aria-label', 'Resize card'); resizeHandle.textContent = '◢';
  resizeHandle.addEventListener('pointerdown', (event) => {
    if (!state.dashboardEditing || event.button > 0) return;
    event.preventDefault(); event.stopPropagation(); closeDashboardSizeMenus();
    state.dashboardResizeActive = true; widget.draggable = false;
    const canvas = $('dashboardCanvas');
    const canvasStyle = getComputedStyle(canvas); const gap = safeNumber(parseFloat(canvasStyle.columnGap), 12);
    const canvasRect = canvas.getBoundingClientRect(); const colWidth = Math.max(1, (canvasRect.width - gap * 11) / 12);
    const startRect = widget.getBoundingClientRect(); const startX = event.clientX; const startY = event.clientY;
    const current = dashboardSize(id, state.dashboardLayoutDraft?.sizes?.[id]);
    const pointerId = event.pointerId;
    resizeHandle.setPointerCapture?.(pointerId);
    const move = (moveEvent) => {
      const desiredWidth = Math.max(colWidth * dashboardMinCols(id), startRect.width + moveEvent.clientX - startX);
      const cols = Math.max(dashboardMinCols(id), Math.min(12, Math.round((desiredWidth + gap) / (colWidth + gap))));
      const desiredHeight = startRect.height + moveEvent.clientY - startY;
      const height = Math.max(dashboardMinHeight(id), Math.min(900, Math.round(desiredHeight)));
      const layout = cloneDashboardLayout(state.dashboardLayoutDraft);
      layout.sizes[id] = dashboardSize(id, { cols, height: Math.abs(moveEvent.clientY - startY) < 8 ? current.height : height });
      state.dashboardLayoutDraft = layout; applyDashboardWidgetSize(widget, id, layout);
    };
    const end = () => {
      state.dashboardResizeActive = false;
      resizeHandle.releasePointerCapture?.(pointerId);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
      applyDashboardLayout();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
  });
  widget.append(resizeHandle);
}
function prepareDashboardWidgets() {
  document.querySelectorAll('[data-dashboard-widget]').forEach((widget) => {
    if (widget.querySelector(':scope > .dashboard-widget-tools')) return;
    const id = widget.dataset.dashboardWidget;
    const tools = document.createElement('div'); tools.className = 'dashboard-widget-tools';
    const handle = document.createElement('button'); handle.type = 'button'; handle.className = 'dashboard-drag-handle'; handle.title = 'Drag card'; handle.setAttribute('aria-label', 'Drag card'); handle.textContent = '⠿';
    handle.addEventListener('pointerdown', () => { state.dashboardDragArmed = id; });
    const up = document.createElement('button'); up.type = 'button'; up.title = 'Move earlier'; up.setAttribute('aria-label', 'Move card earlier'); up.textContent = '↑'; up.addEventListener('click', () => moveDashboardWidget(id, -1));
    const down = document.createElement('button'); down.type = 'button'; down.title = 'Move later'; down.setAttribute('aria-label', 'Move card later'); down.textContent = '↓'; down.addEventListener('click', () => moveDashboardWidget(id, 1));
    const sizeButton = document.createElement('button'); sizeButton.type = 'button'; sizeButton.className = 'dashboard-size-toggle'; sizeButton.title = 'Change size'; sizeButton.setAttribute('aria-label', 'Change card size'); sizeButton.textContent = '⤢';
    const hideButton = document.createElement('button'); hideButton.type = 'button'; hideButton.className = 'dashboard-hide-widget'; hideButton.title = 'Ocultar tarjeta'; hideButton.setAttribute('aria-label', 'Ocultar tarjeta'); hideButton.textContent = '⊘'; hideButton.addEventListener('click', () => hideDashboardWidget(id));
    tools.append(handle, up, down, sizeButton, hideButton); widget.append(tools);

    const sizeMenu = document.createElement('div'); sizeMenu.className = 'dashboard-size-menu';
    const current = document.createElement('strong'); current.className = 'dashboard-size-current';
    const widthRow = document.createElement('div'); widthRow.className = 'dashboard-size-row';
    const widthLabel = document.createElement('span'); widthLabel.textContent = 'Ancho';
    const widthDown = document.createElement('button'); widthDown.type = 'button'; widthDown.textContent = '−'; widthDown.title = 'Reducir ancho'; widthDown.addEventListener('click', () => stepDashboardWidth(id, -1));
    const widthFull = document.createElement('button'); widthFull.type = 'button'; widthFull.textContent = 'Full width'; widthFull.title = 'Use full width'; widthFull.addEventListener('click', () => updateDashboardSize(id, { cols: 12 }));
    const widthUp = document.createElement('button'); widthUp.type = 'button'; widthUp.textContent = '+'; widthUp.title = 'Aumentar ancho'; widthUp.addEventListener('click', () => stepDashboardWidth(id, 1));
    widthRow.append(widthLabel, widthDown, widthFull, widthUp);
    const heightRow = document.createElement('div'); heightRow.className = 'dashboard-size-row';
    const heightLabel = document.createElement('span'); heightLabel.textContent = 'Alto';
    const heightDown = document.createElement('button'); heightDown.type = 'button'; heightDown.textContent = '−'; heightDown.title = 'Reducir alto'; heightDown.addEventListener('click', () => stepDashboardHeight(id, -1));
    const heightAuto = document.createElement('button'); heightAuto.type = 'button'; heightAuto.textContent = 'Auto'; heightAuto.title = 'Automatic height'; heightAuto.addEventListener('click', () => updateDashboardSize(id, { height: 0 }));
    const heightUp = document.createElement('button'); heightUp.type = 'button'; heightUp.textContent = '+'; heightUp.title = 'Aumentar alto'; heightUp.addEventListener('click', () => stepDashboardHeight(id, 1));
    heightRow.append(heightLabel, heightDown, heightAuto, heightUp);
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'dashboard-size-reset'; reset.textContent = 'Original size'; reset.addEventListener('click', () => resetDashboardWidgetSize(id));
    sizeMenu.append(current, widthRow, heightRow, reset); widget.append(sizeMenu);
    sizeButton.addEventListener('click', (event) => { event.stopPropagation(); const opening = !sizeMenu.classList.contains('is-open'); closeDashboardSizeMenus(sizeMenu); sizeMenu.classList.toggle('is-open', opening); updateDashboardSizeMenu(id, widget); });
    sizeMenu.addEventListener('click', (event) => event.stopPropagation());
    prepareDashboardResizeHandle(widget, id);

    widget.addEventListener('dragstart', (event) => {
      if (!state.dashboardEditing || state.dashboardResizeActive || state.dashboardDragArmed !== id) { event.preventDefault(); return; }
      state.dashboardDraggedWidget = id; closeDashboardSizeMenus();
      widget.classList.add('dashboard-dragging');
      event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id);
      window.setTimeout(() => applyDashboardLayout(), 0);
    });
    widget.addEventListener('dragend', () => {
      state.dashboardDraggedWidget = null; state.dashboardDragArmed = null;
      widget.classList.remove('dashboard-dragging'); clearDashboardDropTarget(); applyDashboardLayout();
    });
    widget.addEventListener('dragover', (event) => {
      if (!state.dashboardEditing || !state.dashboardDraggedWidget || state.dashboardDraggedWidget === id) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
      const target = dashboardDropTargetAt(event.clientX, event.clientY);
      if (target) setDashboardDropTarget(target.targetId, target.after);
    });
    widget.addEventListener('drop', (event) => {
      if (!state.dashboardEditing) return;
      event.preventDefault(); event.stopPropagation();
      const sourceId = event.dataTransfer.getData('text/plain') || state.dashboardDraggedWidget;
      const target = state.dashboardDropTarget || { targetId: id, after: false };
      clearDashboardDropTarget();
      if (!sourceId || sourceId === target.targetId) return;
      reorderDashboardWidget(sourceId, target.targetId, target.after);
    });
  });
  $('dashboardCanvas')?.addEventListener('dragover', (event) => {
    if (!state.dashboardEditing || !state.dashboardDraggedWidget) return;
    event.preventDefault();
    const target = dashboardDropTargetAt(event.clientX, event.clientY);
    if (target) setDashboardDropTarget(target.targetId, target.after);
  });
  $('dashboardCanvas')?.addEventListener('drop', (event) => {
    if (!state.dashboardEditing) return;
    event.preventDefault();
    const sourceId = event.dataTransfer.getData('text/plain') || state.dashboardDraggedWidget;
    const target = state.dashboardDropTarget;
    clearDashboardDropTarget();
    if (sourceId && target && sourceId !== target.targetId) reorderDashboardWidget(sourceId, target.targetId, target.after);
  });
  document.addEventListener('click', () => closeDashboardSizeMenus());
  window.addEventListener('pointerup', () => { state.dashboardDragArmed = null; });
  let resizeFrame = null;
  const refreshDashboardViewport = () => {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      applyDashboardLayout();
      scheduleDashboardMasonry();
    });
  };
  window.addEventListener('resize', refreshDashboardViewport, { passive: true });
  window.visualViewport?.addEventListener('resize', refreshDashboardViewport, { passive: true });
  prepareDashboardMasonry();
}
function reorderDashboardWidget(sourceId, targetId, after = false) {
  const layout = cloneDashboardLayout(state.dashboardLayoutDraft);
  layout.order = layout.order.filter((id) => id !== sourceId);
  const targetIndex = layout.order.indexOf(targetId);
  layout.order.splice(Math.max(0, targetIndex + (after ? 1 : 0)), 0, sourceId);
  state.dashboardLayoutDraft = layout; applyDashboardLayout();
  dashboardWidget(sourceId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function moveDashboardWidget(id, direction) {
  if (!state.dashboardEditing) return;
  const layout = cloneDashboardLayout(state.dashboardLayoutDraft);
  const visual = dashboardVisualWidgets().map((widget) => widget.dataset.dashboardWidget);
  const current = visual.indexOf(id); const target = current + direction;
  if (current < 0 || target < 0 || target >= visual.length) return;
  const targetId = visual[target];
  layout.order = layout.order.filter((item) => item !== id);
  const targetIndex = layout.order.indexOf(targetId);
  layout.order.splice(Math.max(0, targetIndex + (direction > 0 ? 1 : 0)), 0, id);
  state.dashboardLayoutDraft = layout; applyDashboardLayout();
  dashboardWidget(id)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function hideDashboardWidget(id) {
  if (!state.dashboardEditing) return;
  const layout = cloneDashboardLayout(state.dashboardLayoutDraft);
  if (!layout.hidden.includes(id)) layout.hidden.push(id);
  state.dashboardLayoutDraft = layout; closeDashboardSizeMenus(); applyDashboardLayout();
}
function restoreDashboardWidget(id) {
  if (!state.dashboardEditing) return;
  const layout = cloneDashboardLayout(state.dashboardLayoutDraft);
  layout.hidden = layout.hidden.filter((item) => item !== id);
  state.dashboardLayoutDraft = layout; applyDashboardLayout();
  dashboardWidget(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function startDashboardEdit() {
  state.dashboardLayoutDraft = cloneDashboardLayout(state.dashboardLayout || {});
  state.dashboardEditing = true; applyDashboardLayout();
}
function cancelDashboardEdit() {
  state.dashboardEditing = false; state.dashboardLayoutDraft = null; state.dashboardDraggedWidget = null; state.dashboardDragArmed = null; clearDashboardDropTarget(); closeDashboardSizeMenus(); applyDashboardLayout(state.dashboardLayout);
}
function resetDashboardEdit() {
  if (!state.dashboardEditing) return;
  state.dashboardLayoutDraft = normalizeDashboardLayout({ version: 3, order: DASHBOARD_DEFAULT_ORDER, hidden: DASHBOARD_DEFAULT_HIDDEN, sizes: DASHBOARD_DEFAULT_SIZES }); applyDashboardLayout();
}
async function saveDashboardEdit() {
  if (!state.dashboardEditing) return;
  try {
    const data = await request('/api/local/account/dashboard-layout', { method: 'POST', body: JSON.stringify(state.dashboardLayoutDraft || {}) });
    state.dashboardLayout = normalizeDashboardLayout(data.layout || state.dashboardLayoutDraft);
    state.dashboardEditing = false; state.dashboardLayoutDraft = null; closeDashboardSizeMenus(); applyDashboardLayout(state.dashboardLayout); toast('Card layout saved');
  } catch (error) { toast(error.message, true); }
}
async function loadDashboardLayout() {
  try {
    const data = await request('/api/local/account/dashboard-layout');
    state.dashboardLayout = normalizeDashboardLayout(data.layout || {});
  } catch (_) { state.dashboardLayout = normalizeDashboardLayout({}); }
  prepareDashboardWidgets(); applyDashboardLayout(state.dashboardLayout);
}

const VALID_VIEWS = new Set(['dashboard', 'server', 'players', 'places', 'bluemap', 'history', 'servers', 'crafty-connections', 'system', 'users']);
function requestedView() {
  const requested = new URLSearchParams(window.location.search).get('view') || 'dashboard';
  if (requested === 'metrics') return 'server';
  return VALID_VIEWS.has(requested) ? requested : 'dashboard';
}
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIosDevice() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
function updatePwaInstallUi() {
  const installed = isStandalone();
  const canPrompt = Boolean(state.installPrompt);
  const status = $('pwaInstallStatus');
  if (status) status.textContent = installed ? 'Player Panel is installed as an app.' : canPrompt ? 'Ready to install on this device.' : isIosDevice() ? 'In Safari, use Share → Add to Home Screen.' : 'Installation will appear when the browser allows it.';
  show($('installAppBtn'), !installed && (canPrompt || isIosDevice()));
  if ($('installFromAccountBtn')) {
    $('installFromAccountBtn').disabled = installed;
    $('installFromAccountBtn').textContent = installed ? 'App installed' : 'Install Player Panel';
  }
  document.body.classList.toggle('pwa-standalone', installed);
}
async function installPwa() {
  if (isStandalone()) return toast('Player Panel is already installed');
  if (state.installPrompt) {
    const prompt = state.installPrompt;
    state.installPrompt = null;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    toast(choice.outcome === 'accepted' ? 'Installation started' : 'Installation cancelled', choice.outcome !== 'accepted');
    updatePwaInstallUi();
    return;
  }
  if (isIosDevice()) return toast('In Safari: Share → Add to Home Screen');
  toast('The browser does not offer installation yet. Open the menu and look for “Install app”.', true);
}
function updateConnectivity() {
  const online = navigator.onLine;
  show($('offlineBanner'), !online);
  document.body.classList.toggle('network-offline', !online);
  if (online && !loginView.classList.contains('hidden')) return;
  if (online && state.user) refreshAll();
}
function showUpdateAvailable(registration) {
  state.swRegistration = registration || state.swRegistration;
  show($('updateBanner'), true);
}
async function registerPwa() {
  updatePwaInstallUi();
  updateConnectivity();
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
    state.swRegistration = registration;
    if (registration.waiting && navigator.serviceWorker.controller) showUpdateAvailable(registration);
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateAvailable(registration);
      });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (state.reloadingForUpdate) return;
      state.reloadingForUpdate = true;
      window.location.reload();
    });
    window.setInterval(() => registration.update().catch(() => {}), 60 * 60 * 1000);
  } catch (error) {
    console.warn('Could not register the PWA:', error);
  }
}
function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}
function pushSubscriptionKeyMatches(subscription, publicKey) {
  const currentKey = subscription?.options?.applicationServerKey;
  if (!currentKey || !publicKey) return null;
  try {
    const current = new Uint8Array(currentKey);
    const expected = urlBase64ToUint8Array(publicKey);
    if (current.length !== expected.length) return false;
    return current.every((value, index) => value === expected[index]);
  } catch (_) {
    return null;
  }
}
function pushNeedsRepair(subscription, record, publicKey) {
  if (!subscription || !record) return false;
  if (record.repairRequired || /BadJwtToken/i.test(String(record.last_error || ''))) return true;
  const keyMatches = pushSubscriptionKeyMatches(subscription, publicKey);
  return keyMatches === false;
}
function pushDeviceName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  if (isIosDevice()) return /ipad/i.test(navigator.userAgent) ? 'iPad' : 'iPhone';
  if (/android/i.test(navigator.userAgent)) return 'Android';
  if (/windows/i.test(platform) || /windows/i.test(navigator.userAgent)) return 'Windows';
  if (/mac/i.test(platform)) return 'Mac';
  return platform || 'Navegador';
}
function selectedPushEvents() {
  return [...document.querySelectorAll('#pushPreferences input[type="checkbox"]:checked')].map((input) => input.value);
}
function renderPushDevices() {
  const container = $('pushDevices');
  if (!container) return;
  container.textContent = '';
  const subscriptions = state.pushConfig?.subscriptions || [];
  for (const subscription of subscriptions) {
    const row = document.createElement('div'); row.className = 'push-device-row';
    const info = document.createElement('div');
    const strong = document.createElement('strong'); strong.textContent = subscription.device_name || subscription.deviceName || 'Device';
    const small = document.createElement('small');
    const isCurrent = state.pushSubscription?.endpoint === subscription.endpoint;
    const needsRepair = isCurrent && pushNeedsRepair(state.pushSubscription, subscription, state.pushConfig?.publicKey);
    const status = needsRepair
      ? 'Push authentication must be renewed.'
      : subscription.last_error
        ? `Error: ${subscription.last_error}`
        : subscription.last_success
          ? `Last delivery: ${formatDate(subscription.last_success)}`
          : 'Registered, no deliveries yet';
    small.textContent = status;
    info.append(strong, small);
    const actions = document.createElement('div'); actions.className = 'push-device-actions';
    if (needsRepair) {
      const repair = document.createElement('button'); repair.type = 'button'; repair.className = 'secondary small-btn'; repair.textContent = 'Repair';
      repair.addEventListener('click', repairPush);
      actions.append(repair);
    }
    const button = document.createElement('button'); button.type = 'button'; button.className = 'ghost small-btn'; button.textContent = 'Quitar';
    button.addEventListener('click', async () => {
      if (!confirm(`Remove notifications for ${strong.textContent}?`)) return;
      try {
        if (isCurrent) await state.pushSubscription.unsubscribe();
        await request('/api/local/push/unsubscribe', { method: 'POST', body: JSON.stringify({ id: subscription.id }) });
        await loadPushSettings(); toast('Device removed');
      } catch (error) { toast(error.message, true); }
    });
    actions.append(button);
    row.append(info, actions); container.append(row);
  }
}
function renderPushSettings() {
  const status = $('pushStatus');
  const supported = pushSupported();
  const configured = Boolean(state.pushConfig?.configured && state.pushConfig?.publicKey);
  const current = state.pushSubscription;
  const currentRecord = (state.pushConfig?.subscriptions || []).find((item) => item.endpoint === current?.endpoint);
  const needsRepair = pushNeedsRepair(current, currentRecord, state.pushConfig?.publicKey);
  if (!supported) status.textContent = 'This browser does not support Web Push.';
  else if (isIosDevice() && !isStandalone()) status.textContent = 'On iPhone/iPad, first install the app from Safari → Share → Add to Home Screen.';
  else if (!configured) status.textContent = 'Web Push is not configured on the server yet.';
  else if (Notification.permission === 'denied') status.textContent = 'Notifications are blocked in the device settings.';
  else if (needsRepair) status.textContent = 'The subscription uses old authentication. Select Repair to renew it.';
  else if (current && currentRecord) status.textContent = 'Background notifications are active on this device.';
  else status.textContent = 'You can receive alerts while the app is closed or the phone is locked.';
  show($('enablePushBtn'), supported && configured && !(current && currentRecord));
  show($('repairPushBtn'), Boolean(needsRepair));
  show($('disablePushBtn'), Boolean(current && currentRecord));
  show($('testPushBtn'), Boolean(current && currentRecord && !needsRepair));
  show($('pushPreferences'), Boolean(current && currentRecord));
  const events = new Set(currentRecord?.eventTypes || state.pushConfig?.defaultEvents || []);
  if (!scopeIsDirty('push-preferences')) document.querySelectorAll('#pushPreferences input[type="checkbox"]').forEach((input) => { input.checked = events.has(input.value); });
  renderPushDevices();
}
async function loadPushSettings() {
  if (!state.user) return;
  try {
    const registration = state.swRegistration || await navigator.serviceWorker?.ready;
    state.pushConfig = await request('/api/local/push');
    state.pushSubscription = registration ? await registration.pushManager.getSubscription() : null;
    const record = (state.pushConfig?.subscriptions || []).find((item) => item.endpoint === state.pushSubscription?.endpoint);
    if (record && pushSubscriptionKeyMatches(state.pushSubscription, state.pushConfig?.publicKey) === false) record.repairRequired = true;
    renderPushSettings();
  } catch (error) {
    if ($('pushStatus')) $('pushStatus').textContent = error.message;
  }
}
async function enablePush() {
  if (!pushSupported()) return toast('Este navegador no soporta Web Push', true);
  if (isIosDevice() && !isStandalone()) return toast('Install the app from Safari and open it from the Home Screen', true);
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return toast('Notification permission was not granted', true);
    const registration = state.swRegistration || await navigator.serviceWorker.ready;
    const config = state.pushConfig || await request('/api/local/push');
    if (!config.publicKey) throw new Error('The server does not have a Web Push key');
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && pushSubscriptionKeyMatches(subscription, config.publicKey) === false) {
      await subscription.unsubscribe();
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.publicKey) });
    }
    const defaults = config.defaultEvents || [];
    await request('/api/local/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON(), deviceName: pushDeviceName(), eventTypes: defaults }) });
    state.pushSubscription = subscription;
    await loadPushSettings();
    toast('Background notifications enabled');
  } catch (error) { toast(error.message, true); }
}
async function repairPush() {
  if (!pushSupported()) return toast('Este navegador no soporta Web Push', true);
  if (isIosDevice() && !isStandalone()) return toast('Open the installed app from the Home Screen', true);
  try {
    if (Notification.permission !== 'granted') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return toast('Notification permission was not granted', true);
    }
    const registration = state.swRegistration || await navigator.serviceWorker.ready;
    const config = state.pushConfig || await request('/api/local/push');
    if (!config.publicKey) throw new Error('The server does not have a Web Push key');
    const current = await registration.pushManager.getSubscription();
    const currentRecord = (config.subscriptions || []).find((item) => item.endpoint === current?.endpoint);
    const events = currentRecord?.eventTypes || config.defaultEvents || [];
    if (current) {
      try {
        await request('/api/local/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: current.endpoint }) });
      } catch (_) {}
      await current.unsubscribe();
    }
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey),
    });
    await request('/api/local/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription: subscription.toJSON(), deviceName: pushDeviceName(), eventTypes: events }),
    });
    state.pushSubscription = subscription;
    await loadPushSettings();
    toast('Notifications repaired. Run a test in 10 seconds.');
  } catch (error) {
    toast(`Could not repair notifications: ${error.message}`, true);
  }
}

async function disablePush() {
  try {
    const subscription = state.pushSubscription || await (state.swRegistration || await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (subscription) {
      await request('/api/local/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) });
      await subscription.unsubscribe();
    }
    state.pushSubscription = null;
    await loadPushSettings();
    toast('Notifications disabled on this device');
  } catch (error) { toast(error.message, true); }
}
async function savePushPreferences() {
  const current = state.pushSubscription;
  const record = (state.pushConfig?.subscriptions || []).find((item) => item.endpoint === current?.endpoint);
  if (!record) return toast('This device is not registered', true);
  try {
    await request('/api/local/push/settings', { method: 'POST', body: JSON.stringify({ id: record.id, enabled: true, eventTypes: selectedPushEvents() }) });
    clearScopeDirty('push-preferences'); await loadPushSettings(); toast('Preferencias guardadas');
  } catch (error) { toast(error.message, true); }
}
async function testPush() {
  try {
    const result = await request('/api/local/push/test', { method: 'POST', body: JSON.stringify({ delaySeconds: 10 }) });
    toast(result.message || 'Test scheduled. Close the app and lock the iPhone.');
  } catch (error) { toast(error.message, true); }
}

window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); state.installPrompt = event; updatePwaInstallUi(); });
window.addEventListener('appinstalled', () => { state.installPrompt = null; updatePwaInstallUi(); toast('Player Panel was installed'); });
window.addEventListener('online', updateConnectivity);
window.addEventListener('offline', updateConnectivity);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    state.alertsPausedAt = Date.now();
    return;
  }
  const hiddenFor = state.alertsPausedAt ? Date.now() - state.alertsPausedAt : 0;
  state.alertsPausedAt = 0;
  if (hiddenFor >= ALERT_BACKGROUND_RESYNC_MS) {
    // Do not replay alerts accumulated while iOS/another browser suspended the page.
    state.suppressAlertNotificationsUntil = Date.now() + 3000;
    syncAlertCursor();
  } else if (state.user) {
    loadAlerts();
  }
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted && state.user) {
    state.suppressAlertNotificationsUntil = Date.now() + 3000;
    syncAlertCursor();
  }
});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'PUSH_ALERT') {
      // The service worker already displayed the system notification. Advance the
      // local cursor so the same alert is not emitted again by browser polling.
      state.suppressAlertNotificationsUntil = Date.now() + 3000;
      const pushedId = Number(event.data.payload?.alertId || 0);
      if (pushedId > 0) {
        state.lastAlertId = Math.max(state.lastAlertId, pushedId);
        state.alertsInitialized = true;
      } else {
        syncAlertCursor();
      }
      if (state.view === 'dashboard') loadDashboard();
      if (event.data.payload?.title) toast(`${event.data.payload.title}: ${event.data.payload.body || ''}`);
    }
  });
}

async function request(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.currentServerId) headers['X-Player-Panel-Server'] = String(state.currentServerId);
  if ((options.method || 'GET') !== 'GET') { headers['X-Requested-With'] = 'PlayerPanel'; headers['X-CSRF-Token'] = state.csrf; }
  const response = await fetch(path, { credentials: 'include', ...options, headers });
  let data = {}; try { data = await response.json(); } catch (_) { data = {}; }
  if (response.status === 401 && path !== '/api/session' && data.error === 'LOGIN_REQUIRED') { stopRealtime(); showLogin(); const error = new Error('The session ended'); error.code = data.error; throw error; }
  if (!response.ok) { const error = new Error(data.message || data.error || `Error HTTP ${response.status}`); error.code = data.error; error.status = response.status; throw error; }
  return data;
}

function hasPermission(name) { const perms = state.user?.permissions || []; return perms.includes('*') || perms.includes(name); }
function updateConnectionNavigation(connections = state.connections) {
  if (connections) state.connections = connections;
  const configured = Boolean(state.connections?.crafty?.configured);
  document.querySelectorAll('[data-crafty-nav]').forEach((el) => show(el, configured && hasPermission('crafty.view')));
  const blueMapConfigured = Boolean(state.connections?.blueMap?.configured);
  const squareMapConfigured = Boolean(state.connections?.squareMap?.configured);
  const anyMapConfigured = blueMapConfigured || squareMapConfigured;
  document.querySelectorAll('[data-bluemap-nav]').forEach((el) => show(el, blueMapConfigured));
  if ($('placeFromMapBtn')) {
    $('placeFromMapBtn').disabled = !anyMapConfigured;
    $('placeFromMapBtn').textContent = squareMapConfigured && isMobileMapPicker() ? 'Choose on 2D map' : 'Choose on map';
    $('placeFromMapBtn').title = anyMapConfigured ? 'Select coordinates from the map' : 'Configure squaremap or BlueMap under System → System Settings';
  }
  if (!anyMapConfigured && state.placeMapPickerActive) stopPlaceMapPicker({ silent: true });
}


function showLogin() { show(loginView, true); show(appView, false); $('password').value = ''; $('otp').value = ''; show($('otpWrap'), false); }
function showApp() { show(loginView, false); show(appView, true); }
function applyPermissions() {
  const user = state.user || {};
  $('currentUserName').textContent = user.displayName || user.username || 'User';
  $('currentUserRole').textContent = user.roleLabel || user.role || '';
  const canManageUsers = hasPermission('users.manage');
  show($('accountAdminTab'), canManageUsers);
  $('accountSelfTab')?.closest('.accounts-tabs')?.classList.toggle('single-tab', !canManageUsers);
  show($('userAdminListPanel'), canManageUsers);
  show($('userAdminFormPanel'), canManageUsers);
  if (!canManageUsers && state.accountTab === 'admin') state.accountTab = 'self';
  renderAccountIdentity();
  setAccountsTab(state.accountTab || 'self');
  show($('bulkActionsBtn'), hasPermission('bulk.manage'));
  show($('placeEditorPanel'), hasPermission('places.manage'));
  show($('markAlertsReadBtn'), hasPermission('alerts.manage'));
  show($('serverMetricsSection'), hasPermission('metrics.view'));
  document.querySelectorAll('.system-settings-nav').forEach((el) => show(el, hasPermission('system.view')));
  updateConnectionNavigation();
  show($('metricSettingsPanel'), hasPermission('metrics.manage'));
  show($('addWhitelistBtn'), hasPermission('players.whitelist'));
  show($('whitelistName')?.closest('.sidebar-form'), hasPermission('players.whitelist')); renderWhitelist();
  show(document.querySelector('.world-control-dock'), hasPermission('world.control'));
  const map = {
    serverStartBtn: 'server.control', serverStopBtn: 'server.control', serverRestartBtn: 'server.control', serverBackupBtn: 'server.backup',
    gamemodeBtn: 'players.gamemode', teleportBtn: 'players.teleport', whitelistBtn: 'players.whitelist', operatorBtn: 'players.operator', kickBtn: 'players.kick', banBtn: 'players.ban', unbanBtn: 'players.ban', clearBtn: 'players.clear_inventory',
    savePlaceBtn: 'places.manage', newPlaceBtn: 'places.manage', placeFromPlayerBtn: 'places.manage', placeFromMapBtn: 'places.manage', applyPlaceMapCoordinatesBtn: 'places.manage',
    createSystemBackupBtn: 'system.backup', saveSystemSettingsBtn: 'system.settings', runSystemMaintenanceBtn: 'system.maintain',
    savePluginConnectionBtn: 'system.settings', saveCraftyConnectionBtn: 'system.settings', saveBlueMapConnectionBtn: 'system.settings', saveSquareMapConnectionBtn: 'system.settings',
    saveServerProfileBtn: 'system.settings', createServerProfileBtn: 'system.settings', deleteServerProfileBtn: 'system.settings',
    openAddServerWizardBtn: 'system.settings', craftyAddServerShortcutBtn: 'system.settings'
  };
  Object.entries(map).forEach(([id, permission]) => show($(id), hasPermission(permission)));
  document.querySelectorAll('[data-action]').forEach((button) => show(button, hasPermission(`players.${button.dataset.action}`)));
}

const SERVER_STORAGE_KEY = 'player-panel-server';
function currentServerProfile() {
  return state.servers.find((server) => Number(server.id) === Number(state.currentServerId)) || state.servers[0] || null;
}
function profileConnections(profile = currentServerProfile()) {
  if (!profile) return state.connections || {};
  return { plugin: profile.plugin || {}, crafty: profile.crafty || {}, blueMap: profile.blueMap || {}, squareMap: profile.squareMap || {}, server: { id: profile.id, name: profile.name } };
}
function renderServerSelector() {
  const select = $('serverSelector');
  if (!select) return;
  select.textContent = '';
  if (!state.servers.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No servers · add the first one';
    select.append(option);
  } else {
    for (const server of state.servers) {
      const option = document.createElement('option');
      option.value = String(server.id);
      option.textContent = `${server.name}${server.isDefault ? ' · primary' : ''}`;
      select.append(option);
    }
  }
  select.value = String(state.currentServerId || '');
  select.disabled = state.servers.length < 2;
  const wrap = $('serverSwitcher');
  if (wrap) {
    wrap.classList.toggle('single-server', state.servers.length < 2);
    wrap.classList.toggle('no-server', state.servers.length === 0);
  }
  renderServerManagement();
}
function applySessionData(data) {
  state.csrf = data.csrf || state.csrf;
  state.user = data.user || state.user;
  state.servers = Array.isArray(data.servers) ? data.servers : state.servers;
  state.timeZone = data.timeZone || state.timeZone || 'UTC';
  state.minecraftAuthMode = ['online', 'offline'].includes(data.minecraftAuthMode) ? data.minecraftAuthMode : state.minecraftAuthMode;
  state.onboarding = data.onboarding || state.onboarding;
  const whitelistHint = $('whitelistUuidHint');
  const whitelistUuidInput = $('whitelistUuid');
  if (state.minecraftAuthMode === 'offline') {
    if (whitelistHint) whitelistHint.textContent = 'Offline mode: match capitalization exactly. Leave UUID blank; the panel will calculate the correct offline UUID.';
    if (whitelistUuidInput) whitelistUuidInput.placeholder = 'Exact offline UUID (optional)';
  } else {
    if (whitelistHint) whitelistHint.textContent = 'Online mode: leave UUID blank so Minecraft resolves the official account; enter it only to correct an existing entry.';
    if (whitelistUuidInput) whitelistUuidInput.placeholder = 'Exact official UUID (optional)';
  }
  const urlServer = Number(new URL(window.location.href).searchParams.get('server') || 0);
  const stored = Number(localStorage.getItem(SERVER_STORAGE_KEY) || 0);
  const candidates = [urlServer, stored, Number(data.selectedServerId || 0), Number(state.servers.find((item) => item.isDefault)?.id || 0), Number(state.servers[0]?.id || 0)];
  state.currentServerId = candidates.find((id) => id > 0 && state.servers.some((server) => Number(server.id) === id)) || 0;
  state.connections = profileConnections() || data.connections || null;
  if (state.currentServerId) localStorage.setItem(SERVER_STORAGE_KEY, String(state.currentServerId));
  renderServerSelector();
}
async function switchServer(serverId, options = {}) {
  const next = Number(serverId || 0);
  if (!next || next === Number(state.currentServerId) || !state.servers.some((server) => Number(server.id) === next)) return;
  stopRealtime();
  stopInventoryLiveLoop();
  stopPlaceMapPicker({ silent: true });
  state.currentServerId = next;
  localStorage.setItem(SERVER_STORAGE_KEY, String(next));
  state.connections = profileConnections();
  state.selectedUuid = null; state.details = null; state.players = []; state.whitelist = []; state.bans = []; state.inventory = {};
  state.alerts = []; state.sessions = []; state.history = []; state.server = {}; state.worlds = []; state.crafty = {}; state.metrics = null; state.system = null;
  state.systemLastLoad = 0; state.metricsLastLoad = 0; state.livePlayersRevision = -1; state.blueMapLoadedUrl = '';
  renderServerSelector(); updateConnectionNavigation(); applyPermissions();
  const url = new URL(window.location.href); url.searchParams.set('server', String(next));
  window.history.replaceState({ view: state.view, server: next }, '', `${url.pathname}${url.search}${url.hash}`);
  await refreshAll();
  if (state.view === 'server') await Promise.allSettled([loadCraftyServer({ silent: true }), loadMetrics(), loadCraftyLogs({ silent: true }), loadCraftyBackups({ silent: true })]);
  if (['servers', 'crafty-connections', 'system'].includes(state.view)) await loadSystem(true);
  if (state.view === 'bluemap') loadBlueMap(true);
  startRealtime(); restartInventoryLiveLoop();
  if (!options.silent) toast(`Server activo: ${currentServerProfile()?.name || 'Server'}`);
}
async function initializeAuthenticatedPanel(data) {
  applySessionData(data);
  showApp();
  applyPermissions();
  await loadDashboardLayout();
  if (!state.servers.length) {
    setView('servers', { updateUrl: true });
    renderServerManagement();
    await loadPushSettings();
    window.setTimeout(() => openAddServerWizard(), 180);
    return;
  }
  setView(requestedView(), { updateUrl: false });
  await refreshAll();
  await loadPushSettings();
  startRealtime();
  maybeShowConnectionOnboarding();
}

async function checkSession() {
  try {
    const data = await request('/api/session');
    await initializeAuthenticatedPanel(data);
  } catch (_) { showLogin(); }
}

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault(); $('loginError').textContent = '';
  try {
    const data = await request('/api/session', { method: 'POST', body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value, otp: $('otp').value.trim() }) });
    await initializeAuthenticatedPanel(data);
  } catch (error) {
    if (error.code === 'MFA_REQUIRED' || error.code === 'INVALID_OTP') { show($('otpWrap'), true); $('otp').focus(); }
    $('loginError').textContent = error.message;
  }
});
$('logoutBtn').addEventListener('click', async () => {
  try { await request('/api/logout', { method: 'POST', body: '{}' }); } catch (_) { /* ignore */ }
  stopRealtime(); state.csrf = ''; state.user = null; showLogin();
});

const NAV_VIEW_GROUPS = {
  server: new Set(['players', 'places', 'server', 'bluemap']),
  system: new Set(['servers', 'crafty-connections', 'users', 'system', 'history'])
};

const navMenuCloseTimers = new WeakMap();
const navMenuDismissedUntilLeave = new WeakSet();

function cancelNavMenuClose(menu) {
  const timer = navMenuCloseTimers.get(menu);
  if (timer) window.clearTimeout(timer);
  navMenuCloseTimers.delete(menu);
}

function closeNavMenu(menu) {
  if (!menu) return;
  cancelNavMenuClose(menu);
  menu.classList.remove('open', 'nav-pinned');
  const trigger = menu.querySelector('.nav-menu-trigger');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

function scheduleNavMenuClose(menu, delay = 360) {
  if (!menu || menu.classList.contains('nav-pinned')) return;
  cancelNavMenuClose(menu);
  const timer = window.setTimeout(() => {
    navMenuCloseTimers.delete(menu);
    if (menu.matches(':hover') || menu.contains(document.activeElement)) return;
    closeNavMenu(menu);
  }, delay);
  navMenuCloseTimers.set(menu, timer);
}

function closeNavMenus(except = null) {
  document.querySelectorAll('.nav-menu.open').forEach((menu) => {
    if (menu === except) return;
    closeNavMenu(menu);
  });
}

function updateNavState(name) {
  document.querySelectorAll('.nav-btn[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  document.querySelectorAll('.nav-menu[data-nav-group]').forEach((menu) => {
    const active = NAV_VIEW_GROUPS[menu.dataset.navGroup]?.has(name) || false;
    menu.classList.toggle('group-active', active);
    const trigger = menu.querySelector('.nav-menu-trigger');
    if (trigger) trigger.classList.toggle('active', active);
  });
}

function setView(name, options = {}) {
  const previousView = state.view;
  if (state.dashboardEditing && name !== 'dashboard') cancelDashboardEdit();
  if (name === 'metrics') name = 'server';
  if (name === 'server' && state.connections?.crafty?.configured === false) name = hasPermission('system.view') ? 'system' : 'dashboard';
  if (!VALID_VIEWS.has(name)) name = 'dashboard';
  if (name !== 'places' && state.placeMapPickerActive) stopPlaceMapPicker({ silent: true });
  if (name === 'servers' && previousView !== 'servers') {
    state.serverEditorOpen = false;
    document.body.classList.remove('server-details-modal-open');
    show($('serverDetailsPanel'), false);
  } else if (name !== 'servers' && state.serverEditorOpen) {
    closeServerEditor({ restoreFocus: false });
  }

  state.view = name;
  if (name !== 'servers') { document.body.classList.remove('server-details-modal-open'); show($('serverDetailsPanel'), false); state.serverEditorOpen = false; }
  if (!state.placeMapPickerActive) document.body.classList.remove('place-map-dialog-open');
  document.querySelectorAll('.view-section').forEach((el) => show(el, el.id === `${name}View`));
  updateNavState(name);
  closeNavMenus();
  if (options.updateUrl !== false) {
    const url = new URL(window.location.href);
    if (name === 'dashboard') url.searchParams.delete('view'); else url.searchParams.set('view', name);
    window.history.replaceState({ view: name }, '', `${url.pathname}${url.search}${url.hash}`);
  }
  if (name === 'dashboard' && state.servers.length) Promise.allSettled([loadDashboard(), loadDashboardCraftyTelemetry({ silent: true })]);
  if (name === 'server' && state.servers.length) Promise.allSettled([loadCraftyServer({ silent: true }), loadMetrics(), loadCraftyLogs({ silent: true }), loadCraftyBackups({ silent: true })]);
  restartCraftyRefreshLoop();
  if (name === 'places' && state.servers.length) loadPlaces();
  if (name === 'bluemap' && state.servers.length) loadBlueMap();
  if (name === 'history' && state.servers.length) Promise.allSettled([loadHistory(), loadSessions()]);
  if (name === 'servers') { if (state.servers.length) loadSystem(true); renderServerManagement(); }
  if (name === 'crafty-connections') { loadSystem(true); loadCraftyConnections({ silent: true }); }
  if (name === 'system' && state.servers.length) loadSystem(true);
  if (name === 'users') { setAccountsTab(state.accountTab || 'self'); Promise.allSettled([loadUsers(), loadAccountSessions(), loadPushSettings()]); }
  restartInventoryLiveLoop();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelectorAll('.nav-btn[data-view]').forEach((button) => button.addEventListener('click', () => {
  const menu = button.closest('.nav-menu');
  if (menu) {
    navMenuDismissedUntilLeave.add(menu);
    closeNavMenu(menu);
  }
  setView(button.dataset.view);
  button.blur();
}));
document.querySelectorAll('.nav-menu-trigger').forEach((trigger) => trigger.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  const menu = trigger.closest('.nav-menu');
  cancelNavMenuClose(menu);
  const willOpen = !menu.classList.contains('open') || !menu.classList.contains('nav-pinned');
  closeNavMenus(willOpen ? menu : null);
  menu.classList.toggle('open', willOpen);
  menu.classList.toggle('nav-pinned', willOpen);
  trigger.setAttribute('aria-expanded', String(willOpen));
  if (!willOpen) trigger.blur();
}));

document.querySelectorAll('.main-nav .nav-menu').forEach((menu) => {
  const trigger = menu.querySelector('.nav-menu-trigger');
  const dropdown = menu.querySelector('.nav-dropdown');

  menu.addEventListener('pointerenter', () => {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    if (navMenuDismissedUntilLeave.has(menu)) return;
    cancelNavMenuClose(menu);
    closeNavMenus(menu);
    menu.classList.add('open');
    trigger?.setAttribute('aria-expanded', 'true');
  });

  menu.addEventListener('pointerleave', () => {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    navMenuDismissedUntilLeave.delete(menu);
    scheduleNavMenuClose(menu);
  });

  dropdown?.addEventListener('pointerenter', () => cancelNavMenuClose(menu));
  dropdown?.addEventListener('pointerleave', () => scheduleNavMenuClose(menu));
  menu.addEventListener('focusin', () => cancelNavMenuClose(menu));
  menu.addEventListener('focusout', () => scheduleNavMenuClose(menu, 220));
});
document.addEventListener('click', (event) => { if (!event.target.closest('.nav-menu')) closeNavMenus(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (state.serverEditorOpen) {
      closeServerEditor();
      return;
    }
    closeNavMenus();
    document.activeElement?.blur();
  }
});
window.addEventListener('popstate', () => setView(requestedView(), { updateUrl: false }));
window.addEventListener('resize', () => {
  if (window.innerWidth <= 760) closeNavMenus();
});

function worldNames() { return state.worlds.map((world) => typeof world === 'string' ? world : world.name).filter(Boolean); }
function worldEntry(name) { return state.worlds.find((world) => typeof world === 'object' && world && world.name === name) || null; }
function minecraftClock(ticks) {
  const normalized = ((Math.floor(safeNumber(ticks)) % 24000) + 24000) % 24000;
  const totalMinutes = Math.floor(((normalized + 6000) % 24000) * 1440 / 24000);
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
}
function phaseLabel(phase) { return ({ DAWN: 'Dawn', DAY: 'Day', DUSK: 'Dusk', NIGHT: 'Night', STATIC: 'Fixed time' })[phase] || 'Unknown'; }
function weatherLabel(weather) { return ({ CLEAR: 'Clear', RAIN: 'Rain', THUNDER: 'Thunder' })[weather] || 'Unknown'; }

function renderWorldControlOptions(preferred = '') {
  const select = $('worldControlSelect'); const names = worldNames(); const previous = preferred || state.selectedWorld || select.value; select.textContent = '';
  for (const name of names) { const option = document.createElement('option'); option.value = name; const world = worldEntry(name); option.textContent = world && world.environment !== 'NORMAL' ? `${name} · ${world.environment}` : name; select.append(option); }
  state.selectedWorld = previous && names.includes(previous) ? previous : (names[0] || ''); select.value = state.selectedWorld;
}
function renderWorldSelects() {
  for (const id of ['tpWorld', 'placeWorld']) {
    const select = $(id); const previous = select.value; select.textContent = '';
    for (const name of worldNames()) { const option = document.createElement('option'); option.value = name; option.textContent = name; select.append(option); }
    if (previous && worldNames().includes(previous)) select.value = previous;
  }
}
function setWorldSceneUnavailable(message = 'No server connection') {
  $('worldScene').className = 'world-scene phase-static weather-clear scene-offline'; $('worldSceneTitle').textContent = 'Status unavailable'; $('worldSceneMeta').textContent = message;
  for (const id of ['worldControlSelect', 'setDayBtn', 'setNightBtn', 'timePresetSelect', 'applyTimeBtn', 'weatherSelect', 'applyWeatherBtn']) $(id).disabled = true;
}
function estimatedWorldTime(world) {
  const base = ((safeNumber(world?.time) % 24000) + 24000) % 24000;
  const sampledAt = safeNumber(world?._sampledAtMs, 0);
  const canAdvance = sampledAt > 0 && state.runtimeState !== 'PAUSED_EMPTY' && document.visibilityState === 'visible';
  if (!canAdvance) return base;
  const elapsedTicks = Math.max(0, Math.min(200, (Date.now() - sampledAt) / 50));
  return (base + elapsedTicks) % 24000;
}
function derivedWorldPhase(time, fallback = 'STATIC') {
  if (!Number.isFinite(time)) return fallback;
  if (time >= 23000 || time < 1000) return 'DAWN';
  if (time < 12000) return 'DAY';
  if (time < 13000) return 'DUSK';
  return 'NIGHT';
}
function stampWorldSnapshot(world, sampledAtMs = Date.now()) {
  if (!world || typeof world !== 'object') return world;
  return { ...world, _sampledAtMs: sampledAtMs };
}
function renderWorldScene(world) {
  if (!world || typeof world !== 'object') { setWorldSceneUnavailable('No worlds are loaded'); return; }
  const time = estimatedWorldTime(world);
  const phase = world.environment === 'NORMAL' ? derivedWorldPhase(time, world.phase || 'STATIC') : (world.phase || 'STATIC');
  const scene = $('worldScene'); scene.className = `world-scene phase-${String(phase).toLowerCase()} weather-${String(world.weather || 'CLEAR').toLowerCase()}`;
  const isNatural = world.environment === 'NORMAL'; const isDay = time >= 0 && time < 13000;
  let progress = isDay ? Math.min(1, Math.max(0, ((time >= 23000 ? time - 24000 : time) + 1000) / 13000)) : Math.min(1, Math.max(0, (time - 12000) / 11000));
  scene.style.setProperty('--celestial-x', `${6 + progress * 88}%`); scene.style.setProperty('--celestial-y', `${68 - Math.sin(Math.PI * progress) * 54}%`);
  $('celestial').className = `celestial ${isDay ? 'sun' : 'moon'}`;
  $('worldSceneTitle').textContent = `${world.name || 'world'} · Day ${world.dayNumber ?? '—'}`;
  $('worldSceneMeta').textContent = `${phaseLabel(world.phase)} · ${minecraftClock(time)} · ${weatherLabel(world.weather)}${isNatural ? '' : ` · ${world.environment || 'DIMENSION'}`}`;
  const currentWeather = world.weather || 'CLEAR';
  const keepPendingWeather = state.weatherDirty && state.weatherDraftWorld === state.selectedWorld;
  if (keepPendingWeather) {
    $('weatherSelect').value = state.weatherDraft;
  } else {
    $('weatherSelect').value = currentWeather;
    state.weatherDraft = currentWeather;
    state.weatherDraftWorld = state.selectedWorld;
    state.weatherDirty = false;
  }
  for (const id of ['worldControlSelect', 'weatherSelect', 'applyWeatherBtn']) $(id).disabled = false;
  for (const id of ['setDayBtn', 'setNightBtn', 'timePresetSelect', 'applyTimeBtn']) $(id).disabled = !isNatural;
}
function renderSelectedWorldScene() { renderWorldScene(worldEntry(state.selectedWorld)); }
function applyLiveWorlds(payload = {}) {
  const worlds = Array.isArray(payload.worlds) ? payload.worlds : [];
  if (!worlds.length) return;
  const sampledAtMs = safeNumber(payload.updatedAt, 0) > 0 ? safeNumber(payload.updatedAt) * 1000 : Date.now();
  const previousSelected = state.selectedWorld;
  const merged = new Map((state.worlds || []).filter((world) => world?.name).map((world) => [world.name, world]));
  for (const world of worlds) if (world?.name) merged.set(world.name, stampWorldSnapshot(world, sampledAtMs));
  const stamped = [...merged.values()];
  state.worlds = stamped;
  state.server = { ...(state.server || {}), worlds: stamped };
  state.worldLiveUpdatedAt = sampledAtMs;
  renderWorldControlOptions(previousSelected);
  renderWorldSelects();
  renderSelectedWorldScene();
}
function startWorldSceneClock() {
  stopWorldSceneClock();
  state.worldSceneTimer = window.setInterval(() => {
    if (!state.user || state.view !== 'dashboard' || document.visibilityState !== 'visible') return;
    renderSelectedWorldScene();
  }, 1000);
}
function stopWorldSceneClock() {
  if (state.worldSceneTimer) clearInterval(state.worldSceneTimer);
  state.worldSceneTimer = null;
}
async function controlWorld(changes) {
  if (!state.selectedWorld) return toast('Select a world', true);
  const targetWorld = state.selectedWorld;
  const changesWeather = Object.prototype.hasOwnProperty.call(changes, 'weather');
  for (const id of ['setDayBtn', 'setNightBtn', 'applyTimeBtn', 'applyWeatherBtn']) $(id).disabled = true;
  try {
    const data = await request('/api/v1/world/control', { method: 'POST', body: JSON.stringify({ world: targetWorld, ...changes }) });
    if (data.world?.name) { const index = state.worlds.findIndex((world) => world?.name === data.world.name); const stampedWorld = stampWorldSnapshot(data.world); if (index >= 0) state.worlds[index] = stampedWorld; else state.worlds.push(stampedWorld); }
    if (changesWeather && state.selectedWorld === targetWorld) {
      state.weatherDraft = data.world?.weather || changes.weather || 'CLEAR';
      state.weatherDraftWorld = targetWorld;
      state.weatherDirty = false;
    }
    renderSelectedWorldScene(); toast('World status updated'); window.setTimeout(() => loadServer().catch(() => {}), 600);
  } catch (error) { toast(error.message, true); }
  finally { renderSelectedWorldScene(); }
}

async function loadServer() {
  const requestSequence = ++state.serverRequestSeq;
  try {
    const data = await request('/api/v1/server');
    if (requestSequence !== state.serverRequestSeq) return;
    state.server = data.server || {}; const sampledAtMs = Date.now(); state.worlds = Array.isArray(state.server.worlds) ? state.server.worlds.map((world) => stampWorldSnapshot(world, sampledAtMs)) : []; state.server.worlds = state.worlds; state.worldLiveUpdatedAt = sampledAtMs;
    setCompactStatusPill($('apiStatus'), 'online', 'Server online', 'Minecraft and the Fabric adapter are responding');
    $('serverSubtitle').textContent = `${state.server.minecraftVersion || '—'} · ${state.server.onlinePlayers ?? state.players.length}/${state.server.maximumPlayers ?? '—'} online`;
    renderWorldControlOptions(state.selectedWorld); renderWorldSelects(); renderSelectedWorldScene(); renderPlacesInSelects();
  } catch (error) {
    if (requestSequence !== state.serverRequestSeq) return;
    setCompactStatusPill($('apiStatus'), 'offline', 'Server offline', `Minecraft is not responding: ${error.message}`); $('serverSubtitle').textContent = error.message; setWorldSceneUnavailable(error.message); renderRuntimeMetricsStatus({}, false);
  }
}
async function loadPlayers() {
  try {
    const bansPromise = request('/api/v1/bans')
      .then((data) => ({ data, supported: true }))
      .catch((error) => {
        if ([404, 405, 501].includes(Number(error.status))) return { data: { entries: [] }, supported: false };
        throw error;
      });
    const [playersData, whitelistData, bansResult] = await Promise.all([
      request('/api/v1/players/all'),
      request('/api/v1/whitelist'),
      bansPromise
    ]);
    state.bansSupported = bansResult.supported;
    state.bans = (bansResult.data.entries || []).map((entry) => ({ ...entry, name: playerName(entry), banned: true }));
    const banByUuid = new Map(state.bans.filter((entry) => entry.uuid).map((entry) => [String(entry.uuid).toLowerCase(), entry]));
    const merged = new Map();
    for (const rawPlayer of (playersData.players || [])) {
      const player = normalizePlayer(rawPlayer);
      const ban = banByUuid.get(String(player.uuid || '').toLowerCase()) || player.ban || null;
      if (ban) { player.banned = true; player.ban = { ...ban, ...(player.ban || {}) }; }
      if (player.uuid) merged.set(String(player.uuid).toLowerCase(), player);
    }
    for (const ban of state.bans) {
      if (!ban.uuid) continue;
      const key = String(ban.uuid).toLowerCase();
      const existing = merged.get(key);
      if (existing) { existing.banned = true; existing.ban = { ...ban, ...(existing.ban || {}) }; }
      else merged.set(key, normalizePlayer({ ...ban, online: false, banned: true, ban }));
    }
    state.players = [...merged.values()];
    state.whitelist = (whitelistData.entries || []).map((entry) => ({ ...entry, name: playerName(entry) }));
    renderPlayers(); renderWhitelist(); renderBulkPlayers();
    if (state.selectedUuid && !state.players.some((player) => player.uuid === state.selectedUuid)) {
      state.selectedUuid = null; state.details = null; show($('welcome'), true); show($('playerView'), false);
    }
  } catch (error) { toast(error.message, true); }
}
function filteredPlayers() {
  const search = state.playerSearch.trim().toLowerCase();
  return state.players.filter((player) => {
    if (state.playerFilter === 'online' && !player.online) return false;
    if (state.playerFilter === 'offline' && player.online) return false;
    if (state.playerFilter === 'whitelist' && !player.whitelisted) return false;
    if (state.playerFilter === 'banned' && !player.banned) return false;
    if (!search) return true;
    return `${playerName(player)} ${player.uuid || ''}`.toLowerCase().includes(search);
  });
}
function playerSummary(player) {
  const ban = player.ban || {};
  const bannedLabel = player.banned ? `Banned${ban.reason ? `: ${ban.reason}` : ''}` : '';
  if (player.online) return [bannedLabel, `${player.world || 'Unknown world'} · ❤ ${player.health ?? '—'} · 🍗 ${player.food ?? '—'}`].filter(Boolean).join(' · ');
  const flags = [];
  if (bannedLabel) flags.push(bannedLabel);
  if (player.whitelisted) flags.push('Whitelist');
  const hasHistory = Boolean(player.hasPlayedBefore) || safeNumber(player.lastPlayed) > 0;
  flags.push(hasHistory ? `Last seen ${formatPlayerTimestamp(player.lastPlayed)}` : 'No previous connection');
  return flags.join(' · ');
}
function renderPlayers() {
  const list = $('playerList'); list.textContent = '';
  const players = filteredPlayers();
  $('playerCount').textContent = state.playerFilter === 'all' && !state.playerSearch ? String(state.players.length) : `${players.length}/${state.players.length}`;
  show($('emptyPlayers'), players.length === 0);
  document.querySelectorAll('[data-player-filter]').forEach((button) => button.classList.toggle('active', button.dataset.playerFilter === state.playerFilter));
  for (const player of players) {
    const button = document.createElement('button');
    button.className = `player-row${player.uuid === state.selectedUuid ? ' active' : ''}${player.online ? ' online-player' : ' offline-player'}${player.banned ? ' banned-player' : ''}`;
    button.type = 'button';
    const avatar = document.createElement('span'); avatar.className = 'mini-avatar'; fillAvatar(avatar, player);
    const text = document.createElement('span');
    const top = document.createElement('span'); top.className = 'player-row-title';
    const strong = document.createElement('strong'); strong.textContent = playerName(player);
    const status = document.createElement('i'); status.className = `player-state-dot ${player.online ? 'online' : 'offline'}`; status.title = player.online ? 'Online' : 'Offline';
    top.append(strong, status);
    if (player.banned) { const banned = document.createElement('span'); banned.className = 'ban-row-badge'; banned.textContent = 'Banned'; top.append(banned); }
    const small = document.createElement('small'); small.textContent = playerSummary(player);
    text.append(top, small); button.append(avatar, text);
    button.addEventListener('click', () => { setView('players'); selectPlayer(player.uuid); }); list.append(button);
  }
}
function renderWhitelist() {
  const list = $('whitelistList'); list.textContent = '';
  $('whitelistCount').textContent = String(state.whitelist.length);
  show($('emptyWhitelist'), state.whitelist.length === 0);
  const playerMap = new Map(state.players.map((player) => [String(player.uuid).toLowerCase(), player]));
  for (const entry of state.whitelist) {
    const row = document.createElement('article'); row.className = 'whitelist-entry';
    const info = document.createElement('div');
    const nameLine = document.createElement('strong'); nameLine.textContent = playerName(entry);
    const player = playerMap.get(String(entry.uuid || '').toLowerCase());
    const stateText = document.createElement('small'); stateText.textContent = player?.online ? 'Online ahora' : 'Offline';
    const uuid = document.createElement('code'); uuid.textContent = entry.uuid || 'UUID desconocido';
    info.append(nameLine, stateText, uuid);
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'ghost small-btn'; edit.textContent = 'Edit UUID';
    edit.disabled = !hasPermission('players.whitelist'); edit.addEventListener('click', () => editWhitelistEntry(entry));
    row.append(info, edit); list.append(row);
  }
}
async function editWhitelistEntry(entry) {
  const oldUuid = String(entry.uuid || '');
  const newUuid = prompt(`Correct UUID for ${playerName(entry)}:`, oldUuid);
  if (newUuid === null) return;
  const cleanUuid = newUuid.trim();
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(cleanUuid)) return toast('Invalid UUID', true);
  const newName = prompt('Player name:', playerName(entry));
  if (newName === null) return;
  const cleanName = newName.trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(cleanName)) return toast('Invalid name', true);
  try {
    await request('/api/v1/whitelist/update', { method: 'POST', body: JSON.stringify({ oldUuid, newUuid: cleanUuid, name: cleanName }) });
    toast(`UUID for ${cleanName} updated and whitelist reloaded`);
    await loadPlayers();
    if (state.selectedUuid === oldUuid) { state.selectedUuid = cleanUuid; await loadPlayer(cleanUuid); }
  } catch (error) { toast(error.message, true); }
}
async function selectPlayer(uuid) {
  state.selectedUuid = uuid; state.inventory = {}; state.inventoryFingerprint = ''; renderPlayers(); renderInventory(); show($('welcome'), false); show($('playerView'), true);
  setInventoryLiveStatus('syncing', 'Sincronizando');
  const listed = state.players.find((player) => player.uuid === uuid);
  await loadPlayer(uuid, true);
  if (listed?.online || state.details?.online) await loadInventory(uuid, { forceRender: true });
  restartInventoryLiveLoop();
}
async function loadPlayer(uuid = state.selectedUuid, notify = false) {
  if (!uuid) return;
  try { const data = await request(`/api/v1/players/${uuid}`); const listed = state.players.find((player) => player.uuid === uuid) || {}; const player = normalizePlayer({ ...listed, ...(data.player || {}) }); const ban = (data.player || {}).ban || listed.ban || state.bans.find((entry) => String(entry.uuid || '').toLowerCase() === String(uuid).toLowerCase()); if (ban) { player.banned = true; player.ban = { ...ban }; } state.details = player; renderDetails(state.details); if (notify) toast('Profile updated'); }
  catch (error) { toast(error.message, true); }
}
function formatPlayerTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '—';
  const milliseconds = number > 100000000000 ? number : number * 1000;
  return panelDateTimeFormat( { dateStyle: 'short', timeStyle: 'short' }).format(new Date(milliseconds));
}
function formatBanTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return '—';
  if (/^forever$/i.test(raw)) return 'Never (permanent)';
  let normalized = raw;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/);
  if (match) normalized = `${match[1]}T${match[2]}${match[3]}:${match[4]}`;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return raw;
  return panelDateTimeFormat( { dateStyle: 'short', timeStyle: 'short' }).format(new Date(parsed));
}
function setQuickActionLabel(id, text) {
  const button = $(id);
  if (!button) return;
  const label = button.querySelector('.quick-action-label');
  if (label) label.textContent = text;
  else button.textContent = text;
}
function setOnlineControls(online) {
  document.querySelectorAll('[data-online-only]').forEach((element) => { element.disabled = !online; });
  document.querySelectorAll('[data-online-section]').forEach((section) => {
    section.classList.toggle('offline-disabled', !online);
    section.querySelectorAll('button, input, select').forEach((element) => { element.disabled = !online; });
  });
  show($('inventoryPanel'), online);
}
function renderDetails(p) {
  const online = Boolean(p.online);
  fillAvatar($('avatar'), p); $('playerName').textContent = playerName(p); $('playerUuid').textContent = p.uuid || '';
  $('onlineBadge').textContent = online ? 'Online' : 'Offline'; $('onlineBadge').className = `badge ${online ? 'online-badge' : 'offline-badge'}`;
  show($('banBadge'), Boolean(p.banned));
  $('gameModeBadge').textContent = online ? (p.gamemode || '—') : 'Offline'; $('worldBadge').textContent = online ? (p.world || '—') : (p.banned ? 'Access blocked' : (p.whitelisted ? 'Whitelist' : 'Unauthorized'));
  $('healthStat').textContent = online ? `${p.health ?? '—'} / ${p.maxHealth ?? '—'}` : 'Offline'; $('healthMeter').style.width = online ? `${Math.min(100, safeNumber(p.health) / Math.max(1, safeNumber(p.maxHealth, 20)) * 100)}%` : '0%';
  $('foodStat').textContent = online ? `${p.food ?? '—'} / 20` : 'Offline'; $('foodMeter').style.width = online ? `${Math.min(100, safeNumber(p.food) / 20 * 100)}%` : '0%'; $('levelStat').textContent = online ? (p.level ?? '—') : '—'; $('xpStat').textContent = online ? `Progress: ${Math.round(safeNumber(p.experience) * 100)}%` : 'Available when connected';
  const loc = p.location || {}; $('positionStat').textContent = online ? `${p.x ?? loc.x ?? '—'}, ${p.y ?? loc.y ?? '—'}, ${p.z ?? loc.z ?? '—'}` : '—'; $('orientationStat').textContent = online ? `Yaw ${loc.yaw ?? '—'} · Pitch ${loc.pitch ?? '—'}` : 'Player offline';
  $('onlineDetail').textContent = online ? 'Online' : 'Offline'; $('ipDetail').textContent = online ? (p.ip || '—') : '—'; $('flyingDetail').textContent = online ? formatBool(p.flying) : '—'; $('operatorDetail').textContent = formatBool(p.operator); $('whitelistDetail').textContent = formatBool(p.whitelisted);
  const ban = p.ban || {}; $('bannedDetail').textContent = p.banned ? 'Yes' : 'No'; $('banReasonDetail').textContent = p.banned ? (ban.reason || p.reason || 'No reason provided') : '—'; $('banCreatedDetail').textContent = p.banned ? formatBanTimestamp(ban.created) : '—'; $('banExpiresDetail').textContent = p.banned ? (ban.permanent || /^forever$/i.test(String(ban.expires || '')) ? 'Never (permanent)' : formatBanTimestamp(ban.expires)) : '—';
  $('hasPlayedDetail').textContent = formatBool(p.hasPlayedBefore || online); $('firstPlayedDetail').textContent = formatPlayerTimestamp(p.firstPlayed); $('lastPlayedDetail').textContent = formatPlayerTimestamp(p.lastPlayed);
  $('lastDeathDetail').textContent = online ? formatLocation(p.lastDeathLocation) : '—';
  const respawnLabel = p.respawnSource === 'WORLD_SPAWN' ? 'world spawn' : 'personal'; $('respawnDetail').textContent = online && p.respawnLocation ? `${formatLocation(p.respawnLocation)} (${respawnLabel})` : '—';
  $('playTimeDetail').textContent = online ? formatTicks((p.statistics || {}).playTimeTicks) : '—'; $('deathsDetail').textContent = online ? ((p.statistics || {}).deaths ?? '—') : '—'; $('mobKillsDetail').textContent = online ? ((p.statistics || {}).mobKills ?? '—') : '—'; $('playerKillsDetail').textContent = online ? ((p.statistics || {}).playerKills ?? '—') : '—';
  $('gamemodeSelect').value = p.gamemode || 'SURVIVAL'; if (online) setTeleportLocation(p.location || { world: p.world, x: p.x, y: p.y, z: p.z }); $('deathLocationBtn').disabled = !online || !p.lastDeathLocation; $('respawnLocationBtn').disabled = !online || !p.respawnLocation; setQuickActionLabel('whitelistBtn', p.whitelisted ? 'Remove from whitelist' : 'Add to whitelist'); setQuickActionLabel('operatorBtn', p.operator ? 'Remove operator' : 'Make operator'); $('operatorBtn')?.classList.toggle('operator-enabled', Boolean(p.operator)); $('operatorBtn')?.setAttribute('aria-pressed', p.operator ? 'true' : 'false');
  show($('banBtn'), !p.banned && hasPermission('players.ban')); show($('unbanBtn'), Boolean(p.banned) && hasPermission('players.ban')); $('unbanBtn').disabled = Boolean(p.banned) && state.bansSupported === false; show($('banSupportNote'), Boolean(p.banned) && state.bansSupported === false); $('reasonInput').disabled = Boolean(p.banned);
  setOnlineControls(online);
  if (!online) setInventoryLiveStatus('offline', 'Player offline');
  restartInventoryLiveLoop();
}
function normalizedTeleportWorld(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const available = worldNames();
  const exact = available.find((world) => world.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;
  const lower = raw.toLowerCase();
  if (lower.includes('the_nether')) return available.find((world) => world.toLowerCase().endsWith('_nether')) || raw;
  if (lower.includes('the_end')) return available.find((world) => world.toLowerCase().endsWith('_the_end')) || raw;
  if (lower.includes('overworld')) return available.find((world) => !/_nether$|_the_end$/i.test(world)) || raw;
  return raw;
}
function setTeleportLocation(location) {
  if (!location) return;
  const world = normalizedTeleportWorld(location.world);
  if (world && worldNames().includes(world)) $('tpWorld').value = world;
  $('tpCoords').value = `${location.x} ${location.y} ${location.z}`;
}
function teleportLocationMatches(actual, requested) {
  if (!actual || !requested) return false;
  const actualWorld = normalizedTeleportWorld(actual.world).toLowerCase();
  const requestedWorld = normalizedTeleportWorld(requested.world).toLowerCase();
  if (actualWorld && requestedWorld && actualWorld !== requestedWorld) return false;
  return Math.abs(safeNumber(actual.x, Number.NaN) - safeNumber(requested.x, Number.NaN)) <= 0.35
    && Math.abs(safeNumber(actual.y, Number.NaN) - safeNumber(requested.y, Number.NaN)) <= 0.35
    && Math.abs(safeNumber(actual.z, Number.NaN) - safeNumber(requested.z, Number.NaN)) <= 0.35;
}
function parseCoordinateText(raw, defaultWorld = '') {
  let value = String(raw || '').trim();
  if (!value) throw new Error('Paste the X Y Z coordinates');
  let detectedWorld = '';
  for (const world of worldNames().sort((a, b) => b.length - a.length)) {
    const escapedWorld = world.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[\\s,;])${escapedWorld}(?=$|[\\s,;])`, 'i');
    if (pattern.test(value)) { detectedWorld = world; value = value.replace(pattern, ' '); break; }
  }
  const dimensionMatch = value.match(/minecraft:(overworld|the_nether|the_end)/i);
  if (dimensionMatch && !detectedWorld) detectedWorld = normalizedTeleportWorld(dimensionMatch[0]);
  value = value.replace(/minecraft:(overworld|the_nether|the_end)/gi, ' ').replace(/[(),;[\]{}]/g, ' ').replace(/\b[xyz]\s*[:=]\s*/gi, ' ');
  const numbers = value.split(/\s+/).filter((token) => /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(token));
  if (numbers.length < 3) throw new Error('Invalid format. Use: X Y Z');
  const [x, y, z] = numbers.slice(0, 3).map(Number);
  return { world: detectedWorld || defaultWorld, x, y, z };
}
function parseTeleportCoordinates(raw) { return parseCoordinateText(raw, $('tpWorld').value); }

async function action(name, body = {}) {
  if (!state.selectedUuid) return;
  if (!['whitelist', 'ban', 'unban'].includes(name) && state.details && !state.details.online) return toast('The player is offline', true);
  try {
    const data = await request(`/api/v1/players/${state.selectedUuid}/${name}`, { method: 'POST', body: JSON.stringify(body) });
    if (name === 'teleport') {
      const actual = data?.result?.location;
      if (!teleportLocationMatches(actual, body)) {
        const error = new Error('Minecraft did not confirm the teleport. The player position did not change.');
        error.code = 'TELEPORT_NOT_APPLIED';
        throw error;
      }
    }
    toast(name === 'teleport' ? 'Teleport completed' : 'Action completed');
    const tasks = [loadPlayer(), loadPlayers(), loadDashboard()]; if (state.details?.online) tasks.push(loadInventory());
    await Promise.allSettled(tasks); return data;
  } catch (error) {
    if (name === 'teleport' && error.code === 'TELEPORT_NOT_APPLIED') {
      error.message = 'Minecraft did not apply the teleport. Check the world and coordinates.';
    }
    toast(error.message, true); throw error;
  }
}

function itemCategory(material) {
  const value = String(material || '').toUpperCase();
  if (/(SWORD|AXE|PICKAXE|SHOVEL|HOE|BOW|CROSSBOW|TRIDENT|MACE|FISHING_ROD|SHEARS|FLINT_AND_STEEL)/.test(value)) return 'tools';
  if (/(HELMET|CHESTPLATE|LEGGINGS|BOOTS|ELYTRA|SHIELD)/.test(value)) return 'armor';
  if (/(BREAD|APPLE|BEEF|PORK|CHICKEN|MUTTON|RABBIT|COD|SALMON|POTATO|CARROT|MELON|COOKIE|CAKE|STEW|SOUP|BERRY|HONEY|KELP|EGG|CHORUS_FRUIT)/.test(value)) return 'food';
  if (/(STONE|DIRT|SAND|GRAVEL|PLANKS|LOG|WOOD|WOOL|GLASS|BRICK|ORE|BLOCK|SLAB|STAIRS|FENCE|DOOR|TERRACOTTA|CONCRETE|LEAVES|SAPLING)/.test(value)) return 'blocks';
  return 'other';
}
function setInventoryLiveStatus(kind, text) {
  const badge = $('inventoryLiveBadge');
  if (!badge) return;
  badge.className = `inventory-live-badge ${kind || 'idle'}`;
  badge.textContent = text || 'En espera';
}
function inventoryLiveEligible() {
  return Boolean(state.user && state.view === 'players' && state.selectedUuid && state.details?.online && document.visibilityState === 'visible');
}
function inventorySnapshotFingerprint(inventory) {
  try { return JSON.stringify(inventory || {}); } catch (_) { return String(Date.now()); }
}
async function loadInventory(uuid = state.selectedUuid, options = {}) {
  if (!uuid || state.inventoryLiveBusy) return false;
  state.inventoryLiveBusy = true;
  if (!options.silent) setInventoryLiveStatus('syncing', 'Sincronizando');
  try {
    const data = await request(`/api/v1/players/${uuid}/inventory`);
    if (uuid !== state.selectedUuid) return false;
    const inventory = data.inventory || {};
    const fingerprint = inventorySnapshotFingerprint(inventory);
    const changed = fingerprint !== state.inventoryFingerprint;
    state.inventory = inventory;
    state.inventoryFingerprint = fingerprint;
    state.inventoryUpdatedAt = Date.now();
    if (changed || options.forceRender) renderInventory();
    setInventoryLiveStatus('live', changed ? 'Updated ahora' : 'En vivo');
    return changed;
  } catch (error) {
    if (error.status === 409 || error.code === 'PLAYER_OFFLINE') {
      setInventoryLiveStatus('offline', 'Player offline');
      stopInventoryLiveLoop();
    } else {
      setInventoryLiveStatus('error', 'Retrying');
      if (!options.silent) toast(error.message, true);
    }
    return false;
  } finally {
    state.inventoryLiveBusy = false;
  }
}
function stopInventoryLiveLoop() {
  if (state.inventoryLiveTimer) clearTimeout(state.inventoryLiveTimer);
  state.inventoryLiveTimer = null;
}
function scheduleInventoryLiveLoop(delay = 1600) {
  stopInventoryLiveLoop();
  if (!inventoryLiveEligible()) return;
  state.inventoryLiveTimer = setTimeout(async () => {
    await loadInventory(state.selectedUuid, { silent: true });
    scheduleInventoryLiveLoop();
  }, delay);
}
function restartInventoryLiveLoop() {
  stopInventoryLiveLoop();
  if (inventoryLiveEligible()) scheduleInventoryLiveLoop(500);
}

function itemElement(item, slotNumber = null) {
  const el = document.createElement('div'); el.className = `item-slot${item ? '' : ' empty-slot'}`; el.dataset.material = item?.material || ''; el.dataset.category = item ? itemCategory(item.material) : '';
  if (item) {
    const image = document.createElement('img'); image.className = 'item-image'; image.src = itemImageUrl(item.material); image.alt = prettyMaterial(item.material); image.loading = 'lazy'; image.addEventListener('error', () => image.remove(), { once: true }); el.append(image);
    const name = document.createElement('div'); name.className = 'item-name'; name.textContent = stripMinecraftFormatting(item.displayName) || prettyMaterial(item.material); el.append(name);
    if (safeNumber(item.amount, 1) > 1) { const amount = document.createElement('span'); amount.className = 'amount'; amount.textContent = item.amount; el.append(amount); }
    if (safeNumber(item.damage) > 0) el.classList.add('damaged'); el.addEventListener('click', () => showItemDialog(item));
  }
  if (slotNumber !== null) { const num = document.createElement('span'); num.className = 'slot-num'; num.textContent = slotNumber; el.append(num); }
  return el;
}
function renderInventory() {
  const inv = state.inventory || {}; const storage = inv.storage || []; const bySlot = new Map(storage.map((item) => [item.slot, item])); const grid = $('inventoryGrid'); grid.textContent = '';
  for (let i = 0; i < 36; i++) { const slot = itemElement(bySlot.get(i), i); if (i === inv.heldSlot) slot.classList.add('held'); grid.append(slot); }
  const armor = inv.armor || {};
  for (const [id, key] of [['helmetSlot', 'helmet'], ['chestplateSlot', 'chestplate'], ['leggingsSlot', 'leggings'], ['bootsSlot', 'boots']]) { const replacement = itemElement(armor[key]); replacement.id = id; $(id).replaceWith(replacement); }
  const off = itemElement(inv.offHand); off.id = 'offHandSlot'; $('offHandSlot').replaceWith(off);
  const allItems = [...storage, ...Object.values(armor).filter(Boolean), ...(inv.offHand ? [inv.offHand] : [])]; $('inventorySummary').textContent = `${allItems.reduce((sum, item) => sum + safeNumber(item.amount, 1), 0)} items · ${allItems.length} slots`;
  filterInventory();
}
function filterInventory() {
  const query = $('inventorySearch').value.trim().toLowerCase(); const category = $('inventoryCategory').value;
  document.querySelectorAll('#inventoryGrid .item-slot').forEach((slot) => { const material = slot.dataset.material.toLowerCase(); const matchText = !query || material.includes(query) || prettyMaterial(material).toLowerCase().includes(query); const matchCategory = category === 'all' || slot.dataset.category === category; slot.classList.toggle('filtered-out', Boolean(material) && !(matchText && matchCategory)); });
}
function showItemDialog(item) {
  const content = $('itemDialogContent'); content.textContent = '';
  const head = document.createElement('div'); head.className = 'item-detail-head'; const image = document.createElement('img'); image.src = itemImageUrl(item.material); image.alt = ''; const heading = document.createElement('div'); const title = document.createElement('h2'); title.textContent = stripMinecraftFormatting(item.displayName) || prettyMaterial(item.material); const code = document.createElement('code'); code.textContent = item.material || ''; heading.append(title, code); head.append(image, heading); content.append(head);
  const list = document.createElement('div'); list.className = 'item-detail-list';
  const details = [['Amount', item.amount ?? 1], ['Damage', item.damage ?? 0], ['Maximum durability', item.maxDamage ?? '—'], ['Category', itemCategory(item.material)]];
  for (const [label, value] of details) { const row = document.createElement('div'); const a = document.createElement('span'); a.textContent = label; const b = document.createElement('span'); b.textContent = String(value); row.append(a, b); list.append(row); }
  if (item.enchantments && Object.keys(item.enchantments).length) { const row = document.createElement('div'); const a = document.createElement('span'); a.textContent = 'Encantamientos'; const b = document.createElement('span'); b.textContent = Object.entries(item.enchantments).map(([key, value]) => `${prettyMaterial(key)} ${value}`).join(', '); row.append(a, b); list.append(row); }
  content.append(list); $('itemDialog').showModal();
}

function dashboardMetricTimestamp(telemetry) {
  const timestamp = safeNumber(telemetry?.updatedAt);
  if (!timestamp) return 'No recent sample';
  return `Updated ${panelDateTimeFormat( { timeStyle: 'short' }).format(new Date(timestamp * 1000))}`;
}
function renderDashboardTelemetry(telemetry = {}) {
  const metricNumber = (value) => value === null || value === undefined || value === '' ? Number.NaN : Number(value);
  const cpu = metricNumber(telemetry.cpuPercent);
  const memory = metricNumber(telemetry.memoryPercent);
  const tps = metricNumber(telemetry.tps);
  const uptime = metricNumber(telemetry.uptimeSeconds);
  const runtimeState = String(telemetry.runtimeState || '').toUpperCase();
  state.runtimeState = runtimeState;
  const sampleMeta = telemetry.stale ? 'Muestra antigua' : dashboardMetricTimestamp(telemetry);

  if ($('dashCpu')) $('dashCpu').textContent = Number.isFinite(cpu) ? `${cpu.toFixed(cpu >= 10 ? 1 : 2)}%` : '—';
  if ($('dashCpuMeta')) $('dashCpuMeta').textContent = Number.isFinite(cpu) ? sampleMeta : 'No CPU data';

  if ($('dashMemory')) {
    const used = telemetry.memoryBytes !== undefined && telemetry.memoryBytes !== null ? formatBytes(telemetry.memoryBytes) : '';
    $('dashMemory').textContent = telemetry.memorySource === 'crafty' && used && used !== '—'
      ? used
      : (Number.isFinite(memory) ? `${memory.toFixed(memory >= 10 ? 1 : 2)}%` : '—');
  }
  if ($('dashMemoryMeta')) {
    const used = telemetry.memoryBytes !== undefined && telemetry.memoryBytes !== null ? formatBytes(telemetry.memoryBytes) : '';
    if (telemetry.memorySource === 'crafty' && (used || Number.isFinite(memory))) {
      const parts = [];
      if (Number.isFinite(memory)) parts.push(`Usage: ${memory.toFixed(memory >= 10 ? 0 : 1)}%`);
      if (telemetry.craftyStale) parts.push('last available sample');
      $('dashMemoryMeta').textContent = parts.join(' · ') || sampleMeta;
    } else {
      $('dashMemoryMeta').textContent = Number.isFinite(memory) ? (used && used !== '—' ? `${used} used` : sampleMeta) : 'No RAM data';
    }
  }

  if ($('dashTps')) {
    const dashTps = $('dashTps');
    dashTps.classList.remove('tps-good', 'tps-warning', 'tps-bad', 'tps-paused', 'tps-unknown');
    if (runtimeState === 'PAUSED_EMPTY') {
      dashTps.textContent = 'Paused';
      dashTps.classList.add('tps-paused');
    } else if (Number.isFinite(tps)) {
      dashTps.textContent = tps.toFixed(2);
      dashTps.classList.add(tps >= 18 ? 'tps-good' : (tps >= 15 ? 'tps-warning' : 'tps-bad'));
    } else {
      dashTps.textContent = '—';
      dashTps.classList.add('tps-unknown');
    }
  }
  if ($('dashTpsMeta')) $('dashTpsMeta').textContent = runtimeState === 'PAUSED_EMPTY' ? 'Server paused' : (Number.isFinite(tps) ? sampleMeta : 'No TPS data');

  if ($('dashUptime')) $('dashUptime').textContent = Number.isFinite(uptime) ? formatDuration(uptime) : '—';
  if ($('dashUptimeMeta')) $('dashUptimeMeta').textContent = Number.isFinite(uptime) ? 'Server uptime' : 'No activity data';
  scheduleDashboardMasonry();
}

async function loadDashboard() {
  try {
    const data = await request('/api/local/dashboard'); const summary = data.summary || {}; $('dashOnline').textContent = summary.online ?? 0; $('dashCapacity').textContent = `of ${data.server?.maximumPlayers ?? '—'}`; $('dashAlerts').textContent = summary.unreadAlerts ?? 0; $('dashAttention').textContent = safeNumber(summary.lowFood); $('dashSessions').textContent = summary.sessions24h ?? 0; $('dashDeaths').textContent = `${summary.deaths24h ?? 0} deaths`; $('dashActions').textContent = summary.actions24h ?? 0;
    renderDashboardTelemetry(data.telemetry || {});
    renderRuntimeMetricsStatus(data.pluginMetrics || {}, Boolean(data.metricsAvailable));
    const liveMeta = data.livePlayers || {};
    state.livePlayersRevision = Math.max(state.livePlayersRevision, safeNumber(liveMeta.revision, -1));
    state.livePlayersUpdatedAt = Math.max(state.livePlayersUpdatedAt, safeNumber(liveMeta.updatedAt, 0));
    renderDashboardOnlinePlayers(data.players || []);
    state.places = data.places || state.places; renderPlacesInSelects(); renderAlerts(data.alerts || []); renderRecentSessions(data.sessions || []);
  } catch (error) { renderRuntimeMetricsStatus({}, false); if (state.view === 'dashboard') toast(error.message, true); }
}

function dashboardCoordinate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return Math.abs(number - Math.round(number)) < 0.01 ? String(Math.round(number)) : number.toFixed(1);
}
function dashboardPlayerLocation(player) {
  const location = player?.location && typeof player.location === 'object' ? player.location : {};
  const world = player?.world || location.world || 'Unknown world';
  const x = player?.x ?? location.x;
  const y = player?.y ?? location.y;
  const z = player?.z ?? location.z;
  return { world, coordinates: `${dashboardCoordinate(x)}, ${dashboardCoordinate(y)}, ${dashboardCoordinate(z)}` };
}
async function openDashboardPlayer(uuid) {
  if (!uuid || !hasPermission('players.view')) return;
  setView('players');
  await selectPlayer(uuid);
  window.requestAnimationFrame(() => $('playerView')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}
function renderDashboardOnlinePlayers(players) {
  const list = $('dashboardOnlinePlayers');
  if (!list) return;
  const onlinePlayers = (Array.isArray(players) ? players : []).filter((player) => player && player.online !== false);
  list.textContent = '';
  const count = onlinePlayers.length;
  if ($('dashboardOnlinePlayersCount')) $('dashboardOnlinePlayersCount').textContent = `${count} connected${count === 1 ? '' : 's'}`;
  show($('emptyDashboardOnlinePlayers'), count === 0);
  const canOpen = hasPermission('players.view');
  for (const rawPlayer of onlinePlayers) {
    const player = normalizePlayer(rawPlayer);
    const row = document.createElement(canOpen ? 'button' : 'article');
    row.className = `dashboard-player-row${canOpen ? ' is-clickable' : ''}`;
    if (canOpen) {
      row.type = 'button';
      row.title = `Open profile for ${playerName(player)}`;
      row.addEventListener('click', () => openDashboardPlayer(player.uuid));
    } else {
      row.setAttribute('aria-disabled', 'true');
      row.title = 'You do not have permission to open player profiles';
    }

    const avatar = document.createElement('span'); avatar.className = 'dashboard-player-avatar'; fillAvatar(avatar, player);
    const identity = document.createElement('span'); identity.className = 'dashboard-player-identity';
    const name = document.createElement('strong'); name.textContent = playerName(player);
    const world = document.createElement('small'); world.textContent = player.world || player.location?.world || 'Unknown world';
    identity.append(name, world);

    const health = document.createElement('span'); health.className = 'dashboard-player-value dashboard-player-health';
    const healthLabel = document.createElement('small'); healthLabel.textContent = 'Salud';
    const healthValue = document.createElement('strong'); healthValue.textContent = `${player.health ?? '—'} / ${player.maxHealth ?? 20}`;
    health.append(healthLabel, healthValue);

    const food = document.createElement('span'); food.className = 'dashboard-player-value dashboard-player-food';
    const foodLabel = document.createElement('small'); foodLabel.textContent = 'Alimento';
    const foodValue = document.createElement('strong'); foodValue.textContent = `${player.food ?? '—'} / 20`;
    food.append(foodLabel, foodValue);

    const location = dashboardPlayerLocation(player);
    const position = document.createElement('span'); position.className = 'dashboard-player-value dashboard-player-position';
    const positionLabel = document.createElement('small'); positionLabel.textContent = 'Position';
    const positionValue = document.createElement('strong'); positionValue.textContent = location.coordinates;
    position.append(positionLabel, positionValue);

    row.append(avatar, identity, health, food, position);
    list.append(row);
  }
  scheduleDashboardMasonry();
}

function renderLiveSelectedPlayer(player) {
  if (!player || !state.selectedUuid || String(player.uuid || '') !== String(state.selectedUuid)) return;
  const wasOnline = Boolean(state.details?.online);
  state.details = { ...(state.details || {}), ...player, online: true };
  if (!wasOnline) {
    renderDetails(state.details);
    return;
  }
  const p = state.details;
  $('onlineBadge').textContent = 'Online'; $('onlineBadge').className = 'badge online-badge';
  $('worldBadge').textContent = p.world || p.location?.world || '—';
  $('healthStat').textContent = `${p.health ?? '—'} / ${p.maxHealth ?? '—'}`;
  $('healthMeter').style.width = `${Math.min(100, safeNumber(p.health) / Math.max(1, safeNumber(p.maxHealth, 20)) * 100)}%`;
  $('foodStat').textContent = `${p.food ?? '—'} / 20`;
  $('foodMeter').style.width = `${Math.min(100, safeNumber(p.food) / 20 * 100)}%`;
  const loc = p.location || {};
  $('positionStat').textContent = `${p.x ?? loc.x ?? '—'}, ${p.y ?? loc.y ?? '—'}, ${p.z ?? loc.z ?? '—'}`;
  $('orientationStat').textContent = `Yaw ${loc.yaw ?? '—'} · Pitch ${loc.pitch ?? '—'}`;
  $('onlineDetail').textContent = 'Online';
  setOnlineControls(true);
}

function applyLivePlayers(payload) {
  if (!payload || !Array.isArray(payload.players)) return;
  const revision = safeNumber(payload.revision, 0);
  const updatedAt = safeNumber(payload.updatedAt, 0);
  const sequenceRestarted = revision < state.livePlayersRevision && updatedAt > state.livePlayersUpdatedAt;
  if (!sequenceRestarted && revision < state.livePlayersRevision) return;
  if (!sequenceRestarted && revision === state.livePlayersRevision && updatedAt <= state.livePlayersUpdatedAt) return;
  state.livePlayersRevision = revision;
  state.livePlayersUpdatedAt = Math.max(updatedAt, state.livePlayersUpdatedAt);

  const livePlayers = payload.players.map(normalizePlayer).filter((player) => player.uuid);
  const liveByUuid = new Map(livePlayers.map((player) => [String(player.uuid), player]));
  const existingByUuid = new Map(state.players.filter((player) => player.uuid).map((player) => [String(player.uuid), player]));
  const merged = [];
  for (const existing of state.players) {
    const uuid = String(existing.uuid || '');
    if (!uuid) { merged.push(existing); continue; }
    const live = liveByUuid.get(uuid);
    if (live) merged.push({ ...existing, ...live, online: true });
    else merged.push(existing.online ? { ...existing, online: false } : existing);
  }
  for (const live of livePlayers) if (!existingByUuid.has(String(live.uuid))) merged.push({ ...live, online: true });
  state.players = merged;
  state.server = { ...(state.server || {}), onlinePlayers: livePlayers.length };

  if ($('dashOnline')) $('dashOnline').textContent = livePlayers.length;
  if ($('dashAttention')) $('dashAttention').textContent = livePlayers.filter((player) => safeNumber(player.food, 20) <= 6).length;
  if ($('serverSubtitle') && $('apiStatus')?.classList.contains('online')) {
    $('serverSubtitle').textContent = `${state.server.minecraftVersion || '26.1.2'} · ${livePlayers.length}/${state.server.maximumPlayers ?? '—'} online`;
  }
  renderDashboardOnlinePlayers(livePlayers);
  if (state.view === 'players') { renderPlayers(); renderBulkPlayers(); }

  if (state.selectedUuid) {
    const selected = liveByUuid.get(String(state.selectedUuid));
    if (selected) renderLiveSelectedPlayer(selected);
    else if (state.details?.online) {
      state.details = { ...state.details, online: false };
      renderDetails(state.details);
    }
  }
}

function renderAlerts(alerts) {
  state.alerts = alerts; const list = $('alertsList'); list.textContent = ''; show($('emptyAlerts'), alerts.length === 0);
  for (const alert of alerts) { const row = document.createElement('div'); const severity = String(alert.severity || 'info').toLowerCase(); row.className = `timeline-item timeline-${severity}`; row.innerHTML = `<span class="timeline-dot"></span><div class="timeline-main"><strong></strong><small></small></div><span class="timeline-time"></span>`; row.querySelector('strong').textContent = alert.title; row.querySelector('small').textContent = alert.message; row.querySelector('.timeline-time').textContent = formatDate(alert.ts); list.append(row); }
}
function renderRecentSessions(sessions) {
  const list = $('recentSessions'); list.textContent = ''; show($('emptySessions'), sessions.length === 0);
  for (const session of sessions) { const row = document.createElement('div'); row.className = 'timeline-item'; const duration = (session.left_at || Math.floor(Date.now() / 1000)) - session.joined_at; row.innerHTML = `<span class="timeline-dot"></span><div class="timeline-main"><strong></strong><small></small></div><span class="timeline-time"></span>`; row.querySelector('strong').textContent = session.player_name; row.querySelector('small').textContent = `${session.left_at ? 'Session ended' : 'Connected'} · ${formatDuration(duration)} · ${session.world || '—'}`; row.querySelector('.timeline-time').textContent = formatDate(session.joined_at); list.append(row); }
}

function runtimeMetricsPresentation(metrics, available = true) {
  if (!available) return { state: 'UNAVAILABLE', label: 'Unavailable', meta: 'No connection to Fabric metrics', className: 'unavailable' };
  const stateName = String(metrics?.state || '').trim().toUpperCase();
  if (stateName === 'PAUSED_EMPTY') return { state: 'Server paused', label: 'Paused', meta: 'Server paused · server empty', className: 'paused' };
  if (stateName === 'RUNNING') return { state: stateName, label: 'Active', meta: 'RUNNING · normal collection', className: 'running' };
  if (stateName === 'STARTING') return { state: stateName, label: 'Starting', meta: 'STARTING · waiting for the first ticks', className: 'starting' };
  return { state: stateName || 'UNKNOWN', label: 'Unknown', meta: `${stateName || 'UNKNOWN'} · unrecognized state`, className: 'unknown' };
}
function renderRuntimeMetricsStatus(metrics, available = true) {
  const presentation = runtimeMetricsPresentation(metrics, available);
  if ($('dashMetricsState')) $('dashMetricsState').textContent = presentation.label;
  if ($('dashMetricsMeta')) $('dashMetricsMeta').textContent = presentation.meta;
  if ($('dashMetricsCard')) {
    $('dashMetricsCard').classList.remove('metrics-running', 'metrics-paused', 'metrics-starting', 'metrics-unavailable', 'metrics-unknown');
    $('dashMetricsCard').classList.add(`metrics-${presentation.className}`);
  }
  const box = $('metricsRuntimeBox');
  if (box) {
    box.classList.remove('running', 'paused', 'starting', 'unavailable', 'unknown');
    box.classList.add(presentation.className);
  }
  if ($('metricsRuntimeState')) $('metricsRuntimeState').textContent = presentation.state;
  if ($('metricsRuntimeMeta')) $('metricsRuntimeMeta').textContent = presentation.meta.replace(`${presentation.state} · `, '');
}
function findMetric(object, keys) {
  if (!object || typeof object !== 'object') return undefined;
  for (const key of keys) if (object[key] !== undefined && object[key] !== null) return object[key];
  for (const value of Object.values(object)) { if (value && typeof value === 'object' && !Array.isArray(value)) { const found = findMetric(value, keys); if (found !== undefined) return found; } }
  return undefined;
}
function craftyIsRunning(stats) {
  const raw = findMetric(stats, ['running', 'server_running']);
  if (typeof raw === 'boolean') return raw;
  return ['true', 'running', 'online', 'started'].includes(String(raw || '').toLowerCase());
}
function craftyProcessLabel(crafty) {
  if (!crafty?.configured) return ['Not configured', 'unknown'];
  if (!crafty?.available) return ['Offline', 'offline'];
  const stats = crafty.stats || {};
  if (findMetric(stats, ['updating'])) return ['Updating', 'busy'];
  if (findMetric(stats, ['waiting_start'])) return ['Starting', 'busy'];
  if (findMetric(stats, ['crashed'])) return ['Failed', 'error'];
  if (craftyIsRunning(stats)) return ['Running', 'online'];
  return ['Stopped', 'offline'];
}
function formatCraftyPercent(value) {
  if (value === undefined || value === null || value === '') return '—';
  const number = Number(value); return Number.isFinite(number) ? `${number.toFixed(number >= 10 ? 0 : 1)}%` : String(value);
}
function formatCraftyMemory(stats) {
  const raw = findMetric(stats, ['mem', 'memory', 'memory_usage', 'memory_used', 'mem_usage']);
  return formatBytes(raw);
}
function parseCraftyTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (Number.isFinite(Number(value)) && String(value).trim() !== '') {
    const number = Number(value);
    const milliseconds = Math.abs(number) >= 100000000000 ? number : number * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  let text = String(value).trim();
  // Crafty returns start_time without timezone, but the value is UTC.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) {
    text = `${text.replace(' ', 'T')}Z`;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}
function craftyStartedDate(stats) {
  return parseCraftyTimestamp(findMetric(stats, ['started', 'start_time', 'started_at', 'start_date']));
}
function craftyDerivedUptime(stats) {
  const started = craftyStartedDate(stats);
  if (!started || !craftyIsRunning(stats)) return null;
  const seconds = Math.floor((Date.now() - started.getTime()) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
function formatCraftyUptime(stats) {
  const derived = craftyDerivedUptime(stats);
  const direct = findMetric(stats, ['uptime', 'up_time']);
  if (direct !== undefined && direct !== null && direct !== '') {
    const numeric = Number(direct);
    if (Number.isFinite(numeric)) {
      // Some Crafty responses report uptime=0 while start_time is valid.
      if (numeric <= 0 && derived !== null) return formatDuration(derived);
      return formatDuration(numeric);
    }
    if (derived === null) return String(direct);
  }
  return derived === null ? '—' : formatDuration(derived);
}
function formatCraftyStarted(stats) {
  const started = craftyStartedDate(stats);
  if (!started) return 'No start time';
  return `Since ${panelDateTimeFormat( { dateStyle: 'short', timeStyle: 'medium' }).format(started)}`;
}
function setCraftyButtons(crafty) {
  const running = craftyIsRunning(crafty?.stats || {});
  const available = Boolean(crafty?.configured && crafty?.available);
  $('serverStartBtn').disabled = !available || running;
  $('serverStopBtn').disabled = !available || !running;
  $('serverRestartBtn').disabled = !available || !running;
  $('serverBackupBtn').disabled = !available;
}
function renderCraftyBackups(backups) {
  const list = $('craftyBackups'); list.textContent = ''; const items = Array.isArray(backups) ? backups : [];
  show($('emptyCraftyBackups'), items.length === 0);
  for (const backup of items) {
    const row = document.createElement('div'); row.className = 'backup-row';
    const info = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = backup.backup_name || backup.name || `Backup ${backup.backup_id || ''}`.trim();
    const details = document.createElement('small');
    const parts = [];
    if (backup.backup_type) parts.push(String(backup.backup_type));
    if (backup.max_backups !== undefined) parts.push(`maximum ${backup.max_backups}`);
    if (backup.shutdown !== undefined) parts.push(backup.shutdown ? 'stops the server' : 'without stopping');
    details.textContent = parts.join(' · ') || 'Backup configuration';
    info.append(title, details);
    const badge = document.createElement('span'); badge.className = 'backup-badge'; badge.textContent = backup.default ? 'Default' : 'Configured';
    row.append(info, badge); list.append(row);
  }
}
function renderDashboardCraftyTelemetry(crafty) {
  const stats = crafty?.stats && typeof crafty.stats === 'object' ? crafty.stats : {};
  const rawMemory = findMetric(stats, ['mem', 'memory', 'memory_usage', 'memory_used', 'mem_usage']);
  const memoryPercent = Number(findMetric(stats, ['mem_percent', 'memory_percent']));
  const formattedMemory = formatCraftyMemory(stats);
  if ($('dashMemory') && formattedMemory !== '—') $('dashMemory').textContent = formattedMemory;
  if ($('dashMemoryMeta') && (formattedMemory !== '—' || Number.isFinite(memoryPercent))) {
    const parts = [];
    if (Number.isFinite(memoryPercent)) parts.push(`Usage: ${memoryPercent.toFixed(memoryPercent >= 10 ? 0 : 1)}%`);
    if (crafty?.stale) parts.push('last available sample');
    $('dashMemoryMeta').textContent = parts.join(' · ') || dashboardMetricTimestamp({ updatedAt: crafty?.updatedAt });
  }
  scheduleDashboardMasonry();
}

async function loadDashboardCraftyTelemetry(options = {}) {
  try {
    const suffix = options.force ? '?force=1' : '';
    const data = await request(`/api/local/crafty/server${suffix}`);
    const crafty = data.crafty || {};
    renderDashboardCraftyTelemetry(crafty);
    return crafty;
  } catch (error) {
    if (!options.silent && state.view === 'dashboard') toast(error.message, true);
    return null;
  }
}

function renderCraftyServer(crafty) {
  const previous = state.crafty && typeof state.crafty === 'object' ? state.crafty : {};
  state.crafty = { ...previous, ...(crafty || {}) };
  if (previous.logs && !(crafty || {}).logs) state.crafty.logs = previous.logs;
  if (previous.backups && !(crafty || {}).backups) state.crafty.backups = previous.backups;
  const [label, className] = craftyProcessLabel(state.crafty);
  const pill = $('craftyProcessState'); pill.textContent = label; pill.className = `process-pill ${className}`;
  const stats = state.crafty.stats || {}; const server = state.crafty.server || {};
  $('craftyServerName').textContent = server.server_name || findMetric(stats, ['server_name', 'world_name']) || 'Server Minecraft';
  $('craftyServerDescription').textContent = state.crafty.available
    ? `${findMetric(stats, ['desc']) || 'Server managed by Crafty'}${findMetric(stats, ['world_name']) ? ` · ${findMetric(stats, ['world_name'])}` : ''}`
    : (state.crafty.message || 'Crafty is unavailable');
  const updatedAt = safeNumber(state.crafty.updatedAt); const updatedDate = updatedAt ? new Date(updatedAt * 1000) : new Date();
  $('craftyLastUpdate').textContent = `${state.crafty.stale ? 'Last sample' : 'Updated'}: ${panelDateTimeFormat( { timeStyle: 'medium' }).format(updatedDate)}${state.crafty.refreshing ? ' · refreshing…' : ''}`;
  $('serverCpu').textContent = formatCraftyPercent(findMetric(stats, ['cpu', 'cpu_usage', 'cpu_percent']));
  $('serverRam').textContent = formatCraftyMemory(stats);
  $('serverRamPercent').textContent = `Usage: ${formatCraftyPercent(findMetric(stats, ['mem_percent', 'memory_percent']))}`;
  $('serverUptime').textContent = formatCraftyUptime(stats);
  $('serverStarted').textContent = formatCraftyStarted(stats);
  $('serverPlayers').textContent = `${findMetric(stats, ['online']) ?? 0} / ${findMetric(stats, ['max', 'max_players']) ?? '—'}`;
  $('serverVersion').textContent = String(findMetric(stats, ['version']) ?? server.version ?? '—');
  $('serverWorldSize').textContent = findMetric(stats, ['world_size']) ? `World: ${findMetric(stats, ['world_size'])}` : 'Size unavailable';
  $('serverPort').textContent = String(findMetric(stats, ['server_port', 'port']) ?? server.server_port ?? '—');
  $('serverAddress').textContent = server.server_ip ? `${server.server_ip}:${server.server_port || ''}`.replace(/:$/, '') : 'Internal Crafty';
  const logs = Array.isArray(state.crafty.logs) ? state.crafty.logs : [];
  $('craftyLogs').textContent = logs.length ? logs.join('\n') : (state.crafty.logsAvailable === false ? 'The user does not have permission to read logs.' : 'No logs are available.');
  if ($('autoScrollCrafty').checked) $('craftyLogs').scrollTop = $('craftyLogs').scrollHeight;
  renderCraftyBackups(state.crafty.backups || []);
  const link = $('craftyOpenServerLink'); show(link, Boolean(state.crafty.panelUrl)); if (state.crafty.panelUrl) link.href = state.crafty.panelUrl;
  setCraftyButtons(state.crafty);
}
async function loadCraftyServer(options = {}) {
  if (state.craftyLoading && !options.force) return state.crafty;
  state.craftyLoading = true;
  try {
    const suffix = options.force ? '?force=1' : '';
    const data = await request(`/api/local/crafty/server${suffix}`);
    renderCraftyServer(data.crafty || {});
    return state.crafty;
  } catch (error) {
    if (!state.crafty?.stats) renderCraftyServer({ configured: true, available: false, message: error.message });
    if (!options.silent && state.view === 'server') toast(error.message, true);
    return state.crafty;
  } finally { state.craftyLoading = false; }
}
async function loadCraftyLogs(options = {}) {
  try {
    const data = await request('/api/local/crafty/logs?limit=200'); state.crafty.logs = data.logs || []; state.crafty.logsAvailable = true; renderCraftyServer(state.crafty);
  } catch (error) { if (!options.silent) toast(error.message, true); }
}
async function loadCraftyBackups(options = {}) {
  try {
    const data = await request('/api/local/crafty/backups'); state.crafty.backups = data.backups || []; state.crafty.backupsAvailable = true; renderCraftyServer(state.crafty);
  } catch (error) { if (!options.silent) toast(error.message, true); }
}
async function runCraftyAction(actionName) {
  const labels = { start_server: 'start', stop_server: 'stop', restart_server: 'restart', backup_server: 'create a backup of' };
  const dangerous = ['stop_server', 'restart_server'];
  if ((dangerous.includes(actionName) || actionName === 'backup_server') && !confirm(`Do you want to ${labels[actionName]} the server?`)) return;
  const buttons = ['serverStartBtn', 'serverStopBtn', 'serverRestartBtn', 'serverBackupBtn']; buttons.forEach((id) => { $(id).disabled = true; });
  try {
    const data = await request('/api/local/crafty/action', { method: 'POST', body: JSON.stringify({ action: actionName }) });
    toast(data.message || 'Action sent to Crafty');
    setTimeout(() => loadCraftyServer({ force: true }), actionName === 'backup_server' ? 1200 : 2500);
  } catch (error) { toast(error.message, true); setCraftyButtons(state.crafty); }
}
function metricPercent(value) {
  const number = Number(value); return Number.isFinite(number) ? `${number.toFixed(number >= 10 ? 0 : 1)}%` : '—';
}
function metricBucketForHours(hours) {
  if (hours <= 1) return 60;
  if (hours <= 6) return 300;
  if (hours <= 24) return 600;
  if (hours <= 168) return 3600;
  return 14400;
}
function svgNode(name, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}
function formatMetricAxisTime(timestamp, rangeHours) {
  const date = new Date(Number(timestamp) * 1000);
  if (rangeHours <= 24) {
    return panelDateTimeFormat( { hour: 'numeric', minute: '2-digit' }).format(date);
  }
  if (rangeHours <= 168) {
    return panelDateTimeFormat( { day: 'numeric', month: 'short', hour: 'numeric' }).format(date);
  }
  return panelDateTimeFormat( { day: 'numeric', month: 'short' }).format(date);
}
function renderMetricChart(svgId, emptyId, points, key, options = {}) {
  const svg = $(svgId); const empty = $(emptyId); svg.textContent = '';
  const chartPoints = points.filter((point) => point[key] !== null && point[key] !== undefined && Number.isFinite(Number(point[key])));
  const values = chartPoints.map((point) => Number(point[key]));
  show(empty, values.length < 2); show(svg, values.length >= 2);
  if (values.length < 2) return;

  const width = 720; const height = 270; const pad = { left: 68, right: 28, top: 24, bottom: 44 };
  const plotW = width - pad.left - pad.right; const plotH = height - pad.top - pad.bottom;
  const rawMin = options.min ?? Math.min(...values); const rawMax = options.max ?? Math.max(...values);
  let min = Number.isFinite(rawMin) ? rawMin : 0;
  let max = Math.max(min + 1, Number.isFinite(rawMax) ? rawMax : 1);
  const formatValue = options.format || ((value) => String(Math.round(value)));
  let ticks = [];

  if (options.integerScale) {
    min = Math.floor(min);
    max = Math.max(min + 1, Math.ceil(max));
    const step = Math.max(1, Math.ceil((max - min) / 4));
    max = Math.ceil(max / step) * step;
    for (let value = max; value >= min; value -= step) ticks.push(value);
    if (ticks.at(-1) !== min) ticks.push(min);
  } else {
    for (let i = 0; i <= 4; i += 1) ticks.push(max - ((max - min) * i / 4));
  }

  const yAt = (value) => pad.top + plotH - ((Number(value) - min) / (max - min)) * plotH;
  for (const value of ticks) {
    const y = yAt(value);
    svg.append(svgNode('line', { x1: pad.left, y1: y, x2: width - pad.right, y2: y, class: 'chart-grid-line' }));
    const label = svgNode('text', { x: pad.left - 11, y: y + 4, class: 'chart-axis-label', 'text-anchor': 'end' });
    label.textContent = formatValue(value); svg.append(label);
  }

  const xAt = (index) => pad.left + (plotW * index / Math.max(1, chartPoints.length - 1));
  const coords = chartPoints.map((point, index) => [xAt(index), yAt(Number(point[key]))]).filter(([, y]) => Number.isFinite(y));
  if (coords.length < 2) return;
  const linePath = coords.map(([x, y], index) => `${index ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const areaPath = `${linePath} L ${coords.at(-1)[0].toFixed(2)} ${(pad.top + plotH).toFixed(2)} L ${coords[0][0].toFixed(2)} ${(pad.top + plotH).toFixed(2)} Z`;
  svg.append(svgNode('path', { d: areaPath, class: `chart-area ${options.className || ''}` }));
  svg.append(svgNode('path', { d: linePath, class: `chart-line ${options.className || ''}` }));

  const labels = [0, Math.floor((chartPoints.length - 1) / 2), chartPoints.length - 1];
  for (const index of [...new Set(labels)]) {
    const text = svgNode('text', {
      x: xAt(index), y: height - 13, class: 'chart-axis-label',
      'text-anchor': index === 0 ? 'start' : index === chartPoints.length - 1 ? 'end' : 'middle'
    });
    text.textContent = formatMetricAxisTime(chartPoints[index].bucket_ts, Number(options.rangeHours || 24));
    svg.append(text);
  }
}
function formatTps(value) {
  const number = Number(value); return Number.isFinite(number) ? number.toFixed(2) : '—';
}
function syncMetricRuleControls() {
  const rules = [
    ['metricCpuEnabled', ['metricCpuThreshold', 'metricCpuDuration']],
    ['metricMemoryEnabled', ['metricMemoryThreshold', 'metricMemoryDuration']],
    ['metricTpsEnabled', ['metricTpsThreshold', 'metricTpsDuration']],
    ['metricStorageEnabled', ['metricStorageThreshold', 'metricStorageDuration']],
    ['serverDownEnabled', ['serverDownDelay']],
  ];
  for (const [toggleId, fieldIds] of rules) {
    const enabled = Boolean($(toggleId)?.checked);
    fieldIds.forEach((id) => { if ($(id)) $(id).disabled = !enabled; });
    $(toggleId)?.closest('.alert-rule-card')?.classList.toggle('rule-disabled', !enabled);
  }
}
function renderMetrics(data) {
  state.metrics = data; const summary = data.summary || {}; const points = data.points || []; const settings = data.settings || {};
  renderRuntimeMetricsStatus(data.runtime || {}, Boolean(data.runtimeAvailable));
  $('metricsAvgCpu').textContent = metricPercent(summary.avg_cpu); $('metricsMaxCpu').textContent = `Maximum ${metricPercent(summary.max_cpu)}`;
  $('metricsAvgMemory').textContent = formatBytes(summary.avg_memory_bytes); $('metricsMaxMemory').textContent = `Maximum ${formatBytes(summary.max_memory_bytes)}`;
  $('metricsAvgTps').textContent = formatTps(summary.avg_tps); $('metricsMinTps').textContent = `Minimum ${formatTps(summary.min_tps)}`;
  for (const [element, value] of [[$('metricsAvgTps'), Number(summary.avg_tps)], [$('metricsMinTps'), Number(summary.min_tps)]]) {
    if (!element) continue;
    element.classList.remove('tps-good', 'tps-warning', 'tps-bad', 'tps-unknown');
    element.classList.add(Number.isFinite(value) ? (value >= 18 ? 'tps-good' : (value >= 15 ? 'tps-warning' : 'tps-bad')) : 'tps-unknown');
  }
  $('metricsStorage').textContent = metricPercent(summary.max_storage_percent ?? summary.avg_storage_percent); $('metricsStorageFree').textContent = `Libre ${formatBytes(summary.min_storage_free_bytes)}`;
  const avgPlayers = Number(summary.avg_players); $('metricsAvgPlayers').textContent = Number.isFinite(avgPlayers) ? avgPlayers.toFixed(avgPlayers >= 10 ? 0 : 1) : '—'; $('metricsPeakPlayers').textContent = `Pico ${summary.peak_players ?? '—'}`;
  $('metricsServerAvailability').textContent = metricPercent(summary.serverAvailabilityPercent); $('metricsApiAvailability').textContent = metricPercent(summary.apiAvailabilityPercent);
  $('metricsSamples').textContent = summary.samples ?? 0; $('metricsRetention').textContent = `Retention: ${data.retentionDays || 30} days`;

  $('metricCpuEnabled').checked = Boolean(settings.highCpuEnabled); $('metricCpuThreshold').value = settings.highCpuThreshold ?? 85; $('metricCpuDuration').value = String(settings.highCpuDurationSeconds ?? 120);
  $('metricMemoryEnabled').checked = Boolean(settings.highMemoryEnabled); $('metricMemoryThreshold').value = settings.highMemoryThreshold ?? 90; $('metricMemoryDuration').value = String(settings.highMemoryDurationSeconds ?? 120);
  $('metricTpsEnabled').checked = Boolean(settings.lowTpsEnabled); $('metricTpsThreshold').value = settings.lowTpsThreshold ?? 17; $('metricTpsDuration').value = String(settings.lowTpsDurationSeconds ?? 60);
  $('metricStorageEnabled').checked = Boolean(settings.highStorageEnabled); $('metricStorageThreshold').value = settings.highStorageThreshold ?? 90; $('metricStorageDuration').value = String(settings.highStorageDurationSeconds ?? 300);
  $('serverDownEnabled').checked = Boolean(settings.serverDownEnabled); $('serverDownDelay').value = String(settings.serverDownDelaySeconds ?? 30);
  $('metricRecoveryEnabled').checked = Boolean(settings.recoveryAlertsEnabled); $('metricAlertCooldown').value = String(settings.alertCooldownSeconds ?? 900);
  syncMetricRuleControls();

  const hours = Number(data.hours || 24);
  renderMetricChart('cpuChart', 'cpuChartEmpty', points, 'cpu_percent', { min: 0, max: Math.max(100, ...points.map((p) => Number(p.cpu_percent) || 0)), format: (v) => `${Math.round(v)}%`, className: 'cpu-series', rangeHours: hours });
  renderMetricChart('memoryChart', 'memoryChartEmpty', points, 'memory_bytes', { min: 0, format: (v) => formatBytes(v).replace(/\s/g, ''), className: 'memory-series', rangeHours: hours });
  renderMetricChart('playersChart', 'playersChartEmpty', points, 'online_players', { min: 0, max: Math.max(1, ...points.map((p) => Number(p.peak_players || p.online_players) || 0)), format: (v) => String(Math.round(v)), className: 'players-series', integerScale: true, rangeHours: hours });
}
async function loadMetrics(force = false) {
  if (!hasPermission('metrics.view')) return;
  if (!force && Date.now() - state.metricsLastLoad < 30000) return;
  state.metricsLastLoad = Date.now();
  try {
    const hours = Number($('metricsRange')?.value || 24); const bucket = metricBucketForHours(hours);
    const data = await request(`/api/local/metrics?hours=${hours}&bucket=${bucket}`); renderMetrics(data);
  } catch (error) { toast(error.message, true); }
}
async function saveMetricSettings() {
  try {
    const body = {
      highCpuEnabled: $('metricCpuEnabled').checked, highCpuThreshold: Number($('metricCpuThreshold').value), highCpuDurationSeconds: Number($('metricCpuDuration').value),
      highMemoryEnabled: $('metricMemoryEnabled').checked, highMemoryThreshold: Number($('metricMemoryThreshold').value), highMemoryDurationSeconds: Number($('metricMemoryDuration').value),
      lowTpsEnabled: $('metricTpsEnabled').checked, lowTpsThreshold: Number($('metricTpsThreshold').value), lowTpsDurationSeconds: Number($('metricTpsDuration').value),
      highStorageEnabled: $('metricStorageEnabled').checked, highStorageThreshold: Number($('metricStorageThreshold').value), highStorageDurationSeconds: Number($('metricStorageDuration').value),
      serverDownEnabled: $('serverDownEnabled').checked, serverDownDelaySeconds: Number($('serverDownDelay').value),
      recoveryAlertsEnabled: $('metricRecoveryEnabled').checked, alertCooldownSeconds: Number($('metricAlertCooldown').value),
    };
    await request('/api/local/metrics/settings', { method: 'POST', body: JSON.stringify(body) }); toast('Alert rules saved'); await loadMetrics(true);
  } catch (error) { toast(error.message, true); }
}

function selectedBulkUuids() { return [...$('bulkPlayers').querySelectorAll('input:checked')].map((input) => input.value); }
function updateBulkSelectionCount() {
  const selected = selectedBulkUuids().length;
  const online = state.players.filter((player) => player.online).length;
  $('bulkSelectedCount').textContent = `${selected} selected out of ${online}`;
  $('runBulkBtn').disabled = selected === 0 || online === 0;
}
function renderBulkPlayers() {
  const container = $('bulkPlayers');
  const checked = new Set([...container.querySelectorAll('input:checked')].map((input) => input.value));
  container.textContent = '';
  const onlinePlayers = state.players.filter((player) => player.online);
  if (!onlinePlayers.length) {
    container.innerHTML = '<div class="empty compact">No players are online.</div>';
    updateBulkSelectionCount();
    return;
  }
  for (const player of onlinePlayers) {
    const label = document.createElement('label'); label.className = 'check-player';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = player.uuid; input.checked = checked.has(player.uuid);
    input.addEventListener('change', updateBulkSelectionCount);
    const avatar = document.createElement('span'); avatar.className = 'bulk-player-avatar'; fillAvatar(avatar, player);
    const span = document.createElement('span'); span.textContent = playerName(player);
    label.append(input, avatar, span); container.append(label);
  }
  updateBulkSelectionCount();
}
function updateBulkFields() {
  const actionName = $('bulkAction').value;
  show($('bulkGamemodeWrap'), actionName === 'gamemode');
  show($('bulkPlaceWrap'), actionName === 'teleport');
  show($('bulkReasonWrap'), actionName === 'kick');
}
function openBulkActionsDialog() {
  renderBulkPlayers(); renderPlacesInSelects(); updateBulkFields();
  $('bulkResult').textContent = '';
  const dialog = $('bulkActionsDialog');
  if (!dialog.open) dialog.showModal();
}
function closeBulkActionsDialog() { if ($('bulkActionsDialog').open) $('bulkActionsDialog').close(); }
function setAllBulkPlayers(checked) {
  $('bulkPlayers').querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = checked; });
  updateBulkSelectionCount();
}
async function runBulkAction() {
  const uuids = selectedBulkUuids();
  if (!uuids.length) return toast('Select at least one player', true);
  const actionName = $('bulkAction').value; const body = {};
  if (actionName === 'gamemode') body.gamemode = $('bulkGamemode').value;
  if (actionName === 'teleport') {
    const place = state.places.find((item) => String(item.id) === $('bulkPlace').value);
    if (!place) return toast('Select a saved location', true);
    Object.assign(body, { world: place.world, x: place.x, y: place.y, z: place.z, yaw: place.yaw, pitch: place.pitch });
  }
  if (actionName === 'kick') {
    body.reason = $('bulkReason').value.trim() || 'Disconnected by an administrator';
    if (!confirm(`Kick ${uuids.length} player(s)?`)) return;
  }
  $('runBulkBtn').disabled = true; $('bulkResult').textContent = 'Running actions…';
  try {
    const data = await request('/api/local/bulk', { method: 'POST', body: JSON.stringify({ action: actionName, uuids, body }) });
    const message = `${data.successCount}/${data.total} actions completed`;
    $('bulkResult').textContent = message; toast(message, data.successCount !== data.total);
    await refreshAll();
    renderBulkPlayers();
  } catch (error) { $('bulkResult').textContent = error.message; toast(error.message, true); }
  finally { updateBulkSelectionCount(); }
}

async function loadPlaces() { try { const data = await request('/api/local/places'); state.places = data.places || []; renderPlaces(); renderPlacesInSelects(); } catch (error) { toast(error.message, true); } }
function renderPlacesInSelects() {
  for (const id of ['bulkPlace', 'playerPlaceSelect']) { const select = $(id); const previous = select.value; select.textContent = ''; const blank = document.createElement('option'); blank.value = ''; blank.textContent = state.places.length ? 'Select a location' : 'No saved locations'; select.append(blank); for (const place of state.places) { const option = document.createElement('option'); option.value = String(place.id); option.textContent = `${place.name} · ${place.world}`; select.append(option); } if ([...select.options].some((option) => option.value === previous)) select.value = previous; }
}
function placeWorldLabel(world) {
  const value = String(world || '').trim();
  if (!value) return 'World';
  const normalized = value.toLowerCase();
  if (normalized === 'world' || normalized.endsWith(':overworld')) return 'Overworld';
  if (normalized.includes('nether')) return 'Nether';
  if (normalized.includes('the_end') || normalized.endsWith(':end')) return 'The End';
  return value;
}
function placeWorldThumbClass(world) {
  const normalized = String(world || '').toLowerCase();
  if (normalized.includes('nether')) return 'place-thumb-nether';
  if (normalized.includes('the_end') || normalized.endsWith(':end')) return 'place-thumb-end';
  return '';
}
let placeThumbnailQueue = [];
let placeThumbnailActive = null;
let placeThumbnailGeneration = 0;

function squareMapThumbnailUrl(place, thumbId = '') {
  const config = currentSquareMapConfig?.();
  if (!mapProviderConfigured(config)) return '';
  try {
    const url = new URL(String(config.url || ''), window.location.href);
    const worldQuery = squareMapWorldQueryId(place?.world || config.worldId || url.searchParams.get('world') || '');
    if (worldQuery) url.searchParams.set('world', worldQuery);
    url.searchParams.set('panelThumb', '1');
    url.searchParams.set('thumbId', thumbId);
    url.searchParams.set('x', formatMapCoordinate(place?.x));
    url.searchParams.set('z', formatMapCoordinate(place?.z));
    url.searchParams.set('zoom', '4');
    return url.toString();
  } catch (_) {
    return '';
  }
}

function resetPlaceThumbnailQueue() {
  placeThumbnailGeneration += 1;
  placeThumbnailQueue = [];
  if (placeThumbnailActive) {
    window.clearTimeout(placeThumbnailActive.timeoutId);
    placeThumbnailActive.frame?.remove();
    placeThumbnailActive = null;
  }
  document.querySelectorAll('.place-thumb-capture-frame').forEach((frame) => frame.remove());
}

function finishActivePlaceThumbnail() {
  if (!placeThumbnailActive) return;
  window.clearTimeout(placeThumbnailActive.timeoutId);
  placeThumbnailActive.frame?.remove();
  placeThumbnailActive = null;
  window.setTimeout(startNextPlaceThumbnail, 30);
}

function startNextPlaceThumbnail() {
  if (placeThumbnailActive) return;
  while (placeThumbnailQueue.length) {
    const task = placeThumbnailQueue.shift();
    if (!task || task.generation !== placeThumbnailGeneration || !task.thumb?.isConnected) continue;
    const frame = document.createElement('iframe');
    frame.className = 'place-thumb-capture-frame';
    frame.loading = 'eager';
    frame.referrerPolicy = 'no-referrer';
    frame.tabIndex = -1;
    frame.dataset.thumbId = task.thumbId;
    frame.setAttribute('aria-hidden', 'true');
    frame.src = task.url;
    task.thumb.append(frame);
    placeThumbnailActive = {
      ...task,
      frame,
      timeoutId: window.setTimeout(() => finishActivePlaceThumbnail(), 7000)
    };
    return;
  }
}

function enqueuePlaceThumbnail(thumb, place) {
  const thumbId = `place-${place?.id || 'new'}-${Math.random().toString(36).slice(2, 9)}`;
  const url = squareMapThumbnailUrl(place, thumbId);
  if (!url) return;
  thumb.dataset.thumbId = thumbId;
  placeThumbnailQueue.push({ thumb, thumbId, url, generation: placeThumbnailGeneration });
}

function buildPlaceThumbnail(thumb, place) {
  thumb.textContent = '';
  thumb.classList.remove('place-thumb-live', 'place-thumb-ready');
  const placeholder = document.createElement('div');
  placeholder.className = 'place-thumb-placeholder';
  thumb.append(placeholder);
  enqueuePlaceThumbnail(thumb, place);
  const pin = document.createElement('span');
  pin.className = 'place-thumb-pin';
  thumb.append(pin);
}

function renderPlaceThumbnailSnapshot(thumb, data) {
  const imageDataUrl = String(data?.imageDataUrl || '').trim();
  if (!imageDataUrl.startsWith('data:image/')) return false;
  thumb.querySelector('.place-thumb-snapshot')?.remove();
  const snapshot = document.createElement('div');
  snapshot.className = 'place-thumb-snapshot';
  const image = document.createElement('img');
  image.alt = '';
  image.decoding = 'async';
  image.draggable = false;
  image.addEventListener('load', () => thumb.classList.add('place-thumb-ready'), { once: true });
  image.addEventListener('error', () => snapshot.remove(), { once: true });
  image.src = imageDataUrl;
  snapshot.append(image);
  thumb.insertBefore(snapshot, thumb.querySelector('.place-thumb-pin'));
  return true;
}

function handlePlaceThumbnailMessage(event) {
  const data = event.data;
  if (!data || data.channel !== 'player-panel-squaremap-thumbnail' || !data.thumbId) return;
  const active = placeThumbnailActive;
  if (!active || active.thumbId !== data.thumbId || event.source !== active.frame?.contentWindow) return;
  if (data.type === 'snapshot') renderPlaceThumbnailSnapshot(active.thumb, data);
  finishActivePlaceThumbnail();
}

function renderPlaces() {
  resetPlaceThumbnailQueue();
  const list = $('placesList'); list.textContent = ''; $('placesCount').textContent = `${state.places.length} guardados`; show($('emptyPlaces'), state.places.length === 0);
  for (const place of state.places) {
    const row = document.createElement('article'); row.className = 'place-row';

    const thumb = document.createElement('div');
    thumb.className = `place-thumb ${placeWorldThumbClass(place.world)}`.trim();
    buildPlaceThumbnail(thumb, place);

    const body = document.createElement('div'); body.className = 'place-card-body';
    const head = document.createElement('div'); head.className = 'place-card-head';
    const titleWrap = document.createElement('div'); titleWrap.className = 'place-card-title';
    const strong = document.createElement('strong'); strong.textContent = place.name;
    const worldPill = document.createElement('span'); worldPill.className = 'place-world-pill'; worldPill.textContent = placeWorldLabel(place.world);
    titleWrap.append(strong, worldPill);

    const actions = document.createElement('div'); actions.className = 'place-actions';
    const edit = document.createElement('button'); edit.className = 'ghost small-btn place-icon-btn'; edit.innerHTML = '<span class="btn-icon" aria-hidden="true">✎</span>'; edit.title = 'Edit'; edit.setAttribute('aria-label', 'Edit'); edit.addEventListener('click', () => editPlace(place));
    const use = document.createElement('button'); use.className = 'secondary small-btn place-icon-btn'; use.innerHTML = '<span class="btn-icon" aria-hidden="true">⌁</span>'; use.title = 'Teleport'; use.setAttribute('aria-label', 'Teleport'); use.disabled = !state.selectedUuid || !state.details?.online; use.addEventListener('click', () => teleportToPlace(place));
    const del = document.createElement('button'); del.className = 'danger-outline small-btn place-icon-btn'; del.innerHTML = '<span class="btn-icon" aria-hidden="true">🗑</span>'; del.title = 'Delete'; del.setAttribute('aria-label', 'Delete'); del.addEventListener('click', () => deletePlace(place));
    if (hasPermission('places.manage')) actions.append(edit);
    if (hasPermission('players.teleport')) actions.append(use);
    if (hasPermission('places.manage')) actions.append(del);
    head.append(titleWrap, actions);

    const coords = document.createElement('div'); coords.className = 'place-coordinate-line';
    [['X', place.x], ['Y', place.y], ['Z', place.z]].forEach(([axis, value]) => {
      const chip = document.createElement('span'); chip.className = 'place-coordinate-chip'; chip.innerHTML = `<span>${axis}</span><strong>${formatMapCoordinate(value)}</strong>`; coords.append(chip);
    });
    const meta = document.createElement('div'); meta.className = 'place-meta-line';
    meta.textContent = `Yaw ${formatMapCoordinate(place.yaw || 0)} · Pitch ${formatMapCoordinate(place.pitch || 0)}`;

    body.append(head, coords, meta);
    row.append(thumb, body);
    list.append(row);
  }
  startNextPlaceThumbnail();
}
function resetPlaceForm() { for (const id of ['placeId', 'placeName', 'placeX', 'placeY', 'placeZ']) $(id).value = ''; $('placeYaw').value = '0'; $('placePitch').value = '0'; if (worldNames().length) $('placeWorld').value = worldNames()[0]; }
function editPlace(place) { setView('places'); $('placeId').value = place.id; $('placeName').value = place.name; $('placeWorld').value = place.world; $('placeX').value = place.x; $('placeY').value = place.y; $('placeZ').value = place.z; $('placeYaw').value = place.yaw || 0; $('placePitch').value = place.pitch || 0; window.scrollTo({ top: 0, behavior: 'smooth' }); }
function releaseMobileFormFocus() {
  const active = document.activeElement;
  if (active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) active.blur();
}
async function savePlace() {
  releaseMobileFormFocus();
  const payload = { id: $('placeId').value || undefined, name: $('placeName').value.trim(), world: $('placeWorld').value, x: $('placeX').value, y: $('placeY').value, z: $('placeZ').value, yaw: $('placeYaw').value || 0, pitch: $('placePitch').value || 0 };
  try {
    const data = await request('/api/local/places/save', { method: 'POST', body: JSON.stringify(payload) });
    state.places = data.places || [];
    resetPlaceForm();
    releaseMobileFormFocus();
    renderPlaces();
    renderPlacesInSelects();
    toast('Location saved');
  }
  catch (error) { toast(error.message, true); }
}
async function deletePlace(place) { if (!confirm(`Delete the location "${place.name}"?`)) return; try { const data = await request('/api/local/places/delete', { method: 'POST', body: JSON.stringify({ id: place.id }) }); state.places = data.places || []; renderPlaces(); renderPlacesInSelects(); toast('Location deleted'); } catch (error) { toast(error.message, true); } }
async function teleportToPlace(place) { if (!state.selectedUuid) return toast('Select a player first', true); try { await action('teleport', { world: place.world, x: place.x, y: place.y, z: place.z, yaw: place.yaw, pitch: place.pitch }); } catch (_) { /* handled */ } }

const MAP_BRIDGE_CHANNEL = 'player-panel-map-bridge';
function currentBlueMapConfig() {
  const profile = currentServerProfile();
  return profile?.blueMap || state.connections?.blueMap || {};
}
function currentSquareMapConfig() {
  const profile = currentServerProfile();
  return profile?.squareMap || state.connections?.squareMap || {};
}
function mapProviderConfigured(config) {
  return Boolean(config?.url && (config?.configured === true || config?.enabled === true));
}
function configuredPlaceMapProviders() {
  const providers = [];
  const squareMap = currentSquareMapConfig();
  const blueMap = currentBlueMapConfig();
  if (mapProviderConfigured(squareMap)) providers.push('squaremap');
  if (mapProviderConfigured(blueMap)) providers.push('bluemap');
  return providers;
}
const PLACE_MAP_PROVIDER_MOBILE_KEY = 'pp_place_map_provider_mobile';
const PLACE_MAP_PROVIDER_DESKTOP_KEY = 'pp_place_map_provider_desktop';
const PLACE_MAP_PROVIDER_PREF_VERSION_KEY = 'pp_place_map_provider_pref_version';
function placeMapProviderStorageKey() {
  return isMobileMapPicker() ? PLACE_MAP_PROVIDER_MOBILE_KEY : PLACE_MAP_PROVIDER_DESKTOP_KEY;
}
function migratePlaceMapProviderPreference() {
  if (localStorage.getItem(PLACE_MAP_PROVIDER_PREF_VERSION_KEY) === '2') return;
  const old = localStorage.getItem('pp_place_map_provider');
  if (old === 'squaremap' || old === 'bluemap') {
    localStorage.setItem(PLACE_MAP_PROVIDER_DESKTOP_KEY, old);
  }
  localStorage.removeItem(PLACE_MAP_PROVIDER_MOBILE_KEY);
  localStorage.setItem(PLACE_MAP_PROVIDER_PREF_VERSION_KEY, '2');
}
function preferredPlaceMapProvider() {
  migratePlaceMapProviderPreference();
  const available = configuredPlaceMapProviders();
  const mobile = isMobileMapPicker();
  const saved = localStorage.getItem(placeMapProviderStorageKey());
  if (available.includes(saved)) return saved;
  if (mobile && available.includes('squaremap')) return 'squaremap';
  if (available.includes('bluemap')) return 'bluemap';
  return available[0] || '';
}
function currentPlaceMapConfig(provider = state.placeMapProvider) {
  return provider === 'squaremap' ? currentSquareMapConfig() : currentBlueMapConfig();
}
function mapProviderLabel(provider = state.placeMapProvider) { return provider === 'squaremap' ? 'squaremap 2D' : 'BlueMap 3D'; }
function squareMapWorldQueryId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const lower = raw.toLowerCase();
  const known = {
    'minecraft:overworld': 'minecraft_overworld',
    'minecraft:the_nether': 'minecraft_the_nether',
    'minecraft:the_end': 'minecraft_the_end',
    'minecraft_overworld': 'minecraft_overworld',
    'minecraft_the_nether': 'minecraft_the_nether',
    'minecraft_the_end': 'minecraft_the_end'
  };
  if (known[lower]) return known[lower];

  // squaremap publishes dimensions as map keys without ":".
  // For custom dimensions, preserve the namespace and
  // Normalize separators to "_" without changing the stored value.
  if (/^[a-z0-9_.-]+:[a-z0-9_./-]+$/i.test(raw)) {
    return raw.replace(/[:/]+/g, '_');
  }
  return raw;
}
function squareMapPickerUrl(config) {
  const url = new URL(String(config.url || ''), window.location.href);
  const configuredWorld = String(config.worldId || '').trim();
  const existingWorld = String(url.searchParams.get('world') || '').trim();
  const squareMapWorld = squareMapWorldQueryId(configuredWorld || existingWorld);
  if (squareMapWorld) url.searchParams.set('world', squareMapWorld);
  return url.toString();
}
function placeMapTargetOrigin(url = state.placeMapPickerUrl) {
  try { return new URL(String(url || ''), window.location.href).origin; }
  catch (_) { return ''; }
}
function setPlaceMapBridgeStatus(status, title, detail = '') {
  const box = $('placeMapBridgeStatus'); if (!box) return;
  box.dataset.status = status || 'waiting';
  const strong = box.querySelector('strong'); const span = box.querySelector('span');
  if (strong) strong.textContent = title;
  if (span) span.textContent = detail;
}
function clearPlaceMapHandshake() {
  if (state.placeMapHandshakeTimer) clearInterval(state.placeMapHandshakeTimer);
  state.placeMapHandshakeTimer = null;
  state.placeMapHandshakeAttempts = 0;
}
function clearPlaceMapCenterRequest() {
  if (state.placeMapCenterRequestTimer) clearTimeout(state.placeMapCenterRequestTimer);
  state.placeMapCenterRequestTimer = null;
}
function createMapBridgeSession() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint32Array(4);
  globalThis.crypto?.getRandomValues?.(bytes);
  return `${Date.now().toString(36)}-${[...bytes].map((value) => value.toString(36)).join('-')}-${Math.random().toString(36).slice(2)}`;
}
function postPlaceMapPickerCommand(type, payload = {}) {
  if (!state.placeMapPickerActive) return;
  const frame = $('placeMapFrame');
  if (!frame?.contentWindow) return;
  // The first handshake uses "*" to survive HTTP→HTTPS or cross-host redirects.
  // After receiving ready, the channel is pinned to the actual origin and a random session.
  const targetOrigin = state.placeMapBridgeOrigin || '*';
  frame.contentWindow.postMessage({
    channel: MAP_BRIDGE_CHANNEL, version: 1, type, serverId: state.currentServerId,
    session: state.placeMapBridgeSession, mode: state.placeMapMode, provider: state.placeMapProvider,
    world: currentPlaceMapConfig()?.worldId || currentPlaceMapConfig()?.mapId || $('placeWorld')?.value || '',
    mobile: isMobileMapPicker(), ...payload
  }, targetOrigin);
}
function isMobileMapPicker() {
  return window.matchMedia('(max-width: 780px), (pointer: coarse)').matches;
}
function preferredMapPickerMode() {
  const saved = localStorage.getItem('pp_place_map_mode');
  if (saved === 'quick' || saved === 'exact') return saved;
  return isMobileMapPicker() ? 'quick' : 'exact';
}
function renderPlaceMapMode() {
  const squaremap = state.placeMapProvider === 'squaremap';
  if (squaremap) state.placeMapMode = 'quick';
  const quick = state.placeMapMode === 'quick';

  // squaremap Bridge v7 processes each tap automatically. In 2D it does not
  // show redundant manual controls or the quick/exact selector.
  show($('placeMapModeBar'), !squaremap);
  show($('placeMapCenterActions'), !squaremap && quick);

  for (const [id, selected] of [['placeMapQuickModeBtn', quick], ['placeMapExactModeBtn', !quick]]) {
    const button = $(id); if (!button) continue;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    if (id === 'placeMapExactModeBtn') {
      button.disabled = squaremap;
      button.title = squaremap ? 'Exact Y selection requires BlueMap 3D' : '';
    }
  }

  $('placeMapFrameShell')?.classList.toggle('map-picker-quick', quick);
  show($('placeMapMobileHint'), squaremap && isMobileMapPicker());

  const centerButton = $('usePlaceMapCenterBtn');
  if (centerButton) {
    centerButton.disabled = squaremap || !quick || state.placeMapResolving || !state.placeMapBridgeReady;
    centerButton.textContent = state.placeMapCenter
      ? 'Use selected X/Z'
      : (isMobileMapPicker() ? 'Use visible center' : 'Read map center');
  }
}
function renderPlaceMapProvider() {
  const square = state.placeMapProvider === 'squaremap';
  for (const [id, active] of [['placeMapSquareProviderBtn', square], ['placeMapBlueProviderBtn', !square]]) {
    const button = $(id); if (!button) continue;
    const provider = id.includes('Square') ? 'squaremap' : 'bluemap';
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.disabled = !configuredPlaceMapProviders().includes(provider);
  }
  const title = $('placeMapPickerTitle'); if (title) title.textContent = `Select a location from ${mapProviderLabel()}`;
  const availability = $('placeMapProviderAvailability');
  if (availability) {
    const providers = configuredPlaceMapProviders();
    if (isMobileMapPicker() && providers.includes('squaremap')) {
      const squareWorld = squareMapWorldQueryId(currentSquareMapConfig()?.worldId || '');
      availability.textContent = `Mobile: squaremap 2D available · world ${squareWorld || 'automatic'}`;
      availability.dataset.status = 'ready';
    } else if (isMobileMapPicker()) {
      availability.textContent = 'Mobile: squaremap is not configured for this server';
      availability.dataset.status = 'warning';
    } else {
      availability.textContent = providers.includes('squaremap') ? 'squaremap 2D available' : 'Only BlueMap is configured';
      availability.dataset.status = providers.includes('squaremap') ? 'ready' : 'neutral';
    }
  }
  const mobileHint = $('placeMapMobileHint');
  if (mobileHint) show(mobileHint, square && isMobileMapPicker());
  renderPlaceMapMode();
}
function switchPlaceMapProvider(provider) {
  if (!configuredPlaceMapProviders().includes(provider)) return toast(`Configure ${provider === 'squaremap' ? 'squaremap' : 'BlueMap'} for this server`, true);
  localStorage.setItem(placeMapProviderStorageKey(), provider);
  if (!state.placeMapPickerActive) { state.placeMapProvider = provider; renderPlaceMapProvider(); return; }
  stopPlaceMapPicker({ silent: true });
  window.setTimeout(() => startPlaceMapPicker(provider), 50);
}
function setPlaceMapMode(mode, options = {}) {
  state.placeMapMode = state.placeMapProvider === 'squaremap' ? 'quick' : (mode === 'quick' ? 'quick' : 'exact');
  if (options.persist !== false) localStorage.setItem('pp_place_map_mode', state.placeMapMode);
  state.placeMapCenter = null;
  const label = $('placeMapCenterLabel'); if (label) label.textContent = 'X/Z position not selected yet';
  renderPlaceMapMode();
  if (state.placeMapPickerActive) postPlaceMapPickerCommand('picker:set-mode');
  if (state.placeMapBridgeReady) {
    if (state.placeMapProvider === 'squaremap') {
      setPlaceMapBridgeStatus(
        'ready',
        'Automatic 2D selection ready',
        'Tap a point on the map. The pin marks the destination and Minecraft calculates Y automatically.'
      );
    } else if (state.placeMapMode === 'quick') {
      setPlaceMapBridgeStatus(
        'ready',
        'Quick mode ready',
        'Select X/Z or use the visible center; Minecraft will calculate a safe height.'
      );
    } else {
      setPlaceMapBridgeStatus('ready', 'Exact 3D mode ready', 'Click a block to use exact X, Y, and Z coordinates.');
    }
  }
}
function schedulePlaceMapHandshake() {
  clearPlaceMapHandshake();
  state.placeMapHandshakeAttempts = 0;
  postPlaceMapPickerCommand('picker:start');
  state.placeMapHandshakeTimer = window.setInterval(() => {
    if (!state.placeMapPickerActive || state.placeMapBridgeReady) { clearPlaceMapHandshake(); return; }
    state.placeMapHandshakeAttempts += 1;
    postPlaceMapPickerCommand('picker:start');
    if (state.placeMapHandshakeAttempts >= 12) {
      clearPlaceMapHandshake();
      setPlaceMapBridgeStatus('manual', 'The map loaded, but the bridge did not respond', `Reinstall the ${mapProviderLabel()} bridge or open the map separately to verify it.`);
    }
  }, 1000);
}
function startPlaceMapPicker(requestedProvider = '') {
  if (typeof requestedProvider !== 'string') requestedProvider = '';
  const available = configuredPlaceMapProviders();
  if (!available.length) return toast('Configure squaremap or BlueMap under System → System Settings', true);
  state.placeMapProvider = available.includes(requestedProvider) ? requestedProvider : preferredPlaceMapProvider();
  const config = currentPlaceMapConfig();
  const url = state.placeMapProvider === 'squaremap' ? squareMapPickerUrl(config) : String(config.url).replace(/\/$/, '');
  const panel = $('placeMapPickerPanel'); const frame = $('placeMapFrame'); const open = $('openPlaceMapPickerBtn'); const dialog = $('placeMapPickerDialog');
  if (!panel || !frame) return;
  clearPlaceMapCenterRequest();
  state.placeMapPickerActive = true; state.placeMapBridgeReady = false; state.placeMapPickerUrl = url; state.placeMapBridgeOrigin = ''; state.placeMapBridgeSession = createMapBridgeSession();
  state.placeMapBridgeCapabilities = []; state.placeMapCenter = null; state.placeMapResolving = false;
  state.placeMapMode = state.placeMapProvider === 'squaremap' ? 'quick' : preferredMapPickerMode();
  if (dialog?.showModal && !dialog.open) dialog.showModal();
  document.body.classList.add('place-map-dialog-open');
  show(panel, true); show(open, true); if (open) open.href = url;
  renderPlaceMapProvider();
  $('placeMapPickerMeta').textContent = state.placeMapProvider === 'squaremap'
    ? `Server: ${currentServerProfile()?.name || 'Server'} · tap a point; it will load automatically and the pin will show the result.`
    : (state.placeMapMode === 'quick'
      ? `Server: ${currentServerProfile()?.name || 'Server'} · select X/Z and Minecraft will calculate Y.`
      : `Server: ${currentServerProfile()?.name || 'Server'} · click a block to use exact X/Y/Z.`);
  setPlaceMapBridgeStatus('waiting', `Connecting to ${mapProviderLabel()}`, 'Waiting for the coordinate bridge…');
  frame.title = `${mapProviderLabel()} coordinate picker`;
  frame.dataset.mapUrl = url; frame.src = url;
  schedulePlaceMapHandshake();
  window.setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
}
function stopPlaceMapPicker(options = {}) {
  if (!state.placeMapPickerActive && !$('placeMapPickerPanel')) return;
  postPlaceMapPickerCommand('picker:stop');
  clearPlaceMapHandshake();
  clearPlaceMapCenterRequest();
  state.placeMapPickerActive = false; state.placeMapBridgeReady = false; state.placeMapPickerUrl = ''; state.placeMapBridgeOrigin = ''; state.placeMapBridgeSession = ''; state.placeMapCenter = null; state.placeMapResolving = false; state.placeMapBridgeCapabilities = [];
  show($('placeMapPickerPanel'), false);
  const dialog = $('placeMapPickerDialog');
  if (options.closeDialog !== false && dialog?.open) dialog.close();
  document.body.classList.remove('place-map-dialog-open');
  const frame = $('placeMapFrame'); if (frame) { frame.removeAttribute('src'); delete frame.dataset.mapUrl; }
  if (!options.silent) toast('Map selector closed');
}
function formatMapCoordinate(value) {
  const number = Number(value); if (!Number.isFinite(number)) return '';
  if (Number.isInteger(number)) return String(number);
  return number.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
function applyCoordinatesToPlace(location, source = 'BlueMap') {
  const x = Number(location?.x); const y = Number(location?.y); const z = Number(location?.z);
  if (![x, y, z].every(Number.isFinite)) throw new Error('The map did not provide valid X Y Z coordinates');
  if (Math.abs(x) > 30000000 || Math.abs(z) > 30000000) throw new Error('The coordinates are outside Minecraft limits');
  const rawWorld = String(location?.world || location?.mapId || currentPlaceMapConfig()?.worldId || currentPlaceMapConfig()?.mapId || $('placeWorld').value || '').trim();
  const normalizedWorld = normalizedTeleportWorld(rawWorld);
  const availableWorlds = worldNames();
  const matchedWorld = availableWorlds.find((world) => world.toLowerCase() === normalizedWorld.toLowerCase()) || '';
  if (matchedWorld) $('placeWorld').value = matchedWorld;
  $('placeX').value = formatMapCoordinate(x); $('placeY').value = formatMapCoordinate(y); $('placeZ').value = formatMapCoordinate(z);
  if (!$('placeYaw').value) $('placeYaw').value = '0'; if (!$('placePitch').value) $('placePitch').value = '0';
  const worldMessage = matchedWorld ? `World: ${matchedWorld}` : `Review the world; BlueMap reported “${rawWorld || 'unidentified'}”`;
  const nextStep = !$('placeName').value.trim() ? ' · Close the selector to enter a name and save.' : '';
  setPlaceMapBridgeStatus('selected', 'Coordinates received', `${source}: ${formatMapCoordinate(x)}, ${formatMapCoordinate(y)}, ${formatMapCoordinate(z)} · ${worldMessage}${nextStep}`);
  const coordinatePaste = $('placeMapCoordinatePaste'); if (coordinatePaste) coordinatePaste.value = '';
  // Do not focus placeName automatically: focus() scrolls the page and moves BlueMap out of view.
  toast('Coordinates loaded into the location');
}
async function readPlaceMapClipboard({ apply = true } = {}) {
  const input = $('placeMapCoordinatePaste');
  if (!navigator.clipboard?.readText) {
    input?.focus();
    throw new Error('This browser cannot read the clipboard. Use Ctrl+V in the field.');
  }
  let text = '';
  try { text = String(await navigator.clipboard.readText() || '').trim(); }
  catch (_) {
    input?.focus();
    throw new Error('The browser blocked clipboard access. Allow it or use Ctrl+V.');
  }
  if (!text) { input?.focus(); throw new Error('The clipboard is empty'); }
  input.value = text;
  if (apply) {
    const location = parseCoordinateText(text, $('placeWorld').value);
    applyCoordinatesToPlace(location, 'Clipboard');
  }
  return text;
}
async function applyPastedPlaceCoordinates() {
  try {
    let raw = $('placeMapCoordinatePaste').value.trim();
    if (!raw) raw = await readPlaceMapClipboard({ apply: false });
    const location = parseCoordinateText(raw, $('placeWorld').value);
    applyCoordinatesToPlace(location, 'Manual paste');
  } catch (error) { toast(error.message, true); }
}
async function usePlaceMapClipboard() {
  try { await readPlaceMapClipboard({ apply: true }); }
  catch (error) { toast(error.message, true); }
}
function finalizePlaceMapSelection() {
  if (!$('placeX').value || !$('placeZ').value || !$('placeY').value) return toast('Select a position on the map first', true);
  stopPlaceMapPicker({ silent: true });
  toast('Selected position applied to the form');
}
function updatePlaceMapCenter(location) {
  clearPlaceMapCenterRequest();
  const x = Number(location?.x); const z = Number(location?.z);
  if (![x, z].every(Number.isFinite)) return;
  state.placeMapCenter = { x, z, world: location?.world || location?.mapId || '' };
  const label = $('placeMapCenterLabel');
  if (label && state.placeMapProvider !== 'squaremap') {
    label.textContent = `X ${formatMapCoordinate(x)} · Z ${formatMapCoordinate(z)}`;
  }
  renderPlaceMapMode();
}
async function resolvePlaceMapCenter(location = state.placeMapCenter) {
  if (state.placeMapResolving) return;
  const x = Number(location?.x); const z = Number(location?.z);
  if (![x, z].every(Number.isFinite)) return toast(`${mapProviderLabel()} has not reported an X/Z position yet`, true);
  const rawWorld = String(location?.world || location?.mapId || currentPlaceMapConfig()?.worldId || currentPlaceMapConfig()?.mapId || $('placeWorld').value || '').trim();
  const world = normalizedTeleportWorld(rawWorld) || $('placeWorld').value;
  if (!world) return toast('The map world could not be identified', true);
  state.placeMapResolving = true; renderPlaceMapMode();
  setPlaceMapBridgeStatus('waiting', 'Calculating safe height…', `Consultando ${world} en X ${formatMapCoordinate(x)}, Z ${formatMapCoordinate(z)}.`);
  try {
    const data = await request('/api/v1/world/safe-position', {
      method: 'POST', body: JSON.stringify({ world, x, z })
    });
    const position = data.position || data.result || data;
    applyCoordinatesToPlace(position, state.placeMapProvider === 'squaremap' ? 'squaremap 2D' : 'BlueMap quick');
    setPlaceMapBridgeStatus('selected', 'Safe position received', `${position.world || world}: ${formatMapCoordinate(position.x)}, ${formatMapCoordinate(position.y)}, ${formatMapCoordinate(position.z)} · Y calculated by Minecraft.`);
    postPlaceMapPickerCommand('picker:resolve-result', { ok: true, position });
  } catch (error) {
    const message = String(error.message || error);
    let detail = message;
    if (/NOT_FOUND|Endpoint/i.test(message)) {
      detail = 'Update Player Panel Fabric to 1.1.7 to enable the corrected height calculation.';
    } else if (/CHUNK_NOT_GENERATED|selected chunk is not generated/i.test(message)) {
      detail = 'The chunk does not exist in the world files or has not been saved by Minecraft yet.';
    } else if (/CHUNK_LOAD_FAILED|exists on disk but could not be loaded/i.test(message)) {
      detail = 'The chunk exists on disk, but Minecraft could not load it to query the height.';
    } else if (/NO_SAFE_SURFACE|No safe surface/i.test(message)) {
      detail = 'The chunk exists, but no safe surface with two free blocks was found.';
    }
    postPlaceMapPickerCommand('picker:resolve-result', { ok: false, message: detail });
    setPlaceMapBridgeStatus('manual', 'A safe position could not be calculated', `${detail} Try again, use exact 3D mode, or enter Y manually.`);
    toast(detail, true);
  } finally {
    state.placeMapResolving = false; renderPlaceMapMode();
  }
}
function requestPlaceMapCenter() {
  if (state.placeMapProvider === 'squaremap') {
    return toast('In squaremap 2D, just tap the destination; X/Z confirmation is not required');
  }
  if (!state.placeMapBridgeReady) return toast('Wait for the BlueMap bridge to connect', true);
  if (state.placeMapCenter) {
    resolvePlaceMapCenter();
    return;
  }
  clearPlaceMapCenterRequest();
  setPlaceMapBridgeStatus(
    'waiting',
    'Reading visible map center…',
    `${mapProviderLabel()} will send X/Z and Minecraft will resolve a safe height.`
  );
  postPlaceMapPickerCommand('picker:request-center', { selected: true });
  state.placeMapCenterRequestTimer = window.setTimeout(() => {
    state.placeMapCenterRequestTimer = null;
    if (state.placeMapCenter || state.placeMapResolving || !state.placeMapPickerActive) return;
    setPlaceMapBridgeStatus(
      'manual',
      `${mapProviderLabel()} has not reported X/Z yet`,
      'Tap the map once, move it slightly under the crosshair, and select “Use visible center” again.'
    );
  }, 3500);
}

function handlePlaceMapBridgeMessage(event) {
  const frame = $('placeMapFrame');
  if (!state.placeMapPickerActive || !frame?.contentWindow || event.source !== frame.contentWindow) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.channel !== MAP_BRIDGE_CHANNEL || Number(data.version || 0) !== 1) return;
  if (!state.placeMapBridgeSession || data.session !== state.placeMapBridgeSession) return;
  if (state.placeMapBridgeOrigin && event.origin !== state.placeMapBridgeOrigin) return;
  if (data.type === 'ready') {
    state.placeMapBridgeOrigin = event.origin;
    state.placeMapBridgeReady = true; clearPlaceMapHandshake();
    state.placeMapBridgeCapabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
    const configuredOrigin = placeMapTargetOrigin();
    const redirectNote = configuredOrigin && configuredOrigin !== event.origin ? ` Redirect detected to ${event.origin}.` : '';
    const providerName = data.provider === 'squaremap' || state.placeMapProvider === 'squaremap' ? 'squaremap 2D' : 'BlueMap 3D';
    if (state.placeMapMode === 'quick') {
      const quickInstruction = state.placeMapProvider === 'squaremap' ? 'Tap a point: it will load automatically and the pin will mark the destination.' : 'Select a point or use the visible center.';
      setPlaceMapBridgeStatus('ready', `Bridge for ${providerName} connected`, `${quickInstruction} Minecraft will calculate Y.${redirectNote}`);
    } else {
      setPlaceMapBridgeStatus('ready', 'BlueMap 3D bridge connected · exact mode', `Click a block to use exact X/Y/Z.${redirectNote}`);
    }
    renderPlaceMapMode();
    postPlaceMapPickerCommand('picker:set-mode');
    return;
  }
  if (!state.placeMapBridgeReady) return;
  if (data.type === 'center' || data.type === 'map-center') {
    updatePlaceMapCenter(data);
    if (data.selected) resolvePlaceMapCenter(data);
    return;
  }
  if (data.type === 'center-unavailable') {
    clearPlaceMapCenterRequest();
    setPlaceMapBridgeStatus(
      'manual',
      `${mapProviderLabel()} does not expose an X/Z position yet`,
      data.message || 'Move the map slightly and select “Use visible center” again.'
    );
    return;
  }
  if (data.type === 'coordinates' || data.type === 'coordinate') {
    try { applyCoordinatesToPlace(data, data.provider === 'bluemap' ? 'BlueMap' : 'Web map'); }
    catch (error) { toast(error.message, true); }
  }
}

async function loadHistory() { try { const category = encodeURIComponent($('historyCategory').value); const data = await request(`/api/local/history?limit=150&category=${category}`); state.history = data.history || []; renderHistory(); } catch (error) { toast(error.message, true); } }
function statusText(ok, yes = 'Operational', no = 'Offline') { return ok ? yes : no; }
function statusClass(ok) { return ok ? 'ok' : 'bad'; }
function setSystemCard(id, metaId, value, meta, ok = true) {
  const card = $(id)?.closest('.system-health-card');
  if ($(id)) $(id).textContent = value;
  if ($(metaId)) $(metaId).textContent = meta;
  if (card) { card.classList.toggle('healthy', Boolean(ok)); card.classList.toggle('unhealthy', !ok); }
}
function fillDefinitionList(element, rows) {
  if (!element) return;
  element.textContent = '';
  for (const [label, value] of rows) {
    const wrap = document.createElement('div'); const dt = document.createElement('dt'); const dd = document.createElement('dd');
    dt.textContent = label; dd.textContent = value; wrap.append(dt, dd); element.append(wrap);
  }
}
function populateTimeZoneSelect(selected) {
  const select = $('systemTimezone'); if (!select) return;
  if (!select.options.length) {
    let zones = ['UTC', 'America/New_York', 'America/Los_Angeles', 'America/Bogota', 'America/Panama', 'Europe/Madrid'];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch (_) { /* fallback */ }
    for (const zone of zones) { const option = document.createElement('option'); option.value = zone; option.textContent = zone; select.append(option); }
  }
  if (![...select.options].some((option) => option.value === selected)) { const option = document.createElement('option'); option.value = selected; option.textContent = selected; select.append(option); }
  if (!controlProtected(select, 'system-retention')) select.value = selected;
}
function renderSystemBackups(backups) {
  const container = $('systemBackupsList'); if (!container) return;
  container.textContent = ''; const items = Array.isArray(backups) ? backups : [];
  show($('emptySystemBackups'), items.length === 0);
  for (const backup of items) {
    const row = document.createElement('div'); row.className = 'system-backup-row';
    const info = document.createElement('div'); const title = document.createElement('strong'); title.textContent = backup.name;
    const meta = document.createElement('small'); meta.textContent = `${formatDate(backup.createdAt)} · ${backup.sizeLabel || formatBytes(backup.size)} · version ${backup.version || '—'}`;
    info.append(title, meta);
    const actions = document.createElement('div'); actions.className = 'system-backup-actions';
    const download = document.createElement('a'); download.className = 'button-link ghost small-btn'; download.textContent = 'Download'; download.href = `/api/local/system/backups/${encodeURIComponent(backup.name)}/download?server=${encodeURIComponent(state.currentServerId || '')}`;
    actions.append(download);
    if (hasPermission('system.restore')) {
      const restore = document.createElement('button'); restore.className = 'warning small-btn'; restore.type = 'button'; restore.textContent = 'Restaurar';
      restore.addEventListener('click', () => restoreSystemBackup(backup.name)); actions.append(restore);
    }
    if (hasPermission('system.backup')) {
      const remove = document.createElement('button'); remove.className = 'danger-outline small-btn'; remove.type = 'button'; remove.textContent = 'Delete';
      remove.addEventListener('click', () => deleteSystemBackup(backup.name)); actions.append(remove);
    }
    row.append(info, actions); container.append(row);
  }
}
const DOCKER_HOST_GATEWAY = 'host.docker.internal';
function isIpLiteral(host) {
  const value = String(host || '').replace(/^\[|\]$/g, '');
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  return value.includes(':');
}
function isPrivateOrLocalHost(host) {
  const value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (isIpLiteral(value)) return true;
  return !value.includes('.') || value.endsWith('.local') || value.endsWith('.internal') || value.endsWith('.lan');
}
function normalizeServiceAddress(rawValue, kind = 'plugin') {
  let value = String(rawValue || '').trim();
  if (!value) return '';
  value = value.replace(/\s+/g, '');
  if (/^\/\//.test(value)) value = `https:${value}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try { return new URL(value).toString().replace(/\/$/, ''); }
    catch (_) { return value; }
  }

  // An IPv6 address without brackets and without a port is normalized before adding the scheme.
  if (!value.startsWith('[') && (value.match(/:/g) || []).length > 1 && !value.includes('/')) {
    value = `[${value}]`;
  }
  const hostPort = value.split('/')[0];
  let host = hostPort;
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'));
  else if ((host.match(/:/g) || []).length === 1) host = host.split(':')[0];
  const direct = isPrivateOrLocalHost(host);
  const defaults = {
    plugin: { directScheme: 'http', directPort: '8765', domainScheme: 'https' },
    crafty: { directScheme: 'https', directPort: '8443', domainScheme: 'https' },
    craftyPublic: { directScheme: 'https', directPort: '8443', domainScheme: 'https' },
    bluemap: { directScheme: 'http', directPort: '', domainScheme: 'https' },
    squaremap: { directScheme: 'http', directPort: '', domainScheme: 'https' }
  }[kind] || { directScheme: 'https', directPort: '', domainScheme: 'https' };
  const scheme = direct ? defaults.directScheme : defaults.domainScheme;
  try {
    const parsed = new URL(`${scheme}://${value}`);
    if (direct && defaults.directPort && !parsed.port) parsed.port = defaults.directPort;
    return parsed.toString().replace(/\/$/, '');
  } catch (_) {
    return value;
  }
}
function normalizeAddressField(id, kind) {
  const input = $(id);
  if (!input) return '';
  const normalized = normalizeServiceAddress(input.value, kind);
  if (normalized && normalized !== input.value.trim()) input.value = normalized;
  return normalized;
}
function connectionRouteInfo(rawUrl, kind = 'plugin') {
  const original = String(rawUrl || '').trim();
  if (!original) return { route: 'empty', label: 'No address', help: 'Enter an IP address, hostname, or complete URL.' };
  const value = normalizeServiceAddress(original, kind);
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    const base = { host, port: Number(port), tls: parsed.protocol === 'https:', normalized: value };
    if (['localhost', '127.0.0.1', '::1'].includes(host)) return { ...base, route: 'loopback', label: 'Web container', help: `localhost points to the web container itself. Use ${DOCKER_HOST_GATEWAY} or the actual server IP.`, warning: true };
    if ([DOCKER_HOST_GATEWAY, 'gateway.docker.internal'].includes(host)) return { ...base, route: 'host', label: 'Docker host', help: `Connection to the Docker host on port ${port}.` };
    if (isIpLiteral(host)) return { ...base, route: 'lan', label: 'Direct IP', help: `Direct connection to ${host}:${port}${parsed.protocol === 'http:' ? ' over HTTP.' : ' over HTTPS.'}`, warning: parsed.protocol === 'http:' && !/^10\.|^127\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host) };
    if (isPrivateOrLocalHost(host)) return { ...base, route: 'docker', label: 'Internal network / LAN', help: `Direct connection to ${host}:${port} using an internal hostname.` };
    const insecure = parsed.protocol === 'http:';
    return { ...base, route: 'remote', label: 'Remote domain', help: insecure ? 'The connection uses unencrypted HTTP. Use HTTPS or a private network.' : `HTTPS connection to ${host}:${port}.`, warning: insecure };
  } catch (_) { return { route: 'invalid', label: 'Invalid address', help: 'Examples: 192.168.1.50:8765, crafty-controller:8765, or https://panel.example.com.', warning: true }; }
}
function renderConnectionRouteHint(kind) {
  const input = $(kind === 'plugin' ? 'pluginConnectionUrl' : 'craftyInstallationUrl');
  const help = $(kind === 'plugin' ? 'pluginConnectionRouteHelp' : 'craftyInstallationRouteHelp');
  if (!input || !help) return;
  const info = connectionRouteInfo(input.value, kind);
  let text = `${info.label}: ${info.help}`;
  let warning = Boolean(info.warning);
  if (kind === 'plugin' && info.route === 'remote' && info.tls && Number(info.port) === 8765) {
    text = `Remote domain: HTTPS is using internal port 8765. With a reverse proxy, normally use the domain without :8765.`;
    warning = true;
  }
  help.textContent = text;
  help.classList.toggle('connection-warning', warning);
}
function setConnectionPreset(preset) {
  const [kind, mode] = String(preset || '').split('-');
  const input = $(kind === 'plugin' ? 'pluginConnectionUrl' : 'craftyInstallationUrl');
  if (!input) return;
  if (mode === 'docker') input.value = kind === 'plugin' ? 'crafty-controller:8765' : 'crafty-controller:8443';
  else if (mode === 'host') input.value = kind === 'plugin' ? `${DOCKER_HOST_GATEWAY}:8765` : `${DOCKER_HOST_GATEWAY}:8443`;
  else if (mode === 'lan') input.value = kind === 'plugin' ? '192.168.1.50:8765' : '192.168.1.50:8443';
  else if (mode === 'remote') input.value = kind === 'plugin' ? 'https://plugin.example.com' : 'https://crafty.example.com';
  if (mode !== 'custom') {
    input.value = normalizeServiceAddress(input.value, kind);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.select();
  }
  input.focus();
  renderConnectionRouteHint(kind);
}
function diagnosticMessage(result, successText, failureText) {
  if (result?.available) {
    const latency = Number.isFinite(Number(result.latencyMs)) ? ` · ${Number(result.latencyMs).toFixed(0)} ms` : '';
    const route = result.target?.label ? ` via ${result.target.label.toLowerCase()}` : '';
    return `${successText}${route}${latency}.`;
  }
  const diagnostic = result?.diagnostic || result?.data?.diagnostic || {};
  const hint = diagnostic.hint || '';
  const detail = diagnostic.detail || result?.message || result?.data?.message || '';
  const status = result?.statusCode || result?.status;
  return [failureText, status ? `HTTP ${status}.` : '', detail ? `${detail}.` : '', hint].filter(Boolean).join(' ');
}

function setConnectionBadge(id, configured, available = null) {
  const badge = $(id); if (!badge) return;
  badge.classList.remove('configured', 'connected', 'disconnected', 'disabled');
  if (!configured) { badge.textContent = 'Not configured'; badge.classList.add('disabled'); return; }
  if (available === true) { badge.textContent = 'Connected'; badge.classList.add('connected'); return; }
  if (available === false) { badge.textContent = 'No response'; badge.classList.add('disconnected'); return; }
  badge.textContent = 'Configured'; badge.classList.add('configured');
}

function craftyConnectionById(value) {
  const id = Number(value || 0);
  return state.craftyConnections.find((item) => Number(item.id) === id) || null;
}
function renderCraftyConnectionOptions(selectedId = 0) {
  const installationSelect = $('craftyInstallationSelect');
  const assignmentSelect = $('craftyConnectionAssignment');
  const selected = Number(selectedId || state.craftyConnectionDraftId || 0);

  if (installationSelect) {
    installationSelect.textContent = '';
    if (!state.craftyConnections.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No installations; configure one first';
      installationSelect.append(option);
    } else {
      for (const connection of state.craftyConnections) {
        const option = document.createElement('option');
        option.value = String(connection.id);
        option.textContent = `${connection.name}${connection.linkedServers ? ` · ${connection.linkedServers} server(s)` : ''}`;
        installationSelect.append(option);
      }
      installationSelect.value = String(
        craftyConnectionById(selected)?.id
        || state.craftyConnections[0]?.id
        || ''
      );
    }
  }

  const hasCraftyInstallations = state.craftyConnections.length > 0;
  if ($('saveCraftyConnectionBtn')) $('saveCraftyConnectionBtn').disabled = !hasCraftyInstallations;
  if ($('craftyConnectionResult') && !hasCraftyInstallations) {
    $('craftyConnectionResult').textContent = 'First configure a Crafty installation with its API credentials.';
  }

  if (assignmentSelect) {
    const currentValue = String(
      selectedId
      || state.connections?.crafty?.connectionId
      || assignmentSelect.value
      || ''
    );
    assignmentSelect.textContent = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'Select an installation';
    assignmentSelect.append(empty);
    for (const connection of state.craftyConnections) {
      const option = document.createElement('option');
      option.value = String(connection.id);
      option.textContent = connection.name;
      assignmentSelect.append(option);
    }
    assignmentSelect.value = currentValue;
  }
}
function resetCraftyInstallationForm() {
  state.craftyConnectionDraftId = 0;
  clearScopeDirty('crafty-installation');
  setGuardedValue('craftyInstallationName', '', 'crafty-installation');
  setGuardedValue('craftyInstallationUrl', 'https://crafty-controller:8443', 'crafty-installation');
  setGuardedValue('craftyInstallationUsername', '', 'crafty-installation');
  setGuardedValue('craftyInstallationPassword', '', 'crafty-installation');
  setGuardedValue('craftyInstallationToken', '', 'crafty-installation');
  setGuardedValue('craftyInstallationPanelUrl', '', 'crafty-installation');
  setGuardedChecked('craftyInstallationVerifyTls', false, 'crafty-installation');
  $('craftyInstallationPassword').placeholder = 'Enter the API password';
  $('craftyInstallationToken').placeholder = 'Enter an API token';
  $('craftyInstallationPasswordState').textContent = 'Not configured';
  $('craftyInstallationTokenState').textContent = 'Not configured';
  $('craftyInstallationResult').textContent = 'Complete the fields and save the installation.';
  setConnectionBadge('craftyInstallationBadge', false, null);
  renderConnectionRouteHint('crafty');
}
function renderCraftyInstallation(connection) {
  if (!connection) return resetCraftyInstallationForm();
  state.craftyConnectionDraftId = Number(connection.id || 0);
  setGuardedValue('craftyInstallationName', connection.name || '', 'crafty-installation');
  setGuardedValue('craftyInstallationUrl', connection.apiUrl || '', 'crafty-installation');
  setGuardedValue('craftyInstallationUsername', connection.username || '', 'crafty-installation');
  setGuardedValue('craftyInstallationPassword', '', 'crafty-installation');
  setGuardedValue('craftyInstallationToken', '', 'crafty-installation');
  setGuardedValue('craftyInstallationPanelUrl', connection.panelUrl || '', 'crafty-installation');
  setGuardedChecked('craftyInstallationVerifyTls', connection.verifyTls, 'crafty-installation');
  $('craftyInstallationPassword').placeholder = connection.passwordConfigured
    ? 'Configured; leave blank to keep it'
    : 'Enter the API password';
  $('craftyInstallationToken').placeholder = connection.apiTokenConfigured
    ? 'Configured; leave blank to keep it'
    : 'Enter an API token';
  $('craftyInstallationPasswordState').textContent = connection.passwordConfigured
    ? 'Password configured and encrypted'
    : 'Password not configured';
  $('craftyInstallationTokenState').textContent = connection.apiTokenConfigured
    ? 'Token configured and encrypted'
    : 'Token not configured';
  $('craftyInstallationResult').textContent =
    `${connection.linkedServers || 0} server(s) linked · ${connection.apiUrl || 'no URL'}`;
  setConnectionBadge('craftyInstallationBadge', Boolean(connection.configured), null);
  renderConnectionRouteHint('crafty');
}
function renderCraftyDiscoveredServers(servers = []) {
  state.craftyDiscoveredServers = Array.isArray(servers) ? servers : [];
  const container = $('craftyDiscoveredServers');
  const section = $('craftyDiscoverySection');
  const select = $('craftyDiscoveredServerSelect');
  if (container) container.textContent = '';
  if (select) {
    const current = select.value;
    select.textContent = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = state.craftyDiscoveredServers.length
      ? 'Select a discovered server'
      : 'Ejecuta “Descubrir servers”';
    select.append(empty);
    for (const server of state.craftyDiscoveredServers) {
      const option = document.createElement('option');
      option.value = server.id;
      option.textContent = `${server.name} · ${server.running ? 'online' : server.status || 'unknown status'}`;
      select.append(option);
    }
    if ([...select.options].some((option) => option.value === current)) {
      select.value = current;
    }
  }
  show(section, state.craftyDiscoveredServers.length > 0);
  if ($('craftyDiscoveryMeta')) {
    $('craftyDiscoveryMeta').textContent = state.craftyDiscoveredServers.length
      ? `${state.craftyDiscoveredServers.length} server(s) visible to this account.`
      : 'Crafty returned no accessible servers.';
  }
  if (!container) return;
  for (const server of state.craftyDiscoveredServers) {
    const row = document.createElement('label');
    row.className = 'crafty-discovered-row';
    row.classList.add(server.running ? 'is-running' : 'is-stopped');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = server.id;
    checkbox.dataset.craftyImport = '1';

    const info = document.createElement('span');
    info.className = 'crafty-discovered-info';
    const title = document.createElement('strong');
    title.textContent = server.name;
    const meta = document.createElement('small');
    meta.textContent = `${server.id} · ${server.type || 'Minecraft'} · ${server.running ? 'Online' : server.status || 'No status'}`;
    info.append(title, meta);

    const status = document.createElement('span');
    status.className = 'crafty-server-status';
    status.textContent = server.running
      ? 'Online'
      : (server.status && server.status !== 'unknown' ? server.status : 'Unavailable');

    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'ghost small-btn';
    use.textContent = 'Vincular activo';
    use.addEventListener('click', (event) => {
      event.preventDefault();
      const connectionId = Number(
        state.craftyConnectionDraftId
        || $('craftyInstallationSelect')?.value
        || 0
      );
      $('craftyConnectionAssignment').value = String(connectionId || '');
      $('craftyDiscoveredServerSelect').value = server.id;
      $('craftyConnectionServerId').value = server.id;
      $('craftyConnectionEnabled').checked = true;
      markScopeDirty('crafty-connection');
      $('craftyConnectionResult').textContent =
        `Ready to link ${server.name}. Select “Save link and test”.`;
      $('craftyConnectionServerId').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    row.append(checkbox, info, status, use);
    container.append(row);
  }
}
async function loadCraftyConnections({ silent = false, selectedId = 0 } = {}) {
  try {
    const data = await request('/api/local/crafty/connections');
    state.craftyConnections = Array.isArray(data.connections) ? data.connections : [];
    renderCraftyConnectionOptions(selectedId || data.selectedConnectionId || 0);
    const wanted = Number(
      selectedId
      || state.craftyConnectionDraftId
      || data.selectedConnectionId
      || state.craftyConnections[0]?.id
      || 0
    );
    const connection = craftyConnectionById(wanted) || state.craftyConnections[0] || null;
    renderCraftyInstallation(connection);
    if ($('craftyInstallationSelect') && connection) {
      $('craftyInstallationSelect').value = String(connection.id);
    }
    return state.craftyConnections;
  } catch (error) {
    if (!silent) toast(error.message, true);
    return [];
  }
}
function openCraftyInstallations() {
  closeServerEditor({ restoreFocus: false });
  setView('crafty-connections');
  window.requestAnimationFrame(() => $('craftyInstallationSelect')?.focus());
}

async function saveCraftyInstallation() {
  const button = $('saveCraftyInstallationBtn');
  button.disabled = true;
  $('craftyInstallationResult').textContent = 'Saving and checking the v2 API…';
  const body = {
    id: state.craftyConnectionDraftId || 0,
    name: $('craftyInstallationName').value.trim(),
    apiUrl: normalizeAddressField('craftyInstallationUrl', 'crafty'),
    username: $('craftyInstallationUsername').value.trim(),
    password: $('craftyInstallationPassword').value,
    apiToken: $('craftyInstallationToken').value.trim(),
    panelUrl: normalizeAddressField('craftyInstallationPanelUrl', 'craftyPublic'),
    verifyTls: $('craftyInstallationVerifyTls').checked,
    test: true
  };
  try {
    const data = await request('/api/local/crafty/connections/save', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    state.craftyConnections = data.connections || [];
    state.servers = data.servers || state.servers;
    state.craftyConnectionDraftId = Number(data.connection?.id || 0);
    clearScopeDirty('crafty-installation');
    renderCraftyConnectionOptions(state.craftyConnectionDraftId);
    renderCraftyInstallation(data.connection);
    renderServerSelector();
    const discovery = data.discovery || {};
    if (discovery.available) {
      renderCraftyDiscoveredServers(discovery.servers || []);
      $('craftyInstallationResult').textContent =
        `Connection verified · ${discovery.count || 0} server(s) · ${Number(discovery.latencyMs || 0).toFixed(0)} ms.`;
      setConnectionBadge('craftyInstallationBadge', true, true);
      toast('Crafty installation saved');
    } else {
      $('craftyInstallationResult').textContent = diagnosticMessage(
        discovery,
        'Connection verified',
        'Installation saved, but Crafty did not respond'
      );
      setConnectionBadge('craftyInstallationBadge', true, false);
      toast('Installation saved; review the connection', true);
    }
  } catch (error) {
    $('craftyInstallationResult').textContent = error.message;
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}
async function deleteCraftyInstallation() {
  const id = Number(state.craftyConnectionDraftId || $('craftyInstallationSelect')?.value || 0);
  const connection = craftyConnectionById(id);
  if (!connection) return toast('Select a Crafty installation', true);
  if (!confirm(`Delete the installation “${connection.name}”?`)) return;
  try {
    const data = await request('/api/local/crafty/connections/delete', {
      method: 'POST',
      body: JSON.stringify({ id })
    });
    state.craftyConnections = data.connections || [];
    state.craftyConnectionDraftId = 0;
    renderCraftyConnectionOptions();
    renderCraftyDiscoveredServers([]);
    if (state.craftyConnections.length) {
      renderCraftyInstallation(state.craftyConnections[0]);
      $('craftyInstallationSelect').value = String(state.craftyConnections[0].id);
    } else {
      resetCraftyInstallationForm();
    }
    toast('Crafty installation deleted');
  } catch (error) {
    toast(error.message, true);
    $('craftyInstallationResult').textContent = error.message;
  }
}
async function discoverCraftyServers() {
  const id = Number(state.craftyConnectionDraftId || $('craftyInstallationSelect')?.value || 0);
  if (!id) return toast('Save or select a Crafty installation', true);
  const button = $('discoverCraftyServersBtn');
  button.disabled = true;
  $('craftyInstallationResult').textContent = 'Consultando /api/v2/servers…';
  try {
    const data = await request('/api/local/crafty/connections/discover', {
      method: 'POST',
      body: JSON.stringify({ id })
    });
    const discovery = data.discovery || {};
    renderCraftyDiscoveredServers(discovery.servers || []);
    $('craftyInstallationResult').textContent =
      `${discovery.count || 0} discovered server(s) · ${Number(discovery.latencyMs || 0).toFixed(0)} ms.`;
    setConnectionBadge('craftyInstallationBadge', true, true);
  } catch (error) {
    $('craftyInstallationResult').textContent = error.message;
    setConnectionBadge('craftyInstallationBadge', true, false);
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}
async function importCraftyServers() {
  const id = Number(state.craftyConnectionDraftId || $('craftyInstallationSelect')?.value || 0);
  const selected = [...document.querySelectorAll('[data-crafty-import]:checked')]
    .map((input) => input.value);
  if (!id) return toast('Select a Crafty installation', true);
  if (!selected.length) return toast('Select at least one discovered server', true);
  const button = $('importCraftyServersBtn');
  button.disabled = true;
  try {
    const data = await request('/api/local/crafty/connections/import', {
      method: 'POST',
      body: JSON.stringify({ id, serverIds: selected })
    });
    state.servers = data.servers || state.servers;
    renderServerSelector();
    renderServerManagement();
    const imported = data.imported?.length || 0;
    const skipped = data.skipped?.length || 0;
    toast(`${imported} imported server(s)${skipped ? ` · ${skipped} already existed` : ''}`);
    await loadCraftyConnections({ silent: true, selectedId: id });
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderConnectionSettings(connections, pluginStatus = {}, craftyStatus = {}) {
  state.connections = connections || state.connections || {};
  const plugin = state.connections.plugin || {};
  const crafty = state.connections.crafty || {};
  updateConnectionNavigation(state.connections);
  setGuardedChecked('pluginConnectionEnabled', plugin.enabled, 'plugin-connection');
  setGuardedValue('pluginConnectionUrl', plugin.apiUrl || '', 'plugin-connection');
  setGuardedValue('pluginConnectionToken', '', 'plugin-connection');
  $('pluginConnectionToken').placeholder = plugin.tokenConfigured ? 'Configured; leave blank to keep it' : 'Enter the API token';
  $('pluginTokenState').textContent = plugin.tokenConfigured ? 'Token configured and encrypted' : 'Token not configured';
  setGuardedChecked('pluginConnectionVerifyTls', plugin.verifyTls !== false, 'plugin-connection');
  renderConnectionRouteHint('plugin');
  setConnectionBadge('pluginConnectionBadge', Boolean(plugin.configured), pluginStatus.available);

  setGuardedChecked('craftyConnectionEnabled', crafty.enabled, 'crafty-connection');
  renderCraftyConnectionOptions(crafty.connectionId || 0);
  setGuardedValue('craftyConnectionAssignment', crafty.connectionId || '', 'crafty-connection');
  setGuardedValue('craftyConnectionServerId', crafty.serverId || '', 'crafty-connection');
  if ($('craftyDiscoveredServerSelect') && [...$('craftyDiscoveredServerSelect').options].some((option) => option.value === crafty.serverId)) {
    setGuardedValue('craftyDiscoveredServerSelect', crafty.serverId || '', 'crafty-connection');
  }
  setConnectionBadge('craftyConnectionBadge', Boolean(crafty.configured), craftyStatus.available);
  const blueMap = state.connections.blueMap || {};
  setGuardedChecked('blueMapConnectionEnabled', blueMap.enabled, 'bluemap-connection');
  setGuardedValue('blueMapConnectionUrl', blueMap.url || '', 'bluemap-connection');
  setGuardedValue('blueMapConnectionMapId', blueMap.mapId || '', 'bluemap-connection');
  setConnectionBadge('blueMapConnectionBadge', Boolean(blueMap.configured), blueMap.configured ? true : null);
  const squareMap = state.connections.squareMap || {};
  setGuardedChecked('squareMapConnectionEnabled', squareMap.enabled, 'squaremap-connection');
  setGuardedValue('squareMapConnectionUrl', squareMap.url || '', 'squaremap-connection');
  setGuardedValue('squareMapConnectionWorldId', squareMap.worldId || 'minecraft:overworld', 'squaremap-connection');
  setConnectionBadge('squareMapConnectionBadge', Boolean(squareMap.configured), squareMap.configured ? true : null);
  renderServerProfileManager();
}
function applyConnectionSaveResponse(data) {
  if (Array.isArray(data?.servers)) state.servers = data.servers;
  if (Array.isArray(data?.craftyConnections)) state.craftyConnections = data.craftyConnections;
  if (Number(data?.selectedServerId || 0) > 0) state.currentServerId = Number(data.selectedServerId);
  state.connections = data?.connections || profileConnections() || state.connections;
  const profile = currentServerProfile();
  if (profile && state.connections) {
    profile.plugin = state.connections.plugin || profile.plugin;
    profile.crafty = state.connections.crafty || profile.crafty;
    profile.blueMap = state.connections.blueMap || profile.blueMap;
    profile.squareMap = state.connections.squareMap || profile.squareMap;
  }
  renderServerSelector();
}

async function savePluginConnection() {
  const button = $('savePluginConnectionBtn'); button.disabled = true; $('pluginConnectionResult').textContent = 'Saving and checking…';
  const body = {
    type: 'plugin',
    enabled: $('pluginConnectionEnabled').checked,
    apiUrl: normalizeAddressField('pluginConnectionUrl', 'plugin'),
    apiToken: $('pluginConnectionToken').value,
    verifyTls: $('pluginConnectionVerifyTls').checked
  };
  try {
    const data = await request('/api/local/system/connections', { method: 'POST', body: JSON.stringify(body) });
    applyConnectionSaveResponse(data); clearScopeDirty('plugin-connection'); renderConnectionSettings(state.connections, data.plugin || {}, state.system?.crafty || {});
    const available = Boolean(data.plugin?.available); $('pluginConnectionResult').textContent = body.enabled ? diagnosticMessage(data.plugin || {}, 'Connection verified', 'Configuration saved, but the plugin did not respond.') : 'Connection disabled.';
    toast(available || !body.enabled ? 'Plugin connection saved' : 'Configuration saved; review the connection', !available && body.enabled);
    await loadSystem(true);
  } catch (error) { $('pluginConnectionResult').textContent = error.message; toast(error.message, true); }
  finally { button.disabled = false; }
}
async function saveCraftyConnection() {
  const button = $('saveCraftyConnectionBtn');
  button.disabled = true;
  $('craftyConnectionResult').textContent = 'Saving link and testing…';
  const discoveredId = $('craftyDiscoveredServerSelect')?.value || '';
  if (discoveredId) $('craftyConnectionServerId').value = discoveredId;
  const body = {
    type: 'crafty',
    enabled: $('craftyConnectionEnabled').checked,
    connectionId: Number($('craftyConnectionAssignment').value || 0),
    serverId: $('craftyConnectionServerId').value.trim()
  };
  if (body.enabled && !body.connectionId) {
    button.disabled = false;
    $('craftyConnectionResult').textContent = 'Configure and select a Crafty installation before linking the server.';
    toast('Crafty installation configuration is missing', true);
    return;
  }
  try {
    const data = await request('/api/local/system/connections', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    if (Array.isArray(data.craftyConnections)) {
      state.craftyConnections = data.craftyConnections;
    }
    applyConnectionSaveResponse(data);
    clearScopeDirty('crafty-connection');
    renderConnectionSettings(
      state.connections,
      state.system?.plugin || {},
      data.crafty || {}
    );
    const available = Boolean(data.crafty?.available);
    $('craftyConnectionResult').textContent = body.enabled
      ? diagnosticMessage(
          data.crafty || {},
          'Server linked; Management & Status is available',
          'Link saved, but Crafty did not respond'
        )
      : 'Connection disabled; Management & Status is hidden.';
    if (!state.connections?.crafty?.configured && state.view === 'server') {
      setView('system');
    }
    toast(
      available || !body.enabled
        ? 'Crafty link saved'
        : 'Link saved; review Crafty',
      !available && body.enabled
    );
    await loadCraftyConnections({
      silent: true,
      selectedId: body.connectionId
    });
    await loadSystem(true);
  } catch (error) {
    $('craftyConnectionResult').textContent = error.message;
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function saveBlueMapConnection() {
  const button = $('saveBlueMapConnectionBtn'); if (!button) return;
  button.disabled = true; $('blueMapConnectionResult').textContent = 'Saving…';
  const body = { type: 'bluemap', enabled: $('blueMapConnectionEnabled').checked, url: normalizeAddressField('blueMapConnectionUrl', 'bluemap'), mapId: $('blueMapConnectionMapId').value.trim() };
  try {
    const data = await request('/api/local/system/connections', { method: 'POST', body: JSON.stringify(body) });
    applyConnectionSaveResponse(data); clearScopeDirty('bluemap-connection');
    const profile = currentServerProfile(); if (profile) profile.blueMap = state.connections.blueMap || profile.blueMap;
    renderConnectionSettings(state.connections, state.system?.plugin || {}, state.system?.crafty || {});
    $('blueMapConnectionResult').textContent = body.enabled ? 'BlueMap is available in the Server menu.' : 'Integration disabled.';
    toast('BlueMap configuration saved');
    updateConnectionNavigation();
  } catch (error) { $('blueMapConnectionResult').textContent = error.message; toast(error.message, true); }
  finally { button.disabled = false; }
}
async function saveSquareMapConnection() {
  const button = $('saveSquareMapConnectionBtn'); if (!button) return;
  button.disabled = true; $('squareMapConnectionResult').textContent = 'Saving…';
  const body = { type: 'squaremap', enabled: $('squareMapConnectionEnabled').checked, url: normalizeAddressField('squareMapConnectionUrl', 'squaremap'), worldId: $('squareMapConnectionWorldId').value.trim() || 'minecraft:overworld' };
  try {
    const data = await request('/api/local/system/connections', { method: 'POST', body: JSON.stringify(body) });
    applyConnectionSaveResponse(data); clearScopeDirty('squaremap-connection');
    const profile = currentServerProfile(); if (profile) profile.squareMap = state.connections.squareMap || profile.squareMap;
    renderConnectionSettings(state.connections, state.system?.plugin || {}, state.system?.crafty || {});
    if (body.enabled && body.url && isMobileMapPicker()) {
      localStorage.setItem(PLACE_MAP_PROVIDER_MOBILE_KEY, 'squaremap');
    }
    $('squareMapConnectionResult').textContent = body.enabled ? 'squaremap is available as the mobile 2D selector.' : '2D integration disabled.';
    toast('squaremap configuration saved'); updateConnectionNavigation();
  } catch (error) { $('squareMapConnectionResult').textContent = error.message; toast(error.message, true); }
  finally { button.disabled = false; }
}

function serverOriginType(profile) {
  return profile?.sourceType === 'crafty' || Number(profile?.crafty?.connectionId || 0) > 0
    ? 'crafty'
    : 'manual';
}
function serverOriginLabel(profile) {
  if (serverOriginType(profile) === 'crafty') {
    return profile?.crafty?.connectionName
      ? `Crafty · ${profile.crafty.connectionName}`
      : 'Crafty';
  }
  return 'Manual configuration';
}
function serverConnectionSummary(profile) {
  const parts = [];
  if (profile?.plugin?.configured) parts.push('Plugin listo');
  else if (profile?.plugin?.enabled) parts.push('Plugin pendiente');
  else parts.push('Plugin deshabilitado');
  if (profile?.blueMap?.configured) parts.push('BlueMap');
  if (profile?.squareMap?.configured) parts.push('squaremap');
  return parts.join(' · ');
}
function renderServerManagement() {
  const container = $('serverManagementList');
  const meta = $('serverOverviewMeta');
  const details = $('serverDetailsPanel');
  const activeProfile = currentServerProfile();

  if (meta) {
    const craftyCount = state.servers.filter((profile) => serverOriginType(profile) === 'crafty').length;
    const manualCount = state.servers.length - craftyCount;
    meta.textContent = `${state.servers.length} configured server(s) · ${craftyCount} Crafty · ${manualCount} manual`;
  }

  show(details, Boolean(state.serverEditorOpen && activeProfile));
  if ($('serverDetailsTitle') && activeProfile) {
    $('serverDetailsTitle').textContent = activeProfile.name;
  }

  if (!container) return;
  container.textContent = '';

  if (!state.servers.length) {
    const empty = document.createElement('div');
    empty.className = 'server-management-empty';
    empty.innerHTML = '<strong>No servers yet</strong><span>Add a server using a direct connection or import it from Crafty.</span>';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'primary';
    add.textContent = 'Add Server';
    add.addEventListener('click', () => openAddServerWizard());
    empty.append(add);
    container.append(empty);
    return;
  }

  for (const profile of state.servers) {
    const selected = Boolean(
      state.serverEditorOpen && Number(profile.id) === Number(state.currentServerId)
    );
    const source = serverOriginType(profile);

    const card = document.createElement('button');
    card.type = 'button';
    card.className = `server-management-card server-management-row${selected ? ' is-selected' : ''}`;
    card.dataset.source = source;
    card.dataset.serverProfileId = String(profile.id);
    card.setAttribute('aria-expanded', selected ? 'true' : 'false');
    card.addEventListener('click', () => openServerEditor(profile.id));

    const identity = document.createElement('span');
    identity.className = 'server-management-identity';

    const titleLine = document.createElement('span');
    titleLine.className = 'server-management-title-line';
    const title = document.createElement('strong');
    title.textContent = profile.name;
    titleLine.append(title);

    if (profile.isDefault) {
      const defaultBadge = document.createElement('span');
      defaultBadge.className = 'server-default-badge';
      defaultBadge.textContent = 'Principal';
      titleLine.append(defaultBadge);
    }

    const origin = document.createElement('span');
    origin.className = 'server-origin-badge';
    origin.dataset.source = source;
    origin.textContent = serverOriginLabel(profile);
    identity.append(titleLine, origin);

    const connection = document.createElement('span');
    connection.className = 'server-management-connection';
    const connectionText = document.createElement('span');
    connectionText.textContent = serverConnectionSummary(profile);
    const identifier = document.createElement('code');
    identifier.textContent = source === 'crafty' && profile.crafty?.serverId
      ? profile.crafty.serverId
      : `Profile ${profile.id}`;
    connection.append(connectionText, identifier);

    const status = document.createElement('span');
    status.className = 'server-management-status';
    const plugin = document.createElement('span');
    plugin.className = `server-status-chip ${profile.plugin?.configured ? 'ok' : 'pending'}`;
    plugin.textContent = profile.plugin?.configured ? 'Plugin connected' : 'Plugin pendiente';
    status.append(plugin);
    if (source === 'crafty') {
      const crafty = document.createElement('span');
      crafty.className = `server-status-chip ${profile.crafty?.configured ? 'ok' : 'pending'}`;
      crafty.textContent = profile.crafty?.configured ? 'Crafty linked' : 'Crafty pending';
      status.append(crafty);
    }

    const arrow = document.createElement('span');
    arrow.className = 'server-management-arrow';
    arrow.textContent = selected ? '▾' : '›';
    arrow.setAttribute('aria-hidden', 'true');

    card.append(identity, connection, status, arrow);
    container.append(card);
  }
}

async function openServerEditor(profileId) {
  const resolved = Number(profileId || 0);
  if (!resolved) return;

  if (resolved !== Number(state.currentServerId)) {
    await switchServer(resolved, { silent: true });
  }

  state.serverEditorOpen = true;
  document.body.classList.add('server-details-modal-open');
  renderServerManagement();

  requestAnimationFrame(() => {
    const panel = $('serverDetailsPanel');
    if (panel) panel.scrollTop = 0;
    $('closeServerDetailsBtn')?.focus();
  });
}

function closeServerEditor({ restoreFocus = true } = {}) {
  const selectedId = Number(state.currentServerId || 0);
  state.serverEditorOpen = false;
  document.body.classList.remove('server-details-modal-open');
  renderServerManagement();

  if (restoreFocus && selectedId) {
    requestAnimationFrame(() => {
      document.querySelector(`[data-server-profile-id="${selectedId}"]`)?.focus();
    });
  }
}

function setConnectionOnboardingStep(mode = '') {
  show($('connectionOnboardingChoices'), !mode);
  show($('connectionOnboardingManual'), mode === 'manual');
}

function openConnectionOnboarding(force = false) {
  if (!hasPermission('system.settings')) return toast('You do not have permission to configure connections', true);
  if (!force && !state.onboarding?.required) return;
  const profile = currentServerProfile();
  if ($('onboardingManualName')) $('onboardingManualName').value = profile?.name || 'Primary server';
  if ($('onboardingManualUrl')) $('onboardingManualUrl').value = profile?.plugin?.apiUrl || '';
  if ($('onboardingManualToken')) $('onboardingManualToken').value = '';
  if ($('onboardingManualVerifyTls')) $('onboardingManualVerifyTls').checked = profile?.plugin?.verifyTls !== false;
  if ($('onboardingManualStatus')) $('onboardingManualStatus').textContent = 'Enter the plugin URL and token.';
  const preferred = state.onboarding?.preferredMode || 'choose';
  document.querySelectorAll('[data-onboarding-mode]').forEach((button) => {
    button.classList.toggle('recommended', button.dataset.onboardingMode === preferred || (preferred === 'choose' && button.dataset.onboardingMode === 'manual'));
  });
  setConnectionOnboardingStep(preferred === 'manual' ? 'manual' : '');
  const dialog = $('connectionOnboardingDialog');
  if (dialog && !dialog.open) dialog.showModal();
}

function closeConnectionOnboarding() {
  const dialog = $('connectionOnboardingDialog');
  if (dialog?.open) dialog.close();
}

function maybeShowConnectionOnboarding() {
  if (!hasPermission('system.settings')) return;
  if (!state.servers.length) {
    window.setTimeout(() => openAddServerWizard(), 250);
    return;
  }
  if (!state.onboarding?.required) return;
  window.setTimeout(() => openConnectionOnboarding(false), 250);
}

async function completeConnectionOnboarding(mode) {
  const data = await request('/api/local/onboarding/complete', {
    method: 'POST', body: JSON.stringify({ mode })
  });
  state.onboarding = data.onboarding || { required: false, completed: true, preferredMode: mode };
  state.onboardingActive = false;
  return data;
}

async function saveOnboardingManualConnection() {
  const button = $('saveOnboardingManualBtn');
  const status = $('onboardingManualStatus');
  const name = $('onboardingManualName').value.trim() || 'Primary server';
  const apiUrl = $('onboardingManualUrl').value.trim();
  const apiToken = $('onboardingManualToken').value.trim();
  if (!apiUrl || !apiToken) return toast('Enter the plugin URL and token', true);
  button.disabled = true;
  status.textContent = 'Saving and testing the connection…';
  try {
    const profile = currentServerProfile();
    if (profile && name !== profile.name) {
      const profileData = await request('/api/local/servers/save', {
        method: 'POST', body: JSON.stringify(profileSavePayload(profile, { name, sourceType: 'manual' }))
      });
      if (Array.isArray(profileData.servers)) state.servers = profileData.servers;
    }
    const data = await request('/api/local/system/connections', {
      method: 'POST',
      body: JSON.stringify({
        type: 'plugin', enabled: true, apiUrl, apiToken,
        accessClientId: '', accessClientSecret: '', verifyTls: $('onboardingManualVerifyTls').checked
      })
    });
    applyConnectionSaveResponse(data);
    const available = Boolean(data.plugin?.available);
    status.textContent = available
      ? 'Connection verified. The panel is ready to use.'
      : diagnosticMessage(data.plugin || {}, '', 'The configuration was saved, but the plugin did not respond.');
    if (!available) return toast('Configuration saved; review the connection before continuing', true);
    await completeConnectionOnboarding('manual');
    closeConnectionOnboarding();
    await loadSystem(true);
    toast('Direct connection configured');
  } catch (error) {
    status.textContent = error.message;
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function startOnboardingCrafty() {
  state.onboardingActive = true;
  state.onboardingInitialProfileId = Number(currentServerProfile()?.id || 0);
  closeConnectionOnboarding();
  await openAddServerWizard('crafty');
}

async function skipConnectionOnboarding() {
  try {
    await completeConnectionOnboarding('later');
    closeConnectionOnboarding();
    toast('You can open the wizard from System → Servers');
  } catch (error) { toast(error.message, true); }
}

async function cleanupOnboardingPlaceholderProfile() {
  const initialId = Number(state.onboardingInitialProfileId || 0);
  if (!initialId || state.servers.length <= 1) return;
  const initial = state.servers.find((profile) => Number(profile.id) === initialId);
  if (!initial) return;
  const empty = !initial.plugin?.enabled && !initial.plugin?.configured && !initial.crafty?.configured && !initial.crafty?.connectionId;
  if (!empty) return;
  try {
    const data = await request('/api/local/servers/delete', { method: 'POST', body: JSON.stringify({ id: initialId }) });
    if (Array.isArray(data.servers)) state.servers = data.servers;
    if (Number(data.selectedServerId || 0)) state.currentServerId = Number(data.selectedServerId);
    renderServerSelector();
  } catch (_) { /* keep the placeholder if it cannot be removed */ }
}

function setAddServerWizardStep(method = '') {
  state.addServerMethod = method;
  show($('addServerMethodStep'), !method);
  show($('addServerCraftyStep'), method === 'crafty');
  show($('addServerManualStep'), method === 'manual');
  const subtitle = $('addServerWizardSubtitle');
  if (subtitle) {
    subtitle.textContent = !method
      ? 'Choose how to connect the server.'
      : method === 'crafty'
        ? 'Discover and import servers through a Crafty installation.'
        : 'Configure a direct plugin connection.';
  }
}
function populateWizardCraftyConnections() {
  const select = $('wizardCraftyConnectionSelect');
  if (!select) return;
  const current = String(state.wizardCraftyConnectionId || select.value || '');
  select.textContent = '';

  const newOption = document.createElement('option');
  newOption.value = 'new';
  newOption.textContent = '+ New Crafty connection';
  select.append(newOption);

  for (const connection of state.craftyConnections) {
    const option = document.createElement('option');
    option.value = String(connection.id);
    option.textContent = `${connection.name}${connection.configured ? '' : ' · incomplete'}`;
    select.append(option);
  }

  select.value = [...select.options].some((option) => option.value === current)
    ? current
    : String(state.craftyConnections[0]?.id || 'new');
  renderWizardCraftyLogin();
}

function wizardSelectedCraftyConnection() {
  const id = Number($('wizardCraftyConnectionSelect')?.value || 0);
  return state.craftyConnections.find((connection) => Number(connection.id) === id) || null;
}

function renderWizardCraftyLogin() {
  const selected = wizardSelectedCraftyConnection();
  const isNew = !selected;

  state.wizardCraftyConnectionId = selected?.id || 0;
  $('wizardCraftyName').value = selected?.name || (isNew ? 'Primary Crafty' : '');
  $('wizardCraftyApiUrl').value = selected?.apiUrl || (isNew ? 'https://host.docker.internal:8443' : '');
  $('wizardCraftyUsername').value = selected?.username || '';
  $('wizardCraftyPassword').value = '';
  $('wizardCraftyPassword').placeholder = selected?.passwordConfigured
    ? 'Configured; leave blank to keep it'
    : 'Enter the API password';
  $('wizardCraftyToken').value = '';
  $('wizardCraftyToken').placeholder = selected?.apiTokenConfigured
    ? 'Configured; leave blank to keep it'
    : 'Enter an API token';
  $('wizardCraftyPanelUrl').value = selected?.panelUrl || '';
  $('wizardCraftyVerifyTls').checked = Boolean(selected?.verifyTls);
  $('wizardCraftyLoginStatus').textContent = selected
    ? 'Select “Sign in and find servers” to use this connection.'
    : 'Enter credentials for a new Crafty installation.';
  show($('wizardCraftyLoginPanel'), true);
  show($('wizardCraftyResultsPanel'), false);
}

function resetAddServerWizard() {
  state.addServerDiscovery = [];
  state.addServerBusy = false;
  state.wizardCraftyConnectionId = 0;
  setAddServerWizardStep('');
  populateWizardCraftyConnections();
  if ($('wizardCraftyServerList')) $('wizardCraftyServerList').textContent = '';
  if ($('wizardImportCraftyBtn')) $('wizardImportCraftyBtn').disabled = true;
  for (const id of [
    'wizardManualName', 'wizardManualPluginToken',
    'wizardManualBlueMapUrl', 'wizardManualBlueMapId', 'wizardManualSquareMapUrl'
  ]) {
    if ($(id)) $(id).value = '';
  }
  if ($('wizardManualPluginUrl')) $('wizardManualPluginUrl').value = '';
  if ($('wizardManualSquareMapWorld')) $('wizardManualSquareMapWorld').value = 'minecraft:overworld';
  if ($('wizardManualVerifyTls')) $('wizardManualVerifyTls').checked = true;
  if ($('wizardManualStatus')) $('wizardManualStatus').textContent = 'The server will be created as a manual profile.';
}

async function openAddServerWizard(preferredMethod = '') {
  if (!hasPermission('system.settings')) return toast('You do not have permission to add servers', true);
  await loadCraftyConnections({ silent: true });
  resetAddServerWizard();
  if (preferredMethod) setAddServerWizardStep(preferredMethod);
  const dialog = $('addServerWizardDialog');
  if (dialog && !dialog.open) dialog.showModal();
}

function closeAddServerWizard() {
  const dialog = $('addServerWizardDialog');
  if (dialog?.open) dialog.close();
}

function renderWizardCraftyServers(servers = []) {
  state.addServerDiscovery = Array.isArray(servers) ? servers : [];
  const container = $('wizardCraftyServerList');
  if (!container) return;
  container.textContent = '';

  for (const server of state.addServerDiscovery) {
    const row = document.createElement('label');
    row.className = `wizard-crafty-server${server.running ? ' is-running' : ''}`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = server.id;
    checkbox.dataset.wizardCraftyServer = '1';
    checkbox.addEventListener('change', () => {
      $('wizardImportCraftyBtn').disabled =
        !document.querySelector('[data-wizard-crafty-server]:checked');
    });

    const info = document.createElement('span');
    info.className = 'wizard-crafty-server-info';
    const title = document.createElement('strong');
    title.textContent = server.name;
    const meta = document.createElement('small');
    meta.textContent = `${server.id} · ${server.type || 'Minecraft'}`;
    info.append(title, meta);

    const status = document.createElement('span');
    status.className = 'wizard-server-state';
    const rawStatus = String(server.status || '').trim().toLowerCase();
    const statusLabels = {
      running: 'Online',
      online: 'Online',
      stopped: 'Stopped',
      offline: 'Stopped',
      starting: 'Starting',
      stopping: 'Stopping',
      restarting: 'Restarting',
      unknown: 'Status not reported'
    };
    status.textContent = server.running
      ? 'Online'
      : (statusLabels[rawStatus] || (rawStatus ? server.status : 'Status not reported'));

    row.append(checkbox, info, status);
    container.append(row);
  }

  $('wizardImportCraftyBtn').disabled = true;
}

async function wizardCraftyLoginAndDiscover() {
  const button = $('wizardCraftyLoginBtn');
  button.disabled = true;
  $('wizardCraftyLoginStatus').textContent = 'Signing in and querying servers…';

  const selected = wizardSelectedCraftyConnection();
  const body = {
    id: selected?.id || 0,
    name: $('wizardCraftyName').value.trim(),
    apiUrl: normalizeAddressField('wizardCraftyApiUrl', 'crafty'),
    username: $('wizardCraftyUsername').value.trim(),
    password: $('wizardCraftyPassword').value,
    apiToken: $('wizardCraftyToken').value.trim(),
    panelUrl: normalizeAddressField('wizardCraftyPanelUrl', 'craftyPublic'),
    verifyTls: $('wizardCraftyVerifyTls').checked,
    test: true
  };

  try {
    const data = await request('/api/local/crafty/connections/save', {
      method: 'POST',
      body: JSON.stringify(body)
    });

    state.craftyConnections = data.connections || state.craftyConnections;
    state.wizardCraftyConnectionId = Number(data.connection?.id || 0);
    populateWizardCraftyConnections();
    $('wizardCraftyConnectionSelect').value = String(state.wizardCraftyConnectionId);

    const discovery = data.discovery || {};
    if (!discovery.available) {
      throw new Error(
        discovery.message
        || diagnosticMessage(discovery, '', 'Crafty did not respond correctly')
      );
    }

    renderWizardCraftyServers(discovery.servers || []);
    $('wizardCraftyDiscoveryStatus').textContent = discovery.count
      ? `${discovery.count} server(s) available · ${Number(discovery.latencyMs || 0).toFixed(0)} ms.`
      : 'The account signed in, but no servers are visible.';
    show($('wizardCraftyLoginPanel'), false);
    show($('wizardCraftyResultsPanel'), true);
  } catch (error) {
    $('wizardCraftyLoginStatus').textContent = error.message;
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function wizardImportCraftyServers() {
  const connectionId = Number(state.wizardCraftyConnectionId || 0);
  const serverIds = [...document.querySelectorAll('[data-wizard-crafty-server]:checked')]
    .map((input) => input.value);

  if (!connectionId || !serverIds.length) return toast('Select at least one server', true);

  const button = $('wizardImportCraftyBtn');
  button.disabled = true;
  try {
    const data = await request('/api/local/crafty/connections/import', {
      method: 'POST',
      body: JSON.stringify({ id: connectionId, serverIds })
    });

    state.servers = data.servers || state.servers;
    const selectedId = Number(data.imported?.[0]?.id || state.servers[0]?.id || 0);
    renderServerSelector();
    closeAddServerWizard();
    if (state.onboardingActive || state.onboarding?.required) {
      await cleanupOnboardingPlaceholderProfile();
      await completeConnectionOnboarding('crafty');
    }
    if (selectedId) await switchServer(selectedId, { silent: true });
    state.serverEditorOpen = false;
    setView('servers');
    renderServerManagement();
    toast(`${data.imported?.length || 0} server(s) added${data.skipped?.length ? ` · ${data.skipped.length} already existed` : ''}`);
  } catch (error) {
    toast(error.message, true);
    $('wizardCraftyDiscoveryStatus').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function wizardCreateManualServer() {
  const name = $('wizardManualName').value.trim();
  const pluginUrl = normalizeAddressField('wizardManualPluginUrl', 'plugin');
  const pluginToken = $('wizardManualPluginToken').value.trim();
  const blueMapUrl = normalizeAddressField('wizardManualBlueMapUrl', 'bluemap');
  const squareMapUrl = normalizeAddressField('wizardManualSquareMapUrl', 'squaremap');
  const button = $('wizardCreateManualBtn');
  button.disabled = true;
  $('wizardManualStatus').textContent = 'Creating and checking the profile…';
  const payload = {
    name,
    isDefault: false,
    sourceType: 'manual',
    plugin: {
      enabled: true,
      apiUrl: pluginUrl,
      apiToken: pluginToken,
      verifyTls: $('wizardManualVerifyTls').checked
    },
    crafty: { enabled: false, connectionId: 0, serverId: '' },
    blueMap: {
      enabled: Boolean(blueMapUrl),
      url: blueMapUrl,
      mapId: $('wizardManualBlueMapId').value.trim()
    },
    squareMap: {
      enabled: Boolean(squareMapUrl),
      url: squareMapUrl,
      worldId: $('wizardManualSquareMapWorld').value.trim() || 'minecraft:overworld'
    }
  };
  try {
    const data = await request('/api/local/servers/save', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    state.servers = data.servers || state.servers;
    renderServerSelector();
    closeAddServerWizard();
    if (state.onboarding?.required) await completeConnectionOnboarding('manual');
    await switchServer(data.selectedServerId, { silent: true });
    state.serverEditorOpen = true;
    setView('servers');
    await loadSystem(true);
    renderServerManagement();
    toast('Server manual creado');
  } catch (error) {
    $('wizardManualStatus').textContent = error.message;
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderServerProfileManager() {
  const profile = currentServerProfile();
  if (!profile || !$('systemServerName')) return;
  setGuardedValue('systemServerName', profile.name || '', 'system-profile');
  setGuardedChecked('systemServerDefault', profile.isDefault, 'system-profile');
  const sourceType = profile.sourceType || (profile.crafty?.connectionId ? 'crafty' : 'manual');
  $('systemServerProfileMeta').textContent = `${state.servers.length} server${state.servers.length === 1 ? '' : 's'} configured · ID ${profile.id}`;
  const sourceBadge = $('systemServerSourceBadge');
  if (sourceBadge) {
    sourceBadge.textContent = sourceType === 'crafty'
      ? `Crafty${profile.crafty?.connectionName ? ` · ${profile.crafty.connectionName}` : ''}`
      : 'Manual configuration';
    sourceBadge.dataset.source = sourceType;
  }
  $('deleteServerProfileBtn').disabled = state.servers.length <= 1;
  renderServerManagement();
}
function profileSavePayload(profile, overrides = {}) {
  return {
    id: profile?.id || 0,
    name: overrides.name ?? profile?.name ?? 'New server',
    isDefault: overrides.isDefault ?? Boolean(profile?.isDefault),
    sourceType: overrides.sourceType ?? profile?.sourceType ?? (profile?.crafty?.connectionId ? 'crafty' : 'manual'),
    plugin: { enabled: Boolean(profile?.plugin?.enabled), apiUrl: profile?.plugin?.apiUrl || 'http://crafty-controller:8765', apiToken: '', verifyTls: profile?.plugin?.verifyTls !== false },
    crafty: { enabled: Boolean(profile?.crafty?.enabled), connectionId: Number(profile?.crafty?.connectionId || 0), serverId: profile?.crafty?.serverId || '' },
    blueMap: { enabled: Boolean(profile?.blueMap?.enabled), url: profile?.blueMap?.url || '', mapId: profile?.blueMap?.mapId || '' },
    squareMap: { enabled: Boolean(profile?.squareMap?.enabled), url: profile?.squareMap?.url || '', worldId: profile?.squareMap?.worldId || 'minecraft:overworld' }
  };
}
async function saveServerProfileIdentity() {
  const profile = currentServerProfile(); if (!profile) return;
  try {
    const data = await request('/api/local/servers/save', { method: 'POST', body: JSON.stringify(profileSavePayload(profile, { name: $('systemServerName').value.trim(), isDefault: $('systemServerDefault').checked })) });
    state.servers = data.servers || state.servers; state.currentServerId = Number(data.selectedServerId || state.currentServerId); state.connections = profileConnections(); clearScopeDirty('system-profile');
    renderServerSelector(); renderServerProfileManager(); toast('Server saved');
  } catch (error) { toast(error.message, true); }
}
function createServerProfile() {
  openAddServerWizard();
}

async function deleteCurrentServerProfile() {
  const profile = currentServerProfile(); if (!profile || state.servers.length <= 1) return;
  if (!confirm(`Delete the configuration for ${profile.name}? Associated historical data will not be deleted.`)) return;
  try {
    const data = await request('/api/local/servers/delete', { method: 'POST', body: JSON.stringify({ id: profile.id }) });
    state.servers = data.servers || []; state.currentServerId = Number(data.selectedServerId || state.servers[0]?.id || 0); localStorage.setItem(SERVER_STORAGE_KEY, String(state.currentServerId));
    state.connections = profileConnections();
    closeServerEditor({ restoreFocus: false });
    renderServerSelector();
    await loadSystem(true);
    await refreshAll();
    stopRealtime();
    startRealtime();
    toast('Server deleted');
  } catch (error) { toast(error.message, true); }
}
function loadBlueMap(force = false) {
  const profile = currentServerProfile(); const blueMap = profile?.blueMap || state.connections?.blueMap || {};
  const frame = $('blueMapFrame'); const empty = $('blueMapEmpty'); const shell = $('blueMapFrameShell'); const open = $('openBlueMapBtn');
  if (!frame || !empty || !shell) return;
  const configured = Boolean(blueMap.configured && blueMap.url);
  show(empty, !configured); show(shell, configured); show(open, configured);
  if (!configured) { frame.removeAttribute('src'); state.blueMapLoadedUrl = ''; return; }
  const url = String(blueMap.url || '').replace(/\/$/, '');
  if (force || state.blueMapLoadedUrl !== url) { frame.src = url; state.blueMapLoadedUrl = url; }
  open.href = url; $('blueMapTitle').textContent = `BlueMap · ${profile?.name || 'Server'}`;
  $('blueMapMeta').textContent = blueMap.mapId ? `Preferred map: ${blueMap.mapId}` : 'Live web map';
}
function renderSystem(data) {
  state.system = data;
  const app = data.application || {}; const plugin = data.plugin || {}; const crafty = data.crafty || {}; const db = data.database || {}; const disk = data.disk || {}; const push = data.push || {}; const runtime = data.runtime || {}; const settings = data.settings || {}; const connections = data.connections || {};
  renderConnectionSettings(connections, plugin, crafty);
  setSystemCard('systemAppStatus', 'systemAppMeta', `v${app.version || '—'}`, `${app.python ? `Python ${app.python}` : 'Python'} · active ${formatDuration(app.uptimeSeconds)}`, true);
  setSystemCard('systemPluginStatus', 'systemPluginMeta', statusText(plugin.available), plugin.data?.version || `HTTP ${plugin.status || '—'}`, Boolean(plugin.available));
  setSystemCard('systemCraftyStatus', 'systemCraftyMeta', statusText(crafty.available), crafty.available ? 'Crafty API reachable' : (crafty.error || 'No response'), Boolean(crafty.available));
  const dbOk = String(db.integrity || '').toLowerCase() === 'ok';
  setSystemCard('systemDbStatus', 'systemDbMeta', dbOk ? 'Healthy' : 'Review', `${formatBytes(db.size)} · ${Object.values(db.tables || {}).reduce((sum, value) => sum + safeNumber(value), 0)} records`, dbOk);
  const diskOk = safeNumber(disk.percent) < 90;
  setSystemCard('systemDiskStatus', 'systemDiskMeta', `${safeNumber(disk.percent).toFixed(1)}% used`, `${formatBytes(disk.free)} free of ${formatBytes(disk.total)}`, diskOk);
  setSystemCard('systemPushStatus', 'systemPushMeta', push.vapidReady && push.publicKeyReady ? 'Ready' : 'Incomplete', `${safeNumber(db.tables?.push_subscriptions)} devices · queue ${safeNumber(push.queueSize)}`, Boolean(push.vapidReady && push.publicKeyReady));
  fillDefinitionList($('systemDatabaseDetails'), [
    ['SQLite integrity', db.integrity || '—'], ['Data file', db.path || '—'], ['Current size', formatBytes(db.size)],
    ['Panel users', String(db.tables?.users ?? 0)], ['Active web sessions', String(db.tables?.web_sessions ?? 0)], ['Devices with Web Push', String(db.tables?.push_subscriptions ?? 0)],
    ['Metric samples', String(db.tables?.metrics ?? 0)], ['Audit records', String(db.tables?.audit ?? 0)], ['Stored alerts', String(db.tables?.alerts ?? 0)], ['Minecraft sessions', String(db.tables?.sessions ?? 0)]
  ]);
  fillDefinitionList($('systemRuntimeDetails'), [
    ['Operating system', `${app.platform || '—'} (${app.architecture || '—'})`], ['Active time zone', app.timezone || '—'], ['Panel process', `PID ${app.pid || '—'}`],
    ['Player refresh', `${runtime.monitorIntervalSeconds || '—'} s`], ['Adapter events', `${runtime.pluginEventIntervalSeconds || '—'} s`], ['SSE heartbeat', `${runtime.liveHeartbeatSeconds || '—'} s`], ['Metrics sampling', `${runtime.metricsSampleIntervalSeconds || '—'} s`],
    ['Maximum session duration', formatDuration(runtime.sessionTtlSeconds)], ['Secure HTTPS cookie', formatBool(runtime.cookieSecure)], ['Trusted proxy headers', formatBool(runtime.trustProxy)], ['Trusted proxy networks', Array.isArray(runtime.trustedProxyCidrs) && runtime.trustedProxyCidrs.length ? runtime.trustedProxyCidrs.join(', ') : (runtime.trustProxy ? 'Compatibility: any source' : 'Not applicable')]
  ]);
  const tbody = $('systemSecretsTable'); if (tbody) { tbody.textContent = ''; for (const secret of data.secrets || []) {
    const tr = document.createElement('tr'); const cells = [secret.name, secret.configured ? 'Yes' : 'No', secret.file || 'Environment variable', secret.mode || '—'];
    for (const value of cells) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
    const status = document.createElement('td'); const pill = document.createElement('span'); pill.className = `result-pill ${secret.safe !== false ? 'success' : 'error'}`; pill.textContent = secret.safe !== false ? 'Seguro' : 'Review'; status.append(pill); tr.append(status); tbody.append(tr);
  }}
  setGuardedValue('systemMetricsRetention', settings.metricsRetentionDays ?? 30, 'system-retention');
  setGuardedValue('systemBackupRetention', settings.backupRetention ?? 10, 'system-retention');
  setGuardedValue('systemAuditRetention', settings.auditRetentionDays ?? 180, 'system-retention');
  setGuardedValue('systemAlertRetention', settings.alertRetentionDays ?? 90, 'system-retention');
  populateTimeZoneSelect(settings.timezone || state.timeZone || 'UTC');
  renderServerProfileManager();
  renderSystemBackups(data.backups || []);
}
async function loadSystem(force = false) {
  if (!hasPermission('system.view')) return;
  if (!force && Date.now() - state.systemLastLoad < 10000) return;
  try {
    const data = await request('/api/local/system');
    state.systemLastLoad = Date.now();
    renderSystem(data);
    await loadCraftyConnections({
      silent: true,
      selectedId: state.connections?.crafty?.connectionId || 0
    });
  }
  catch (error) { toast(`Diagnostics: ${error.message}`, true); }
}
async function createSystemBackup() {
  if (!confirm('The backup will include credentials and private keys. Create an internal backup now?')) return;
  const button = $('createSystemBackupBtn'); button.disabled = true;
  try { const data = await request('/api/local/system/backup', { method: 'POST', body: '{}' }); toast(`Backup created: ${data.backup.name}`); state.system.backups = data.backups || []; renderSystemBackups(state.system.backups); }
  catch (error) { toast(error.message, true); } finally { button.disabled = false; }
}
async function deleteSystemBackup(name) {
  if (!confirm(`Permanently delete ${name}?`)) return;
  try { const data = await request('/api/local/system/backups/delete', { method: 'POST', body: JSON.stringify({ name }) }); toast('Backup deleted'); state.system.backups = data.backups || []; renderSystemBackups(state.system.backups); }
  catch (error) { toast(error.message, true); }
}
async function restoreSystemBackup(name) {
  const confirmation = prompt(`Restore ${name} will replace users, history, metrics, and Push subscriptions.\n\nType RESTORE to continue:`);
  if (confirmation !== 'RESTORE') return toast('Restore cancelled');
  try {
    const data = await request('/api/local/system/restore', { method: 'POST', body: JSON.stringify({ name, confirmation }) });
    alert(`${data.message}\nA rollback backup was created: ${data.restore.rollback}`);
    window.location.href = '/';
  } catch (error) { toast(error.message, true); }
}
async function runSystemMaintenance() {
  if (!confirm('Expired data will be deleted and SQLite will be compacted. The panel may take a few seconds.')) return;
  const button = $('runSystemMaintenanceBtn'); button.disabled = true; $('systemMaintenanceResult').textContent = 'Running maintenance…';
  try {
    const data = await request('/api/local/system/maintenance', { method: 'POST', body: '{}' }); const result = data.maintenance || {};
    const removed = result.removed || {}; $('systemMaintenanceResult').textContent = `Completed: ${Object.values(removed).reduce((sum, value) => sum + safeNumber(value), 0)} expired records removed. SQLite: ${formatBytes(result.databaseSize)}.`;
    renderSystem(data.diagnostics); toast('Maintenance completed');
  } catch (error) { $('systemMaintenanceResult').textContent = error.message; toast(error.message, true); } finally { button.disabled = false; }
}
async function saveSystemSettings() {
  const body = {
    metricsRetentionDays: safeNumber($('systemMetricsRetention').value, 30), backupRetention: safeNumber($('systemBackupRetention').value, 10),
    auditRetentionDays: safeNumber($('systemAuditRetention').value, 180), alertRetentionDays: safeNumber($('systemAlertRetention').value, 90),
    timezone: $('systemTimezone').value || state.timeZone || 'UTC'
  };
  try { const data = await request('/api/local/system/settings', { method: 'POST', body: JSON.stringify(body) }); Object.assign(state.system.settings || {}, data.settings || {}); state.timeZone = data.settings?.timezone || state.timeZone; clearScopeDirty('system-retention'); toast('Ajustes guardados'); await loadSystem(true); }
  catch (error) { toast(error.message, true); }
}

function historyResultPresentation(value) {
  const key = String(value || 'unknown').trim().toLowerCase();
  const map = {
    success: ['Successful', 'success'],
    ok: ['Successful', 'success'],
    recorded: ['Registrado', 'recorded'],
    error: ['Error', 'error'],
    failed: ['Error', 'error'],
    denied: ['Denegado', 'denied'],
    forbidden: ['Denegado', 'denied'],
    unknown: ['Unknown', 'unknown']
  };
  const [label, className] = map[key] || [key || 'Unknown', 'unknown'];
  return { key, label, className };
}

function renderHistory() {
  const tbody = $('historyTable');
  const mobileList = $('historyMobileList');
  tbody.textContent = '';
  if (mobileList) mobileList.textContent = '';
  show($('emptyHistory'), state.history.length === 0);
  for (const item of state.history) {
    const details = typeof item.details === 'object' ? JSON.stringify(item.details) : String(item.details || '');
    const player = item.player_name || item.player_uuid || '—';
    const resultText = item.result || 'unknown';
    const resultPresentation = historyResultPresentation(resultText);
    const ts = formatDate(item.ts);

    const tr = document.createElement('tr');
    const values = [ts, item.actor || 'system', item.category, item.action, player];
    for (const value of values) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }
    const result = document.createElement('td');
    result.className = 'history-result-cell';
    const pill = document.createElement('span');
    pill.className = `result-pill ${resultPresentation.className}`;
    pill.textContent = resultPresentation.label;
    pill.title = resultText;
    result.append(pill);
    tr.append(result);
    const detailTd = document.createElement('td');
    detailTd.textContent = details.length > 160 ? `${details.slice(0, 157)}…` : details;
    detailTd.title = details;
    tr.append(detailTd);
    tbody.append(tr);

    if (mobileList) {
      const entry = document.createElement('details');
      entry.className = 'history-mobile-entry';
      const summary = document.createElement('summary');
      summary.className = 'history-mobile-summary';
      const head = document.createElement('div');
      head.className = 'history-mobile-head';
      const title = document.createElement('strong');
      title.textContent = `${item.action || 'action'} · ${player}`;
      const meta = document.createElement('small');
      meta.textContent = `${ts} · ${item.actor || 'system'} · ${item.category || '—'}`;
      head.append(title, meta);
      const summaryPill = document.createElement('span');
      summaryPill.className = `result-pill ${resultPresentation.className}`;
      summaryPill.textContent = resultPresentation.label;
      summaryPill.title = resultText;
      summary.append(head, summaryPill);

      const body = document.createElement('div');
      body.className = 'history-mobile-body';
      const rows = [
        ['Date', ts],
        ['User', item.actor || 'system'],
        ['Category', item.category || '—'],
        ['Action', item.action || '—'],
        ['Player', player],
        ['Result', resultPresentation.label],
        ['Detalle', details || '—']
      ];
      for (const [label, value] of rows) {
        const row = document.createElement('div');
        row.className = 'history-mobile-row';
        const key = document.createElement('span');
        key.textContent = label;
        const val = document.createElement('strong');
        val.textContent = value;
        row.append(key, val);
        body.append(row);
      }
      entry.append(summary, body);
      mobileList.append(entry);
    }
  }
}
async function loadSessions() { try { const data = await request('/api/local/sessions?limit=150'); state.sessions = data.sessions || []; renderSessions(); } catch (error) { toast(error.message, true); } }
function renderSessions() {
  const tbody = $('sessionsTable'); tbody.textContent = ''; show($('emptyHistorySessions'), state.sessions.length === 0); const now = Math.floor(Date.now() / 1000);
  for (const item of state.sessions) { const tr = document.createElement('tr'); const values = [item.player_name, formatDate(item.joined_at), item.left_at ? formatDate(item.left_at) : 'Connected', formatDuration((item.left_at || now) - item.joined_at), item.world || '—']; for (const value of values) { const td = document.createElement('td'); td.textContent = value; tr.append(td); } tbody.append(tr); }
}


function accountInitials(user) {
  const value = String(user?.displayName || user?.username || 'U').trim();
  const parts = value.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : value.slice(0, 2)).toUpperCase();
}
function renderAccountIdentity() {
  const user = state.user || {};
  if ($('accountIdentityAvatar')) $('accountIdentityAvatar').textContent = accountInitials(user);
  if ($('accountIdentityName')) $('accountIdentityName').textContent = user.displayName || user.username || 'User';
  if ($('accountIdentityUsername')) $('accountIdentityUsername').textContent = user.username ? `@${user.username}` : 'Panel account';
  if ($('accountRoleBadge')) $('accountRoleBadge').textContent = user.roleLabel || user.role || 'User';
}
function setAccountsTab(name = 'self') {
  const allowed = name === 'admin' && hasPermission('users.manage') ? 'admin' : 'self';
  state.accountTab = allowed;
  show($('accountSelfSection'), allowed === 'self');
  show($('accountAdminSection'), allowed === 'admin');
  document.querySelectorAll('[data-account-tab]').forEach((button) => {
    const active = button.dataset.accountTab === allowed;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
}

function resetUserForm() {
  clearScopeDirty('user-editor');
  $('panelUserId').value = ''; $('panelUsername').value = ''; $('panelDisplayName').value = ''; $('panelRole').value = 'viewer'; $('panelPassword').value = ''; $('panelActive').checked = true;
  $('userFormTitle').textContent = 'New user'; show($('deletePanelUserBtn'), false); show($('revokeUserSessionsBtn'), false);
  document.querySelectorAll('#allowPermissions input, #denyPermissions input').forEach((input) => { input.checked = false; });
}
function permissionLabel(name) { return name.replaceAll('.', ' · ').replaceAll('_', ' '); }
function renderPermissionLists() {
  for (const [id, type] of [['allowPermissions', 'allow'], ['denyPermissions', 'deny']]) {
    const box = $(id); box.textContent = '';
    for (const permission of state.availablePermissions) { const label = document.createElement('label'); label.className = 'permission-check'; const input = document.createElement('input'); input.type = 'checkbox'; input.value = permission; input.dataset.override = type; input.addEventListener('change', () => markScopeDirty('user-editor')); input.dataset.draftGuardBound = '1'; const span = document.createElement('span'); span.textContent = permissionLabel(permission); label.append(input, span); box.append(label); }
  }
}
async function loadUsers() {
  if (!hasPermission('users.manage')) { renderAccountState(); return; }
  try { const data = await request('/api/local/users'); state.users = data.users || []; state.availablePermissions = data.availablePermissions || []; if (!scopeIsDirty('user-editor')) renderPermissionLists(); renderUsers(); }
  catch (error) { toast(error.message, true); }
  renderAccountState();
}
function renderUsers() {
  const list = $('usersList'); list.textContent = ''; show($('emptyUsers'), state.users.length === 0);
  for (const user of state.users) {
    const row = document.createElement('button'); row.type = 'button'; row.className = `user-row ${user.active ? '' : 'disabled-user'}`;
    const info = document.createElement('div'); const strong = document.createElement('strong'); strong.textContent = user.displayName || user.username; const small = document.createElement('small'); small.textContent = `@${user.username} · ${user.roleLabel} · ${user.activeSessions || 0} session(s)`; info.append(strong, small);
    const badges = document.createElement('div'); badges.className = 'user-badges'; const active = document.createElement('span'); active.className = `badge ${user.active ? 'success-badge' : ''}`; active.textContent = user.active ? 'Activo' : 'Desactivado'; badges.append(active); if (user.totpEnabled) { const mfa = document.createElement('span'); mfa.className = 'badge'; mfa.textContent = '2FA'; badges.append(mfa); }
    row.append(info, badges); row.addEventListener('click', () => editPanelUser(user)); list.append(row);
  }
}
function editPanelUser(user) {
  if (scopeIsDirty('user-editor') && String($('panelUserId').value || '') !== String(user.id) && !confirm('There are unsaved changes. Discard them and open another user?')) return;
  clearScopeDirty('user-editor');
  $('panelUserId').value = user.id; $('panelUsername').value = user.username; $('panelDisplayName').value = user.displayName; $('panelRole').value = user.role; $('panelPassword').value = ''; $('panelActive').checked = Boolean(user.active); $('userFormTitle').textContent = `Edit ${user.username}`;
  const overrides = user.permissionOverrides || { allow: [], deny: [] };
  document.querySelectorAll('#allowPermissions input').forEach((input) => { input.checked = (overrides.allow || []).includes(input.value); });
  document.querySelectorAll('#denyPermissions input').forEach((input) => { input.checked = (overrides.deny || []).includes(input.value); });
  show($('deletePanelUserBtn'), Number(user.id) !== Number(state.user?.id)); show($('revokeUserSessionsBtn'), true);
}
function permissionOverrides() {
  return { allow: [...document.querySelectorAll('#allowPermissions input:checked')].map((i) => i.value), deny: [...document.querySelectorAll('#denyPermissions input:checked')].map((i) => i.value) };
}
async function savePanelUser() {
  const payload = { id: $('panelUserId').value || undefined, username: $('panelUsername').value.trim(), displayName: $('panelDisplayName').value.trim(), role: $('panelRole').value, password: $('panelPassword').value, active: $('panelActive').checked, permissions: permissionOverrides() };
  try { await request('/api/local/users/save', { method: 'POST', body: JSON.stringify(payload) }); clearScopeDirty('user-editor'); toast('User saved'); resetUserForm(); await loadUsers(); }
  catch (error) { toast(error.message, true); }
}
async function deletePanelUser() { const id = Number($('panelUserId').value); if (!id || !confirm('Delete this panel user?')) return; try { await request('/api/local/users/delete', { method: 'POST', body: JSON.stringify({ id }) }); toast('User deleted'); resetUserForm(); await loadUsers(); } catch (error) { toast(error.message, true); } }
async function revokePanelUserSessions() { const id = Number($('panelUserId').value); if (!id || !confirm('Close all sessions for this user?')) return; try { await request('/api/local/users/revoke-sessions', { method: 'POST', body: JSON.stringify({ id }) }); toast('Sessions closed'); await loadUsers(); } catch (error) { toast(error.message, true); } }
function renderAccountState() {
  const enabled = Boolean(state.user?.totpEnabled);
  $('twoFactorStatus').textContent = enabled ? '2FA enabled for this account' : '2FA disabled';
  show($('setup2faBtn'), !enabled);
  show($('disable2faBox'), enabled);
  if (enabled) show($('twoFactorSetup'), false);
  const badge = $('accountTwoFactorBadge');
  if (badge) {
    badge.textContent = enabled ? '2FA activo' : '2FA disabled';
    badge.className = `badge ${enabled ? 'success-badge' : 'warning-badge'}`;
  }
  renderAccountIdentity();
}
async function loadAccountSessions() { try { const data = await request('/api/local/account/sessions'); state.accountSessions = data.sessions || []; renderAccountSessions(); renderAccountState(); } catch (error) { toast(error.message, true); } }
function renderAccountSessions() {
  const box = $('accountSessions'); box.textContent = '';
  for (const session of state.accountSessions) {
    const card = document.createElement('div'); card.className = `session-card ${session.current ? 'current' : ''}`;
    const title = document.createElement('strong'); title.textContent = session.current ? 'Current session' : (session.ip || 'Session');
    const meta = document.createElement('small'); meta.textContent = `${session.ip || 'Unknown IP'} · Last activity ${formatDate(session.last_seen)}`;
    const agent = document.createElement('span'); agent.textContent = session.user_agent || 'Navegador desconocido';
    card.append(title, meta, agent); box.append(card);
  }
  const count = state.accountSessions.length;
  if ($('accountSessionCountBadge')) $('accountSessionCountBadge').textContent = `${count} ${count === 1 ? 'session' : 'sessions'}`;
}
async function changeOwnPassword() { try { const data = await request('/api/local/account/password', { method: 'POST', body: JSON.stringify({ currentPassword: $('currentPassword').value, newPassword: $('newPassword').value }) }); clearScopeDirty('account-password'); toast('Password changed. Sign in again.'); if (data.reauthenticate) { stopRealtime(); showLogin(); } } catch (error) { toast(error.message, true); } }
async function setup2fa() { try { const data = await request('/api/local/account/2fa/setup', { method: 'POST', body: '{}' }); $('twoFactorSecret').value = data.secret; show($('twoFactorSetup'), true); toast('Add the secret to your authenticator app'); } catch (error) { toast(error.message, true); } }
async function confirm2fa() { try { await request('/api/local/account/2fa/confirm', { method: 'POST', body: JSON.stringify({ code: $('twoFactorCode').value.trim() }) }); state.user.totpEnabled = true; clearScopeDirty('account-2fa-setup'); renderAccountState(); toast('2FA activado'); } catch (error) { toast(error.message, true); } }
async function disable2fa() { if (!confirm('Disable two-factor authentication?')) return; try { await request('/api/local/account/2fa/disable', { method: 'POST', body: JSON.stringify({ password: $('disable2faPassword').value }) }); state.user.totpEnabled = false; clearScopeDirty('account-2fa-disable'); renderAccountState(); toast('2FA disabled'); } catch (error) { toast(error.message, true); } }
async function logoutAllSessions() { if (!confirm('Close all your sessions, including this one?')) return; try { await request('/api/local/account/logout-all', { method: 'POST', body: '{}' }); stopRealtime(); state.user = null; showLogin(); } catch (error) { toast(error.message, true); } }

function alertSound() {
  if (localStorage.getItem('pp_sound_alerts') !== '1') return;
  try { const audio = new (window.AudioContext || window.webkitAudioContext)(); const oscillator = audio.createOscillator(); const gain = audio.createGain(); oscillator.frequency.value = 620; gain.gain.setValueAtTime(0.08, audio.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.28); oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + 0.3); } catch (_) { /* ignored */ }
}
function notifyAlert(alert) {
  // Never create normal browser notifications for a hidden/suspended page.
  // Background notifications are delivered by Web Push through the service worker.
  if (document.visibilityState !== 'visible') return;
  if (Date.now() < state.suppressAlertNotificationsUntil) return;
  if (!alertIsRecent(alert)) return;
  alertSound();
  // An active Web Push subscription already produces the system notification
  // through the service worker, including when the app is visible.
  if (state.pushSubscription) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    const type = String(alert.type || 'alert').replace(/[^a-z0-9_-]/gi, '-');
    const player = String(alert.player_uuid || '').replace(/[^a-z0-9_-]/gi, '-');
    new Notification(alert.title, {
      body: alert.message,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // Replace an earlier live notification of the same kind instead of stacking it.
      tag: `player-panel-live-${type}-${player}`,
      renotify: false
    });
  }
}
async function loadAlerts() {
  try {
    const data = await request(`/api/local/alerts?since=${state.alertsInitialized ? state.lastAlertId : 0}&limit=50`);
    const alerts = data.alerts || [];
    if (!state.alertsInitialized) {
      state.lastAlertId = newestAlertId(alerts);
      state.alertsInitialized = true;
      return;
    }
    const fresh = alerts
      .filter((alert) => Number(alert.id) > state.lastAlertId)
      .sort((a, b) => Number(a.id) - Number(b.id));
    if (!fresh.length) return;

    // Always advance the cursor, even while hidden, so old alerts are never replayed.
    state.lastAlertId = Math.max(state.lastAlertId, newestAlertId(fresh));
    if (document.visibilityState === 'visible' && Date.now() >= state.suppressAlertNotificationsUntil) {
      fresh.filter(alertIsRecent).forEach(notifyAlert);
    }
    if (state.view === 'dashboard') loadDashboard();
  } catch (_) { /* polling can fail silently */ }
}

async function refreshAll() { await Promise.allSettled([loadServer(), loadPlayers(), loadPlaces(), loadDashboard(), loadAlerts()]); if (state.selectedUuid) { await loadPlayer(); if (state.details?.online) await loadInventory(); } }

function setCompactStatusPill(pill, stateClass, label, title) {
  if (!pill) return;
  pill.classList.remove('online', 'offline', 'syncing');
  pill.classList.add(stateClass);
  pill.title = title;
  pill.setAttribute('aria-label', label);
  const labelNode = pill.querySelector('.compact-status-label');
  if (labelNode) labelNode.textContent = label;
}

function setLiveStatus(status) {
  const wasConnected = state.liveConnected;
  state.liveConnected = status === 'online';
  if (state.poll && wasConnected !== state.liveConnected) startPolling();
  const pill = $('liveStatus');
  if (!pill) return;
  if (status === 'online') {
    setCompactStatusPill(pill, 'online', 'Live updates', 'The browser is receiving real-time events');
  } else if (status === 'connecting') {
    setCompactStatusPill(pill, 'syncing', 'Connecting', 'Connecting the real-time update channel');
  } else if (status === 'reconnecting') {
    setCompactStatusPill(pill, 'syncing', 'Reconnecting', 'The channel is reconnecting; fallback polling remains active');
  } else {
    setCompactStatusPill(pill, 'offline', 'Real-time disconnected', 'No SSE channel; fallback polling remains active');
  }
}

function scheduleLiveRefresh(alert) {
  clearTimeout(state.liveRefreshTimer);
  state.liveRefreshTimer = setTimeout(() => {
    const type = String(alert?.type || '');
    const tasks = [loadDashboard()];
    if (['join', 'leave', 'death', 'low_food', 'whitelist_denied'].includes(type)) tasks.push(loadPlayers());
    if (['join', 'leave', 'server_down', 'server_up', 'weather'].includes(type)) tasks.push(loadServer());
    if (state.selectedUuid && String(alert?.player_uuid || '') === String(state.selectedUuid)) tasks.push(loadPlayer());
    Promise.allSettled(tasks);
  }, 180);
}

function handleLiveAlert(alert) {
  const alertId = Number(alert?.id || 0);
  if (alertId > 0 && alertId <= state.lastAlertId) {
    scheduleLiveRefresh(alert);
    return;
  }
  if (alertId > 0) {
    state.lastAlertId = Math.max(state.lastAlertId, alertId);
    state.alertsInitialized = true;
  }
  if (document.visibilityState === 'visible' && Date.now() >= state.suppressAlertNotificationsUntil) notifyAlert(alert);
  scheduleLiveRefresh(alert);
}

function startLiveEvents() {
  stopLiveEvents();
  if (!window.EventSource || !state.user) { setLiveStatus('offline'); return; }
  setLiveStatus('connecting');
  const source = new EventSource(`/api/local/live?server=${encodeURIComponent(state.currentServerId || '')}`);
  state.liveSource = source;
  const markOnline = () => {
    clearTimeout(state.liveDisconnectTimer);
    state.liveDisconnectTimer = null;
    setLiveStatus('online');
  };
  source.addEventListener('ready', markOnline);
  source.addEventListener('alert', (event) => {
    try { handleLiveAlert(JSON.parse(event.data || '{}')); }
    catch (error) { console.warn('Invalid live event:', error); }
  });
  source.addEventListener('players', (event) => {
    try { applyLivePlayers(JSON.parse(event.data || '{}')); }
    catch (error) { console.warn('Invalid live player state:', error); }
  });
  source.addEventListener('worlds', (event) => {
    try { applyLiveWorlds(JSON.parse(event.data || '{}')); }
    catch (error) { console.warn('Invalid live world state:', error); }
  });
  source.onopen = markOnline;
  source.onerror = () => {
    if (source !== state.liveSource) return;
    setLiveStatus('reconnecting');
    clearTimeout(state.liveDisconnectTimer);
    state.liveDisconnectTimer = setTimeout(() => {
      if (source === state.liveSource && source.readyState !== EventSource.OPEN) setLiveStatus('offline');
    }, 10000);
  };
}

function stopLiveEvents() {
  if (state.liveSource) state.liveSource.close();
  state.liveSource = null;
  state.liveConnected = false;
  clearTimeout(state.liveRefreshTimer);
  clearTimeout(state.liveDisconnectTimer);
  state.liveRefreshTimer = null;
  state.liveDisconnectTimer = null;
  setLiveStatus('offline');
}

function pollingDelay() { return state.liveConnected ? 60000 : 15000; }
function schedulePolling(delay = pollingDelay()) {
  state.poll = setTimeout(async () => {
    await Promise.allSettled([loadServer(), loadPlayers(), loadAlerts()]);
    if (state.view === 'dashboard') await loadDashboard();
    if (state.view === 'server') await loadMetrics();
    if (state.view === 'system') await loadSystem();
    if (state.user) schedulePolling();
  }, delay);
}
function startPolling() { stopPolling(); schedulePolling(); }
function stopPolling() { if (state.poll) clearTimeout(state.poll); state.poll = null; }
function stopCraftyRefreshLoop() {
  if (state.craftyRefreshTimer) clearTimeout(state.craftyRefreshTimer);
  state.craftyRefreshTimer = null;
}
function craftyRefreshDelay() {
  if (document.visibilityState !== 'visible') return 15000;
  return state.view === 'server' ? 4000 : 5000;
}
function scheduleCraftyRefreshLoop(delay = craftyRefreshDelay()) {
  stopCraftyRefreshLoop();
  if (!state.user || !['dashboard', 'server'].includes(state.view) || state.connections?.crafty?.configured === false) return;
  state.craftyRefreshTimer = setTimeout(async () => {
    state.craftyRefreshTick += 1;
    if (state.view === 'server') {
      await loadCraftyServer({ silent: true });
      // Console is less time-sensitive than CPU/RAM; refresh it every 8 seconds.
      if (state.craftyRefreshTick % 2 === 0) await loadCraftyLogs({ silent: true });
    } else if (state.view === 'dashboard') {
      await loadDashboardCraftyTelemetry({ silent: true });
    }
    scheduleCraftyRefreshLoop();
  }, delay);
}
function restartCraftyRefreshLoop() {
  state.craftyRefreshTick = 0;
  scheduleCraftyRefreshLoop(250);
}

function startRealtime() { startLiveEvents(); startPolling(); restartCraftyRefreshLoop(); restartInventoryLiveLoop(); startWorldSceneClock(); }
function stopRealtime() { stopLiveEvents(); stopPolling(); stopCraftyRefreshLoop(); stopInventoryLiveLoop(); stopWorldSceneClock(); }

// Player actions and forms
document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => action(button.dataset.action)));
$('refreshBtn').addEventListener('click', async () => { await refreshAll(); if (state.view === 'server') await Promise.allSettled([loadCraftyServer({ force: true }), loadCraftyLogs(), loadCraftyBackups()]); if (state.view === 'dashboard') await loadDashboardCraftyTelemetry({ force: true }); }); $('refreshPlayerBtn').addEventListener('click', () => loadPlayer(state.selectedUuid, true)); $('inventoryBtn').addEventListener('click', () => loadInventory(state.selectedUuid, { forceRender: true }));
$('gamemodeBtn').addEventListener('click', () => action('gamemode', { gamemode: $('gamemodeSelect').value }));
$('teleportBtn').addEventListener('click', () => { try { action('teleport', parseTeleportCoordinates($('tpCoords').value)); } catch (error) { toast(error.message, true); } });
$('tpCoords').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('teleportBtn').click(); } });
$('currentLocationBtn').addEventListener('click', () => setTeleportLocation(state.details?.location || state.details)); $('deathLocationBtn').addEventListener('click', () => setTeleportLocation(state.details?.lastDeathLocation)); $('respawnLocationBtn').addEventListener('click', () => setTeleportLocation(state.details?.respawnLocation));
$('usePlayerPlaceBtn').addEventListener('click', () => { const place = state.places.find((item) => String(item.id) === $('playerPlaceSelect').value); if (place) setTeleportLocation(place); });
$('whitelistBtn').addEventListener('click', () => action('whitelist', { enabled: !Boolean(state.details?.whitelisted) }));
$('operatorBtn').addEventListener('click', () => action('operator', { enabled: !Boolean(state.details?.operator) }));
$('kickBtn').addEventListener('click', () => { const reason = $('reasonInput').value.trim() || 'Disconnected by an administrator'; if (confirm(`Kick ${playerName(state.details)}?`)) action('kick', { reason }); });
$('banBtn').addEventListener('click', () => { const reason = $('reasonInput').value.trim() || 'Banned by an administrator'; const suffix = state.details?.online ? ' They will also be kicked.' : ''; if (confirm(`Ban ${playerName(state.details)}?${suffix}`)) action('ban', { reason, kickIfOnline: true }); });
$('unbanBtn').addEventListener('click', () => { if (confirm(`Unban ${playerName(state.details)}?`)) action('unban'); });
$('clearBtn').addEventListener('click', () => { if (prompt('Type CLEAR to confirm:') === 'CLEAR') action('clear-inventory', { confirmation: 'CLEAR' }); });
async function addWhitelistPlayer() {
  const name = $('whitelistName').value.trim(); const uuid = $('whitelistUuid').value.trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return toast('Invalid name', true);
  if (uuid && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(uuid)) return toast('Invalid UUID', true);
  try {
    await request('/api/v1/whitelist/add', { method: 'POST', body: JSON.stringify({ name, uuid: uuid || null }) });
    $('whitelistName').value = ''; $('whitelistUuid').value = ''; toast(`${name} added and whitelist reloaded`); await refreshAll();
  } catch (error) { toast(error.message, true); }
}
$('addWhitelistBtn').addEventListener('click', addWhitelistPlayer);
[$('whitelistName'), $('whitelistUuid')].forEach((input) => input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addWhitelistPlayer(); } }));
$('playerSearch').addEventListener('input', () => { state.playerSearch = $('playerSearch').value; renderPlayers(); });
document.querySelectorAll('[data-player-filter]').forEach((button) => button.addEventListener('click', () => { state.playerFilter = button.dataset.playerFilter || 'all'; renderPlayers(); }));
$('inventorySearch').addEventListener('input', filterInventory); $('inventoryCategory').addEventListener('change', filterInventory); $('closeItemDialog').addEventListener('click', () => $('itemDialog').close());
$('themeMenuButton')?.addEventListener('click', (event) => {
  event.stopPropagation();
  setThemeMenuOpen($('themeMenu')?.classList.contains('hidden'));
});
document.querySelectorAll('[data-theme-choice]').forEach((button) => {
  button.addEventListener('click', () => {
    applyTheme(button.dataset.themeChoice);
    setThemeMenuOpen(false);
    $('themeMenuButton')?.focus();
  });
});
document.addEventListener('click', (event) => {
  if (!$('themePicker')?.contains(event.target)) setThemeMenuOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('themeMenu')?.classList.contains('hidden')) {
    setThemeMenuOpen(false);
    $('themeMenuButton')?.focus();
  }
});

// World controls
$('worldControlSelect').addEventListener('change', () => {
  state.selectedWorld = $('worldControlSelect').value;
  state.weatherDirty = false;
  state.weatherDraft = '';
  state.weatherDraftWorld = state.selectedWorld;
  renderSelectedWorldScene();
});
$('weatherSelect').addEventListener('change', () => {
  state.weatherDraft = $('weatherSelect').value;
  state.weatherDraftWorld = state.selectedWorld;
  state.weatherDirty = true;
});
$('setDayBtn').addEventListener('click', () => controlWorld({ timePreset: 'DAY' }));
$('setNightBtn').addEventListener('click', () => controlWorld({ timePreset: 'NIGHT' }));
$('applyTimeBtn').addEventListener('click', () => controlWorld({ timePreset: $('timePresetSelect').value }));
$('applyWeatherBtn').addEventListener('click', () => controlWorld({ weather: $('weatherSelect').value }));

$('editDashboardBtn').addEventListener('click', startDashboardEdit);
$('resetDashboardBtn').addEventListener('click', resetDashboardEdit);
$('cancelDashboardBtn').addEventListener('click', cancelDashboardEdit);
$('saveDashboardBtn').addEventListener('click', saveDashboardEdit);

// Player bulk actions
$('bulkActionsBtn').addEventListener('click', openBulkActionsDialog);
$('closeBulkDialog').addEventListener('click', closeBulkActionsDialog);
$('cancelBulkBtn').addEventListener('click', closeBulkActionsDialog);
$('bulkSelectAllBtn').addEventListener('click', () => setAllBulkPlayers(true));
$('bulkClearBtn').addEventListener('click', () => setAllBulkPlayers(false));
$('bulkAction').addEventListener('change', updateBulkFields);
$('runBulkBtn').addEventListener('click', runBulkAction);
$('bulkActionsDialog').addEventListener('click', (event) => { if (event.target === $('bulkActionsDialog')) closeBulkActionsDialog(); });
updateBulkFields();
$('soundAlerts').checked = localStorage.getItem('pp_sound_alerts') === '1'; $('soundAlerts').addEventListener('change', () => localStorage.setItem('pp_sound_alerts', $('soundAlerts').checked ? '1' : '0'));
$('enableNotificationsBtn').addEventListener('click', enablePush);

$('refreshMetricsBtn').addEventListener('click', () => loadMetrics(true));
$('metricsRange').addEventListener('change', () => loadMetrics(true));
['metricCpuEnabled', 'metricMemoryEnabled', 'metricTpsEnabled', 'metricStorageEnabled', 'serverDownEnabled'].forEach((id) => $(id).addEventListener('change', syncMetricRuleControls));
$('saveMetricSettingsBtn').addEventListener('click', saveMetricSettings);
$('markAlertsReadBtn').addEventListener('click', async () => { try { await request('/api/local/alerts/read', { method: 'POST', body: JSON.stringify({ ids: 'all' }) }); toast('Alerts marked as read'); await loadDashboard(); } catch (error) { toast(error.message, true); } });

// Crafty server control
$('serverStartBtn').addEventListener('click', () => runCraftyAction('start_server'));
$('serverStopBtn').addEventListener('click', () => runCraftyAction('stop_server'));
$('serverRestartBtn').addEventListener('click', () => runCraftyAction('restart_server'));
$('serverBackupBtn').addEventListener('click', () => runCraftyAction('backup_server'));
$('refreshCraftyBtn').addEventListener('click', () => loadCraftyServer({ force: true }));
$('refreshCraftyLogsBtn').addEventListener('click', loadCraftyLogs);
$('refreshCraftyBackupsBtn').addEventListener('click', loadCraftyBackups);

// System
$('refreshSystemBtn').addEventListener('click', () => loadSystem(true));
$('createSystemBackupBtn').addEventListener('click', createSystemBackup);
$('runSystemMaintenanceBtn').addEventListener('click', runSystemMaintenance);
$('saveSystemSettingsBtn').addEventListener('click', saveSystemSettings);
document.querySelectorAll('[data-connection-preset]').forEach((button) => button.addEventListener('click', () => setConnectionPreset(button.dataset.connectionPreset)));
$('pluginConnectionUrl')?.addEventListener('input', () => renderConnectionRouteHint('plugin'));
$('pluginConnectionUrl')?.addEventListener('blur', () => { normalizeAddressField('pluginConnectionUrl', 'plugin'); renderConnectionRouteHint('plugin'); });
$('craftyInstallationUrl')?.addEventListener('input', () => renderConnectionRouteHint('crafty'));
$('craftyInstallationUrl')?.addEventListener('blur', () => { normalizeAddressField('craftyInstallationUrl', 'crafty'); renderConnectionRouteHint('crafty'); });
[['craftyInstallationPanelUrl', 'craftyPublic'], ['blueMapConnectionUrl', 'bluemap'], ['squareMapConnectionUrl', 'squaremap'], ['wizardCraftyApiUrl', 'crafty'], ['wizardCraftyPanelUrl', 'craftyPublic'], ['wizardManualPluginUrl', 'plugin'], ['wizardManualBlueMapUrl', 'bluemap'], ['wizardManualSquareMapUrl', 'squaremap']].forEach(([id, kind]) => {
  $(id)?.addEventListener('blur', () => normalizeAddressField(id, kind));
});
$('craftyInstallationSelect')?.addEventListener('change', (event) => {
  const id = Number(event.target.value || 0);
  const connection = craftyConnectionById(id);
  clearScopeDirty('crafty-installation');
  renderCraftyInstallation(connection);
  renderCraftyDiscoveredServers([]);
});
$('craftyDiscoveredServerSelect')?.addEventListener('change', (event) => {
  if (event.target.value) {
    $('craftyConnectionServerId').value = event.target.value;
    markScopeDirty('crafty-connection');
  }
});
$('newCraftyInstallationBtn')?.addEventListener('click', resetCraftyInstallationForm);
$('saveCraftyInstallationBtn')?.addEventListener('click', saveCraftyInstallation);
$('deleteCraftyInstallationBtn')?.addEventListener('click', deleteCraftyInstallation);
$('discoverCraftyServersBtn')?.addEventListener('click', discoverCraftyServers);
$('importCraftyServersBtn')?.addEventListener('click', importCraftyServers);
$('savePluginConnectionBtn').addEventListener('click', savePluginConnection);
$('saveCraftyConnectionBtn').addEventListener('click', saveCraftyConnection);
$('manageCraftyInstallationsBtn')?.addEventListener('click', openCraftyInstallations);
$('saveBlueMapConnectionBtn')?.addEventListener('click', saveBlueMapConnection);
$('saveSquareMapConnectionBtn')?.addEventListener('click', saveSquareMapConnection);
$('saveServerProfileBtn')?.addEventListener('click', saveServerProfileIdentity);
$('createServerProfileBtn')?.addEventListener('click', createServerProfile);
$('openConnectionGuideBtn')?.addEventListener('click', () => openConnectionOnboarding(true));
$('closeConnectionOnboardingBtn')?.addEventListener('click', () => closeConnectionOnboarding());
document.querySelectorAll('[data-onboarding-mode]').forEach((button) => button.addEventListener('click', () => {
  const mode = button.dataset.onboardingMode;
  if (mode === 'manual') setConnectionOnboardingStep('manual');
  else if (mode === 'crafty') startOnboardingCrafty();
  else skipConnectionOnboarding();
}));
document.querySelectorAll('[data-onboarding-back]').forEach((button) => button.addEventListener('click', () => setConnectionOnboardingStep('')));
$('saveOnboardingManualBtn')?.addEventListener('click', saveOnboardingManualConnection);
$('connectionOnboardingDialog')?.addEventListener('cancel', (event) => { event.preventDefault(); closeConnectionOnboarding(); });
$('openAddServerWizardBtn')?.addEventListener('click', () => openAddServerWizard());
$('craftyAddServerShortcutBtn')?.addEventListener('click', () => openAddServerWizard('crafty'));
$('deleteServerProfileBtn')?.addEventListener('click', deleteCurrentServerProfile);
$('closeAddServerWizardBtn')?.addEventListener('click', closeAddServerWizard);
$('closeServerDetailsBtn')?.addEventListener('click', () => closeServerEditor());
$('serverDetailsPanel')?.addEventListener('click', (event) => {
  if (event.target === $('serverDetailsPanel')) closeServerEditor();
});
$('wizardCraftyConnectionSelect')?.addEventListener('change', renderWizardCraftyLogin);
$('wizardCraftyLoginBtn')?.addEventListener('click', wizardCraftyLoginAndDiscover);
$('wizardCraftyChangeLoginBtn')?.addEventListener('click', () => {
  show($('wizardCraftyResultsPanel'), false);
  show($('wizardCraftyLoginPanel'), true);
});
document.querySelectorAll('[data-add-server-cancel]').forEach((button) => button.addEventListener('click', closeAddServerWizard));
document.querySelectorAll('[data-add-server-back]').forEach((button) => button.addEventListener('click', () => setAddServerWizardStep('')));
document.querySelectorAll('[data-add-server-method]').forEach((button) => button.addEventListener('click', () => setAddServerWizardStep(button.dataset.addServerMethod)));
$('wizardImportCraftyBtn')?.addEventListener('click', wizardImportCraftyServers);
$('wizardCreateManualBtn')?.addEventListener('click', wizardCreateManualServer);
$('addServerWizardDialog')?.addEventListener('click', (event) => {
  if (event.target === $('addServerWizardDialog')) closeAddServerWizard();
});
$('serverSelector')?.addEventListener('change', async (event) => {
  const protectedScopes = ['system-profile', 'plugin-connection', 'crafty-installation', 'crafty-connection', 'bluemap-connection', 'system-retention'];
  const hasDraft = protectedScopes.some(scopeIsDirty);
  if (hasDraft && !confirm('There are unsaved changes in System Settings. Discard them and switch servers?')) {
    event.target.value = String(state.currentServerId || '');
    return;
  }
  clearScopes(protectedScopes);
  await switchServer(event.target.value);
});
$('refreshBlueMapBtn')?.addEventListener('click', () => loadBlueMap(true));

// Places
$('newPlaceBtn')?.addEventListener('click', resetPlaceForm); $('savePlaceBtn')?.addEventListener('click', savePlace); $('placeFromPlayerBtn')?.addEventListener('click', () => { if (!state.details) return toast('Select a player', true); const loc = state.details.location || state.details; $('placeWorld').value = loc.world || state.details.world || ''; $('placeX').value = loc.x ?? state.details.x ?? ''; $('placeY').value = loc.y ?? state.details.y ?? ''; $('placeZ').value = loc.z ?? state.details.z ?? ''; $('placeYaw').value = loc.yaw ?? 0; $('placePitch').value = loc.pitch ?? 0; });
$('placeFromMapBtn')?.addEventListener('click', () => startPlaceMapPicker());
$('placeMapQuickModeBtn')?.addEventListener('click', () => setPlaceMapMode('quick'));
$('placeMapSquareProviderBtn')?.addEventListener('click', () => switchPlaceMapProvider('squaremap'));
$('placeMapBlueProviderBtn')?.addEventListener('click', () => switchPlaceMapProvider('bluemap'));
$('placeMapExactModeBtn')?.addEventListener('click', () => setPlaceMapMode('exact'));
$('usePlaceMapCenterBtn')?.addEventListener('click', requestPlaceMapCenter);
$('stopPlaceMapPickerBtn')?.addEventListener('click', () => finalizePlaceMapSelection());
$('closePlaceMapPickerDialog')?.addEventListener('click', () => stopPlaceMapPicker());
$('readPlaceMapClipboardBtn')?.addEventListener('click', usePlaceMapClipboard);
$('applyPlaceMapCoordinatesBtn')?.addEventListener('click', applyPastedPlaceCoordinates);
$('placeMapCoordinatePaste')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); applyPastedPlaceCoordinates(); } });
$('placeMapFrame')?.addEventListener('load', () => { if (state.placeMapPickerActive) schedulePlaceMapHandshake(); });
$('placeMapPickerDialog')?.addEventListener('cancel', (event) => { event.preventDefault(); stopPlaceMapPicker(); });
$('placeMapPickerDialog')?.addEventListener('close', () => { document.body.classList.remove('place-map-dialog-open'); if (state.placeMapPickerActive) stopPlaceMapPicker({ silent: true, closeDialog: false }); });
window.addEventListener('message', handlePlaceMapBridgeMessage);
window.addEventListener('message', handlePlaceThumbnailMessage);

// History
$('refreshHistoryBtn').addEventListener('click', loadHistory); $('historyCategory').addEventListener('change', loadHistory); $('refreshSessionsBtn').addEventListener('click', loadSessions);


// Users and account
document.querySelectorAll('[data-account-tab]').forEach((button) => button.addEventListener('click', () => setAccountsTab(button.dataset.accountTab)));
$('newUserBtn').addEventListener('click', () => { if (scopeIsDirty('user-editor') && !confirm('There are unsaved changes. Discard them and create another user?')) return; setAccountsTab('admin'); resetUserForm(); $('panelUsername').focus(); });
$('savePanelUserBtn').addEventListener('click', savePanelUser);
$('deletePanelUserBtn').addEventListener('click', deletePanelUser);
$('revokeUserSessionsBtn').addEventListener('click', revokePanelUserSessions);
$('changePasswordBtn').addEventListener('click', changeOwnPassword);
$('setup2faBtn').addEventListener('click', setup2fa);
$('confirm2faBtn').addEventListener('click', confirm2fa);
$('disable2faBtn').addEventListener('click', disable2fa);
$('logoutAllBtn').addEventListener('click', logoutAllSessions);
$('enablePushBtn').addEventListener('click', enablePush);
$('repairPushBtn').addEventListener('click', repairPush);
$('disablePushBtn').addEventListener('click', disablePush);
$('testPushBtn').addEventListener('click', testPush);
$('savePushPreferencesBtn').addEventListener('click', savePushPreferences);

$('installAppBtn').addEventListener('click', installPwa);
$('installFromAccountBtn').addEventListener('click', installPwa);
$('retryConnectionBtn').addEventListener('click', () => { updateConnectivity(); if (navigator.onLine) refreshAll(); });
$('dismissUpdateBtn').addEventListener('click', () => show($('updateBanner'), false));
$('applyUpdateBtn').addEventListener('click', () => {
  const registration = state.swRegistration;
  if (registration?.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  else window.location.reload();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopPolling(); stopInventoryLiveLoop(); } else if (!loginView.classList.contains('hidden')) return; else { startPolling(); restartInventoryLiveLoop(); if (!state.liveSource || (window.EventSource && state.liveSource.readyState === window.EventSource.CLOSED)) startLiveEvents(); state.swRegistration?.update().catch(() => {}); } });
bindFormDraftProtection();
registerPwa();
migratePlaceMapProviderPreference();
checkSession();

// Keep Crafty refresh responsive after returning to the tab without polling while hidden.
document.addEventListener('visibilitychange', () => { if (state.user) restartCraftyRefreshLoop(); });
