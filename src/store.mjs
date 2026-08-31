// TalentStore：单例 Durable Object，承载全部状态（rooms/users/sessions）与 API。
// 由 server.mjs（Express 版）移植：业务逻辑保持一致，传输层换为标准 Request/Response，
// fs 持久化换为 DO storage，内存 sessions 持久化到 storage 以便 DO 休眠后恢复。
import JSZip from 'jszip';
import QRCode from 'qrcode';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// ---------- 纯业务函数（与原版一致） ----------
const defaults = { currentIndex: 0, initialCurrentIndex: 0, decisions: {}, discussionNotes: {}, initialDecisions: {}, initialDiscussionNotes: {}, employees: [{ id: 'E001', name: '张三', department: '产品部', role: '产品经理' }, { id: 'E002', name: '李四', department: '技术部', role: '开发工程师' }, { id: 'E003', name: '王五', department: '市场部', role: '市场经理' }], votes: {}, initialVotes: {} };
const clone = value => JSON.parse(JSON.stringify(value));
const normalizeEmployees = list => { const counts = new Map(), used = new Set(); return list.map((employee, index) => { const employeeNo = String(employee.employeeNo || employee.id || ('E' + (index + 1))).trim() || ('E' + (index + 1)); let occurrence = (counts.get(employeeNo) || 0) + 1; counts.set(employeeNo, occurrence); let id = occurrence === 1 ? employeeNo : employeeNo + '__' + occurrence; while (used.has(id)) { occurrence++; counts.set(employeeNo, occurrence); id = employeeNo + '__' + occurrence } used.add(id); return { ...employee, id, employeeNo } }) };
const roomIdFromValue = value => String(value || 'default').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'default';
const makeRoom = (name = '默认讨论区') => ({ ...clone(defaults), name, createdAt: new Date().toISOString() });
const sessionKeys = ['currentIndex', 'initialCurrentIndex', 'decisions', 'discussionNotes', 'employees', 'votes'];

const gridBox = (pl, pot) => { if (!pl || !pot) return ''; const g = pl >= 4 ? 'H' : pl === 3 ? 'M' : 'L'; return ({ 'H,3': 1, 'H,2': 2, 'H,1': 4, 'M,3': 3, 'M,2': 5, 'M,1': 7, 'L,3': 6, 'L,2': 8, 'L,1': 9 })[`${g},${pot}`] };
const majorityLevel = (counts, total) => { if (!total) return null; const index = counts.findIndex(count => count > total / 2); return index < 0 ? null : index + 1 };
const recommendedGridByShare = (gridCounts, total) => { if (!total) return null; const index = gridCounts.findIndex(count => count / total >= 0.75); return index < 0 ? null : index + 1 };
const recommendedPlForGrid = (votes, grid) => { grid = Number(grid); if (!grid) return null; if ([3, 5, 7].includes(grid)) return 3; const candidates = [1, 2, 4].includes(grid) ? [4, 5] : [6, 8, 9].includes(grid) ? [1, 2] : []; if (!candidates.length) return null; const gridVotes = votes.filter(v => gridBox(v.pl, v.pot) === grid); const winner = candidates.map(level => ({ level, count: gridVotes.filter(v => v.pl === level).length })).find(x => x.count > gridVotes.length / 2); return winner?.level || null };

const reservedFields = new Set(['员工编号', '姓名', '部门', '岗位', '照片']);
const cleanFields = value => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).map(([key, val]) => [String(key || '').trim().slice(0, 50), String(val ?? '').trim().slice(0, 500)]).filter(([key, val]) => key && val && !reservedFields.has(key)));

const discussionNoteKeys = ['strength', 'improvementArea', 'nextStep', 'developmentMeasures', 'riskOfLeaving'];
const cleanDiscussionNote = value => { if (value && typeof value === 'object') return Object.fromEntries(discussionNoteKeys.map(k => [k, String(value[k] ?? '').trim().slice(0, 1200)])); return { strength: String(value ?? '').trim().slice(0, 1200), improvementArea: '', nextStep: '', developmentMeasures: '', riskOfLeaving: '' } };
const discussionNoteText = value => { const note = cleanDiscussionNote(value); return [['Strength', note.strength], ['Improvement Area', note.improvementArea], ['Next Step', note.nextStep], ['Development Measures', note.developmentMeasures], ['Risk of Leaving', note.riskOfLeaving]].filter(([, v]) => v).map(([k, v]) => k + ': ' + v).join(' | ') };
const voteCommentKeys = ['strength', 'improvementArea', 'others'];
const cleanVoteComment = value => { if (value && typeof value === 'object') return Object.fromEntries(voteCommentKeys.map(k => [k, String(value[k] ?? '').trim().slice(0, 1000)])); return { strength: '', improvementArea: '', others: String(value ?? '').trim().slice(0, 1000) } };
const voteCommentText = value => { const c = cleanVoteComment(value); return [['Strength', c.strength], ['Improvement Area', c.improvementArea], ['Others', c.others]].filter(([, v]) => v).map(([k, v]) => k + ': ' + v).join(' | ') };

const view = room => ({ currentIndex: room.currentIndex, total: room.employees.length, employee: room.employees[room.currentIndex] || null });
const initialView = room => ({ currentIndex: room.initialCurrentIndex || 0, total: room.employees.length, employee: room.employees[room.initialCurrentIndex || 0] || null, preVotingClosed: !!room.preVotingClosed });

const results = (room, mode = 'live') => {
  const decisions = mode === 'initial' ? (room.initialDecisions || {}) : (room.decisions || {});
  const discussionNotes = mode === 'initial' ? (room.initialDiscussionNotes || {}) : (room.discussionNotes || {});
  const voteStore = mode === 'initial' ? (room.initialVotes || {}) : (room.votes || {});
  return room.employees.map(e => {
    const voteMap = voteStore[e.id] || {}, allVotes = Object.values(voteMap), vs = allVotes.filter(v => !v.skip), skipped = allVotes.filter(v => v.skip).length, n = vs.length,
      plCounts = [1, 2, 3, 4, 5].map(level => vs.filter(v => v.pl === level).length),
      potCounts = [1, 2, 3].map(level => vs.filter(v => v.pot === level).length),
      gridCounts = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(box => vs.filter(v => gridBox(v.pl, v.pot) === box).length),
      plGroupCounts = [plCounts[0] + plCounts[1], plCounts[2], plCounts[3] + plCounts[4]],
      potGroupCounts = [potCounts[0], potCounts[1], potCounts[2]],
      comments = vs.map(v => voteCommentText(v.comment)).filter(Boolean),
      voteDetails = Object.entries(voteMap).map(([evaluatorId, v]) => ({ evaluator: String(v.evaluatorName || evaluatorId || '').replace(/^name:/, ''), pl: v.pl || null, pot: v.pot || null, grid: v.skip ? null : gridBox(v.pl, v.pot), skip: !!v.skip, comment: voteCommentText(v.comment), commentDetail: cleanVoteComment(v.comment), updatedAt: v.updatedAt || '', source: v.source || 'online' })),
      majorityPL = majorityLevel(plCounts, n), majorityPOT = majorityLevel(potCounts, n),
      recommendedGrid = recommendedGridByShare(gridCounts, n), recommendedShare = recommendedGrid ? gridCounts[recommendedGrid - 1] / n : 0,
      recommendedPl = recommendedPlForGrid(vs, recommendedGrid);
    return { ...e, count: n, skipped, avgPL: n ? vs.reduce((s, v) => s + v.pl, 0) / n : 0, avgPOT: n ? vs.reduce((s, v) => s + v.pot, 0) / n : 0, plCounts, potCounts, plGroupCounts, potGroupCounts, gridCounts, comments, voteDetails, majorityPL, majorityPOT, recommendedGrid, recommendedShare, recommendedPl, decision: decisions[e.id] || null, discussionNote: cleanDiscussionNote(discussionNotes[e.id]) };
  });
};

