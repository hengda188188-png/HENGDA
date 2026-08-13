/**
 * 電腦端狀態（單一事實來源）+ 網址同步。
 * 初始狀態一律從 URL 讀（禁先閃預設頁再跳），改變時 replaceState 寫回。
 */
const listeners = new Set();

export const state = {
  projectId: '',
  project: null,
  bootstrap: null,
  photos: { rows: [], total: 0, page: 1, pageCount: 1, pageSize: 24, stats: {}, uploaders: [] },
  filters: { q: '', status: 'all', device: 'all', drive: 'all', sort: 'time', page: 1 },
  projectFilters: { q: '', status: 'active', page: 1 },
  address: '',
  job: null,
};

export function readUrl() {
  const params = new URLSearchParams(location.search);
  state.projectId = params.get('project') ?? '';
  state.filters.q = params.get('q') ?? '';
  state.filters.status = params.get('status') ?? 'all';
  state.filters.device = params.get('device') ?? 'all';
  state.filters.drive = params.get('drive') ?? 'all';
  state.filters.sort = params.get('sort') === 'device' ? 'device' : 'time';
  state.filters.page = Math.max(1, Number(params.get('page') ?? 1));
  state.address = params.get('address') ?? '';
}

export function writeUrl() {
  const params = new URLSearchParams();
  if (state.projectId) params.set('project', state.projectId);
  if (state.filters.q) params.set('q', state.filters.q);
  if (state.filters.status !== 'all') params.set('status', state.filters.status);
  if (state.filters.device !== 'all') params.set('device', state.filters.device);
  if (state.filters.drive !== 'all') params.set('drive', state.filters.drive);
  if (state.filters.sort !== 'time') params.set('sort', state.filters.sort);
  if (state.filters.page > 1) params.set('page', String(state.filters.page));
  if (state.address) params.set('address', state.address);
  const query = params.toString();
  history.replaceState(null, '', query ? `?${query}` : location.pathname);
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** @param {'project'|'photos'|'job'|'all'} scope */
export function notify(scope = 'all') {
  writeUrl();
  for (const fn of listeners) fn(scope);
}
