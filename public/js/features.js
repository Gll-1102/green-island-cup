/* ============================================================
 * 绿岛杯 V2.2 扩展功能：荣誉榜 / 报名冻结 / 电子参赛证 / 官方记录单
 * 以全局函数方式挂载，供页面 onclick 直接调用（与 app.js 同全局作用域）
 * ============================================================ */

// ---------- 轻量提示 ----------
let __toastTimer = null;
function toast(msg, type) {
  let el = document.getElementById('__toast');
  if (!el) {
    el = document.createElement('div');
    el.id = '__toast';
    el.style.cssText = 'position:fixed;left:50%;top:22px;transform:translateX(-50%);z-index:99999;padding:10px 20px;border-radius:10px;color:#fff;font-size:14px;box-shadow:0 6px 20px rgba(0,0,0,.18);opacity:0;transition:opacity .25s;pointer-events:none;max-width:80vw';
    document.body.appendChild(el);
  }
  el.style.background = type === 'error' ? '#c62828' : type === 'success' ? '#2e7d32' : '#1A4D3A';
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(__toastTimer);
  __toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2400);
}

// ============================================================
// 一、荣誉榜
// ============================================================
async function loadHonors() {
  const wrap = document.getElementById('honorsContent');
  const adminBar = document.getElementById('honorsAdminBar');
  if (!wrap) return;
  wrap.innerHTML = '<div class="empty-state">加载中…</div>';
  const fetchD = (g) => fetch('/api/awards/honors' + (g ? `?gender=${g}` : '')).then(r => r.json());
  let sections;
  try {
    const g = (typeof currentGender !== 'undefined') ? currentGender : 'men';
    if (g === 'women') sections = [['女子组', await fetchD('women')]];
    else if (g === 'all') sections = [['⚽ 男子组', await fetchD('men')], ['🏐 女子组', await fetchD('women')]];
    else sections = [['男子组', await fetchD('')]];
  } catch (e) { wrap.innerHTML = '<div class="empty-state">荣誉数据加载失败</div>'; return; }

  const awardCard = (icon, title, names, sub, color) => `
    <div style="flex:1 1 260px;min-width:240px;background:#fff;border:1px solid var(--border);border-top:4px solid ${color};border-radius:14px;padding:20px">
      <div style="font-size:30px">${icon}</div>
      <div style="font-size:16px;font-weight:700;margin:8px 0 4px">${title}</div>
      <div style="font-size:20px;font-weight:700;color:${color}">${names || '<span style="font-size:13px;color:var(--text-light);font-weight:400">决赛结束后产生</span>'}</div>
      ${sub ? `<div style="font-size:12px;color:var(--text-light);margin-top:6px">${sub}</div>` : ''}
    </div>`;

  const renderSection = (label, d) => {
    const gb = d.golden_boot || [];
    const fp = d.fair_play || [];
    const fpTable = d.fair_play_table || [];
    const designated = d.designated || [];
    const bestPlayer = designated.find(x => x.award_type === 'best_player');
    const bestGK = designated.find(x => x.award_type === 'best_goalkeeper');
    let html = (sections.length > 1) ? `<div style="font-size:16px;font-weight:700;color:#1f5c43;margin:6px 2px 12px">${label}</div>` : '';
    html += `<div class="card" style="margin-bottom:16px"><div style="padding:20px">
    <div style="display:flex;gap:14px;flex-wrap:wrap">
      ${awardCard('🥇', '金靴奖',
        gb.map(p => `${p.name}（${p.team_name}）`).join('、'),
        gb.length ? `${gb[0].goals}球${gb[0].assists?` · ${gb[0].assists}助攻`:''}${gb.length>1?' · 并列获奖':''}` : '', '#C8A45C')}
      ${awardCard('🧤', '金手套奖', bestGK ? `${bestGK.player_name}（${bestGK.team_name}）` : '', '', '#2D6B52')}
      ${awardCard('⭐', '金球奖', bestPlayer ? `${bestPlayer.player_name}（${bestPlayer.team_name}）` : '', '', '#1565C0')}
      ${awardCard('🤝', '公平竞赛奖', fp.map(t => t.team_name).join('、'),
        fp.length ? `黄牌${fp[0].yellow}/红牌${fp[0].red}，扣分${fp[0].points}${fp.length>1?' · 并列获奖':''}` : '', '#2e7d32')}
    </div></div></div>`;
    // 公平竞赛积分榜
    const played = fpTable.filter(t => t.played > 0);
    html += `<div class="card"><div class="card-header"><div class="card-title">公平竞赛积分榜${sections.length>1?'（'+label.replace(/[⚽🏐\s]/g,'')+'）':''}</div>
    <div style="font-size:12px;color:var(--text-light)">黄牌计1分、红牌计3分，分数越低越佳（仅统计已完赛场次）</div></div>
    <div class="table-wrap"><table><thead><tr><th>排名</th><th>球队</th><th>已赛</th><th>黄牌</th><th>红牌</th><th>扣分</th></tr></thead><tbody>
    ${(played.length ? played : fpTable).map((t,i)=>`<tr${i===0&&t.played>0?' style="background:#f4faf5"':''}>
      <td class="text-center">${t.played>0?(i===0?'🥇':i+1):'—'}</td><td><strong>${t.team_name}</strong></td>
      <td class="text-center">${t.played}</td><td class="text-center">${t.yellow}</td><td class="text-center">${t.red}</td>
      <td class="text-center" style="font-weight:700">${t.points}</td></tr>`).join('')}
    </tbody></table></div></div>`;
    return { html, bestPlayer, bestGK };
  };
  const rendered = sections.map(([label, d]) => renderSection(label, d));
  wrap.innerHTML = rendered.map(r => r.html).join('<div style="height:8px"></div>');
  const last = rendered[rendered.length - 1];

  // 管理员指定最佳球员/门将（仅在单一性别视图下可操作，避免跨性别误指）
  if (adminBar) {
    if (isAdmin() && (typeof currentGender === 'undefined' || currentGender !== 'all')) {
      const gIsWomen = currentGender === 'women';
      const opts = (sel) => '<option value="">— 暂不指定 —</option>' +
        allPlayers.filter(p => !p.is_official && p.status === 'approved' && ((p.gender || 'men') === (gIsWomen ? 'women' : 'men')))
          .map(p => `<option value="${p.id}" ${sel===p.id?'selected':''}>${p.name}（${p.team_name||teamName(p.team_id)} ${p.jersey_number}号）</option>`).join('');
      adminBar.style.display = 'block';
      adminBar.innerHTML = `<div class="card" style="padding:16px 20px;display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap">
        <div class="form-group" style="margin:0;min-width:240px"><label>指定金球奖（${gIsWomen?'女子组':'男子组'}）</label>
          <select id="honorBestPlayer" onchange="designateAward('best_player',this.value)">${opts(last.bestPlayer?last.bestPlayer.player_id:null)}</select></div>
        <div class="form-group" style="margin:0;min-width:240px"><label>指定金手套奖（${gIsWomen?'女子组':'男子组'}）</label>
          <select id="honorBestGK" onchange="designateAward('best_goalkeeper',this.value)">${opts(last.bestGK?last.bestGK.player_id:null)}</select></div>
        <button class="btn btn-outline no-print" onclick="window.print()">🖨️ 打印荣誉榜</button>
      </div>`;
    } else adminBar.style.display = 'none';
  }
}
async function designateAward(type, playerId) {
  const res = await fetch('/api/awards/designate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ award_type:type, player_id: playerId?+playerId:null }) });
  const d = await res.json().catch(()=>({}));
  if (!res.ok) { alert(d.error||'操作失败'); loadHonors(); return; }
  toast(playerId ? '已指定' : '已取消指定', 'success');
  loadHonors();
}

// ============================================================
// 二、报名注册冻结
// ============================================================
async function loadFreezePanel() {
  const card = document.getElementById('freezeCard');
  if (!card) return;
  card.style.display = isAdmin() ? 'block' : 'none';
  if (!isAdmin()) return;
  // 男子/女子冻结相互独立，面板跟随当前所在组别（"全部"时按男子）
  const g = (typeof currentGender !== 'undefined' && currentGender === 'women') ? 'women' : 'men';
  const gLabel = g === 'women' ? '女子组' : '男子组';
  const [s, rc] = await Promise.all([
    fetch('/api/settings/public').then(r=>r.json()).catch(()=>({})),
    fetch('/api/roster-counts?gender=' + g).then(r=>r.json()).catch(()=>[])
  ]);
  const frozen = g === 'women' ? s.registration_frozen_women === 1 : s.registration_frozen_men === 1;
  document.getElementById('freezeStatus').innerHTML = frozen
    ? `<span style="color:#1565c0">🧊 ${gLabel}当前状态：已冻结（球队名单锁定）</span>`
    : `<span style="color:#2e7d32">🔓 ${gLabel}当前状态：开放报名（球队可编辑名单）</span>`;
  document.getElementById('btnFreeze').style.display = frozen ? 'none' : 'inline-block';
  document.getElementById('btnUnfreeze').style.display = frozen ? 'inline-block' : 'none';
  const el = document.getElementById('rosterCounts');
  if (Array.isArray(rc) && rc.length) {
    el.innerHTML = `${gLabel}各队上场球员人数（冻结需 11–23）：<br>` + rc.map(r => {
      const ok = r.player_count >= 11 && r.player_count <= 23 && r.pending_count === 0;
      return `<span style="display:inline-block;margin:3px 6px 0 0;padding:2px 8px;border-radius:10px;background:${ok?'#e8f5e9':'#fdecea'};color:${ok?'#2e7d32':'#c62828'}">${r.name}：${r.player_count}人${r.pending_count?` · 待审批${r.pending_count}`:''}</span>`;
    }).join('');
  }
}
async function setRegistrationFreeze(on) {
  const g = (typeof currentGender !== 'undefined' && currentGender === 'women') ? 'women' : 'men';
  const gLabel = g === 'women' ? '女子组' : '男子组';
  if (on && !confirm(`冻结后${gLabel}各队不能再增删改运动员名单（球队官员仍可维护），确定冻结${gLabel}吗？`)) return;
  if (!on && !confirm(`确定解除${gLabel}冻结、重新开放报名吗？`)) return;
  const doPost = (force) => fetch('/api/settings/registration-freeze', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ frozen: on, gender: g, force: !!force }) });
  let res = await doPost(false);
  let d = await res.json().catch(()=>({}));
  if (!res.ok) {
    if (d.need_confirm) {
      if (!confirm(d.error + '\n\n如确认仍要强制冻结，请点确定。')) { loadFreezePanel(); return; }
      res = await doPost(true); d = await res.json().catch(()=>({}));
      if (!res.ok) { alert(d.error||'操作失败'); return; }
    } else { alert(d.error||'操作失败'); return; }
  }
  toast(on ? `${gLabel}报名已冻结并通知各队` : `${gLabel}报名已解冻`, 'success');
  loadFreezePanel();
}