// ---------- Excel 解析（JSZip 直接读 xlsx 内部 XML，兼容 Workers） ----------
const decodeXml = value => String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));
const columnIndex = letters => [...letters].reduce((value, ch) => value * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const attr = (attrs, name) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1] || '';
async function parseEmployeeWorkbook(buffer) {
  const zip = await JSZip.loadAsync(buffer), sharedXml = await zip.file('xl/sharedStrings.xml')?.async('string'),
    shared = sharedXml ? [...(sharedXml.match(/<(?:\w+:)?si\b[\s\S]*?<\/(?:\w+:)?si>/g) || [])].map(block => decodeXml([...block.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(m => m[1]).join(''))) : [],
    sheetName = Object.keys(zip.files).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).sort()[0];
  if (!sheetName) throw new Error('No worksheet');
  const sheetXml = await zip.file(sheetName).async('string'), values = [];
  for (const rowMatch of sheetXml.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const rowNumber = Number(attr(rowMatch[1], 'r')) || values.length + 1, row = [];
    for (const cellMatch of rowMatch[2].matchAll(/<(?:\w+:)?c\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?c>/g)) {
      const address = attr(cellMatch[1], 'r'), letters = /^[A-Z]+/i.exec(address)?.[0]; if (!letters) continue;
      const type = attr(cellMatch[1], 't'), body = cellMatch[2], raw = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1] ?? '', inline = [...body.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(m => m[1]).join('');
      row[columnIndex(letters)] = type === 's' ? shared[Number(raw)] ?? '' : type === 'inlineStr' ? decodeXml(inline) : decodeXml(raw)
    }
    values[rowNumber - 1] = row
  }
  const photosByCell = new Map(), drawingNames = Object.keys(zip.files).filter(name => /^xl\/drawings\/drawing\d+\.xml$/i.test(name));
  for (const drawingName of drawingNames) {
    const drawingXml = await zip.file(drawingName).async('string'), relName = `xl/drawings/_rels/${drawingName.split('/').pop()}.rels`, relXml = await zip.file(relName)?.async('string'), rels = new Map();
    for (const rel of String(relXml || '').matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) rels.set(attr(rel[1], 'Id'), attr(rel[1], 'Target'));
    for (const block of drawingXml.matchAll(/<xdr:(?:twoCellAnchor|oneCellAnchor)\b[^>]*>([\s\S]*?)<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/g)) {
      const content = block[1], from = /<xdr:from>([\s\S]*?)<\/xdr:from>/.exec(content)?.[1] || '',
        col = Number(/<xdr:col>(\d+)<\/xdr:col>/.exec(from)?.[1]), row = Number(/<xdr:row>(\d+)<\/xdr:row>/.exec(from)?.[1]),
        relId = /<a:blip\b[^>]*r:embed="([^"]+)"/.exec(content)?.[1];
      if (!relId) continue; const target = rels.get(relId); if (!target) continue;
      const mediaPath = target.startsWith('/') ? target.slice(1) : target.replace(/^(\.\.\/)+/, 'xl/'),
        entry = zip.file(mediaPath); if (!entry) continue;
      const ext = mediaPath.split('.').pop().toLowerCase(), mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png',
        base64 = await entry.async('base64');
      if (base64.length <= 12000000) photosByCell.set(`${row}:${col}`, `data:${mime};base64,${base64}`)
    }
  }
  return { values, photosByCell }
}

const normalizeHeader = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
const pickColumn = (headers, names) => headers.findIndex(h => names.includes(normalizeHeader(h)));
const parseLevelValue = (value, prefix, max) => { const text = String(value ?? '').trim().toUpperCase(); const re = new RegExp(prefix + '\\s*([1-' + max + '])|^([1-' + max + '])$'); const match = text.match(re); return match ? Number(match[1] || match[2]) : 0 };
const truthySkip = value => ['是', 'yes', 'y', 'true', '1', 'skip', '跳过', '不认识', '不熟悉', 'na', 'n/a'].includes(String(value ?? '').trim().toLowerCase());

