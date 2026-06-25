/* ============================================================
   DataProvider — central store for every collection, backed by
   the control-plane BFF. No mock seed: collections are empty until
   the backend responds.

   - HYDRATORS[name]  loads the collection from an endpoint on mount.
   - WRITERS[name]    persists add/update/remove to the endpoint.
   A collection with no writer is read-only (e.g. Keycloak users).
   ============================================================ */
import { createContext, useContext, useReducer, useMemo, useCallback, useEffect } from 'react';
import * as api from './api.js';

let _counter = 0;
function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  _counter += 1;
  return `id-${_counter}`;
}

// Every collection is backend-driven and starts empty (no mock fallback).
const COLLECTIONS = [
  'dashboards', 'reports', 'metrics', 'sources', 'connectors', 'dqRules', 'assets',
  'accessUsers', 'accessRoles', 'runs', 'adminUsers', 'adminOrgs', 'adminConfig',
  'adminAudit', 'adminApi', 'adminTenancy', 'notifications',
];

// normalize ensures every row has a stable string id (server rows usually carry one).
function normalize(name, rows) {
  return (rows || []).map((r, i) => ({ ...r, id: String(r.id != null ? r.id : `${name}-${i}`) }));
}

/* HYDRATORS — initial load for each collection. A rejection leaves the
   collection empty (logged, no mock fallback). */
const HYDRATORS = {
  dashboards: () => api.dashboards.list(),
  reports: () => api.reports.list(),
  metrics: () => api.metrics.list(),
  sources: () => api.datasources.list(),
  connectors: () => api.getPipelines(),
  dqRules: () => api.dqRules.list(),
  assets: () => api.getCatalogSearch(''),
  // Keycloak usernames are unique, so id = username keeps CRUD targeting correct
  // and rows distinct. Fall back to email/index only when username is absent.
  accessUsers: () => api.getAccessUsers().then((rows) => (rows || []).map((u, i) => ({ ...u, id: u.username || u.email || `user-${i}` }))),
  accessRoles: () => api.accessRoles.list(),
  runs: () => api.getOpsRuns().then((r) => r.runs || []),
  adminUsers: () => api.getAdminUsers().then((rows) => (rows || []).map((u, i) => ({ ...u, id: u.username || u.email || `user-${i}` }))),
  adminOrgs: () => api.adminOrgs.list(),
  adminConfig: () => api.adminConfig.list(),
  adminAudit: () => api.getAdminAudit(),
  adminApi: () => api.adminApiKeys.list(),
  adminTenancy: () => api.adminTenancy.list(),
  notifications: () => api.getNotifications(),
};

/* WRITERS — persist mutations. resource()-backed collections expose
   create/update/remove; custom ones (api keys, notifications) override. */
const WRITERS = {
  dashboards: api.dashboards,
  reports: api.reports,
  metrics: api.metrics,
  sources: api.datasources,
  dqRules: api.dqRules,
  accessRoles: api.accessRoles,
  adminOrgs: api.adminOrgs,
  adminConfig: api.adminConfig,
  adminTenancy: api.adminTenancy,
  adminApi: { create: api.adminApiKeys.create, remove: api.adminApiKeys.remove },
  // Keycloak realm users (write path; id is the username). May fail on an
  // LDAP read-only realm — the error surfaces (optimistic add rolls back).
  adminUsers: {
    create: (u) => api.createAdminUser(u).then((s) => ({ ...s, id: s.username || s.email })),
    update: (id, patch) => api.updateAdminUser(id, patch),
    remove: (id) => api.deleteAdminUser(id),
  },
  accessUsers: {
    create: (u) => api.createAccessUser(u).then((s) => ({ ...s, id: s.username || s.email })),
    update: (id, patch) => api.updateAccessUser(id, patch),
    remove: (id) => api.deleteAccessUser(id),
  },
  notifications: {
    // Only "mark read" and delete are persisted; full PUT isn't a notification op.
    update: (id, patch) => (patch.unread === false ? api.markNotificationRead(id) : Promise.resolve(null)),
    remove: (id) => api.deleteNotification(id),
  },
};

function seedState() {
  const out = {};
  for (const name of COLLECTIONS) out[name] = [];
  return out;
}

function reducer(state, action) {
  const { name } = action;
  switch (action.type) {
    case 'add':
      return { ...state, [name]: [{ ...action.item, id: action.item.id || genId() }, ...state[name]] };
    case 'update':
      return { ...state, [name]: state[name].map((x) => (x.id === action.id ? { ...x, ...action.patch } : x)) };
    case 'remove':
      return { ...state, [name]: state[name].filter((x) => x.id !== action.id) };
    case 'set':
      return { ...state, [name]: action.items };
    default:
      return state;
  }
}

const DataContext = createContext(null);

export function DataProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, seedState);

  // Hydrate every collection in parallel. Failures are isolated per collection
  // so one unavailable component doesn't blank the whole app.
  useEffect(() => {
    let alive = true;
    for (const [name, load] of Object.entries(HYDRATORS)) {
      load()
        .then((rows) => { if (alive) dispatch({ type: 'set', name, items: normalize(name, rows) }); })
        .catch((err) => { if (alive) console.error(`hydrate ${name} failed`, err); });
    }
    return () => { alive = false; };
  }, []);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

/* CRUD helpers for one collection. For backend-backed collections the mutation
   is applied optimistically then persisted; a failed create rolls back. */
export function useCollection(name) {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useCollection must be used within <DataProvider>');
  const { state, dispatch } = ctx;
  const writer = WRITERS[name];

  const add = useCallback((item) => {
    const tmpId = item.id || genId();
    dispatch({ type: 'add', name, item: { ...item, id: tmpId } });
    if (writer?.create) {
      writer.create(item)
        .then((saved) => { if (saved) dispatch({ type: 'update', name, id: tmpId, patch: saved }); })
        .catch((err) => { dispatch({ type: 'remove', name, id: tmpId }); console.error(`create ${name} failed`, err); });
    }
    return tmpId;
  }, [dispatch, name, writer]);

  const update = useCallback((id, patch) => {
    dispatch({ type: 'update', name, id, patch });
    if (writer?.update) {
      writer.update(id, patch).catch((err) => console.error(`update ${name} failed`, err));
    }
  }, [dispatch, name, writer]);

  const remove = useCallback((id) => {
    dispatch({ type: 'remove', name, id });
    if (writer?.remove) {
      writer.remove(id).catch((err) => console.error(`remove ${name} failed`, err));
    }
  }, [dispatch, name, writer]);

  const set = useCallback((items) => dispatch({ type: 'set', name, items }), [dispatch, name]);
  return { items: state[name], add, update, remove, set };
}

/* Read the whole store (e.g. cross-collection counts). */
export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used within <DataProvider>');
  return ctx.state;
}