// ============================================================
// 三、电子参赛证
// ============================================================
async function openCredential(playerId) {
  document.getElementById('genericModalTitle').textContent = '电子参赛证';
  document.getElementById('genericModalBody').innerHTML = '<div class="empty-state">正在生成…</div>';
  document.getElementById('genericModalFooter').innerHTML = '<button class="btn btn-outline" onclick="closeModal(\'genericModal\')">关闭</button>';
  showModal('genericModal');
  const res = await fetch('/api/players/' + playerId + '/credential');
  const d = await res.json().catch(()=>({}));
  if (!res.ok) { document.getElementById('genericModalBody').innerHTML = `<div class="empty-state">${d.error||'生成失败'}</div>`; return; }
  window.__lastCredential = d;
  const p = d.player;
  document.getElementById('genericModalBody').innerHTML = credentialCardHtml(d, true);
  document.getElementById('genericModalFooter').innerHTML = `
    <button class="btn btn-outline" onclick="closeModal('genericModal')">关闭</button>
    <button class="btn btn-primary" onclick="printOneCredential()">🖨️ 打印 / 另存PDF</button>`;
}
function credentialCardHtml(d, withQr) {
  const p = d.player;
  return `<div style="border:2px solid var(--primary);border-radius:14px;overflow:hidden;max-width:420px;margin:0 auto">
    <div style="background:var(--primary);color:#fff;padding:10px 16px;text-align:center;font-weight:700;font-size:15px">2026 沈阳城市学院“绿岛杯”足球赛 · 电子参赛证</div>
    <div style="display:flex;gap:14px;padding:16px">
      ${p.photo_path
        ? `<img src="${p.photo_path}" alt="证件照" style="width:96px;height:128px;object-fit:cover;border-radius:8px;border:1px solid var(--border);background:#f0f0f0">`
        : `<div style="width:96px;height:128px;border-radius:8px;border:1px solid var(--border);background:var(--primary-lighter,#E8F0EC);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--primary);font-size:12px;text-align:center;padding:6px">${p.is_official?'<span style="font-size:22px">👔</span>球队官员':'<span style="font-size:22px">🧑</span>暂无证件照'}</div>`}
      <div style="flex:1;font-size:13.5px;line-height:1.9">
        <div><strong style="font-size:18px">${p.name}</strong> ${p.is_captain?'<span style="color:#C8A45C">（队长）</span>':''}</div>
        <div>球队：${d.team.name}</div>
        <div>号码：<strong>${p.jersey_number||'—'}</strong>　位置：${p.position||'—'}</div>
        <div>学号/工号：${p.student_id||'—'}</div>
        <div>班级：${p.class_name||'—'}</div>
        <div>资格：${d.eligible?'<span style="color:#2e7d32;font-weight:600">✔ 可参赛</span>':'<span style="color:#c62828;font-weight:600">✘ 停赛中</span>'}</div>
      </div>
    </div>
    ${withQr?`<div style="text-align:center;padding:0 16px 14px"><img src="${d.qrDataUrl}" style="width:150px;height:150px"><div style="font-size:11px;color:var(--text-light);margin-top:4px">现场扫码核验 · 凭证编号 ${d.code}</div></div>`:''}
  </div>`;
}
function printOneCredential() {
  if (!window.__lastCredential) return;
  const w = window.open('', '_blank');
  w.document.write(credentialPrintHead() + credentialCardHtml(window.__lastCredential, true) + '</body></html>');
  w.document.close(); setTimeout(()=>w.print(), 300);
}
function credentialPrintHead() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>电子参赛证</title><style>
  body{font-family:"Microsoft YaHei",sans-serif;padding:20px}*{box-sizing:border-box}</style></head><body>`;
}

// ========== 电子裁判证（同款参赛证样式，信息对应裁判字段）==========
async function openRefereeCredential(refereeId) {
  document.getElementById('genericModalTitle').textContent = '电子裁判证';
  document.getElementById('genericModalBody').innerHTML = '<div class="empty-state">正在生成…</div>';
  document.getElementById('genericModalFooter').innerHTML = '<button class="btn btn-outline" onclick="closeModal(\'genericModal\')">关闭</button>';
  showModal('genericModal');
  const res = await fetch('/api/referees/' + refereeId + '/credential');
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { document.getElementById('genericModalBody').innerHTML = `<div class="empty-state">${d.error || '生成失败'}</div>`; return; }
  window.__lastRefereeCredential = d;
  document.getElementById('genericModalBody').innerHTML = refereeCardHtml(d, true);
  document.getElementById('genericModalFooter').innerHTML = `
    <button class="btn btn-outline" onclick="closeModal('genericModal')">关闭</button>
    <button class="btn btn-primary" onclick="printRefereeCredential()">🖨️ 打印 / 另存PDF</button>`;
}
function refereeCardHtml(d, withQr) {
  const r = d.referee;
  const photo = r.photo_path
    ? `<img src="${r.photo_path}" alt="证件照" style="width:96px;height:128px;object-fit:cover;border-radius:8px;border:1px solid var(--border);background:#f0f0f0">`
    : `<div style="width:96px;height:128px;border-radius:8px;border:1px solid var(--border);background:var(--primary-lighter,#E8F0EC);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--primary);font-size:12px;text-align:center;padding:6px"><span style="font-size:22px">🧑‍⚖️</span>暂无证件照</div>`;
  return `<div style="border:2px solid var(--primary);border-radius:14px;overflow:hidden;max-width:420px;margin:0 auto">
    <div style="background:var(--primary);color:#fff;padding:10px 16px;text-align:center;font-weight:700;font-size:15px">2026 沈阳城市学院“绿岛杯”足球赛 · 电子裁判证</div>
    <div style="display:flex;gap:14px;padding:16px">
      ${photo}
      <div style="flex:1;font-size:13.5px;line-height:1.9">
        <div><strong style="font-size:18px">${escapeHtml(r.name)}</strong></div>
        <div>裁判等级：${escapeHtml(r.level) || '—'}</div>
        <div>所在学院：${escapeHtml(r.college) || '—'}</div>
        <div>裁判编号：${escapeHtml(r.serial_number) || '—'}</div>
        <div>专职岗位：${escapeHtml(r.ref_type_label) || '通用裁判'}</div>
      </div>
    </div>
    ${withQr ? `<div style="text-align:center;padding:0 16px 14px"><img src="${d.qrDataUrl}" style="width:150px;height:150px"><div style="font-size:11px;color:var(--text-light);margin-top:4px">现场扫码核验 · 凭证编号 ${d.code}</div></div>` : ''}
  </div>`;
}
function printRefereeCredential() {
  if (!window.__lastRefereeCredential) return;
  const w = window.open('', '_blank');
  w.document.write(credentialPrintHead() + refereeCardHtml(window.__lastRefereeCredential, true) + '</body></html>');
  w.document.close(); setTimeout(() => w.print(), 300);
}

// ========== 电子裁判证（同款参赛证样式，信息对应裁判字段）==========
async function openRefereeCredential(refereeId) {
  document.getElementById('genericModalTitle').textContent = '电子裁判证';
  document.getElementById('genericModalBody').innerHTML = '<div class="empty-state">正在生成…</div>';
  document.getElementById('genericModalFooter').innerHTML = '<button class="btn btn-outline" onclick="closeModal(\'genericModal\')">关闭</button>';
  showModal('genericModal');
  const res = await fetch('/api/referees/' + refereeId + '/credential');
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { document.getElementById('genericModalBody').innerHTML = `<div class="empty-state">${d.error || '生成失败'}</div>`; return; }
  window.__lastRefereeCredential = d;
  document.getElementById('genericModalBody').innerHTML = refereeCardHtml(d, true);
  document.getElementById('genericModalFooter').innerHTML = `
    <button class="btn btn-outline" onclick="closeModal('genericModal')">关闭</button>
    <button class="btn btn-primary" onclick="printRefereeCredential()">🖨️ 打印 / 另存PDF</button>`;
}
function refereeCardHtml(d, withQr) {
  const r = d.referee;
  const photo = r.photo_path
    ? `<img src="${r.photo_path}" alt="证件照" style="width:96px;height:128px;object-fit:cover;border-radius:8px;border:1px solid var(--border);background:#f0f0f0">`
    : `<div style="width:96px;height:128px;border-radius:8px;border:1px solid var(--border);background:var(--primary-lighter,#E8F0EC);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--primary);font-size:12px;text-align:center;padding:6px"><span style="font-size:22px">🧑‍⚖️</span>暂无证件照</div>`;
  return `<div style="border:2px solid var(--primary);border-radius:14px;overflow:hidden;max-width:420px;margin:0 auto">
    <div style="background:var(--primary);color:#fff;padding:10px 16px;text-align:center;font-weight:700;font-size:15px">2026 沈阳城市学院“绿岛杯”足球赛 · 电子裁判证</div>
    <div style="display:flex;gap:14px;padding:16px">
      ${photo}
      <div style="flex:1;font-size:13.5px;line-height:1.9">
        <div><strong style="font-size:18px">${escapeHtml(r.name)}</strong></div>
        <div>裁判等级：${escapeHtml(r.level) || '—'}</div>
        <div>所在学院：${escapeHtml(r.college) || '—'}</div>
        <div>裁判编号：${escapeHtml(r.serial_number) || '—'}</div>
        <div>专职岗位：${escapeHtml(r.ref_type_label) || '通用裁判'}</div>
      </div>
    </div>
    ${withQr ? `<div style="text-align:center;padding:0 16px 14px"><img src="${d.qrDataUrl}" style="width:150px;height:150px"><div style="font-size:11px;color:var(--text-light);margin-top:4px">现场扫码核验 · 凭证编号 ${d.code}</div></div>` : ''}
  </div>`;
}
function printRefereeCredential() {
  if (!window.__lastRefereeCredential) return;
  const w = window.open('', '_blank');
  w.document.write(credentialPrintHead() + refereeCardHtml(window.__lastRefereeCredential, true) + '</body></html>');
  w.document.close(); setTimeout(() => w.print(), 300);
}
// 整队批量打印参赛证
async function batchPrintCredentials(teamId) {
  const list = allPlayers.filter(p => p.team_id === teamId && !p.is_official && p.status === 'approved');
  if (!list.length) return alert('该队暂无已审批球员');
  toast('正在生成 ' + list.length + ' 张参赛证…');
  let cards = '';
  for (const p of list) {
    const res = await fetch('/api/players/' + p.id + '/credential');
    if (res.ok) { const d = await res.json(); cards += '<div style="margin-bottom:18px;page-break-inside:avoid">' + credentialCardHtml(d, true) + '</div>'; }
  }
  if (!cards) return alert('参赛证生成失败，请稍后重试');
  const w = window.open('', '_blank');
  if (!w) return alert('浏览器拦截了打印窗口，请允许弹出窗口');
  w.document.write(credentialPrintHead() + cards + '</body></html>');
  w.document.close();
  setTimeout(() => w.print(), 500);
}

// ============================================================
// 四、官方比赛记录单（A4 网页打印）
// ============================================================
function printMatchSheet() {
  const m = matchDetailData;
  if (!m) return;
  const t1 = m.team1 ? m.team1.name : (m.team1_source||'待定');
  const t2 = m.team2 ? m.team2.name : (m.team2_source||'待定');
  const evs = (m.events||[]).slice().sort((a,b)=>(a.minute-b.minute)||(a.id-b.id));
  const line = (txt)=>`<tr><td style="padding:5px 8px;border:1px solid #333">${txt||''}</td></tr>`;
  const evRow = (e)=>{
    const who = e.player_name ? `${e.jersey_number||''}号 ${e.player_name}` : '';
    const map = { goal:'⚽进球', own_goal:'🦶乌龙', assist:'🅰助攻', yellow:'🟨黄牌', red:'🟥红牌', sub:'🔄换人' };
    let detail = map[e.event_type]||e.event_type;
    if (e.event_type==='goal' && e.is_penalty_kick) detail += '(点球)';
    if (e.event_type==='sub') detail += ` ${who}↓ / ${e.sub_in_name||''}${e.sub_in_number?('('+e.sub_in_number+'号)'):''}↑`;
    else detail += ' ' + who;
    return `<tr><td style="padding:5px 8px;border:1px solid #333">${e.minute}'</td>
      <td style="padding:5px 8px;border:1px solid #333">${e.team_name||''}</td>
      <td style="padding:5px 8px;border:1px solid #333">${detail}</td></tr>`;
  };
  const starters = (tid)=> (m.lineups||[]).filter(l=>l.team_id===tid && l.is_starter===1);
  const subs = (tid)=> (m.lineups||[]).filter(l=>l.team_id===tid && l.is_starter!==1);
  const rosterBlock = (title, list) => `<div style="margin-bottom:8px"><strong>${title}（${list.length}人）</strong>
    <div style="font-size:12px;line-height:1.8">${list.map(p=>`${p.jersey_number}号 ${p.name}${p.position?'/'+p.position:''}`).join('　')||'无'}</div></div>`;
  const scoreText = `${m.team1_score??'-'} : ${m.team2_score??'-'}` +
    (m.has_penalty ? `（点球 ${m.penalty_team1??0}:${m.penalty_team2??0}）` : '') +
    (m.ht_team1_score!=null ? `　半场 ${m.ht_team1_score}:${m.ht_team2_score}` : '');
  const rn = (r)=> r ? r.name : '（未指派）';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>比赛记录单-场序${(typeof displayMatchNum==='function')?displayMatchNum(m):m.match_number}</title>
  <style>body{font-family:"Microsoft YaHei",sans-serif;padding:26px;color:#111;font-size:13px}
  h1{text-align:center;font-size:20px;margin:0 0 4px}.sub{text-align:center;color:#444;margin-bottom:14px;font-size:13px}
  table{width:100%;border-collapse:collapse;margin:8px 0}td,th{border:1px solid #333;padding:5px 8px}th{background:#f0f0f0}
  .score{font-size:22px;font-weight:700;text-align:center;padding:10px;border:1px solid #333;margin:8 0}
  .sign{margin-top:26px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;font-size:13px}
  .sign span{display:inline-block;min-width:150px;border-bottom:1px solid #333;padding:18px 8px 2px;text-align:center}
  @media print{.no-print{display:none}} </style></head><body>
  <div class="no-print" style="text-align:right;margin-bottom:8px"><button onclick="window.print()">打印 / 另存PDF</button></div>
  <h1>2026 沈阳城市学院“绿岛杯”足球赛 比赛记录单</h1>
  <div class="sub">场序 ${(typeof displayMatchNum==='function')?displayMatchNum(m):m.match_number} · ${typeof roundFullText==='function'?roundFullText(m):(m.round_name||'')}　比赛时间：${m.match_date||'—'} ${m.match_time||''}　地点：${m.match_location||'三期操场'}</div>
  <div class="score">${t1}　${scoreText}　${t2}</div>
  <table><tr><th style="width:50%">${t1}</th><th style="width:50%">${t2}</th></tr><tr>
  <td style="vertical-align:top">${rosterBlock('首发',starters(m.team1_id))}${rosterBlock('替补',subs(m.team1_id))}</td>
  <td style="vertical-align:top">${rosterBlock('首发',starters(m.team2_id))}${rosterBlock('替补',subs(m.team2_id))}</td></tr></table>
  <strong>比赛事件</strong>
  <table><thead><tr><th style="width:60px">时间</th><th style="width:120px">球队</th><th>事件</th></tr></thead>
  <tbody>${evs.length?evs.map(evRow).join(''):'<tr><td colspan="3" style="text-align:center;color:#888">无事件记录</td></tr>'}</tbody></table>
  <table>
    ${line('主裁判：'+rn(m.main_referee))}
    ${line('助理裁判1：'+rn(m.assistant_ref1)+'　　助理裁判2：'+rn(m.assistant_ref2))}
    
    ${line('本场最佳球员(MVP)：'+(m.mvp_player?`${m.mvp_player.jersey_number}号 ${m.mvp_player.name}`:'—'))}
  </table>
  <div class="sign">
    <span>主队队长签字</span><span>客队队长签字</span><span>主裁判签字</span><span>第四官员签字</span>
  </div>
  </body></html>`;
  const w = window.open('', '_blank');
  w.document.write(html); w.document.close();
}

