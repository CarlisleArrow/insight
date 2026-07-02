import React, { useState, useMemo, useEffect } from 'react';
import {
  ContentSwitcher, Switch,
  DataTable, Table, TableHead, TableRow, TableHeader, TableBody, TableCell,
  TableContainer, TableToolbar, TableToolbarContent, TableToolbarSearch,
  Pagination, OverflowMenu, OverflowMenuItem,
} from '@carbon/react';
import Icon from './Icon.jsx';
import { Picker } from './inputs.jsx';

/* ---- status dot mapping (ported from the prototype) ---- */
const STATUS_DOT = {
  green: 'var(--cds-support-success)', running: 'var(--cds-support-success)', connected: 'var(--cds-support-success)',
  success: 'var(--cds-support-success)', active: 'var(--cds-support-success)', healthy: 'var(--cds-support-success)',
  amber: 'var(--cds-support-warning)', warning: 'var(--cds-support-warning)', retrying: 'var(--cds-support-warning)',
  degraded: 'var(--cds-support-warning)', paused: 'var(--cds-support-warning)',
  red: 'var(--cds-support-error)', error: 'var(--cds-support-error)', failed: 'var(--cds-support-error)',
  blue: 'var(--cds-blue-60)', provisioning: 'var(--cds-blue-60)', syncing: 'var(--cds-blue-60)',
  gray: 'var(--cds-text-placeholder)', stopped: 'var(--cds-text-placeholder)', draft: 'var(--cds-text-placeholder)', inactive: 'var(--cds-text-placeholder)',
};
export function StatusDot({ kind, children }) {
  const color = STATUS_DOT[(kind || 'gray').toLowerCase()] || STATUS_DOT.gray;
  return <span className="w-status"><span className="dot" style={{ background: color }} />{children}</span>;
}

/* ---- page header (breadcrumb + title + actions) ---- */
export function PageHeader({ crumb, title, sub, actions }) {
  return (
    <>
      {crumb && (
        <div className="w-crumb">
          {crumb.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="sep">/</span>}
              {i < crumb.length - 1
                ? <a href="#" onClick={(e) => e.preventDefault()}>{c}</a>
                : <span>{c}</span>}
            </React.Fragment>
          ))}
        </div>
      )}
      <div className="w-head">
        <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
        {actions && <div className="acts">{actions}</div>}
      </div>
    </>
  );
}

/* ---- sub-page switcher (Carbon ContentSwitcher, full width) ---- */
export function SubSwitch({ items, value, onChange }) {
  const idx = Math.max(0, items.findIndex((it) => it.id === value));
  return (
    <div className="ip-subswitch">
      <ContentSwitcher selectedIndex={idx} onChange={({ index }) => onChange(items[index].id)} size="md">
        {items.map((it) => <Switch key={it.id} name={it.id} text={it.label} />)}
      </ContentSwitcher>
    </div>
  );
}

/* ---- overflow row menu (real Carbon component) ----
   Pass handlers (onView/onEdit/onDuplicate/onDelete) to wire actions,
   or `items` (legacy) for a static menu. */
export function RowMenu({ onView, onEdit, onRoles, onDuplicate, onDelete, items }) {
  const stop = (fn) => (e) => { if (e && e.stopPropagation) e.stopPropagation(); if (fn) fn(); };
  if (items) {
    return (
      <OverflowMenu size="sm" flipped aria-label="Row actions" onClick={(e) => e.stopPropagation()}>
        {items.map((t) => <OverflowMenuItem key={t} itemText={t} isDelete={t === 'Delete' || t === 'Revoke'} />)}
      </OverflowMenu>
    );
  }
  return (
    <OverflowMenu size="sm" flipped aria-label="Row actions" onClick={(e) => e.stopPropagation()}>
      {onView && <OverflowMenuItem itemText="View" onClick={stop(onView)} />}
      {onEdit && <OverflowMenuItem itemText="Edit" onClick={stop(onEdit)} />}
      {onRoles && <OverflowMenuItem itemText="Manage roles" onClick={stop(onRoles)} />}
      {onDuplicate && <OverflowMenuItem itemText="Duplicate" onClick={stop(onDuplicate)} />}
      {onDelete && <OverflowMenuItem itemText="Delete" isDelete onClick={stop(onDelete)} />}
    </OverflowMenu>
  );
}

/* ---- reusable Carbon DataTable wrapper ----
   headers: [{ key, header }]; rows: array of plain objects;
   renderCell(originalRow, key) -> node (optional). */
