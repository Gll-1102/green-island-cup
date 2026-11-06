// ========== 全局状态 ==========
let currentUser = null;
let isGuest = false;
let socket = null;
let allMatches = [];
let allExhibitions = [];
let allTeams = [];

let allPlayers = [];
let showHiddenTest = false;
let allReferees = [];
let suspendedIds = new Set(); // A2 处于停赛期(active=1)的球员id
let notifications = [];
let editingMatchId = null;


// HTML 转义（防止文本字段注入/破坏渲染）
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// ========== 停服维护：球队/裁判端全局拦截（管理员、游客不受影响）==========
let __maintShown = false;
function showMaintenanceKick(msg, reason) {
  if (__maintShown) return;
  __maintShown = true;
  const titleEl = document.getElementById('maintenanceKickTitle');
  if (titleEl) titleEl.textContent = reason === 'manual' ? '系统已停止服务' : '系统维护中';
  const t = document.getElementById('maintenanceKickText');
  if (t) t.textContent = msg || (reason === 'manual'
    ? '系统已由管理员手动停止服务，恢复时间请以管理员通知为准。'
    : '系统维护中，请稍后再试。');
  const m = document.getElementById('maintenanceKickModal');
  if (m) m.classList.add('show');
}
window.maintenanceLogout = async function () {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  location.href = '/login.html';
};
(function installMaintenanceFetchGuard() {
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const res = await origFetch(...args);
    try {
      if (res.status === 503 && (res.headers.get('content-type') || '').includes('application/json')) {
        res.clone().json().then(d => {
          if (d && d.maintenance && currentUser && ['viewer', 'referee'].includes(currentUser.role)) {
            showMaintenanceKick(d.error, d.reason);
          }
        }).catch(() => {});
      }
    } catch (e) {}
    return res;
  };
})();
async function checkMaintenanceOnBoot() {
  try {
    const d = await fetch('/api/settings/public?t=' + Date.now()).then(r => r.json());
    if (d && d.maintenance_active && currentUser && ['viewer', 'referee'].includes(currentUser.role)) {
      showMaintenanceKick(d.maintenance_message, d.maintenance_reason);
    }
  } catch (e) {}
}

// ========== 双组别（男子组 men / 女子组 women / 全部 all）==========
let currentGender = (function () {
  try { const v = localStorage.getItem('gic_gender'); return ['men', 'women', 'all'].includes(v) ? v : 'men'; } catch (e) { return 'men'; }
})();
function genderOk(g) { if (currentGender === 'all') return true; return (g || 'men') === currentGender; }
function genderTeams() { return allTeams.filter(t => genderOk(t.gender || 'men')); }
function genderMatches() { return allMatches.filter(m => genderOk(m.gender || 'men')); }
function genderPlayers() { return allPlayers.filter(p => genderOk(p.gender || 'men')); }
// 女子组内部场序=match_number-100（101~109 展示为 1~9）
function displayMatchNum(m) { return (m.gender === 'women') ? (m.match_number - 100) : m.match_number; }
function isWomenMatch(m) { return m && m.gender === 'women'; }
function setGender(g) {
  if (!['men', 'women', 'all'].includes(g)) return;
  currentGender = g;
  try { localStorage.setItem('gic_gender', g); } catch (e) {}
  document.querySelectorAll('#genderSwitch .gs-btn, #mmGender .gs-btn').forEach(b => b.classList.toggle('active', b.dataset.gender === g));
  refreshCurrentPage();
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('#genderSwitch .gs-btn');
  if (btn) setGender(btn.dataset.gender);
});

// 安全解析服务端JSON字段：脏数据时回退到兜底对象，绝不让单行坏数据白屏整页
function safeParse(raw, fallback) {
  if (typeof raw !== 'string' || !raw) return fallback;
  try { const v = JSON.parse(raw); return (v && typeof v === 'object') ? v : fallback; }
  catch (e) { return fallback; }
}

// ========== GET 接口短缓存：消除云服务器往返造成的切页卡顿 ==========
// 同一 /api GET 请求在 TTL 内直接复用，切页“秒开”；任何写操作(非GET)或收到实时推送时立即清空，保证数据新鲜
(function () {
  const _fetch = window.fetch.bind(window);
  const _cache = new Map();
  const TTL = 8000; // 8秒
  const NO_CACHE = ['/api/auth/captcha']; // 验证码必须每次全新
  function fakeResp(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return JSON.parse(body); },
      async text() { return body; },
      headers: { get: () => null },
      clone() { return this; }
    };
  }
  window.__invalidateApiCache = function () { _cache.clear(); };
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init && init.method) || (typeof input !== 'string' && input && input.method) || 'GET';
    const isGet = !method || String(method).toUpperCase() === 'GET';
    if (!isGet) { _cache.clear(); return _fetch(input, init); } // 写操作先清缓存
    if (!url.startsWith('/api/') || NO_CACHE.some(x => url.includes(x))) return _fetch(input, init);
    const now = Date.now();
    const hit = _cache.get(url);
    if (hit && now - hit.t < TTL) return Promise.resolve(fakeResp(hit.s, hit.b));
    return _fetch(input, init).then(async res => {
      if (res.status >= 200 && res.status < 300) {
        try { const b = await res.clone().text(); _cache.set(url, { t: Date.now(), s: res.status, b }); } catch (e) {}
      }
      return res;
    });
  };
})();

// ========== 实时数据联动（Socket.IO）==========
// 任何一端（管理员/球队/裁判）提交数据后，服务端广播 dataUpdate；
// 所有打开本系统的页面收到后自动"清缓存→重载数据→重渲染当前页"，无需手动刷新。
let __liveTimer = null;
let __dataDirtyWhileModal = false;
function __anyModalOpen() {
  return document.querySelectorAll('.modal.show').length > 0;
}
async function __applyLiveUpdate() {
  try {
    if (window.__invalidateApiCache) window.__invalidateApiCache();
    await loadAllData();
    if (__anyModalOpen()) {
      __dataDirtyWhileModal = true; // 弹窗打开期间不打断输入，关闭后再渲染
    } else {
      __dataDirtyWhileModal = false;
      refreshCurrentPage();
    }
  } catch (e) { try { console.error('实时更新失败', e); } catch (_) {} }
}
function scheduleLiveUpdate() {
  clearTimeout(__liveTimer);
  __liveTimer = setTimeout(__applyLiveUpdate, 300); // 合并连续广播
}
// ========== 测试沙箱：切换组别/模拟球队（仅 isTest 账号）==========
async function applySandbox(g, teamId) {
  currentUser.gender = g;
  currentGender = g;
  currentUser.team_id = teamId ? Number(teamId) : null;
  if (window.__invalidateApiCache) window.__invalidateApiCache();
  await loadAllData();
  refreshCurrentPage();
}
function buildSandboxBar() {
  if (!currentUser || !currentUser.isTest) return;
  const bar = document.createElement('div');
  bar.id = 'sandboxBar';
  bar.innerHTML =
    '<span style="font-weight:700;color:#C8A45C">🧪 测试沙箱</span>' +
    '<label style="display:flex;align-items:center;gap:6px">组别 <select id="sb_gender"><option value="men">男子组</option><option value="women">女子组</option></select></label>' +
    '<label style="display:flex;align-items:center;gap:6px">模拟球队 <select id="sb_team" style="min-width:170px"></select></label>' +
    '<span style="font-size:12px;opacity:.85">数据仅测试，对其他端不可见，登出自动清空</span>';
  Object.assign(bar.style, { position: 'fixed', top: '0', left: '0', right: '0', zIndex: '9999', display: 'flex', gap: '14px', alignItems: 'center', padding: '8px 16px', background: '#1A4D3A', color: '#fff', fontSize: '13px', boxShadow: '0 2px 8px rgba(0,0,0,.25)', flexWrap: 'wrap' });
  document.body.appendChild(bar);
  document.body.style.paddingTop = '48px';
  const gSel = document.getElementById('sb_gender');
  const tSel = document.getElementById('sb_team');
  function fillTeams() {
    const list = allTeams.filter(t => t.gender === gSel.value && !t.deleted_at);
    tSel.innerHTML = list.map(t => '<option value="' + t.id + '">' + escapeHtml(t.name) + '</option>').join('');
  }
  gSel.addEventListener('change', () => { fillTeams(); applySandbox(gSel.value, tSel.value); });
  tSel.addEventListener('change', () => { applySandbox(gSel.value, tSel.value); });
  gSel.value = currentUser.gender === 'women' ? 'women' : 'men';
  fillTeams();
  applySandbox(gSel.value, tSel.value);
}

// ========== 初始化 ==========
async function init() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const user = await res.json();
      // 安全机制：关闭标签页即失效
      // 如果是新打开的标签页（sessionStorage无标记），即使有cookie也强制登出
      if (!sessionStorage.getItem('session_active')) {
        await fetch('/api/auth/logout', { method: 'POST' });
        isGuest = true;
        currentUser = { id: 0, username: 'guest', displayName: '游客', role: 'guest' };
      } else {
        currentUser = user;
      }
    } else {
      // 未登录 → 游客模式
      isGuest = true;
      currentUser = { id: 0, username: 'guest', displayName: '游客', role: 'guest' };
    }
  } catch {
    isGuest = true;
    currentUser = { id: 0, username: 'guest', displayName: '游客', role: 'guest' };
  }

  if (isGuest) {
    setupGuestUI();
  } else {
    document.getElementById('userName').textContent = currentUser.displayName || currentUser.username;
    document.getElementById('userAvatar').textContent = (currentUser.displayName || currentUser.username).charAt(0);
    const roleBadge = document.getElementById('userRole');
    if (currentUser.role === 'admin') {
      roleBadge.textContent = '管理员';
      roleBadge.style.background = 'var(--primary-lighter)';
      roleBadge.style.color = 'var(--primary)';
      document.getElementById('navTeams').style.display = '';
      document.getElementById('navPlayers').style.display = '';
      document.getElementById('navReferees').style.display = '';
      { const _navCi = document.getElementById('navCheckin'); if (_navCi) _navCi.style.display = ''; }
      document.getElementById('navSettings').style.display = '';
      document.getElementById('navLogs').style.display = '';
      { const _navAnn = document.getElementById('navAnnouncements'); if (_navAnn) _navAnn.style.display = ''; }
      const navRec = document.getElementById('navRecycle'); if (navRec) navRec.style.display = '';
      document.getElementById('navDraw').style.display = '';
      document.getElementById('btnAddSuspension').style.display = '';
      { const _btnExh = document.getElementById('btnAddExhibition'); if (_btnExh) _btnExh.style.display = ''; }
      document.getElementById('resetPwdCard').style.display = '';
      document.getElementById('resetDataCard').style.display = '';
      document.getElementById('addAdminCard').style.display = '';
      document.getElementById('sendNoticeCard').style.display = '';
      document.getElementById('accountMgmtCard').style.display = '';
      document.getElementById('backupCard').style.display = '';
      const _maintCard = document.getElementById('maintenanceCard');
      if (_maintCard) _maintCard.style.display = '';
      const _selfCard = document.getElementById('selfCheckCard');
      if (_selfCard) _selfCard.style.display = '';
      loadMaintenancePanel();

      loadNoticeUsers();
      loadAccountStatus();
      loadBackups();
    } else if (currentUser.role === 'referee') {
      setupRefereeUI(roleBadge);
    } else {
      roleBadge.textContent = '访客';
      roleBadge.style.background = '#F0F4F2';
      roleBadge.style.color = '#888';
      document.getElementById('navPlayers').style.display = '';
      document.getElementById('navSettings').style.display = ''; // 球队端仅用于修改密码
      { const _navRA = document.getElementById('navRefereeApp'); if (_navRA) _navRA.style.display = ''; }

    }
  }

  // 组别切换器初始状态；球队访客锁定在本队组别，裁判/管理员/游客可自由切换
  document.querySelectorAll('#genderSwitch .gs-btn').forEach(b => b.classList.toggle('active', b.dataset.gender === currentGender));
  if (!isGuest && currentUser.role === 'viewer' && currentUser.gender) {
    currentGender = currentUser.gender;
    try { localStorage.setItem('gic_gender', currentGender); } catch (e) {}
    document.querySelectorAll('#genderSwitch .gs-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.gender === currentGender);
      if (b.dataset.gender !== currentGender) { b.disabled = true; b.title = '球队账号仅可查看本组别'; }
    });
  }

  // 首次登录强制修改密码（同时校验标记归属当前账号，防止换号后残留误弹）
  if (!isGuest && sessionStorage.getItem('mustChangePassword') === '1' &&
      (!sessionStorage.getItem('loginUser') || sessionStorage.getItem('loginUser') === currentUser.username)) {
    showForceChangePasswordModal();
  }

  // Socket连接（身份由服务端从会话解析，客户端不再自报，防止伪造）
  socket = io();
  socket.on('onlineCount', n => {
    const el = document.getElementById('onlineCount');
    if (el) el.textContent = n;
  });
  socket.on('userOnline', d => {
    if (currentUser.role === 'admin') {
      addNotification(`${d.username} 登录了系统`);
    }
  });
  // 数据变更广播：防抖合并后"清缓存→重载→重渲染"（弹窗打开时延后到关闭），无需手动刷新
  socket.on('dataUpdate', scheduleLiveUpdate);
  socket.on('unreadCount', d => {
    if (!isGuest && d.userId === currentUser.id) updateUnreadBadge(d.count);
  });
  // 心跳：每60秒上报活跃一次，用于"谁在线"列表的最后活跃时间与超时清理
  setInterval(() => { try { socket.emit('hb'); } catch (e) {} }, 60000);

  // ===== 在线用户列表（管理员） =====
  async function toggleOnlineUsers(ev) {
    ev && ev.stopPropagation();
    if (currentUser.role !== 'admin') return;
    const panel = document.getElementById('onlinePanel');
    if (!panel) return;
    if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
    try {
      const res = await fetch('/api/admin/online-users');
      if (!res.ok) { alert('加载在线列表失败'); return; }
      const data = await res.json();
      const roleMap = { admin: ['管理员', '#0e3b2e'], viewer: ['球队', '#1565c0'], referee: ['裁判', '#e65100'] };
      const now = Date.now();
      const rows = data.users.map(u => {
        const r = roleMap[u.role] || [u.role, '#666'];
        const mins = Math.max(0, Math.floor((now - u.last_seen) / 60000));
        const time = mins < 1 ? '刚刚活跃' : mins < 60 ? mins + ' 分钟前活跃' : Math.floor(mins / 60) + ' 小时前活跃';
        const team = u.team_name ? `<span>${escapeHtml(u.team_name)}</span>` : '<span style="color:#ccc">—</span>';
        const designer = u.is_designer ? ' <span style="font-size:11px;color:#b8860b;border:1px solid #e6d29a;border-radius:4px;padding:0 4px;background:#fffbea">设计者</span>' : '';
        return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 8px 2px;border-bottom:1px solid #f0f2f5">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            <span style="width:8px;height:8px;border-radius:50%;background:#2e7d32;flex:none"></span>
            <span style="font-weight:600;font-size:13px;color:#222">${escapeHtml(u.name)}${designer}</span>
          </div>
          <span style="background:${r[1]};color:#fff;border-radius:4px;padding:1px 6px;font-size:11px">${r[0]}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:#999;padding:2px 8px 7px 24px">${team}<span>${time}</span></div>`;
      }).join('');
      panel.innerHTML = `<div style="font-weight:700;font-size:13px;padding:4px 6px 8px;border-bottom:1px solid #eef0f3;margin-bottom:4px">当前在线（${data.count}）</div>${rows || '<div style="color:#999;font-size:12px;padding:10px 6px">暂无在线用户</div>'}`;
      panel.style.display = 'block';
    } catch (e) { alert('加载在线列表失败'); }
  }
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('onlinePanel');
    const badge = document.getElementById('onlineBadge');
    if (panel && panel.style.display === 'block' && badge && !badge.contains(e.target) && panel !== e.target && !panel.contains(e.target)) panel.style.display = 'none';
  });
  // 仅管理员显示"查看谁在线"入口
  if (currentUser.role === 'admin') {
    const more = document.getElementById('onlineMore');
    if (more) { more.style.display = 'inline'; more.onclick = toggleOnlineUsers; }
  }

  // 获取未读消息数（游客跳过）
  if (!isGuest) loadUnreadCount();
  if (!isGuest && currentUser.role !== 'admin') checkMaintenanceOnBoot();

  // 导航
  function switchPage(page) {
    // 现场检录为独立页面（扫码签到），直接跳转
    if (page === 'checkin') { window.location.href = '/checkin.html'; return; }
    // 角色护栏：目标菜单对当前角色隐藏时，回退首页，避免越权调用接口
    const _guard = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (_guard && _guard.style.display === 'none') page = 'home';
    document.querySelectorAll('.nav-item, .mobile-nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll(`.nav-item[data-page="${page}"], .mobile-nav-item[data-page="${page}"]`).forEach(i => i.classList.add('active'));
    document.querySelectorAll('.page').forEach(p => { p.classList.remove('active'); p.style.opacity = '0'; });
    const pageEl = document.getElementById('page-' + page);
    if (pageEl) {
      pageEl.classList.add('active');
      // 淡入效果，减少切换卡顿感
      requestAnimationFrame(() => { pageEl.style.transition = 'opacity 0.15s ease'; pageEl.style.opacity = '1'; });
    }
    const navItem = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (navItem) document.getElementById('pageTitle').textContent = navItem.querySelector('span:last-child').textContent;
    loadPage(page);
    initMultiFilePickers();
    window.scrollTo(0, 0);
  }
  // 暴露为全局函数，供 HTML inline onclick（如游客端裁判申请横幅按钮）调用
  window.switchPage = switchPage;
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => switchPage(item.dataset.page));
  });
  document.querySelectorAll('.mobile-nav-item').forEach(item => {
    item.addEventListener('click', () => switchPage(item.dataset.page));
  });

  // 通知铃铛（游客隐藏）
  const notifBell = document.getElementById('notifBell');
  if (notifBell) {
    notifBell.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('notifDropdown').classList.toggle('show');
    });
  }
  document.addEventListener('click', () => {
    const dd = document.getElementById('notifDropdown');
    if (dd) dd.classList.remove('show');
  });

  // 构建移动端导航（角色显隐已在上方设置完成）
  setupMobileNav();

  // 加载初始数据
  await loadAllData();
  if (currentUser.isTest) buildSandboxBar();
  if (currentUser.role === 'referee') {
    // 裁判默认进入“我的执法”
    document.querySelector('.nav-item[data-page="home"]').classList.remove('active');
    document.querySelector('.nav-item[data-page="my-matches"]').classList.add('active');
    document.getElementById('page-home').classList.remove('active');
    document.getElementById('page-my-matches').classList.add('active');
    document.getElementById('pageTitle').textContent = '我的执法';
    loadPage('my-matches');
  } else {
    loadPage('home');
  }
  // URL 直达：?page=xxx（引导页“裁判员申请”等入口直达对应页面，switchPage 自带角色护栏）
  try {
    const _qp = new URLSearchParams(window.location.search).get('page');
    if (_qp) switchPage(_qp);
  } catch (e) {}

  // 加载访客列表（设置页）
  if (currentUser.role === 'admin') loadUsersForReset();

}

// ========== 游客模式UI设置 ==========
function setupGuestUI() {
  // 隐藏不需要的菜单项
  const hiddenNavs = ['draw', 'referees', 'messages', 'settings', 'logs'];
  hiddenNavs.forEach(p => {
    const el = document.getElementById('nav' + p.charAt(0).toUpperCase() + p.slice(1));
    if (el) el.style.display = 'none';
    // 部分菜单项没有id，通过data-page选择
    const byPage = document.querySelector(`.nav-item[data-page="${p}"]`);
    if (byPage) byPage.style.display = 'none';
  });
  // 显示"参赛球队"和"球员名单"（游客只读）
  document.getElementById('navTeams').style.display = '';
  document.getElementById('navPlayers').style.display = '';
  // 裁判员申请入口（游客免登录可申请）
  { const _navRA = document.getElementById('navRefereeApp'); if (_navRA) _navRA.style.display = ''; }
  // 首页主区域展示裁判员申请横幅（游客可见，其他角色隐藏）
  { const _banner = document.getElementById('guestRefereeBanner'); if (_banner) _banner.style.display = ''; }
  // 菜单改名
  document.querySelector('#navTeams span:last-child').textContent = '参赛球队';
  document.querySelector('#navPlayers span:last-child').textContent = '球员名单';
  document.querySelector('.nav-item[data-page="suspensions"] span:last-child').textContent = '红黄牌停赛';
  // 页面标题改名
  document.querySelector('#page-teams .card-title').textContent = '参赛球队';
  document.querySelector('#page-players .card-title').textContent = '球员名单';
  document.querySelector('#page-suspensions .card-title').textContent = '红黄牌停赛';

  // 顶栏：隐藏在线人数、消息铃铛、用户信息、退出按钮
  const onlineBadge = document.querySelector('.online-badge');
  if (onlineBadge) onlineBadge.style.display = 'none';
  const notifBell = document.getElementById('notifBell');
  if (notifBell) notifBell.parentElement.style.display = 'none';
  const userInfo = document.querySelector('.user-info');
  if (userInfo) userInfo.style.display = 'none';
  const logoutBtn = document.querySelector('.btn-logout');
  if (logoutBtn) logoutBtn.style.display = 'none';

  // 顶栏右侧添加“裁判员入口 / 管理员/球队入口”按钮
  const topbarRight = document.querySelector('.topbar-right');
  if (topbarRight) {
    const entryWrap = document.createElement('div');
    entryWrap.style.display = 'flex';
    entryWrap.style.alignItems = 'center';
    entryWrap.style.gap = '10px';
    entryWrap.style.flexShrink = '0';

    const refLink = document.createElement('a');
    refLink.href = '/login.html?role=referee';
    refLink.className = 'btn btn-outline btn-sm';
    refLink.textContent = '裁判员入口';
    refLink.style.textDecoration = 'none';
    refLink.style.whiteSpace = 'nowrap';
    refLink.style.flexShrink = '0';
    refLink.style.borderColor = '#C8A45C';
    refLink.style.color = '#8a6d1f';

    const loginLink = document.createElement('a');
    loginLink.href = '/login.html';
    loginLink.className = 'btn btn-outline btn-sm';
    loginLink.textContent = '管理员/球队入口';
    loginLink.style.textDecoration = 'none';
    loginLink.style.whiteSpace = 'nowrap';
    loginLink.style.flexShrink = '0';

    entryWrap.appendChild(refLink);
    entryWrap.appendChild(loginLink);
    topbarRight.insertBefore(entryWrap, topbarRight.firstChild);
  }

  // 隐藏首页上传照片按钮
  const photoUploadBtn = document.getElementById('photoUploadBtn');
  if (photoUploadBtn) photoUploadBtn.style.display = 'none';

  // 隐藏各页面的导出/打印/编辑按钮（no-print 类的操作按钮）
  document.querySelectorAll('#page-schedule .no-print, #page-standings .no-print, #page-scorers .no-print').forEach(el => {
    if (el.tagName === 'BUTTON' || el.tagName === 'A') el.style.display = 'none';
  });
  // 隐藏球员管理的操作按钮
  const playerHeaderBtns = document.querySelector('#page-players .card-header > div:last-child');
  if (playerHeaderBtns) playerHeaderBtns.style.display = 'none';
  // 隐藏球员审批标签
  const playerTabs = document.getElementById('playerTabs');
  if (playerTabs) playerTabs.style.display = 'none';
  // 隐藏停赛手动添加按钮
  const btnAddSusp = document.getElementById('btnAddSuspension');
  if (btnAddSusp) btnAddSusp.style.display = 'none';

  // 移动端底部导航：只保留首页、赛程、积分、射手
  document.querySelectorAll('.mobile-nav-item').forEach(item => {
    const page = item.dataset.page;
    if (!['home', 'schedule', 'standings', 'scorers', 'honors'].includes(page)) {
      item.style.display = 'none';
    }
  });
}

async function loadAllData() {
  const [teams, matches, players, referees, suspensions, exhibitions] = await Promise.all([

    fetch('/api/teams' + (isDesigner() && showHiddenTest ? '?include_hidden=1' : '')).then(r => r.json()),
    fetch('/api/matches').then(r => r.json()),
    fetch('/api/players' + (isDesigner() && showHiddenTest ? '?include_hidden=1' : '')).then(r => r.json()),
    fetch('/api/referees').then(r => r.json()),
    fetch('/api/suspensions').then(r => r.json()).catch(() => []),
    fetch('/api/exhibition').then(r => r.json()).catch(() => []),
  ]);
  allTeams = teams;
  allMatches = matches;
  allPlayers = players;
  allReferees = referees;
  allExhibitions = exhibitions || [];
  suspendedIds = new Set((suspensions || []).map(s => +s.player_id));
}

// ========== 裁判员UI设置 ==========
function setupRefereeUI(roleBadge) {
  roleBadge.textContent = '裁判员';
  roleBadge.style.background = '#F3E9D2';
  roleBadge.style.color = '#8a6d1f';
  // 显示裁判专属与只读菜单（裁判已是裁判，不再显示"裁判申请"入口）
  document.getElementById('navMyMatches').style.display = '';
  document.getElementById('navMyRatings').style.display = '';
  document.getElementById('navSettings').style.display = ''; // 仅用于修改密码
  // 抽签/球队/球员/裁判管理/日志对裁判隐藏（默认即隐藏，此处兜底）
  ['navDraw', 'navTeams', 'navPlayers', 'navReferees', 'navLogs'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  // 停赛页只读：隐藏手动添加
  const btnAdd = document.getElementById('btnAddSuspension');
  if (btnAdd) btnAdd.style.display = 'none';
  // 隐藏各只读页的打印/导出/编辑按钮
  document.querySelectorAll('#page-schedule .no-print, #page-standings .no-print, #page-scorers .no-print').forEach(el => {
    if (el.tagName === 'BUTTON' || el.tagName === 'A') el.style.display = 'none';
  });
  // 移动端底部导航
  document.querySelectorAll('.mobile-nav-item').forEach(item => {
    if (!['home', 'my-matches', 'my-ratings', 'schedule', 'standings', 'scorers', 'honors', 'messages'].includes(item.dataset.page)) {
      item.style.display = 'none';
    }
  });
  // 设置页只保留修改密码卡片（其余管理卡片仅管理员显示）
  ['accountMgmtCard','resetPwdCard','addAdminCard','sendNoticeCard','backupCard','resetDataCard','maintenanceCard','selfCheckCard'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function isReferee() { return currentUser && currentUser.role === 'referee'; }

// 全局页面跳转（模拟点击侧边栏）
function switchToPage(page) {
  const nav = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (nav) nav.click();
}

function refreshCurrentPage() {
  const active = document.querySelector('.nav-item.active');
  if (active) loadPage(active.dataset.page);
}

// ========== 移动端导航：底部快捷栏 + 全部分类抽屉 ==========
function setupMobileNav() {
  const role = currentUser ? currentUser.role : 'guest';
  const quickBar = document.getElementById('mobileQuickBar');
  if (!quickBar) return;
  const quickDefs = {
    admin:   [['home','⚽','首页'],['schedule','📋','赛程'],['bracket','🗂️','对阵'],['messages','💬','消息']],
    viewer:  [['home','⚽','首页'],['schedule','📋','赛程'],['standings','📊','积分'],['messages','💬','消息']],
    referee: [['my-matches','🎽','执法'],['my-ratings','⭐','评分'],['schedule','📋','赛程'],['messages','💬','消息']],
    guest:   [['home','⚽','首页'],['schedule','📋','赛程'],['standings','📊','积分'],['referee-app','🧑‍⚖️','裁判申请']],
  };
  const defs = quickDefs[role] || quickDefs.guest;
  quickBar.innerHTML = defs.map(([pg, icon, label]) =>
    '<div class="mobile-nav-item" data-page="' + pg + '"><span class="icon">' + icon + '</span><span>' + label + '</span>' +
    (pg === 'messages' ? '<span class="mn-badge" id="mnMsgBadge" style="display:none">0</span>' : '') + '</div>'
  ).join('') + '<div class="mobile-nav-item" id="mobileMenuBtn"><span class="icon">☰</span><span>菜单</span></div>';
  quickBar.querySelectorAll('.mobile-nav-item[data-page]').forEach(item => {
    item.addEventListener('click', () => switchToPage(item.dataset.page));
  });
  const menuBtn = document.getElementById('mobileMenuBtn');
  if (menuBtn) menuBtn.addEventListener('click', openMobileMenu);

  // 抽屉头部
  const dispName = isGuest ? '游客浏览' : (currentUser.displayName || currentUser.username);
  document.getElementById('mmName').textContent = dispName;
  document.getElementById('mmRole').textContent = ({ admin: '管理员', viewer: '球队端', referee: '裁判员', guest: '游客' })[role] || '';
  document.getElementById('mmAvatar').textContent = isGuest ? '客' : String(dispName).charAt(0);

  // 组别切换：球队账号锁定本组别，其余角色可切换
  const mmGender = document.getElementById('mmGender');
  if (!isGuest && role === 'viewer' && currentUser.gender) {
    mmGender.innerHTML = '<div style="flex:1;text-align:center;font-size:12px;color:var(--text-light);padding:8px 0;line-height:1.6">当前组别：' +
      (currentUser.gender === 'women' ? '女子组' : '男子组') + '<br>球队账号仅可查看本组别</div>';
  } else {
    mmGender.innerHTML = [['men','男子组'],['women','女子组'],['all','全部']].map(([g, label]) =>
      '<button class="gs-btn' + (g === currentGender ? ' active' : '') + '" data-gender="' + g + '" type="button">' + label + '</button>').join('');
    mmGender.querySelectorAll('.gs-btn').forEach(b => b.addEventListener('click', () => setGender(b.dataset.gender)));
  }

  // 全量菜单：镜像桌面侧边栏当前可见项（角色显隐逻辑天然复用）
  const mmList = document.getElementById('mmList');
  mmList.innerHTML = '';
  document.querySelectorAll('.sidebar-nav .nav-item').forEach(nav => {
    if (nav.style.display === 'none') return;
    const pg = nav.dataset.page;
    const icon = (nav.querySelector('.icon') || {}).textContent || '•';
    const label = (nav.querySelector('span:last-child') || {}).textContent || pg;
    const item = document.createElement('div');
    item.className = 'mm-item' + (pg === 'checkin' ? ' mm-special' : '');
    item.dataset.page = pg;
    item.innerHTML = '<span class="icon">' + icon + '</span><span>' + label + '</span>';
    item.addEventListener('click', () => { closeMobileMenu(); switchToPage(pg); });
    mmList.appendChild(item);
  });

  // 游客：抽屉内提供登录入口；登录用户：退出登录
  const mmExtra = document.getElementById('mmExtra');
  if (isGuest) {
    mmExtra.innerHTML =
      '<a class="btn btn-outline" style="width:100%;margin-bottom:8px;text-decoration:none;text-align:center" href="/login.html?role=referee">裁判员入口</a>' +
      '<a class="btn btn-outline" style="width:100%;text-decoration:none;text-align:center" href="/login.html">管理员 / 球队登录</a>';
  } else {
    mmExtra.innerHTML = '';
  }
  document.getElementById('mmFooter').innerHTML = isGuest ? '' :
    '<button class="btn btn-outline" type="button" onclick="doLogout()">退出登录</button>';
}
function openMobileMenu() {
  const cur = document.querySelector('.nav-item.active');
  document.querySelectorAll('#mmList .mm-item').forEach(it => it.classList.toggle('active', !!cur && it.dataset.page === cur.dataset.page));
  document.querySelectorAll('#mmGender .gs-btn').forEach(b => b.classList.toggle('active', b.dataset.gender === currentGender));
  const ov = document.getElementById('mobileMenuOverlay');
  if (ov) { ov.classList.add('show'); document.body.style.overflow = 'hidden'; }
}
function closeMobileMenu() {
  const ov = document.getElementById('mobileMenuOverlay');
  if (ov) ov.classList.remove('show');
  document.body.style.overflow = '';
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMobileMenu(); });

async function loadPage(page) {
  switch(page) {
    case 'home': loadHome(); break;
    case 'my-matches': loadMyMatches(); break;
    case 'my-ratings': loadMyRatings(); break;
    case 'schedule': loadSchedule(); break;
    case 'draw': loadDraw(); break;
    case 'bracket': loadBracket(); break;
    case 'standings': loadStandings(); break;
    case 'scorers': loadScorers(); break;
    case 'mvp': loadMvpBoard(); break;
    case 'honors': loadHonors(); break;
    case 'teams': loadTeams(); break;
    case 'players': loadPlayers(); break;
    case 'referees': loadReferees(); if (isAdmin()) loadRatingSummary(); break;
    case 'referee-app': loadRefereeApp(); break;
    case 'suspensions': loadSuspensions(); break;

    case 'settings':
      { const sub = document.getElementById('settingsSubtitle');
        if (sub) sub.textContent = isAdmin() ? '管理账号安全、密码、通知发布与数据库备份' : '管理账号安全与登录密码'; }
      if (isAdmin()) { loadAccountStatus(); loadBackups(); loadFreezePanel(); }
      break;
    case 'logs': loadOperationLogs(); break;
    case 'recycle': loadRecycleBin(); break;
    case 'messages': loadMessages();
      if (currentUser.role === 'admin') {
        document.getElementById('sentMessagesCard').style.display = 'block';
        document.getElementById('visitorInboxCard').style.display = 'block';
        document.getElementById('visitorSendBtn').style.display = 'none';
        loadSentMessages();
        loadVisitorInbox();
      } else {
        document.getElementById('sentMessagesCard').style.display = 'none';
        document.getElementById('visitorInboxCard').style.display = 'none';
        document.getElementById('visitorSendBtn').style.display = 'inline-block';
      }
      break;
    case 'announcements':
      if (currentUser.role !== 'admin') { loadHome(); break; }
      loadAnnouncementAdmin();
      break;
  }
}

// ========== 工具函数 ==========
function teamName(id) {
  const t = allTeams.find(x => x.id === id);
  return t ? t.name : '待定';
}
function teamLogo(id) {
  const t = allTeams.find(x => x.id === id);
  if (t && t.logo_path) return t.logo_path;
  return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#E8F0EC"/><text x="20" y="26" text-anchor="middle" fill="#1A4D3A" font-size="14">队</text></svg>');
}
function statusText(s) {
  return { pending: '未开始', live: '进行中', finished: '已结束' }[s] || s;
}
function statusBadge(s) {
  return `<span class="badge badge-${s}">${statusText(s)}</span>`;
}

function isAdmin() { return currentUser && currentUser.role === 'admin'; }
function isDesigner() { return currentUser && currentUser.username === 'admin'; }
function refreshHiddenToggle() {
  const wrap = document.getElementById('hiddenTestToggle');
  if (wrap) wrap.style.display = isDesigner() ? 'flex' : 'none';
}
function toggleHiddenTest() {
  const cb = document.getElementById('hiddenTestCb');
  showHiddenTest = !!(cb && cb.checked);
  loadAllData().then(() => { loadPlayers(); loadPendingPlayers(); });
}
function isViewer() { return currentUser && currentUser.role === 'viewer'; }

// 文件校验：格式+大小
function validateFile(file, allowedExts, maxSizeMB) {
  const name = file.name.toLowerCase();
  const ext = '.' + name.split('.').pop();
  if (!allowedExts.includes(ext)) {
    return { valid: false, msg: `文件格式不支持，仅允许 ${allowedExts.join('、')}` };
  }
  if (file.size > maxSizeMB * 1024 * 1024) {
    return { valid: false, msg: `文件大小超过限制，最大 ${maxSizeMB}MB（当前 ${(file.size / 1024 / 1024).toFixed(1)}MB）` };
  }
  return { valid: true };
}

// ========== 通用多文件累积选择器 ==========
// 用法（静态 HTML 或动态弹窗均可）：
//   <input type="file" multiple data-mfp="唯一key" data-mfp-list="清单容器id"
//          data-mfp-max="20" data-mfp-exts=".jpg,.png" data-mfp-size="5">
//   <div id="清单容器id" class="mfp-list"></div>
// 取文件：mfpFiles('key')；重置：mfpReset('key')
function fmtFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}
function mfpFiles(key) {
  const input = document.querySelector(`[data-mfp="${key}"]`);
  return input ? (input._mfpFiles || []) : [];
}
function mfpReset(key) {
  const input = document.querySelector(`[data-mfp="${key}"]`);
  if (input) { input._mfpFiles = []; input.value = ''; mfpRender(input); }
}
function mfpRender(input) {
  const list = input.dataset.mfpList ? document.getElementById(input.dataset.mfpList) : null;
  if (!list) return;
  const files = input._mfpFiles || [];
  if (!files.length) { list.innerHTML = '<div class="mfp-empty">未选择文件（可多次点击选择文件追加）</div>'; return; }
  list.innerHTML = files.map((f, i) => `
    <div class="mfp-item">
      <span class="mfp-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      <span class="mfp-size">${fmtFileSize(f.size)}</span>
      <button type="button" class="mfp-remove" title="移除" onclick="mfpRemove('${input.dataset.mfp}',${i})">&times;</button>
    </div>`).join('');
}
window.mfpRemove = function (key, idx) {
  const input = document.querySelector(`[data-mfp="${key}"]`);
  if (!input) return;
  input._mfpFiles.splice(idx, 1);
  mfpRender(input);
};
function initMultiFilePickers(root) {
  (root || document).querySelectorAll('[data-mfp]').forEach(input => {
    if (input._mfpBound) return;
    input._mfpBound = true;
    input._mfpFiles = [];
    input.addEventListener('change', () => {
      const max = parseInt(input.dataset.mfpMax || '99');
      const sizeMB = parseFloat(input.dataset.mfpSize || '0');
      const exts = (input.dataset.mfpExts || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const incoming = Array.from(input.files || []);
      input.value = ''; // 立即清空，允许再次追加（含重复选择同一文件）
      for (const f of incoming) {
        if (input._mfpFiles.length >= max) { alert(`最多选择 ${max} 个文件`); break; }
        const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
        if (exts.length && !exts.includes(ext)) { alert(`文件“${f.name}”格式不支持，仅允许 ${exts.join('、')}`); continue; }
        if (sizeMB && f.size > sizeMB * 1024 * 1024) { alert(`文件“${f.name}”超过 ${sizeMB}MB 限制`); continue; }
        if (input._mfpFiles.some(x => x.name === f.name && x.size === f.size)) { alert(`文件“${f.name}”已在列表中`); continue; }
        input._mfpFiles.push(f);
      }
      mfpRender(input);
    });
    mfpRender(input);
  });
}

// 弹窗堆叠：genericModal 已打开时再次打开（如弹窗内再开弹窗），快照上一层内容，关闭时逐层恢复
const __modalStack = [];
function showModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  if (id === 'genericModal' && el.classList.contains('show')) {
    __modalStack.push({
      title: document.getElementById('genericModalTitle').innerHTML,
      body: document.getElementById('genericModalBody').innerHTML,
      footer: document.getElementById('genericModalFooter').innerHTML
    });
  }
  el.classList.add('show');
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  if (id === 'genericModal' && __modalStack.length) {
    const snap = __modalStack.pop();
    document.getElementById('genericModalTitle').textContent = snap.title;
    document.getElementById('genericModalBody').innerHTML = snap.body;
    document.getElementById('genericModalFooter').innerHTML = snap.footer;
    return; // 恢复上一层，弹窗保持打开
  }
  el.classList.remove('show');
  if (__dataDirtyWhileModal) { __dataDirtyWhileModal = false; scheduleLiveUpdate(); }
}

function confirmDialog(text, onOk, icon = '❓') {
  document.getElementById('confirmText').textContent = text;
  document.getElementById('confirmIcon').textContent = icon;
  const btn = document.getElementById('confirmOk');
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);
  newBtn.addEventListener('click', () => { closeModal('confirmModal'); onOk(); });
  showModal('confirmModal');
}

function addNotification(text) {
  notifications.unshift({ text, time: new Date().toLocaleString('zh-CN') });
  if (notifications.length > 50) notifications.pop();
  renderNotifications();
}
function renderNotifications() {
  const el = document.getElementById('notifDropdown');
  const count = document.getElementById('notifCount');
  count.textContent = notifications.length;
  count.style.display = notifications.length ? '' : 'none';
  el.innerHTML = notifications.length
    ? notifications.map(n => `<div class="notification-item"><div>${escapeHtml(n.text)}</div><div class="time">${escapeHtml(n.time)}</div></div>`).join('')
    : '<div class="notification-item" style="text-align:center;color:#999">暂无通知</div>';
}

async function doLogout() {
  // 清除本标签会话标记，避免下一账号继承强制改密等残留状态
  sessionStorage.removeItem('mustChangePassword');
  sessionStorage.removeItem('loginUser');
  sessionStorage.removeItem('session_active');
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
}

function exportExcel(type) {
  // 按当前所在组别导出（"全部"视图默认导出男子）
  const g = currentGender === 'women' ? 'women' : 'men';
  window.open('/api/export/' + type + '?gender=' + g, '_blank');
}

// D12 赛后多Sheet归档导出
function exportArchive() {
  if (!confirm('将导出包含赛程、名单、射手、纪律、事件、裁判、表演赛的多Sheet归档表，确定？')) return;
  window.open('/api/export/archive/full', '_blank');
}

// D15 全局搜索
function onGlobalSearch() {
  const box = document.getElementById('globalSearchResults');
  const q = document.getElementById('globalSearch').value.trim().toLowerCase();
  if (!q) { box.style.display = 'none'; return; }
  const res = [];
  const norm = s => (s == null ? '' : String(s).toLowerCase());
  // 球队
  genderTeams().filter(t => norm(t.name).includes(q)).slice(0, 6).forEach(t =>
    res.push({ icon: '🛡️', title: escapeHtml(t.name), sub: (t.gender==='women'?'女子组':'男子组')+' · 球队', act: `globalSearchJump('teams',${t.id})` }));
  // 球员
  genderPlayers().filter(p => !p.deleted_at && (norm(p.name).includes(q) || norm(p.student_id).includes(q) || norm(p.jersey_number) === q)).slice(0, 8).forEach(p => {
    const tn = allTeams.find(t => t.id === p.team_id)?.name || '';
    res.push({ icon: '👤', title: `${p.jersey_number || ''}号 ${escapeHtml(p.name)}`, sub: `球员 · ${tn}`, act: `globalSearchJump('players',${p.id})` });
  });
  // 比赛（场序或队名，支持输入“场序3”或纯数字3；场序按实际时间动态排序）
  genderMatches().filter(m => {
      const orderNum = timeOrderNum(m);
      return String(orderNum) === q || norm(`场序${orderNum}`).includes(q) ||
        norm(displayMatchNum(m)).toString() === q || norm(m.match_number) === q || norm(m.match_number).includes(q) ||
        norm(`场序${displayMatchNum(m)}`).includes(q) ||
        norm(m.team1?.name).includes(q) || norm(m.team2?.name).includes(q);
    }).slice(0, 8).forEach(m => {
      const t1 = m.team1?.name || m.team1_source || '待定', t2 = m.team2?.name || m.team2_source || '待定';
      res.push({ icon: '⚽', title: `场序${timeOrderNum(m)} ${t1} vs ${t2}`, sub: m.gender==='women'?'女子组比赛':'比赛', act: `openMatch(${m.id})` });
    });
  // 裁判（仅管理员）
  if (isAdmin()) allReferees.filter(r => !r.deleted_at && (norm(r.name).includes(q) || norm(r.serial_number).includes(q))).slice(0, 6).forEach(r =>
    res.push({ icon: '🧑‍⚖️', title: escapeHtml(r.name), sub: `裁判 · ${r.level || ''}`, act: `globalSearchJump('referees',${r.id})` }));

  if (!res.length) {
    box.innerHTML = `<div style="padding:16px;text-align:center;color:#999;font-size:13px">未找到与“${escapeHtml(document.getElementById('globalSearch').value)}”相关的结果</div>`;
  } else {
    box.innerHTML = res.slice(0, 20).map(r => `<div onmousedown="${r.act};document.getElementById('globalSearchResults').style.display='none';document.getElementById('globalSearch').value=''"
      style="display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;cursor:pointer;font-size:13px" onmouseover="this.style.background='var(--primary-lighter)'" onmouseout="this.style.background=''">
      <span style="font-size:16px">${r.icon}</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.title}</span>
      <span style="font-size:11px;color:var(--text-light)">${r.sub}</span></div>`).join('');
  }
  box.style.display = 'block';
}
function hideGlobalSearch() {
  const box = document.getElementById('globalSearchResults');
  if (box) box.style.display = 'none';
}
// 全局搜索：跳转到对应页面并定位、高亮目标条目（解决“点了只切页、找不到目标”）
function globalSearchJump(page, id) {
  hideGlobalSearch();
  const sInput = document.getElementById('globalSearch'); if (sInput) sInput.value = '';
  switchToPage(page);
  const findTarget = () => {
    if (page === 'teams') return document.getElementById('tname_' + id)?.closest('.team-edit-card');
    if (page === 'players') {
      const btn = document.querySelector(`#page-players [onclick="showPlayerModal(${id})"]`);
      return btn ? btn.closest('tr') || btn.closest('[class*=card]') : null;
    }
    if (page === 'referees') {
      const btn = document.querySelector(`#page-referees [onclick="openRefProfile(${id})"]`);
      return btn ? btn.closest('tr') || btn.closest('[class*=card]') : null;
    }
    return null;
  };
  let tries = 0;
  let highlighted = null;
  const MAX_TRIES = 30; // 约2.4s内持续重定位，避免实时刷新重渲染把高亮覆盖
  const timer = setInterval(() => {
    tries++;
    const el = findTarget();
    if (el) {
      if (el !== highlighted) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.transition = 'background .3s';
        el.style.background = 'var(--primary-lighter, #E8F0EC)';
        el.style.outline = '2px solid var(--primary)';
        highlighted = el;
      }
    }
    if (tries >= MAX_TRIES) {
      clearInterval(timer);
      if (highlighted) setTimeout(() => { highlighted.style.background = ''; highlighted.style.outline = ''; }, 1800);
    }
  }, 80);
}

// ========== 首页 ==========
async function loadHome() {
  loadHomeAnnouncements();
  startCountdown();
  const gMatches = genderMatches();
  const gTeams = genderTeams();
  const finished = gMatches.filter(m => m.status === 'finished');
  const live = gMatches.filter(m => m.status === 'live');
  const pending = gMatches.filter(m => m.status !== 'finished' && m.status !== 'live');
  const totalGoals = finished.reduce((s, m) => s + (m.team1_score || 0) + (m.team2_score || 0), 0);
  const fmtLabel = currentGender === 'women' ? '小组循环+排位' : (currentGender === 'all' ? '男分组淘汰 · 女小组循环' : '分组双循环+淘汰');

  document.getElementById('homeStats').innerHTML = `
    <div class="stat-card" style="--stat-accent:#1A4D3A"><div class="label">⚽ 总比赛</div><div class="value">${gMatches.length}</div><div class="sub">已赛 ${finished.length} 场</div></div>
    <div class="stat-card" style="--stat-accent:#1565C0"><div class="label">👥 参赛球队</div><div class="value">${gTeams.length}</div><div class="sub">${fmtLabel}</div></div>
    <div class="stat-card" style="--stat-accent:#E65100"><div class="label">🥅 总进球</div><div class="value">${totalGoals}</div><div class="sub">常规时间进球</div></div>
    <div class="stat-card" style="--stat-accent:#6A1B9A"><div class="label">🧑‍⚖️ 裁判人数</div><div class="value">${allReferees.length}</div><div class="sub">男女组共用裁判池</div></div>
  `;

  // B6 待办聚合（登录用户）
  loadHomeTodos();

  // 图表1：球队进球统计
  renderGoalsChart(finished);

  // 图表2：比赛进度
  renderProgressChart(finished.length, live.length, pending.length);

  // 图表3：射手榜TOP5
  await renderScorersChart();

  // 图表4：球队胜负统计
  renderWinsChart(finished);

  // 图表5：冠军概率预测
  renderTitleProbability();

  const recent = finished.slice(-3).reverse();
  document.getElementById('recentMatches').innerHTML = recent.length
    ? recent.map(m => matchCardHtml(m)).join('')
    : '<div class="empty-state"><div class="icon">⚽</div>暂无已结束比赛</div>';

  const upcoming = gMatches.filter(m => m.status !== 'finished' && m.team1_id && m.team2_id).slice(0, 5);
  document.getElementById('upcomingMatches').innerHTML = upcoming.length
    ? upcoming.map(m => matchCardHtml(m)).join('')
    : '<div class="empty-state"><div class="icon">📅</div>暂无待赛比赛</div>';

  // 加载精彩镜头
  loadMatchPhotos();
}

// ========== 开赛倒计时（全端首页显示，精确到秒） ==========
// 开赛时间：2026-10-07 14:35（北京时间）
const OPENING_TIME = Date.parse('2026-10-07T14:35:00+08:00');
function _cdPad(n) { return String(n).padStart(2, '0'); }
function renderCountdown() {
  const el = document.getElementById('homeCountdown');
  if (!el) return;
  const diff = OPENING_TIME - Date.now();
  if (diff <= 0) {
    el.innerHTML = `
      <div class="countdown-banner opened">
        <div class="cd-label">2026 沈阳城市学院“绿岛杯”足球赛</div>
        <div class="cd-opened">⚽ 赛事进行中</div>
      </div>`;
    if (window.__cdTimer) { clearInterval(window.__cdTimer); window.__cdTimer = null; }
    return;
  }
  let s = Math.floor(diff / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  el.innerHTML = `
    <div class="countdown-banner">
      <div class="cd-label">距 2026 沈阳城市学院“绿岛杯”足球赛开赛</div>
      <div class="cd-items">
        <div class="cd-item"><span class="cd-num">${d}</span><em>天</em></div>
        <div class="cd-sep">:</div>
        <div class="cd-item"><span class="cd-num">${_cdPad(h)}</span><em>时</em></div>
        <div class="cd-sep">:</div>
        <div class="cd-item"><span class="cd-num">${_cdPad(m)}</span><em>分</em></div>
        <div class="cd-sep">:</div>
        <div class="cd-item"><span class="cd-num">${_cdPad(s)}</span><em>秒</em></div>
      </div>
    </div>`;
}
function startCountdown() {
  renderCountdown();
  if (!window.__cdTimer) window.__cdTimer = setInterval(renderCountdown, 1000);
}

// ========== 全站公告（首页横幅） ==========
// 服务端时间已统一为北京时间字符串，前端直接格式化显示（不再做时区偏移）
function fmtAnnTime(t) {
  if (!t) return '';
  return String(t).replace('T', ' ').slice(0, 16);
}
// 通用时间格式化（北京时间 YYYY-MM-DD HH:mm:ss → YYYY-MM-DD HH:mm）
function fmtTime(t) {
  if (!t) return '';
  return String(t).replace('T', ' ').slice(0, 16);
}
async function loadHomeAnnouncements() {
  const box = document.getElementById('homeAnnouncements');
  if (!box) return;
  let list = [];
  try { list = await fetch('/api/announcements').then(r => r.json()); } catch (e) { box.innerHTML = ''; return; }
  if (!Array.isArray(list) || !list.length) { box.innerHTML = ''; return; }
  const uid = (currentUser && currentUser.id) || 'guest';
  const lvlMap = {
    urgent: ['紧急公告', 'ann-urgent', '❗'],
    important: ['重要公告', 'ann-important', '★'],
    info: ['赛事公告', 'ann-info', '📢']
  };
  const banners = list.map(a => {
    if (a.level !== 'urgent') {
      try { if (localStorage.getItem('ann_dismiss_' + uid + '_' + a.id) === '1') return ''; } catch (e) {}
    }
    const [tag, cls, ico] = lvlMap[a.level] || lvlMap.info;
    let atts = [];
    try { atts = JSON.parse(a.attachments || '[]'); } catch (e) {}
    const attHtml = atts.length ? `<div class="ann-att">${atts.map(f => `<a href="${f.path}" target="_blank" rel="noopener">📎 ${escapeHtml(f.filename)}</a>`).join('')}</div>` : '';
    const close = a.level === 'urgent' ? '' :
      `<button class="ann-close" title="收起（本设备不再提示）" onclick="dismissAnnouncement(${a.id},event)">×</button>`;
    return `<div class="ann-banner ${cls}">
      <div class="ann-left">
        <span class="ann-ico">${ico}</span>
        <div class="ann-body">
          <div class="ann-head"><span class="ann-tag">${tag}</span><span class="ann-title">${escapeHtml(a.title)}</span><span class="ann-time">${fmtAnnTime(a.created_at)}</span></div>
          ${a.content ? `<div class="ann-content">${escapeHtml(a.content).replace(/\n/g, '<br>')}</div>` : ''}
          ${attHtml}
        </div>
      </div>
      ${close}
    </div>`;
  }).join('');
  // 常驻入口：即使横幅全部被收起，仍可在此查看全部在架公告（含已收起、紧急公告）
  const entry = list.length ? `<div class="ann-history-entry"><button class="ann-history-btn" onclick="openAnnHistory()">📢 查看全部公告（${list.length}）</button></div>` : '';
  box.innerHTML = banners + entry;
  window.__annCache = list;
}

// 公告历史（全部公告，含本设备已收起的）
window.openAnnHistory = async function () {
  let list = window.__annCache || [];
  try { list = await fetch('/api/announcements?t=' + Date.now()).then(r => r.json()); window.__annCache = list; } catch (e) {}
  const lvlMap = { urgent: ['紧急公告', 'ann-urgent', '❗'], important: ['重要公告', 'ann-important', '★'], info: ['赛事公告', 'ann-info', '📢'] };
  const body = !list.length ? '<div class="empty-state">暂无公告</div>' : list.map(a => {
    const [tag, cls, ico] = lvlMap[a.level] || lvlMap.info;
    let atts = [];
    try { atts = JSON.parse(a.attachments || '[]'); } catch (e) {}
    const attHtml = atts.length ? `<div class="ann-att">${atts.map(f => `<a href="${f.path}" target="_blank" rel="noopener">📎 ${escapeHtml(f.filename)}</a>`).join('')}</div>` : '';
    return `<div class="ann-hist-card ${cls}">
      <div class="ann-head"><span class="ann-tag">${tag}</span><span class="ann-title">${escapeHtml(a.title)}</span><span class="ann-time">${fmtAnnTime(a.created_at)}</span></div>
      ${a.content ? `<div class="ann-content">${escapeHtml(a.content).replace(/\n/g, '<br>')}</div>` : ''}
      ${attHtml}
    </div>`;
  }).join('');
  const titleEl = document.getElementById('genericModalTitle');
  const bodyEl = document.getElementById('genericModalBody');
  const footEl = document.getElementById('genericModalFooter');
  if (titleEl) titleEl.textContent = '赛事公告';
  if (bodyEl) bodyEl.innerHTML = `<div class="ann-hist-wrap">${body}</div>`;
  if (footEl) footEl.innerHTML = '<button class="btn btn-outline" onclick="closeModal(\'genericModal\')">关闭</button>';
  showModal('genericModal');
};
window.dismissAnnouncement = function (id, ev) {
  if (ev) ev.stopPropagation();
  const uid = (currentUser && currentUser.id) || 'guest';
  try { localStorage.setItem('ann_dismiss_' + uid + '_' + id, '1'); } catch (e) {}
  if (ev && ev.target) { const b = ev.target.closest('.ann-banner'); if (b) b.remove(); }
};

// ========== 管理员：全站公告管理 ==========
async function loadAnnouncementAdmin() {
  const box = document.getElementById('annAdminList');
  if (!box) return;
  box.innerHTML = '<div class="empty-state">加载中…</div>';
  let list = [];
  try { list = await fetch('/api/admin/announcements').then(r => r.json()); } catch (e) { box.innerHTML = '<div class="empty-state">加载失败</div>'; return; }
  if (!list.length) { box.innerHTML = '<div class="empty-state"><div class="icon">📣</div>暂无公告，发布后将显示在四端首页顶部</div>'; return; }
  const lvlText = { urgent: '紧急', important: '重要', info: '普通' };
  const scopeText = { all: '全员（含游客）', visitors: '仅球队', referees: '仅裁判' };
  box.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px">` + list.map(a => `
    <div class="ann-admin-row ann-level-${a.level}">
      <div class="ann-admin-main">
        <div class="ann-admin-title">
          <span class="ann-admin-lvl lvl-${a.level}">${lvlText[a.level] || '普通'}</span>
          ${escapeHtml(a.title)}
          ${a.is_active ? '<span class="ann-admin-state on">在架展示中</span>' : '<span class="ann-admin-state off">已下架</span>'}
        </div>
        ${a.content ? `<div class="ann-admin-content">${escapeHtml(a.content).replace(/\n/g, '<br>')}</div>` : ''}
        <div class="ann-admin-meta">范围：${scopeText[a.scope] || a.scope} ｜ 发布人：${escapeHtml(a.created_by_name || '')} ｜ 时间：${fmtAnnTime(a.created_at)}</div>
      </div>
      <div class="ann-admin-ops">
        ${a.is_active
          ? `<button class="btn btn-outline btn-sm" onclick="annToggle(${a.id},'offline')">下架</button>`
          : `<button class="btn btn-outline btn-sm" onclick="annToggle(${a.id},'online')">重新上架</button>`}
        <button class="btn btn-danger btn-sm" onclick="annDelete(${a.id})">删除</button>
      </div>
    </div>`).join('') + `</div>`;
}
async function submitAnnouncement() {
  const title = document.getElementById('annTitle').value.trim();
  const content = document.getElementById('annContent').value;
  const level = document.getElementById('annLevel').value;
  const scope = document.getElementById('annScope').value;
  if (!title) { alert('请填写公告标题'); return; }
  const fd = new FormData();
  fd.append('title', title); fd.append('content', content); fd.append('level', level); fd.append('scope', scope);
  const files = mfpFiles('annFiles');
  for (const f of files) fd.append('attachments', f);
  const btn = document.querySelector('#page-announcements .btn-primary'); if (btn) { btn.disabled = true; btn.textContent = '发布中…'; }
  try {
    const res = await fetch('/api/admin/announcements', { method: 'POST', body: fd });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { alert('发布失败：' + (d.error || '')); return; }
    document.getElementById('annTitle').value = '';
    document.getElementById('annContent').value = '';
    mfpReset('annFiles');
    alert('公告已发布，四端首页将实时显示');
    loadAnnouncementAdmin();
  } catch (e) { alert('网络错误：' + e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '📣 立即发布'; } }
}
window.annToggle = async function (id, act) {
  const res = await fetch(`/api/admin/announcements/${id}/${act}`, { method: 'POST' });
  if (res.ok) loadAnnouncementAdmin(); else alert('操作失败');
};
window.annDelete = async function (id) {
  if (!confirm('确定删除该公告？删除后不可恢复，其附件也会一并删除。')) return;
  const res = await fetch(`/api/admin/announcements/${id}`, { method: 'DELETE' });
  if (res.ok) loadAnnouncementAdmin(); else alert('删除失败');
};

// B6 首页待办聚合
async function loadHomeTodos() {
  const box = document.getElementById('homeTodos');
  if (!box) return;
  // 游客端不展示待办
  if (!currentUser || isGuest || currentUser.role === 'guest') { box.innerHTML = ''; return; }
  let todos = [];

  try { const d = await fetch('/api/home/todos' + (isDesigner() && showHiddenTest ? '?include_hidden=1' : '')).then(r => r.json()); todos = d.todos || []; } catch (e) {}  if (!todos.length) {
    box.innerHTML = `<div class="card" style="padding:14px 18px;display:flex;align-items:center;gap:10px;color:var(--primary);font-size:14px">✅ 当前没有待办事项</div>`;
    return;
  }
  const color = { danger: '#c62828', warning: '#e65100', info: 'var(--primary)' };
  const bg = { danger: '#fdecea', warning: '#fff3e0', info: 'var(--primary-lighter)' };
  box.innerHTML = `<div class="card" style="padding:14px 18px">
    <div style="font-weight:600;margin-bottom:10px">📌 我的待办（${todos.length}）</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${todos.map(t => `<div onclick="switchToPage('${t.page}')" style="cursor:pointer;display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;background:${bg[t.level]||bg.info};color:${color[t.level]||color.info};font-size:13px;font-weight:500">
        <span style="flex:1">${escapeHtml(t.text)}</span><span style="font-size:12px;opacity:.7">前往处理 ›</span></div>`).join('')}
    </div></div>`;
}

async function loadMatchPhotos() {
  try {
    const res = await fetch('/api/matches/photos');
    const photos = await res.json();
    renderMatchPhotos(photos);
  } catch(e) { console.error(e); }
}

function renderMatchPhotos(photos) {
  const container = document.getElementById('matchPhotos');
  const uploadBtn = document.getElementById('photoUploadBtn');
  if (uploadBtn && currentUser && currentUser.role === 'admin') {
    uploadBtn.style.display = 'block';
  }
  if (!photos || photos.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="icon">📷</div>暂无精彩镜头，管理员可上传比赛照片</div>';
    return;
  }
  const isAdmin = currentUser && currentUser.role === 'admin';
  container.innerHTML = photos.map(p => {
    const label = p.photo_type === 'activity'
      ? (escapeHtml(p.activity_name) || '其他活动')
      : `场序${p.gender==='women'?p.match_number-100:p.match_number} ${escapeHtml(p.team1_name) || ''} vs ${escapeHtml(p.team2_name) || ''}`;
    return `
    <div class="photo-card">
      <img src="${p.photo_path}" alt="${escapeHtml(p.caption) || '精彩镜头'}" onclick="previewImage('${p.photo_path}')" class="photo-thumb">
      <div class="photo-info">
        <div class="photo-match">${p.photo_type === 'activity' ? '<span class="photo-tag-act">活动</span> ' : ''}${label}</div>
        ${p.caption ? `<div class="photo-caption">${escapeHtml(p.caption)}</div>` : ''}
        ${isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="deletePhoto(${p.id}, event)">删除</button>` : ''}
      </div>
    </div>
  `;
  }).join('');
}

function openPhotoUpload() {
  const matchOptions = genderMatches().filter(m => m.team1_id && m.team2_id).map(m =>
    `<option value="${m.id}">场序${displayMatchNum(m)} ${escapeHtml(teamName(m.team1_id))} vs ${escapeHtml(teamName(m.team2_id))}</option>`
  ).join('');
  const html = `
    <div class="form-group"><label>图片类型</label>
      <div class="photo-type-switch">
        <label class="radio-pill"><input type="radio" name="photoType" value="match" checked onchange="togglePhotoType()"> 比赛图片</label>
        <label class="radio-pill"><input type="radio" name="photoType" value="activity" onchange="togglePhotoType()"> 其他活动</label>
      </div>
    </div>
    <div class="form-group" id="photoMatchWrap"><label>选择比赛</label>
      <select id="photoMatchId">${matchOptions}</select>
    </div>
    <div class="form-group" id="photoActivityWrap" style="display:none"><label>活动名称（可选）</label>
      <input type="text" id="photoActivityName" placeholder="如：倒计时海报、抽签现场、颁奖仪式等">
    </div>
    <div class="form-group"><label>照片说明（可选）</label>
      <input type="text" id="photoCaption" placeholder="如：进球瞬间、庆祝画面等">
    </div>
    <div class="form-group"><label>选择照片（可多次点击追加，单张≤5MB，仅JPG/PNG）</label>
      <input type="file" id="photoFiles" accept=".jpg,.jpeg,.png" multiple
        data-mfp="photoFiles" data-mfp-list="photoFilesList" data-mfp-max="20"
        data-mfp-exts=".jpg,.jpeg,.png" data-mfp-size="5">
      <div id="photoFilesList" class="mfp-list"></div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:15px">
      <button class="btn btn-ghost" onclick="closeModal('photoUploadModal')">取消</button>
      <button class="btn btn-primary" onclick="uploadPhotos()">上传</button>
    </div>
  `;
  // 创建模态框
  let modal = document.getElementById('photoUploadModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'photoUploadModal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `<div class="modal" style="max-width:500px"><div class="modal-header"><h3>上传精彩镜头</h3><span class="modal-close" onclick="closeModal('photoUploadModal')">&times;</span></div><div class="modal-body" id="photoUploadBody"></div></div>`;
    document.body.appendChild(modal);
  }
  document.getElementById('photoUploadBody').innerHTML = html;
  initMultiFilePickers();
  showModal('photoUploadModal');
}
window.togglePhotoType = function () {
  const typeEl = document.querySelector('input[name="photoType"]:checked');
  const type = typeEl ? typeEl.value : 'match';
  document.getElementById('photoMatchWrap').style.display = type === 'match' ? '' : 'none';
  document.getElementById('photoActivityWrap').style.display = type === 'activity' ? '' : 'none';
};

async function uploadPhotos() {
  const typeEl = document.querySelector('input[name="photoType"]:checked');
  const photoType = typeEl ? typeEl.value : 'match';
  const caption = document.getElementById('photoCaption').value;
  const files = mfpFiles('photoFiles');
  if (!files || files.length === 0) { alert('请选择至少一张照片'); return; }
  let matchId = '', activityName = '';
  if (photoType === 'match') {
    matchId = document.getElementById('photoMatchId').value;
    if (!matchId) { alert('请选择关联比赛'); return; }
  } else {
    activityName = document.getElementById('photoActivityName').value.trim();
  }
  const formData = new FormData();
  formData.append('photo_type', photoType);
  if (matchId) formData.append('match_id', matchId);
  formData.append('activity_name', activityName);
  formData.append('caption', caption);
  for (const f of files) formData.append('photos', f);
  try {
    const res = await fetch('/api/photos', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.ok) {
      closeModal('photoUploadModal');
      loadMatchPhotos();
      alert(`成功上传 ${data.photos.length} 张照片`);
    } else {
      alert(data.error || '上传失败');
    }
  } catch(e) { alert('上传失败：' + e.message); }
}

async function deletePhoto(photoId, event) {
  if (event) event.stopPropagation();
  if (!confirm('确定删除这张照片吗？')) return;
  try {
    const res = await fetch(`/api/matches/photos/${photoId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) loadMatchPhotos();
    else alert(data.error || '删除失败');
  } catch(e) { alert('删除失败'); }
}

function renderGoalsChart(finished) {
  const goals = {};
  genderTeams().forEach(t => goals[t.id] = { name: t.name, gf: 0, ga: 0 });
  finished.forEach(m => {
    if (m.team1_id && m.team2_id && goals[m.team1_id] && goals[m.team2_id]) {
      goals[m.team1_id].gf += m.team1_score || 0;
      goals[m.team1_id].ga += m.team2_score || 0;
      goals[m.team2_id].gf += m.team2_score || 0;
      goals[m.team2_id].ga += m.team1_score || 0;
    }
  });
  const arr = Object.values(goals).sort((a, b) => b.gf - a.gf);
  const max = Math.max(...arr.map(g => g.gf), 1);
  const html = arr.map(g => `
    <div class="bar-row">
      <div class="bar-label">${escapeHtml(g.name)}</div>
      <div class="bar-track">
        <div class="bar-fill bar-goal" style="width:${(g.gf / max * 100).toFixed(1)}%"></div>
      </div>
      <div class="bar-value">${g.gf}</div>
    </div>
  `).join('');
  document.getElementById('chartGoals').innerHTML = html || '<div class="empty-state">暂无数据</div>';
}

function renderProgressChart(finished, live, pending) {
  const total = finished + live + pending;
  const pct = total ? ((finished / total) * 100).toFixed(1) : 0;
  const html = `
    <div class="progress-ring-container">
      <div class="progress-ring">
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="50" fill="none" stroke="#EDF3F0" stroke-width="12"/>
          <circle cx="60" cy="60" r="50" fill="none" stroke="#1A4D3A" stroke-width="12"
            stroke-dasharray="${2 * Math.PI * 50}" stroke-dashoffset="${2 * Math.PI * 50 * (1 - pct / 100)}"
            transform="rotate(-90 60 60)" stroke-linecap="round"/>
        </svg>
        <div class="progress-ring-text">
          <div class="progress-ring-value">${finished}</div>
          <div class="progress-ring-label">已完成</div>
        </div>
      </div>
      <div class="progress-legend">
        <div class="legend-item"><span class="legend-dot" style="background:#1A4D3A"></span>已结束 ${finished} 场</div>
        <div class="legend-item"><span class="legend-dot" style="background:#F57C00"></span>进行中 ${live} 场</div>
        <div class="legend-item"><span class="legend-dot" style="background:#EDF3F0"></span>未开始 ${pending} 场</div>
      </div>
    </div>
  `;
  document.getElementById('chartProgress').innerHTML = html;
}

async function renderScorersChart() {
  const res = await fetch('/api/scorers' + (currentGender === 'women' ? '?gender=women' : ''));
  const scorers = await res.json();
  const arr = scorers.slice(0, 5);
  if (arr.length === 0) {
    document.getElementById('chartScorers').innerHTML = '<div class="empty-state">暂无进球数据</div>';
    return;
  }
  const max = Math.max(...arr.map(s => s.goals), 1);
  const colors = ['#FFD700', '#C0C0C0', '#CD7F32', '#1A4D3A', '#1A4D3A'];
  const html = arr.map((s, i) => `
    <div class="bar-row">
      <div class="bar-label">${escapeHtml(s.name)} <small style="color:#999">(${escapeHtml(s.team_name)})</small></div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${(s.goals / max * 100).toFixed(1)}%;background:${colors[i]}"></div>
      </div>
      <div class="bar-value">${s.goals}</div>
    </div>
  `).join('');
  document.getElementById('chartScorers').innerHTML = html;
}

function renderWinsChart(finished) {
  const stats = {};
  genderTeams().forEach(t => stats[t.id] = { name: t.name, wins: 0, losses: 0 });
  finished.forEach(m => {
    if (m.team1_id && m.team2_id && m.winner_id && stats[m.team1_id] && stats[m.team2_id]) {
      if (m.winner_id === m.team1_id) { stats[m.team1_id].wins++; stats[m.team2_id].losses++; }
      else { stats[m.team2_id].wins++; stats[m.team1_id].losses++; }
    }
  });
  const arr = Object.values(stats).sort((a, b) => b.wins - a.wins);
  const max = Math.max(...arr.map(s => s.wins + s.losses), 1);
  const html = arr.map(s => `
    <div class="bar-row">
      <div class="bar-label">${escapeHtml(s.name)}</div>
      <div class="bar-track bar-double">
        <div class="bar-fill bar-win" style="width:${(s.wins / max * 100).toFixed(1)}%"></div>
        <div class="bar-fill bar-loss" style="width:${(s.losses / max * 100).toFixed(1)}%"></div>
      </div>
      <div class="bar-value"><span style="color:#1A4D3A">${s.wins}胜</span> <span style="color:#d9534f">${s.losses}负</span></div>
    </div>
  `).join('');
  document.getElementById('chartWins').innerHTML = html;
}

// ========== 冠军概率预测 ==========
async function renderTitleProbability() {
  const el = document.getElementById('chartTitleProb');
  if (!el) return;
  if (currentGender === 'women') {
    try {
      const d = await fetch('/api/standings/women').then(r => r.json());
      const rows = [...(d.groupA || []), ...(d.groupB || [])];
      if (!rows.length) { el.innerHTML = '<div class="empty-state"><div class="icon">🏆</div>暂无有效数据</div>'; return; }
      const weights = rows.map(s => Math.max(0.1, (s.points || 0) + 1 + (s.gd || 0) * 0.1));
      const sum = weights.reduce((a, b) => a + b, 0);
      const list = rows.map((s, i) => ({ s, p: weights[i] / sum })).sort((a, b) => b.p - a.p);
      const maxP = list[0].p;
      el.innerHTML = list.map((x, i) => {
        const pct = (x.p * 100).toFixed(1);
        const bar = (x.p / maxP * 100).toFixed(1);
        return `<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
          <span style="min-width:24px;font-weight:700;color:#1A4D3A;font-size:16px">${i + 1}</span>
          <img src="${x.s.logo_path || teamLogo(x.s.team_id)}" class="team-logo team-logo-sm" style="width:28px;height:28px">
          <span style="min-width:110px;font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(x.s.team_name)}</span>
          <span style="font-size:11px;min-width:40px;color:#666">${x.s.points}分</span>
          <div style="flex:1;background:#F0F4F2;border-radius:8px;height:24px;position:relative;overflow:hidden">
            <div style="width:${bar}%;height:100%;background:linear-gradient(90deg,#1A4D3A,#3d8b6e);border-radius:8px;display:flex;align-items:center;justify-content:flex-end;padding-right:8px">
              <span style="color:#fff;font-size:12px;font-weight:700">${pct}%</span></div></div></div>`;
      }).join('') + '<div style="font-size:11px;color:#999;margin-top:8px;text-align:right">* 女子组出线/夺冠指数基于小组积分与净胜球综合估算，仅供参考</div>';
    } catch (e) { el.innerHTML = '<div class="empty-state">预测数据加载失败</div>'; }
    return;
  }
  try {
    const res = await fetch('/api/standings');
    const data = await res.json();
    // 三败淘汰制：剩余生命 = 3 - losses，已淘汰概率为0
    const alive = data.filter(s => (s.losses || 0) < 3);
    if (!alive.length) {
      el.innerHTML = '<div class="empty-state"><div class="icon">🏆</div>暂无有效数据</div>';
      return;
    }
    // 计算夺冠指数：剩余生命 × (胜场+1) × 实力修正(净胜球)
    alive.forEach(s => {
      const life = 3 - (s.losses || 0);
      const strength = (s.wins || 0) + 1;
      const gdFactor = 1 + Math.max(-0.5, Math.min(0.5, (s.gd || 0) * 0.03));
      s._index = life * strength * gdFactor;
    });
    // Softmax归一化（温度系数平滑）
    const temp = 2.5;
    const exps = alive.map(s => Math.exp(s._index / temp));
    const sumExp = exps.reduce((a, b) => a + b, 0);
    alive.forEach((s, i) => s._prob = exps[i] / sumExp);
    // 按概率降序
    alive.sort((a, b) => b._prob - a._prob);
    const maxProb = alive[0]._prob;
    const colors = ['#FFD700', '#C0C0C0', '#CD7F32', '#1A4D3A', '#2d7a5e', '#3d8b6e', '#4d9c7e', '#5dad8e'];
    el.innerHTML = alive.map((s, i) => {
      const pct = (s._prob * 100).toFixed(1);
      const barPct = (s._prob / maxProb * 100).toFixed(1);
      const life = 3 - (s.losses || 0);
      const lifeDots = '❤️'.repeat(life) + '🖤'.repeat(3 - life);
      return `<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
        <span style="min-width:24px;font-weight:700;color:${colors[i] || '#1A4D3A'};font-size:16px">${i + 1}</span>
        <img src="${s.logo_path || teamLogo(s.team_id)}" class="team-logo team-logo-sm" style="width:28px;height:28px">
        <span style="min-width:100px;font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.team_name)}</span>
        <span style="font-size:11px;min-width:54px">${lifeDots}</span>
        <div style="flex:1;background:#F0F4F2;border-radius:8px;height:24px;position:relative;overflow:hidden">
          <div style="width:${barPct}%;height:100%;background:linear-gradient(90deg,${colors[i] || '#1A4D3A'},${colors[i] || '#1A4D3A'}cc);border-radius:8px;transition:width 0.8s ease;display:flex;align-items:center;justify-content:flex-end;padding-right:8px">
            <span style="color:#fff;font-size:12px;font-weight:700">${pct}%</span>
          </div>
        </div>
      </div>`;
    }).join('') + `<div style="font-size:11px;color:#999;margin-top:8px;text-align:right">* 预测基于剩余生命、胜场数、净胜球综合计算，仅供参考</div>`;
  } catch (e) {
    el.innerHTML = '<div class="empty-state">预测数据加载失败</div>';
  }
}

// 男子阶段/分组标签
function menStageLabel(m) {
  const rg = String(m.round_group || '');
  if (rg === 'A' || rg === 'B') return rg + '组';
  if (rg === 'SFX' || rg === 'SFY') return '半决赛';
  if (rg === 'PO1' || rg === 'PO2') return '附加赛';
  if (rg === 'TP') return '季军赛';
  if (rg === 'F') return '决赛';
  return '';
}
function roundFullText(m) { return (m && m.round_name) || ''; }

function matchCardHtml(m) {
  const women = isWomenMatch(m);
  const t1 = m.team1 ? m.team1.name : (m.team1_source || '待定');
  const t2 = m.team2 ? m.team2.name : (m.team2_source || '待定');
  let score = '<span class="match-vs">VS</span>';
  if (m.status === 'finished') {
    const hasScore = m.team1_score !== null && m.team1_score !== undefined;
    score = hasScore ? `<strong>${m.team1_score} : ${m.team2_score}</strong>${m.has_penalty ? `<br><small style="font-size:11px;color:var(--text-light)">点 ${m.penalty_team1}:${m.penalty_team2}</small>` : ''}` : '<span class="match-vs">待录比分</span>';
  }
  const stage = women ? '女子组' : ('男子组 · ' + menStageLabel(m));
  return `<div class="match-card" onclick="openMatch(${m.id})">
    <div class="match-meta"><span>场序${displayMatchNum(m)} · ${roundFullText(m)} · ${stage}</span><span>${m.match_date || ''} ${m.match_time || ''}</span></div>
    <div class="match-teams">
      <div class="match-team" style="justify-content:flex-end;text-align:right">${t1}</div>
      <div class="match-score ${m.status==='finished'?'':'pending'}">${score}</div>
      <div class="match-team">${t2}</div>
    </div>
  </div>`;
}

// ========== 赛程表 ==========
// 场序按实际比赛时间排序（同组别内）；调整比赛时间后，赛程表场序自动重排。
// 内部 match_number 保持不变（清黄边界/打印/战报等业务逻辑仍依赖它）。
function padTime(t) {
  const p = String(t == null ? '' : t).split(':');
  return (p[0] || '').padStart(2, '0') + ':' + ((p[1] || '').padStart(2, '0'));
}
function matchTimeKey(m) {
  return (m.match_date || '') + 'T' + padTime(m.match_time || '');
}
function timeOrderedMatches(pool) {
  return pool.slice().sort((a, b) => {
    const ka = matchTimeKey(a), kb = matchTimeKey(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return (a.match_number || 0) - (b.match_number || 0);
  });
}
function timeOrderNum(m) {
  const list = timeOrderedMatches(genderMatches());
  const idx = list.findIndex(x => x.id === m.id);
  return idx < 0 ? displayMatchNum(m) : (idx + 1);
}
async function loadSchedule() {
  const tbody = document.querySelector('#scheduleTable tbody');
  // —— 表演赛行（排在正式赛程最前面）——
  const exhList = (allExhibitions || []).filter(x => genderOk(x.gender || 'men'));
  const exhRows = exhList.map((x, i) => {
    const women = x.gender === 'women';
    const t1 = escapeHtml(x.team1_name || '待定');
    const t2 = escapeHtml(x.team2_name || '待定');
    let score = '-', pen = '-';
    if (x.status === 'finished') {
      score = `<strong>${x.team1_score} : ${x.team2_score}</strong>`;
      pen = `${x.penalty_team1} : ${x.penalty_team2}`;
    } else if (x.team1_score != null) {
      score = `${x.team1_score} : ${x.team2_score}`;
    }
    const action = isAdmin()
      ? `<button class="btn btn-sm ${x.status==='finished'?'btn-outline':'btn-primary'}" onclick="event.stopPropagation();openExhibition(${x.id})">${x.status==='finished'?'查看/修改':'管理'}</button>`
      : `<button class="btn btn-sm btn-outline" onclick="event.stopPropagation();openExhibition(${x.id})">详情</button>`;
    return `<tr onclick="openExhibition(${x.id})" style="cursor:pointer;background:#fcfdfd">
      <td>表${i+1}${women?'<span class="wtag">女</span>':''}</td><td>表演赛</td><td>表演赛</td>
      <td>${t1}</td><td class="text-center">${score}</td><td>${t2}</td>
      <td class="text-center">${pen}</td>
      <td>${x.match_date||'-'}</td><td>${x.match_time||'-'}</td>
      <td>${x.match_location||'-'}</td><td>${escapeHtml(x.main_referee_name||'-')}</td>
      <td>${statusBadge(x.status)}</td>
      <td class="no-print">${action}</td>
    </tr>`;
  }).join('');
  // —— 正式赛程（场序按实际比赛时间动态排序：调整时间后场序自动重排）——
  const list = timeOrderedMatches(genderMatches());
  const rows = list.map((m, idx) => {
    const women = isWomenMatch(m);
    const t1 = m.team1 ? escapeHtml(m.team1.name) : `<span style="color:#bbb">${escapeHtml(m.team1_source) || '待定'}</span>`;
    const t2 = m.team2 ? escapeHtml(m.team2.name) : `<span style="color:#bbb">${escapeHtml(m.team2_source) || '待定'}</span>`;
    let score = '-';
    if (m.status === 'finished') {
      score = (m.team1_score !== null && m.team1_score !== undefined) ? `<strong>${m.team1_score} : ${m.team2_score}</strong>` : '待录比分';
    }
    let pen = '-';
    if (m.has_penalty) pen = `${m.penalty_team1} : ${m.penalty_team2}`;
    const ref = m.main_referee_id ? escapeHtml(allReferees.find(r => r.id === m.main_referee_id)?.name || '-') : '-';
    let action;
    if (isAdmin()) {
      action = `<button class="btn btn-sm ${m.status==='finished'?'btn-outline':'btn-primary'}" onclick="event.stopPropagation();openMatch(${m.id})">${m.status==='finished'?'查看/修改':'管理'}</button>`;
    } else {
      const inTeam = currentUser.team_id && (m.team1_id === currentUser.team_id || m.team2_id === currentUser.team_id);
      const detailBtn = (m.team1_id != null && m.team2_id != null) ? `<button class="btn btn-sm btn-outline" onclick="event.stopPropagation();openMatch(${m.id})">详情</button>` : '';
      let rateBtn = '';
      if (inTeam && m.status === 'finished' && m.finished_at) {
        if (ratingWindowOpen(m)) rateBtn = `<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();openRatingLink(${m.id})">裁判评分</button>`;
        else rateBtn = `<button class="btn btn-sm btn-outline" disabled style="opacity:.6">评分已结束</button>`;
      }
      action = (detailBtn || rateBtn) ? `<div style="display:flex;gap:6px;justify-content:flex-end">${detailBtn}${rateBtn}</div>` : '';
    }
    const groupLabel = women ? '循环赛' : menStageLabel(m);
    const byeNote = women && m.notes ? `<div style="font-size:11px;color:var(--text-light)">${escapeHtml(m.notes)}</div>` : '';
    return `<tr onclick="openMatch(${m.id})" style="cursor:pointer">
      <td>${idx + 1}${women?'<span class="wtag">女</span>':''}</td><td>${m.round_name}${byeNote}</td><td>${groupLabel}</td>
      <td>${t1}</td><td class="text-center">${score}</td><td>${t2}</td>
      <td class="text-center">${pen}</td>
      <td>${m.match_date || '-'}</td><td>${m.match_time || '-'}</td>
      <td>${escapeHtml(m.match_location) || '-'}</td><td>${ref}</td>
      <td>${statusBadge(m.status)}</td>
      <td class="no-print">${action}</td>
    </tr>`;
  }).join('');
  tbody.innerHTML = exhRows + rows;
  if (!exhRows && !list.length) tbody.innerHTML = '<tr><td colspan="13" class="empty-state">当前组别暂无赛程</td></tr>';
}


// ========== 表演赛（正赛前；管理员填报双方人员；只统计基本信息/比分/点球/事件）==========
let currentExhibition = null;

async function loadExhibitions() {
  try { allExhibitions = await fetch('/api/exhibition').then(r => r.json()); }
  catch (e) { allExhibitions = []; }
}

// ---- 基本信息表单 ----
async function openExhibitionForm(id) {
  if (!isAdmin()) return;
  let x = null;
  if (id) {
    x = await fetch('/api/exhibition/' + id).then(r => r.json());
    if (x.status === 'finished') { alert('已结束的表演赛不能直接编辑，请先在详情中重置为未开始'); return; }
  }
  const g = x ? x.gender : 'men';
  const teamOptions = gd => allTeams.filter(t => (t.gender || 'men') === gd)
    .map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  const refOptions = v => '<option value="">不填</option>' +
    allReferees.map(r => `<option value="${r.id}" ${r.id === v ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
  const sideField = (side, label) => {
    const tid = side === 1 ? (x && x.team1_id) : (x && x.team2_id);
    const cust = side === 1 ? (x && x.team1_custom || '') : (x && x.team2_custom || '');
    const mode = tid ? 'team' : (cust ? 'custom' : 'team');
    return `
    <div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px">
      <div style="font-weight:600;margin-bottom:8px">${label}</div>
      <label style="font-size:13px;margin-right:14px"><input type="radio" name="exh_side${side}_type" value="team" ${mode === 'team' ? 'checked' : ''}> 选择注册球队</label>
      <label style="font-size:13px"><input type="radio" name="exh_side${side}_type" value="custom" ${mode === 'custom' ? 'checked' : ''}> 填写临时队名</label>
      <div id="exh_side${side}_team" style="margin-top:8px"><select id="exh_side${side}_tid" class="form-control">${teamOptions(g)}</select></div>
      <div id="exh_side${side}_custom" style="margin-top:8px;display:none"><input id="exh_side${side}_cust" class="form-control" placeholder="临时队名（如：校友联队）" value="${escapeHtml(cust)}"></div>
    </div>`;
  };
  document.getElementById('exhibitionFormTitle').textContent = id ? '编辑表演赛' : '添加表演赛';
  document.getElementById('exhibitionFormBody').innerHTML = `
    <div class="form-row">
      <div class="form-group"><label>组别</label>
        <select id="exh_gender" class="form-control" onchange="exhGenderChange()">
          <option value="men" ${g === 'men' ? 'selected' : ''}>男子</option>
          <option value="women" ${g === 'women' ? 'selected' : ''}>女子</option>
        </select></div>
      <div class="form-group"><label>比赛日期</label><input id="exh_date" type="date" class="form-control" value="${x ? x.match_date || '' : ''}"></div>
      <div class="form-group"><label>比赛时间</label><input id="exh_time" type="time" class="form-control" value="${x ? x.match_time || '' : ''}"></div>
      <div class="form-group"><label>比赛地点</label><input id="exh_loc" class="form-control" value="${escapeHtml(x ? x.match_location || '三期操场' : '三期操场')}"></div>
    </div>
    ${sideField(1, '一方')}
    ${sideField(2, '另一方')}
    <div class="form-row">
      <div class="form-group"><label>主裁判</label><select id="exh_main_ref" class="form-control">${refOptions(x ? x.main_referee_id : null)}</select></div>
      <div class="form-group"><label>助理裁判1</label><select id="exh_a1_ref" class="form-control">${refOptions(x ? x.assistant_ref1_id : null)}</select></div>
      <div class="form-group"><label>助理裁判2</label><select id="exh_a2_ref" class="form-control">${refOptions(x ? x.assistant_ref2_id : null)}</select></div>
    </div>
    <div class="form-group"><label>备注</label><textarea id="exh_notes" class="form-control" rows="2">${escapeHtml(x ? x.notes || '' : '')}</textarea></div>
    <div style="font-size:12px;color:var(--text-light)">提示：表演赛排在正式赛程最前面；无论比分如何都进行点球大战；只记录本场信息，不计入正赛积分、射手榜与纪律停赛。</div>`;
  document.getElementById('exhibitionFormFooter').innerHTML = `
    <button class="btn btn-outline" onclick="closeModal('exhibitionFormModal')">取消</button>
    <button class="btn btn-primary" onclick="saveExhibition(${id || 'null'})">保存</button>`;
  // 初始化两侧显示模式（用事件委托绑定切换）
  document.querySelectorAll('input[name="exh_side1_type"]').forEach(r => r.onchange = () => exhToggleSide(1, r.value));
  document.querySelectorAll('input[name="exh_side2_type"]').forEach(r => r.onchange = () => exhToggleSide(2, r.value));
  exhToggleSide(1, document.querySelector('input[name="exh_side1_type"]:checked').value);
  exhToggleSide(2, document.querySelector('input[name="exh_side2_type"]:checked').value);
  if (x && x.team1_id) document.getElementById('exh_side1_tid').value = x.team1_id;
  if (x && x.team2_id) document.getElementById('exh_side2_tid').value = x.team2_id;
  showModal('exhibitionFormModal');
}

function exhToggleSide(side, mode) {
  document.getElementById('exh_side' + side + '_team').style.display = mode === 'team' ? '' : 'none';
  document.getElementById('exh_side' + side + '_custom').style.display = mode === 'custom' ? '' : 'none';
}
function exhGenderChange() {
  const gd = document.getElementById('exh_gender').value;
  [1, 2].forEach(side => {
    const sel = document.getElementById('exh_side' + side + '_tid');
    const cur = sel.value;
    sel.innerHTML = allTeams.filter(t => (t.gender || 'men') === gd)
      .map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    if (cur) sel.value = cur;
  });
}

async function saveExhibition(id) {
  const body = {
    gender: document.getElementById('exh_gender').value,
    match_date: document.getElementById('exh_date').value,
    match_time: document.getElementById('exh_time').value,
    match_location: document.getElementById('exh_loc').value,
    main_referee_id: document.getElementById('exh_main_ref').value,
    assistant_ref1_id: document.getElementById('exh_a1_ref').value,
    assistant_ref2_id: document.getElementById('exh_a2_ref').value,
    notes: document.getElementById('exh_notes').value
  };
  [1, 2].forEach(side => {
    const type = document.querySelector(`input[name="exh_side${side}_type"]:checked`).value;
    if (type === 'team') {
      body[side === 1 ? 'team1_id' : 'team2_id'] = document.getElementById('exh_side' + side + '_tid').value;
      body[side === 1 ? 'team1_custom' : 'team2_custom'] = '';
    } else {
      body[side === 1 ? 'team1_id' : 'team2_id'] = '';
      body[side === 1 ? 'team1_custom' : 'team2_custom'] = document.getElementById('exh_side' + side + '_cust').value;
    }
  });
  const res = await fetch('/api/exhibition' + (id ? '/' + id : ''), {
    method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { alert(d.error || '保存失败'); return; }
  closeModal('exhibitionFormModal');
  await loadExhibitions();
  loadSchedule();
}

async function deleteExhibition(id) {
  if (!confirm('确定删除这场表演赛及其人员、比分、点球、事件记录吗？此操作不可恢复。')) return;
  const res = await fetch('/api/exhibition/' + id, { method: 'DELETE' });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { alert(d.error || '删除失败'); return; }
  closeModal('exhibitionModal');
  await loadExhibitions();
  loadSchedule();
}

// ---- 人员名单编辑器 ----
function exhRosterEditor(x, side) {
  const tid = side === 1 ? x.team1_id : x.team2_id;
  const saved = x.players.filter(p => p.side === side);
  const title = side === 1 ? x.team1_name : x.team2_name;
  const disabled = x.status === 'finished';
  if (tid) {
    const pool = allPlayers.filter(p => p.team_id === tid && p.status === 'approved' && !p.deleted_at);
    const savedIds = new Set(saved.map(p => p.player_id));
    const rows = pool.map(p => `
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:3px 0">
        <input type="checkbox" class="exh_roster_${side}" value="${p.id}" ${savedIds.has(p.id) ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
        <span style="min-width:34px">${p.jersey_number || ''}</span><span>${escapeHtml(p.name)}</span>
      </label>`).join('') || '<div style="font-size:12px;color:var(--text-light)">该球队暂无注册球员</div>';
    return `<div style="flex:1;min-width:260px;border:1px solid var(--border);border-radius:10px;padding:12px">
      <div style="font-weight:600;margin-bottom:8px">${escapeHtml(title)} 名单 <span style="font-size:11px;color:var(--text-light)">从球员库勾选</span></div>
      <div style="max-height:240px;overflow:auto">${rows}</div>
      ${disabled ? '' : `<button class="btn btn-sm btn-primary" style="margin-top:8px" onclick="saveExhRoster(${x.id},${side})">保存名单</button>`}
      <div style="font-size:12px;color:var(--text-light);margin-top:6px">已选 ${savedIds.size} 人</div>
    </div>`;
  }
  const rows = saved.map(p => `
    <div style="display:flex;gap:6px;margin-bottom:6px">
      <input class="form-control exh_cr_num" style="width:64px" value="${p.jersey_number || ''}" placeholder="号" ${disabled ? 'disabled' : ''}>
      <input class="form-control exh_cr_name" value="${escapeHtml(p.name)}" placeholder="姓名" ${disabled ? 'disabled' : ''}>
      ${disabled ? '' : '<button class="btn btn-sm btn-outline" onclick="this.parentElement.remove()">×</button>'}
    </div>`).join('');
  return `<div style="flex:1;min-width:260px;border:1px solid var(--border);border-radius:10px;padding:12px">
    <div style="font-weight:600;margin-bottom:8px">${escapeHtml(title)} 名单 <span style="font-size:11px;color:var(--text-light)">手工录入</span></div>
    <div id="exh_crows_${side}">${rows}</div>
    ${disabled ? '' : `
    <button class="btn btn-sm btn-outline" onclick="exhAddCRow(${side})">＋ 添加一行</button>
    <button class="btn btn-sm btn-primary" onclick="saveExhRoster(${x.id},${side})">保存名单</button>`}
    <div style="font-size:12px;color:var(--text-light);margin-top:6px">已录 ${saved.length} 人</div>
  </div>`;
}
function exhAddCRow(side) {
  const wrap = document.getElementById('exh_crows_' + side);
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;gap:6px;margin-bottom:6px';
  div.innerHTML = `<input class="form-control exh_cr_num" style="width:64px" placeholder="号"><input class="form-control exh_cr_name" placeholder="姓名"><button class="btn btn-sm btn-outline" onclick="this.parentElement.remove()">×</button>`;
  wrap.appendChild(div);
}
async function saveExhRoster(id, side) {
  const x = currentExhibition;
  const tid = side === 1 ? x.team1_id : x.team2_id;
  let players = [];
  if (tid) {
    players = Array.from(document.querySelectorAll(`.exh_roster_${side}:checked`)).map(c => ({ player_id: c.value }));
  } else {
    document.querySelectorAll(`#exh_crows_${side} > div`).forEach(d => {
      const num = d.querySelector('.exh_cr_num').value;
      const name = d.querySelector('.exh_cr_name').value.trim();
      if (name) players.push({ jersey_number: num, name });
    });
  }
  const res = await fetch(`/api/exhibition/${id}/roster`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ side, players })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { alert(d.error || '保存失败'); return; }
  await openExhibition(id);
}

// ---- 全场比分 ----
function exhScoreSection(x) {
  if (x.status === 'finished') return '';
  const s1 = x.team1_score != null ? x.team1_score : '';
  const s2 = x.team2_score != null ? x.team2_score : '';
  return `<div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:14px">
    <div style="font-weight:600;margin-bottom:8px">全场比分</div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <input id="exh_s1" class="form-control" style="width:70px" type="number" min="0" value="${s1}">
      <span>:</span>
      <input id="exh_s2" class="form-control" style="width:70px" type="number" min="0" value="${s2}">
      <button class="btn btn-sm btn-primary" onclick="saveExhScore(${x.id})">保存比分</button>
      <span style="font-size:12px;color:var(--text-light)">保存后可记录点球与事件</span>
    </div>
  </div>`;
}
async function saveExhScore(id) {
  const team1_score = document.getElementById('exh_s1').value;
  const team2_score = document.getElementById('exh_s2').value;
  const res = await fetch(`/api/exhibition/${id}/score`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ team1_score, team2_score })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { alert(d.error || '保存失败'); return; }
  await openExhibition(id);
}

// ---- 点球大战 ----
function exhPenaltySection(x) {
  if (x.team1_score == null) return '';
  const ro = side => x.players.filter(p => p.side === side);
  const psel = side => '<option value="">选择球员</option>' +
    ro(side).map(p => `<option value="${p.id}">${p.jersey_number ? p.jersey_number + ' ' : ''}${escapeHtml(p.name)}</option>`).join('');
  const list = side => {
    const ks = x.penalties.filter(p => p.side === side);
    if (!ks.length) return '<div style="font-size:12px;color:var(--text-light)">暂无记录</div>';
    return ks.map(k => {
      const p = x.players.find(q => q.id === k.roster_id);
      const nm = p ? `${p.jersey_number ? p.jersey_number + ' ' : ''}${p.name}` : '—';
      return `<div style="display:flex;align-items:center;gap:8px;font-size:13px;padding:2px 0">
        <span style="min-width:24px">${k.kick_order}.</span><span style="flex:1">${escapeHtml(nm)}</span>
        <span style="color:${k.scored ? '#2e7d32' : '#c62828'}">${k.scored ? '● 进' : '○ 失'}</span>
        ${x.status === 'finished' ? '' : `<button class="btn btn-sm btn-outline" onclick="delExhPen(${x.id},${k.id})">删</button>`}
      </div>`;
    }).join('');
  };
  const addForm = side => x.status === 'finished' ? '' : `
    <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
      <select id="exh_pen_player_${side}" class="form-control" style="width:150px">${psel(side)}</select>
      <select id="exh_pen_scored_${side}" class="form-control" style="width:80px"><option value="1">罚进</option><option value="0">罚失</option></select>
      <button class="btn btn-sm btn-primary" onclick="addExhPen(${x.id},${side})">记录</button>
    </div>`;
  const t1 = x.penalties.filter(p => p.side === 1 && p.scored).length;
  const t2 = x.penalties.filter(p => p.side === 2 && p.scored).length;
  return `<div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:14px">
    <div style="font-weight:600;margin-bottom:4px">点球大战 <span style="font-size:12px;color:var(--text-light);font-weight:normal">无论比分如何都进行；当前 ${t1} : ${t2}</span></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div><div style="font-weight:600;font-size:13px;margin-bottom:4px">${escapeHtml(x.team1_name)}</div>${list(1)}${addForm(1)}</div>
      <div><div style="font-weight:600;font-size:13px;margin-bottom:4px">${escapeHtml(x.team2_name)}</div>${list(2)}${addForm(2)}</div>
    </div>
  </div>`;
}
async function addExhPen(id, side) {
  const roster_id = document.getElementById('exh_pen_player_' + side).value;
  const scored = document.getElementById('exh_pen_scored_' + side).value;
  const res = await fetch(`/api/exhibition/${id}/penalties`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ side, roster_id, scored })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { alert(d.error || '操作失败'); return; }
  await openExhibition(id);
}
async function delExhPen(id, pid) {
  const res = await fetch(`/api/exhibition/${id}/penalties/${pid}`, { method: 'DELETE' });
  if (res.ok) await openExhibition(id);
}

// ---- 比赛事件 ----
const EXH_EVENT_LABEL = { goal: '进球', own_goal: '乌龙', yellow: '黄牌', red: '红牌', sub: '换人', other: '其他' };
function exhEventsSection(x) {
  const ro = side => x.players.filter(p => p.side === side);
  const psel = side => '<option value="">选择球员</option>' +
    ro(side).map(p => `<option value="${p.id}">${p.jersey_number ? p.jersey_number + ' ' : ''}${escapeHtml(p.name)}</option>`).join('');
  const list = x.events.length ? x.events.map(e => {
    const p = x.players.find(q => q.id === e.roster_id);
    const sp = x.players.find(q => q.id === e.sub_roster_id);
    const pnm = p ? `${p.jersey_number ? p.jersey_number + ' ' : ''}${p.name}` : '';
    const snm = sp ? `${sp.jersey_number ? sp.jersey_number + ' ' : ''}${sp.name}` : '';
    const txt = e.event_type === 'sub' ? `${pnm} 下，${snm} 上` : (pnm + (e.description ? ' ' + e.description : ''));
    return `<div style="display:flex;align-items:center;gap:8px;font-size:13px;padding:2px 0">
      <span style="min-width:34px;color:var(--text-light)">${e.minute ? e.minute + "'" : ''}</span>
      <span class="badge" style="background:#f1f5f9;color:#334155">${EXH_EVENT_LABEL[e.event_type] || '其他'}</span>
      <span style="flex:1">${escapeHtml(txt)}</span>
      ${x.status === 'finished' ? '' : `<button class="btn btn-sm btn-outline" onclick="delExhEvent(${x.id},${e.id})">删</button>`}
    </div>`;
  }).join('') : '<div style="font-size:12px;color:var(--text-light)">暂无事件</div>';
  const form = x.status === 'finished' ? '' : `
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
      <select id="exh_ev_type" class="form-control" style="width:96px" onchange="exhEvTypeChange()">
        ${Object.keys(EXH_EVENT_LABEL).map(k => `<option value="${k}">${EXH_EVENT_LABEL[k]}</option>`).join('')}
      </select>
      <select id="exh_ev_side" class="form-control" style="width:90px" onchange="exhEvSideChange()">
        <option value="1">一方</option><option value="2">另一方</option>
      </select>
      <select id="exh_ev_player" class="form-control" style="width:150px">${psel(1)}</select>
      <select id="exh_ev_sub" class="form-control" style="width:150px;display:none">${psel(1)}</select>
      <input id="exh_ev_min" class="form-control" style="width:64px" type="number" min="0" placeholder="分钟">
      <input id="exh_ev_desc" class="form-control" style="width:160px" placeholder="说明（可选）">
      <button class="btn btn-sm btn-primary" onclick="addExhEvent(${x.id})">记录事件</button>
    </div>`;
  return `<div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:14px">
    <div style="font-weight:600;margin-bottom:4px">比赛事件 <span style="font-size:12px;color:var(--text-light);font-weight:normal">仅本场留痕，不计射手榜与停赛</span></div>
    ${list}${form}
  </div>`;
}
function exhEvTypeChange() {
  const type = document.getElementById('exh_ev_type').value;
  document.getElementById('exh_ev_sub').style.display = type === 'sub' ? '' : 'none';
}
function exhEvSideChange() {
  const side = document.getElementById('exh_ev_side').value;
  const x = currentExhibition;
  const opts = '<option value="">选择球员</option>' +
    x.players.filter(p => p.side === +side).map(p => `<option value="${p.id}">${p.jersey_number ? p.jersey_number + ' ' : ''}${escapeHtml(p.name)}</option>`).join('');
  document.getElementById('exh_ev_player').innerHTML = opts;
  document.getElementById('exh_ev_sub').innerHTML = opts;
}
async function addExhEvent(id) {
  const payload = {
    event_type: document.getElementById('exh_ev_type').value,
    side: document.getElementById('exh_ev_side').value,
    roster_id: document.getElementById('exh_ev_player').value,
    sub_roster_id: document.getElementById('exh_ev_sub').value,
    minute: document.getElementById('exh_ev_min').value,
    description: document.getElementById('exh_ev_desc').value
  };
  const res = await fetch(`/api/exhibition/${id}/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { alert(d.error || '操作失败'); return; }
  await openExhibition(id);
}
async function delExhEvent(id, eid) {
  const res = await fetch(`/api/exhibition/${id}/events/${eid}`, { method: 'DELETE' });
  if (res.ok) await openExhibition(id);
}

// ---- 详情弹窗 ----
async function openExhibition(id) {
  const x = await fetch('/api/exhibition/' + id).then(r => r.json());
  currentExhibition = x;
  document.getElementById('exhibitionModalTitle').textContent =
    `表演赛 ${x.team1_name} vs ${x.team2_name}`;
  let resultLine = '';
  if (x.status === 'finished') {
    const winName = x.penalty_winner_side ? (x.penalty_winner_side === 1 ? x.team1_name : x.team2_name) : '';
    resultLine = `<div style="background:#f8fafc;border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center">
      <div style="font-size:15px"><strong>${escapeHtml(x.team1_name)}</strong> ${x.team1_score} : ${x.team2_score} <strong>${escapeHtml(x.team2_name)}</strong></div>
      <div style="margin-top:6px;font-size:13px">点球 <strong>${x.penalty_team1} : ${x.penalty_team2}</strong>
        <span style="color:#1A4D3A;margin-left:8px">点球胜方：${escapeHtml(winName)}</span></div>
    </div>`;
  }
  const info = `<div style="font-size:13px;color:var(--text-light);line-height:1.9;margin:8px 0">
    ${x.gender === 'women' ? '<span class="wtag">女</span>' : '男子'} ｜
    时间：${x.match_date || '日期待定'} ${x.match_time || ''} ｜ 地点：${x.match_location || '三期操场'} ｜ ${statusBadge(x.status)}<br>
    主裁判：${x.main_referee_name || '未填'} ｜ 助理1：${x.assistant_ref1_name || '未填'} ｜ 助理2：${x.assistant_ref2_name || '未填'}
    ${x.notes ? `<br>备注：${escapeHtml(x.notes)}` : ''}
  </div>`;
  document.getElementById('exhibitionModalBody').innerHTML =
    resultLine + info +
    `<div style="display:flex;gap:14px;flex-wrap:wrap">${exhRosterEditor(x, 1)}${exhRosterEditor(x, 2)}</div>` +
    exhScoreSection(x) + exhPenaltySection(x) + exhEventsSection(x);
  let footer = `<button class="btn btn-outline" onclick="closeModal('exhibitionModal')">关闭</button>`;
  if (isAdmin()) {
    if (x.status === 'finished') {
      footer += `<button class="btn btn-outline" onclick="reopenExhibition(${x.id})">重置为未开始</button>`;
    } else {
      footer = `<button class="btn btn-danger" onclick="deleteExhibition(${x.id})">删除</button>` + footer;
      if (x.team1_score != null) footer += `<button class="btn btn-primary" onclick="finishExhibition(${x.id})">结束并统计</button>`;
    }
  }
  document.getElementById('exhibitionModalFooter').innerHTML = footer;
  showModal('exhibitionModal');
}
async function finishExhibition(id) {
  const res = await fetch(`/api/exhibition/${id}/finish`, { method: 'POST' });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { alert(d.error || '操作失败'); return; }
  await loadExhibitions();
  loadSchedule();
  await openExhibition(id);
}
async function reopenExhibition(id) {
  if (!confirm('重置后将清空比分、点球与事件（保留人员名单），确定？')) return;
  const res = await fetch(`/api/exhibition/${id}/reopen`, { method: 'POST' });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { alert(d.error || '操作失败'); return; }
  await loadExhibitions();
  loadSchedule();
  await openExhibition(id);
}

// ========== 对阵图 ==========
// 男子签位/来源标签
function menSourceLabel(s) {
  const map = {
    A1: 'A组1号', A2: 'A组2号', A3: 'A组3号',
    B1: 'B组1号', B2: 'B组2号', B3: 'B组3号',
    GA1: 'A组第1', GA2: 'A组第2', GA3: 'A组第3',
    GB1: 'B组第1', GB2: 'B组第2', GB3: 'B组第3',
    LR2: '较低小组第二', PO1W: '附加赛①胜者',
    WX: '半决赛X小组第一', WY: '半决赛Y小组第一',
    CX: '半决赛X晋级队', CY: '半决赛Y晋级队',
    SXL: '半决赛X负者', SYL: '半决赛Y负者',
    SXW: '半决赛X胜者', SYW: '半决赛Y胜者'
  };
  return map[s] || s || '待定';
}
function sideName(m, side) {
  const tm = side === 1 ? m.team1 : m.team2;
  if (tm) return tm.name;
  const src = side === 1 ? m.team1_source : m.team2_source;
  return menSourceLabel(src);
}
function bmMatchCard(m, extra) {
  const t1Win = m.status === 'finished' && m.winner_id === m.team1_id;
  const t2Win = m.status === 'finished' && m.winner_id === m.team2_id;
  let s1 = '', s2 = '';
  if (m.status === 'finished') {
    s1 = `<span class="bm-score">${m.team1_score ?? ''}</span>`;
    s2 = `<span class="bm-score">${m.team2_score}</span>`;
  }
  const pen = (m.status === 'finished' && m.has_penalty) ? `<div class="bm-pen">点 ${m.penalty_team1}:${m.penalty_team2}</div>` : '';
  const aggLine = extra ? `<div class="bm-pen bm-agg">${extra}</div>` : '';
  return `<div class="bracket-match ${m.status}" onclick="openMatch(${m.id})">
    <div class="bm-num">#${m.match_number}</div>
    <div class="bm-team ${t1Win?'winner':''} ${!m.team1?'tbd':''}"><span>${sideName(m,1)}</span>${s1}</div>
    <div class="bm-team ${t2Win?'winner':''} ${!m.team2?'tbd':''}"><span>${sideName(m,2)}</span>${s2}</div>
    ${pen}${aggLine}
  </div>`;
}
function bmColumn(title, cards, cls) {
  return `<div class="bracket-round ${cls||''}"><div class="bracket-round-title">${title}</div>${cards}</div>`;
}
function findMen(num) { return allMatches.find(x => x.match_number === num); }

function menBracketHtml() {
  const groupCol = (letter, nums) => {
    const cards = nums.map(n => bmMatchCard(findMen(n))).join('');
    return bmColumn(letter + '组 · 双循环', cards, 'brk-group');
  };
  const po = bmColumn('附加赛①', bmMatchCard(findMen(13)), 'brk-po')
           + bmColumn('附加赛②', bmMatchCard(findMen(14)), 'brk-po');
  const sf1 = bmColumn('半决赛X', bmMatchCard(findMen(15)), 'brk-sf');
  const sf2 = bmColumn('半决赛Y', bmMatchCard(findMen(16)), 'brk-sf');
  const finals = bmColumn('季军赛', bmMatchCard(findMen(17)), 'brk-final')
    + bmColumn('决赛', bmMatchCard(findMen(18)), 'brk-final');
  return groupCol('A', [1,3,5,7,9,11]) + groupCol('B', [2,4,6,8,10,12])
    + `<div class="bracket-round brk-powrap"><div class="bracket-round-title">附加赛 · 单场决胜</div>${po}</div>`
    + `<div class="bracket-round brk-sfwrap"><div class="bracket-round-title">半决赛 · 单场决胜</div>${sf1}${sf2}</div>`
    + `<div class="bracket-round brk-finalwrap"><div class="bracket-round-title">决赛阶段</div>${finals}</div>`;
}

// 男子赛制说明
function menBracketExplainHtml() {
  return `<div class="rule-explain">
    <div class="rule-explain-title">📖 男子组赛制说明</div>
    <div class="rule-explain-grid">
      <div><b>分组与签位</b>6 支球队抽签分为 A、B 两组各 3 队，抽签确定 A1—A3、B1—B3 号签位。</div>
      <div><b>小组赛</b>各组内进行双循环（主客各一次），每组 6 场、共 12 场。</div>
      <div><b>出线与附加赛</b>两个小组第一直接出线；两个小组第二跨组比较（积分→净胜球→进球，仍平则抽签），较高者直接出线、较低者进入附加赛；两个小组第三进行附加赛①（单场决胜，小组赛战绩优者主场），其胜者与较低小组第二进行附加赛②（单场决胜，较低小组第二主场），附加赛②胜者晋级，由此产生四强。</div>
      <div><b>半决赛</b>单场定胜负，按“避免同组重赛”落位：直接出线的小组第二与另一组小组第一对阵，第四支晋级队与剩余小组第一对阵，小组第一主场；常规时间战平直接罚球点球决胜，不设加时。</div>
      <div><b>决赛阶段</b>两场半决赛胜者进入决赛争冠军，负者进行季军赛；季军赛、决赛战平直接罚球点球决胜。</div>
      <div><b>积分与停赛</b>小组赛常规胜积3分、点球胜2分、点球负1分、常规负0分；累计3张黄牌停赛1场、直红停1场，小组赛与附加赛的黄牌累计计算，进入半决赛前各队黄牌自动清零一次。</div>
      <div><b>查看方式</b>可用右上角按钮放大缩小、平移，或用鼠标滚轮、触控板横滑；点击任意场次卡片可打开比赛详情。</div>
    </div>
  </div>`;
}

// ============ 对阵图缩放 / 平移控制器 ============
const BracketZoom = (function () {
  let scale = 1, fitScale = 1, mode = 'fit';
  let scroller, view, pct, btnIn, btnOut, btnFit, btnPrev, btnNext;
  const supportsZoom = (function () { try { return !!(window.CSS && CSS.supports && CSS.supports('zoom', '1')); } catch (e) { return false; } })();
  function els() {
    scroller = document.getElementById('bracketScroll');
    view = document.getElementById('bracketView');
    pct = document.getElementById('btZoomPct');
    btnIn = document.getElementById('btZoomIn'); btnOut = document.getElementById('btZoomOut');
    btnFit = document.getElementById('btFit'); btnPrev = document.getElementById('btPrev'); btnNext = document.getElementById('btNext');
  }
  function naturalWidth() {
    const track = view.querySelector('.bracket-track');
    if (!track) return scroller ? scroller.clientWidth - 4 : 0;
    const prevZoom = view.style.zoom; view.style.zoom = '1';
    const w = track.scrollWidth + 24;
    view.style.zoom = prevZoom || '';
    return w;
  }
  const MIN_SCALE = 0.35;
  function computeFit() {
    if (!scroller) return 1;
    const nat = naturalWidth(), cw = scroller.clientWidth - 12;
    return Math.max(MIN_SCALE, Math.min(1, cw / Math.max(nat, 1)));
  }
  function render() {
    if (!view) return;
    if (supportsZoom) { view.style.zoom = String(scale); view.style.transform = ''; }
    else { view.style.zoom = ''; view.style.transformOrigin = 'top left'; view.style.transform = 'scale(' + scale + ')'; }
    if (pct) pct.textContent = Math.round(scale * 100) + '%';
    const overflow = scroller && scroller.scrollWidth > scroller.clientWidth + 2;
    if (btnPrev) btnPrev.disabled = !overflow;
    if (btnNext) btnNext.disabled = !overflow;
    if (btnOut) btnOut.disabled = scale <= fitScale + 0.005;
    if (btnIn) btnIn.disabled = scale >= 1.55;
    if (btnFit) btnFit.classList.toggle('active', mode === 'fit');
  }
  function setScale(v, m) {
    fitScale = computeFit();
    scale = Math.max(MIN_SCALE, Math.min(1.5, Math.round(v * 100) / 100));
    mode = m || (Math.abs(scale - fitScale) < 0.011 ? 'fit' : 'manual');
    requestAnimationFrame(render);
  }
  function fit() {
    if (!scroller) return;
    setScale(computeFit(), 'fit');
    scroller.scrollLeft = 0; scroller.scrollTop = 0;
  }
  function pan(dir) { if (scroller) scroller.scrollBy({ left: dir * scroller.clientWidth * 0.85, behavior: 'smooth' }); }
  function afterRender(gender) {
    els(); if (!scroller) return;
    view.style.width = 'max-content';
    fit(); setTimeout(fit, 150); setTimeout(fit, 450);
  }
  function bind() {
    els(); if (!scroller || scroller._bzBound) return; scroller._bzBound = true;
    btnIn.addEventListener('click', () => setScale(scale + 0.1, 'manual'));
    btnOut.addEventListener('click', () => setScale(scale - 0.1, 'manual'));
    btnFit.addEventListener('click', fit);
    btnPrev.addEventListener('click', () => pan(-1));
    btnNext.addEventListener('click', () => pan(1));
    scroller.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && scroller.scrollWidth > scroller.clientWidth + 2) {
        scroller.scrollLeft += e.deltaY; e.preventDefault();
      }
    }, { passive: false });
    let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (mode === 'fit') fit(); else render(); }, 150); });
  }
  return { bind, afterRender, fit, render };
})();

async function loadBracket() {
  const container = document.getElementById('bracketView');
  const explain = document.getElementById('bracketExplain');
  if (currentGender === 'women') {
    container.innerHTML = `<div class="bracket-gender-title">🏐 女子组 · 单循环对阵图<span class="bgt-sub">5队单循环，按积分定冠亚季军</span></div>
      <div class="bracket-track">${womenBracketHtml()}</div>`;
  } else {
    container.innerHTML = `<div class="bracket-gender-title">⚽ 男子组 · 分组双循环 + 单场半决赛对阵图<span class="bgt-sub">默认整图适应屏幕，可用右上角按钮放大查看</span></div>
      <div class="bracket-track">${menBracketHtml()}</div>`;
  }
  explain.innerHTML = currentGender === 'women' ? womenBracketExplainHtml() : menBracketExplainHtml();
  BracketZoom.bind(); BracketZoom.afterRender(currentGender);
}

// 女子来源标签
function womenSourceLabel(s) { return /^[1-5]$/.test(String(s)) ? s + '号种子' : (s || '待定'); }
function womenSideName(m, side) {
  const tm = side === 1 ? m.team1 : m.team2;
  if (tm) return tm.name;
  return womenSourceLabel(side === 1 ? m.team1_source : m.team2_source);
}
// 女子单循环：按轮分列
function womenBracketHtml() {
  const byRound = {};
  genderMatches().slice().sort((a,b)=>a.match_number-b.match_number).forEach(m => {
    const r = m.round_order;
    (byRound[r] = byRound[r] || []).push(m);
  });
  return Object.keys(byRound).sort((a,b)=>a-b).map(r => {
    const cards = byRound[r].map(m => {
      const t1Win = m.status==='finished' && m.winner_id===m.team1_id;
      const t2Win = m.status==='finished' && m.winner_id===m.team2_id;
      let s1='',s2='';
      if (m.status==='finished'){ s1=`<span class="bm-score">${m.team1_score}</span>`; s2=`<span class="bm-score">${m.team2_score}</span>`; }
      const bye = m.notes ? `<div class="bm-pen bm-agg">${escapeHtml(m.notes)}</div>` : '';
      return `<div class="bracket-match ${m.status}" onclick="openMatch(${m.id})">
        <div class="bm-num">#${displayMatchNum(m)}</div>
        <div class="bm-team ${t1Win?'winner':''} ${!m.team1?'tbd':''}"><span>${womenSideName(m,1)}</span>${s1}</div>
        <div class="bm-team ${t2Win?'winner':''} ${!m.team2?'tbd':''}"><span>${womenSideName(m,2)}</span>${s2}</div>
        ${bye}
      </div>`;
    }).join('');
    return `<div class="bracket-round brk-group"><div class="bracket-round-title">第${r}轮</div>${cards}</div>`;
  }).join('');
}
function womenBracketExplainHtml() {
  return `<div class="rule-explain">
    <div class="rule-explain-title">📖 女子组赛制说明</div>
    <div class="rule-explain-grid">
      <div><b>赛制</b>5 支球队抽签确定 1—5 号签位，进行单循环，共 10 场，按最终积分排定冠、亚、季军。</div>
      <div><b>积分</b>胜一场积3分、平一场积1分、负一场积0分；比赛可出现平局。</div>
      <div><b>排名</b>依次比较 积分→相互积分→相互净胜球→相互进球→总净胜球→总进球→抽签。</div>
      <div><b>停赛</b>累计3张黄牌停赛1场、直红停1场；女子组全程黄牌不清零。每轮有一队轮空，轮空不计场次。</div>
    </div>
  </div>`;
}

// ========== 积分榜 ==========
const MEN_STANDINGS_EXPLAIN = `<div class="rule-explain">
    <div class="rule-explain-title">📖 男子组小组赛积分与排名规则</div>
    <div class="rule-explain-grid">
      <div><b>积分方法</b>小组赛不设平局：常规时间胜积 3 分、点球大战胜积 2 分、点球大战负积 1 分、常规时间负积 0 分；点球大战场次按常规时间比分（即平局）计入进球、失球与净胜球，点球决胜的罚球不计入得失球。</div>
      <div><b>出线规则</b>两个小组第一直接出线；两个小组第二跨组比较（积分→净胜球→进球，仍平抽签），较高者直接出线；较低小组第二与两个小组第三经两场单场决胜附加赛决出最后一个四强名额。</div>
      <div><b>同分排名</b>同组依次比较：积分 → 同分队相互积分 → 相互净胜球 → 相互进球 → 小组总净胜球 → 总进球 → 抽签。</div>
      <div><b>公平竞赛分</b>每张黄牌 −1、两黄变红 −3、直红 −4；本表“公平”列仅作参考，不参与排名比较。</div>
      <div><b>黄牌清零</b>累计 3 张黄牌停赛 1 场、直红停 1 场；小组赛与附加赛黄牌累计，进入半决赛前各队黄牌自动清零一次。</div>
    </div>
  </div>`;
const WOMEN_STANDINGS_EXPLAIN = `<div class="rule-explain">
    <div class="rule-explain-title">📖 女子组积分与排名规则</div>
    <div class="rule-explain-grid">
      <div><b>积分方法</b>5 队单循环：胜积 3 分、平积 1 分、负积 0 分，比赛允许平局，共 10 场。</div>
      <div><b>排名顺序</b>依次比较：积分 → 相互积分 → 相互净胜球 → 相互进球 → 总净胜球 → 总进球 → 抽签。</div>
      <div><b>名次</b>按最终积分排定冠、亚、季军；每轮一队轮空，轮空不计场次。</div>
      <div><b>停赛</b>累计 3 张黄牌停赛 1 场、直红停 1 场；女子组全程黄牌不清零。</div>
    </div>
  </div>`;

function standingsTeamCell(r) {
  return `<span class="w-team-inner"><img src="${r.logo_path || teamLogo(r.team_id)}" class="team-logo team-logo-sm"><span class="w-team-name">${escapeHtml(r.team_name) || '待定'}</span></span>`;
}
// 跨组比较两队小组赛记录：true=x更优（积分→净胜球→进球，难分id兜底，实际应抽签）
function menStandingBetter(x, y) {
  if (x.points !== y.points) return x.points > y.points;
  if (x.gd !== y.gd) return x.gd > y.gd;
  if (x.gf !== y.gf) return x.gf > y.gf;
  return x.team_id < y.team_id;
}
// 男子小组名次对应的出线标记：第1直接出线；第2跨组比较后决定；第3进附加赛
function menRowBadge(i, rows, otherRows) {
  if (i === 0) return { cls: 'w-qualify', tag: '直接出线' };
  if (i === 1 && rows.length === 3 && otherRows.length === 3) {
    return menStandingBetter(rows[1], otherRows[1])
      ? { cls: 'w-qualify', tag: '直接出线' }
      : { cls: 'w-playoff', tag: '附加赛' };
  }
  return { cls: 'w-playoff', tag: '附加赛' };
}
function menGroupTableHtml(title, rows, otherRows) {
  otherRows = otherRows || [];
  const body = rows.length ? rows.map((r, i) => {
    const b = menRowBadge(i, rows, otherRows);
    return `<tr class="${b.cls}">
    <td class="w-slot">${i + 1}</td>
    <td><div class="w-team-cell">${standingsTeamCell(r)}<span class="w-badge ${b.cls}">${b.tag}</span></div></td>
    <td class="text-center">${r.played}</td>
    <td class="text-center" style="color:var(--success);font-weight:600">${r.win}</td>
    <td class="text-center">${r.ps_win}</td>
    <td class="text-center">${r.ps_loss}</td>
    <td class="text-center" style="color:var(--danger)">${r.loss}</td>
    <td class="text-center">${r.gf}</td>
    <td class="text-center">${r.ga}</td>
    <td class="text-center">${r.gd > 0 ? '+' + r.gd : r.gd}</td>
    <td class="text-center" style="font-weight:700;color:var(--primary)">${r.points}</td>
    <td class="text-center">${r.fair}</td>
  </tr>`; }).join('') : '<tr><td colspan="12" class="empty-state">暂无数据（完成男子抽签后显示）</td></tr>';
  return `<div class="stg-group-title">⚽ ${title}（双循环）</div>
    <div class="table-wrap"><table class="wgroup-table">
    <thead><tr><th>名次</th><th>球队</th><th>赛</th><th>胜</th><th>点胜</th><th>点负</th><th>负</th><th>进</th><th>失</th><th>净</th><th>积分</th><th title="公平竞赛分，仅作参考">公平</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

async function loadStandings() {
  const table = document.getElementById('standingsTable');
  const menWrap = table.closest('.table-wrap');
  const womenWrap = document.getElementById('womenStandingsWrap');
  const explain = document.getElementById('standingsExplain');
  if (currentGender === 'women') {
    menWrap.style.display = 'none';
    womenWrap.style.display = '';
    await renderWomenStandings(document.getElementById('womenStandingsTable'));
    if (explain) explain.innerHTML = WOMEN_STANDINGS_EXPLAIN;
    return;
  }
  menWrap.style.display = '';
  const d = await fetch('/api/standings').then(r => r.json());
  menWrap.innerHTML = menGroupTableHtml('A 组积分榜', d.groupA || [], d.groupB || []) + menGroupTableHtml('B 组积分榜', d.groupB || [], d.groupA || []);
  if (currentGender === 'all') {
    womenWrap.style.display = '';
    await renderWomenStandings(document.getElementById('womenStandingsTable'));
    if (explain) explain.innerHTML = MEN_STANDINGS_EXPLAIN + WOMEN_STANDINGS_EXPLAIN;
  } else {
    womenWrap.style.display = 'none';
    if (explain) explain.innerHTML = MEN_STANDINGS_EXPLAIN;
  }
}

// 女子组积分榜（5队单循环，单表）
async function renderWomenStandings(table) {
  let d;
  try { d = await fetch('/api/standings/women').then(r => r.json()); } catch (e) { table.querySelector('tbody').innerHTML = '<tr><td colspan="11" class="empty-state">加载失败</td></tr>'; return; }
  const rows = d.table || [];
  table.querySelector('tbody').innerHTML = rows.length ? rows.map((r, i) => `<tr class="${i === 0 ? 'w-qualify' : ''}">
    <td class="w-slot">${i + 1}</td>
    <td>${standingsTeamCell(r)}</td>
    <td class="text-center">${r.played}</td>
    <td class="text-center" style="color:var(--success);font-weight:600">${r.win}</td>
    <td class="text-center">${r.draw}</td>
    <td class="text-center" style="color:var(--danger)">${r.loss}</td>
    <td class="text-center">${r.gf}</td>
    <td class="text-center">${r.ga}</td>
    <td class="text-center">${r.gd > 0 ? '+' + r.gd : r.gd}</td>
    <td class="text-center" style="font-weight:700;color:var(--primary)">${r.points}</td>
    <td class="text-center">${r.fair}</td></tr>`).join('')
    : '<tr><td colspan="11" class="empty-state">暂无数据（完成女子抽签后显示）</td></tr>';
}
async function loadWomenStandings(table) { await renderWomenStandings(table); }

// ========== 射手榜 ==========
async function loadScorers() {
  const fetchList = (g) => fetch('/api/scorers' + (g ? `?gender=${g}` : '')).then(r => r.json());
  let data, womenData = [];
  if (currentGender === 'women') data = await fetchList('women');
  else if (currentGender === 'all') { data = await fetchList('men'); womenData = await fetchList('women'); }
  else data = await fetchList('');
  // 渲染进球分布条形图（TOP8）
  const chartEl = document.getElementById('scorersChart');
  if (chartEl) {
    const top8 = data.slice(0, 8);
    const maxGoals = Math.max(...top8.map(s => s.goals), 1);
    if (top8.length) {
      chartEl.innerHTML = `
        <div style="font-weight:600;margin-bottom:12px;font-size:14px">进球分布 TOP8</div>
        ${top8.map(s => {
          const pct = (s.goals / maxGoals * 100).toFixed(0);
          return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <span style="min-width:90px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.jersey_number}号 ${escapeHtml(s.name)}</span>
            <div style="flex:1;background:#F0F4F2;border-radius:8px;height:22px;position:relative;overflow:hidden">
              <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,var(--primary),#2d7a5e);border-radius:8px;transition:width 0.6s ease;display:flex;align-items:center;justify-content:flex-end;padding-right:6px">
                <span style="color:#fff;font-size:12px;font-weight:600">${s.goals}</span>
              </div>
            </div>
            <span style="min-width:50px;font-size:12px;color:var(--text-light);text-align:right">${escapeHtml(s.team_name)}</span>
          </div>`;
        }).join('')}
        <div style="height:1px;background:var(--border-light);margin:12px 0"></div>
      `;
    } else {
      chartEl.innerHTML = '';
    }
  }
  const tbody = document.querySelector('#scorersTable tbody');
  const rowHtml = (s, i) => `<tr>
    <td class="text-center">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</td>
    <td><strong>${escapeHtml(s.name)}</strong></td>
    <td class="text-center">${s.jersey_number}</td>
    <td>${escapeHtml(s.team_name)}</td>
    <td class="text-center" style="font-weight:700;color:var(--primary);font-size:16px">${s.goals}</td>
    <td class="text-center">${s.assists || '-'}</td>
    <td class="text-center">${s.penalties}</td>
    <td class="text-center">${s.own_goals ? `<span style="color:#c62828">${s.own_goals}</span>` : '-'}</td>
    <td class="text-center">${s.mvp_count ? `<span style="color:#FFD700;font-weight:600">${s.mvp_count}</span>` : '-'}</td>
  </tr>`;
  const sep = (txt) => `<tr class="w-group-sep"><td colspan="9">${txt}</td></tr>`;
  let html = data.length ? data.map(rowHtml).join('') : '<tr><td colspan="9" class="empty-state">暂无进球数据</td></tr>';
  if (currentGender === 'all') {
    html += sep('🏐 女子组射手榜');
    html += womenData.length ? womenData.map((s, i) => rowHtml(s, i)).join('') : '<tr><td colspan="9" class="empty-state">女子组暂无进球数据</td></tr>';
  }
  tbody.innerHTML = html;
}

// ========== 最佳球员榜 ==========
async function loadMvpBoard() {
  const tbody = document.querySelector('#mvpTable tbody');
  if (!tbody) return;
  const fetchList = (g) => fetch('/api/mvp-board' + (g ? `?gender=${g}` : '')).then(r => r.json());
  let data, womenData = [];
  if (currentGender === 'women') data = await fetchList('women');
  else if (currentGender === 'all') { data = await fetchList('men'); womenData = await fetchList('women'); }
  else data = await fetchList('');
  const rowHtml = (s, i) => `<tr>
    <td class="text-center">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</td>
    <td><strong>${escapeHtml(s.name)}</strong></td>
    <td class="text-center">${s.jersey_number}</td>
    <td>${escapeHtml(s.team_name)}</td>
    <td class="text-center" style="font-weight:700;color:#e6a700;font-size:16px">${s.mvp_count}</td>
    <td class="text-center">${s.goals || '-'}</td>
    <td class="text-center">${s.assists || '-'}</td>
  </tr>`;
  let html = data.length ? data.map(rowHtml).join('') : '<tr><td colspan="7" class="empty-state">暂无最佳球员记录（完赛并评选MVP后展示）</td></tr>';
  if (currentGender === 'all') {
    html += '<tr class="w-group-sep"><td colspan="7">🏐 女子组最佳球员榜</td></tr>';
    html += womenData.length ? womenData.map(rowHtml).join('') : '<tr><td colspan="7" class="empty-state">女子组暂无最佳球员记录</td></tr>';
  }
  tbody.innerHTML = html;
}

// ========== 球队管理 ==========
async function loadTeams() {
  const grid = document.getElementById('teamsGrid');
  const teams = genderTeams();
  if (isGuest) {
    // 游客只读视图
    grid.innerHTML = teams.map(t => `
    <div class="team-edit-card">
      <div class="team-header">
        <img src="${t.logo_path || teamLogo(t.id)}" alt="队徽">
        <div><h3>${escapeHtml(t.name)}</h3></div>
      </div>
      <div style="padding:8px 0;font-size:13px;line-height:2">
        <div><strong>领队：</strong>${escapeHtml(t.leader) || '-'}</div>
        <div><strong>主教练：</strong>${escapeHtml(t.coach) || '-'}</div>
        <div><strong>队服颜色：</strong>${escapeHtml(t.jersey_color) || '-'}</div>
      </div>
    </div>`).join('');
    return;
  }
  grid.innerHTML = teams.map(t => `
    <div class="team-edit-card">
      <div class="team-header">
        <img src="${t.logo_path || teamLogo(t.id)}" alt="队徽">
        <div><h3>${escapeHtml(t.name)}</h3></div>
      </div>
      <div class="form-group"><label>球队名称</label><input id="tname_${t.id}" value="${escapeHtml(t.name)}"></div>
      <div class="form-group"><label>领队</label><input id="tleader_${t.id}" value="${escapeHtml(t.leader) || ''}"></div>
      <div class="form-group"><label>领队电话</label><input id="tleader_phone_${t.id}" value="${escapeHtml(t.leader_phone) || ''}" maxlength="20" placeholder="用于组委会联系，仅管理员可见"></div>
      <div class="form-group"><label>主教练</label><input id="tcoach_${t.id}" value="${escapeHtml(t.coach) || ''}"></div>
      <div class="form-group"><label>队服颜色</label><input id="tcolor_${t.id}" value="${escapeHtml(t.jersey_color) || ''}"></div>
      <div class="form-group">
        <label>队徽上传</label>
        <input type="file" accept=".jpg,.jpeg,.png,.gif,.webp" id="tlogo_${t.id}" onchange="uploadLogo(${t.id})">
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" onclick="saveTeam(${t.id})">保存</button>
        <button class="btn btn-danger btn-sm" onclick="deleteTeam(${t.id})">删除</button>
      </div>
    </div>
  `).join('');
}

async function saveTeam(id) {
  const data = {
    name: document.getElementById('tname_' + id).value,
    leader: document.getElementById('tleader_' + id).value,
    leader_phone: document.getElementById('tleader_phone_' + id).value,
    coach: document.getElementById('tcoach_' + id).value,
    jersey_color: document.getElementById('tcolor_' + id).value,
  };
  const res = await fetch('/api/teams/' + id, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  if (res.ok) { await loadAllData(); loadTeams(); alert('保存成功'); }
}

async function uploadLogo(id) {
  const input = document.getElementById('tlogo_' + id);
  if (!input.files[0]) return;
  const v = validateFile(input.files[0], ['.jpg', '.jpeg', '.png'], 5);
  if (!v.valid) { alert(v.msg); input.value = ''; return; }
  const fd = new FormData();
  fd.append('logo', input.files[0]);
  const res = await fetch('/api/teams/' + id + '/logo', { method: 'POST', body: fd });
  if (res.ok) { await loadAllData(); loadTeams(); }
}

// ========== 球员管理 ==========
async function loadPlayers(tabFilter) {
  const admin = isAdmin();
  // 管理员显示标签页，访客隐藏球队筛选
  if (admin) {
    document.getElementById('playerTabs').style.display = 'flex';
    document.getElementById('filterTeam').style.display = '';
  } else {
    document.getElementById('playerTabs').style.display = 'none';
    document.getElementById('filterTeam').style.display = 'none';
  }

  // 球队端：名单冻结时提示"运动员锁定、官员仍可维护、领队唯一"
  const freezeNotice = document.getElementById('rosterFrozenNotice');
  if (freezeNotice) {
    if (!admin && !isGuest) {
      try {
        const s = await fetch('/api/settings/public').then(r => r.json());
        const g = currentUser.gender === 'women' ? 'women' : 'men';
        const frozen = g === 'women' ? s.registration_frozen_women === 1 : s.registration_frozen_men === 1;
        freezeNotice.style.display = frozen ? '' : 'none';
        freezeNotice.innerHTML = frozen
          ? `🧊 <b>本${g === 'women' ? '女子' : '男子'}组名单已锁定：</b>运动员不可再增、删、改；<b>球队官员（领队 / 主教练 / 队医）仍可提交或修改</b>。每队始终只能有一名领队，如需更换，请先删除原领队。`
          : '';
      } catch (e) { freezeNotice.style.display = 'none'; }
    } else { freezeNotice.style.display = 'none'; }
  }

  const sel = document.getElementById('filterTeam');
  // 组别切换后重建球队下拉，避免混入另一组别；
  // 先保存当前选中值，重建后恢复，避免"选择学院后仍显示全部球队"
  const prevTeamId = sel.value;
  const gt = genderTeams();
  sel.innerHTML = '<option value="">全部球队</option>' + gt.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  if (prevTeamId && gt.some(t => String(t.id) === String(prevTeamId))) sel.value = prevTeamId;
  const teamId = sel.value;
  let players = genderPlayers();
  if (admin && teamId) players = players.filter(p => p.team_id == teamId);
  if (!admin && !isGuest) players = players.filter(p => p.team_id === currentUser.team_id);
  // draft标签筛选
  if (tabFilter === 'draft') players = players.filter(p => p.status === 'draft');

  // 游客模式：简化表头，隐藏敏感列和操作列
  if (isGuest) {
    const thead = document.querySelector('#playersTable thead tr');
    thead.innerHTML = '<th>球队</th><th>姓名</th><th>年龄</th><th>班级</th><th>号码</th><th>位置</th><th>备注</th>';
    const tbody = document.querySelector('#playersTable tbody');
    tbody.innerHTML = players.map(p => `<tr>
      <td>${escapeHtml(p.team_name)}</td>
      <td><strong>${escapeHtml(p.name)}</strong>${p.is_captain ? ' <span class="badge badge-captain">队长</span>' : ''}</td>
      <td>${p.age || '-'}</td><td>${escapeHtml(p.class_name) || '-'}</td>
      <td class="text-center">${p.jersey_number}</td><td>${escapeHtml(p.position) || '-'}</td>
      <td>${p.is_official ? '<span class="badge badge-pending">'+escapeHtml(p.official_role||'官员')+'</span>' : ''}</td>
    </tr>`).join('');
    return;
  }

  const tbody = document.querySelector('#playersTable tbody');
  tbody.innerHTML = players.map(p => {
    const isPending = p.status === 'pending';
    const isDraft = p.status === 'draft';
    const canEdit = admin || (!admin && p.team_id === currentUser.team_id);
    // 草稿球员缺材料提示
    let missingBadge = '';
    if (isDraft && !p.is_official) {
      const miss = [];
      if (!p.student_card_path) miss.push('学生证');
      if (!p.safety_doc_path) miss.push('责任书');
      if (!p.photo_path) miss.push('证件照');
      if (miss.length) missingBadge = ` <span class="badge" style="background:#ff9800;color:#fff;font-size:10px">缺${miss.join('/')}</span>`;
    }
    return `<tr class="${isPending ? 'row-pending' : (isDraft ? 'row-draft' : '')}">
    <td>${escapeHtml(p.team_name)}</td><td>${escapeHtml(p.student_id) || '-'}</td>

    <td><strong>${escapeHtml(p.name)}</strong>${p.is_captain ? ' <span class="badge badge-captain">队长</span>' : ''}${isPending ? ' <span class="badge badge-waiting">待审批</span>' : ''}${isDraft ? ' <span class="badge" style="background:#ff9800;color:#fff">草稿</span>' : ''}${p.reject_reason ? ` <span class="badge" style="background:#c62828;color:#fff;cursor:help" title="打回理由：${escapeHtml(p.reject_reason)}">被拒</span>` : ''}${p.withdrawn_at ? ' <span class="badge" style="background:#607d8b;color:#fff">已放弃</span>' : ''}${p.is_replacement == 1 ? ' <span class="badge" style="background:#5c6bc0;color:#fff">补录</span>' : ''}${p.withdraw_pending == 1 ? ' <span class="badge badge-waiting">弃赛审批中</span>' : ''}${missingBadge}${p.reject_reason ? ` <div style="font-size:11px;color:#c62828;margin-top:2px">打回：${escapeHtml(p.reject_reason)}</div>` : ''}</td>
    <td>${p.age || '-'}</td><td>${escapeHtml(p.class_name) || '-'}</td>
    <td>${p.height || '-'}</td><td>${p.weight || '-'}</td>
    <td class="text-center">${p.jersey_number}</td><td>${escapeHtml(p.position) || '-'}</td>
    <td>${escapeHtml(p.health) || '-'}</td><td>${escapeHtml(p.phone) || '-'}</td>
    <td>${p.is_official ? '<span class="badge badge-pending">'+escapeHtml(p.official_role||'官员')+'</span>' : ''}${p.safety_doc_path ? ' <a href="'+p.safety_doc_path+'" target="_blank" style="font-size:12px;color:var(--primary)">📄责任书</a>' : (p.is_official ? '' : ' <span style="font-size:11px;color:#c62828">⚠责任书</span>')}</td>

    <td class="no-print">
      ${(!p.is_official && p.status==='approved' && !p.withdrawn_at) ? `<button class="btn btn-sm" style="background:var(--primary-lighter);color:var(--primary)" onclick="openCredential(${p.id})">参赛证</button>` : ''}
      ${(!p.is_official && p.status==='approved' && !p.withdrawn_at && p.withdraw_pending != 1 && !admin) ? `<button class="btn btn-sm" style="background:#fff8e1;color:#8a6d3b;border:1px solid #f0e0a0" onclick="openWithdrawModal(${p.id})">弃赛</button>` : ''}
      ${canEdit && isDraft && !p.withdrawn_at ? `<button class="btn btn-sm btn-primary" onclick="submitDraftPlayer(${p.id})">提交</button>` : ''}
      ${canEdit && !p.withdrawn_at ? `<button class="btn btn-sm btn-outline" onclick="showPlayerModal(${p.id})">编辑</button>` : ''}
      ${canEdit && !p.withdrawn_at ? `<button class="btn btn-sm btn-danger" onclick="deletePlayer(${p.id})">删</button>` : ''}
      ${canEdit && p.withdrawn_at && admin ? `<button class="btn btn-sm btn-outline" onclick="restoreWithdraw(${p.id})">恢复</button>` : ''}
    </td>
  </tr>`}).join('') || '<tr><td colspan="13" style="text-align:center;padding:30px;color:#999">暂无球员数据</td></tr>';

  // 管理员加载待审批和草稿数量（按当前组别）
  if (admin) {
    refreshHiddenToggle();
    const gp = genderPlayers();
    const pendingCount = gp.filter(p => p.status === 'pending').length;
    const draftCount = gp.filter(p => p.status === 'draft').length;
    document.getElementById('pendingBadge').textContent = pendingCount;
    const draftBadge = document.getElementById('draftBadge');
    if (draftBadge) draftBadge.textContent = draftCount;
  }

  // 显示/隐藏提交审批按钮
  const submitBtn = document.getElementById('submitRosterBtn');
  if (submitBtn) {
    let draftTeamId = null;
    if (admin) {
      draftTeamId = teamId || (genderPlayers().find(p => p.status === 'draft') || {}).team_id;
    } else {
      draftTeamId = currentUser.team_id;
    }
    const hasDraft = draftTeamId && allPlayers.some(p => p.team_id == draftTeamId && p.status === 'draft');
    submitBtn.style.display = hasDraft ? '' : 'none';
    submitBtn.dataset.teamId = draftTeamId || '';
  }
}

function switchPlayerTab(tab) {
  document.querySelectorAll('.player-tab').forEach(t => t.classList.toggle('active', t.dataset.ptab === tab));
  document.getElementById('playersAllWrap').style.display = (tab === 'all' || tab === 'draft') ? '' : 'none';
  document.getElementById('playersPendingWrap').style.display = tab === 'pending' ? '' : 'none';
  if (tab === 'pending') loadPendingPlayers();
  else loadPlayers(tab);
}


async function loadPendingPlayers() {
  const res = await fetch('/api/players/pending' + (isDesigner() && showHiddenTest ? '?include_hidden=1' : ''));

  const players = await res.json();
  const tbody = document.querySelector('#playersPendingTable tbody');
  tbody.innerHTML = players.map(p => {
    const hasPendingData = p.pending_data && p.pending_data.length > 0;
    const display = hasPendingData ? safeParse(p.pending_data, p) : p;
    return `<tr class="row-pending">
    <td>${escapeHtml(p.team_name)}</td>
    <td>${escapeHtml(display.student_id) || '-'}</td>
    <td><strong>${escapeHtml(display.name)}</strong>${hasPendingData ? ' <span class="badge badge-waiting">修改</span>' : ' <span class="badge badge-waiting">新增</span>'}</td>
    <td class="text-center">${display.jersey_number || '-'}</td>
    <td>${escapeHtml(display.position) || '-'}</td>
    <td>${p.student_card_path ? (p.student_card_path.toLowerCase().endsWith('.pdf') ? `<a href="${p.student_card_path}" target="_blank" rel="noopener" style="color:var(--primary);font-size:13px">📄 打开学生证 PDF</a>` : `<img src="${p.student_card_path}" class="student-card-thumb" onclick="viewImage('${p.student_card_path}')">`) : '<span style="color:#999">无</span>'}</td>
    <td>${display.safety_doc_path ? `<a href="${display.safety_doc_path}" target="_blank" style="color:var(--primary)">📄</a>` : (display.is_official ? '<span style="color:#999">-</span>' : '<span style="color:#c62828;font-weight:600">缺</span>')}</td>
    <td>${escapeHtml(p.submitter_name) || '-'}</td>
    <td class="no-print">
      <button class="btn btn-sm btn-primary" onclick="showApproveModal(${p.id})">审批</button>
      <button class="btn btn-sm btn-danger" onclick="rejectPlayer(${p.id})">拒绝</button>
    </td>
  </tr>`
}).join('') || '<tr><td colspan="9" style="text-align:center;padding:30px;color:#999">暂无待审批球员</td></tr>';
  loadWithdrawals();
}

// ========== 弃赛申请与审批 ==========

async function loadWithdrawals() {
  const el = document.getElementById('withdrawalsTable');
  if (!el) return;
  const res = await fetch('/api/admin/withdrawals' + (isDesigner() && showHiddenTest ? '?include_hidden=1' : ''));

  if (!res.ok) return;
  const list = await res.json();
  const tbody = el.querySelector('tbody');
  tbody.innerHTML = list.map(w => `<tr class="row-pending">
    <td>${escapeHtml(w.team_name)}${w.gender==='women'?'【女】':''}</td>
    <td><strong>${escapeHtml(w.player_name)}</strong></td>
    <td class="text-center">${w.jersey_number||'-'}</td>
    <td>${escapeHtml(w.reason)||'-'}</td>
    <td>${w.doc_path ? `<a href="${w.doc_path}" target="_blank" style="color:var(--primary)">📄 查看协议书</a>` : '<span style="color:#999">无</span>'}</td>
    <td>${w.created_at||'-'}</td>
    <td class="no-print">
      <button class="btn btn-sm btn-primary" onclick="approveWithdrawal(${w.id})">同意弃赛</button>
      <button class="btn btn-sm btn-danger" onclick="rejectWithdrawal(${w.id})">驳回</button>
    </td>
  </tr>`).join('') || '<tr><td colspan="7" style="text-align:center;padding:30px;color:#999">暂无待审批的弃赛申请</td></tr>';
}
async function approveWithdrawal(id) {
  if (!confirm('确认同意该球员弃赛？\n同意后该球员不再参加后续比赛，本队可依规程补录队员（一换一，补录队员将继承其未执行完的禁赛处罚）。')) return;
  const r = await fetch('/api/admin/withdrawals/'+id+'/approve', { method: 'POST' });
  const d = await r.json();
  if (!r.ok) { alert(d.error || '操作失败'); return; }
  loadWithdrawals(); loadPlayers('pending');
}
async function rejectWithdrawal(id) {
  if (!confirm('确认驳回该弃赛申请？')) return;
  const r = await fetch('/api/admin/withdrawals/'+id+'/reject', { method: 'POST' });
  const d = await r.json();
  if (!r.ok) { alert(d.error || '操作失败'); return; }
  loadWithdrawals(); loadPlayers('pending');
}
function openWithdrawModal(pid) {
  const p = allPlayers.find(x => x.id === pid);
  if (!p) return;
  document.getElementById('genericModalTitle').textContent = '申请弃赛 - ' + p.name;
  document.getElementById('genericModalBody').innerHTML = `
    <div style="background:#fff3cd;padding:10px;border-radius:6px;font-size:13px;color:#856404;margin-bottom:12px">
      弃赛申请须上传《放弃本届赛事协议书》（球员+领队签字后拍照/扫描）。审批通过后该球员不再参加后续比赛，本队可依规程补录队员（一换一）。
    </div>
    <div class="form-group"><label>弃赛原因*</label><textarea id="wd_reason" rows="3" placeholder="如：训练中受伤，无法继续参赛"></textarea></div>
    <div class="form-group"><label>《放弃本届赛事协议书》*（jpg/png/pdf ≤5MB）</label>
      <div style="margin-bottom:6px;display:flex;align-items:center;gap:8px">
        <a href="/api/players/withdraw-template" class="btn btn-outline btn-sm" style="text-decoration:none">📄 下载协议书模板</a>
        <span style="font-size:12px;color:#999">模板为正式文书，填写后签字拍照/扫描上传</span>
      </div>
      <input type="file" id="wd_doc" accept=".jpg,.jpeg,.png,.pdf" style="padding:6px;border:1.5px solid var(--border);border-radius:6px;width:100%">
    </div>`;
  document.getElementById('genericModalFooter').innerHTML = `
    <button class="btn btn-outline" onclick="closeModal('genericModal')">取消</button>
    <button class="btn btn-primary" onclick="submitWithdraw(${pid})">提交弃赛申请</button>`;
  showModal('genericModal');
}
async function submitWithdraw(pid) {
  const reason = document.getElementById('wd_reason').value.trim();
  const fi = document.getElementById('wd_doc');
  if (!reason) { alert('请填写弃赛原因'); return; }
  if (!fi.files[0]) { alert('请上传弃赛协议书'); return; }
  const fd = new FormData(); fd.append('doc', fi.files[0]);
  const up = await fetch('/api/players/withdraw-doc', { method: 'POST', body: fd });
  const upd = await up.json();
  if (!up.ok) { alert(upd.error || '协议书上传失败'); return; }
  const r = await fetch('/api/players/'+pid+'/withdraw', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason, doc_path: upd.docPath })
  });
  const d = await r.json();
  if (!r.ok) { alert(d.error || '提交失败'); return; }
  alert(d.message || '弃赛申请已提交');
  closeModal('genericModal');
  loadPlayers();
}
async function restoreWithdraw(pid) {
  if (!confirm('特殊情况下恢复该球员参赛资格？操作将留痕。')) return;
  const r = await fetch('/api/admin/players/'+pid+'/restore-withdraw', { method: 'POST' });
  const d = await r.json();
  if (!r.ok) { alert(d.error || '操作失败'); return; }
  alert(d.message || '已恢复');
  loadPlayers();
}

function viewImage(src) {
  document.getElementById('imageModalImg').src = src;
  showModal('imageModal');
}

function showPlayerModal(id) {
  const p = id ? allPlayers.find(x => x.id === id) : null;
  const admin = isAdmin();
  const _formTeams = (() => {
    let list = genderTeams();
    if (admin && p && p.team_id && !list.some(t => t.id === p.team_id)) {
      const own = allTeams.find(t => t.id === p.team_id); if (own) list = [own, ...list];
    }
    return list;
  })();
  const teamOptions = admin
    ? _formTeams.map(t => `<option value="${t.id}" ${p&&p.team_id===t.id?'selected':''}>${t.gender==='women'?'【女】':''}${escapeHtml(t.name)}</option>`).join('')
    : allTeams.filter(t => t.id === currentUser.team_id).map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  const teamDisabled = admin ? '' : 'disabled';
  // 如果是编辑且有待审批数据，显示待审批的数据
  const display = (p && p.pending_data && p.pending_data.length > 0) ? safeParse(p.pending_data, p) : p;


  document.getElementById('genericModalTitle').textContent = id ? '编辑球员' : '添加球员';
  const withdrawnForReplace = (!admin && !id) ? allPlayers.filter(x => x.team_id === currentUser.team_id && x.withdrawn_at && !allPlayers.some(y => y.team_id === x.team_id && y.is_replacement == 1 && y.replacement_of === x.id)) : [];
  document.getElementById('genericModalBody').innerHTML = `
    ${!admin && !id && withdrawnForReplace.length ? `<div class="form-group" style="background:#fff8e1;border:1px solid #f0e0a0;border-radius:6px;padding:8px 10px;margin-bottom:12px">
      <label style="color:#8a6d3b;font-weight:600">补录（替代已弃赛球员，一换一）</label>
      <select id="p_replacement_of">
        <option value="0">不补录，正常新增球员</option>
        ${withdrawnForReplace.map(x => `<option value="${x.id}">替代：${escapeHtml(x.name)}（${x.jersey_number}号）</option>`).join('')}
      </select>
      <div style="font-size:12px;color:#8a6d3b;margin-top:4px">若选择替代弃赛球员，该球员将被标记为"补录"，并继承其未执行完的禁赛处罚（解禁后方可上场）；补录材料要求与正式球员一致。</div>
    </div>` : ''}
    <div class="form-row">
      <div class="form-group"><label>所属球队*</label><select id="p_team" ${teamDisabled} onchange="syncCollege(this.value)">${teamOptions}</select></div>
      <div class="form-group"><label>学院*</label><input id="p_college" value="" disabled></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label id="p_sid_label">学号/工号</label><input id="p_sid" value="${escapeHtml(display?.student_id)||''}" maxlength="20"></div>
    </div>
    <div id="p_player_fields">
    <div class="form-row">
      <div class="form-group"><label>姓名*</label><input id="p_name" value="${escapeHtml(display?.name)||''}" maxlength="10"></div>
      <div class="form-group"><label>年龄</label><input type="number" id="p_age" value="${display?.age||''}" min="15" max="35"></div>
      <div class="form-group"><label>班级</label><input id="p_class" value="${escapeHtml(display?.class_name)||''}" maxlength="30"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>身高(cm)</label><input type="number" id="p_height" value="${escapeHtml(display?.height)||''}" min="150" max="210"></div>
      <div class="form-group"><label>体重(kg)</label><input type="number" id="p_weight" value="${escapeHtml(display?.weight)||''}" min="40" max="150"></div>
      <div class="form-group"><label>球衣号码</label><input type="number" id="p_num" value="${escapeHtml(display?.jersey_number)||''}" min="0" max="99"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>场上位置</label>
        <select id="p_pos">
          <option value="">请选择</option>
          <option value="门将" ${display&&display.position==='门将'?'selected':''}>门将</option>
          <option value="后卫" ${display&&display.position==='后卫'?'selected':''}>后卫</option>
          <option value="中场" ${display&&display.position==='中场'?'selected':''}>中场</option>
          <option value="前锋" ${display&&display.position==='前锋'?'selected':''}>前锋</option>
        </select>
      </div>
      <div class="form-group"><label>健康状况</label><input id="p_health" value="${escapeHtml(display?.health)||''}" maxlength="50"></div>
      <div class="form-group" style="display:flex;align-items:flex-end;">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal;">
          <input type="checkbox" id="p_captain" ${display&&display.is_captain?'checked':''} style="width:16px;height:16px;">
          设为队长（每队一名）
        </label>
      </div>
    </div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>联系电话</label><input id="p_phone" value="${escapeHtml(display?.phone)||''}" maxlength="11"></div>
      <div class="form-group"><label>身份</label>
        <select id="p_official" onchange="toggleOfficialMode()">
          <option value="0" ${display&&!display.is_official?'selected':''}>球员</option>
          <option value="1" ${display&&display.is_official?'selected':''}>官员(领队/教练/队医)</option>
        </select>
      </div>
      <div class="form-group"><label>官员职务</label><input id="p_official_role" list="p_official_list" value="${escapeHtml(display?.official_role)||''}" maxlength="20" ${display&&display.is_official?'':'disabled'}>
        <datalist id="p_official_list"><option value="领队"><option value="教练"><option value="队医"><option value="其他"></datalist></div>
    </div>
    ${!admin ? `
    <div class="form-group" id="p_card_group">
      <label>学生证首页复印件*（仅支持 jpg/png/pdf，最大5MB）</label>
      <div style="margin-bottom:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <a href="/api/players/identity-template" class="btn btn-outline btn-sm" style="text-decoration:none">📄 下载《在校学生身份证明（替代学生证）》模板</a>
        <span style="font-size:12px;color:#999">若无法提供学生证/学信网截图，需签署该证明后扫描上传</span>
      </div>
      <input type="file" id="p_card" accept=".jpg,.jpeg,.png,.pdf" style="padding:6px;border:1.5px solid var(--border);border-radius:6px;width:100%">
      <input type="hidden" id="p_card_path" value="${p?.student_card_path||''}">
      ${p?.student_card_path ? `<div style="margin-top:8px">${p.student_card_path.toLowerCase().endsWith('.pdf') ? `<a href="${p.student_card_path}" target="_blank" rel="noopener" style="color:var(--primary);font-size:13px">📄 打开学生证 PDF</a>` : `<img src="${p.student_card_path}" class="student-card-thumb" onclick="viewImage('${p.student_card_path}')">`} <span style="font-size:12px;color:#999">已上传，重新选择可替换</span></div>` : ''}
      <div style="font-size:12px;color:#999;margin-top:4px">上传后需管理员审批通过才能正式加入名单</div>
      <div style="font-size:12px;color:#8a6d3b;background:#fff8e1;border:1px solid #f0e0a0;padding:6px 8px;border-radius:6px;margin-top:6px">若学生证丢失或暂时无法提供：①可上传本人学信网学籍信息截图；②或下载签署《在校学生身份证明（替代学生证）》后扫描上传</div>
    </div>` : ''}
    <div class="form-group" id="p_photo_group">
      <label>球员证件照*（jpg/png/webp，≤5MB，用于电子参赛证）</label>
      <input type="file" id="p_photo" accept=".jpg,.jpeg,.png,.webp,image/*" style="padding:6px;border:1.5px solid var(--border);border-radius:6px;width:100%">
      <input type="hidden" id="p_photo_path" value="${display?.photo_path||''}">
      ${display?.photo_path ? `<div style="margin-top:8px;display:flex;align-items:center;gap:8px"><img src="${display.photo_path}" style="width:60px;height:76px;object-fit:cover;border-radius:6px;border:1px solid var(--border)"> <span style="font-size:12px;color:#999">已上传，重新选择可替换</span></div>` : ''}
    </div>
    <div class="form-group" id="p_safety_group">
      <label>参赛安全责任书${admin ? '' : '*'}（仅支持 jpg/png/pdf，最大5MB；球队官员无需上传）</label>
      <input type="file" id="p_safety" accept=".jpg,.jpeg,.png,.pdf" style="padding:6px;border:1.5px solid var(--border);border-radius:6px;width:100%">
      <input type="hidden" id="p_safety_path" value="${p?.safety_doc_path||''}">
      ${p?.safety_doc_path ? `<div style="margin-top:8px"><a href="${p.safety_doc_path}" target="_blank" style="font-size:13px;color:var(--primary)">📄 查看已上传的安全责任书</a> <span style="font-size:12px;color:#999">重新选择可替换</span></div>` : ''}
    </div>
    ${p && p.status === 'pending' ? '<div style="background:#fff3cd;padding:10px;border-radius:6px;font-size:13px;color:#856404;margin-bottom:10px">该球员当前处于待审批状态，' + (p.pending_data ? '修改' : '新增') + '申请正在等待管理员审核</div>' : ''}
  `;
  const isDraftPlayer = p && p.status === 'draft';
  document.getElementById('genericModalFooter').innerHTML = `
    <button class="btn btn-outline" onclick="closeModal('genericModal')">取消</button>
    <button class="btn btn-primary" onclick="savePlayer(${id||0})">${admin ? '保存' : (isDraftPlayer ? '保存草稿' : '提交审批')}</button>`;
  showModal('genericModal');
  // 初始化：学院联动 + 官员模式字段显隐
  const _pt = document.getElementById('p_team');
  if (_pt) syncCollege(_pt.value);
  toggleOfficialMode();
}

// 学院联动：固定本院（球队所属学院，不可修改）；优先取球队 college 字段，为空时回退球队名（球队名即学院名，去掉 A/B 队后缀）
function collegeOfTeam(t) {
  if (!t) return '';
  if (t.college && String(t.college).trim()) return String(t.college).trim();
  return String(t.name || '').replace(/\s*[AB]队\s*$/, '');
}
function syncCollege(teamId) {
  const el = document.getElementById('p_college');
  if (!el) return;
  const t = (window.allTeams || allTeams || []).find(x => x.id === +teamId);
  el.value = collegeOfTeam(t);
}

// 官员模式：表单精简为【学院·固定本院/姓名/工号/联系电话/官员职务】，隐藏球员类字段与学生证/证件照/责任书上传
function toggleOfficialMode() {
  const off = document.getElementById('p_official');
  if (!off) return;
  const isOff = off.value == 1;
  ['p_player_fields', 'p_card_group', 'p_safety_group', 'p_photo_group'].forEach(gid => {
    const g = document.getElementById(gid);
    if (g) g.style.display = isOff ? 'none' : '';
  });
  const role = document.getElementById('p_official_role');
  if (role) role.disabled = !isOff;
  const lbl = document.getElementById('p_sid_label');
  if (lbl) lbl.textContent = isOff ? '工号' : '学号/工号';
}

async function savePlayer(id) {
  const admin = isAdmin();

  const replacementEl = document.getElementById('p_replacement_of');
  const data = {
    id: id || null,
    team_id: +document.getElementById('p_team').value,
    student_id: document.getElementById('p_sid').value.trim(),
    name: document.getElementById('p_name').value.trim(),
    age: +document.getElementById('p_age').value || 0,
    class_name: document.getElementById('p_class').value,
    height: +document.getElementById('p_height').value || 0,
    weight: +document.getElementById('p_weight').value || 0,
    jersey_number: +document.getElementById('p_num').value || 0,
    position: document.getElementById('p_pos').value,
    health: document.getElementById('p_health').value,
    phone: document.getElementById('p_phone').value,
    is_official: +document.getElementById('p_official').value,
    official_role: document.getElementById('p_official_role').value,

    is_captain: document.getElementById('p_captain').checked ? 1 : 0,
    is_replacement: replacementEl && +replacementEl.value > 0 ? 1 : 0,
    replacement_of: replacementEl ? +replacementEl.value : 0,
  };
  if (!data.name) { alert('请输入姓名'); return; }
  // D16 前端格式校验（后端仍会二次校验）
  if (data.phone && !/^\d{11}$/.test(data.phone)) { alert('联系电话必须为11位数字'); return; }
  if (!data.is_official && data.student_id && (data.student_id.length < 6 || data.student_id.length > 20)) { alert('学号/工号长度须为6-20位'); return; }
  if (!data.is_official) {
    if (data.age && (data.age < 15 || data.age > 35)) { alert('年龄须在15-35岁之间'); return; }
    if (data.height && (data.height < 150 || data.height > 210)) { alert('身高须在150-210cm之间'); return; }
    if (data.weight && (data.weight < 40 || data.weight > 150)) { alert('体重须在40-150kg之间'); return; }
  }

  // 证件照上传（非官员必填；草稿可暂存已有）
  const isDraftSave = id && allPlayers.find(x => x.id === id && x.status === 'draft');
  if (!data.is_official) {
    const photoInput = document.getElementById('p_photo');
    const photoPathInput = document.getElementById('p_photo_path');
    if (photoInput && photoInput.files.length > 0) {
      const v = validateFile(photoInput.files[0], ['.jpg', '.jpeg', '.png', '.webp'], 5);
      if (!v.valid) { alert(v.msg); return; }
      const fd = new FormData(); fd.append('photo', photoInput.files[0]);
      const up = await fetch('/api/players/photo', { method: 'POST', body: fd });
      const ud = await up.json().catch(()=>({}));
      if (!up.ok) { alert(ud.error || '证件照上传失败'); return; }
      data.photo_path = ud.photoPath;
    } else if (photoPathInput && photoPathInput.value) {
      data.photo_path = photoPathInput.value;
    } else if (!isDraftSave) {
      alert('请上传球员证件照'); return;
    }
  }

  if (!admin && !data.is_official) {
    // 访客：先上传学生证图片（编辑草稿时可暂存）；官员无需上传
    const cardInput = document.getElementById('p_card');
    const cardPathInput = document.getElementById('p_card_path');
    const editingDraftCard = id && allPlayers.find(x => x.id === id && x.status === 'draft');
    if (cardInput && cardInput.files.length > 0) {
      const v = validateFile(cardInput.files[0], ['.jpg', '.jpeg', '.png', '.pdf'], 5);
      if (!v.valid) { alert(v.msg); return; }
      const formData = new FormData();
      formData.append('card', cardInput.files[0]);
      const uploadRes = await fetch('/api/players/student-card', { method: 'POST', body: formData });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) { alert(uploadData.error || '学生证上传失败'); return; }
      data.student_card_path = uploadData.cardPath;
    } else if (cardPathInput && cardPathInput.value) {
      data.student_card_path = cardPathInput.value;
    } else if (!editingDraftCard) {
      alert('请上传学生证首页复印件'); return;
    }
    // 访客：上传安全责任书（非官员必填，但编辑草稿时可暂存）
    const editingDraft = id && allPlayers.find(x => x.id === id && x.status === 'draft');
    if (!data.is_official && !editingDraft) {
      const safetyInput = document.getElementById('p_safety');
      const safetyPathInput = document.getElementById('p_safety_path');
      if (safetyInput && safetyInput.files.length > 0) {
        const v = validateFile(safetyInput.files[0], ['.jpg', '.jpeg', '.png', '.pdf'], 5);
        if (!v.valid) { alert(v.msg); return; }
        const formData = new FormData();
        formData.append('doc', safetyInput.files[0]);
        const uploadRes = await fetch('/api/players/safety-doc', { method: 'POST', body: formData });
        const uploadData = await uploadRes.json();
        if (!uploadRes.ok) { alert(uploadData.error || '安全责任书上传失败'); return; }
        data.safety_doc_path = uploadData.docPath;
      } else if (safetyPathInput && safetyPathInput.value) {
        data.safety_doc_path = safetyPathInput.value;
      } else {
        alert('请上传参赛安全责任书'); return;
      }
    } else if (!data.is_official && editingDraft) {
      // 编辑草稿：有文件就上传，没有就用已有的
      const safetyInput = document.getElementById('p_safety');
      const safetyPathInput = document.getElementById('p_safety_path');
      if (safetyInput && safetyInput.files.length > 0) {
        const v = validateFile(safetyInput.files[0], ['.jpg', '.jpeg', '.png', '.pdf'], 5);
        if (!v.valid) { alert(v.msg); return; }
        const formData = new FormData();
        formData.append('doc', safetyInput.files[0]);
        const uploadRes = await fetch('/api/players/safety-doc', { method: 'POST', body: formData });
        const uploadData = await uploadRes.json();
        if (!uploadRes.ok) { alert(uploadData.error || '安全责任书上传失败'); return; }
        data.safety_doc_path = uploadData.docPath;
      } else if (safetyPathInput && safetyPathInput.value) {
        data.safety_doc_path = safetyPathInput.value;
      }
    }
    // 访客调用submit API
    const res = await fetch('/api/players/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await res.json();
    if (res.ok) {
      alert(result.message || '提交成功，等待管理员审批');
      closeModal('genericModal');
      await loadAllData(); loadPlayers(document.querySelector('.player-tab.active')?.dataset?.ptab);
    } else {
      alert(result.error || '提交失败，请检查输入');
    }
  } else {
    // 管理员：上传安全责任书（如果有选择文件）
    const safetyInput = document.getElementById('p_safety');
    const safetyPathInput = document.getElementById('p_safety_path');
    if (safetyInput && safetyInput.files.length > 0) {
      const v = validateFile(safetyInput.files[0], ['.jpg', '.jpeg', '.png', '.pdf'], 5);
      if (!v.valid) { alert(v.msg); return; }
      const formData = new FormData();
      formData.append('doc', safetyInput.files[0]);
      const uploadRes = await fetch('/api/players/safety-doc', { method: 'POST', body: formData });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) { alert(uploadData.error || '安全责任书上传失败'); return; }
      data.safety_doc_path = uploadData.docPath;
    } else if (safetyPathInput && safetyPathInput.value) {
      data.safety_doc_path = safetyPathInput.value;
    }
    // 管理员调用原有API
    const url = id ? '/api/players/' + id : '/api/players';
    const method = id ? 'PUT' : 'POST';
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (res.ok) { closeModal('genericModal'); await loadAllData(); loadPlayers(); }
    else {
      const err = await res.json().catch(() => ({}));
      alert(err.error || '保存失败，请检查输入');
    }
  }
}

async function deletePlayer(id) {
  confirmDialog('确定删除该球员？', async () => {
    await fetch('/api/players/' + id, { method: 'DELETE' });
    await loadAllData(); loadPlayers();
  }, '🗑️');
}

// 单个草稿球员提交审批（批量导入后逐人提交）
async function submitDraftPlayer(id) {
  const p = allPlayers.find(x => x.id === id);
  if (!p) return;
  if (p.status !== 'draft') { alert('该球员不是草稿状态'); return; }
  confirmDialog(`确定提交「${p.name}」等待审批？\n提交后管理员将收到审批通知。`, async () => {
    const res = await fetch('/api/players/' + id + '/submit-draft', { method: 'POST' });
    const result = await res.json();
    if (res.ok) {
      alert('已提交，等待管理员审批');
      await loadAllData(); loadPlayers();
    } else {
      alert(result.error || '提交失败');
    }
  }, '📤');
}

// 审批模态框
function showApproveModal(id) {
  const p = allPlayers.find(x => x.id === id);
  if (!p) return;
  const hasPendingData = p.pending_data && p.pending_data.length > 0;
  const display = hasPendingData ? safeParse(p.pending_data, p) : p;
  const _apTeams = (() => { let l = genderTeams(); if (!l.some(t => t.id === p.team_id)) { const o = allTeams.find(t => t.id === p.team_id); if (o) l = [o, ...l]; } return l; })();
  const teamOptions = _apTeams.map(t => `<option value="${t.id}" ${p.team_id===t.id?'selected':''}>${t.gender==='women'?'【女】':''}${escapeHtml(t.name)}</option>`).join('');

  document.getElementById('genericModalTitle').textContent = hasPendingData ? '审批 - 修改球员' : '审批 - 新增球员';
  document.getElementById('genericModalBody').innerHTML = `
    <div style="background:#fff3cd;padding:10px;border-radius:6px;font-size:13px;color:#856404;margin-bottom:15px">
      ${hasPendingData ? '该球员申请修改信息，原信息已保留，审批通过后将更新为以下内容' : '该球员为新增申请，审批通过后将正式加入名单'}
      ${p.submitted_by ? `，提交人：${escapeHtml(p.submitter_name) || '未知'}` : ''}
    </div>
    ${p.student_card_path ? `
    <div class="form-group">
      <label>学生证复印件</label>
      <div>${p.student_card_path.toLowerCase().endsWith('.pdf') ? `<a href="${p.student_card_path}" target="_blank" rel="noopener" style="color:var(--primary);font-size:13px">📄 点击打开学生证 PDF</a>` : `<img src="${p.student_card_path}" class="student-card-thumb" style="width:120px;height:80px" onclick="viewImage('${p.student_card_path}')"> <span style="font-size:12px;color:#999;cursor:pointer" onclick="viewImage('${p.student_card_path}')">点击放大</span>`}</div>
    </div>` : ''}
    ${display.safety_doc_path ? `
    <div class="form-group">
      <label>参赛安全责任书</label>
      <div><a href="${display.safety_doc_path}" target="_blank" style="font-size:13px;color:var(--primary)">📄 点击查看安全责任书</a></div>
    </div>` : (!display.is_official ? '<div style="background:#f8d7da;padding:8px;border-radius:6px;font-size:12px;color:#721c24;margin-bottom:10px">⚠ 该球员未上传安全责任书</div>' : '')}
    ${display.photo_path ? `
    <div class="form-group">
      <label>球员证件照</label>
      <div><img src="${display.photo_path}" style="width:72px;height:92px;object-fit:cover;border-radius:6px;border:1px solid var(--border)" onclick="viewImage('${display.photo_path}')"> <span style="font-size:12px;color:#999;cursor:pointer" onclick="viewImage('${display.photo_path}')">点击放大</span></div>
    </div>` : (!display.is_official ? '<div style="background:#f8d7da;padding:8px;border-radius:6px;font-size:12px;color:#721c24;margin-bottom:10px">⚠ 该球员未上传证件照</div>' : '')}
    <div class="form-row">
      <div class="form-group"><label>所属球队*</label><select id="a_team" onchange="syncApproveCollege(this.value)">${teamOptions}</select></div>
      <div class="form-group"><label>学院*</label><input id="a_college" value="${escapeHtml(collegeOfTeam(allTeams.find(t=>t.id===p.team_id)))}" disabled></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label id="a_sid_label">学号/工号</label><input id="a_sid" value="${escapeHtml(display.student_id)||''}"></div>
    </div>
    <div id="a_player_fields">
    <div class="form-row">
      <div class="form-group"><label>姓名*</label><input id="a_name" value="${escapeHtml(display.name)||''}"></div>
      <div class="form-group"><label>年龄</label><input type="number" id="a_age" value="${display.age||''}"></div>
      <div class="form-group"><label>班级</label><input id="a_class" value="${escapeHtml(display.class_name)||''}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>身高(cm)</label><input type="number" id="a_height" value="${escapeHtml(display.height)||''}"></div>
      <div class="form-group"><label>体重(kg)</label><input type="number" id="a_weight" value="${escapeHtml(display.weight)||''}"></div>
      <div class="form-group"><label>球衣号码</label><input type="number" id="a_num" value="${escapeHtml(display.jersey_number)||''}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>场上位置</label>
        <select id="a_pos">
          <option value="">请选择</option>
          <option value="门将" ${display.position==='门将'?'selected':''}>门将</option>
          <option value="后卫" ${display.position==='后卫'?'selected':''}>后卫</option>
          <option value="中场" ${display.position==='中场'?'selected':''}>中场</option>
          <option value="前锋" ${display.position==='前锋'?'selected':''}>前锋</option>
        </select>
      </div>
      <div class="form-group"><label>健康状况</label><input id="a_health" value="${escapeHtml(display.health)||''}"></div>
      <div class="form-group" style="display:flex;align-items:flex-end;">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal;">
          <input type="checkbox" id="a_captain" ${display.is_captain?'checked':''} style="width:16px;height:16px;">
          设为队长
        </label>
      </div>
    </div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>联系电话</label><input id="a_phone" value="${escapeHtml(display.phone)||''}"></div>
      <div class="form-group"><label>身份</label>
        <select id="a_official" onchange="toggleApproveOfficialMode()">
          <option value="0" ${!display.is_official?'selected':''}>球员</option>
          <option value="1" ${display.is_official?'selected':''}>官员</option>
        </select>
      </div>
      <div class="form-group"><label>官员职务</label><input id="a_official_role" list="a_official_list" value="${escapeHtml(display.official_role)||''}" ${display.is_official?'':'disabled'}>
        <datalist id="a_official_list"><option value="领队"><option value="教练"><option value="队医"><option value="其他"></datalist></div>
    </div>
  `;
  document.getElementById('genericModalFooter').innerHTML = `
    <button class="btn btn-outline" onclick="closeModal('genericModal')">取消</button>
    <button class="btn btn-danger" onclick="closeModal('genericModal');rejectPlayer(${id})">拒绝</button>
    <button class="btn btn-primary" onclick="approvePlayer(${id})">通过</button>`;
  showModal('genericModal');
  toggleApproveOfficialMode();
}

// 审批弹窗：学院联动
function syncApproveCollege(teamId) {
  const el = document.getElementById('a_college');
  if (!el) return;
  const t = (window.allTeams || allTeams || []).find(x => x.id === +teamId);
  el.value = collegeOfTeam(t);
}

// 审批弹窗：官员模式精简显示（隐藏球员类字段）
function toggleApproveOfficialMode() {
  const off = document.getElementById('a_official');
  if (!off) return;
  const isOff = off.value == 1;
  const pf = document.getElementById('a_player_fields');
  if (pf) pf.style.display = isOff ? 'none' : '';
  const role = document.getElementById('a_official_role');
  if (role) role.disabled = !isOff;
  const lbl = document.getElementById('a_sid_label');
  if (lbl) lbl.textContent = isOff ? '工号' : '学号/工号';
}

async function approvePlayer(id) {
  const p = allPlayers.find(x => x.id === id);
  const hasPendingData = p && p.pending_data && p.pending_data.length > 0;
  const pendingDisplay = hasPendingData ? safeParse(p.pending_data, p) : p;
  const data = {
    student_id: document.getElementById('a_sid').value.trim(),
    name: document.getElementById('a_name').value.trim(),
    age: +document.getElementById('a_age').value || 0,
    class_name: document.getElementById('a_class').value,
    height: +document.getElementById('a_height').value || 0,
    weight: +document.getElementById('a_weight').value || 0,
    jersey_number: +document.getElementById('a_num').value || 0,
    position: document.getElementById('a_pos').value,
    health: document.getElementById('a_health').value,
    phone: document.getElementById('a_phone').value,
    is_official: +document.getElementById('a_official').value,
    official_role: document.getElementById('a_official_role').value,
    is_captain: document.getElementById('a_captain').checked ? 1 : 0,
    student_card_path: pendingDisplay?.student_card_path || p?.student_card_path || '',
    safety_doc_path: pendingDisplay?.safety_doc_path || p?.safety_doc_path || '',
    photo_path: pendingDisplay?.photo_path || p?.photo_path || '',
  };
  if (!data.is_official && !data.photo_path) { alert('该球员缺少证件照，无法审批通过'); return; }
  if (!data.name) { alert('请输入姓名'); return; }
  if (data.phone && !/^\d{11}$/.test(data.phone)) { alert('联系电话必须为11位数字'); return; }
  if (!data.is_official && data.student_id && (data.student_id.length < 6 || data.student_id.length > 20)) { alert('学号/工号长度须为6-20位'); return; }
  if (!data.is_official) {
    if (data.age && (data.age < 15 || data.age > 35)) { alert('年龄须在15-35岁之间'); return; }
    if (data.height && (data.height < 150 || data.height > 210)) { alert('身高须在150-210cm之间'); return; }
    if (data.weight && (data.weight < 40 || data.weight > 150)) { alert('体重须在40-150kg之间'); return; }
  }
  const res = await fetch('/api/players/' + id + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await res.json();
  if (res.ok) {
    alert('审批通过');
    closeModal('genericModal');
    await loadAllData(); loadPlayers(); loadPendingPlayers();
  } else {
    alert(result.error || '审批失败');
  }
}

// 打回球员：弹窗填写必填理由
function openRejectModal(id) {
  const p = allPlayers.find(x => x.id === id);
  if (!p) return;
  const hasPendingData = p.pending_data && p.pending_data.length > 0;
  const display = hasPendingData ? safeParse(p.pending_data, p) : p;
  document.getElementById('genericModalTitle').textContent = hasPendingData ? '打回 - 修改球员' : '打回 - 新增球员';
  document.getElementById('genericModalBody').innerHTML = `
    <div style="background:#fff3cd;padding:10px;border-radius:6px;font-size:13px;color:#856404;margin-bottom:15px">
      ${hasPendingData
        ? `球员「${escapeHtml(display.name)}」申请修改信息，打回后将<strong>取消本次修改、恢复原状态</strong>，并通知球队打回理由。`
        : `球员「${escapeHtml(display.name)}」为新增申请，打回后将<strong>退回草稿（不删除）</strong>，球队可修改后重新提交。`}
    </div>
    <div class="form-group">
      <label>打回理由 <span style="color:#c62828">*</span></label>
      <textarea id="rejectReasonInput" rows="3" maxlength="200" placeholder="请填写打回理由（必填，将通知给该队球队管理员）" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;resize:vertical"></textarea>
      <div style="font-size:12px;color:#999;margin-top:4px" id="rejectReasonCount">0 / 200</div>
    </div>`;
  document.getElementById('rejectReasonInput').addEventListener('input', function () {
    document.getElementById('rejectReasonCount').textContent = this.value.length + ' / 200';
  });
  document.getElementById('genericModalFooter').innerHTML = `
    <button class="btn btn-outline" onclick="closeModal('genericModal')">取消</button>
    <button class="btn btn-danger" onclick="doRejectPlayer(${id})">确认打回</button>`;
  showModal('genericModal');
}

async function doRejectPlayer(id) {
  const reason = document.getElementById('rejectReasonInput').value.trim();
  if (!reason) { alert('请填写打回理由（必填）'); return; }
  const res = await fetch('/api/players/' + id + '/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
  const result = await res.json();
  if (res.ok) {
    alert('已打回并通知球队');
    closeModal('genericModal');
    await loadAllData(); loadPlayers();
    if (document.getElementById('playersPendingWrap').style.display !== 'none') loadPendingPlayers();
  } else {
    alert(result.error || '操作失败');
  }
}

async function rejectPlayer(id) {
  openRejectModal(id);
}

// ========== 裁判管理 ==========
const REF_TYPE_LABELS = { main: '专职主裁判', assistant: '专职助理裁判', fourth: '专职第四官员' };
const REF_TYPE_BADGE = { main: 'background:#1A4D3A', assistant: 'background:#2D6B52', fourth: 'background:#C8A45C' };
// 兼容旧数据：ref_type 为空时按旧勾选推导
function refSpec(r) {
  if (r.ref_type) return r.ref_type;
  if (r.is_main_ref) return 'main';
  if (r.is_assistant_ref) return 'assistant';
  return '';
}
// 某裁判能否担任指定岗位：通用（无专职）任意岗位都可，专职只能对应岗位
function canFillPosition(r, type) {
  const s = refSpec(r);
  return !s || s === type;
}
function downloadFairPlayTemplate() {
  window.open('/api/referees/fair-play-template', '_blank');
}

async function loadReferees() {
  const tbody = document.querySelector('#refereesTable tbody');
  tbody.innerHTML = allReferees.map(r => {
    const locked = r.locked_until && new Date(r.locked_until.replace(' ','T')) > new Date();
    const acct = r.account ? `<code style="font-size:12px">${r.account}</code>${locked?' <span class="badge" style="background:#c62828;color:#fff">锁定</span>':(r.must_change_password?' <span class="badge badge-pending">待改密</span>':'')}` : '<span style="color:#bbb">无</span>';
    const spec = refSpec(r);
    const specBadge = spec
      ? `<span class="badge" style="color:#fff;${REF_TYPE_BADGE[spec]||''}">${REF_TYPE_LABELS[spec]||spec}</span>`
      : '<span class="badge" style="background:#E8EEEC;color:#456">通用裁判</span>';
    const fp = r.fair_play_path
      ? `<a href="${r.fair_play_path}" target="_blank" style="font-size:12px">查看</a>`
      : '<span style="color:#e74c3c;font-size:12px">缺</span>';
    return `<tr>
    <td>${escapeHtml(r.serial_number)}</td><td><strong>${escapeHtml(r.name)}</strong></td>
    <td>${escapeHtml(r.college) || '-'}</td><td>${escapeHtml(r.student_id) || '-'}</td><td>${escapeHtml(r.phone) || '-'}</td>
    <td>${r.level || '-'}</td>
    <td>${specBadge}</td>
    <td class="text-center">${fp}</td>
    <td>${acct}</td>
    <td class="no-print">
      ${isAdmin() ? `<button class="btn btn-sm btn-outline" onclick="openRefereeCredential(${r.id})">裁判证</button>
      <button class="btn btn-sm btn-outline" onclick="openRefProfile(${r.id})">档案</button>
      <button class="btn btn-sm btn-outline" onclick="showRefereeModal(${r.id})">编辑</button>
      ${r.user_id ? `<button class="btn btn-sm btn-outline" onclick="resetRefereePwd(${r.user_id},'${r.account}')">重置密码</button>` : ''}
      <button class="btn btn-sm btn-danger" onclick="deleteReferee(${r.id})">删</button>` : ''}
    </td>
  </tr>`;
  }).join('');
}

let refFairPlayPath = ''; // 裁判弹窗内已上传承诺书路径
function showRefereeModal(id) {
  const r = id ? allReferees.find(x => x.id === id) : null;
  refFairPlayPath = r?.fair_play_path || '';
  const curSpec = refSpec(r || {});
  document.getElementById('genericModalTitle').textContent = id ? '编辑裁判' : '添加裁判';
  document.getElementById('genericModalBody').innerHTML = `
    <div class="form-row">
      <div class="form-group"><label>序号*</label><input id="r_sn" value="${escapeHtml(r?.serial_number)||''}" maxlength="20"></div>
      <div class="form-group"><label>姓名*</label><input id="r_name" value="${escapeHtml(r?.name)||''}" maxlength="20"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>所在学院</label><input id="r_college" value="${escapeHtml(r?.college)||''}" maxlength="40"></div>
      <div class="form-group"><label>学号/工号</label><input id="r_sid" value="${escapeHtml(r?.student_id)||''}" maxlength="20"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>联系电话</label><input id="r_phone" value="${escapeHtml(r?.phone)||''}" maxlength="11"></div>
      <div class="form-group"><label>裁判等级</label>
        <select id="r_level">
          ${['一级','二级','三级','四级'].map(l => `<option ${r&&r.level===l?'selected':''}>${l}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-group">
      <label>专职岗位（可选，不选为“通用裁判”，可担任所有位置）</label>
      <div style="display:flex;gap:22px;padding:6px 2px;flex-wrap:wrap">
        ${[['','通用裁判（可吹所有位置）'],['main','专职主裁判'],['assistant','专职助理裁判'],['fourth','专职第四官员']].map(([v,t])=>`
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap">
            <input type="radio" name="r_type" value="${v}" ${curSpec===v?'checked':''}> ${t}
          </label>`).join('')}
      </div>
<small style="color:var(--text-light);font-size:12px">选择专职后只能被指派到对应位置（专职助理可任助理1/助理2）；不选即为通用裁判，主裁/助理/第四官员均可担任。</small>
    </div>
    <div class="form-group">
      <label>公平竞赛承诺书*（已签署图片，jpg/png）</label>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <input type="file" id="r_fairplay" accept="image/jpeg,image/png" style="max-width:260px" onchange="uploadRefFairPlay(this)">
        <button type="button" class="btn btn-outline btn-sm" onclick="downloadFairPlayTemplate()">下载模板</button>
        <span id="r_fairplay_status" style="font-size:12px"></span>
      </div>
      <div id="r_fairplay_preview" style="margin-top:8px"></div>
    </div>
  `;
  // 回显已上传承诺书
  renderRefFairPlayPreview();
  document.getElementById('genericModalFooter').innerHTML = `
    <button class="btn btn-outline" onclick="closeModal('genericModal')">取消</button>
    <button class="btn btn-primary" onclick="saveReferee(${id||0})">保存</button>`;
  showModal('genericModal');
}

function renderRefFairPlayPreview() {
  const box = document.getElementById('r_fairplay_preview');
  const status = document.getElementById('r_fairplay_status');
  if (!box) return;
  if (refFairPlayPath) {
    box.innerHTML = `<a href="${refFairPlayPath}" target="_blank"><img src="${refFairPlayPath}" alt="公平竞赛承诺书" style="max-height:120px;border:1px solid var(--border);border-radius:8px"></a>`;
    if (status) { status.textContent = '✓ 已上传'; status.style.color = '#1A4D3A'; }
  } else {
    box.innerHTML = '';
    if (status) { status.textContent = '尚未上传'; status.style.color = '#e74c3c'; }
  }
}

async function uploadRefFairPlay(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (!['image/jpeg', 'image/png'].includes(file.type)) { alert('承诺书只支持 jpg/png 图片'); input.value = ''; return; }
  if (file.size > 5 * 1024 * 1024) { alert('图片不能超过 5MB'); input.value = ''; return; }
  const status = document.getElementById('r_fairplay_status');
  if (status) { status.textContent = '上传中…'; status.style.color = ''; }
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/referees/fair-play', { method: 'POST', body: fd });
  const out = await res.json().catch(() => ({}));
  if (res.ok) {
    refFairPlayPath = out.path;
    renderRefFairPlayPreview();
  } else {
    alert(out.error || '承诺书上传失败');
    if (status) { status.textContent = '上传失败'; status.style.color = '#e74c3c'; }
  }
}

async function saveReferee(id) {
  const typeEl = document.querySelector('input[name="r_type"]:checked');
  const ref_type = typeEl ? typeEl.value : '';
  const data = {
    serial_number: document.getElementById('r_sn').value.trim(),
    name: document.getElementById('r_name').value.trim(),
    college: document.getElementById('r_college').value,
    student_id: document.getElementById('r_sid').value,
    phone: document.getElementById('r_phone').value,
    level: document.getElementById('r_level').value,
    ref_type,
    fair_play_path: refFairPlayPath,
  };
  if (!data.serial_number || !data.name) { alert('请填写序号和姓名'); return; }
  if (!data.fair_play_path) { alert('请上传已签署的公平竞赛承诺书图片'); return; }
  if (data.phone && !/^\d{11}$/.test(data.phone)) { alert('联系电话必须为11位数字'); return; }
  const url = id ? '/api/referees/' + id : '/api/referees';
  const method = id ? 'PUT' : 'POST';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const out = await res.json().catch(()=>({}));
  if (res.ok) {
    closeModal('genericModal'); await loadAllData(); loadReferees();
    if (!id && out.username) showRefereeCredentials(out.username, out.password, data.name);
  } else { alert(out.error || '保存失败'); }
}

// 展示新裁判的初始账号密码（仅显示一次）
function showRefereeCredentials(username, password, name) {
  document.getElementById('genericModalTitle').textContent = '裁判账号已创建';
  document.getElementById('genericModalBody').innerHTML = `
    <p style="font-size:13px;color:var(--text-light);margin-bottom:12px">裁判 <strong>${name}</strong> 的登录账号已自动生成，初始密码仅显示一次，请妥善抄送给本人，首次登录需修改密码。</p>
    <div style="background:var(--primary-lighter);border:1px dashed var(--primary);border-radius:10px;padding:16px;font-size:15px;line-height:2;text-align:center">
      <div>登录账号：<strong style="font-size:18px">${username}</strong></div>
      <div>初始密码：<strong style="font-size:18px;letter-spacing:1px">${password}</strong></div>
    </div>
    <p style="font-size:12px;color:var(--text-light);margin-top:10px">登录入口：欢迎页右上角“裁判员入口”。密码规则：8-16位，须同时含字母和数字。</p>`;
  document.getElementById('genericModalFooter').innerHTML = `
    <button class="btn btn-outline" onclick="copyText('${username} ${password}')">复制账号密码</button>
    <button class="btn btn-primary" onclick="closeModal('genericModal')">我已记录</button>`;
  showModal('genericModal');
}

function copyText(t) { navigator.clipboard?.writeText(t); alert('已复制：' + t); }

// 管理员为裁判重置密码（随机）
async function resetRefereePwd(userId, account) {
  const res = await fetch('/api/auth/reset-visitor-password', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ userId })
  });
  const d = await res.json().catch(()=>({}));
  if (!res.ok) { alert(d.error||'重置失败'); return; }
  await loadAllData(); loadReferees();
  document.getElementById('genericModalTitle').textContent = '密码已重置';
  document.getElementById('genericModalBody').innerHTML = `
    <p style="font-size:13px;color:var(--text-light);margin-bottom:10px">裁判账号 <strong>${account}</strong> 的新密码（仅显示一次）：</p>
    <div style="background:var(--primary-lighter);border:1px dashed var(--primary);border-radius:10px;padding:14px;text-align:center;font-size:18px;font-weight:700;letter-spacing:1px">${d.password}</div>`;
  document.getElementById('genericModalFooter').innerHTML = `
    <button class="btn btn-outline" onclick="copyText('${d.password}')">复制密码</button>
    <button class="btn btn-primary" onclick="closeModal('genericModal')">完成</button>`;
  showModal('genericModal');
}

async function deleteReferee(id) {
  confirmDialog('确定删除该裁判？', async () => {
    await fetch('/api/referees/' + id, { method: 'DELETE' });
    await loadAllData(); loadReferees();
  }, '🗑️');
}

// ========== 裁判员：我的执法 ==========
let myMatchesCache = [];
let refReportState = null;

const CARD_YELLOW_REASONS = ['非体育行为','延误比赛恢复','持续违反规则','对判罚表示异议','不退规定距离','未经允许进入/重新入场','未经允许离场'];
const CARD_RED_REASONS = ['严重犯规','暴力行为','向他人吐唾沫','故意手球破坏明显进球','犯规破坏明显进球机会','使用攻击性/侮辱性语言','两黄变一红'];

// ========== 赛事裁判员申请（免登录申请 + 查询/撤回 + 管理员审批）==========
let raState = { lastRemaining: null };

function loadRefereeApp() {
  const box = document.getElementById('page-referee-app');
  box.innerHTML = `
  <div class="card">
    <div class="card-header"><div class="card-title">🧑‍⚖️ 赛事裁判员申请</div></div>
    <div style="padding:18px 22px">
      <div style="background:var(--primary-lighter,#E8F0EC);border:1px solid #cfe3d8;border-radius:10px;padding:12px 16px;font-size:13px;line-height:1.9;color:#1f2937;margin-bottom:18px">
        <b>申请说明</b><br>
        ① 沈阳城市学院在校学生均可申请（含已报名参赛的球员）；<br>
        ② 需上传：<b>本人证件照、学生证或学信网学籍信息截图、已签署的公平竞赛承诺书</b>；<br>
        ③ 同一学号每天最多提交 <b>3 次</b>（提交即计数，含被拒/撤回），次日 00:00 重置；<br>
        ④ 管理员审批时评定裁判等级（一级~四级）；审批通过后自动生成裁判账号并加入裁判队伍，账号密码由组委会线下告知；<br>
        ⑤ 提交后、审批前可自行撤回（计入当日次数）。裁判等级由组委会评定，无需填写。
      </div>
      <div class="form-row">
        <div class="form-group"><label>姓名 *</label><input id="ra_name" maxlength="20"></div>
        <div class="form-group"><label>性别</label>
          <select id="ra_gender"><option value="men">男</option><option value="women">女</option></select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>所在学院 *</label><input id="ra_college" maxlength="40"></div>
        <div class="form-group"><label>学号 *</label><input id="ra_sid" maxlength="20"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>联系电话（11位手机号）*</label><input id="ra_phone" maxlength="11"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>证件照 *（jpg/png，用于裁判证）</label>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <input type="file" id="ra_photo" accept="image/jpeg,image/png,image/webp" onchange="uploadRaPhoto(this)" style="max-width:260px">
            <span id="ra_photo_status" style="font-size:12px"></span>
          </div>
          <div id="ra_photo_preview" style="margin-top:8px"></div>
        </div>
        <div class="form-group"><label>学生证或学信网学籍信息截图 *</label>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <input type="file" id="ra_proof" accept="image/jpeg,image/png,application/pdf" onchange="uploadRaProof(this)" style="max-width:260px">
            <span id="ra_proof_status" style="font-size:12px"></span>
          </div>
          <div id="ra_proof_preview" style="margin-top:8px"></div>
        </div>
      </div>
      <div class="form-group">
        <label>公平竞赛承诺书 *（已签署图片）</label>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <input type="file" id="ra_fairplay" accept="image/jpeg,image/png" onchange="uploadRaFairPlay(this)" style="max-width:260px">
          <button type="button" class="btn btn-outline btn-sm" onclick="downloadFairPlayTemplate()">下载模板</button>
          <span id="ra_fairplay_status" style="font-size:12px"></span>
        </div>
        <div id="ra_fairplay_preview" style="margin-top:8px"></div>
      </div>
      <div class="form-row" style="align-items:flex-end">
        <div class="form-group" style="flex:0 0 220px">
          <label>验证码 *</label>
          <div style="display:flex;gap:8px;align-items:center">
            <input id="ra_captcha" maxlength="6" style="width:120px">
            <img id="ra_captcha_img" src="/api/auth/captcha" title="点击刷新" onclick="this.src='/api/auth/captcha?t='+Date.now()" style="height:40px;border-radius:6px;border:1px solid var(--border);cursor:pointer">
          </div>
        </div>
        <button class="btn btn-primary" onclick="submitRefereeApp()">提交申请</button>
        <span id="ra_submit_msg" style="font-size:12px"></span>
      </div>
    </div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="card-header"><div class="card-title">📋 我的申请记录（查询 / 撤回）</div></div>
    <div style="padding:16px 22px">
      <div class="form-row" style="align-items:flex-end">
        <div class="form-group"><label>学号</label><input id="ra_q_sid" maxlength="20"></div>
        <div class="form-group"><label>姓名</label><input id="ra_q_name" maxlength="20"></div>
        <button class="btn btn-outline" onclick="lookupRefereeApps()">查询</button>
        <span id="ra_lookup_msg" style="font-size:12px"></span>
      </div>
      <div id="ra_lookup_result" style="margin-top:12px"></div>
    </div>
  </div>`;
  refreshRaCaptcha();
}

function refreshRaCaptcha() {
  const img = document.getElementById('ra_captcha_img');
  if (img) img.src = '/api/auth/captcha?t=' + Date.now();
}

// 申请材料上传（免登录）
let raUploads = { photo: '', proof: '', fairPlay: '' };
async function uploadRaPhoto(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (!['image/jpeg','image/png','image/webp'].includes(file.type)) { alert('证件照只支持 jpg/png/webp 图片'); input.value = ''; return; }
  if (file.size > 5 * 1024 * 1024) { alert('图片不能超过 5MB'); input.value = ''; return; }
  const st = document.getElementById('ra_photo_status'); if (st) st.textContent = '上传中…';
  const fd = new FormData(); fd.append('photo', file);
  const res = await fetch('/api/referee-applications/photo', { method: 'POST', body: fd });
  const out = await res.json().catch(() => ({}));
  if (res.ok) { raUploads.photo = out.photoPath; document.getElementById('ra_photo_preview').innerHTML = `<img src="${out.photoPath}" style="max-height:110px;border:1px solid var(--border);border-radius:8px">`; if (st) { st.textContent = '✓ 已上传'; st.style.color = '#1A4D3A'; } }
  else { alert(out.error || '证件照上传失败'); if (st) { st.textContent = '上传失败'; st.style.color = '#e74c3c'; } }
}
async function uploadRaProof(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (!['image/jpeg','image/png','application/pdf'].includes(file.type)) { alert('证明只支持 jpg/png/pdf'); input.value = ''; return; }
  if (file.size > 5 * 1024 * 1024) { alert('文件不能超过 5MB'); input.value = ''; return; }
  const st = document.getElementById('ra_proof_status'); if (st) st.textContent = '上传中…';
  const fd = new FormData(); fd.append('card', file);
  const res = await fetch('/api/referee-applications/proof', { method: 'POST', body: fd });
  const out = await res.json().catch(() => ({}));
  if (res.ok) { raUploads.proof = out.proofPath; document.getElementById('ra_proof_preview').innerHTML = `<a href="${out.proofPath}" target="_blank">${file.type==='application/pdf'?'📄 查看PDF证明':'<img src="'+out.proofPath+'" style="max-height:110px;border:1px solid var(--border);border-radius:8px">'}</a>`; if (st) { st.textContent = '✓ 已上传'; st.style.color = '#1A4D3A'; } }
  else { alert(out.error || '证明上传失败'); if (st) { st.textContent = '上传失败'; st.style.color = '#e74c3c'; } }
}
async function uploadRaFairPlay(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (!['image/jpeg','image/png'].includes(file.type)) { alert('承诺书只支持 jpg/png 图片'); input.value = ''; return; }
  if (file.size > 5 * 1024 * 1024) { alert('图片不能超过 5MB'); input.value = ''; return; }
  const st = document.getElementById('ra_fairplay_status'); if (st) st.textContent = '上传中…';
  const fd = new FormData(); fd.append('file', file);
  const res = await fetch('/api/referee-applications/fair-play', { method: 'POST', body: fd });
  const out = await res.json().catch(() => ({}));
  if (res.ok) { raUploads.fairPlay = out.path; document.getElementById('ra_fairplay_preview').innerHTML = `<img src="${out.path}" style="max-height:110px;border:1px solid var(--border);border-radius:8px">`; if (st) { st.textContent = '✓ 已上传'; st.style.color = '#1A4D3A'; } }
  else { alert(out.error || '承诺书上传失败'); if (st) { st.textContent = '上传失败'; st.style.color = '#e74c3c'; } }
}

async function submitRefereeApp() {
  const msg = document.getElementById('ra_submit_msg');
  const name = (document.getElementById('ra_name').value || '').trim();
  const college = (document.getElementById('ra_college').value || '').trim();
  const sid = (document.getElementById('ra_sid').value || '').trim();
  const phone = (document.getElementById('ra_phone').value || '').trim();
  const captcha = (document.getElementById('ra_captcha').value || '').trim();
  const gender = document.getElementById('ra_gender').value;
  if (!name || !sid || !phone) { alert('请填写姓名、学号和联系电话'); return; }
  if (!/^\d{11}$/.test(phone)) { alert('联系电话必须为11位手机号'); return; }
  if (!raUploads.photo) { alert('请上传证件照'); return; }
  if (!raUploads.proof) { alert('请上传学生证或学信网学籍信息截图'); return; }
  if (!raUploads.fairPlay) { alert('请上传已签署的公平竞赛承诺书'); return; }
  if (!captcha) { alert('请输入验证码'); return; }
  if (msg) { msg.textContent = '提交中…'; msg.style.color = ''; }
  const body = { name, gender, college, student_id: sid, phone, photo_path: raUploads.photo, proof_path: raUploads.proof, fair_play_path: raUploads.fairPlay, captcha };
  const res = await fetch('/api/referee-applications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (res.ok) {
    alert('✅ 申请已提交，等待管理员审批。本学号今日还可提交 ' + (out.remaining ?? 0) + ' 次。');
    if (msg) { msg.textContent = '✓ 提交成功'; msg.style.color = '#1A4D3A'; }
    // 清空表单
    ['ra_name','ra_college','ra_sid','ra_phone','ra_captcha'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    ['ra_photo','ra_proof','ra_fairplay'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('ra_photo_preview').innerHTML = ''; document.getElementById('ra_proof_preview').innerHTML = ''; document.getElementById('ra_fairplay_preview').innerHTML = '';
    ['ra_photo_status','ra_proof_status','ra_fairplay_status'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = ''; });
    raUploads = { photo: '', proof: '', fairPlay: '' };
    refreshRaCaptcha();
  } else {
    alert(out.error || '提交失败');
    if (out.captchaRequired) refreshRaCaptcha();
    if (msg) { msg.textContent = ''; }
  }
}

async function lookupRefereeApps() {
  const sid = (document.getElementById('ra_q_sid').value || '').trim();
  const name = (document.getElementById('ra_q_name').value || '').trim();
  const msg = document.getElementById('ra_lookup_msg');
  const box = document.getElementById('ra_lookup_result');
  if (!sid || !name) { alert('请填写学号和姓名'); return; }
  if (msg) msg.textContent = '查询中…';
  const res = await fetch('/api/referee-applications/lookup?student_id=' + encodeURIComponent(sid) + '&name=' + encodeURIComponent(name));
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { if (msg) msg.textContent = ''; box.innerHTML = '<div class="empty-state">' + (out.error || '查询失败') + '</div>'; return; }
  if (msg) msg.textContent = '';
  if (!out.list || !out.list.length) { box.innerHTML = '<div class="empty-state">未查到该学号的裁判申请记录</div>'; return; }
  const stMap = { pending: ['待审批', '#8a6d1f', '#F3E9D2'], approved: ['已通过', '#2e7d32', '#e8f5e9'], rejected: ['已拒绝', '#c62828', '#fdecea'], withdrawn: ['已撤回', '#757575', '#eeeeee'] };
  box.innerHTML = out.list.map(a => {
    const [txt, color, bg] = stMap[a.status] || [a.status, '#333', '#eee'];
    const extra = a.status === 'approved'
      ? `<div style="font-size:12px;color:var(--primary);margin-top:4px">✔ 已通过（裁判等级：${escapeHtml(a.level || '—')}；裁判编号：${escapeHtml(a.serial_number || '—')}）<br>账号密码请向组委会领取</div>`
      : (a.status === 'rejected' ? `<div style="font-size:12px;color:#c62828;margin-top:4px">拒绝原因：${escapeHtml(a.admin_note || '未填写')}</div>` : '');
    const canWithdraw = a.status === 'pending';
    return `<div style="border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:10px;background:#fff">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div style="font-size:13px">${escapeHtml(a.name)} · ${escapeHtml(a.college) || '—'} · 提交于 ${escapeHtml(String(a.created_at||'').replace('T',' ').slice(0,16))}</div>
        <span class="badge" style="background:${bg};color:${color}">${txt}</span>
      </div>
      ${extra}
      ${canWithdraw ? `<button class="btn btn-sm btn-outline" style="margin-top:8px" onclick="withdrawRefereeApp(${a.id})">撤回申请</button>` : ''}
    </div>`;
  }).join('');
}

async function withdrawRefereeApp(id) {
  const sid = (document.getElementById('ra_q_sid').value || '').trim();
  const name = (document.getElementById('ra_q_name').value || '').trim();
  if (!confirm('确定撤回该申请吗？撤回后计入当日申请次数，且不可恢复。')) return;
  const res = await fetch('/api/referee-applications/' + id + '/withdraw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ student_id: sid, name }) });
  const out = await res.json().catch(() => ({}));
  if (res.ok) { alert('✅ 申请已撤回'); lookupRefereeApps(); }
  else alert(out.error || '撤回失败');
}

// ========== 管理员：裁判申请审批 ==========
async function loadRefereeAppsAdmin() {
  const res = await fetch('/api/referee-applications/pending');
  const out = await res.json().catch(() => ({}));
  if (!res.ok) return alert(out.error || '加载失败');
  const list = out.list || [];
  document.getElementById('genericModalTitle').textContent = '赛事裁判员申请（待审批 ' + list.length + ' 条）';
  document.getElementById('genericModalBody').innerHTML = !list.length
    ? '<div class="empty-state">暂无待审批的裁判员申请</div>'
    : list.map(a => `
      <div style="border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:12px;background:#fff">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div style="font-weight:600;font-size:15px">${escapeHtml(a.name)} <span style="font-weight:400;font-size:12px;color:var(--text-light)">（${a.gender === 'women' ? '女' : '男'}）</span></div>
          <span style="font-size:12px;color:var(--text-light)">提交于 ${escapeHtml(String(a.created_at||'').replace('T',' ').slice(0,16))}</span>
        </div>
        <div style="font-size:13px;line-height:1.9;margin-top:6px">
          学院：${escapeHtml(a.college) || '—'}　学号：${escapeHtml(a.student_id) || '—'}　电话：${escapeHtml(a.phone) || '—'}
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">
          ${a.photo_path ? `<a href="${a.photo_path}" target="_blank" class="btn btn-sm btn-outline">证件照</a>` : '<span style="color:#e74c3c;font-size:12px">缺证件照</span>'}
          ${a.proof_path ? `<a href="${a.proof_path}" target="_blank" class="btn btn-sm btn-outline">学生证/学信网证明</a>` : '<span style="color:#e74c3c;font-size:12px">缺证明</span>'}
          ${a.fair_play_path ? `<a href="${a.fair_play_path}" target="_blank" class="btn btn-sm btn-outline">公平竞赛承诺书</a>` : '<span style="color:#e74c3c;font-size:12px">缺承诺书</span>'}
        </div>
        <div id="ra_approve_row_${a.id}" style="margin-top:10px"></div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="btn btn-sm btn-primary" onclick="showRefAppApproveRow(${a.id})">✅ 审批通过</button>
          <button class="btn btn-sm btn-danger" onclick="rejectRefereeApp(${a.id})">❌ 拒绝</button>
        </div>
      </div>`).join('');
  document.getElementById('genericModalFooter').innerHTML = '<button class="btn btn-outline" onclick="closeModal(\'genericModal\')">关闭</button>';
  showModal('genericModal');
}

function showRefAppApproveRow(id) {
  const row = document.getElementById('ra_approve_row_' + id);
  row.innerHTML = `
    <div style="background:var(--primary-lighter,#E8F0EC);border-radius:8px;padding:10px 12px">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <span style="font-size:13px">裁判等级：</span>
        <select id="ra_level_${id}">${['一级','二级','三级','四级'].map(l => `<option ${l==='二级'?'selected':''}>${l}</option>`).join('')}</select>
        <span style="font-size:13px">专职岗位（可选）：</span>
        <select id="ra_type_${id}">
          <option value="">通用裁判（可担任所有位置）</option>
          <option value="main">专职主裁判</option>
          <option value="assistant">专职助理裁判</option>
          <option value="fourth">专职第四官员</option>
        </select>
      </div>
      <div style="font-size:12px;color:var(--text-light)">通过后将自动生成裁判账号（ref 账号 + 随机初始密码）、加入裁判队伍并生成电子裁判证。账号密码请线下告知申请人。</div>
      <button class="btn btn-sm btn-primary" style="margin-top:8px" onclick="approveRefereeApp(${id})">确认通过</button>
      <button class="btn btn-sm btn-outline" style="margin-top:8px" onclick="document.getElementById('ra_approve_row_${id}').innerHTML=''">取消</button>
    </div>`;
}

async function approveRefereeApp(id) {
  const level = document.getElementById('ra_level_' + id).value;
  const ref_type = document.getElementById('ra_type_' + id).value;
  const res = await fetch('/api/referee-applications/' + id + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level, ref_type }) });
  const out = await res.json().catch(() => ({}));
  if (res.ok) {
    alert('✅ 审批通过。\n裁判账号：' + out.username + '\n初始密码：' + out.password + '\n裁判编号：' + out.serial + '\n（请线下告知申请人，首次登录需修改密码）');
    loadRefereeAppsAdmin();
  } else alert(out.error || '审批失败');
}

async function rejectRefereeApp(id) {
  const note = prompt('请输入拒绝原因（申请人可在“我的申请记录”中查看）：');
  if (note === null) return;
  const res = await fetch('/api/referee-applications/' + id + '/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: String(note).trim() }) });
  const out = await res.json().catch(() => ({}));
  if (res.ok) { alert('✅ 已拒绝该申请'); loadRefereeAppsAdmin(); }
  else alert(out.error || '操作失败');
}

// 裁判本人：查看自己的裁判证
async function openMyRefereeCredential() {
  const res = await fetch('/api/referee/me');
  const me = await res.json().catch(() => ({}));
  if (!res.ok) return alert(me.error || '裁判档案不存在，请联系管理员');
  openRefereeCredential(me.id);
}

async function loadMyMatches() {
  const wrap = document.getElementById('myMatchesWrap');
  wrap.innerHTML = '<div class="empty-state"><div class="icon">⏳</div>加载中...</div>';
  let list;
  try {
    list = await fetch('/api/referee/my-matches').then(r => r.json());
  } catch (e) { wrap.innerHTML = '<div class="empty-state">加载失败</div>'; return; }
  myMatchesCache = list;
  if (!list.length) {
    wrap.innerHTML = '<div class="empty-state"><div class="icon">📭</div><p>暂无为您指派的执法任务</p></div>';
    return;
  }
  const groups = [
    { key: 'pending', title: '待执法', icon: '🕒' },
    { key: 'live', title: '进行中', icon: '⚡' },
    { key: 'finished', title: '已结束', icon: '✅' },
  ];
  let html = '';
  groups.forEach(g => {
    const items = list.filter(m => m.status === g.key);
    if (!items.length) return;
    html += `<div style="margin:16px 0 8px;font-weight:600;font-size:15px">${g.icon} ${g.title}（${items.length}）</div>`;
    html += items.map(m => renderMyMatchCard(m)).join('');
  });
  // 其他异常状态兜底
  const rest = list.filter(m => !['pending','live','finished'].includes(m.status));
  if (rest.length) html += rest.map(m => renderMyMatchCard(m)).join('');
  wrap.innerHTML = html;
}

function renderMyMatchCard(m) {
  const t1 = m.team1 ? escapeHtml(m.team1.name) : escapeHtml(m.team1_source || '待定');
  const t2 = m.team2 ? escapeHtml(m.team2.name) : escapeHtml(m.team2_source || '待定');
  const roleBadge = `<span class="badge" style="background:#F3E9D2;color:#8a6d1f">${m.role_label}</span>`;
  // 开赛临近高亮
  let soon = '';
  if (m.status === 'pending' && m.match_date && m.match_time) {
    const diff = new Date(`${m.match_date}T${m.match_time}:00`).getTime() - Date.now();
    const hrs = diff / 3600000;
    if (hrs >= 0 && hrs <= 24) soon = `<span style="color:#e65100;font-size:12px;margin-left:8px">⏰ ${hrs<=1?'1小时内开赛':'24小时内开赛'}</span>`;
  }
  let action = '';
  if (m.status === 'finished') {
    if (m.role === 'main') {
      const map = { none: ['填写裁判报告','btn-primary','📝'], draft: ['继续填写（草稿）','btn-outline','✏️'], submitted: ['查看裁判报告','btn-outline','👁️'], returned: ['报告已退回，重新编辑','btn-danger','↩️'] };
      const [txt, cls, ic] = map[m.report_status] || map.none;
      action = `<button class="btn btn-sm ${cls}" onclick="openRefReport(${m.id})">${ic} ${txt}</button>`;
    } else {
      const done = m.report_status === 'submitted';
      action = `<span style="font-size:12px;color:${done?'var(--primary)':'var(--text-light)'}">主裁报告：${done?'已提交':'未提交'}</span>`;
    }
  } else if (m.team1_id && m.team2_id) {
    action = `<button class="btn btn-sm btn-outline" onclick="viewRefMatchInfo(${m.id})">查看比赛信息</button>`;
  }
  // B7 赛前执法确认（未结束比赛）
  let confirmRow = '';
  if (m.status !== 'finished' && m.status !== 'cancelled') {
    const cs = m.confirm_status || 'pending';
    const map = { pending: ['未确认', '#9e9e9e', '#f5f5f5'], confirmed: ['✓ 已确认执法', '#2e7d32', '#e8f5e9'], leave: ['已请假', '#c62828', '#fdecea'] };
    const [txt, color, bg] = map[cs] || map.pending;
    confirmRow = `<div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="font-size:12px;padding:2px 10px;border-radius:12px;color:${color};background:${bg}">${txt}</span>
      <button class="btn btn-sm ${cs==='confirmed'?'btn-success':'btn-outline'}" onclick="setRefConfirm(${m.id},'confirmed')">确认执法</button>
      <button class="btn btn-sm ${cs==='leave'?'btn-danger':'btn-outline'}" onclick="askRefLeave(${m.id})">请假</button>
    </div>`;
  }
  return `<div style="border:1px solid var(--border);border-radius:12px;padding:14px 18px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:#fff">
    <div style="flex:1;min-width:280px">
      <div style="font-size:12px;color:var(--text-light);margin-bottom:6px">场序${displayMatchNum(m)} · ${roundFullText(m)} ${roleBadge}${soon}</div>
      <div style="font-weight:600;font-size:15px">${t1} <span style="color:var(--text-light);font-size:13px">VS</span> ${t2}</div>
      <div style="font-size:12px;color:var(--text-light);margin-top:4px">🕐 ${m.match_date||'日期待定'} ${m.match_time||''} ｜ 📍 ${m.match_location||'三期操场'} ｜ ${statusText(m.status)}</div>
      ${confirmRow}
    </div>
    <div>${action}</div>
  </div>`;
}

// B7 裁判确认/请假
async function setRefConfirm(matchId, status, note, kind) {
  const url = `/api/matches/${matchId}/confirm`;
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, note: note || '' })
  });
  const d = await res.json().catch(()=>({}));
  if (!res.ok) { alert(d.error || '操作失败'); return; }
  await loadMyMatches();
}
function askRefLeave(matchId, kind) {
  const note = prompt('请填写请假原因（将通知管理员改派）：');
  if (note === null) return;
  setRefConfirm(matchId, 'leave', note.trim(), kind);
}

// 助理/第四官员或赛前查看：只读比赛信息
async function viewRefMatchInfo(matchId, kind) {
  const m = await fetch('/api/matches/'+matchId).then(r=>r.json());
  const t1 = m.team1 ? escapeHtml(m.team1.name) : escapeHtml(m.team1_source||'待定');
  const t2 = m.team2 ? escapeHtml(m.team2.name) : escapeHtml(m.team2_source||'待定');
  const roster = (tid) => allPlayers.filter(p=>p.team_id===tid && p.status==='approved')
    .sort((a,b)=>a.jersey_number-b.jersey_number)
    .map(p=>`<tr><td>${p.jersey_number}</td><td>${escapeHtml(p.name)}</td><td>${p.is_official?escapeHtml(p.official_role||'官员'):escapeHtml(p.position||'-')}</td></tr>`).join('');
  document.getElementById('genericModalTitle').textContent = `场序${displayMatchNum(m)} 比赛信息（只读）`;
  document.getElementById('genericModalBody').innerHTML = `
    <div style="text-align:center;font-weight:600;font-size:16px;margin-bottom:12px">${t1} VS ${t2}</div>
    <div style="font-size:13px;color:var(--text-light);line-height:1.9;margin-bottom:12px">
      时间：${m.match_date||'-'} ${m.match_time||''}　地点：${m.match_location||'-'}<br>
      主裁判：${escapeHtml(m.main_referee?.name)||'未指派'}　助理1：${escapeHtml(m.assistant_ref1?.name)||'未指派'}　助理2：${escapeHtml(m.assistant_ref2?.name)||'未指派'}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div><strong style="font-size:13px">${t1} 名单</strong><div class="table-wrap" style="max-height:260px;overflow:auto"><table style="font-size:12px"><thead><tr><th>号码</th><th>姓名</th><th>位置</th></tr></thead><tbody>${roster(m.team1_id)}</tbody></table></div></div>
      <div><strong style="font-size:13px">${t2} 名单</strong><div class="table-wrap" style="max-height:260px;overflow:auto"><table style="font-size:12px"><thead><tr><th>号码</th><th>姓名</th><th>位置</th></tr></thead><tbody>${roster(m.team2_id)}</tbody></table></div></div>
    </div>`;
  document.getElementById('genericModalFooter').innerHTML = `<button class="btn btn-outline" onclick="closeModal('genericModal')">关闭</button>`;
  showModal('genericModal');
}

// ========== 裁判报告编辑器 ==========
async function openRefReport(matchId, kind) {
  const [m, rep] = await Promise.all([
    fetch('/api/matches/'+matchId).then(r=>r.json()),
    fetch('/api/referee/reports/'+matchId).then(r=>r.json())
  ]);
  if (rep.error) { alert(rep.error); return; }
  if (rep.is_main === false) { alert('仅本场主裁判可编辑报告'); return; }
  renderRefReportEditor(m, rep.report, rep.withinEditWindow);
  showModal('refReportModal');
}

function renderRefReportEditor(m, report, withinEditWindow) {
  refReportState = {
    matchId: m.id,
    events: report && report.events ? report.events.map(e => ({
      event_type: e.event_type, team_id: e.team_id, player_id: e.player_id,
      minute: e.minute, detail: e.detail||'', sub_in_player_id: e.sub_in_player_id||null, notes: e.notes||''
    })) : []
  };
  const t1 = m.team1 ? m.team1.name : 'A队';
  const t2 = m.team2 ? m.team2.name : 'B队';
  const r = report || {};

  const isSubmitted = r.status === 'submitted';
  const isReturned = r.status === 'returned';
  const locked = isSubmitted && !withinEditWindow && !isReturned;
  const canSubmit = m.status === 'finished';

  document.getElementById('refReportTitle').textContent = `裁判报告 · 场序${displayMatchNum(m)} ${t1} VS ${t2}`;
  const statusTip = isSubmitted
    ? (withinEditWindow ? `<div style="background:#e8f5e9;border:1px solid #a5d6a7;color:#2e7d32;padding:8px 14px;border-radius:8px;font-size:13px;margin-bottom:12px">✅ 报告已提交，1小时内仍可修改后重新提交</div>`
      : `<div style="background:#fff3e0;border:1px solid #ffb74d;color:#e65100;padding:8px 14px;border-radius:8px;font-size:13px;margin-bottom:12px">🔒 报告提交已超过1小时并锁定，如需修改请联系管理员退回</div>`)
    : isReturned ? `<div style="background:#ffebee;border:1px solid #ef9a9a;color:#c62828;padding:8px 14px;border-radius:8px;font-size:13px;margin-bottom:12px">↩️ 报告已被管理员退回，请修改后重新提交</div>`
    : (!canSubmit ? `<div style="background:#e3f2fd;border:1px solid #90caf9;color:#1565c0;padding:8px 14px;border-radius:8px;font-size:13px;margin-bottom:12px">ℹ️ 比赛尚未结束，可先保存草稿，比赛结束后才能提交</div>` : '');

  const dis = locked ? 'disabled' : '';
  document.getElementById('refReportBody').innerHTML = `
    ${statusTip}
    <div style="font-size:13px;color:var(--text-light);margin-bottom:10px">比赛时间：${m.match_date||'-'} ${m.match_time||''}　地点：${m.match_location||'-'}</div>
    <div class="form-row">
      <div class="form-group"><label>${t1} 最终比分</label><input type="number" min="0" id="rr_s1" value="${r.team1_score??''}" ${dis}></div>
      <div class="form-group"><label>${t2} 最终比分</label><input type="number" min="0" id="rr_s2" value="${r.team2_score??''}" ${dis}></div>
    </div>
    <div class="form-group" style="margin-bottom:6px">
      <label style="cursor:pointer"><input type="checkbox" id="rr_haspen" ${r.has_penalty?'checked':''} ${dis} onchange="document.getElementById('rr_penrow').style.display=this.checked?'':'none'"> 常规时间战平，进行点球大战</label>
    </div>
    <div class="form-row" id="rr_penrow" style="${r.has_penalty?'':'display:none'}">
      <div class="form-group"><label>${t1} 点球进球</label><input type="number" min="0" id="rr_p1" value="${r.penalty_team1??''}" ${dis}></div>
      <div class="form-group"><label>${t2} 点球进球</label><input type="number" min="0" id="rr_p2" value="${r.penalty_team2??''}" ${dis}></div>
    </div>

    <div style="border-top:1px solid var(--border);margin:14px 0;padding-top:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <strong>比赛事件</strong>
        ${locked?'':`<button class="btn btn-outline btn-sm" onclick="addRefEventRow()">+ 添加事件</button>`}
      </div>
      <div id="rr_event_list"></div>
    </div>

    <div class="form-group" style="margin-top:10px">
      <label>纪律与违规情况说明（红牌、冲突、球队官员/替补席违规等）</label>
      <textarea id="rr_discipline" rows="3" placeholder="无则填“无”" ${dis}>${r.discipline||''}</textarea>
    </div>
    <div class="form-group">
      <label>意外事件（受伤、比赛中断、天气延误、球迷或其他突发情况）</label>
      <textarea id="rr_incidents" rows="3" placeholder="无则填“无”" ${dis}>${r.incidents||''}</textarea>
    </div>
    <div class="form-group" id="rr_confirm_group" style="${isSubmitted&&locked?'display:none':''}">
      <label style="cursor:pointer;font-weight:600"><input type="checkbox" id="rr_confirm"> 本人确认以上记录属实，并对报告内容负责</label>
    </div>
    <div style="font-size:12px;color:var(--text-light)">提交人：${currentUser.displayName||currentUser.username}　${isSubmitted&&r.submitted_at?'提交时间：'+String(r.submitted_at).replace('T',' ').slice(0,16):''}</div>
  `;
  renderRefEventList(m);
  // footer
  const footer = document.getElementById('refReportFooter');
  if (locked) {
    footer.innerHTML = `<button class="btn btn-outline" onclick="closeModal('refReportModal')">关闭</button>`;
  } else {
    footer.innerHTML = `
      <button class="btn btn-outline" onclick="closeModal('refReportModal')">取消</button>
      <button class="btn btn-outline" onclick="saveRefReport('draft')">💾 保存草稿</button>
      <button class="btn btn-primary" onclick="saveRefReport('submit')">✅ 提交报告</button>`;
  }
}

function teamPlayerOptions(teamId, selected) {
  const players = allPlayers.filter(p => p.team_id === teamId && p.status === 'approved').sort((a,b)=>a.jersey_number-b.jersey_number);
  return '<option value="">选择球员</option>' + players.map(p => `<option value="${p.id}" ${p.id===selected?'selected':''}>${p.jersey_number} ${escapeHtml(p.name)}${p.is_official?'（官员）':''}</option>`).join('');
}

function addRefEventRow() {
  refReportState.events.push({ event_type:'goal', team_id:null, player_id:null, minute:'', detail:'open', sub_in_player_id:null, notes:'' });
  const m = matchDetailData || null;
  rerenderEventListKeep();
}

function rerenderEventListKeep() {
  // 需要当前比赛：从缓存myMatches或全局；用refReportState.matchId拉取的全局allMatches
  const m = allMatches.find(x => x.id === refReportState.matchId);
  renderRefEventList(m);
}

function removeRefEvent(i) { refReportState.events.splice(i,1); rerenderEventListKeep(); }

function updateRefEvent(i, field, val) {
  const e = refReportState.events[i];
  e[field] = (field==='team_id'||field==='player_id'||field==='sub_in_player_id'||field==='minute') ? (val===''?null:Number(val)) : val;
  if (field === 'event_type') {
    // 切换类型时重置 detail
    e.detail = e.event_type==='goal' ? 'open' : (e.event_type==='yellow' ? CARD_YELLOW_REASONS[0] : e.event_type==='red' ? CARD_RED_REASONS[0] : '');
  }  if (field === 'team_id') { e.player_id = null; e.sub_in_player_id = null; }
  rerenderEventListKeep();
}

function renderRefEventList(m) {
  const el = document.getElementById('rr_event_list');
  if (!el) return;
  if (!refReportState.events.length) { el.innerHTML = '<div style="font-size:12px;color:var(--text-light);padding:8px 0">暂无事件，可点击“添加事件”记录进球、红黄牌、换人</div>'; return; }
  el.innerHTML = refReportState.events.map((e,i) => {
    const typeIcon = { goal:'⚽进球', own_goal:'🦶乌龙', assist:'🅰助攻', yellow:'🟨黄牌', red:'🟥红牌', sub:'🔄换人' }[e.event_type];
    let detailCell = '';
    if (e.event_type === 'goal') {
      detailCell = `<select onchange="updateRefEvent(${i},'detail',this.value)">
        <option value="open" ${e.detail==='open'?'selected':''}>运动战进球</option>
        <option value="penalty" ${e.detail==='penalty'?'selected':''}>点球</option></select>`;
    } else if (e.event_type === 'yellow') {
      detailCell = `<select onchange="updateRefEvent(${i},'detail',this.value)">${CARD_YELLOW_REASONS.map(x=>`<option ${e.detail===x?'selected':''}>${x}</option>`).join('')}</select>`;
    } else if (e.event_type === 'red') {
      detailCell = `<select onchange="updateRefEvent(${i},'detail',this.value)">${CARD_RED_REASONS.map(x=>`<option ${e.detail===x?'selected':''}>${x}</option>`).join('')}</select>`;
    }
    const subCell = e.event_type === 'sub'
      ? `<select onchange="updateRefEvent(${i},'sub_in_player_id',this.value)">${teamPlayerOptions(e.team_id, e.sub_in_player_id)}</select><span style="font-size:11px;color:var(--text-light)">换上</span>` : '';
    const TYPE_LABELS = {goal:'⚽ 进球',own_goal:'🦶 乌龙球',assist:'🅰 助攻',yellow:'🟨 黄牌',red:'🟥 红牌',sub:'🔄 换人'};
    return `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 0;border-bottom:1px dashed var(--border-light)">
      <input type="number" min="0" max="130" value="${e.minute??''}" placeholder="分钟" style="width:64px" onchange="updateRefEvent(${i},'minute',this.value)">
      <select onchange="updateRefEvent(${i},'team_id',this.value)">
        <option value="">球队</option>
        ${m?`<option value="${m.team1_id}" ${e.team_id===m.team1_id?'selected':''}>${m.team1?escapeHtml(m.team1.name):'主队'}</option>
        <option value="${m.team2_id}" ${e.team_id===m.team2_id?'selected':''}>${m.team2?escapeHtml(m.team2.name):'客队'}</option>`:''}
      </select>
      <select onchange="updateRefEvent(${i},'event_type',this.value)">
        ${['goal','own_goal','assist','yellow','red','sub'].map(t=>`<option value="${t}" ${e.event_type===t?'selected':''}>${TYPE_LABELS[t]}</option>`).join('')}
      </select>
      <select onchange="updateRefEvent(${i},'player_id',this.value)">${teamPlayerOptions(e.team_id, e.player_id)}</select>
      ${e.event_type==='sub'?'<span style="font-size:11px;color:var(--text-light)">换下↑</span>':''}
      ${subCell}
      ${detailCell}
      <button class="btn btn-sm btn-danger" onclick="removeRefEvent(${i})">删</button>
    </div>`;
  }).join('');
}

async function saveRefReport(action) {
  if (!refReportState) return;
  const payload = {
    action,
    team1_score: document.getElementById('rr_s1').value,
    team2_score: document.getElementById('rr_s2').value,
    has_penalty: document.getElementById('rr_haspen').checked,
    penalty_team1: document.getElementById('rr_p1').value,
    penalty_team2: document.getElementById('rr_p2').value,
    discipline: document.getElementById('rr_discipline').value,
    incidents: document.getElementById('rr_incidents').value,
    confirmed: document.getElementById('rr_confirm') ? document.getElementById('rr_confirm').checked : false,
    events: refReportState.events,
  };
  if (action === 'submit') {
    if (payload.team1_score === '' || payload.team2_score === '') { alert('请填写双方最终比分'); return; }
    if (!payload.confirmed) { alert('请勾选“本人确认以上记录属实”'); return; }
    if (!confirm('提交后即代表您确认本场比赛记录属实。确定提交裁判报告？')) return;
  }
  const res = await fetch('/api/referee/reports/'+refReportState.matchId, {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) { alert(data.error||'保存失败'); return; }
  alert(action==='submit' ? '裁判报告已提交' : '草稿已保存');
  closeModal('refReportModal');
  loadMyMatches();
}

// ========== 管理员：查看/采纳/退回 裁判报告 ==========
async function loadAdminRefReport(matchId) {
  const wrap = document.getElementById('adminRefReportWrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="empty-state"><div class="icon">⏳</div>加载中...</div>';
  const data = await fetch('/api/admin/matches/'+matchId+'/referee-report').then(r=>r.json()).catch(()=>({}));
  if (!data.exists) {
    wrap.innerHTML = '<div class="empty-state"><div class="icon">📭</div><p>主裁判尚未提交裁判报告（也无草稿）</p></div>';
    return;
  }
  const r = data.report;
  const m = matchDetailData;
  const t1 = m.team1 ? escapeHtml(m.team1.name) : '主队', t2 = m.team2 ? escapeHtml(m.team2.name) : '客队';
  const statusMap = { draft:['草稿','#ff9800'], submitted:['已提交','#2e7d32'], returned:['已退回','#c62828'] };
  const [stText, stColor] = statusMap[r.status] || ['-','#888'];
  const evRow = e => {
    let detail = '';
    if (e.event_type==='goal') detail = {open:'运动战',penalty:'点球',own:'乌龙球'}[e.detail]||'';
    else detail = e.detail||'';
    if (e.event_type==='sub') return `<tr><td>${e.minute}'</td><td>🔄换人</td><td>${escapeHtml(e.team_name)||''}</td><td>${escapeHtml(e.player_name)||''}(${e.jersey_number||'-'})↓ / ${escapeHtml(e.sub_in_name)||''}(${e.sub_in_number||'-'})↑</td><td>${detail}</td></tr>`;
    const icon = {goal:'⚽进球',own_goal:'🦶乌龙球',assist:'🅰助攻',yellow:'🟨黄牌',red:'🟥红牌'}[e.event_type]||e.event_type;
    return `<tr><td>${e.minute}'</td><td>${icon}</td><td>${escapeHtml(e.team_name)||''}</td><td>${escapeHtml(e.player_name)||''}(${e.jersey_number||'-'})</td><td>${detail}${e.notes?' '+escapeHtml(e.notes):''}</td></tr>`;
  };
  wrap.innerHTML = `
    <div id="refReportPrintArea">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <div><span class="badge" style="background:${stColor};color:#fff">${stText}</span>
          ${r.adopted?'<span class="badge" style="background:#1565c0;color:#fff;margin-left:6px">已采纳为正式数据</span>':''}
          <span style="font-size:12px;color:var(--text-light);margin-left:8px">主裁判：${escapeHtml(r.referee_name)||'-'}　${r.submitted_at?'提交时间：'+String(r.submitted_at).replace('T',' ').slice(0,16):''}</span></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:14px;margin-bottom:12px">
        <div style="background:var(--bg);border-radius:8px;padding:10px 14px"><strong>${t1} 比分：</strong>${r.team1_score??'-'} ${r.has_penalty?`（点球 ${r.penalty_team1??'-'}）`:''}</div>
        <div style="background:var(--bg);border-radius:8px;padding:10px 14px"><strong>${t2} 比分：</strong>${r.team2_score??'-'} ${r.has_penalty?`（点球 ${r.penalty_team2??'-'}）`:''}</div>
      </div>
      <div style="font-weight:600;margin:10px 0 6px">比赛事件（${(r.events||[]).length}）</div>
      <div class="table-wrap">
        <table style="font-size:13px"><thead><tr><th>时间</th><th>类型</th><th>球队</th><th>球员</th><th>说明</th></tr></thead>
        <tbody>${(r.events||[]).length?r.events.map(evRow).join(''):'<tr><td colspan="5" class="empty-state">无事件记录</td></tr>'}</tbody></table>
      </div>

      <div style="margin-top:12px"><strong>纪律与违规情况：</strong><div style="white-space:pre-wrap;background:var(--bg);border-radius:8px;padding:10px 14px;margin-top:4px;font-size:13px">${escapeHtml(r.discipline)||'无'}</div></div>
      <div style="margin-top:10px"><strong>意外事件：</strong><div style="white-space:pre-wrap;background:var(--bg);border-radius:8px;padding:10px 14px;margin-top:4px;font-size:13px">${escapeHtml(r.incidents)||'无'}</div></div>
      <div style="margin-top:10px;font-size:12px;color:var(--primary)">${r.confirmed?'✔ 主裁已勾选“本人确认以上记录属实”':''}</div>
    </div>
    <div class="no-print" style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
      ${r.status==='submitted'&&!r.adopted?`<button class="btn btn-primary btn-sm" onclick="adoptRefReport(${matchId})">✅ 采纳为正式比分与事件</button>`:''}
      ${r.status==='submitted'?`<button class="btn btn-outline btn-sm" onclick="returnRefReport(${matchId})">↩️ 退回让主裁修改</button>`:''}
      <button class="btn btn-outline btn-sm" onclick="printRefReport()">🖨️ 打印报告</button>
    </div>`;
}

async function adoptRefReport(matchId) {
  confirmDialog('采纳后将用裁判报告覆盖本场正式比分与比赛事件，并自动计算停赛、推进后续对阵。确定采纳？', async () => {
    const res = await fetch('/api/admin/referee-report/'+matchId+'/adopt', { method:'POST' });
    const d = await res.json().catch(()=>({}));
    if (!res.ok) { alert(d.error||'采纳失败'); return; }
    alert('已采纳为正式数据');
    await loadAllData();
    loadAdminRefReport(matchId);
    openMatch(matchId);
  }, '✅');
}

async function returnRefReport(matchId) {
  const res = await fetch('/api/admin/referee-report/'+matchId+'/return', { method:'POST' });
  const d = await res.json().catch(()=>({}));
  if (!res.ok) { alert(d.error||'退回失败'); return; }
  alert('已退回，主裁可重新编辑提交');
  loadAdminRefReport(matchId);
}

function printRefReport() {
  const area = document.getElementById('refReportPrintArea');
  if (!area) return;
  const w = window.open('', '_blank');
  w.document.write(`<html><head><meta charset="utf-8"><title>裁判报告</title><style>
    body{font-family:"Microsoft YaHei",sans-serif;padding:32px;color:#222;font-size:14px}
    h2{text-align:center;margin-bottom:4px} .sub{text-align:center;color:#666;font-size:12px;margin-bottom:20px}
    table{width:100%;border-collapse:collapse;margin:8px 0} th,td{border:1px solid #bbb;padding:6px 8px;font-size:13px;text-align:left}
    th{background:#f0f4f2}.box{background:#f6f8f7;border-radius:6px;padding:8px 12px;margin:6px 0;white-space:pre-wrap}
    .grid{display:flex;gap:12px}.grid>div{flex:1;background:#f6f8f7;border-radius:6px;padding:8px 12px}
  </style></head><body><h2>2026年沈阳城市学院“绿岛杯”足球赛 裁判报告</h2>
  <div class="sub">${document.getElementById('matchModalTitle').textContent}</div>${area.innerHTML}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(()=>w.print(), 300);
}

// ========== 纪律与停赛 ==========
async function loadSuspensions() {
  const res = await fetch('/api/discipline');
  let data = await res.json();
  // 按当前组别过滤（依据球员所属球队 gender）
  if (currentGender !== 'all') {
    data = data.filter(s => {
      const t = allTeams.find(x => x.id === s.team_id);
      return (t ? (t.gender || 'men') : 'men') === currentGender;
    });
  }
  const alertsEl = document.getElementById('suspensionAlerts');
  const active = data.filter(s => s.active === 1 && (s.discipline_type || 'suspension') === 'suspension' && (s.remaining_count ?? s.match_count) > 0);
  if (active.length) {
    alertsEl.innerHTML = active.map(s => `<div class="suspension-alert">⚠️ <strong>${escapeHtml(s.player_name)}</strong>（${escapeHtml(s.team_name)}）- ${escapeHtml(s.reason)}，剩余停赛${s.remaining_count ?? s.match_count}场</div>`).join('');
  } else {
    alertsEl.innerHTML = '';
  }
  const tbody = document.querySelector('#suspensionsTable tbody');
  const addBtn = document.getElementById('btnAddSuspension');
  if (addBtn) addBtn.style.display = isAdmin() ? 'inline-block' : 'none';
  const typeLabel = (s) => (s.discipline_type === 'warning')
    ? '<span class="badge" style="background:#fff3e0;color:#e65100">警告</span>'
    : '<span class="badge" style="background:#fdecea;color:#c62828">停赛</span>';
  const statusLabel = (s) => {
    if (s.revoked_at || s.active === 0) return '<span class="badge" style="background:#eceff1;color:#607d8b">已解除/执行完毕</span>';
    if ((s.discipline_type || 'suspension') === 'warning') return '<span class="badge badge-finished">有效</span>';
    const rem = s.remaining_count ?? s.match_count;
    return rem > 0 ? `<span class="badge badge-pending">停赛中·剩${rem}场</span>` : '<span class="badge badge-finished">已执行完毕</span>';
  };
  tbody.innerHTML = data.length ? data.map(s => `<tr style="${s.active===0?'opacity:.55':''}">
    <td><strong>${escapeHtml(s.player_name)}</strong></td>
    <td class="text-center">${s.jersey_number}</td>
    <td>${escapeHtml(s.team_name)}</td>
    <td>${typeLabel(s)}</td>
    <td>${escapeHtml(s.reason)}${s.notes?`<div style="font-size:11px;color:var(--text-light)">${escapeHtml(s.notes)}</div>`:''}</td>
    <td class="text-center">${(s.discipline_type||'suspension')==='warning' ? '—' : `${s.remaining_count ?? s.match_count}/${s.match_count}`}</td>
    <td>${statusLabel(s)}</td>
    <td>${String(s.created_at||'').replace('T',' ').slice(0,16)}</td>
    ${isGuest ? '' : `<td class="no-print">${isAdmin() && s.active === 1 ? `<button class="btn btn-sm btn-outline" onclick="revokeDiscipline(${s.id})">解除</button>` : ''}</td>`}
  </tr>`).join('') : `<tr><td colspan="${isGuest ? 8 : 9}" class="empty-state">暂无纪律处罚记录</td></tr>`;
  loadYellowResets();
}

// 清黄牌边界管理（管理员兜底）：男子=半决赛边界15，女子=小组赛后/排位赛前边界107（展示场序7）
async function loadYellowResets() {
  const card = document.getElementById('yellowResetCard');
  const panel = document.getElementById('yellowResetPanel');
  if (!card || !panel) return;
  if (!isAdmin()) { card.style.display = 'none'; return; }
  card.style.display = '';
  const titleEl = document.getElementById('yellowResetTitle');
  const descEl = document.getElementById('yellowResetDesc');
  const isWomen = currentGender === 'women';
  if (isWomen) {
    if (titleEl) titleEl.textContent = '小组赛后黄牌清零管理（兜底）';
    if (descEl) descEl.innerHTML = '规程：女子组小组赛全部结束、进入排位赛（展示场序7，即决赛）前，各队此前累计黄牌自动清零一次（黄牌事件仍保留展示，已触发尚未执行的停赛不免）。系统在小组赛完赛时自动执行；此处供管理员在特殊情况下手动设置/撤销某队的清黄边界。';
  } else if (currentGender === 'all') {
    if (titleEl) titleEl.textContent = '黄牌清零管理（兜底 · 男子半决赛前 / 女子排位赛前）';
    if (descEl) descEl.innerHTML = '规程：男子组进入半决赛（场序15/16）、女子组小组赛全部结束进入排位赛（展示场序7）前，各队此前累计黄牌自动清零一次（黄牌事件仍保留展示，已触发尚未执行的停赛不免）。系统自动执行；此处供管理员在特殊情况下手动设置/撤销某队的清黄边界。';
  } else {
    if (titleEl) titleEl.textContent = '半决赛黄牌清零管理（兜底）';
    if (descEl) descEl.innerHTML = '规程：进入半决赛（场序15/16）时各队此前累计黄牌自动清零（黄牌事件仍保留展示，已触发尚未执行的停赛不免）。系统在半决赛完赛时自动执行；此处供管理员在特殊情况下手动设置/撤销某队的清黄边界。';
  }
  let resets = [];
  try { const j = await fetch('/api/discipline/yellow-resets').then(r => r.json()); resets = j.manual || j || []; } catch(e) {}
  const map = {}; (resets||[]).forEach(r => map[r.team_id] = r);
  const boundaryLabel = (b) => (+b) >= 100 ? `场序${(+b) - 100}（决赛）前清零` : `场序${b}后清零`;
  const teamBlock = (t) => {
    const womenTeam = t.gender === 'women';
    const cur = map[t.id];
    const opts = womenTeam
      ? `<option value="">未设置（按系统自动）</option><option value="107" ${cur&&cur.boundary_match_number===107?'selected':''}>场序7（决赛）前清零</option>`
      : `<option value="">未设置（按系统自动）</option><option value="15" ${cur&&cur.boundary_match_number===15?'selected':''}>场序15（半决赛）前清零</option>`;
    return `<div style="border:1px solid var(--border);border-radius:8px;padding:10px">
      <div style="font-weight:600;margin-bottom:6px">${womenTeam?'🏐 ':''}${escapeHtml(t.name)}</div>
      <div style="display:flex;gap:6px;align-items:center">
        <select id="yr_${t.id}" style="flex:1">${opts}</select>
        <button class="btn btn-sm btn-primary" onclick="saveYellowReset(${t.id})">保存</button>
        ${cur?`<button class="btn btn-sm btn-outline" onclick="removeYellowReset(${t.id})">撤销</button>`:''}
      </div>
      ${cur?`<div style="font-size:11px;color:var(--text-light);margin-top:4px">已设：${boundaryLabel(cur.boundary_match_number)} · ${fmtTime(cur.created_at)}</div>`:''}
    </div>`;
  };
  const menTeams = genderTeams().filter(t => t.gender !== 'women');
  const womenTeams = genderTeams().filter(t => t.gender === 'women');
  let panelHtml = '';
  if (currentGender === 'women') panelHtml = womenTeams.map(teamBlock).join('');
  else if (currentGender === 'all') {
    panelHtml = '<div style="font-weight:700;color:#1f5c43;margin:4px 0 10px">⚽ 男子组（半决赛前清零）</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px">' + menTeams.map(teamBlock).join('') + '</div>'
      + '<div style="font-weight:700;color:#1f5c43;margin:16px 0 10px">🏐 女子组（排位赛前清零）</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px">' + womenTeams.map(teamBlock).join('') + '</div>';
  } else panelHtml = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px">' + menTeams.map(teamBlock).join('') + '</div>';
  panel.innerHTML = panelHtml;
}
async function saveYellowReset(teamId) {
  const boundary = +document.getElementById('yr_'+teamId).value;
  if (!boundary) { removeYellowReset(teamId); return; }
  const team = allTeams.find(t => t.id === teamId);
  const isWomen = team && team.gender === 'women';
  const note = prompt('备注（选填）', isWomen ? '小组赛结束、排位赛前累计黄牌清零' : '进入半决赛，累计黄牌清零') || '';
  const res = await fetch('/api/discipline/yellow-reset', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ team_id: teamId, boundary_match_number: boundary, note }) });
  const d = await res.json().catch(()=>({}));
  if (!res.ok) { alert(d.error||'保存失败'); return; }
  toast('已设置清黄边界'); loadYellowResets();
}
async function removeYellowReset(teamId) {
  const res = await fetch('/api/discipline/yellow-reset/'+teamId, { method:'DELETE' });
  if (res.ok) { toast('已撤销'); loadYellowResets(); }
}

async function revokeDiscipline(id) {
  if (!confirm('确定解除该条纪律处罚吗？')) return;
  const res = await fetch('/api/discipline/' + id + '/revoke', { method: 'POST' });
  if (res.ok) { toast('已解除'); loadSuspensions(); }
  else { const e = await res.json().catch(()=>({})); alert(e.error || '操作失败'); }
}

function showDisciplineModal() {
  const playerOptions = allPlayers.filter(p => !p.is_official && p.status === 'approved').map(p =>
    `<option value="${p.id}">${escapeHtml(p.name)}(${p.jersey_number}号) - ${escapeHtml(p.team_name)}</option>`).join('');
  document.getElementById('genericModalTitle').textContent = '新增纪律处罚';
  document.getElementById('genericModalBody').innerHTML = `
    <div class="form-group"><label>处罚类型*</label>
      <select id="d_type" onchange="document.getElementById('d_count_group').style.display=this.value==='suspension'?'block':'none'">
        <option value="warning">纪律警告（不停赛）</option>
        <option value="suspension" selected>追加停赛</option>
      </select></div>
    <div class="form-group"><label>选择球员*</label><select id="d_player">${playerOptions}</select></div>
    <div class="form-group" id="d_count_group"><label>停赛场次*</label><input type="number" id="d_count" value="1" min="1" max="20"></div>
    <div class="form-group"><label>处罚事由*</label><input id="d_reason" maxlength="60" placeholder="如：累计黄牌/严重犯规/非体育行为"></div>
    <div class="form-group"><label>备注</label><textarea id="d_notes" maxlength="200"></textarea></div>
  `;
  document.getElementById('genericModalFooter').innerHTML = `
    <button class="btn btn-outline" onclick="closeModal('genericModal')">取消</button>
    <button class="btn btn-primary" onclick="saveDiscipline()">保存并通知球队</button>`;
  showModal('genericModal');
}

async function saveDiscipline() {
  const data = {
    discipline_type: document.getElementById('d_type').value,
    player_id: +document.getElementById('d_player').value,
    match_count: +document.getElementById('d_count').value || 1,
    reason: document.getElementById('d_reason').value.trim(),
    notes: document.getElementById('d_notes').value.trim(),
  };
  if (!data.reason) return alert('请填写处罚事由');
  const res = await fetch('/api/discipline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (res.ok) { closeModal('genericModal'); toast('处罚已记录并通知该队'); loadSuspensions(); }
  else { const e = await res.json().catch(()=>({})); alert(e.error || '保存失败'); }
}

// ========== 比赛详情（核心） ==========
let matchDetailData = null;
let matchEvents = [];
let penaltyData = [];

async function openMatch(id) {
  try {
  editingMatchId = id;
  const res = await fetch('/api/matches/' + id);
  matchDetailData = await res.json();
  if (matchDetailData.error) { alert(matchDetailData.error); return; }
  matchEvents = [...(matchDetailData.events || [])];
  penaltyData = [...(matchDetailData.penalties || [])];
  // 预加载签到数据（游客跳过）
  if (!isGuest && matchDetailData.team1_id && matchDetailData.team2_id) {
    fetch(`/api/matches/${id}/checkins`).then(r => r.json()).then(d => { checkinData = d; }).catch(() => {});
  }

  const m = matchDetailData;
  const t1 = m.team1 ? m.team1.name : (m.team1_source || '待定');
  const t2 = m.team2 ? m.team2.name : (m.team2_source || '待定');
  document.getElementById('matchModalTitle').textContent = `场序${displayMatchNum(m)} · ${roundFullText(m)}`;

  renderMatchDetail();
  showModal('matchModal');
  } catch(e) { console.error('openMatch error:', e); alert('打开比赛详情失败: ' + e.message); }
}

function renderMatchDetail() {
  const m = matchDetailData;
  const t1 = m.team1 ? escapeHtml(m.team1.name) : escapeHtml(m.team1_source || '待定');
  const t2 = m.team2 ? escapeHtml(m.team2.name) : escapeHtml(m.team2_source || '待定');
  const isLocked = m.status === 'finished';
  const canEdit = isAdmin() && m.team1_id && m.team2_id && !isLocked;
  let confirmSummaryHtml = '';   // B7（需在 html 组装前完成赋值）
  let advanceOverrideHtml = '';  // C11（同上）

  // B7 执法确认状态（管理员可见）——内嵌于基本信息tab
  if (isAdmin() && Array.isArray(m.ref_confirms) && m.ref_confirms.length) {
    const roleOf = { };
    [['main_referee_id','主裁判'],['assistant_ref1_id','助理1'],['assistant_ref2_id','助理2'],['fourth_official_id','第四官员']].forEach(([k,label])=>{ if(m[k]) roleOf[m[k]]=label; });
    const rows = m.ref_confirms.map(c => {
      const ref = allReferees.find(r => r.id === c.referee_id);
      const name = ref ? escapeHtml(ref.name) : ('#'+c.referee_id);
      const map = { pending:['未确认','#9e9e9e','#f5f5f5'], confirmed:['已确认','#2e7d32','#e8f5e9'], leave:['请假','#c62828','#fdecea'] };
      const [txt,color,bg] = map[c.status]||map.pending;
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-bottom:1px solid var(--border);font-size:13px">
        <span>${roleOf[c.referee_id]||''} · ${name}${c.note?`（${c.note}）`:''}</span>
        <span style="padding:2px 10px;border-radius:12px;color:${color};background:${bg}">${txt}</span></div>`;
    }).join('');
    confirmSummaryHtml = `<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;margin:12px 0">
      <div style="padding:8px 10px;font-weight:600;font-size:13px;background:var(--primary-lighter)">裁判赛前执法确认</div>${rows}</div>`;
  }

  // C11 淘汰赛手动覆盖晋级（管理员、未结束、非首轮）
  if (isAdmin() && m.status !== 'finished' && m.match_number > 4) {
    const _ovTeams = allTeams.filter(t => (t.gender || 'men') === (m.gender || 'men'));
    const teamOpts = (sel) => '<option value="">选择球队</option>' + _ovTeams.map(t => `<option value="${t.id}" ${sel===t.id?'selected':''}>${escapeHtml(t.name)}</option>`).join('');
    if (m.advance_locked) {
      advanceOverrideHtml = `<div style="border:1px solid #C8A45C;background:#FBF6E9;border-radius:10px;padding:10px 12px;margin:12px 0;font-size:13px">
        🔒 本场对阵已由管理员手动指定并锁定，自动晋级不会改写。
        <button class="btn btn-sm btn-outline" style="margin-left:8px" onclick="restoreAutoAdvance(${m.id})">恢复自动晋级</button></div>`;
    } else {
      advanceOverrideHtml = `<details style="border:1px solid var(--border);border-radius:10px;margin:12px 0">
        <summary style="padding:8px 12px;cursor:pointer;font-size:13px;font-weight:600">手动指定对阵双方（覆盖自动晋级）</summary>
        <div style="padding:10px 12px">
          <div class="form-row">
            <div class="form-group"><label>一方</label><select id="ov_t1">${teamOpts(m.team1_id)}</select></div>
            <div class="form-group"><label>另一方</label><select id="ov_t2">${teamOpts(m.team2_id)}</select></div>
          </div>
          <button class="btn btn-sm btn-primary" onclick="submitAdvanceOverride(${m.id})">覆盖并锁定</button>
          <span style="font-size:12px;color:var(--text-light);margin-left:8px">仅用于自动推导异常时人工修正</span>
        </div></details>`;
    }
  }

  let html = `
    <div style="text-align:center;margin-bottom:20px">
      <div style="font-size:13px;color:var(--text-light);margin-bottom:8px">${roundFullText(m)} · 场序${displayMatchNum(m)}</div>
      <div style="display:flex;align-items:center;justify-content:center;gap:20px">
        <div style="text-align:right;min-width:120px"><div style="font-weight:600;font-size:16px">${t1}</div></div>
        <div style="font-size:28px;font-weight:700;color:var(--primary)">
          ${(m.status === 'finished' && m.team1_score !== null && m.team1_score !== undefined) ? `${m.team1_score} : ${m.team2_score}` : (m.status === 'finished' ? '<span style="font-size:15px;color:var(--text-light)">比分待录入</span>' : 'VS')}
        </div>
        <div style="text-align:left;min-width:120px"><div style="font-weight:600;font-size:16px">${t2}</div></div>
      </div>
      ${m.has_penalty ? `<div style="margin-top:6px;font-size:13px;color:var(--text-light)">点球大战 ${m.penalty_team1} : ${m.penalty_team2}</div>` : ''}
      ${m.mvp_player ? `<div style="margin-top:8px;display:inline-block;background:linear-gradient(135deg,#FFD700,#FFA500);color:#fff;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:600">🏆 本场MVP：${m.mvp_player.jersey_number}号 ${escapeHtml(m.mvp_player.name)}</div>` : ''}
      ${m.notes && m.notes.includes('取消') ? `<div style="margin-top:6px;color:var(--danger);font-size:13px">${escapeHtml(m.notes)}</div>` : ''}
    </div>
  `;


  // 锁定提示
  if (isLocked && isAdmin()) {
    html += `<div style="background:#fff3e0;border:1px solid #ffb74d;border-radius:8px;padding:10px 16px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between">
      <span style="color:#e65100;font-size:13px">🔒 比赛已结束并锁定，如需修改请先解锁</span>
      <button class="btn btn-outline btn-sm" onclick="unlockMatch()" style="border-color:#ff9800;color:#e65100">解锁比赛</button>
    </div>`;
  }

  // 基本信息
  const _wm = m.gender === 'women';
  const guestTabs = isGuest
    ? `<div class="tabs" id="matchTabs">
    <div class="tab active" data-tab="info" onclick="switchMatchTab(this)">基本信息</div>
    <div class="tab" data-tab="lineup" onclick="switchMatchTab(this)">阵容</div>
    <div class="tab" data-tab="events" onclick="switchMatchTab(this)">比赛事件</div>

  </div>`
    : `<div class="tabs" id="matchTabs">
    <div class="tab active" data-tab="info" onclick="switchMatchTab(this)">基本信息</div>
    <div class="tab" data-tab="checkin" onclick="switchMatchTab(this)">签到</div>
    <div class="tab" data-tab="lineup" onclick="switchMatchTab(this)">阵容</div>
    <div class="tab" data-tab="score" onclick="switchMatchTab(this)">比分录入</div>
    <div class="tab" data-tab="events" onclick="switchMatchTab(this)">比赛事件</div>

    ${isAdmin() ? '<div class="tab" data-tab="refreport" onclick="switchMatchTab(this)">裁判报告</div>' : ''}

  </div>`;
  html += guestTabs;

  // 基本信息
  if (isGuest) {
    const mainRef = m.main_referee ? m.main_referee.name : '未指派';
    const asst1 = m.assistant_ref1 ? m.assistant_ref1.name : '未指派';
    const asst2 = m.assistant_ref2 ? m.assistant_ref2.name : '未指派';
    const fourth = m.fourth_official_id ? (allReferees.find(r => r.id === m.fourth_official_id)?.name || '未指派') : '无';

    html += `<div class="match-tab" id="tab-info">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:14px;line-height:2">
        <div><strong>比赛日期：</strong>${m.match_date || '-'}</div>
        <div><strong>比赛时间：</strong>${m.match_time || '-'}</div>
        <div><strong>比赛地点：</strong>${escapeHtml(m.match_location) || '-'}</div>
        <div><strong>比赛状态：</strong>${statusText(m.status)}</div>
        <div><strong>主裁判：</strong>${mainRef}</div>
        <div><strong>第四官员：</strong>${fourth}</div>
        <div><strong>助理裁判1：</strong>${asst1}</div>
        <div><strong>助理裁判2：</strong>${asst2}</div>

      </div>
      ${m.notes ? `<div style="margin-top:12px;font-size:13px;color:var(--text-light)"><strong>备注：</strong>${escapeHtml(m.notes)}</div>` : ''}
    </div>`;
  } else {
  html += `<div class="match-tab" id="tab-info">
    <div class="form-row">
      <div class="form-group"><label>比赛日期</label><input type="date" id="m_date" value="${escapeHtml(m.match_date)||''}" ${!canEdit?'disabled':''}></div>
      <div class="form-group"><label>比赛时间</label><input type="time" id="m_time" value="${escapeHtml(m.match_time)||''}" ${!canEdit?'disabled':''}></div>
      <div class="form-group"><label>比赛地点</label><input id="m_loc" value="${escapeHtml(m.match_location)||'三期操场'}" ${!canEdit?'disabled':''}></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>比赛状态</label>
        <select id="m_status" ${!canEdit?'disabled':''}>
          <option value="pending" ${m.status==='pending'?'selected':''}>未开始</option>
          <option value="live" ${m.status==='live'?'selected':''}>进行中</option>
          <option value="finished" ${m.status==='finished'?'selected':''}>已结束</option>
        </select>
      </div>
      <div class="form-group"><label>主裁判</label>
        <select id="m_ref" ${!canEdit?'disabled':''} onchange="updateRefSelects()">
          <option value="">未指派</option>
          ${allReferees.filter(r=>canFillPosition(r,'main')).map(r=>`<option value="${r.id}" ${m.main_referee_id===r.id?'selected':''}>${escapeHtml(r.name)}(${escapeHtml(r.level)})</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>助理裁判1</label>
        <select id="m_ref1" ${!canEdit?'disabled':''} onchange="updateRefSelects()">
          <option value="">未指派</option>
          ${allReferees.filter(r=>canFillPosition(r,'assistant')).map(r=>`<option value="${r.id}" ${m.assistant_ref1_id===r.id?'selected':''}>${escapeHtml(r.name)}(${escapeHtml(r.level)})</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>助理裁判2</label>
        <select id="m_ref2" ${!canEdit?'disabled':''} onchange="updateRefSelects()">
          <option value="">未指派</option>
          ${allReferees.filter(r=>canFillPosition(r,'assistant')).map(r=>`<option value="${r.id}" ${m.assistant_ref2_id===r.id?'selected':''}>${escapeHtml(r.name)}(${escapeHtml(r.level)})</option>`).join('')}
        </select>
      </div>
      <div class="form-group" ${m.gender==='women'?'style="display:none"':''}><label>第四官员</label>
        <select id="m_fourth" ${!canEdit?'disabled':''} onchange="updateRefSelects()">
          <option value="">本场比赛不设第四官员</option>
          ${allReferees.filter(r=>canFillPosition(r,'fourth')).map(r=>`<option value="${r.id}" ${m.fourth_official_id===r.id?'selected':''}>${escapeHtml(r.name)}(${escapeHtml(r.level)})</option>`).join('')}
        </select>
      </div>
    </div>

    ${confirmSummaryHtml}
    ${advanceOverrideHtml}
    ${canEdit ? `<div id="refRecommendBar" style="margin:6px 0 12px">
      <button type="button" class="btn btn-outline" onclick="loadRefRecommend()">✨ 智能推荐裁判</button>
      <div id="refRecommendPanel" style="margin-top:10px"></div>
    </div>` : ''}
    ${canEdit ? `<button class="btn btn-primary" onclick="saveMatchBasic()">保存基本信息</button>` : ''}
    ${m.status==='finished' ? `<button type="button" class="btn btn-outline" onclick="printMatchSheet()" style="margin-left:8px">🖨️ 官方比赛记录单</button>` : ''}
  </div>`;
  }

  // 签到（游客隐藏）
  if (!isGuest) {
    html += `<div class="match-tab" id="tab-checkin" style="display:none">
    <div id="checkinContent"><div class="empty-state"><div class="icon">⏳</div>加载中...</div></div>
  </div>`;
  }

  // 阵容
  html += `<div class="match-tab" id="tab-lineup" style="display:none">
    ${renderLineupTab(m)}
  </div>`;

  // 比分录入（游客隐藏）
  if (!isGuest) {
    html += `<div class="match-tab" id="tab-score" style="display:none">
    ${renderScoreTab(m)}
  </div>`;
  }

  // 比赛事件
  html += `<div class="match-tab" id="tab-events" style="display:none">
    ${renderEventsTab(m)}
  </div>`;

  // 裁判报告（仅管理员）
  if (isAdmin()) {
    html += `<div class="match-tab" id="tab-refreport" style="display:none">
      <div id="adminRefReportWrap"><div class="empty-state"><div class="icon">⏳</div>加载中...</div></div>
    </div>`;
  }
  document.getElementById('matchModalBody').innerHTML = html;

  // footer
  document.getElementById('matchModalFooter').innerHTML = `
    <button class="btn btn-outline" onclick="closeModal('matchModal')">关闭</button>`;
}

// 切换比赛详情tab（全局函数，供onclick调用）
function switchMatchTab(tabEl) {
  const tabName = tabEl.dataset.tab;
  document.querySelectorAll('#matchTabs .tab').forEach(t => t.classList.remove('active'));
  tabEl.classList.add('active');
  document.querySelectorAll('.match-tab').forEach(t => t.style.display = 'none');
  const target = document.getElementById('tab-' + tabName);
  if (target) target.style.display = '';
  if (tabName === 'checkin') loadCheckins(matchDetailData.id);
  if (tabName === 'refreport' && isAdmin()) loadAdminRefReport(matchDetailData.id);

  if (tabName === 'lineup' && !isGuest) {
    fetch(`/api/matches/${matchDetailData.id}/checkins`).then(r => r.json()).then(d => {
      if (Array.isArray(d)) checkinData = d;
      const lineupEl = document.getElementById('tab-lineup');
      if (lineupEl) lineupEl.innerHTML = renderLineupTab(matchDetailData);
    }).catch(() => {});
  }
}

// ========== 解锁比赛 ==========
async function unlockMatch() {
  const password = prompt('请输入管理员密码以解锁比赛：');
  if (!password) return;
  try {
    const res = await fetch(`/api/matches/${matchDetailData.id}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || '解锁失败'); return; }
    alert('比赛已解锁，状态已改为进行中');
    closeModal('matchModal');
    await loadAllData(); refreshCurrentPage();
  } catch (e) { alert('网络错误'); }
}

// ========== 签到管理 ==========
let checkinData = [];
async function loadCheckins(matchId) {
  const m = matchDetailData;
  if (!m.team1_id || !m.team2_id) {
    document.getElementById('checkinContent').innerHTML = '<div class="empty-state">双方球队尚未确定</div>';
    return;
  }
  try {
    const res = await fetch(`/api/matches/${matchId}/checkins`);
    checkinData = await res.json();
  } catch (e) { checkinData = []; }
  const canEdit = isAdmin() || (currentUser && currentUser.team_id);
  const isFinished = m.status === 'finished';
  const t1Players = allPlayers.filter(p => p.team_id === m.team1_id && !p.is_official && p.status === 'approved');
  const t2Players = allPlayers.filter(p => p.team_id === m.team2_id && !p.is_official && p.status === 'approved');
  const getStatus = (pid) => {
    const c = checkinData.find(x => x.player_id === pid);
    return c ? c.status : 'pending';
  };
  const renderTeam = (teamId, teamName, players) => {
    const checked = players.filter(p => getStatus(p.id) === 'checked_in').length;
    const absent = players.filter(p => getStatus(p.id) === 'absent').length;
    return `<div class="lineup-section">
      <h4>${teamName} <span style="font-size:12px;font-weight:normal;color:var(--text-light)">已签到 ${checked}/${players.length}${absent ? ` · 缺阵 ${absent}` : ''}</span></h4>
      <div class="checkin-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">
        ${players.map(p => {
          const st = getStatus(p.id);
          let bg = '#F5F8F7', color = '#999', icon = '○', label = '未签到';
          if (st === 'checked_in') { bg = '#e8f5e9'; color = '#2e7d32'; icon = '✓'; label = '已签到'; }
          else if (st === 'absent') { bg = '#ffebee'; color = '#c62828'; icon = '✗'; label = '缺阵'; }
          const canOperate = canEdit && !isFinished && (isAdmin() || currentUser.team_id === teamId);
          return `<div style="background:${bg};border:1px solid #e0e0e0;border-radius:8px;padding:10px;display:flex;align-items:center;gap:8px">
            <span style="font-size:18px;color:${color};font-weight:700;width:24px;text-align:center">${icon}</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.jersey_number}号 ${escapeHtml(p.name)}</div>
              <div style="font-size:11px;color:${color}">${label}</div>
            </div>
            ${canOperate ? `<div style="display:flex;flex-direction:column;gap:2px">
              <button class="btn btn-sm" style="padding:2px 6px;font-size:10px;background:${st==='checked_in'?'#ccc':'#2e7d32'};color:#fff" onclick="checkInPlayer(${p.id},'checked_in')">签到</button>
              <button class="btn btn-sm" style="padding:2px 6px;font-size:10px;background:${st==='absent'?'#ccc':'#c62828'};color:#fff" onclick="checkInPlayer(${p.id},'absent')">缺阵</button>
            </div>` : ''}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  };
  const t1Name = escapeHtml(m.team1?.name) || '主队';
  const t2Name = escapeHtml(m.team2?.name) || '客队';
  document.getElementById('checkinContent').innerHTML = `
    ${isFinished ? '<div style="background:#fff3cd;padding:10px;border-radius:6px;font-size:13px;color:#856404;margin-bottom:12px">比赛已结束，签到信息不可修改</div>' : ''}
    ${!canEdit ? '<div style="background:#e3f2fd;padding:10px;border-radius:6px;font-size:13px;color:#1565c0;margin-bottom:12px">仅管理员和对应球队可操作签到</div>' : ''}
    ${isAdmin() ? `<div style="margin-bottom:12px;text-align:right"><a class="btn btn-sm btn-primary" href="/checkin.html" target="_blank">📱 打开现场扫码检录页（手机使用）</a></div>` : ''}
    ${renderTeam(m.team1_id, t1Name, t1Players)}
    ${renderTeam(m.team2_id, t2Name, t2Players)}
  `;
}
async function checkInPlayer(playerId, status) {
  try {
    const res = await fetch(`/api/matches/${matchDetailData.id}/checkin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: playerId, status })
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || '操作失败'); return; }
    loadCheckins(matchDetailData.id);
  } catch (e) { alert('操作失败：' + e.message); }
}

// 男11人制/女8人制：首发人数与单场大名单上限（替补均≤12）
function requiredStarters(m) { return (m && m.gender === 'women') ? 8 : 11; }
function maxMatchSquad(m) { return (m && m.gender === 'women') ? 20 : 23; }
function renderLineupTab(m) {
  if (!m.team1_id || !m.team2_id) return '<div class="empty-state">双方球队尚未确定</div>';
  const canEditTeam = (teamId) => {
    if (m.status === 'finished') return false;
    if (isAdmin()) return true;
    return currentUser && currentUser.team_id === teamId;
  };
  const canEditAny = isAdmin() || (currentUser && (currentUser.team_id === m.team1_id || currentUser.team_id === m.team2_id));
  const t1Players = allPlayers.filter(p => p.team_id === m.team1_id && !p.is_official && p.status === 'approved');
  const t2Players = allPlayers.filter(p => p.team_id === m.team2_id && !p.is_official && p.status === 'approved');
  const lineup = m.lineups || [];
  const isStarter = (pid) => lineup.some(l => l.player_id === pid && l.is_starter);
  const isSub = (pid) => lineup.some(l => l.player_id === pid && !l.is_starter);

  const renderTeam = (teamId, teamName, players) => {
    const editable = canEditTeam(teamId);
    return `
    <div class="lineup-section">
      <h4>${escapeHtml(teamName)}${currentUser && currentUser.team_id === teamId ? '（本队）' : ''}</h4>
      ${editable ? '<div style="margin-bottom:8px;font-size:12px;color:var(--text-light)">点击选择球员：金色=首发，绿色=替补，再次点击取消</div>' : '<div style="margin-bottom:8px;font-size:12px;color:var(--text-light)">金色=首发，绿色=替补</div>'}
      <div id="lineup_${teamId}">
        ${players.map(p => {
          const isSuspended = suspendedIds.has(p.id);
          let cls = 'player-checkbox';
          if (isStarter(p.id)) cls += ' selected starter';
          else if (isSub(p.id)) cls += ' selected';
          if (!editable || isSuspended) cls += ' locked';
          if (isSuspended) cls += ' suspended';
          const ci = Array.isArray(checkinData) ? checkinData.find(x => x.player_id === p.id) : null;
          const absentTag = (ci && ci.status === 'absent') ? '<span style="color:#c62828;font-size:10px;margin-left:4px">缺阵</span>' : '';
          const noCheckinTag = (!isGuest && (!ci || ci.status === 'pending')) ? '<span style="color:#ff9800;font-size:10px;margin-left:4px">未签到</span>' : '';
          const suspTag = isSuspended ? '<span style="color:#fff;background:#c62828;border-radius:4px;padding:0 4px;font-size:10px;margin-left:4px">停赛</span>' : '';
          const clickable = editable && !isSuspended;
          return `<span class="${cls}" data-pid="${p.id}" data-team="${teamId}" ${clickable?`onclick="toggleLineup(this)"`:''} title="${isSuspended?'该球员处于停赛期，不能进入本场阵容':(ci && ci.status==='absent'?'该球员已标记缺阵':'')}">
            ${p.jersey_number} ${escapeHtml(p.name)}${absentTag}${noCheckinTag}${suspTag}
          </span>`;
        }).join('')}
      </div>
    </div>`;
  };

  return renderTeam(m.team1_id, m.team1.name, t1Players) + renderTeam(m.team2_id, m.team2.name, t2Players)
    + (canEditAny && m.status !== 'finished' ? `
      <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
        ${isAdmin() ? '<button class="btn btn-primary" onclick="saveLineup()">保存阵容</button>' : ''}
        ${!isAdmin() && currentUser && (currentUser.team_id === m.team1_id || currentUser.team_id === m.team2_id) ? '<button class="btn btn-success" onclick="submitMatchLineup()">✅ 提交首发阵容</button>' : ''}
      </div>
      ${!isAdmin() ? `<div style="margin-top:8px;font-size:12px;color:var(--text-light)">提交后首发${requiredStarters(m)}人+替补名单将发送给管理员审核，提交后不可修改（男子11人制/女子8人制，替补均不超过12人）。</div>` : ''}
    ` : '');
}

let lineupSelection = {};
function toggleLineup(el) {
  const pid = +el.dataset.pid;
  const teamId = +el.dataset.team;
  if (!lineupSelection[teamId]) lineupSelection[teamId] = { starters: new Set(), subs: new Set() };
  // 从已有阵容初始化
  if (!lineupSelection[teamId].initialized) {
    lineupSelection[teamId].initialized = true;
    (matchDetailData.lineups || []).filter(l => l.team_id === teamId).forEach(l => {
      if (l.is_starter) lineupSelection[teamId].starters.add(l.player_id);
      else lineupSelection[teamId].subs.add(l.player_id);
    });
  }
  const sel = lineupSelection[teamId];
  if (sel.starters.has(pid)) { sel.starters.delete(pid); sel.subs.add(pid); }
  else if (sel.subs.has(pid)) { sel.subs.delete(pid); }
  else { sel.starters.add(pid); }
  // 重新渲染
  el.classList.remove('selected', 'starter');
  if (sel.starters.has(pid)) el.classList.add('selected', 'starter');
  else if (sel.subs.has(pid)) el.classList.add('selected');
}

async function saveLineup() {
  const m = matchDetailData;
  // 确定可保存的球队：管理员可保存双方，访客只保存本队
  const editableTeamIds = [m.team1_id, m.team2_id].filter(tid => isAdmin() || currentUser.team_id === tid);
  // 保存前实时获取最新签到数据，避免预加载未完成导致校验失效
  try {
    const ciRes = await fetch(`/api/matches/${m.id}/checkins`);
    if (ciRes.ok) checkinData = await ciRes.json();
  } catch (e) { checkinData = []; }
  // 校验：未签到/缺阵球员不能进入首发
  for (const teamId of editableTeamIds) {
    if (!lineupSelection[teamId] || !lineupSelection[teamId].initialized) continue;
    const sel = lineupSelection[teamId];
    for (const pid of sel.starters) {
      const ci = checkinData.find(x => x.player_id === pid);
      const player = allPlayers.find(p => p.id === pid);
      if (!ci || ci.status !== 'checked_in') {
        const reason = ci && ci.status === 'absent' ? '已标记缺阵' : '未签到';
        alert(`保存失败：${player?.jersey_number || ''}号 ${player?.name || '球员'} ${reason}，不能进入首发阵容。请先在"签到"页完成签到。`);
        return;
      }
    }
  }
  for (const teamId of editableTeamIds) {
    if (!lineupSelection[teamId] || !lineupSelection[teamId].initialized) continue;
    const sel = lineupSelection[teamId];
    const allSel = [...sel.starters, ...sel.subs];
    const squadMax = maxMatchSquad(m);
    if (allSel.length > squadMax) { alert(`单场大名单最多${squadMax}人，当前选择了${allSel.length}人`); return; }
    const susp = allSel.filter(pid => suspendedIds.has(pid)).map(pid => allPlayers.find(p => p.id === pid)?.name).filter(Boolean);
    if (susp.length) { alert(`以下球员处于停赛期，不能进入阵容：${susp.join('、')}`); return; }
    const player_ids = [
      ...[...sel.starters].map(pid => ({ player_id: pid, is_starter: true })),
      ...[...sel.subs].map(pid => ({ player_id: pid, is_starter: false })),
    ];
    const saveRes = await fetch(`/api/matches/${m.id}/lineup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: teamId, player_ids })
    });
    if (!saveRes.ok) {
      const err = await saveRes.json();
      alert('阵容保存失败：' + (err.error || '未知错误'));
      return;
    }
  }
  alert('阵容保存成功');
  const res = await fetch('/api/matches/' + m.id);
  matchDetailData = await res.json();
}

// 访客提交比赛首发阵容
async function submitMatchLineup() {
  const m = matchDetailData;
  const teamId = currentUser.team_id;
  if (!teamId) { alert('账号未绑定球队'); return; }
  if (m.team1_id !== teamId && m.team2_id !== teamId) { alert('本队不参与这场比赛'); return; }
  if (!lineupSelection[teamId] || !lineupSelection[teamId].initialized) {
    // 从已有阵容初始化
    lineupSelection[teamId] = { starters: new Set(), subs: new Set(), initialized: true };
    (m.lineups || []).filter(l => l.team_id === teamId).forEach(l => {
      if (l.is_starter) lineupSelection[teamId].starters.add(l.player_id);
      else lineupSelection[teamId].subs.add(l.player_id);
    });
  }
  const sel = lineupSelection[teamId];
  const starters = [...sel.starters];
  const subs = [...sel.subs];
  const needStarters = requiredStarters(m);
  const squadMax = maxMatchSquad(m);
  if (starters.length !== needStarters) {
    alert(`首发必须是${needStarters}人，当前选择了${starters.length}人。\n请点击球员选择：第一次点击=首发，第二次点击=替补，第三次点击=取消。`);
    return;
  }
  if (subs.length > 12 || starters.length + subs.length > squadMax) {
    alert(`单场大名单最多${squadMax}人（${needStarters}名首发+最多12名替补），当前替补${subs.length}人、共${starters.length + subs.length}人，请减少替补。`);
    return;
  }
  const starterObjs = starters.map(pid => allPlayers.find(p => p.id === pid)).filter(Boolean);
  if (!starterObjs.some(p => p.position === '门将')) {
    alert(`首发${needStarters}人中必须包含至少1名门将。`);
    return;
  }
  const suspIn = [...starters, ...subs].filter(pid => suspendedIds.has(pid)).map(pid => allPlayers.find(p => p.id === pid)?.name).filter(Boolean);
  if (suspIn.length) {
    alert(`以下球员处于停赛期，不能进入本场阵容：${suspIn.join('、')}`);
    return;
  }
  const player_ids = [
    ...starters.map(pid => ({ player_id: pid, is_starter: 1 })),
    ...subs.map(pid => ({ player_id: pid, is_starter: 0 }))
  ];
  const teamName = (m.team1_id === teamId ? m.team1?.name : m.team2?.name) || '本队';
  if (!confirm(`确认提交 ${teamName} 的首发阵容？\n\n首发：${starters.length}人\n替补：${subs.length}人\n\n提交后将发送给管理员，且不可修改。`)) return;
  try {
    const res = await fetch(`/api/matches/${m.id}/lineup/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_ids })
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || '提交失败'); return; }
    alert('首发阵容提交成功！');
    const res2 = await fetch('/api/matches/' + m.id);
    matchDetailData = await res2.json();
    const lineupEl = document.getElementById('tab-lineup');
    if (lineupEl) lineupEl.innerHTML = renderLineupTab(matchDetailData);
  } catch (e) { alert('提交失败：' + e.message); }
}

// 比分录入规则
function scoreRules(m) {
  if (m.gender === 'women') return { canDraw: true, canPen: false, hint: '女子组单循环，比赛允许平局，不设点球大战。' };
  const rg = String(m.round_group || '');
  if (rg === 'A' || rg === 'B') return { canDraw: false, canPen: true, hint: '男子小组赛不设平局，战平须进行点球大战。' };
  return { canDraw: false, canPen: true, hint: '附加赛、半决赛、季军赛、决赛均不设平局，战平直接罚球点球决胜。' };
}

function renderScoreTab(m) {
  if (!m.team1_id || !m.team2_id) return '<div class="empty-state">双方球队尚未确定</div>';
  if (!isAdmin() || m.status === 'finished') {
    if (m.status !== 'finished') return '<div class="empty-state">比赛尚未结束</div>';
    return `<div class="score-input-group">
      <div class="team-label left">${escapeHtml(m.team1.name)}</div>
      <div style="font-size:24px;font-weight:700">${m.team1_score ?? '-'} : ${m.team2_score ?? '-'}</div>
      <div class="team-label">${escapeHtml(m.team2.name)}</div>
    </div>${m.ht_team1_score!=null?`<div style="text-align:center;color:var(--text-light);font-size:13px">半场 ${m.ht_team1_score} : ${m.ht_team2_score}</div>`:''}${m.has_penalty ? `<div style="text-align:center">点球大战：${m.penalty_team1} : ${m.penalty_team2}</div>` : ''}
    ${m.mvp_player ? `<div style="text-align:center;margin-top:10px"><span style="background:linear-gradient(135deg,#FFD700,#FFA500);color:#fff;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:600">🏆 MVP：${m.mvp_player.jersey_number}号 ${escapeHtml(m.mvp_player.name)}</span></div>` : ''}
    <div style="text-align:center;margin-top:12px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
      <button class="btn btn-sm btn-primary" onclick="openMatchReport(${m.id})">📰 生成战报</button>
      ${isAdmin() ? '<button class="btn btn-sm" onclick="recalcScore()">↻ 按进球事件重算比分</button>' : ''}
    </div>`;
  }

  const s1 = m.status === 'finished' ? m.team1_score : '';
  const s2 = m.status === 'finished' ? m.team2_score : '';
  const hasPen = m.has_penalty ? 'checked' : '';
  const rules = scoreRules(m);
  const t1Players = allPlayers.filter(p => p.team_id === m.team1_id && !p.is_official && p.status === 'approved');
  const t2Players = allPlayers.filter(p => p.team_id === m.team2_id && !p.is_official && p.status === 'approved');

  return `
    ${renderScheduleOps(m)}
    <div class="score-input-group">
      <div class="team-label left">${escapeHtml(m.team1.name)}</div>
      <input type="number" id="score1" value="${s1}" min="0" style="width:60px">
      <span class="vs">:</span>
      <input type="number" id="score2" value="${s2}" min="0" style="width:60px">
      <div class="team-label">${escapeHtml(m.team2.name)}</div>
    </div>
    <div style="text-align:center;margin-bottom:14px">
      <span style="font-size:13px;color:var(--text-light)">上半场比分：</span>
      <input type="number" id="htScore1" value="${m.ht_team1_score??''}" min="0" style="width:56px"> :
      <input type="number" id="htScore2" value="${m.ht_team2_score??''}" min="0" style="width:56px">
    </div>
    <div style="text-align:center;margin-bottom:6px;font-size:13px;color:var(--text-light)">${rules.hint}</div>
    <div style="text-align:center;margin-bottom:16px">
      ${rules.canPen ? `<label style="cursor:pointer"><input type="checkbox" id="hasPenalty" ${hasPen} onchange="document.getElementById('penaltySection').style.display=this.checked?'':'none'"> 战平，罚球点球决胜</label>` : ''}
    </div>
    ${rules.canPen ? `<div id="penaltySection" style="${m.has_penalty?'':'display:none'}">
      <div style="font-weight:600;margin-bottom:10px;color:var(--primary)">点球大战记录</div>
      <div id="penaltyRounds"></div>
      <button class="btn btn-outline btn-sm" onclick="addPenaltyRound()" style="margin-top:8px">+ 添加轮次</button>
    </div>` : ''}
    <div style="margin-top:16px">
      <label style="display:block;font-weight:600;margin-bottom:6px">本场MVP（可选）</label>
      <select id="mvpPlayer" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px">
        <option value="">不评选</option>
        <optgroup label="${escapeHtml(m.team1.name)}">
          ${t1Players.map(p=>`<option value="${p.id}" ${m.mvp_player_id===p.id?'selected':''}>${p.jersey_number}号 ${escapeHtml(p.name)}</option>`).join('')}
        </optgroup>
        <optgroup label="${escapeHtml(m.team2.name)}">
          ${t2Players.map(p=>`<option value="${p.id}" ${m.mvp_player_id===p.id?'selected':''}>${p.jersey_number}号 ${escapeHtml(p.name)}</option>`).join('')}
        </optgroup>
      </select>
    </div>
    <div style="margin-top:20px;text-align:center">
      <button class="btn btn-primary" onclick="submitScore()">${m.status === 'finished' ? '修改比分' : '提交比分'}</button>
    </div>
  `;
}

function renderPenaltyRounds() {
  const m = matchDetailData;
  const t1Players = allPlayers.filter(p => p.team_id === m.team1_id && !p.is_official && p.status === 'approved');
  const t2Players = allPlayers.filter(p => p.team_id === m.team2_id && !p.is_official && p.status === 'approved');
  const maxRound = penaltyData.length ? Math.max(...penaltyData.map(p => p.round_number)) : 0;
  let html = '';
  for (let r = 1; r <= Math.max(maxRound, 5); r++) {
    const t1p = penaltyData.find(p => p.round_number === r && p.team_id === m.team1_id);
    const t2p = penaltyData.find(p => p.round_number === r && p.team_id === m.team2_id);
    html += `<div style="margin-bottom:10px">
      <div style="font-size:12px;color:var(--text-light);margin-bottom:4px">第 ${r} 轮</div>
      <div class="penalty-round">
        <div class="penalty-row">
          <span style="min-width:80px;font-size:12px">${escapeHtml(m.team1.name)}</span>
          <select onchange="updatePenalty(${r},${m.team1_id},'player',this.value)">
            <option value="">选择球员</option>
            ${t1Players.map(p=>`<option value="${p.id}" ${t1p&&t1p.player_id===p.id?'selected':''}>${p.jersey_number} ${escapeHtml(p.name)}</option>`).join('')}
          </select>
          <button class="penalty-result ${t1p&&t1p.scored?'penalty-scored':'penalty-missed'}"
            onclick="togglePenaltyScored(${r},${m.team1_id},this)">
            ${t1p ? (t1p.scored ? '进' : '失') : '未设'}
          </button>
        </div>
        <div class="penalty-row">
          <span style="min-width:80px;font-size:12px">${escapeHtml(m.team2.name)}</span>
          <select onchange="updatePenalty(${r},${m.team2_id},'player',this.value)">
            <option value="">选择球员</option>
            ${t2Players.map(p=>`<option value="${p.id}" ${t2p&&t2p.player_id===p.id?'selected':''}>${p.jersey_number} ${escapeHtml(p.name)}</option>`).join('')}
          </select>
          <button class="penalty-result ${t2p&&t2p.scored?'penalty-scored':'penalty-missed'}"
            onclick="togglePenaltyScored(${r},${m.team2_id},this)">
            ${t2p ? (t2p.scored ? '进' : '失') : '未设'}
          </button>
        </div>
      </div>
    </div>`;
  }
  document.getElementById('penaltyRounds').innerHTML = html;
}

function updatePenalty(round, teamId, field, value) {
  let p = penaltyData.find(x => x.round_number === round && x.team_id === teamId);
  if (!p) { p = { round_number: round, team_id: teamId, player_id: null, scored: 0 }; penaltyData.push(p); }
  if (field === 'player') p.player_id = +value;
}

function togglePenaltyScored(round, teamId, btn) {
  let p = penaltyData.find(x => x.round_number === round && x.team_id === teamId);
  if (!p) { p = { round_number: round, team_id: teamId, player_id: null, scored: 0 }; penaltyData.push(p); }
  p.scored = p.scored ? 0 : 1;
  btn.textContent = p.scored ? '进' : '失';
  btn.className = 'penalty-result ' + (p.scored ? 'penalty-scored' : 'penalty-missed');
}

function addPenaltyRound() {
  renderPenaltyRounds();
}

function renderEventsTab(m) {
  if (!m.team1_id || !m.team2_id) return '<div class="empty-state">双方球队尚未确定</div>';

  // 已有事件列表
  let eventsHtml = '';
  if (matchEvents.length) {
    eventsHtml = '<ul class="event-list">' + matchEvents.map((e, i) => {
      const icon = e.event_type === 'goal' ? '⚽' : e.event_type === 'own_goal' ? '🦶' : e.event_type === 'assist' ? '🅰' : e.event_type === 'yellow' ? '🟨' : e.event_type === 'red' ? '🟥' : '🔄';
      const cls = e.event_type === 'goal' ? 'event-goal' : e.event_type === 'yellow' ? 'event-yellow' : e.event_type === 'red' ? 'event-red' : 'event-sub';
      let text = '';
      const pn = e.player_name ? `${escapeHtml(e.player_name)}(${e.jersey_number || '-'})` : '未登记球员';
      if (e.event_type === 'goal') text = `${pn} 进球${e.is_penalty_kick ? ' (点球)' : ''}`;
      else if (e.event_type === 'own_goal') text = `${pn} 乌龙球（计对方进球）`;
      else if (e.event_type === 'assist') text = `${pn} 助攻`;
      else if (e.event_type === 'yellow') text = `${pn} 黄牌${e.notes ? ' - ' + escapeHtml(e.notes) : ''}`;
      else if (e.event_type === 'red') text = `${pn} 红牌${e.notes ? ' - ' + escapeHtml(e.notes) : ''}`;
      else if (e.event_type === 'sub') text = `${pn} ↓ 换上 ${escapeHtml(e.sub_in_name) || '未登记球员'}${e.sub_window?`（窗口${e.sub_window}）`:''}`;
      return `<li class="event-item">
        <span class="event-minute">${e.minute}'</span>
        <span class="event-icon ${cls}">${icon}</span>
        <span>${escapeHtml(e.team_name)} - ${text}</span>
        ${(isAdmin() && m.status !== 'finished') ? `<button class="btn btn-sm" style="margin-left:auto" onclick="editEvent(${e.id})">改</button><button class="btn btn-sm btn-danger" onclick="removeEvent(${e.id || i})">×</button>` : ''}
      </li>`;
    }).join('') + '</ul>';
  } else {
    eventsHtml = '<div class="empty-state" style="padding:20px">暂无比赛事件</div>';
  }

  // 添加事件表单
  let addForm = '';
  if (isAdmin() && m.status !== 'finished') {
    const t1Players = allPlayers.filter(p => p.team_id === m.team1_id && !p.is_official);
    const t2Players = allPlayers.filter(p => p.team_id === m.team2_id && !p.is_official);
    const playerOptions = (players) => `<option value="">选择球员</option>${players.map(p=>`<option value="${p.id}">${p.jersey_number} ${escapeHtml(p.name)}</option>`).join('')}`;
    addForm = `
      <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
        <div style="font-weight:600;margin-bottom:10px">添加事件</div>
        <div class="event-form-row">
          <input type="number" id="ev_minute" placeholder="分钟" min="0" max="90" style="width:60px">
          <select id="ev_team" onchange="updateEventPlayers()">
            <option value="${m.team1_id}">${escapeHtml(m.team1.name)}</option>
            <option value="${m.team2_id}">${escapeHtml(m.team2.name)}</option>
          </select>
          <select id="ev_type" onchange="toggleEventFields()">
            <option value="goal">⚽ 进球</option>
            <option value="assist">🅰 助攻</option>
            <option value="own_goal">🦶 乌龙球</option>
            <option value="yellow">🟨 黄牌</option>
            <option value="red">🟥 红牌</option>
            <option value="sub">🔄 换人</option>
          </select>
          <select id="ev_player">${playerOptions(t1Players)}</select>
          <button class="btn btn-primary btn-sm" onclick="addEvent()">添加</button>
        </div>
        <div id="ev_penalty" style="margin-top:6px;display:none">
          <label style="font-size:12px;cursor:pointer"><input type="checkbox" id="ev_is_penalty"> 此进球为点球</label>
        </div>
        <div id="ev_subin" style="margin-top:6px;display:none">
          <select id="ev_sub_player" style="width:200px">${playerOptions(t1Players)}</select>
          <span style="font-size:12px;color:var(--text-light);margin-left:8px">换上球员</span>
          <select id="ev_subwin" style="width:130px;margin-left:10px">
            <option value="1">第1换人窗口</option>
            <option value="2">第2换人窗口</option>
            <option value="3">第3换人窗口</option>
          </select>
          <span style="font-size:12px;color:var(--text-light);margin-left:6px">全场共3个窗口（中场不计），累计换上≤12人，被换下者不得再上</span>
        </div>
        <div id="ev_notes_div" style="margin-top:6px;display:none">
          <input type="text" id="ev_notes" placeholder="犯规/判罚原因（选填）" style="width:300px">
        </div>
      </div>`;
  }

  return eventsHtml + addForm;
}

// ========== 赛务调整：改期 / 中断补赛 / 弃权 ==========
function renderScheduleOps(m) {
  if (!isAdmin()) return '';

  const noteLine = m.schedule_note ? `<div style="background:#e8f5e9;border:1px solid #a5d6a7;color:#2e7d32;border-radius:8px;padding:8px 10px;font-size:12px;margin-bottom:10px">📌 ${escapeHtml(m.schedule_note)}</div>` : '';
  return `<details style="border:1px solid #ffb74d;background:#fff8e1;border-radius:10px;margin-bottom:14px">
    <summary style="padding:9px 12px;cursor:pointer;font-size:13px;font-weight:600;color:#e65100">🛟 改期 / 中断补赛 / 弃权判负（赛务专用，谨慎操作）</summary>
    <div style="padding:10px 12px">
      ${noteLine}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px">
          <div style="font-weight:600;font-size:13px;margin-bottom:6px">① 未开赛改期</div>
          <input type="date" id="rs_date1" style="width:100%;margin-bottom:6px">
          <input type="time" id="rs_time1" style="width:100%;margin-bottom:6px">
          <input type="text" id="rs_note1" placeholder="原因（选填）" maxlength="100" style="width:100%;margin-bottom:6px">
          <button class="btn btn-sm btn-outline" onclick="rescheduleMatch('postpone')">改期并清空阵容/检录</button>
        </div>
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px">
          <div style="font-weight:600;font-size:13px;margin-bottom:6px">② 上半场前中断→改日全场重赛</div>
          <input type="date" id="rs_date2" style="width:100%;margin-bottom:6px">
          <input type="time" id="rs_time2" style="width:100%;margin-bottom:6px">
          <input type="text" id="rs_note2" placeholder="原因（选填，黄红牌保留）" maxlength="100" style="width:100%;margin-bottom:6px">
          <button class="btn btn-sm btn-outline" onclick="rescheduleMatch('replay_full')">清比分/阵容、保留纪律并重赛</button>
        </div>
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px">
          <div style="font-weight:600;font-size:13px;margin-bottom:6px">③ 下半场后中断→以当前比分结束</div>
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
            ${escapeHtml(m.team1?.name)||'一方'} <input type="number" id="rs_s1" min="0" style="width:56px"> :
            <input type="number" id="rs_s2" min="0" style="width:56px"> ${escapeHtml(m.team2?.name)||'另一方'}
          </div>
          <input type="text" id="rs_note3" placeholder="说明（选填）" maxlength="100" style="width:100%;margin-bottom:6px">
          <button class="btn btn-sm btn-outline" onclick="rescheduleMatch('finish_current')">按此比分完赛并推进晋级</button>
        </div>
        <div style="border:1px solid #ef9a9a;background:#ffebee;border-radius:8px;padding:10px">
          <div style="font-weight:600;font-size:13px;margin-bottom:6px;color:#c62828">④ 一方弃权→判0:3</div>
          <select id="wo_team" style="width:100%;margin-bottom:6px">
            <option value="">选择弃权方</option>
            <option value="${m.team1_id}">${escapeHtml(m.team1?.name)||''} 弃权</option>
            <option value="${m.team2_id}">${escapeHtml(m.team2?.name)||''} 弃权</option>
          </select>
          <input type="text" id="wo_note" placeholder="说明（选填）" maxlength="100" style="width:100%;margin-bottom:6px">
          <button class="btn btn-sm btn-danger" onclick="walkoverMatch()">判弃权 0:3</button>
        </div>
      </div>
      <p style="font-size:12px;color:var(--text-light);margin:8px 0 0">说明：①用于开赛前调整时间；②中断于上半场结束前，比分/进球/换人/阵容清零但已得黄红牌继续计入累计；③中断于下半场开始后，以中断比分完赛；④固定计3:0，计积分与净胜球但不产生个人进球。</p>
    </div>
  </details>`;
}
async function rescheduleMatch(mode) {
  const m = matchDetailData;
  const body = { mode };
  if (mode === 'postpone' || mode === 'replay_full') {
    const i = mode === 'postpone' ? '1' : '2';
    body.match_date = document.getElementById('rs_date'+i).value;
    body.match_time = document.getElementById('rs_time'+i).value;
    body.note = document.getElementById('rs_note'+i).value.trim();
    if (!body.match_date || !body.match_time) { alert('请填写日期和时间'); return; }
    const tip = mode === 'postpone' ? '确认未开赛改期？将清空本场阵容与检录。' : '确认中断并改日全场重赛？比分/进球/换人/阵容将清空，已出示黄红牌保留并继续计入累计。';
    if (!confirm(tip)) return;
  } else if (mode === 'finish_current') {
    body.team1_score = +document.getElementById('rs_s1').value;
    body.team2_score = +document.getElementById('rs_s2').value;
    body.note = document.getElementById('rs_note3').value.trim();
    if (!Number.isInteger(body.team1_score) || !Number.isInteger(body.team2_score) || body.team1_score===body.team2_score) {
      alert('请填写分出胜负的非负整数比分（不允许平局）'); return;
    }
    if (!confirm(`确认以 ${body.team1_score}:${body.team2_score} 当前比分结束比赛并推进晋级？`)) return;
  }
  const res = await fetch(`/api/matches/${m.id}/reschedule`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const d = await res.json().catch(()=>({}));
  if (!res.ok) { alert(d.error||'操作失败'); return; }
  alert('操作成功，已通知双方球队与裁判组');
  closeModal('matchModal');
  await loadAllData();
}
async function walkoverMatch() {
  const m = matchDetailData;
  const forfeit = +document.getElementById('wo_team').value;
  if (!forfeit) { alert('请选择弃权方'); return; }
  const note = document.getElementById('wo_note').value.trim();
  if (!confirm('确认判该方弃权、对方3:0获胜？将计积分与净胜球、正常推进晋级，且不产生个人进球。')) return;
  const res = await fetch(`/api/matches/${m.id}/walkover`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ walkover_team_id: forfeit, note }) });
  const d = await res.json().catch(()=>({}));
  if (!res.ok) { alert(d.error||'操作失败'); return; }
  alert('弃权判定成功');
  closeModal('matchModal');
  await loadAllData();
}


function toggleEventFields() {
  const type = document.getElementById('ev_type').value;
  document.getElementById('ev_penalty').style.display = type === 'goal' ? '' : 'none';
  document.getElementById('ev_subin').style.display = type === 'sub' ? '' : 'none';
  document.getElementById('ev_notes_div').style.display = (type === 'yellow' || type === 'red') ? '' : 'none';
}


function updateEventPlayers() {
  const teamId = +document.getElementById('ev_team').value;
  const players = allPlayers.filter(p => p.team_id === teamId && !p.is_official && p.status === 'approved');
  const opts = '<option value="">选择球员</option>' + players.map(p => '<option value="' + p.id + '">' + p.jersey_number + ' ' + escapeHtml(p.name) + '</option>').join('');
  document.getElementById('ev_player').innerHTML = opts;
  const subSel = document.getElementById('ev_sub_player');
  if (subSel) subSel.innerHTML = opts;
}

async function addEvent() {
  const minute = +document.getElementById('ev_minute').value;
  const teamId = +document.getElementById('ev_team').value;
  const type = document.getElementById('ev_type').value;
  const playerId = +document.getElementById('ev_player').value;
  if (!minute || !playerId) { alert('请填写分钟和球员'); return; }
  const notes = (document.getElementById('ev_notes')?.value || '').trim();
  const ev = { event_type: type, team_id: teamId, player_id: playerId, minute, is_penalty_kick: 0, sub_in_player_id: null, notes };
  if (type === 'goal') ev.is_penalty_kick = document.getElementById('ev_is_penalty').checked ? 1 : 0;
  if (type === 'sub') {
    const subIn = +document.getElementById('ev_sub_player').value;
    if (!subIn) { alert('请选择换上球员'); return; }
    ev.sub_in_player_id = subIn;
    ev.sub_window = +(document.getElementById('ev_subwin')?.value || 0) || 0;
  }

  const res = await fetch(`/api/matches/${matchDetailData.id}/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev)
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || '添加失败'); return; }
  if (data.auto_red) {
    alert('该球员本场已累计两张黄牌，自动转为红牌罚下！');
  }
  if (Array.isArray(data.warnings) && data.warnings.length) {
    alert('换人规则提醒（已保存，请核对）：\n' + data.warnings.join('\n'));
  }
  // 重新加载比赛详情
  await loadAllData();
  await openMatch(matchDetailData.id);
  document.querySelector('#matchTabs .tab[data-tab="events"]').click();
}

async function removeEvent(eventId) {
  if (!confirm('确定删除该事件？')) return;
  const res = await fetch(`/api/matches/${matchDetailData.id}/events/${eventId}`, { method: 'DELETE' });
  if (!res.ok) { alert('删除失败'); return; }
  await loadAllData();
  await openMatch(matchDetailData.id);
  document.querySelector('#matchTabs .tab[data-tab="events"]').click();
}

// A4 编辑比赛事件
let editingEventId = null;
function editEvent(eventId) {
  const m = matchDetailData;
  const e = matchEvents.find(x => x.id === eventId);
  if (!e) return alert('未找到该事件');
  editingEventId = eventId;
  const teamPlayers = (tid) => allPlayers.filter(p => p.team_id === tid && !p.is_official && p.status === 'approved');
  const playerOpts = (tid, sel) => '<option value="">选择球员</option>' + teamPlayers(tid).map(p => `<option value="${p.id}" ${p.id===sel?'selected':''}>${p.jersey_number} ${escapeHtml(p.name)}</option>`).join('');
  document.getElementById('genericModalTitle').textContent = '编辑比赛事件';
  document.getElementById('genericModalBody').innerHTML = `
    <div class="form-row">
      <div class="form-group"><label>分钟</label><input type="number" id="ee_minute" min="0" max="130" value="${e.minute||''}"></div>
      <div class="form-group"><label>所属球队</label>
        <select id="ee_team" onchange="eeTeamChange()">
          <option value="${m.team1_id}" ${e.team_id===m.team1_id?'selected':''}>${escapeHtml(m.team1.name)}</option>
          <option value="${m.team2_id}" ${e.team_id===m.team2_id?'selected':''}>${escapeHtml(m.team2.name)}</option>
        </select>
      </div>
      <div class="form-group"><label>类型</label>
        <select id="ee_type" onchange="eeTypeChange()">
          <option value="goal" ${e.event_type==='goal'?'selected':''}>进球</option>
          <option value="assist" ${e.event_type==='assist'?'selected':''}>助攻</option>
          <option value="own_goal" ${e.event_type==='own_goal'?'selected':''}>乌龙球</option>
          <option value="yellow" ${e.event_type==='yellow'?'selected':''}>黄牌</option>
          <option value="red" ${e.event_type==='red'?'selected':''}>红牌</option>
          <option value="sub" ${e.event_type==='sub'?'selected':''}>换人</option>
        </select>
      </div>
    </div>
    <div class="form-group"><label>涉及球员</label><select id="ee_player">${playerOpts(+e.team_id||m.team1_id, e.player_id)}</select></div>
    <div class="form-group" id="ee_penalty_wrap"><label style="font-size:13px;cursor:pointer"><input type="checkbox" id="ee_penalty" ${e.is_penalty_kick?'checked':''}> 此进球为点球</label></div>
    <div class="form-group" id="ee_subin_wrap" style="display:none"><label>换上球员（换人时）</label><select id="ee_subin">${playerOpts(+e.team_id||m.team1_id, e.sub_in_player_id)}</select></div>
    <div class="form-group"><label>备注</label><input type="text" id="ee_notes" maxlength="100" value="${escapeHtml(e.notes)||''}"></div>
    <div style="text-align:right;margin-top:10px"><button class="btn" onclick="closeModal('genericModal')">取消</button>
    <button class="btn btn-primary" onclick="saveEventEdit()">保存修改</button></div>
    <p style="font-size:12px;color:var(--text-light);margin-top:8px">提示：修改进球/乌龙后，已结束比赛的比分将按进球事件自动重算；红黄牌停赛不会因改类型自动增减，请到停赛页人工核对。</p>`;
  showModal('genericModal');
  eeTypeChange();
}
function eeTeamChange() {
  const tid = +document.getElementById('ee_team').value;
  const players = allPlayers.filter(p => p.team_id === tid && !p.is_official && p.status === 'approved');
  const opts = '<option value="">选择球员</option>' + players.map(p => `<option value="${p.id}">${p.jersey_number} ${escapeHtml(p.name)}</option>`).join('');
  document.getElementById('ee_player').innerHTML = opts;
  const sub = document.getElementById('ee_subin'); if (sub) sub.innerHTML = opts;
}
function eeTypeChange() {
  const t = document.getElementById('ee_type').value;
  document.getElementById('ee_penalty_wrap').style.display = t === 'goal' ? '' : 'none';
  document.getElementById('ee_subin_wrap').style.display = t === 'sub' ? '' : 'none';
}
async function saveEventEdit() {
  const body = {
    event_type: document.getElementById('ee_type').value,
    team_id: +document.getElementById('ee_team').value,
    player_id: +document.getElementById('ee_player').value || null,
    minute: +document.getElementById('ee_minute').value || 0,
    is_penalty_kick: document.getElementById('ee_penalty').checked ? 1 : 0,
    sub_in_player_id: +(document.getElementById('ee_subin')?.value || 0) || null,
    notes: document.getElementById('ee_notes').value.trim()
  };
  if (!body.minute || !body.player_id) { alert('请填写分钟和涉及球员'); return; }
  const res = await fetch(`/api/matches/${matchDetailData.id}/events/${editingEventId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { alert(d.error || '保存失败'); return; }
  closeModal('genericModal');
  await loadAllData();
  await openMatch(matchDetailData.id);
  document.querySelector('#matchTabs .tab[data-tab="events"]').click();
  if (d.recalced) alert(`已按进球事件重算比分：${d.recalced.s1} : ${d.recalced.s2}`);
}

// A4 一键按进球事件重算比分
async function recalcScore() {
  if (!confirm('将根据本场全部“进球事件”重新统计比分并覆盖当前比分，是否继续？')) return;
  const res = await fetch(`/api/matches/${matchDetailData.id}/recalc-score`, { method: 'POST' });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { alert(d.error || '重算失败'); return; }
  alert(`重算完成：${d.s1} : ${d.s2}`);
  await loadAllData(); await openMatch(matchDetailData.id);
  document.querySelector('#matchTabs .tab[data-tab="score"]').click();
}

// 裁判下拉去重：已选裁判不出现在其他下拉中
function updateRefSelects() {
  const selMain = document.getElementById('m_ref');
  const selA1 = document.getElementById('m_ref1');
  const selA2 = document.getElementById('m_ref2');
  const selFourth = document.getElementById('m_fourth');
  if (!selMain || !selA1 || !selA2) return;
  const mainVal = selMain.value;
  const a1Val = selA1.value;
  const a2Val = selA2.value;
  const fourthVal = selFourth ? selFourth.value : '';
  const usedByMain = new Set([a1Val, a2Val, fourthVal].filter(Boolean).map(Number));
  const usedByA1 = new Set([mainVal, a2Val, fourthVal].filter(Boolean).map(Number));
  const usedByA2 = new Set([mainVal, a1Val, fourthVal].filter(Boolean).map(Number));
  const usedByFourth = new Set([mainVal, a1Val, a2Val].filter(Boolean).map(Number));

  function rebuild(sel, filterFn, usedSet, currentVal, withLevel, emptyLabel) {
    const options = [`<option value="">${emptyLabel || '未指派'}</option>`];
    allReferees.filter(filterFn).forEach(r => {
      if (usedSet.has(r.id) && String(r.id) !== String(currentVal)) return;
      const label = withLevel ? `${escapeHtml(r.name)}(${escapeHtml(r.level)})` : escapeHtml(r.name);
      options.push(`<option value="${r.id}" ${String(r.id)===String(currentVal)?'selected':''}>${label}</option>`);
    });
    sel.innerHTML = options.join('');
  }
  rebuild(selMain, r => canFillPosition(r,'main'), usedByMain, mainVal, true);
  rebuild(selA1, r => canFillPosition(r,'assistant'), usedByA1, a1Val, true);
  rebuild(selA2, r => canFillPosition(r,'assistant'), usedByA2, a2Val, true);
  if (selFourth) rebuild(selFourth, r => canFillPosition(r,'fourth'), usedByFourth, fourthVal, true, '本场比赛不设第四官员');
}

async function saveMatchBasic() {
  const m = matchDetailData;
  const data = {
    match_date: document.getElementById('m_date').value,
    match_time: document.getElementById('m_time').value,
    match_location: document.getElementById('m_loc').value,
    main_referee_id: +document.getElementById('m_ref').value || null,
    assistant_ref1_id: +document.getElementById('m_ref1').value || null,
    assistant_ref2_id: +document.getElementById('m_ref2').value || null,
    fourth_official_id: (+(document.getElementById('m_fourth')||{value:''}).value) || null,

    status: document.getElementById('m_status').value,
  };
  const res = await fetch(`/api/matches/${m.id}/basic`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  if (res.ok) {
    const d = await res.json().catch(()=>({}));
    await loadAllData(); openMatch(m.id);
    if (Array.isArray(d.warnings) && d.warnings.length) alert('保存成功。\n\n选派提醒：\n' + d.warnings.join('\n'));
    else alert('保存成功');
  }
  else { const d = await res.json().catch(() => ({})); alert(d.error || '保存失败'); }
}

async function submitScore() {
  const m = matchDetailData;
  if (!m) { alert('请先打开比赛详情'); return; }
  const s1 = +document.getElementById('score1').value;
  const s2 = +document.getElementById('score2').value;
  const hasPenalty = document.getElementById('hasPenalty') ? document.getElementById('hasPenalty').checked : false;
  let p1 = null, p2 = null;

  if (isNaN(s1) || isNaN(s2)) { alert('请输入比分'); return; }
  const rules = scoreRules(m);
  if (hasPenalty) {
    if (!rules.canPen) { alert('本场不设点球大战'); return; }
    if (s1 !== s2) { alert('点球大战仅在常规时间平局时进行'); return; }
    p1 = penaltyData.filter(p => p.team_id === m.team1_id && p.scored).length;
    p2 = penaltyData.filter(p => p.team_id === m.team2_id && p.scored).length;
    if (p1 === p2) { alert('点球大战比分不能相同，请继续记录'); return; }
  } else if (!rules.canDraw && s1 === s2) {
    alert('本场不设平局，请勾选点球大战'); return;
  }

  const isEdit = m.status === 'finished';
  const text = isEdit
    ? `确定修改比分？\n${m.team1.name} ${s1} : ${s2} ${m.team2.name}${hasPenalty ? `\n点球 ${p1} : ${p2}` : ''}\n\n修改后将重新计算排名和后续对阵。`
    : `确认提交比分？\n${m.team1.name} ${s1} : ${s2} ${m.team2.name}${hasPenalty ? `\n点球 ${p1} : ${p2}` : ''}\n\n提交后将自动推进后续对阵。`;

  confirmDialog(text, async () => {
    const payload = {
      team1_score: s1, team2_score: s2,
      ht_team1_score: (document.getElementById('htScore1') && document.getElementById('htScore1').value !== '') ? +document.getElementById('htScore1').value : null,
      ht_team2_score: (document.getElementById('htScore2') && document.getElementById('htScore2').value !== '') ? +document.getElementById('htScore2').value : null,
      has_penalty: hasPenalty,
      penalty_team1: p1, penalty_team2: p2,
      penalties: penaltyData.filter(p => p.player_id).map(p => ({
        round_number: p.round_number, team_id: p.team_id, player_id: p.player_id, scored: p.scored
      })),
      mvp_player_id: +document.getElementById('mvpPlayer').value || null,

    };
    const url = isEdit ? `/api/matches/${m.id}/score` : `/api/matches/${m.id}/score`;
    const method = isEdit ? 'PUT' : 'POST';
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (res.ok) {
      closeModal('matchModal');
      await loadAllData();
      refreshCurrentPage();
      alert(isEdit ? '比分修改成功，后续对阵已重新计算' : '比分提交成功，后续对阵已自动推进');
    } else {
      const err = await res.json();
      alert('提交失败：' + (err.error || '未知错误'));
    }
  }, isEdit ? '✏️' : '✅');
}

// 当切换到比分tab时渲染点球轮次
const origRenderMatchDetail = renderMatchDetail;
// 重写tab切换以支持点球渲染
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('tab') && e.target.dataset.tab === 'score') {
    setTimeout(() => {
      const penSection = document.getElementById('penaltySection');
      if (penSection && penSection.style.display !== 'none') {
        renderPenaltyRounds();
      }
    }, 50);
  }
  if (e.target.id === 'hasPenalty') {
    setTimeout(() => {
      if (e.target.checked) renderPenaltyRounds();
    }, 50);
  }
});

// ========== 设置 ==========
async function changePassword() {
  const oldPwd = document.getElementById('oldPwd').value;
  const newPwd = document.getElementById('newPwd').value;
  const confirmPwd = document.getElementById('confirmPwd').value;
  if (!oldPwd || !newPwd) { alert('请填写完整'); return; }
  if (newPwd !== confirmPwd) { alert('两次密码不一致'); return; }
  if (newPwd.length < 6) { alert('新密码至少6位'); return; }
  const res = await fetch('/api/auth/change-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd })
  });
  const data = await res.json();
  if (res.ok) { alert('密码修改成功'); document.getElementById('oldPwd').value=''; document.getElementById('newPwd').value=''; document.getElementById('confirmPwd').value=''; }
  else alert(data.error || '修改失败');
}

// ========== 首次登录强制改密 ==========
function showForceChangePasswordModal() {
  const m = document.getElementById('forcePwdModal');
  if (!m) return;
  ['forceOldPwd','forceNewPwd','forceConfirmPwd'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const e = document.getElementById('forcePwdError'); if (e) e.textContent = '';
  m.classList.add('show');
}
function validPwdRule(p) {
  if (!p || p.length < 8 || p.length > 16) return false;
  if (!/^[A-Za-z0-9]+$/.test(p)) return false;
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return false;
  return true;
}
async function submitForceChangePassword() {
  const oldPwd = document.getElementById('forceOldPwd').value;
  const newPwd = document.getElementById('forceNewPwd').value;
  const confirmPwd = document.getElementById('forceConfirmPwd').value;
  const errEl = document.getElementById('forcePwdError');
  const fail = msg => { if (errEl) errEl.textContent = msg; };
  if (!oldPwd || !newPwd || !confirmPwd) return fail('请填写完整');
  if (newPwd !== confirmPwd) return fail('两次输入的新密码不一致');
  if (newPwd === oldPwd) return fail('新密码不能与原密码相同');
  if (!validPwdRule(newPwd)) return fail('密码须为8-16位，只能含字母和数字，且必须同时包含字母和数字');
  const res = await fetch('/api/auth/change-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return fail(data.error || '修改失败');
  try {
    sessionStorage.removeItem('mustChangePassword');
    if (currentUser) currentUser.must_change_password = 0;
  } catch (e) {}
  const m = document.getElementById('forcePwdModal');
  if (m) m.classList.remove('show');
  alert('密码修改成功，请牢记新密码');
}

async function loadUsersForReset() {
  const res = await fetch('/api/users');
  const users = await res.json();
  const sel = document.getElementById('resetUserSelect');
  if (!sel || !Array.isArray(users)) return;
  sel.innerHTML = users.filter(u => u.role === 'viewer' || u.role === 'referee').map(u =>
    `<option value="${u.id}">${u.username} (${u.display_name})${u.role==='referee'?' [裁判]':''}</option>`).join('');
}

async function loadAccountStatus() {
  try {
    const res = await fetch('/api/users');
    const users = await res.json();
    const listEl = document.getElementById('accountStatusList');
    if (!listEl) return;
    if (!Array.isArray(users)) return;
    listEl.innerHTML = users.map(u => {
      const isLocked = u.locked_until && new Date(u.locked_until.replace(' ','T')) > new Date();
      const roleLabel = u.role === 'admin' ? '管理员' : u.role === 'referee' ? '裁判' : '访客';
      const statusBadge = isLocked
        ? '<span style="color:#c62828;font-size:12px;font-weight:600">已锁定</span>'
        : (u.failed_attempts > 0
          ? `<span style="color:#ff9800;font-size:12px">失败${u.failed_attempts}次</span>`
          : '<span style="color:#2e7d32;font-size:12px">正常</span>');
      const mustChange = u.must_change_password ? '<span style="color:#1565c0;font-size:12px;margin-left:6px">待改密</span>' : '';
      const unlockBtn = isLocked ? `<button class="btn btn-sm btn-outline" onclick="unlockUser(${u.id})" style="margin-left:8px">解锁</button>` : '';
      const genderTag = u.role === 'viewer' ? `<span style="color:${u.gender==='women'?'#b0478f':'#1A4D3A'};font-size:11px;margin-left:4px">[${u.gender==='women'?'女队':'男队'}]</span>` : '';
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border-light)">
        <span style="font-size:13px"><strong>${u.username}</strong> (${u.display_name||'-'}) <span style="color:#999;font-size:11px">[${roleLabel}]</span>${genderTag} ${mustChange}</span>
        <span>${statusBadge}${unlockBtn}</span>
      </div>`;
    }).join('');
  } catch(e) {}
}

async function resetVisitorPwd() {
  const sel = document.getElementById('resetUserSelect');
  const userId = sel ? +sel.value : NaN;
  if (!userId) { alert('请先在下拉框中选择要重置的账号'); return; }
  const newPwd = document.getElementById('resetNewPwd').value;
  try {
    const res = await fetch('/api/auth/reset-visitor-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, newPassword: newPwd || undefined })
    });
    const txt = await res.text();
    let data = {};
    try { data = JSON.parse(txt); } catch (_) { data = { error: '服务器返回异常（HTTP ' + res.status + '）：' + txt.slice(0, 120) }; }
    if (res.ok) {
      if (data.password) {
        alert('密码重置成功！\n\n新密码：' + data.password + '\n\n请将此密码安全地告知该球队负责人，他们首次登录时需要修改密码。');
      } else {
        alert('密码重置成功');
      }
      document.getElementById('resetNewPwd').value = '';
      loadAccountStatus(); loadUsersForReset();
    } else if (res.status === 401) {
      alert('登录状态已失效，请退出后重新登录管理员账号再操作');
    } else {
      alert('重置失败：' + (data.error || ('HTTP ' + res.status)));
    }
  } catch (e) { alert('网络错误，重置请求未送达：' + e.message); }
}

async function addAdmin() {
  const username = document.getElementById('newAdminUsername').value.trim();
  const displayName = document.getElementById('newAdminDisplayName').value.trim();
  const password = document.getElementById('newAdminPassword').value;
  if (!username || !password) { alert('请填写用户名和密码'); return; }
  if (password.length < 8 || password.length > 16) { alert('密码长度须为8-16位'); return; }
  if (!/^[a-zA-Z0-9]+$/.test(password)) { alert('密码只能包含字母和数字'); return; }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) { alert('密码必须同时包含字母和数字'); return; }
  const res = await fetch('/api/users/admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, display_name: displayName })
  });
  const data = await res.json();
  if (res.ok) {
    alert('管理员添加成功！\n用户名：' + username + '\n密码：' + password);
    document.getElementById('newAdminUsername').value = '';
    document.getElementById('newAdminDisplayName').value = '';
    document.getElementById('newAdminPassword').value = '';
  } else {
    alert(data.error || '添加失败');
  }
}

function showResetConfirm() {
  const pwd = prompt('此操作将清空所有比赛数据（比分、事件、点球、阵容、停赛），且不可恢复！\n请输入您的管理员密码以确认：');
  if (pwd === null) return;
  if (!pwd) { alert('请输入密码'); return; }
  if (!confirm('确定要执行数据重置吗？此操作不可撤销！')) return;
  resetData(pwd);
}

async function resetData(password) {
  const res = await fetch('/api/admin/reset', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  const data = await res.json();
  if (res.ok) {
    alert('数据重置成功！所有比赛数据已清空。');
    await loadAllData();
    switchToPage('home');
  } else {
    alert(data.error || '重置失败');
  }
}

// 启动
init();

// ========== 提交全队审批 ==========
function submitRosterConfirm() {
  const btn = document.getElementById('submitRosterBtn');
  const teamId = btn?.dataset?.teamId;
  if (!teamId) { alert('请先选择球队'); return; }
  const draftPlayers = allPlayers.filter(p => p.team_id == teamId && p.status === 'draft');
  if (draftPlayers.length === 0) { alert('没有待提交的球员'); return; }
  // 检查材料是否齐全
  const missing = [];
  draftPlayers.forEach(p => {
    if (!p.is_official) {
      const miss = [];
      if (!p.student_card_path) miss.push('学生证');
      if (!p.safety_doc_path) miss.push('安全责任书');
      if (miss.length) missing.push(`${p.name}（缺${miss.join('、')}）`);
    }
  });
  if (missing.length > 0) {
    alert('以下球员材料未补齐，无法提交：\n\n' + missing.join('\n') + '\n\n请点击"编辑"补齐材料后再提交。');
    return;
  }
  // 确认提示
  confirmDialog(
    `提交后即代表所在学院同意该运动员参加本届赛事。\n\n本次将提交 ${draftPlayers.length} 名球员的报名材料，提交后将进入管理员审批流程，审批期间无法修改。\n\n确定提交吗？`,
    async () => {
      try {
        const res = await fetch('/api/teams/' + teamId + '/submit-roster', { method: 'POST' });
        const result = await res.json();
        if (res.ok) {
          alert(result.message || '提交成功');
          await loadAllData();
          loadPlayers();
          if (isAdmin()) loadPendingPlayers();
        } else {
          alert(result.error || '提交失败');
        }
      } catch (e) {
        alert('提交失败：' + e.message);
      }
    },
    '✅'
  );
}

// ========== Excel批量导入 ==========
async function importPlayers(input) {
  const file = input.files[0];
  if (!file) return;
  if (!file.name.match(/\.(xlsx|xls)$/i)) { alert('请选择Excel文件(.xlsx/.xls)'); input.value=''; return; }

  let teamId = '';
  if (currentUser.role === 'admin') {
    // 管理员需要选择球队
    const teams = allTeams || [];
    if (teams.length === 0) { alert('请先添加球队'); input.value=''; return; }
    const opts = teams.map(t => `${t.id}:${t.name}`).join('\n');
    const choice = prompt('请输入要导入的球队编号：\n' + opts, '1');
    if (!choice) { input.value=''; return; }
    teamId = parseInt(choice);
    if (!teamId || !teams.find(t => t.id === teamId)) { alert('无效的球队编号'); input.value=''; return; }
  }

  const formData = new FormData();
  formData.append('file', file);
  if (teamId) formData.append('team_id', teamId);

  try {
    const res = await fetch('/api/players/import', { method: 'POST', body: formData });
    const data = await res.json();
    if (res.ok) {
      let msg = `导入完成！\n成功：${data.success} 条`;
      if (data.errors && data.errors.length > 0) {
        msg += `\n失败：${data.errors.length} 条\n\n` + data.errors.slice(0, 10).join('\n');
        if (data.errors.length > 10) msg += `\n...等共${data.errors.length}条错误`;
      }
      if (data.success > 0) {
        msg += '\n\n⚠ 导入的球员为"草稿"状态，请逐个编辑补齐学生证照片和安全责任书，然后点击"✅ 提交审批"按钮提交。';
      }
      alert(msg);
      await loadAllData();
      loadPlayers();
    } else {
      alert('导入失败：' + (data.error || '未知错误'));
    }
  } catch (e) {
    alert('导入失败：' + e.message);
  }
  input.value = '';
}

// ========== 操作日志 ==========
const actionLabels = {
  add_player: '添加球员', update_player: '修改球员', delete_player: '删除球员',
  submit_player_add: '访客提交球员', submit_player_edit: '访客修改球员',
  approve_player: '审批通过', reject_player: '审批拒绝', import_players: '批量导入',
  add_referee: '添加裁判', update_referee: '修改裁判', delete_referee: '删除裁判',
  update_match_basic: '修改比赛信息', save_lineup: '保存阵容',
  submit_score: '录入比分', update_score: '修改比分',
  add_match_event: '添加比赛事件', delete_match_event: '删除比赛事件',
  add_suspension: '添加停赛', cancel_suspension: '取消停赛',
  add_admin: '添加管理员', change_password: '修改密码',
  reset_visitor_password: '重置访客密码', update_team: '修改球队',
  upload_team_logo: '上传队徽', reset_data: '重置数据', draw_lots: '抽签'
};

async function loadOperationLogs() {
  const action = document.getElementById('logFilter').value;
  let url = '/api/operation-logs?limit=300';
  if (action) url += '&action=' + action;
  const res = await fetch(url);
  const logs = await res.json();
  const tbody = document.querySelector('#logsTable tbody');
  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;padding:30px">暂无日志</td></tr>';
    return;
  }
  tbody.innerHTML = logs.map(l => {
    const label = actionLabels[l.action] || l.action;
    let detail = '';
    if (l.detail) {
      try {
        const d = typeof l.detail === 'string' ? safeParse(l.detail, {}) : l.detail;
        const fmtVal = (v) => {
          if (v === null || v === undefined) return '';
          if (typeof v !== 'object') return String(v);
          if (Array.isArray(v)) return '[' + v.map(x => (x && typeof x === 'object') ? JSON.stringify(x) : String(x)).join(', ') + ']';
          return '{' + Object.entries(v).map(([a, b]) => a + '=' + ((b && typeof b === 'object') ? JSON.stringify(b) : b)).join(', ') + '}';
        };
        detail = Object.entries(d).map(([k, v]) => `${k}: ${fmtVal(v)}`).join(', ');
      } catch { detail = String(l.detail); }
    }
    const roleLabel = l.role === 'admin' ? '<span style="color:var(--primary);font-weight:600">管理员</span>' : '<span style="color:#888">访客</span>';
    const time = l.created_at ? l.created_at.replace('T', ' ').substring(0, 19) : '';
    return `<tr>
      <td style="white-space:nowrap;font-size:12px">${time}</td>
      <td>${l.username || '-'}</td>
      <td>${roleLabel}</td>
      <td><span style="background:#f0f7f4;color:var(--primary);padding:2px 8px;border-radius:4px;font-size:12px">${label}</span></td>
      <td style="font-size:12px;color:#666;max-width:400px;word-break:break-all">${detail}</td>
      <td style="font-size:12px;color:#999">${l.ip_address || '-'}</td>
    </tr>`;
  }).join('');
}

// ========== 消息通知 ==========
const msgTypeLabels = {
  match_update: '比赛通知', match_reminder: '比赛提醒', suspension: '禁赛通知',
  player_submit: '审批通知', player_approved: '审批通过', admin_notice: '管理员通知',
  visitor_message: '访客来信', admin_reply: '管理员回复',
  referee_assign: '执法指派', referee_reminder: '执法提醒', referee_report: '裁判报告', referee_message: '裁判来信',
  referee_apply: '裁判申请', rating_reminder: '裁判评分'
};
const msgTypeColors = {
  match_update: '#2196F3', match_reminder: '#FF9800', suspension: '#F44336',
  player_submit: '#9C27B0', player_approved: '#4CAF50', admin_notice: '#1A4D3A',
  visitor_message: '#FF5722', admin_reply: '#009688',
  referee_assign: '#8a6d1f', referee_reminder: '#e65100', referee_report: '#1565c0', referee_message: '#6a1b9a',
  referee_apply: '#8a6d1f', rating_reminder: '#C8A45C'
};

async function loadUnreadCount() {
  try {
    const res = await fetch('/api/messages/unread-count');
    const data = await res.json();
    updateUnreadBadge(data.count);
  } catch(e) {}
}

function updateUnreadBadge(count) {
  const badge = document.getElementById('notifCount');
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
  const mnBadge = document.getElementById('mnMsgBadge');
  if (mnBadge) {
    mnBadge.textContent = count > 99 ? '99+' : count;
    mnBadge.style.display = count > 0 ? 'flex' : 'none';
  }
}

let dropdownOpen = false;
async function toggleMessageDropdown() {
  const dd = document.getElementById('notifDropdown');
  dropdownOpen = !dropdownOpen;
  if (dropdownOpen) {
    dd.style.display = 'block';
    try {
      const res = await fetch('/api/messages?limit=5');
      const msgs = await res.json();
      renderMessageDropdown(msgs);
    } catch(e) {
      dd.innerHTML = '<div style="padding:20px;text-align:center;color:#999">加载失败</div>';
    }
  } else {
    dd.style.display = 'none';
  }
}

function renderMessageDropdown(msgs) {
  const dd = document.getElementById('notifDropdown');
  if (!msgs.length) {
    dd.innerHTML = '<div style="padding:30px;text-align:center;color:#999;font-size:13px">暂无消息</div>';
    return;
  }
  let html = '<div style="max-height:360px;overflow-y:auto">';
  msgs.forEach(m => {
    const unread = !m.is_read;
    const typeColor = msgTypeColors[m.type] || '#888';
    const time = m.created_at ? m.created_at.replace('T',' ').substring(5,16) : '';
    let hasAtt = false;
    try { hasAtt = m.attachments && JSON.parse(m.attachments).length > 0; } catch(e) {}
    html += `<div class="msg-item ${unread?'msg-unread':''}" onclick='handleMessageClick(${JSON.stringify(m).replace(/'/g,"&#39;")})'>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:11px;color:${typeColor};font-weight:600">${msgTypeLabels[m.type]||'通知'}${hasAtt?' 📎':''}</span>
        <span style="font-size:11px;color:#999">${time}</span>
      </div>
      <div style="font-size:13px;font-weight:${unread?'600':'400'};color:${unread?'#333':'#666'};margin-bottom:2px">${escapeHtml(m.title)}</div>
      <div style="font-size:12px;color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(m.content) || ''}</div>
    </div>`;
  });
  html += '</div><div style="padding:10px;text-align:center;border-top:1px solid #eee;cursor-pointer;color:var(--primary);font-size:13px;font-weight:600" onclick="goToMessages()">查看全部消息</div>';
  dd.innerHTML = html;
}

function goToMessages() {
  document.getElementById('notifDropdown').style.display = 'none';
  dropdownOpen = false;
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  document.querySelector('[data-page="messages"]').classList.add('active');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-messages').classList.add('active');
  loadMessages();
  if (currentUser.role === 'admin') {
    document.getElementById('sentMessagesCard').style.display = 'block';
    document.getElementById('visitorInboxCard').style.display = 'block';
    document.getElementById('visitorSendBtn').style.display = 'none';
    loadSentMessages();
    loadVisitorInbox();
  } else {
    document.getElementById('sentMessagesCard').style.display = 'none';
    document.getElementById('visitorInboxCard').style.display = 'none';
    document.getElementById('visitorSendBtn').style.display = 'inline-block';
  }
}

async function loadMessages() {
  const type = document.getElementById('msgFilter').value;
  let url = '/api/messages?limit=200';
  if (type && type !== 'all') url += '&type=' + type;
  const res = await fetch(url);
  const msgs = await res.json();
  const container = document.getElementById('messagesList');
  if (!msgs.length) {
    container.innerHTML = '<div style="text-align:center;color:#999;padding:40px">暂无消息</div>';
    return;
  }
  container.innerHTML = msgs.map(m => renderMessageCard(m)).join('');
}

// 渲染消息附件
function renderAttachments(attachmentsStr) {
  if (!attachmentsStr) return '';
  let atts;
  try { atts = JSON.parse(attachmentsStr); } catch(e) { return ''; }
  if (!atts || !atts.length) return '';
  const imgs = atts.filter(a => a.mimetype && a.mimetype.startsWith('image/'));
  const files = atts.filter(a => !(a.mimetype && a.mimetype.startsWith('image/')));
  let html = '<div style="margin-top:8px">';
  if (imgs.length) {
    html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">';
    imgs.forEach(img => {
      html += `<img src="${img.path}" style="width:60px;height:60px;object-fit:cover;border-radius:4px;cursor:pointer;border:1px solid #ddd" onclick="event.stopPropagation();previewImage('${img.path}')" title="${escapeHtml(img.filename)}">`;
    });
    html += '</div>';
  }
  if (files.length) {
    html += '<div style="display:flex;flex-direction:column;gap:4px">';
    files.forEach(f => {
      const sizeKB = (f.size / 1024).toFixed(1);
      html += `<a href="${f.path}" download="${escapeHtml(f.filename)}" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#1A4D3A;text-decoration:none;padding:4px 8px;background:#F5F8F7;border-radius:4px;width:fit-content" onclick="event.stopPropagation()">
        <span>📎</span><span>${escapeHtml(f.filename)}</span><span style="color:#999">(${sizeKB}KB)</span>
      </a>`;
    });
    html += '</div>';
  }
  html += '</div>';
  return html;
}

// 图片预览
function previewImage(src) {
  document.getElementById('imageModalImg').src = src;
  showModal('imageModal');
}

function renderMessageCard(m) {
  const unread = !m.is_read;
  const typeColor = msgTypeColors[m.type] || '#888';
  const time = m.created_at ? m.created_at.replace('T',' ').substring(0,16) : '';
  const canDelete = currentUser.role === 'admin' || m.receiver_id === currentUser.id;
  return `<div class="msg-card ${unread?'msg-unread':''}" style="border-left:4px solid ${typeColor}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div style="flex:1;cursor:pointer" onclick='handleMessageClick(${JSON.stringify(m).replace(/'/g,"&#39;")})'>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-size:12px;color:${typeColor};font-weight:600;background:${typeColor}15;padding:2px 8px;border-radius:4px">${msgTypeLabels[m.type]||'通知'}</span>
          <span style="font-size:12px;color:#999">${time}</span>
          ${unread?'<span style="font-size:11px;color:#F44336;font-weight:600">未读</span>':''}
        </div>
        <div style="font-size:15px;font-weight:${unread?'600':'500'};color:#333;margin-bottom:4px">${escapeHtml(m.title)}</div>
        <div style="font-size:13px;color:#666;line-height:1.5">${escapeHtml(m.content) || ''}</div>
        ${m.related_type === 'match' && m.related_id ? '<div style="font-size:12px;color:#1A4D3A;margin-top:6px;font-weight:500">→ 点击卡片查看比赛详情</div>' : ''}
        ${renderAttachments(m.attachments)}
        <div style="font-size:12px;color:#999;margin-top:6px">来自：${escapeHtml(m.sender_name) || '系统'}</div>
      </div>
      ${canDelete?`<button class="btn btn-ghost btn-sm" onclick="deleteMessage(${m.id},event)" style="margin-left:12px">删除</button>`:''}
    </div>
  </div>`;
}

async function handleMessageClick(m) {
  if (!m.is_read) {
    try {
      const res = await fetch(`/api/messages/${m.id}/read`, { method: 'POST' });
      const data = await res.json();
      updateUnreadBadge(data.count);
    } catch(e) {}
  }
  document.getElementById('notifDropdown').style.display = 'none';
  dropdownOpen = false;
  if (m.related_type === 'exhibition' && m.related_id) {
    switchPage('schedule');
    openExhibition(m.related_id);
  } else if (m.related_type === 'match' && m.related_id) {
    if (isReferee()) {
      // 裁判：跳转到我的执法，主裁可直接打开报告
      switchToPage('my-matches');
      const mm = myMatchesCache.find(x => x.id === m.related_id);
      if (mm && mm.role === 'main' && mm.status === 'finished') openRefReport(m.related_id);
    } else {
      openMatch(m.related_id);
    }
  } else if (m.related_type === 'player') {
    // 标准导航切换，避免手动切换导致页面空白
    switchToPage('players');
    if (currentUser && currentUser.role === 'admin') {
      // 管理员：球员审批类消息直达待审批标签页（等待页面数据加载完成后再切）
      setTimeout(() => switchPlayerTab('pending'), 1000);
    } else {
      // 球队端：打回/通过消息直达草稿标签页（被拒球员退回草稿）
      setTimeout(() => switchPlayerTab('draft'), 1000);
    }
  } else if (m.related_type === 'referee_application') {
    // 裁判申请待审批：管理员直接跳裁判管理页并打开审批弹窗
    if (currentUser && currentUser.role === 'admin') {
      switchPage('referees');
      loadRefereeAppsAdmin();
    }
  }
}

async function markAllRead() {
  await fetch('/api/messages/read-all', { method: 'POST' });
  updateUnreadBadge(0);
  loadMessages();
}

async function deleteMessage(id, event) {
  if (event) event.stopPropagation();
  if (!confirm('确定删除这条消息吗？')) return;
  await fetch(`/api/messages/${id}`, { method: 'DELETE' });
  loadMessages();
  loadUnreadCount();
}

function onNoticeReceiverChange() {
  const type = document.getElementById('noticeReceiverType').value;
  document.getElementById('noticeUserSelectGroup').style.display = type === 'user' ? 'block' : 'none';
}

async function loadNoticeUsers() {
  try {
    const res = await fetch('/api/users');
    const users = await res.json();
    const visitors = users.filter(u => u.role === 'viewer');
    const sel = document.getElementById('noticeUserSelect');
    sel.innerHTML = visitors.map(u => `<option value="${u.id}">${u.username}（${teamName(u.team_id)||'未分配'}）</option>`).join('');
  } catch(e) {}
}

async function sendNotice() {
  const receiverType = document.getElementById('noticeReceiverType').value;
  const title = document.getElementById('noticeTitle').value.trim();
  const content = document.getElementById('noticeContent').value.trim();
  if (!title) { alert('请输入通知标题'); return; }
  const fd = new FormData();
  fd.append('title', title);
  fd.append('content', content);
  fd.append('receiver_type', receiverType);
  if (receiverType === 'user') {
    const rid = parseInt(document.getElementById('noticeUserSelect').value);
    if (!rid) { alert('请选择访客'); return; }
    fd.append('receiver_id', rid);
  }
  const attFiles = mfpFiles('noticeAttachments');
  for (const f of attFiles) fd.append('attachments', f);
  const res = await fetch('/api/messages/send', { method: 'POST', body: fd });
  const data = await res.json();
  if (data.ok) {
    alert('通知发送成功');
    document.getElementById('noticeTitle').value = '';
    document.getElementById('noticeContent').value = '';
    mfpReset('noticeAttachments');
    loadSentMessages();
  } else {
    alert(data.error || '发送失败');
  }
}

// 访客发送消息
function openVisitorSendModal() {
  document.getElementById('visitorMsgTitle').value = '';
  document.getElementById('visitorMsgContent').value = '';
  mfpReset('visitorMsgAttachments');
  showModal('visitorSendModal');
}

async function submitVisitorMessage() {
  const title = document.getElementById('visitorMsgTitle').value.trim();
  const content = document.getElementById('visitorMsgContent').value.trim();
  if (!title) { alert('请输入消息标题'); return; }
  const fd = new FormData();
  fd.append('title', title);
  fd.append('content', content);
  const attFiles = mfpFiles('visitorMsgAttachments');
  for (const f of attFiles) fd.append('attachments', f);
  const res = await fetch('/api/messages/visitor-send', { method: 'POST', body: fd });
  const data = await res.json();
  if (data.ok) {
    alert('消息已发送给全体管理员');
    closeModal('visitorSendModal');
  } else {
    alert(data.error || '发送失败');
  }
}

// 管理员回复
let currentReplyMsgId = null;
window.openReplyModalFrom = function (btn) { openReplyModal(+btn.dataset.rid, btn.dataset.rtitle || ''); };
function openReplyModal(msgId, origTitle) {
  currentReplyMsgId = msgId;
  document.getElementById('replyTitle').value = '回复：' + (origTitle || '');
  document.getElementById('replyContent').value = '';
  mfpReset('replyAttachments');
  showModal('replyModal');
}

async function submitReply() {
  if (!currentReplyMsgId) return;
  const title = document.getElementById('replyTitle').value.trim();
  const content = document.getElementById('replyContent').value.trim();
  if (!title) { alert('请输入回复标题'); return; }
  const fd = new FormData();
  fd.append('title', title);
  fd.append('content', content);
  const attFiles = mfpFiles('replyAttachments');
  for (const f of attFiles) fd.append('attachments', f);
  const res = await fetch(`/api/messages/${currentReplyMsgId}/reply`, { method: 'POST', body: fd });
  const data = await res.json();
  if (data.ok) {
    alert('回复已发送');
    closeModal('replyModal');
    loadVisitorInbox();
  } else {
    alert(data.error || '回复失败');
  }
}

// 加载访客来信
async function loadVisitorInbox() {
  const res = await fetch('/api/messages/visitor-inbox');
  const msgs = await res.json();
  const container = document.getElementById('visitorInboxList');
  if (!container) return;
  if (!msgs.length) {
    container.innerHTML = '<div style="text-align:center;color:#999;padding:30px">暂无访客来信</div>';
    return;
  }
  container.innerHTML = msgs.map(m => {
    const time = m.created_at ? m.created_at.replace('T',' ').substring(0,16) : '';
    const teamLabel = m.sender_team_id ? `（${escapeHtml(teamName(m.sender_team_id))}）` : '';
    return `<div class="msg-card" style="border-left:4px solid #FF5722;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-size:12px;color:#FF5722;font-weight:600;background:#FF572215;padding:2px 8px;border-radius:4px">访客来信</span>
            <span style="font-size:12px;color:#999">${time}</span>
            <span style="font-size:12px;color:#666">来自：${escapeHtml(m.sender_name) || '未知'}${teamLabel}</span>
          </div>
          <div style="font-size:15px;font-weight:500;color:#333;margin-bottom:4px">${escapeHtml(m.title)}</div>
          <div style="font-size:13px;color:#666;line-height:1.5">${escapeHtml(m.content) || ''}</div>
          ${renderAttachments(m.attachments)}
        </div>
        <button class="btn btn-primary btn-sm" data-rid="${m.id}" data-rtitle="${escapeHtml(m.title||'')}" onclick="openReplyModalFrom(this)" style="margin-left:12px;white-space:nowrap">回复</button>
      </div>
    </div>`;
  }).join('');
}

async function loadSentMessages() {
  const res = await fetch('/api/messages/all?limit=200');
  const msgs = await res.json();
  const container = document.getElementById('sentMessagesList');
  if (!msgs.length) {
    container.innerHTML = '<div style="text-align:center;color:#999;padding:30px">暂无已发送消息</div>';
    return;
  }
  container.innerHTML = msgs.map(m => {
    const typeColor = msgTypeColors[m.type] || '#888';
    const time = m.created_at ? m.created_at.replace('T',' ').substring(0,16) : '';
    const tName = m.receiver_team_id ? teamName(m.receiver_team_id) : '';
    return `<div class="msg-card" style="border-left:4px solid ${typeColor}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:12px;color:${typeColor};font-weight:600;background:${typeColor}15;padding:2px 8px;border-radius:4px">${msgTypeLabels[m.type]||'通知'}</span>
        <span style="font-size:12px;color:#999">${time}</span>
        <span style="font-size:12px;color:#666">接收者：${escapeHtml(m.receiver_name) || '未知'}${tName?`（${tName}）`:''}</span>
      </div>
      <div style="font-size:14px;font-weight:500;color:#333;margin-bottom:4px">${escapeHtml(m.title)}</div>
      <div style="font-size:13px;color:#666;line-height:1.5">${escapeHtml(m.content) || ''}</div>
      ${renderAttachments(m.attachments)}
      <div style="font-size:12px;color:#999;margin-top:6px">发送者：${escapeHtml(m.sender_name) || '系统'}</div>
    </div>`;
  }).join('');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#notifBell') && !e.target.closest('#notifDropdown')) {
    document.getElementById('notifDropdown').style.display = 'none';
    dropdownOpen = false;
  }
});

// ========== 抽签系统 ==========
let drawState = {
  teams: [],
  slot: [null, null, null, null, null, null, null, null], // 8 个首轮席位槽，7 队抽入后空余 1 席为轮空
  spinning: false
};
const DRAW_TEAM_TOTAL = 7;   // 参赛球队数
const DRAW_SLOT_TOTAL = 8;   // 首轮席位数（=球队数+1，多1席轮空）

// ==================== 抽签仪式（男子 A1-A3/B1-B3；女子 1-5） ====================
let drawUI = null;

const DRAW_CFG = {
  men: { title: '男子组 · 分组抽签', groups: [['A', ['A1','A2','A3']], ['B', ['B1','B2','B3']]],
         slotOrder: ['A1','A2','A3','B1','B2','B3'], statusUrl: '/api/draw/status', executeUrl: '/api/draw/execute',
         done: '男子组抽签完成，已生成小组双循环对阵。' },
  women: { title: '女子组 · 单循环抽签', groups: [['', ['1','2','3','4','5']]],
         slotOrder: ['1','2','3','4','5'], statusUrl: '/api/draw/women/status', executeUrl: '/api/draw/women/execute',
         done: '女子组抽签完成，已生成单循环对阵。' },
};

async function loadDraw(gender) {
  const g = gender || (drawUI && drawUI.gender) || 'men';
  const cfg = DRAW_CFG[g];
  let st;
  try { st = await fetch(cfg.statusUrl).then(r => r.json()); } catch (e) { st = null; }
  const container = document.getElementById('drawContainer');
  const tabs = `<div class="draw-gender-tabs">
    <button class="draw-gtab ${g==='men'?'active':''}" onclick="loadDraw('men')">男子组</button>
    <button class="draw-gtab ${g==='women'?'active':''}" onclick="loadDraw('women')">女子组</button>
  </div>`;
  if (!st) { container.innerHTML = tabs + '<div class="empty-state">抽签状态加载失败</div>'; return; }

  // 已抽签 / 比赛已开始：只读展示
  if (!st.canDraw) {
    drawUI = { gender: g, cfg, st, readOnly: true };
    container.innerHTML = tabs + renderDrawReadonly(g, st);
    document.getElementById('drawStatus').textContent = st.hasLiveMatch ? '比赛已开始，抽签结果已锁定' : '抽签已完成';
    return;
  }
  drawUI = { gender: g, cfg, st, slots: {}, remaining: st.teams.map(t => t.id), current: 0, rolling: false };
  document.getElementById('drawStatus').textContent = '尚未抽签，请逐支抽取';
  container.innerHTML = tabs + renderDrawCeremony();
}

function teamById(id) { return drawUI.st.teams.find(t => t.id === id); }

function renderDrawReadonly(g, st) {
  const cfg = DRAW_CFG[g];
  const groupsHtml = cfg.groups.map(([letter, keys]) => {
    const cards = keys.map(k => {
      const id = st.slots[k]; const t = id != null ? st.teams.find(x => x.id === id) : null;
      return `<div class="draw-slot2 done"><div class="draw-slot2-label">${g==='women'?k+'号签':k}</div>
        <div class="draw-slot-team"><img src="${t? (t.logo_path||teamLogo(t.id)):''}" class="team-logo team-logo-sm"><span>${t?escapeHtml(t.name):'—'}</span></div></div>`;
    }).join('');
    return `<div class="draw-group2 ${g==='women'?'single':''}">
      <div class="draw-group2-name">${g==='women'?'签位区':letter+' 组'}</div>
      <div class="draw-slots2">${cards}</div></div>`;
  }).join('');
  return `<div class="draw-stage2">
    <div class="draw-finished-banner2">✅ 抽签已完成${st.hasLiveMatch?'，且比赛已开始，结果不可更改':''}，以下为最终签位</div>
    <div class="draw-board2 ${g==='women'?'women':''}">${groupsHtml}</div>
  </div>`;
}

function renderDrawCeremony() {
  const { cfg } = drawUI;
  const total = cfg.slotOrder.length;
  const isWomen = drawUI.gender === 'women';

  const groupsHtml = cfg.groups.map(([letter, keys]) => {
    const cards = keys.map(k => {
      const idx = cfg.slotOrder.indexOf(k);
      const id = drawUI.slots[k];
      const isCurrent = idx === drawUI.current && id == null;
      let body;
      if (id != null) {
        const t = teamById(id);
        body = `<div class="draw-slot-team"><img src="${t.logo_path||teamLogo(t.id)}" class="team-logo team-logo-sm"><span>${escapeHtml(t.name)}</span></div>`;
      } else {
        body = `<div class="draw-slot-empty2">${isCurrent?'待抽取':'—'}</div>`;
      }
      return `<div class="draw-slot2 ${id!=null?'done':''} ${isCurrent?'current':''}">
        <div class="draw-slot2-label">${isWomen?k+'号签':k}</div>${body}</div>`;
    }).join('');
    return `<div class="draw-group2 ${isWomen?'single':''}">
      <div class="draw-group2-name">${isWomen?'签位区':letter+' 组'}</div>
      <div class="draw-slots2">${cards}</div></div>`;
  }).join('');

  const allDone = drawUI.current >= total;
  const currentKey = allDone ? null : cfg.slotOrder[drawUI.current];
  const currentLabel = allDone ? '' : (isWomen ? currentKey+'号签' : currentKey);
  const pct = Math.round(drawUI.current/total*100);

  const poolChips = drawUI.remaining.map(id => {
    const t = teamById(id);
    return `<span class="draw-pool-chip2">${escapeHtml(t.name)}</span>`;
  }).join('');

  const machine = allDone
    ? `<div class="draw-alldone2">🎉 全部 ${total} 个签位已抽出，请核对后提交</div>
       <div class="draw-actions2">
         <button class="btn btn-outline" onclick="resetLocalDraw()">↺ 清空重抽</button>
         <button class="btn btn-gold" onclick="submitDraw()">✅ 确认提交抽签</button>
       </div>`
    : `<div class="draw-ball2" id="drawBall"><span id="drawBallText">${drawUI.current===0?'点击下方按钮开始抽签':'准备抽取下一签'}</span></div>
       <div class="draw-next-label2">下一签位 <b>${currentLabel}</b><i>·</i>剩余 ${drawUI.remaining.length} 支球队</div>
       <div class="draw-actions2">
         ${drawUI.current>0?'<button class="btn btn-outline" onclick="resetLocalDraw()">↺ 清空重抽</button>':''}
         <button class="btn btn-gold draw-pick-btn" id="drawPickBtn" onclick="pickOneDraw()">🎲 抽取【${currentLabel}】</button>
       </div>`;

  return `<div class="draw-stage2">
    <div class="draw-stage2-head">
      <div class="draw-stage2-title">${cfg.title}</div>
      <div class="draw-progress2">
        <div class="draw-progress2-track"><div class="draw-progress2-bar" style="width:${pct}%"></div></div>
        <span class="draw-progress2-text">${drawUI.current} / ${total}</span>
      </div>
    </div>
    <div class="draw-board2 ${isWomen?'women':''}">${groupsHtml}</div>
    <div class="draw-machine2">${machine}</div>
    <div class="draw-pool2">
      <div class="draw-pool2-cap">待抽球队池 · ${drawUI.remaining.length} 支</div>
      <div class="draw-pool2-chips">${poolChips||'<span class="draw-pool2-empty">已全部抽出</span>'}</div>
    </div>
    <div class="draw-tip2">抽签逐支进行：点击“抽取”后随机确定该签位球队；全部抽出并核对无误后再提交。提交前可清空重抽，提交后如需重抽须由管理员重置。${isWomen ? '' : '<br><b style="color:#a98842">回避规则：体育与艺术学院A队、体育与艺术学院B队强制分入不同小组，抽签过程由系统自动保证，不会落入同一组。</b>'}</div>
  </div>`;
}

function resetLocalDraw() {
  if (!confirm('确定清空本次已抽出的结果、重新开始吗？')) return;
  drawUI.slots = {}; drawUI.remaining = drawUI.st.teams.map(t=>t.id); drawUI.current = 0;
  document.getElementById('drawContainer').innerHTML =
    document.querySelector('.draw-gender-tabs').outerHTML + renderDrawCeremony();
}

// 男子组回避规则：体育与艺术学院A队、B队强制分入不同小组
function menSplitPairIds() {
  const teams = (drawUI && drawUI.st && drawUI.st.teams) || [];
  return teams.filter(t => t.name && t.name.indexOf('体育与艺术学院') === 0 && /[AB]队$/.test(t.name)).map(t => t.id);
}
// 假设在 nextIdx 之前的签位已确定，判断是否仍能合法完成（A、B 组各恰有 1 支回避队）
function menFeasibleAfter(slots, nextIdx) {
  const cfg = drawUI.cfg;
  const pair = menSplitPairIds();
  if (pair.length !== 2) return true;
  let x = 0, y = 0;
  cfg.slotOrder.forEach(k => {
    if (pair.includes(slots[k])) { if (k.charAt(0) === 'A') x++; else y++; }
  });
  let aFree = 0, bFree = 0;
  for (let i = nextIdx; i < cfg.slotOrder.length; i++) {
    if (cfg.slotOrder[i].charAt(0) === 'A') aFree++; else bFree++;
  }
  return x <= 1 && y <= 1 && (1 - x) <= aFree && (1 - y) <= bFree;
}
// 当前签位允许抽取的球队（自动剔除会导致同组的选项，保证始终可合法完成）
function drawCandidates() {
  const pool = drawUI.remaining;
  if (drawUI.gender !== 'men') return pool.slice();
  const key = drawUI.cfg.slotOrder[drawUI.current];
  return pool.filter(id => {
    const trial = Object.assign({}, drawUI.slots);
    trial[key] = id;
    return menFeasibleAfter(trial, drawUI.current + 1);
  });
}

async function pickOneDraw() {
  if (drawUI.rolling) return;
  const { cfg } = drawUI;
  if (drawUI.current >= cfg.slotOrder.length || !drawUI.remaining.length) return;
  const candidates = drawCandidates();
  if (!candidates.length) { alert('当前无合法球队可抽，请清空重抽'); return; }
  drawUI.rolling = true;
  const btn = document.getElementById('drawPickBtn'); if (btn) btn.disabled = true;
  const ballText = document.getElementById('drawBallText');
  const ballEl = document.getElementById('drawBall'); if (ballEl) ballEl.classList.add('rolling');
  // 滚动动画（仅在合法候选中滚动）
  const started = Date.now();
  await new Promise(resolve => {
    const tick = () => {
      const t = teamById(candidates[Math.floor(Math.random()*candidates.length)]);
      if (ballText) ballText.textContent = t.name;
      if (Date.now() - started < 850) { setTimeout(tick, 60); } else resolve();
    };
    tick();
  });
  if (ballEl) ballEl.classList.remove('rolling');
  const ri = Math.floor(Math.random()*candidates.length);
  const teamId = candidates[ri];
  const poolIdx = drawUI.remaining.indexOf(teamId);
  drawUI.remaining.splice(poolIdx, 1);
  const key = cfg.slotOrder[drawUI.current];
  drawUI.slots[key] = teamId;
  drawUI.current++;
  drawUI.rolling = false;
  const t = teamById(teamId);
  if (ballText) ballText.innerHTML = `🎉 <b>${escapeHtml(t.name)}</b> 落入 <b>${drawUI.gender==='women'?key+'号签':key}</b>`;
  // 短暂停留后刷新席位与机器
  setTimeout(() => {
    document.getElementById('drawContainer').innerHTML =
      document.querySelector('.draw-gender-tabs').outerHTML + renderDrawCeremony();
  }, 650);
}

async function submitDraw() {
  const { cfg } = drawUI;
  if (cfg.slotOrder.some(k => drawUI.slots[k] == null)) { alert('尚有签位未抽出'); return; }
  if (!confirm('确认提交抽签结果？提交后将正式生成对阵，如需重抽须由管理员重置。')) return;
  const res = await fetch(cfg.executeUrl, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ slots: drawUI.slots })
  });
  const d = await res.json().catch(()=>({}));
  if (!res.ok) { alert(d.error||'抽签失败'); return; }
  alert(cfg.done);
  await loadAllData(); refreshCurrentPage();
  loadDraw(drawUI.gender);
}

// ========== 数据库备份 ==========
async function backupDatabase() {
  try {
    const res = await fetch('/api/admin/backup', { method: 'POST' });
    const data = await res.json();
    if (res.ok) { alert('备份成功：' + data.file); loadBackups(); }
    else alert('备份失败：' + (data.error || ''));
  } catch(e) { alert('备份失败：' + e.message); }
}

async function loadBackups() {
  try {
    const res = await fetch('/api/admin/backups');
    const data = await res.json();
    const listEl = document.getElementById('backupList');
    if (!listEl) return;
    if (!data.length) { listEl.innerHTML = '<p style="color:#999;font-size:13px">暂无备份</p>'; return; }
    listEl.innerHTML = data.map(b => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border-light)">
        <span style="font-size:13px">${b.file} (${(b.size/1024).toFixed(1)}KB)</span>
        <a class="btn btn-sm btn-outline" href="/api/admin/backups/${b.file}" download>下载</a>
      </div>
    `).join('');
  } catch(e) {}
}


// ========== D14 回收站 ==========
async function loadRecycleBin() {
  let d = { teams: [], players: [], referees: [] };
  try {
    const resp = await fetch('/api/recycle-bin');
    if (resp.ok) {
      const j = await resp.json();
      if (j && Array.isArray(j.teams) && Array.isArray(j.players) && Array.isArray(j.referees)) d = j;
    }
  } catch (e) {}
  const fmt = (t) => t ? fmtTime(t) : '-';
  const empty = '<tr><td colspan="5" style="text-align:center;color:#999;padding:14px">空</td></tr>';
  document.getElementById('recycleTeams').innerHTML = d.teams.length ? d.teams.map(t => `
    <tr><td>${escapeHtml(t.name)}</td><td>${fmt(t.deleted_at)}</td>
    <td><button class="btn btn-sm btn-success" onclick="restoreItem('team',${t.id})">恢复</button>
    <button class="btn btn-sm btn-danger" onclick="purgeItem('team',${t.id})">彻底删除</button></td></tr>`).join('') : empty;
  document.getElementById('recyclePlayers').innerHTML = d.players.length ? d.players.map(p => `
    <tr><td>${p.jersey_number||'-'}</td><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.team_name)||'（球队已删）'}</td><td>${fmt(p.deleted_at)}</td>
    <td><button class="btn btn-sm btn-success" onclick="restoreItem('player',${p.id})">恢复</button>
    <button class="btn btn-sm btn-danger" onclick="purgeItem('player',${p.id})">彻底删除</button></td></tr>`).join('') : empty;
  document.getElementById('recycleReferees').innerHTML = d.referees.length ? d.referees.map(r => `
    <tr><td>${escapeHtml(r.serial_number)||''}</td><td>${escapeHtml(r.name)}</td><td>${r.level||''}</td><td>${fmt(r.deleted_at)}</td>
    <td><button class="btn btn-sm btn-success" onclick="restoreItem('referee',${r.id})">恢复</button>
    <button class="btn btn-sm btn-danger" onclick="purgeItem('referee',${r.id})">彻底删除</button></td></tr>`).join('') : empty;
}
async function restoreItem(type, id) {
  const res = await fetch(`/api/recycle-bin/${type}/${id}/restore`, { method: 'POST' });
  const d = await res.json().catch(()=>({}));
  if (!res.ok) { alert(d.error || '恢复失败'); return; }
  await loadAllData(); loadRecycleBin();
}
function purgeItem(type, id) {
  const label = { team: '球队', player: '球员', referee: '裁判' }[type];
  confirmDialog(`确定彻底删除该${label}吗？此操作不可恢复！`, async () => {
    const res = await fetch(`/api/recycle-bin/${type}/${id}`, { method: 'DELETE' });
    const d = await res.json().catch(()=>({}));
    if (!res.ok) { alert(d.error || '删除失败'); return; }
    await loadAllData(); loadRecycleBin();
  }, '🗑️');
}
// ========== C11 手动覆盖晋级 ==========
function submitAdvanceOverride(matchId) {
  const t1 = +document.getElementById('ov_t1').value;
  const t2 = +document.getElementById('ov_t2').value;
  if (!t1 || !t2) return alert('请选择双方球队');
  if (t1 === t2) return alert('双方不能是同一支球队');
  confirmDialog('手动指定后将锁定本场，后续比赛自动晋级不再改写本场对阵。确定？', async () => {
    const res = await fetch(`/api/matches/${matchId}/advance-override`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ team1_id: t1, team2_id: t2 })
    });
    const d = await res.json().catch(()=>({}));
    if (!res.ok) return alert(d.error || '操作失败');
    closeModal('matchModal'); await loadAllData(); refreshCurrentPage(); alert('已手动覆盖并锁定');
  }, '🔒');
}
async function restoreAutoAdvance(matchId) {
  const res = await fetch(`/api/matches/${matchId}/advance-auto`, { method: 'POST' });
  const d = await res.json().catch(()=>({}));
  if (!res.ok) return alert(d.error || '操作失败');
  closeModal('matchModal'); await loadAllData(); refreshCurrentPage(); alert('已恢复自动晋级并重新推导');
}

// ========== C10 战报（文本+复制+图片卡片） ==========
function buildMatchReport(m) {
  const t1 = m.team1 ? m.team1.name : '待定';
  const t2 = m.team2 ? m.team2.name : '待定';
  const evs = (m.events || []).slice().sort((a, b) => (a.minute - b.minute) || a.id - b.id);
  const line = (e, icon) => `${e.minute}' ${icon} ${e.team_name || ''} ${e.jersey_number || ''}${e.player_name ? ' ' + e.player_name : ''}${e.is_penalty_kick ? '（点球）' : ''}${e.event_type === 'sub' ? ' ↓ 换上 ' + (e.sub_in_name || '') : ''}${e.notes ? '（' + e.notes + '）' : ''}`;
  const goals = evs.filter(e => e.event_type === 'goal');
  const yellows = evs.filter(e => e.event_type === 'yellow');
  const reds = evs.filter(e => e.event_type === 'red');
  const subs = evs.filter(e => e.event_type === 'sub');
  let txt = `【2026绿岛杯战报】\n`;
  txt += `${roundFullText(m)} 场序${displayMatchNum(m)}\n`;
  txt += `${t1} ${m.team1_score ?? '-'} : ${m.team2_score ?? '-'} ${t2}\n`;
  if (m.has_penalty) txt += `（点球大战 ${m.penalty_team1} : ${m.penalty_team2}）\n`;
  txt += `比赛时间：${m.match_date || ''} ${m.match_time || ''}　地点：${m.match_location || ''}\n`;
  txt += `\n— 进球 —\n` + (goals.length ? goals.map(e => line(e, '⚽')).join('\n') : '无') + '\n';
  if (yellows.length) txt += `\n— 黄牌 —\n` + yellows.map(e => line(e, '🟨')).join('\n') + '\n';
  if (reds.length) txt += `\n— 红牌 —\n` + reds.map(e => line(e, '🟥')).join('\n') + '\n';
  if (subs.length) txt += `\n— 换人 —\n` + subs.map(e => line(e, '🔄')).join('\n') + '\n';
  if (m.mvp_player) txt += `\n🏆 本场MVP：${m.mvp_player.jersey_number}号 ${m.mvp_player.name}\n`;
  txt += `\n2026 沈阳城市学院“绿岛杯”足球赛组委会`;
  return { txt, goals, yellows, reds, t1, t2 };
}
async function openMatchReport(matchId) {
  const m = await fetch('/api/matches/' + matchId).then(r => r.json());
  if (m.error) return alert(m.error);
  const rep = buildMatchReport(m);
  window.__lastReport = { m, rep };
  document.getElementById('genericModalTitle').textContent = '比赛战报';
  document.getElementById('genericModalBody').innerHTML = `
    <textarea id="reportText" style="width:100%;min-height:300px;font-size:13px;line-height:1.7;padding:12px;border:1.5px solid var(--border);border-radius:8px;font-family:inherit" readonly>${rep.txt}</textarea>`;
  document.getElementById('genericModalFooter').innerHTML = `
    <button class="btn btn-outline" onclick="closeModal('genericModal')">关闭</button>
    <button class="btn btn-outline" onclick="copyReport()">📋 一键复制</button>
    <button class="btn btn-primary" onclick="exportReportCard()">🖼️ 导出图片卡片</button>`;
  showModal('genericModal');
}
function copyReport() {
  const ta = document.getElementById('reportText');
  ta.select();
  navigator.clipboard.writeText(ta.value).then(() => alert('战报已复制到剪贴板'), () => { ta.select(); document.execCommand('copy'); alert('已复制'); });
}
function exportReportCard() {
  const { m, rep } = window.__lastReport || {};
  if (!m) return;
  const W = 900, H = 1180;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  // 背景
  const grad = x.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#0F3326'); grad.addColorStop(1, '#1A4D3A');
  x.fillStyle = grad; x.fillRect(0, 0, W, H);
  x.fillStyle = '#ffffff';
  x.textAlign = 'center';
  x.font = 'bold 34px "Microsoft YaHei",sans-serif';
  x.fillText('2026 沈阳城市学院“绿岛杯”足球赛', W / 2, 70);
  x.font = '22px "Microsoft YaHei",sans-serif'; x.fillStyle = '#C8A45C';
  x.fillText(`${roundFullText(m)} · 场序${displayMatchNum(m)}`, W / 2, 112);
  // 比分卡
  x.fillStyle = 'rgba(255,255,255,0.08)';
  roundRect(x, 60, 150, W - 120, 220, 18); x.fill();
  x.fillStyle = '#fff'; x.font = 'bold 40px "Microsoft YaHei",sans-serif';
  x.fillText(rep.t1, 230, 235); x.fillText(rep.t2, W - 230, 235);
  x.font = 'bold 88px Arial'; x.fillStyle = '#C8A45C';
  x.fillText(`${m.team1_score ?? 0} : ${m.team2_score ?? 0}`, W / 2, 270);
  x.font = '20px "Microsoft YaHei",sans-serif'; x.fillStyle = 'rgba(255,255,255,0.8)';
  let sub = `${m.match_date || ''} ${m.match_time || ''} · ${m.match_location || ''}`;
  if (m.has_penalty) sub += `（点球 ${m.penalty_team1}:${m.penalty_team2}）`;
  x.fillText(sub, W / 2, 335);
  // 事件列表
  x.textAlign = 'left'; x.fillStyle = '#fff';
  let y = 430;
  const drawSection = (title, list, icon) => {
    x.font = 'bold 26px "Microsoft YaHei",sans-serif'; x.fillStyle = '#C8A45C';
    x.fillText(title, 90, y); y += 44;
    x.font = '22px "Microsoft YaHei",sans-serif'; x.fillStyle = '#eee';
    if (!list.length) { x.fillText('无', 110, y); y += 40; }
    list.forEach(e => {
      const s = `${e.minute}' ${icon} ${e.team_name || ''} ${e.jersey_number || ''} ${e.player_name || ''}${e.is_penalty_kick ? '（点）' : ''}${e.event_type === 'sub' ? ' 换 ' + (e.sub_in_name || '') : ''}`;
      x.fillText(s.length > 26 ? s.slice(0, 26) + '…' : s, 110, y); y += 38;
    });
    y += 18;
  };
  drawSection('⚽ 进球', rep.goals, '');
  if (rep.yellows.length) drawSection('🟨 黄牌', rep.yellows, '');
  if (rep.reds.length) drawSection('🟥 红牌', rep.reds, '');
  if (m.mvp_player) { x.font = 'bold 24px "Microsoft YaHei",sans-serif'; x.fillStyle = '#FFD700'; x.fillText(`🏆 MVP：${m.mvp_player.jersey_number}号 ${m.mvp_player.name}`, 90, y + 10); y += 50; }
  x.textAlign = 'center'; x.font = '18px "Microsoft YaHei",sans-serif'; x.fillStyle = 'rgba(255,255,255,0.6)';
  x.fillText('2026 绿岛杯赛事组委会', W / 2, H - 40);
  const a = document.createElement('a');
  a.download = `战报_场序${displayMatchNum(m)}_${rep.t1}vs${rep.t2}.png`;
  a.href = cv.toDataURL('image/png'); a.click();
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// B8 裁判执法档案
async function openRefProfile(id) {
  let d;
  try {
    const res = await fetch('/api/referees/' + id + '/profile');
    d = await res.json().catch(() => ({}));
    if (!res.ok) return alert(d.error || '执法档案加载失败');
  } catch (e) { return alert('执法档案加载失败，请稍后重试'); }
  if (d.error) return alert(d.error);
  const rc = d.role_count || {};
  const rate = d.on_time_rate === null ? '暂无主裁报告' : d.on_time_rate + '%';
  const rows = d.records.length ? d.records.map(x => `<tr>
    <td>${x.match_number}</td><td>${x.t1||'待定'} vs ${x.t2||'待定'}</td><td>${x.role_label||''}</td>
    <td class="text-center">${x.y}</td><td class="text-center">${x.r}</td>
    <td>${x.report_status==='submitted'?'已提交':(x.role==='main'?'未提交':'-')}</td></tr>`).join('')
    : '<tr><td colspan="6" style="text-align:center;color:#999;padding:12px">暂无已结束执法场次</td></tr>';
  document.getElementById('genericModalTitle').textContent = `执法档案 · ${d.referee.name}`;
  const spec = refSpec(d.referee);
  const specLine = `<div style="display:flex;align-items:center;gap:14px;margin-bottom:12px;font-size:13px">
      <span>专职岗位：${spec ? `<b>${REF_TYPE_LABELS[spec]||spec}</b>` : '<b>通用裁判（可担任所有位置）</b>'}</span>
      <span>承诺书：${d.referee.fair_play_path ? `<a href="${d.referee.fair_play_path}" target="_blank">查看已签署承诺书</a>` : '<span style="color:#e74c3c">缺失</span>'}</span>
    </div>`;
  document.getElementById('genericModalBody').innerHTML = specLine + `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
      ${[['已执法场次',d.total_finished],['主裁/助理/第四',`${rc.main||0}/${rc.assistant||0}/${rc.fourth||0}`],['出示黄/红牌',`${d.yellow}/${d.red}`],['主裁报告24h及时率',rate]]
        .map(([k,v])=>`<div style="background:var(--primary-lighter);border-radius:10px;padding:12px;text-align:center"><div style="font-size:18px;font-weight:700;color:var(--primary)">${v}</div><div style="font-size:12px;color:var(--text-light);margin-top:2px">${k}</div></div>`).join('')}
    </div>
    <div class="table-wrap" style="max-height:340px;overflow:auto"><table style="font-size:12px">
      <thead><tr><th>场序</th><th>对阵</th><th>角色</th><th>黄牌</th><th>红牌</th><th>报告</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  document.getElementById('genericModalFooter').innerHTML = `<button class="btn btn-outline" onclick="closeModal('genericModal')">关闭</button>`;
  showModal('genericModal');
}

// D14 管理员删除球队（软删除进回收站）
function deleteTeam(id) {
  const t = allTeams.find(x => x.id === id);
  if (!t) return;
  confirmDialog(`确定删除球队「${t.name}」吗？将移入回收站，可恢复。`, async () => {
    const res = await fetch('/api/teams/' + id, { method: 'DELETE' });
    const d = await res.json().catch(()=>({}));
    if (!res.ok) { alert(d.error || '删除失败'); return; }
    await loadAllData(); loadTeams();
  }, '🗑️');
}


// ========== 管理员：停服维护设置 ==========
async function runSystemSelfCheck() {
  const box = document.getElementById('selfCheckResult');
  if (!box) return;
  box.innerHTML = '<div style="font-size:13px;color:var(--text-light)">正在自检，请稍候……</div>';
  try {
    const r = await fetch('/api/admin/self-check');
    const d = await r.json();
    if (!r.ok) { box.innerHTML = '<div style="color:#c62828">自检请求失败：' + (d.error || r.status) + '</div>'; return; }
    const rows = (d.checks || []).map(c =>
      '<div style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:1px dashed #e3eae6;font-size:12.5px">' +
      '<span style="flex:0 0 auto;font-weight:700;color:' + (c.ok ? '#2e7d32' : '#c62828') + '">' + (c.ok ? '✓ 通过' : '✗ 异常') + '</span>' +
      '<span style="flex:1"><b>' + c.name + '</b><div style="color:var(--text-light)">' + (c.detail || '') + '</div></span></div>').join('');
    const head = d.ok
      ? '<div style="margin-bottom:8px;padding:8px 12px;background:#e8f5e9;border-radius:8px;color:#2e7d32;font-weight:700;font-size:13.5px">全部 ' + d.checks.length + ' 项通过，系统状态正常（' + d.version + '，已运行 ' + Math.floor(d.uptimeSec/60) + ' 分钟）</div>'
      : '<div style="margin-bottom:8px;padding:8px 12px;background:#ffebee;border-radius:8px;color:#c62828;font-weight:700;font-size:13.5px">发现 ' + d.problems.length + ' 项异常，请按下方条目排查</div>';
    box.innerHTML = head + rows;
  } catch (e) { box.innerHTML = '<div style="color:#c62828">自检失败：' + e.message + '</div>'; }
}
window.runSystemSelfCheck = runSystemSelfCheck;

async function loadMaintenancePanel() {
  const stateEl = document.getElementById('maintNowState');
  const enChk = document.getElementById('maintEnabledChk');
  const manChk = document.getElementById('maintManualChk');
  if (!stateEl) return;
  let d;
  try { d = await fetch('/api/settings/maintenance').then(r => r.json()); } catch (e) { stateEl.textContent = '状态获取失败'; return; }
  if (enChk) enChk.checked = !!d.enabled;
  if (manChk) manChk.checked = !!d.manual;
  stateEl.innerHTML = d.activeNow
    ? (d.reason === 'manual'
        ? '<span style="color:#c62828">● 当前为<b>手动停服</b>状态，球队端/裁判端已暂停；关闭下方"立即手动维护"即恢复</span>'
        : '<span style="color:#c62828">● 当前处于<b>定时维护</b>时段（01:00–07:00），球队端/裁判端已暂停，07:00 自动恢复</span>')
    : '<span style="color:#2e7d32">● 当前正常开放（北京时间 ' + d.beijingHour + ' 时）</span>';
}
async function setMaintenanceFlag(key, val) {
  const body = {}; body[key] = val ? 1 : 0;
  const r = await fetch('/api/settings/maintenance', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).then(x => x.json()).catch(() => null);
  if (!r || r.ok === false) { alert('操作失败，请重试'); loadMaintenancePanel(); return; }
  if (key === 'manual') {
    alert(val ? '已立即进入维护，球队端/裁判端此刻起被拦截。' : '已结束手动维护，访问恢复。');
  }
  loadMaintenancePanel();
}
window.loadMaintenancePanel = loadMaintenancePanel;
window.setMaintenanceFlag = setMaintenanceFlag;