// ============================================================
// 五、裁判辅助选派（智能推荐 + 一键填充）
// ============================================================
const REF_SLOT_SEL = { main:'m_ref', assistant1:'m_ref1', assistant2:'m_ref2', fourth:'m_fourth' };
let __refRecCache = null;
async function loadRefRecommend() {
  const panel = document.getElementById('refRecommendPanel');
  if (!panel) return;
  panel.innerHTML = '<div style="font-size:13px;color:var(--text-light)">正在计算推荐…</div>';
  const res = await fetch('/api/referees/recommend?match_id=' + matchDetailData.id);
  const d = await res.json().catch(()=>({}));
  if (!res.ok) { panel.innerHTML = `<div style="color:#c62828;font-size:13px">${d.error||'推荐加载失败'}</div>`; return; }
  __refRecCache = d;
  const order = ['main','assistant1','assistant2','fourth'];
  let html = '<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;font-size:13px">';
  order.forEach(slot => {
    const list = (d.slots && d.slots[slot]) || [];
    const top = list.slice(0, 3);
    html += `<div style="display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-bottom:1px solid var(--border);flex-wrap:wrap">
      <span style="min-width:96px;font-weight:600">${d.slotLabels[slot]}</span>
      <div style="flex:1;min-width:220px">${top.length ? top.map(c => `
        <span style="display:inline-flex;align-items:center;gap:6px;margin:2px 6px 2px 0;padding:3px 10px;border-radius:14px;background:${c.conflict?'#fdecea':'var(--primary-lighter)'};color:${c.conflict?'#c62828':'var(--primary)'}">
          ${c.name} <small>${c.score}分${c.tags.length?' · '+c.tags.join('/'):''}${c.warns.length?' · ⚠'+c.warns[0]:''}</small>
          <button type="button" class="btn btn-sm" style="padding:0 8px" onclick="adoptRef('${slot}',${c.id})">采用</button>
        </span>`).join('') : '<span style="color:var(--text-light)">暂无可选裁判</span>'}</div>
    </div>`;
  });
  html += '</div><button type="button" class="btn btn-primary btn-sm" style="margin-top:8px" onclick="autoFillRefs()">⚡ 一键智能填充（自动避开冲突）</button>';
  panel.innerHTML = html;
}
function adoptRef(slot, refId) {
  const sel = document.getElementById(REF_SLOT_SEL[slot]);
  if (!sel) return;
  if (!Array.from(sel.options).some(o => +o.value === refId)) { toast('该裁判不适合此岗位或已被占用', 'error'); return; }
  sel.value = String(refId);
  if (typeof updateRefSelects === 'function') updateRefSelects();
  toast('已采用，可继续调整后点“保存基本信息”', 'success');
}
function autoFillRefs() {
  if (!__refRecCache) return;
  let n = 0;
  Object.keys(REF_SLOT_SEL).forEach(slot => {
    const refId = __refRecCache.auto[slot];
    const sel = document.getElementById(REF_SLOT_SEL[slot]);
    if (!sel || refId == null) return;
    if (Array.from(sel.options).some(o => +o.value === refId)) { sel.value = String(refId); n++; }
  });
  if (typeof updateRefSelects === 'function') updateRefSelects();
  toast(`已自动填充 ${n} 个岗位，请核对后保存`, 'success');
}