export function CarbonTable({
  headers, rows, renderCell, onRowClick,
  searchPlaceholder, actions, filters,
  withToolbar = true, withPagination = false, pageSizes = [10, 20, 50],
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(pageSizes[0]);

  // live substring search across all string-valued cells
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => headers.some((h) => String(r[h.key] ?? '').toLowerCase().includes(q)));
  }, [rows, query, headers]);

  const total = filtered.length;
  const start = (page - 1) * pageSize;
  const pageRows = withPagination ? filtered.slice(start, start + pageSize) : filtered;

  // keep the current page valid as the filtered set changes
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    if (page > maxPage) setPage(maxPage);
  }, [total, pageSize, page]);

  const norm = pageRows.map((r, i) => ({ id: String(r.id ?? r.name ?? r.key ?? r.org ?? r.tenant ?? r.role ?? r.pipe ?? i), __orig: r }));
  const dataRows = norm.map(({ id, __orig }) => {
    const out = { id };
    headers.forEach((h) => { out[h.key] = typeof __orig[h.key] === 'object' ? '' : (__orig[h.key] ?? ''); });
    return out;
  });
  const origById = Object.fromEntries(norm.map((n) => [n.id, n.__orig]));
  // Remount DataTable when the visible slice changes so Carbon's internal
  // row state never goes stale against headers/page.
  const tableKey = `${headers.map((h) => h.key).join(',')}#${pageRows.length}#${page}`;

  return (
    <div className="ip-tablewrap">
      <DataTable key={tableKey} rows={dataRows} headers={headers} isSortable>
        {({ rows: drows, headers: dheaders, getHeaderProps, getTableProps, getRowProps }) => (
          <TableContainer>
            {withToolbar && (
              <TableToolbar>
                <TableToolbarContent>
                  {searchPlaceholder && (
                    <TableToolbarSearch
                      persistent
                      placeholder={searchPlaceholder}
                      onChange={(e) => { setQuery(e && e.target ? e.target.value : ''); setPage(1); }}
                    />
                  )}
                  {filters && filters.map((f, i) => (
                    <div key={i} style={{ minWidth: 176 }}>
                      <Picker items={f.items} value={f.value} onChange={f.onChange} />
                    </div>
                  ))}
                  {actions}
                </TableToolbarContent>
              </TableToolbar>
            )}
            <Table {...getTableProps()}>
              <TableHead>
                <TableRow>
                  {dheaders.map((h) => {
                    const { key, ...hp } = getHeaderProps({ header: h });
                    return <TableHeader key={h.key} {...hp}>{h.header}</TableHeader>;
                  })}
                </TableRow>
              </TableHead>
              <TableBody>
                {drows.map((r) => {
                  const orig = origById[r.id] || {};
                  const { key, ...rp } = getRowProps({ row: r });
                  return (
                    <TableRow
                      key={r.id}
                      {...rp}
                      onClick={onRowClick ? () => onRowClick(orig) : undefined}
                      style={onRowClick ? { cursor: 'pointer' } : undefined}
                    >
                      {r.cells.map((c) => (
                        <TableCell key={c.id} className={headers.find((h) => h.key === c.info.header)?.mono ? 'ip-mono' : undefined}>
                          {renderCell ? renderCell(orig, c.info.header) : c.value}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DataTable>
      {withPagination && (
        <Pagination
          size="md"
          totalItems={total}
          pageSizes={pageSizes}
          page={page}
          pageSize={pageSize}
          onChange={({ page: p, pageSize: ps }) => { setPage(p); setPageSize(ps); }}
        />
      )}
    </div>
  );
}

/* ---- chart / image placeholder ---- */
export function Placeholder({ label, height = 160, icon = 'chart--bar', style }) {
  return (
    <div className="w-ph" style={{ height, ...style }}>
      <span className="lbl"><Icon name={icon} size={14} />{label}</span>
    </div>
  );
}

/* ---- empty state ---- */
/* useUnsavedGuard — warn on browser close/refresh while an editor has unsaved
   changes. `active` is the dirty flag; the native beforeunload prompt fires
   only when true, so it never nags on clean views. */
export function useUnsavedGuard(active) {
  useEffect(() => {
    if (!active) return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; return ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [active]);
}

export function EmptyState({ icon = 'document', title, sub, action }) {
  return (
    <div className="w-empty">
      <div className="ic"><Icon name={icon} size={32} /></div>
      <h3>{title}</h3>
      {sub && <p>{sub}</p>}
      {action}
    </div>
  );
}

/* ---- draggable field chip ---- */
export function FieldChip({ children, kind, ...rest }) {
  return (
    <div className="w-chip" draggable {...rest}>
      <span className="w-grip"><i /><i /><i /><i /><i /><i /></span>
      {children}
      {kind && <span className="t">{kind}</span>}
    </div>
  );
}

/* ---- right slide-over panel ---- */
export function SidePanel({ title, sup, width = 420, onClose, children, footer }) {
  return (
    <>
      <div className="w-scrim" onClick={onClose} />
      <aside className="w-panel" style={{ width }}>
        <div className="w-panel__head">
          {sup && <div className="sup">{sup}</div>}
          <h2>{title}</h2>
          <button className="x" aria-label="Close" onClick={onClose}><Icon name="close" size={20} /></button>
        </div>
        <div className="w-panel__body">{children}</div>
        {footer && <div className="w-panel__foot">{footer}</div>}
      </aside>
    </>
  );
}

/* ---- editor toolbar button ---- */
export function ToolBtn({ icon, label, onClick, title }) {
  return (
    <button className="w-iconbtn" onClick={onClick} title={title || label} aria-label={title || label}>
      {icon && <Icon name={icon} size={16} />}{label}
    </button>
  );
}