const xmlEscape = value => String(value ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const xlsxCell = (value, col, row) => '<c r="' + col + row + '" t="inlineStr"><is><t>' + xmlEscape(value) + '</t></is></c>';
const xlsxRow = (values, row) => '<row r="' + row + '">' + values.map((v, i) => xlsxCell(v, String.fromCharCode(65 + i), row)).join('') + '</row>';

const hashPassword = p => { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(String(p), salt, 64).toString('hex') };
const verifyPassword = (p, v) => { try { const [salt, hash] = String(v || '').split(':'), a = scryptSync(String(p), salt, 64), b = Buffer.from(hash, 'hex'); return a.length === b.length && timingSafeEqual(a, b) } catch { return false } };
const normalizeUsername = v => String(v || '').trim().toLowerCase().slice(0, 50);
const publicUser = u => u ? { id: u.id, username: u.username, name: u.name, role: u.role, enabled: u.enabled !== false } : null;
const cookies = req => Object.fromEntries(String(req.headers.get('cookie') || '').split(';').map(x => x.trim().split(/=(.*)/s)).filter(x => x[0]));
const roomOwnedBy = (room, u) => !!room && room.ownerId === u?.id;

// ---------- HTTP 帮助函数 ----------
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const redirect = (location, status = 302) => new Response(null, { status, headers: { location } });
const csvResponse = (csv, filename) => new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store, no-cache, must-revalidate' } });

const protectedPages = new Set(['/home.html', '/admin.html', '/summary.html', '/initial-results.html', '/accounts.html', '/change-password.html']);

// ---------- Durable Object ----------
export class TalentStore {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.loaded = false;
    this.store = null;      // { rooms, roomOrder, users }
    this.sessions = new Map();
    this.saveTimer = null;
  }

  // 惰性加载：DO 可能休眠后被重新唤醒
  async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    const persisted = await this.ctx.storage.get('store');
    let store;
    if (persisted?.rooms) {
      store = persisted;
    } else if (persisted) {
      // 兼容旧版单房间 session.json 结构
      store = { rooms: { default: { ...clone(defaults), ...Object.fromEntries(sessionKeys.map(k => [k, persisted[k] ?? clone(defaults[k])])), name: persisted.name || '默认讨论区', createdAt: persisted.createdAt || new Date().toISOString() } }, roomOrder: ['default'] };
    } else {
      store = { rooms: { default: makeRoom() }, roomOrder: ['default'] };
    }
    store.roomOrder = Array.isArray(store.roomOrder) && store.roomOrder.length ? store.roomOrder : Object.keys(store.rooms);
    store.users = store.users && typeof store.users === 'object' ? store.users : {};
    for (const room of Object.values(store.rooms)) {
      if (!Object.prototype.hasOwnProperty.call(room, 'initialCurrentIndex')) room.initialCurrentIndex = 0;
      if (!Object.prototype.hasOwnProperty.call(room, 'initialDecisions')) room.initialDecisions = clone(room.decisions || {});
      if (!Object.prototype.hasOwnProperty.call(room, 'initialDiscussionNotes')) room.initialDiscussionNotes = clone(room.discussionNotes || {});
      if (!Object.prototype.hasOwnProperty.call(room, 'locked')) room.locked = false;
      if (!Object.prototype.hasOwnProperty.call(room, 'preVotingClosed')) room.preVotingClosed = false;
      if (!Object.prototype.hasOwnProperty.call(room, 'initialVotes')) { room.initialVotes = clone(room.votes || {}); room.votes = {}; room.voteDataSeparatedAt = new Date().toISOString() }
      room.employees = normalizeEmployees(Array.isArray(room.employees) ? room.employees : []);
    }
    this.store = store;
    this.sessions = new Map(Object.entries(await this.ctx.storage.get('sessions') || {}));
  }

  save() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => { this.saveTimer = null; this.ctx.storage.put('store', this.store); this.ctx.storage.put('sessions', Object.fromEntries(this.sessions)) }, 120) }
  saveNow() { clearTimeout(this.saveTimer); this.saveTimer = null; return Promise.all([this.ctx.storage.put('store', this.store), this.ctx.storage.put('sessions', Object.fromEntries(this.sessions))]) }

  roomOf(roomId) { return this.store.rooms[roomId] || this.store.rooms.default }

  // WebSocket 广播：按房间 tag 找到所有连接（含休眠中的，会自动唤醒）
  broadcast(roomId, type, data) {
    const msg = JSON.stringify({ type, room: roomId, data });
    for (const ws of this.ctx.getWebSockets('room:' + roomId)) { try { ws.readyState === 1 && ws.send(msg) } catch { } }
  }

  userFromRequest(req) {
    const token = cookies(req).talent_session, x = this.sessions.get(token);
    if (!x || x.expiresAt < Date.now()) return null;
    const u = this.store.users[x.userId];
    return u?.enabled === false ? null : u || null;
  }

  setSession(req, res, u) {
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { userId: u.id, expiresAt: Date.now() + 43200000 });
    const secure = new URL(req.url).protocol === 'https:';
    res.headers.append('Set-Cookie', 'talent_session=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200' + (secure ? '; Secure' : ''));
    return res;
  }

  // 手机端二维码地址：优先 PUBLIC_URL，否则用请求本身的域名（Workers 下天然是公网地址）
  mobileUrl(url, override) {
    const room = roomIdFromValue(url.searchParams.get('room'));
    const withRoom = value => { const u = new URL(value); if (roomIdFromValue(room) !== 'default') u.searchParams.set('room', roomIdFromValue(room)); return u.toString() };
    const publicBase = String(this.env.PUBLIC_URL || '').trim();
    if (publicBase) {
      try {
        const base = new URL(publicBase); if (!base.pathname || base.pathname === '/') base.pathname = '/index.html';
        if (override) { const s = new URL(override, base); base.pathname = s.pathname; base.search = s.search; base.hash = s.hash }
        return withRoom(base.toString());
      } catch { }
    }
    // 无 PUBLIC_URL 时：有 override（如 /pre.html）必须尊重，否则二维码会错误指向 /index.html
    if (override) {
      try { return withRoom(new URL(override, url.origin).toString()) } catch { }
    }
    return withRoom(new URL('/index.html', url.origin).toString());
  }

  // ---------- 入口 ----------
  async fetch(request) {
    await this.ensureLoaded();
    // WebSocket 升级：手机端实时同步
    if (request.headers.get('Upgrade') === 'websocket') return this.handleWebSocket(request);
    try {
      return await this.handle(request);
    } catch (error) {
      console.error('DO error', error);
      return json({ error: '服务器内部错误' }, 500);
    }
  }

  handleWebSocket(request) {
    const url = new URL(request.url);
    const rid = roomIdFromValue(url.searchParams.get('room'));
    if (!this.store.rooms[rid]) return new Response(null, { status: 440, statusText: 'Room not found' });
    const pair = new WebSocketPair();
    // 休眠式 WebSocket：连接休眠不占内存，广播时自动唤醒
    this.ctx.acceptWebSocket(pair[1], ['room:' + rid]);
    pair[1].send(JSON.stringify({ type: 'state', room: rid, data: view(this.roomOf(rid)) }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async handle(request) {
    const url = new URL(request.url), path = url.pathname;
    const user = this.userFromRequest(request);

    // 受保护页面（由 worker.mjs 转发）：登录/权限校验
    if (path === '/api/internal/page-guard') {
      const target = String(url.searchParams.get('path') || '/home.html');
      const targetPath = new URL(target, 'https://x').pathname;
      if (!protectedPages.has(targetPath)) return json({ ok: true });
      if (!Object.keys(this.store.users).length) return redirect('/login.html?setup=1');
      if (!user) return redirect('/login.html?next=' + encodeURIComponent(target));
      const roomQ = new URL(target, 'https://x').searchParams.get('room');
      if (!['/home.html', '/accounts.html', '/change-password.html'].includes(targetPath) && !roomOwnedBy(this.store.rooms[roomIdFromValue(roomQ)], user)) {
        return new Response('Access denied', { status: 403 });
      }
      return json({ ok: true });
    }

    if (!path.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    const p = path.slice(4); // 去掉 /api 前缀，与原 Express 挂载路径一致

    // 解析请求体
    let body = {};
    const rawBodyPaths = p === '/import-employees' || p === '/import-initial-votes';
    if (!rawBodyPaths && ['POST', 'PATCH', 'DELETE'].includes(request.method)) {
      const ct = request.headers.get('content-type') || '';
      if (ct.includes('json')) { try { body = await request.json() } catch { } }
    }

    // 房间上下文（原 AsyncLocalStorage 的替代）
    const roomId = roomIdFromValue(url.searchParams.get('room') || body?.room);
    const room = this.roomOf(roomId);

    // 房间不存在检查
    if (roomId !== 'default' && !this.store.rooms[roomId]) return json({ error: '讨论区不存在或链接已失效' }, 404);

    // ---- 认证 API（公开） ----
    if (p === '/auth/status') return json({ setupRequired: !Object.keys(this.store.users).length, user: publicUser(user) });
    if (p === '/auth/setup' && request.method === 'POST') {
      if (Object.keys(this.store.users).length) return json({ error: 'Admin already exists' }, 409);
      const username = normalizeUsername(body.username), password = String(body.password || ''), id = 'u-' + randomBytes(8).toString('hex');
      if (!username || password.length < 8) return json({ error: 'Account and 8-character password required' }, 400);
      const u = { id, username, name: String(body.name || username).trim().slice(0, 60), role: 'admin', enabled: true, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
      this.store.users[id] = u;
      for (const r of Object.values(this.store.rooms)) if (!r.ownerId) r.ownerId = id;
      await this.saveNow();
      return this.setSession(request, json({ ok: true, user: publicUser(u) }), u);
    }
    if (p === '/auth/login' && request.method === 'POST') {
      const u = Object.values(this.store.users).find(x => x.username === normalizeUsername(body.username));
      if (!u || u.enabled === false || !verifyPassword(body.password, u.passwordHash)) return json({ error: 'Incorrect account or password' }, 401);
      this.save();
      return this.setSession(request, json({ ok: true, user: publicUser(u) }), u);
    }
    if (p === '/auth/logout' && request.method === 'POST') {
      const token = cookies(request).talent_session; if (token) this.sessions.delete(token);
      this.save();
      return json({ ok: true }, 200, { 'Set-Cookie': 'talent_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
    }
    if (p === '/auth/change-password' && request.method === 'POST') {
      if (!user) return json({ error: 'Please sign in' }, 401);
      const current = String(body.currentPassword || ''), next = String(body.newPassword || '');
      if (!verifyPassword(current, user.passwordHash)) return json({ error: 'Current password is incorrect' }, 400);
      if (next.length < 8) return json({ error: 'New password must be at least 8 characters' }, 400);
      if (next === 'test12345') return json({ error: 'Please choose a different password' }, 400);
      user.passwordHash = hashPassword(next); user.passwordChangedAt = new Date().toISOString();
      this.save();
      return json({ ok: true });
    }

    // ---- 账号管理（管理员） ----
    if (p.startsWith('/accounts')) {
      if (!user) return json({ error: 'Please sign in' }, 401);
      if (user.role !== 'admin') return json({ error: 'Admin access required' }, 403);
      if (request.method === 'GET') return json(Object.values(this.store.users).map(publicUser));
      if (request.method === 'POST') {
        const username = normalizeUsername(body.username), password = 'test12345', id = 'u-' + randomBytes(8).toString('hex');
        if (!username) return json({ error: 'Account is required' }, 400);
        if (Object.values(this.store.users).some(x => x.username === username)) return json({ error: 'Account already exists' }, 409);
        this.store.users[id] = { id, username, name: String(body.name || username).trim().slice(0, 60), role: 'user', enabled: true, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
        this.save();
        return json({ ok: true, user: publicUser(this.store.users[id]), initialPassword: password });
      }
      const m = /^\/accounts\/([^/]+)$/.exec(p);
      if (request.method === 'PATCH' && m) {
        const u = this.store.users[m[1]];
        if (!u) return json({ error: 'Account not found' }, 404);
        if (typeof body.enabled === 'boolean') u.enabled = body.enabled;
        if (body.resetPassword) { u.passwordHash = hashPassword('test12345'); u.passwordChangedAt = null; for (const [t, x] of this.sessions) if (x.userId === u.id) this.sessions.delete(t) }
        this.save();
        return json({ ok: true, user: publicUser(u) });
      }
      return json({ error: 'Not found' }, 404);
    }

    // ---- 讨论区管理 ----
    if (p === '/rooms' && request.method === 'GET') {
      if (!user) return json({ error: 'Please sign in' }, 401);
      return json(this.store.roomOrder.filter(id => roomOwnedBy(this.store.rooms[id], user)).map(id => ({ id, name: this.store.rooms[id].name || id, total: this.store.rooms[id].employees?.length || 0, locked: !!this.store.rooms[id].locked })));
    }
    if (p === '/rooms' && request.method === 'POST') {
      if (!user) return json({ error: 'Please sign in' }, 401);
      const name = String(body.name || '').trim().slice(0, 60), id = 'room-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex');
      if (!name) return json({ error: 'Room name required' }, 400);
      this.store.rooms[id] = { ...makeRoom(name), ownerId: user.id };
      this.store.roomOrder.push(id); this.save();
      return json({ ok: true, id, name });
    }
    if (/^\/rooms\/([^/]+)\/lock$/.test(p) && request.method === 'POST') {
      const id = roomIdFromValue(/^\/rooms\/([^/]+)\/lock$/.exec(p)[1]), r = this.store.rooms[id];
      if (!roomOwnedBy(r, user)) return json({ error: 'Access denied' }, 403);
      if (!r) return json({ error: '讨论区不存在' }, 404);
      r.locked = Boolean(body.locked); r.lockedAt = r.locked ? new Date().toISOString() : null; r.updatedAt = new Date().toISOString();
      this.save();
      return json({ ok: true, id, locked: r.locked });
    }
    // 锁定保护：除讨论区管理、翻页外的写操作一律拒绝
    if (['POST', 'PATCH', 'DELETE'].includes(request.method)
      && !['/rooms'].includes(p) && !/^\/rooms\/[^/]+\/lock$/.test(p)
      && p !== '/current' && p !== '/initial-current') {
      const roomPath = /^\/rooms\/([^/]+)$/.exec(p);
      const target = roomPath ? this.store.rooms[roomIdFromValue(roomPath[1])] : room;
      if (target?.locked) return json({ error: '讨论区已锁定，请先在讨论区首页解锁' }, 423);
    }
    {
      const m = /^\/rooms\/([^/]+)$/.exec(p);
      if (m && request.method === 'PATCH') {
        const id = roomIdFromValue(m[1]), r = this.store.rooms[id];
        if (!roomOwnedBy(r, user)) return json({ error: 'Access denied' }, 403);
        if (!r) return json({ error: '讨论区不存在' }, 404);
        const name = String(body.name || '').trim().slice(0, 60);
        if (!name) return json({ error: '请输入讨论区名称' }, 400);
        r.name = name; r.updatedAt = new Date().toISOString(); this.save();
        return json({ ok: true, id, name });
      }
      if (m && request.method === 'DELETE') {
        const id = roomIdFromValue(m[1]), r = this.store.rooms[id];
        if (!roomOwnedBy(r, user)) return json({ error: 'Access denied' }, 403);
        if (id === 'default') return json({ error: '默认讨论区不能删除' }, 400);
        if (!this.store.rooms[id]) return json({ error: '讨论区不存在' }, 404);
        delete this.store.rooms[id];
        this.store.roomOrder = this.store.roomOrder.filter(x => x !== id); this.save();
        return json({ ok: true, id });
      }
    }

    // ---- 以下业务 API：需要登录且是房间主人（投票与部分只读接口除外） ----
    const openGet = request.method === 'GET' && ['/state', '/initial-state', '/public-employees', '/my-vote', '/my-votes', '/qr', '/qr.svg'].includes(p);
    const openPost = request.method === 'POST' && p === '/vote';
    if (!openGet && !openPost) {
      if (!user) return json({ error: 'Please sign in' }, 401);
      if (!roomOwnedBy(this.store.rooms[roomId], user)) return json({ error: 'Access denied' }, 403);
    }

    // ---- 状态/翻页 ----
    if (p === '/state' && request.method === 'GET') return json(view(room));
    if (p === '/initial-state' && request.method === 'GET') return json(initialView(room));
    if (p === '/public-employees' && request.method === 'GET') return json(room.employees);
    if (p === '/pre-voting' && request.method === 'POST') {
      room.preVotingClosed = Boolean(body.closed); room.preVotingUpdatedAt = new Date().toISOString();
      this.save(); this.broadcast(roomId, 'pre-voting', initialView(room));
      return json({ ok: true, closed: room.preVotingClosed });
    }
    if (p === '/initial-current' && request.method === 'POST') {
      const requested = Number(body.index), byId = room.employees.findIndex(e => e.id === String(body.employeeId || ''));
      const i = Number.isInteger(requested) ? requested : byId;
      if (!Number.isInteger(i) || i < 0 || i >= room.employees.length) return json({ error: 'Invalid page' }, 400);
      room.initialCurrentIndex = i; const data = initialView(room);
      this.broadcast(roomId, 'initial-current', data); this.save();
      return json(data);
    }
    if (p === '/current' && request.method === 'POST') {
      const i = Number(body.index);
      if (!Number.isInteger(i) || i < 0 || i >= room.employees.length) return json({ error: '无效页码' }, 400);
      room.currentIndex = i; const data = view(room);
      this.broadcast(roomId, 'current', data); this.save();
      return json(data);
    }
    if (p === '/results' && request.method === 'GET') return json(results(room, url.searchParams.get('mode')));

    // ---- 二维码 ----
    if (p === '/qr' && request.method === 'GET') {
      const target = this.mobileUrl(url, String(url.searchParams.get('url') || ''));
      // svgUrl 由 <img> 直接加载，不走前端的 room 包装器，必须显式带上 room，
      // 否则 /qr.svg 端 mobileUrl 读不到房间，二维码会退回 default 讨论区
      return json({ url: target, svgUrl: '/api/qr.svg?room=' + encodeURIComponent(roomId) + '&url=' + encodeURIComponent(target) });
    }
    if (p === '/qr.svg' && request.method === 'GET') {
      const target = this.mobileUrl(url, String(url.searchParams.get('url') || ''));
      const svg = await QRCode.toString(target, { type: 'svg', errorCorrectionLevel: 'H', margin: 2, width: 420, color: { dark: '#111827', light: '#ffffff' } });
      return new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'Cache-Control': 'no-store' } });
    }

    // ---- 员工名单 ----
    if (p === '/employees' && request.method === 'POST') {
      const rawList = (Array.isArray(body.employees) ? body.employees : []).map((e, i) => {
        const employeeNo = String(e.employeeNo || e.id || ('E' + (i + 1))).trim();
        return { id: employeeNo, employeeNo, name: String(e.name || '').trim(), department: String(e.department || '').trim(), role: String(e.role || '').trim(), photo: String(e.photo || '').startsWith('data:image/') ? String(e.photo) : '', fields: cleanFields(e.fields) };
      }).filter(e => e.name);
      const list = normalizeEmployees(rawList);
      if (!list.length) return json({ error: '至少需要一名员工' }, 400);
      room.employees = list; room.currentIndex = 0; room.initialCurrentIndex = 0;
      room.votes = {}; room.initialVotes = {}; room.decisions = {}; room.discussionNotes = {}; room.initialDecisions = {}; room.initialDiscussionNotes = {};
      await this.saveNow();
      this.broadcast(roomId, 'employees'); this.broadcast(roomId, 'results');
      return json({ ok: true, total: list.length, reset: true });
    }

    // ---- 投票 ----
    if (p === '/vote' && request.method === 'POST') {
      const initialMode = url.searchParams.get('mode') === 'initial';
      const voteStore = initialMode ? (room.initialVotes ||= {}) : (room.votes ||= {});
      if (initialMode && room.preVotingClosed) return json({ error: '会前初评已关闭，请联系主持人' }, 423);
      const { evaluatorId, employeeId } = body, pl = Number(body.pl), pot = Number(body.pot),
        comment = cleanVoteComment(body.comment), skip = Boolean(body.skip),
        evaluatorName = String(body.evaluatorName || '').trim().slice(0, 80);
      if (!evaluatorId || !room.employees.some(e => e.id === employeeId)) return json({ error: '无效员工' }, 400);
      voteStore[employeeId] ||= {};
      if (skip) {
        voteStore[employeeId][evaluatorId] = { skip: true, comment, evaluatorName, updatedAt: new Date().toISOString(), source: 'online' };
        await this.saveNow(); this.broadcast(roomId, initialMode ? 'initial-results' : 'results', { employeeId });
        return json({ ok: true, skip: true });
      }
      if (!Number.isInteger(pl) || pl < 1 || pl > 5 || !Number.isInteger(pot) || pot < 1 || pot > 3) return json({ error: '请选择完整等级，或选择 Skip' }, 400);
      voteStore[employeeId][evaluatorId] = { pl, pot, comment, evaluatorName, updatedAt: new Date().toISOString(), source: 'online' };
      await this.saveNow(); this.broadcast(roomId, initialMode ? 'initial-results' : 'results', { employeeId });
      return json({ ok: true });
    }
    if (p === '/my-vote' && request.method === 'GET') {
      const voteStore = url.searchParams.get('mode') === 'initial' ? (room.initialVotes || {}) : (room.votes || {});
      return json(voteStore[String(url.searchParams.get('employeeId'))]?.[String(url.searchParams.get('evaluatorId'))] || null);
    }
    if (p === '/my-votes' && request.method === 'GET') {
      const voteStore = url.searchParams.get('mode') === 'initial' ? (room.initialVotes || {}) : (room.votes || {});
      const raw = String(url.searchParams.get('evaluatorId') || '').trim(), name = String(url.searchParams.get('evaluatorName') || url.searchParams.get('name') || '').trim();
      const ids = [raw, name, name ? 'name:' + name.toLowerCase() : ''].filter(Boolean), unique = [...new Set(ids)];
      if (!unique.length) return json({ error: '请输入评估人姓名或编号' }, 400);
      const items = [];
      for (const e of room.employees) {
        const voteMap = voteStore[e.id] || {}, entries = Object.entries(voteMap),
          matchedKey = unique.find(id => Object.prototype.hasOwnProperty.call(voteMap, id)),
          matchedEntry = matchedKey ? [matchedKey, voteMap[matchedKey]] : entries.find(([_id, v]) => name && String(v.evaluatorName || '').trim().toLowerCase() === name.toLowerCase());
        if (!matchedEntry) continue;
        const [matched, v] = matchedEntry;
        items.push({ employeeId: e.id, employeeNo: e.employeeNo || e.id, name: e.name, department: e.department, role: e.role, fields: e.fields || {}, evaluator: String(v.evaluatorName || matched || '').replace(/^name:/, ''), pl: v.pl || null, pot: v.pot || null, grid: v.skip ? null : gridBox(v.pl, v.pot), skip: !!v.skip, comment: voteCommentText(v.comment), commentDetail: cleanVoteComment(v.comment), updatedAt: v.updatedAt || '', source: v.source || 'online' });
      }
      return json({ ok: true, evaluator: raw || name, total: items.length, items });
    }

    // ---- 讨论备注 / 最终结论 ----
    if (p === '/discussion-note' && request.method === 'POST') {
      const employeeId = String(body.employeeId || ''), note = cleanDiscussionNote(body.note), initialMode = url.searchParams.get('mode') === 'initial';
      if (!room.employees.some(e => e.id === employeeId)) return json({ error: '无效员工' }, 400);
      const notes = initialMode ? (room.initialDiscussionNotes ||= {}) : (room.discussionNotes ||= {});
      notes[employeeId] = note; await this.saveNow();
      this.broadcast(roomId, initialMode ? 'initial-results' : 'results', { employeeId });
      return json({ ok: true, note });
    }
    if (p === '/decision' && request.method === 'POST') {
      const employeeId = String(body.employeeId || ''), type = body.type, initialMode = url.searchParams.get('mode') === 'initial';
      const decisions = initialMode ? (room.initialDecisions ||= {}) : (room.decisions ||= {});
      if (!room.employees.some(e => e.id === employeeId) || !['direct', 'pending'].includes(type)) return json({ error: '无效讨论结论' }, 400);
      if (type === 'pending') decisions[employeeId] = { type, grid: null, pl: null, updatedAt: new Date().toISOString() };
      else {
        const grid = Number(body.grid), pl = Number(body.pl || 0);
        if (!Number.isInteger(grid) || grid < 1 || grid > 9) return json({ error: '请选择最终 Box' }, 400);
        if ([1, 2, 4].includes(grid) && ![4, 5].includes(pl)) return json({ error: '请选择具体绩效：PL4 或 PL5' }, 400);
        if ([6, 8, 9].includes(grid) && ![1, 2].includes(pl)) return json({ error: '请选择具体绩效：PL1 或 PL2' }, 400);
        decisions[employeeId] = { type, grid, pl: pl || null, updatedAt: new Date().toISOString() };
      }
      await this.saveNow();
      this.broadcast(roomId, initialMode ? 'initial-results' : 'results', { employeeId });
      return json({ ok: true, decision: decisions[employeeId] });
    }

    // ---- Excel 导入员工 ----
    if (p === '/import-employees' && request.method === 'POST') {
      try {
        const buffer = await request.arrayBuffer();
        if (!buffer.byteLength) return json({ error: '请选择有效的 Excel 文件' }, 400);
        const { values, photosByCell } = await parseEmployeeWorkbook(buffer);
        if (!values.length) return json({ error: '模板中没有员工数据' }, 400);
        const headers = (values[0] || []).map(v => String(v || '').trim());
        const idCol = pickColumn(headers, ['员工编号', '工号', 'employeeno', 'employeenumber', 'employeeid', 'eployeeno', 'id']);
        const nameCol = pickColumn(headers, ['姓名', '员工姓名', 'name', 'employeename']);
        const deptCol = pickColumn(headers, ['部门', 'dept', 'department']);
        const roleCol = pickColumn(headers, ['岗位', '职位', 'position', 'positiob', 'role']);
        if (nameCol < 0) return json({ error: '模板至少需要 Name/姓名 列' }, 400);
        const photoCol = headers.findIndex(h => ['照片', 'photo', 'picture'].includes(normalizeHeader(h)));
        const reserved = new Set([idCol, nameCol, deptCol, roleCol, photoCol].filter(i => i >= 0));
        const customColumns = headers.map((name, index) => ({ name, index })).filter(x => x.name && !reserved.has(x.index));
        const employees = values.slice(1).map((row, i) => {
          const id = String(idCol >= 0 ? (row && row[idCol]) || '' : 'E' + (i + 1)).trim();
          const name = String((row && row[nameCol]) || '').trim();
          const department = String(deptCol >= 0 ? (row && row[deptCol]) || '' : '').trim();
          const role = String(roleCol >= 0 ? (row && row[roleCol]) || '' : '').trim();
          const photo = photoCol >= 0 ? (photosByCell.get((i + 1) + ':' + photoCol) || '') : '';
          const fields = cleanFields(Object.fromEntries(customColumns.map(({ name, index }) => [name, row ? row[index] ?? '' : ''])));
          return { id, name, department, role, photo, fields };
        }).filter(e => e.name);
        if (!employees.length) return json({ error: '模板中至少需要一名员工' }, 400);
        return json({ ok: true, employees, count: employees.length, photoCount: employees.filter(e => e.photo).length, fieldCount: customColumns.length, fieldNames: customColumns.map(x => x.name) });
      } catch (error) {
        console.error('Excel import failed', error);
        return json({ error: '无法读取该文件，请确认使用新版 .xlsx 模板' }, 400);
      }
    }

    // ---- 初评模板下载 ----
    if (p === '/initial-votes-template.xlsx' && request.method === 'GET') {
      const zip = new JSZip();
      const headers = ['Employee No', 'Name', 'Dept', 'Position', 'Band', 'EDSP 2025', 'EDSP 2024', 'PL 2025', 'PL 2024', 'PL 2026', 'POT 2026', 'Box', 'Comments'];
      const rows = [headers, ...room.employees.map(e => [e.employeeNo || e.id, e.name, e.department, e.role, e.fields?.Band || e.fields?.band || '', e.fields?.['EDSP 2025'] || e.fields?.EDSP2025 || '', e.fields?.['EDSP 2024'] || e.fields?.EDSP2024 || '', e.fields?.['PL 2025'] || e.fields?.PL2025 || '', e.fields?.['PL 2024'] || e.fields?.PL2024 || '', '', '', '', ''])];
      const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + rows.map((row, i) => xlsxRow(row, i + 1)).join('') + '</sheetData></worksheet>';
      zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
      zip.folder('_rels').file('.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
      zip.folder('xl').file('workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="初评导入" sheetId="1" r:id="rId1"/></sheets></workbook>');
      zip.folder('xl').folder('_rels').file('workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
      zip.folder('xl').folder('worksheets').file('sheet1.xml', sheet);
      const buffer = await zip.generateAsync({ type: 'uint8array' });
      return new Response(buffer, { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="initial-votes-template.xlsx"' } });
    }

    // ---- Excel 导入初评 ----
    if (p === '/import-initial-votes' && request.method === 'POST') {
      try {
        if (room.preVotingClosed) return json({ error: '会前初评已关闭，请先重新开放投票' }, 423);
        const buffer = await request.arrayBuffer();
        if (!buffer.byteLength) return json({ error: '请选择初评结果 Excel 文件' }, 400);
        const { values } = await parseEmployeeWorkbook(buffer);
        const headers = (values[0] || []).map(v => String(v || '').trim());
        const employeeIdCol = pickColumn(headers, ['员工编号', '工号', 'employeeno', 'employeenumber', 'employeeid', 'eployeeno', 'id']);
        const nameCol = pickColumn(headers, ['姓名', '员工姓名', 'name', 'employeename']);
        const evaluatorCol = pickColumn(headers, ['评估人', '评委', '评价人', 'evaluator', 'evaluatorid', '评估人id']);
        const plCol = pickColumn(headers, ['pl', 'pl2026', '绩效', '绩效等级', 'performance']);
        const potCol = pickColumn(headers, ['pot', 'pot2026', '潜力', '潜力等级', 'potential']);
        const boxCol = pickColumn(headers, ['box', 'box2026', '宫格', '九宫格']);
        const commentCol = pickColumn(headers, ['comments', 'comment', '备注', '评语']);
        const skipCol = pickColumn(headers, ['skip', '跳过', '不认识', 'na']);
        if ((plCol < 0 || potCol < 0) && boxCol < 0) return json({ error: '模板至少需要：PL 2026、POT 2026，或 Box 列' }, 400);
        if (employeeIdCol < 0 && nameCol < 0) return json({ error: '模板需要员工编号或姓名' }, 400);
        let imported = 0, skipped = 0; const errors = [];
        for (const [i, row] of values.slice(1).entries()) {
          if (!row || !row.some(v => String(v ?? '').trim())) continue;
          const line = i + 2, id = String(employeeIdCol >= 0 ? row[employeeIdCol] || '' : '').trim(), name = String(nameCol >= 0 ? row[nameCol] || '' : '').trim(),
            evaluator = String(evaluatorCol >= 0 ? row[evaluatorCol] || '' : '').trim() || ('导入评委-' + line);
          const employee = room.employees.find(e => id && String(e.employeeNo || e.id) === id && (!name || String(e.name) === name)) || room.employees.find(e => name && String(e.name) === name);
          if (!employee) { errors.push('第 ' + line + ' 行：找不到员工 ' + (id || name)); continue }
          const comment = String(commentCol >= 0 ? row[commentCol] || '' : '').trim().slice(0, 1000), skip = skipCol >= 0 && truthySkip(row[skipCol]);
          room.initialVotes[employee.id] ||= {};
          if (skip) { room.initialVotes[employee.id][evaluator] = { skip: true, comment, updatedAt: new Date().toISOString(), source: 'excel' }; skipped++; continue }
          let pl = plCol >= 0 ? parseLevelValue(row[plCol], 'PL', 5) : 0, pot = potCol >= 0 ? parseLevelValue(row[potCol], 'POT', 3) : 0;
          const box = boxCol >= 0 ? Number(String(row[boxCol] ?? '').toUpperCase().replace('BOX', '').trim()) : 0;
          if ((!pl || !pot) && box >= 1 && box <= 9) {
            pot = { 1: 3, 2: 2, 3: 3, 4: 1, 5: 2, 6: 3, 7: 1, 8: 2, 9: 1 }[box] || pot;
            if ([3, 5, 7].includes(box)) pl = 3;
          }
          if (!pl || !pot) { errors.push('第 ' + line + ' 行：PL/POT 无效；Box 1/2/4/6/8/9 仍需填写具体 PL'); continue }
          room.initialVotes[employee.id][evaluator] = { pl, pot, comment, updatedAt: new Date().toISOString(), source: 'excel' };
          imported++;
        }
        await this.saveNow(); this.broadcast(roomId, 'initial-results');
        return json({ ok: true, imported, skipped, errorCount: errors.length, errors: errors.slice(0, 20) });
      } catch (error) {
        console.error('Initial vote import failed', error);
        return json({ error: '无法读取初评结果 Excel，请确认使用 .xlsx 格式' }, 400);
      }
    }

    // ---- 初评进度 CSV ----
    if (p === '/export-initial.csv' && request.method === 'GET') {
      const employeeField = (employee, ...names) => {
        const wanted = new Set(names.map(name => String(name).toLowerCase().replace(/[^a-z0-9]/g, '')));
        const entry = Object.entries(employee.fields || {}).find(([key]) => wanted.has(String(key).toLowerCase().replace(/[^a-z0-9]/g, '')));
        return entry?.[1] || '';
      };
      const evaluators = new Map();
      for (const employee of room.employees) {
        for (const [evaluatorId, vote] of Object.entries((room.initialVotes || {})[employee.id] || {})) {
          const display = String(vote.evaluatorName || evaluatorId || '').replace(/^name:/, '') || '未知评估人';
          const key = vote.evaluatorName ? 'name:' + display.toLowerCase() : 'id:' + evaluatorId;
          if (!evaluators.has(key)) evaluators.set(key, { name: display, votes: {} });
          const current = evaluators.get(key).votes[employee.id];
          if (!current || String(vote.updatedAt || '') >= String(current.updatedAt || '')) evaluators.get(key).votes[employee.id] = vote;
        }
      }
      const total = room.employees.length, rows = [['评估人', '已处理', '员工总数', '完成率', '员工编号', '姓名', '部门', '岗位', 'Band', 'EDSP 2025', 'EDSP 2024', 'PL 2025', 'PL 2024', '状态', 'PL', 'POT', 'Box', 'Strength', 'Improvement Area', 'Others', '提交时间']];
      const append = (evaluator, employee, vote, completed) => {
        const comment = cleanVoteComment(vote?.comment), status = !vote ? '未评' : vote.skip ? 'Skip' : '已评';
        rows.push([evaluator, completed, total, total ? Math.round(completed / total * 100) + '%' : '0%', employee.employeeNo || employee.id, employee.name, employee.department, employee.role, employeeField(employee, 'Band'), employeeField(employee, 'EDSP 2025', 'EDSP2025'), employeeField(employee, 'EDSP 2024', 'EDSP2024'), employeeField(employee, 'PL 2025', 'PL2025'), employeeField(employee, 'PL 2024', 'PL2024'), status, vote && !vote.skip && vote.pl ? 'PL' + vote.pl : '', vote && !vote.skip && vote.pot ? 'POT' + vote.pot : '', vote && !vote.skip ? gridBox(vote.pl, vote.pot) : '', comment.strength, comment.improvementArea, comment.others, vote?.updatedAt || '']);
      };
      if (evaluators.size) {
        for (const evaluator of evaluators.values()) {
          const completed = room.employees.filter(employee => evaluator.votes[employee.id]).length;
          for (const employee of room.employees) append(evaluator.name, employee, evaluator.votes[employee.id], completed);
        }
      } else {
        for (const employee of room.employees) append('', employee, null, 0);
      }
      const csv = '\ufeff' + rows.map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
      return csvResponse(csv, 'initial-evaluation-progress.csv');
    }

    // ---- 盘点结果 CSV ----
    if (['/export.csv', '/export-live-summary.csv', '/export-initial-summary.csv'].includes(p) && request.method === 'GET') {
      const mode = p === '/export-initial-summary.csv' ? 'initial' : (p === '/export.csv' && url.searchParams.get('mode') === 'initial' ? 'initial' : 'live');
      const sendTalentResultsCsv = () => {
        const customHeaders = [...new Set(room.employees.flatMap(e => Object.keys(e.fields || {})))];
        const finalPot = grid => ({ 1: 3, 2: 2, 3: 3, 4: 1, 5: 2, 6: 3, 7: 1, 8: 2, 9: 1 })[Number(grid)] || '';
        const rows = [
          ['员工编号', '姓名', '部门', '岗位', ...customHeaders, '投票人数', 'Box 1票数', 'Box 2票数', 'Box 3票数', 'Box 4票数', 'Box 5票数', 'Box 6票数', 'Box 7票数', 'Box 8票数', 'Box 9票数', '系统推荐 Box', '评估备注', 'Strength', 'Improvement Area', 'Next Step', 'Development Measures', 'Risk of Leaving', '讨论结论', 'Final Box', 'Final PL', 'Final POT'],
          ...results(room, mode).map(x => [x.employeeNo || x.id, x.name, x.department, x.role, ...customHeaders.map(h => x.fields?.[h] || ''), x.count, ...x.gridCounts, x.recommendedGrid, (x.comments || []).join(' | '), x.discussionNote?.strength || '', x.discussionNote?.improvementArea || '', x.discussionNote?.nextStep || '', x.discussionNote?.developmentMeasures || '', x.discussionNote?.riskOfLeaving || '', x.decision?.type === 'direct' ? '直接落位' : x.decision?.type === 'pending' ? '待定' : '未讨论', x.decision?.grid || '', x.decision?.pl ? ('PL' + x.decision.pl) : '', x.decision?.type === 'direct' && finalPot(x.decision.grid) ? ('POT' + finalPot(x.decision.grid)) : ''])
        ];
        const csv = '\ufeff' + rows.map(row => row.map(v => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\r\n');
        return csvResponse(csv, mode === 'initial' ? 'initial-talent-results-final-pot.csv' : 'talent-results-final-pot.csv');
      };
      return sendTalentResultsCsv();
    }

    // ---- 数据迁移/备份（管理员）：从旧版 session.json 导入、导出全部数据 ----
    if (p === '/admin/import-store' && request.method === 'POST') {
      if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, 403);
      const incoming = body;
      if (!incoming || typeof incoming !== 'object' || (!incoming.rooms && !incoming.employees)) return json({ error: '无效的数据格式，请上传 data/session.json 的内容' }, 400);
      const importPersisted = incoming;
      let store;
      if (importPersisted.rooms) store = importPersisted;
      else store = { rooms: { default: { ...clone(defaults), ...Object.fromEntries(sessionKeys.map(k => [k, importPersisted[k] ?? clone(defaults[k])])), name: importPersisted.name || '默认讨论区', createdAt: importPersisted.createdAt || new Date().toISOString() } }, roomOrder: ['default'] };
      store.roomOrder = Array.isArray(store.roomOrder) && store.roomOrder.length ? store.roomOrder : Object.keys(store.rooms);
      store.users = store.users && typeof store.users === 'object' ? store.users : this.store.users;
      for (const r of Object.values(store.rooms)) {
        r.employees = normalizeEmployees(Array.isArray(r.employees) ? r.employees : []);
        if (!r.locked) r.locked = false;
        if (!r.preVotingClosed) r.preVotingClosed = false;
        r.initialVotes ||= {}; r.votes ||= {};
      }
      this.store = store;
      await this.saveNow();
      return json({ ok: true, rooms: Object.keys(store.rooms).length, employees: Object.values(store.rooms).reduce((s, r) => s + r.employees.length, 0) });
    }
    if (p === '/admin/export-store' && request.method === 'GET') {
      if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, 403);
      return new Response(JSON.stringify({ rooms: this.store.rooms, roomOrder: this.store.roomOrder, users: this.store.users }, null, 2), { headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="session.json"' } });
    }

    return json({ error: 'Not found' }, 404);
  }

  // 休眠式 WebSocket 可选钩子
  webSocketMessage() { }
  webSocketClose() { }
}