// 打印当前筛选球队的参赛证（管理员按筛选；球队端固定本队）
function printCredentialsCurrent() {
  let teamId = null;
  if (typeof currentUser !== 'undefined' && currentUser && currentUser.role === 'viewer') teamId = currentUser.team_id;
  else { const sel = document.getElementById('filterTeam'); teamId = sel ? +sel.value : 0; if (!teamId) return alert('请先在球队筛选中选择某一支球队，再整队打印'); }
  batchPrintCredentials(teamId);
}

// ========== 裁判评分功能 ==========
function ratingWindowOpen(m){
  if(!m.finished_at) return false;
  const closes = new Date(String(m.finished_at).replace(' ','T')+'+08:00').getTime()+48*3600*1000;
  return Date.now()<=closes;
}
function fmtCloseTime(ts){
  const d = new Date(ts+8*3600*1000);
  const p = n=>String(n).padStart(2,'0');
  return `${d.getUTCMonth()+1}月${d.getUTCDate()}日 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// —— 球队端：评分链接弹窗 ——
async function openRatingLink(matchId){
  document.getElementById('genericModalTitle').textContent='裁判评分 · 队内评分通道';
  document.getElementById('genericModalBody').innerHTML='<div class="empty-state">正在生成评分链接…</div>';
  document.getElementById('genericModalFooter').innerHTML='<button class="btn btn-outline" onclick="closeModal(\'genericModal\')">关闭</button>';
  showModal('genericModal');
  const res = await fetch(`/api/matches/${matchId}/ratings/token`,{method:'POST'});
  const d = await res.json().catch(()=>({}));
  if(!res.ok){ document.getElementById('genericModalBody').innerHTML=`<div class="empty-state">${escapeHtml(d.error||'生成失败')}</div>`; return; }
  document.getElementById('genericModalBody').innerHTML = `
  <div style="text-align:center">
    <img src="${d.qr}" alt="评分二维码" style="width:240px;height:240px;border:1px solid var(--border-light);border-radius:10px;padding:6px;background:#fff">
    <div style="margin-top:10px;font-size:13px;color:var(--text-light)">手机扫码或复制链接发到队内群，队员打开即可匿名评分</div>
  </div>
  <div style="margin-top:14px">
    <div style="font-size:13px;font-weight:600;margin-bottom:5px">评分链接</div>
    <div style="display:flex;gap:8px">
      <input id="ratingUrlInput" readonly value="${escapeHtml(d.full_url)}" style="flex:1;font-size:12px;padding:9px">
      <button class="btn btn-outline btn-sm" onclick="copyRatingUrl()">复制链接</button>
    </div>
  </div>
  <div style="margin-top:14px;display:flex;gap:10px;text-align:center">
    <div style="flex:1;background:#f4f8f5;border-radius:10px;padding:10px">
      <div style="font-size:20px;font-weight:700;color:var(--primary)">${d.rated_count}<span style="font-size:13px;color:var(--text-light)">/${d.roster_count}</span></div>
      <div style="font-size:12px;color:var(--text-light)">已评/应评人数</div>
    </div>
    <div style="flex:1;background:#fdf8ef;border-radius:10px;padding:10px">
      <div style="font-size:15px;font-weight:700;color:#b07a25;margin-top:3px">${fmtCloseTime(d.closes_at)}</div>
      <div style="font-size:12px;color:var(--text-light)">评分截止时间</div>
    </div>
  </div>
  <div style="font-size:12px;color:var(--text-light);margin-top:12px;line-height:1.7">
  说明：每名已注册球员凭姓名+学号校验后评分，每人对每名裁判限评一次；评分对裁判匿名，裁判仅能看到分数与评语。</div>`;
}
function copyRatingUrl(){
  const inp=document.getElementById('ratingUrlInput');
  const done=()=>toast('链接已复制，可粘贴到队内群','success');
  if(navigator.clipboard){ navigator.clipboard.writeText(inp.value).then(done).catch(()=>{inp.select();document.execCommand('copy');done();}); }
  else { inp.select(); document.execCommand('copy'); done(); }
}

// —— 裁判端：我的评分 ——
async function loadMyRatings(){
  const wrap=document.getElementById('myRatingsWrap');
  wrap.innerHTML='<div class="empty-state">加载中…</div>';
  const res=await fetch('/api/referee/ratings/me');
  const d=await res.json().catch(()=>({}));
  if(!res.ok){ wrap.innerHTML=`<div class="empty-state">${escapeHtml(d.error||'加载失败')}</div>`; return; }
  if(!d.rating_count){ wrap.innerHTML='<div class="empty-state">暂无评分，比赛结束并经球队评分后显示</div>'; return; }
  const dimsHtml=d.dims.map(x=>{
    const pct=(x.avg/5*100).toFixed(0);
    return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <span style="width:80px;font-size:13px;flex-shrink:0">${escapeHtml(x.label)}</span>
      <div style="flex:1;height:9px;background:#eef2ef;border-radius:5px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--primary)"></div></div>
      <span style="width:38px;text-align:right;font-size:13px;font-weight:600">${x.avg}</span></div>`;
  }).join('');
  const commentsHtml=d.comments.length?d.comments.map(c=>`
    <div style="border:1px solid var(--border-light);border-radius:10px;padding:11px 13px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-light);margin-bottom:5px">
        <span>${escapeHtml(c.slot_label)}　${escapeHtml((c.match_date||'').slice(0,10))}</span><span>本条 ${c.total_score} 分</span></div>
      <div style="font-size:13px;line-height:1.7">${escapeHtml(c.comment)}</div></div>`).join('')
    :'<div class="empty-state">暂无文字评语</div>';
  wrap.innerHTML=`
  <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:6px 0 14px">
    <div style="text-align:center;background:var(--primary);color:#fff;border-radius:14px;padding:14px 22px">
      <div style="font-size:34px;font-weight:700;line-height:1.1">${d.avg_total}</div>
      <div style="font-size:12px;opacity:.85">综合均分（满分5）</div></div>
    <div style="font-size:13px;color:var(--text-light);line-height:2">
      参评场次：<b style="color:var(--text)">${d.match_count}</b> 场<br>
      有效评分：<b style="color:var(--text)">${d.rating_count}</b> 人次<br>
      评分全程匿名，仅供你本人查看</div></div>
  <div style="font-weight:700;font-size:14px;margin:6px 0 4px">各维度均分</div>${dimsHtml}
  <div style="font-weight:700;font-size:14px;margin:18px 0 8px">评语摘录（匿名）</div>${commentsHtml}`;
}

// —— 管理员端：评分汇总 ——
async function loadRatingSummary(){
  const tbody=document.querySelector('#ratingSummaryTable tbody');
  tbody.innerHTML='<tr><td colspan="12" class="empty-state">加载中…</td></tr>';
  const res=await fetch('/api/admin/referee-ratings/summary');
  const rows=await res.json().catch(()=>[]);
  if(!res.ok){ tbody.innerHTML='<tr><td colspan="12" class="empty-state">加载失败</td></tr>'; return; }
  if(!rows.length){ tbody.innerHTML='<tr><td colspan="12" class="empty-state">暂无评分数据</td></tr>'; return; }
  tbody.innerHTML=rows.map((r,i)=>`<tr>
    <td class="text-center">${i+1}</td>
    <td><b>${escapeHtml(r.referee_name)}</b></td>
    <td>${escapeHtml(r.referee_level||'-')}</td>
    <td class="text-center">${r.match_count}</td>
    <td class="text-center">${r.rating_count}</td>
    <td class="text-center"><b style="color:var(--primary)">${r.avg_total}</b></td>
    <td class="text-center">${r.avg_accuracy}</td><td class="text-center">${r.avg_control}</td>
    <td class="text-center">${r.avg_position}</td><td class="text-center">${r.avg_communication}</td>
    <td class="text-center">${r.avg_rules}</td>
    <td class="no-print"><button class="btn btn-sm btn-outline" onclick="openRatingDetail(${r.referee_id})">明细</button></td></tr>`).join('');
}
async function openRatingDetail(refereeId){
  document.getElementById('genericModalTitle').textContent='裁判评分明细';
  document.getElementById('genericModalBody').innerHTML='<div class="empty-state">加载中…</div>';
  document.getElementById('genericModalFooter').innerHTML='<button class="btn btn-outline" onclick="closeModal(\'genericModal\')">关闭</button>';
  showModal('genericModal');
  const res=await fetch('/api/admin/referee-ratings?referee_id='+refereeId);
  const rows=await res.json().catch(()=>[]);
  if(!res.ok){ document.getElementById('genericModalBody').innerHTML='<div class="empty-state">加载失败</div>'; return; }
  document.getElementById('genericModalBody').innerHTML=rows.map(r=>{
    const num=r.gender==='women'?r.match_number-100:r.match_number;
    return `<div style="border:1px solid var(--border-light);border-radius:10px;padding:11px 13px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-light);margin-bottom:6px">
        <span>场序${num}　评分队：${escapeHtml(r.team_name)}　评分人：${escapeHtml(r.rater_name||'-')}</span>
        <span style="font-weight:700;color:var(--primary)">${r.total_score}</span></div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--text-light);margin-bottom:${r.comment?'6px':'0'}">
        <span>准确性${r.score_accuracy}</span><span>控场${r.score_control}</span><span>选位${r.score_position}</span>
        <span>沟通${r.score_communication}</span><span>规则${r.score_rules}</span></div>
      ${r.comment?`<div style="font-size:13px;line-height:1.6">${escapeHtml(r.comment)}</div>`:''}</div>`;
  }).join('') || '<div class="empty-state">暂无明细</div>';
}
function exportRatingsCsv(){ window.location='/api/admin/referee-ratings/export'; }
