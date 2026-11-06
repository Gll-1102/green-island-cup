const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Server } = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const { db, init } = require('./db/database');

// 电子参赛证：生成/校验球员凭证码（防伪造，不暴露自增ID以外的敏感信息）
function makeCredentialCode(playerId) {
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update('cred:' + playerId).digest('hex').slice(0, 8);
  return `G${playerId}-${sig}`;
}
function verifyCredentialCode(code) {
  if (!code || typeof code !== 'string') return null;
  let raw = code.trim();
  // 兼容扫码得到完整 URL（如 .../checkin.html?c=G1-abcd1234）的情况，提取裸凭证码
  const cParam = raw.match(/[?&]c=(G\d+-[0-9a-f]{8})/i);
  if (cParam) raw = cParam[1];
  else { const g = raw.match(/(G\d+-[0-9a-f]{8})/i); if (g) raw = g[1]; }
  const m = raw.match(/^G(\d+)-([0-9a-f]{8})$/i);
  if (!m) return null;
  const pid = Number(m[1]);
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update('cred:' + pid).digest('hex').slice(0, 8);
  // 计时安全比较
  const a = Buffer.from(m[2].toLowerCase());
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return pid;
}
// 球队是否为隐藏测试队（测试数据不打扰管理员）
function teamIsHidden(teamId) {
  if (!teamId) return false;
  const t = db.prepare('SELECT COALESCE(is_hidden,0) h FROM teams WHERE id=?').get(teamId);
  return !!(t && t.h === 1);
}

// 电子裁判证：生成/校验裁判凭证码（前缀 R 区分球员凭证，防伪造）
function makeRefereeCode(refereeId) {
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update('refcred:' + refereeId).digest('hex').slice(0, 8);
  return `R${refereeId}-${sig}`;
}
function verifyRefereeCode(code) {
  if (!code || typeof code !== 'string') return null;
  let raw = code.trim();
  const cParam = raw.match(/[?&]c=(R\d+-[0-9a-f]{8})/i);
  if (cParam) raw = cParam[1];
  else { const g = raw.match(/(R\d+-[0-9a-f]{8})/i); if (g) raw = g[1]; }
  const m = raw.match(/^R(\d+)-([0-9a-f]{8})$/i);
  if (!m) return null;
  const rid = Number(m[1]);
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update('refcred:' + rid).digest('hex').slice(0, 8);
  const a = Buffer.from(m[2].toLowerCase());
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return rid;
}

// 自动生成裁判编号（C0001 起递增，与既有编号不冲突）
function generateRefereeSerial() {
  let n = 1;
  while (true) {
    const serial = 'C' + String(n).padStart(4, '0');
    const dup = db.prepare('SELECT id FROM referees WHERE serial_number=? AND deleted_at IS NULL').get(serial);
    if (!dup) return serial;
    n++;
  }
}

// 禁赛转移：将弃赛球员未执行完的禁赛转移给补录球员（含继承链条）
function transferSuspensions(fromPid, toPid, adminId) {
  const rows = db.prepare("SELECT * FROM suspensions WHERE player_id=? AND active=1 AND COALESCE(remaining_count,match_count)>0 AND COALESCE(discipline_type,'suspension')='suspension'").all(fromPid);
  let n = 0;
  for (const s of rows) {
    const notes = (s.notes ? s.notes + '；' : '') + `弃赛转补录（原球员ID ${fromPid} → ${toPid}，管理员 ${adminId}）`;
    db.prepare('UPDATE suspensions SET player_id=?, notes=? WHERE id=?').run(toPid, notes, s.id);
    n++;
  }
  return n;
}
// 球员当前是否处于停赛（剩余停赛场次>0）
function playerActiveSuspension(playerId) {
  return db.prepare("SELECT * FROM suspensions WHERE player_id=? AND active=1 AND COALESCE(remaining_count,match_count)>0 AND COALESCE(discipline_type,'suspension')='suspension' ORDER BY id DESC LIMIT 1").get(playerId);
}
// 新增自动停赛（红牌/累计黄牌），记录来源场次，避免同场重复生成
function addAutoSuspension(playerId, reason, sourceMatchId, count = 1) {
  const exist = db.prepare("SELECT id FROM suspensions WHERE player_id=? AND reason=? AND is_manual=0 AND active=1 AND COALESCE(remaining_count,match_count)>0").get(playerId, reason);
  if (exist) return null;
  const r = db.prepare('INSERT INTO suspensions (player_id,reason,match_count,remaining_count,is_manual,discipline_type,source_match_id,decided_at) VALUES (?,?,?,?,0,?, ?,?)')
    .run(playerId, reason, count, count, 'suspension', sourceMatchId || null, BJ());
  return r.lastInsertRowid;
}
// 设置读写
function getSetting(key, def = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : def;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, String(value));
}

// ========== 每日停服维护（北京时间 01:00-07:00；管理员不受限）==========
const MAINTENANCE_START_HOUR = 1;
const MAINTENANCE_END_HOUR = 7;
const MAINTENANCE_MSG = '系统维护中（每日 01:00–07:00）。为保障赛事数据稳定，该时段暂停球队端、裁判端登录与操作，07:00 后自动恢复。如遇紧急事务请联系管理员（联系方式由部署方配置）。';
// 管理员手动停服时的独立文案（不提固定时段、不承诺自动恢复时间）
const MANUAL_MAINTENANCE_MSG = '系统已由管理员手动停止服务，球队端、裁判端暂时无法登录与操作，恢复时间以管理员通知为准。如遇紧急事务请联系管理员（联系方式由部署方配置）。';
function beijingHourNow() {
  // 服务器时区可能为 UTC，统一按 Asia/Shanghai 取小时
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(new Date());
  return parseInt(h, 10) || 0;
}
// 北京时间字符串 'YYYY-MM-DD HH:mm:ss'（全站时间统一以此为准，避免 SQLite CURRENT_TIMESTAMP/toISOString 的 UTC 偏差）
function BJ(offsetMin = 0) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + (offsetMin || 0) * 60000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
// 当前停服原因：'manual' 手动停服（优先） / 'scheduled' 定时窗口 / null 正常开放
function maintenanceReason() {
  if (getSetting('maintenance_manual', '0') === '1') return 'manual';
  if (getSetting('maintenance_enabled', '1') !== '1') return null;
  const h = beijingHourNow();
  return (h >= MAINTENANCE_START_HOUR && h < MAINTENANCE_END_HOUR) ? 'scheduled' : null;
}
function maintenanceActive() {
  return maintenanceReason() !== null;
}
// 按停服原因返回对应提示文案
function maintenanceMessage() {
  return maintenanceReason() === 'manual' ? MANUAL_MAINTENANCE_MSG : MAINTENANCE_MSG;
}
function maintenanceBlock(req, res) {
  return res.status(503).json({ maintenance: true, reason: maintenanceReason(), error: maintenanceMessage() });
}
function isRegistrationFrozen(gender) {
  // 男子/女子报名冻结相互独立；无性别上下文时任一冻结即视为冻结（兼容旧全局键）
  const men = getSetting('registration_frozen_men', '0') === '1';
  const women = getSetting('registration_frozen_women', '0') === '1';
  const legacy = getSetting('registration_frozen', '0') === '1';
  if (gender === 'men') return men;
  if (gender === 'women') return women;
  return men || women || legacy;
}
// 取某支球队所属组别（默认男子）
function genderOfTeam(teamId) {
  const t = teamId == null ? null : db.prepare('SELECT gender FROM teams WHERE id=?').get(teamId);
  return (t && t.gender) || 'men';
}
// 判断一条（拟保存的）人员记录是否为"领队"
function isLeaderRecord(isOfficial, officialRole) {
  return !!(isOfficial && String(officialRole || '').includes('领队'));
}
// 每队始终只能有一名领队：返回同队另一名在册领队（excludeId 除外），无则 undefined
function findOtherLeader(teamId, excludeId) {
  return db.prepare("SELECT id,name FROM players WHERE team_id=? AND is_official=1 AND deleted_at IS NULL AND official_role LIKE '%领队%' AND id IS NOT ? LIMIT 1")
    .get(teamId, excludeId || -1);
}

// 一场比赛完赛：为对阵两队球员"执行"停赛核减（当场产生的停赛不计入当场；重赛不重复核减）
function serveSuspensionsForMatch(matchId) {
  const m = db.prepare('SELECT team1_id, team2_id FROM matches WHERE id=?').get(matchId);
  if (!m) return;
  const teamIds = [m.team1_id, m.team2_id].filter(Boolean);
  if (!teamIds.length) return;
  const list = db.prepare(`SELECT s.* FROM suspensions s JOIN players p ON s.player_id=p.id
    WHERE s.active=1 AND COALESCE(s.discipline_type,'suspension')='suspension' AND p.team_id IN (${teamIds.map(()=>'?').join(',')})`).all(...teamIds);
  const upd = db.prepare('UPDATE suspensions SET remaining_count=?, served_matches=?, active=? WHERE id=?');
  for (const s of list) {
    if (s.source_match_id != null && +s.source_match_id === +matchId) continue; // 当场吃牌，下一场才开始执行
    const served = String(s.served_matches || '').split(',').filter(Boolean);
    if (served.includes(String(matchId))) continue; // 已被本场核减过（回退后重赛不重复）
    served.push(String(matchId));
    const remain = Math.max(0, (s.remaining_count ?? s.match_count) - 1);
    upd.run(remain, served.join(','), remain > 0 ? 1 : 0, s.id);
  }
}

// ========== v51 赛制辅助：黄牌边界 / 小组积分 / 单场半决赛 / 换人窗口 ==========
const MEN_SF_BOUNDARY = 15;               // 男子小组赛+附加赛结束、半决赛（场序15起）前黄牌清零一次
const SUB_WINDOWS_MAX = 3;                // 全场换人窗口数（中场休息不计）
const SUB_PLAYERS_MAX = 12;               // 单场累计换上人数上限（男23-11 / 女20-8）

// 男子球队是否已进入半决赛（出现在单场半决赛场序15、16）
function teamReachedMenSF(teamId) {
  if (!teamId) return false;
  return !!db.prepare('SELECT 1 FROM matches WHERE match_number IN (15,16) AND (team1_id=? OR team2_id=?) LIMIT 1').get(teamId, teamId);
}
// 球员累计黄牌"起算场序边界"：男子进入半决赛=15；叠加管理员手动清零，取较大值；女子全程不清零=0
function yellowBoundaryForTeam(teamId) {
  let boundary = teamReachedMenSF(teamId) ? MEN_SF_BOUNDARY : 0;
  const manual = db.prepare('SELECT boundary_match_number FROM yellow_resets WHERE team_id=?').get(teamId);
  if (manual && +manual.boundary_match_number > boundary) boundary = +manual.boundary_match_number;
  return boundary;
}
// 球员在有效范围内、已结束比赛中的累计黄牌数（场序>=边界；当场黄牌由调用方另行累加）
function countEffectiveFinishedYellows(playerId, teamId) {
  const boundary = yellowBoundaryForTeam(teamId);
  return db.prepare(`SELECT COUNT(*) c FROM match_events me JOIN matches m ON me.match_id=m.id
    WHERE me.event_type='yellow' AND me.player_id=? AND m.status='finished' AND m.match_number>=?`).get(playerId, boundary).c;
}
// 单队公平竞赛分（每张黄牌-1；两黄变红-3；直红-4），只统计已结束比赛，分值越高（越接近0）排名越靠前
function teamFairPlayScore(teamId) {
  let score = 0;
  const ms = db.prepare("SELECT id FROM matches WHERE status='finished' AND (team1_id=? OR team2_id=?)").all(teamId, teamId);
  for (const m of ms) {
    const yellows = db.prepare("SELECT player_id FROM match_events WHERE match_id=? AND event_type='yellow' AND team_id=?").all(m.id, teamId);
    score -= yellows.length;
    const reds = db.prepare("SELECT DISTINCT player_id FROM match_events WHERE match_id=? AND event_type='red' AND player_id IS NOT NULL AND team_id=?").all(m.id, teamId);
    for (const r of reds) {
      const twoYellow = yellows.some(y => y.player_id === r.player_id); // 同场已有黄牌=两黄变红
      score -= twoYellow ? 3 : 4;
    }
  }
  return score;
}

// ---------- 男子小组积分榜（A/B 组，双循环；无平局：常规胜3/点胜2/点负1/负0）----------
function _disciplineFairForMatch(m, tid, row) {
  const ys = db.prepare("SELECT COUNT(*) c FROM match_events WHERE match_id=? AND event_type='yellow' AND team_id=?").get(m.id, tid).c;
  const yPlayers = db.prepare("SELECT DISTINCT player_id FROM match_events WHERE match_id=? AND event_type='yellow' AND team_id=?").all(m.id, tid).map(x => x.player_id);
  const reds = db.prepare("SELECT DISTINCT player_id FROM match_events WHERE match_id=? AND event_type='red' AND team_id=?").all(m.id, tid);
  let fp = -ys;
  reds.forEach(r => { fp -= yPlayers.includes(r.player_id) ? 3 : 4; });
  row.yellow += ys; row.fair += fp;
}
function menGroupTable(group) {
  const ms = db.prepare("SELECT * FROM matches WHERE gender='men' AND round_group=? ORDER BY match_number").all(group);
  const rows = new Map();
  const ensure = id => {
    if (!rows.has(id)) rows.set(id, { team_id: id, played: 0, win: 0, ps_win: 0, ps_loss: 0, loss: 0, gf: 0, ga: 0, gd: 0, points: 0, yellow: 0, fair: 0 });
    return rows.get(id);
  };
  // 抽签落位后即便未参赛也先补零数据行，保证组内始终3队
  ms.forEach(m => { if (m.team1_id != null) ensure(m.team1_id); if (m.team2_id != null) ensure(m.team2_id); });
  for (const m of ms) {
    if (m.status !== 'finished' || m.team1_id == null || m.team2_id == null) continue;
    const a = ensure(m.team1_id), b = ensure(m.team2_id);
    a.played++; b.played++;
    const s1 = m.team1_score || 0, s2 = m.team2_score || 0;
    a.gf += s1; a.ga += s2; b.gf += s2; b.ga += s1;
    if (m.has_penalty) {
      // 点球大战：该场按平局计入得失球，点胜2分、点负1分
      if ((m.penalty_team1 || 0) > (m.penalty_team2 || 0)) { a.ps_win++; a.points += 2; b.ps_loss++; b.points += 1; }
      else { b.ps_win++; b.points += 2; a.ps_loss++; a.points += 1; }
    } else if (s1 > s2) { a.win++; a.points += 3; b.loss++; }
    else if (s2 > s1) { b.win++; b.points += 3; a.loss++; }
    _disciplineFairForMatch(m, m.team1_id, a);
    _disciplineFairForMatch(m, m.team2_id, b);
  }
  const arr = [...rows.values()];
  arr.forEach(r => { r.gd = r.gf - r.ga; });
  arr.sort((x, y) => menGroupTieCompare(x, y, arr, ms));
  return arr;
}
// 男子小组同分排名：积分→相互积分→相互净胜球→相互进球→小组总净胜球→小组总进球→抽签
function menGroupTieCompare(x, y, arr, ms) {
  if (y.points !== x.points) return y.points - x.points;
  const tied = arr.filter(t => t.points === x.points);
  if (tied.length > 1) {
    const ids = new Set(tied.map(t => t.team_id));
    const sub = {};
    tied.forEach(t => { sub[t.team_id] = { pts: 0, gf: 0, ga: 0 }; });
    for (const m of ms) {
      if (m.status !== 'finished' || !ids.has(m.team1_id) || !ids.has(m.team2_id)) continue;
      const s1 = m.team1_score || 0, s2 = m.team2_score || 0;
      sub[m.team1_id].gf += s1; sub[m.team1_id].ga += s2;
      sub[m.team2_id].gf += s2; sub[m.team2_id].ga += s1;
      if (m.has_penalty) {
        if ((m.penalty_team1 || 0) > (m.penalty_team2 || 0)) { sub[m.team1_id].pts += 2; sub[m.team2_id].pts += 1; }
        else { sub[m.team2_id].pts += 2; sub[m.team1_id].pts += 1; }
      } else if (s1 > s2) sub[m.team1_id].pts += 3;
      else if (s2 > s1) sub[m.team2_id].pts += 3;
    }
    let d = sub[y.team_id].pts - sub[x.team_id].pts; if (d) return d;
    d = (sub[y.team_id].gf - sub[y.team_id].ga) - (sub[x.team_id].gf - sub[x.team_id].ga); if (d) return d;
    d = sub[y.team_id].gf - sub[x.team_id].gf; if (d) return d;
  }
  if (y.gd !== x.gd) return y.gd - x.gd;
  if (y.gf !== x.gf) return y.gf - x.gf;
  return x.team_id - y.team_id; // 兜底：实际由管理员组织抽签
}

// ---------- 女子单循环积分榜（5队；胜3/平1/负0）----------
function womenTable() {
  const ms = db.prepare("SELECT * FROM matches WHERE gender='women' ORDER BY match_number").all();
  const rows = new Map();
  const ensure = id => {
    if (!rows.has(id)) rows.set(id, { team_id: id, played: 0, win: 0, draw: 0, loss: 0, gf: 0, ga: 0, gd: 0, points: 0, yellow: 0, fair: 0 });
    return rows.get(id);
  };
  ms.forEach(m => { if (m.team1_id != null) ensure(m.team1_id); if (m.team2_id != null) ensure(m.team2_id); });
  for (const m of ms) {
    if (m.status !== 'finished' || m.team1_id == null || m.team2_id == null) continue;
    const a = ensure(m.team1_id), b = ensure(m.team2_id);
    a.played++; b.played++;
    const s1 = m.team1_score || 0, s2 = m.team2_score || 0;
    a.gf += s1; a.ga += s2; b.gf += s2; b.ga += s1;
    if (s1 > s2) { a.win++; a.points += 3; b.loss++; }
    else if (s1 < s2) { b.win++; b.points += 3; a.loss++; }
    else { a.draw++; b.draw++; a.points++; b.points++; }
    _disciplineFairForMatch(m, m.team1_id, a);
    _disciplineFairForMatch(m, m.team2_id, b);
  }
  const arr = [...rows.values()];
  arr.forEach(r => { r.gd = r.gf - r.ga; });
  arr.sort((x, y) => womenTieCompare(x, y, ms));
  return arr;
}
// 女子同分排名：相互战绩→相互净胜球→相互进球→总净胜球→总进球→抽签（5队单循环，相互对阵仅1场）
function womenTieCompare(x, y, ms) {
  if (y.points !== x.points) return y.points - x.points;
  const h2h = ms.find(m => m.status === 'finished' &&
    ((m.team1_id === x.team_id && m.team2_id === y.team_id) || (m.team1_id === y.team_id && m.team2_id === x.team_id)));
  if (h2h) {
    const xHome = h2h.team1_id === x.team_id;
    const xs = xHome ? (h2h.team1_score || 0) : (h2h.team2_score || 0);
    const ys = xHome ? (h2h.team2_score || 0) : (h2h.team1_score || 0);
    if (xs !== ys) return ys - xs; // 相互胜者列前（平局则继续往下比）
  }
  if (y.gd !== x.gd) return y.gd - x.gd;
  if (y.gf !== x.gf) return y.gf - x.gf;
  return x.team_id - y.team_id;
}

// ---------- 男子晋级推进 ----------
function menGroupStageComplete() {
  const total = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='men' AND round_group IN ('A','B')").get().c;
  const fin = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='men' AND round_group IN ('A','B') AND status='finished'").get().c;
  return total === 12 && fin === 12;
}
// 小组赛结束、半决赛前黄牌清零一次（自动；yellow_resets 同时作为手动兜底）
function clearMenYellowsOnce() {
  if (db.prepare("SELECT value FROM settings WHERE key='men_sf_yellow_reset'").get()) return;
  const teams = db.prepare("SELECT id FROM teams WHERE gender='men' AND COALESCE(is_hidden,0)=0").all();
  const ins = db.prepare("INSERT OR IGNORE INTO yellow_resets (team_id,boundary_match_number,note,created_by,created_at) VALUES (?,?,?,0,?)");
  teams.forEach(t => ins.run(t.id, MEN_SF_BOUNDARY, '小组赛及附加赛结束、半决赛前统一清零', BJ()));
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('men_sf_yellow_reset','done')").run();
}
function _fillFromSlot(num, slot) {
  const m = db.prepare('SELECT * FROM matches WHERE match_number=?').get(num);
  if (!m || m.status !== 'pending') return;
  const t1 = slot[m.team1_source], t2 = slot[m.team2_source];
  if (t1 && t2 && (m.team1_id == null || m.team2_id == null)) {
    db.prepare('UPDATE matches SET team1_id=?, team2_id=? WHERE id=?').run(t1, t2, m.id);
  }
}
function _fillFixed(num, t1, t2) {
  const m = db.prepare('SELECT * FROM matches WHERE match_number=?').get(num);
  if (m && m.status === 'pending' && (m.team1_id == null || m.team2_id == null)) {
    db.prepare('UPDATE matches SET team1_id=?, team2_id=? WHERE id=?').run(t1, t2, m.id);
  }
}
// （v56 起半决赛为单场定胜负，不再使用两回合总比分聚合）
// 比较两队小组赛记录：true 表示 x 战绩更优（积分→净胜球→进球；难分用id兜底，实际应抽签）
function menRecordBetter(x, y) {
  if (x.points !== y.points) return x.points > y.points;
  if (x.gd !== y.gd) return x.gd > y.gd;
  if (x.gf !== y.gf) return x.gf > y.gf;
  return x.team_id < y.team_id;
}
function advanceMenMatches() {
  // 1) 小组赛12场全部结束 → 确定名次，填附加赛①（场13，两个小组第三，战绩优者主场）
  if (menGroupStageComplete()) {
    const A = menGroupTable('A'), B = menGroupTable('B');
    if (A.length === 3 && B.length === 3) {
      const tA3 = A[2], tB3 = B[2];
      if (menRecordBetter(tB3, tA3)) _fillFixed(13, tB3.team_id, tA3.team_id);
      else _fillFixed(13, tA3.team_id, tB3.team_id);
    }
  }
  // 2) 附加赛①结束 → 胜者 P 与较低小组第二 r 打附加赛②（场14，r主场）
  const m13 = db.prepare('SELECT * FROM matches WHERE match_number=13').get();
  if (m13 && m13.status === 'finished' && m13.winner_id != null) {
    const A = menGroupTable('A'), B = menGroupTable('B');
    if (A.length === 3 && B.length === 3) {
      const P = m13.winner_id;
      let r;
      if (menRecordBetter(A[1], B[1])) r = B[1]; else r = A[1]; // 较佳小组第二直接出线，较低者r进附加赛
      _fillFixed(14, r.team_id, P);
    }
  }
  // 3) 附加赛②结束 → Q4诞生；黄牌清零一次，按"避免同组重赛"填半决赛（单场，场15/16，小组第一主场）
  const m14 = db.prepare('SELECT * FROM matches WHERE match_number=14').get();
  if (m14 && m14.status === 'finished' && m14.winner_id != null) {
    const A = menGroupTable('A'), B = menGroupTable('B');
    if (A.length === 3 && B.length === 3) {
      const Q4 = m14.winner_id;
      const WA = A[0].team_id, WB = B[0].team_id;
      const bestIsA = menRecordBetter(A[1], B[1]);   // 直接出线的较佳小组第二R是否来自A组
      const R = bestIsA ? A[1].team_id : B[1].team_id;
      clearMenYellowsOnce();
      // R 与"另一组"小组第一对阵（避免同组重赛）；Q4 与剩余小组第一对阵；单场定胜负
      let X, Y; // {w=小组第一(主场), c=挑战者}；配对X→场15，配对Y→场16
      if (bestIsA) { X = { w: WB, c: R };  Y = { w: WA, c: Q4 }; }
      else         { X = { w: WA, c: R };  Y = { w: WB, c: Q4 }; }
      _fillFixed(15, X.w, X.c);
      _fillFixed(16, Y.w, Y.c);
    }
  }
  // 4) 半决赛（单场，15、16）结束 → 填季军赛(17)、决赛(18)
  const s15 = db.prepare('SELECT * FROM matches WHERE match_number=15').get();
  const s16 = db.prepare('SELECT * FROM matches WHERE match_number=16').get();
  if (s15 && s16 && s15.status === 'finished' && s16.status === 'finished'
      && s15.winner_id != null && s16.winner_id != null) {
    const winX = s15.winner_id, winY = s16.winner_id;
    const loseX = s15.team1_id === winX ? s15.team2_id : s15.team1_id;
    const loseY = s16.team1_id === winY ? s16.team2_id : s16.team1_id;
    _fillFixed(17, loseX, loseY);
    _fillFixed(18, winX, winY);
  }
}
// 比分修改后重算：清空未结束的半决赛/决赛队伍后重新推进（已结束/已锁定不动）
function recalculateMenAdvances() {
  db.prepare(`UPDATE matches SET team1_id=NULL, team2_id=NULL WHERE gender='men' AND match_number>=13
    AND status!='finished' AND COALESCE(advance_locked,0)=0`).run();
  advanceMenMatches();
}

// 某队当场换人统计：已用窗口数、累计换上人数、被换下球员集合（用于换人规则软校验）
function teamSubStats(matchId, teamId) {
  const subs = db.prepare("SELECT player_id, sub_in_player_id, sub_window FROM match_events WHERE match_id=? AND event_type='sub' AND team_id=?").all(matchId, teamId);
  const windows = new Set();
  let onCount = 0;
  const offIds = new Set();
  subs.forEach(s => { if (s.sub_window) windows.add(+s.sub_window); if (s.sub_in_player_id) onCount++; if (s.player_id) offIds.add(s.player_id); });
  return { windows: windows.size, onCount, offIds, list: subs };
}

init();

// ========== 启动时密码兜底（只给“空密码账号”补初始密码，绝不覆盖已有密码）==========
// 说明：初始密码在 database.js 首次建号时已生成一次；之后无论重启、升级还是重新部署，
// 只要账号已有密码就一律保持不变，避免每次部署都把用户改过的密码冲掉。
function ensurePasswordsPresent() {
  // 仅处理密码为空/NULL 的异常账号（正常情况下一个都不会有）
  const emptyAdmins = db.prepare("SELECT id, username FROM users WHERE role='admin' AND (password IS NULL OR password='')").all();
  const emptyVisitors = db.prepare("SELECT id, username, team_id FROM users WHERE role='viewer' AND (password IS NULL OR password='') ORDER BY id").all();
  if (!emptyAdmins.length && !emptyVisitors.length) return; // 常见路径：直接返回，不动任何密码

  console.log('\n========== 检测到空密码账号，仅补齐这些账号 ==========');
  // 初始管理员密码：通过环境变量 ADMIN_INIT_PASSWORD 注入；未配置时使用占位值，部署后请立即修改
  const ADMIN_FIXED_PASSWORD = process.env.ADMIN_INIT_PASSWORD || 'ChangeMe-2026';
  emptyAdmins.forEach(a => {
    db.prepare('UPDATE users SET password=?, must_change_password=0, failed_attempts=0, locked_until=NULL WHERE id=?')
      .run(bcrypt.hashSync(ADMIN_FIXED_PASSWORD, 10), a.id);
    console.log(`  管理员 ${a.username}: 补齐初始密码 ${ADMIN_FIXED_PASSWORD}`);
  });
  const filled = [];
  emptyVisitors.forEach(v => {
    const pwd = generateRandomPassword();
    db.prepare('UPDATE users SET password=?, must_change_password=1, failed_attempts=0, locked_until=NULL WHERE id=?')
      .run(bcrypt.hashSync(pwd, 10), v.id);
    const team = db.prepare('SELECT name FROM teams WHERE id=?').get(v.team_id);
    filled.push({ username: v.username, password: pwd, team: team ? team.name : `球队${v.team_id}` });
    console.log(`  访客 ${v.username} (${team ? team.name : '未知球队'}): 补齐随机密码 ${pwd}`);
  });
  if (filled.length) {
    // 仅在确实补齐了访客时，追加记录到文件（不覆盖历史清单）
    const pwdFile = path.join(__dirname, 'data', 'visitor_passwords.txt');
    const add = ['', `# ${new Date().toLocaleString('zh-CN')} 补齐空密码账号：`,
      ...filled.map(v => `  ${v.team}  账号: ${v.username}  初始密码: ${v.password}`)].join('\n');
    fs.appendFileSync(pwdFile, add, 'utf8');
  }
  console.log('========== 空密码补齐完成（其余账号密码未改动）==========\n');
}
ensurePasswordsPresent();

// ========== 启动时迁移：旧公告附件（messages 目录，需登录）→ announcements 目录（登录用户可访问）==========
// 幂等：只处理 attachments 中仍指向 /uploads/messages/ 的公告；文件不存在时仅改写路径不报错。
function migrateAnnouncementAttachments() {
  try {
    const rows = db.prepare("SELECT id, attachments FROM announcements").all();
    const destDir = path.join(__dirname, 'public', 'uploads', 'announcements');
    let moved = 0;
    rows.forEach(row => {
      let atts;
      try { atts = JSON.parse(row.attachments || '[]'); } catch (e) { return; }
      if (!Array.isArray(atts) || !atts.length) return;
      let changed = false;
      atts.forEach(f => {
        if (!f || !f.path || !f.path.startsWith('/uploads/messages/')) return;
        const name = f.path.slice('/uploads/messages/'.length);
        const src = path.join(__dirname, 'public', 'uploads', 'messages', name);
        const dst = path.join(destDir, name);
        try {
          if (fs.existsSync(src)) {
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
            if (!fs.existsSync(dst)) { fs.renameSync(src, dst); moved++; }
          }
        } catch (e) {}
        f.path = '/uploads/announcements/' + name;
        changed = true;
      });
      if (changed) db.prepare("UPDATE announcements SET attachments=? WHERE id=?").run(JSON.stringify(atts), row.id);
    });
    if (moved) console.log('========== 公告附件迁移完成：' + moved + ' 个文件移入 announcements 目录 ==========');
  } catch (e) { console.warn('公告附件迁移跳过：', e.message); }
}
migrateAnnouncementAttachments();

const app = express();
// gzip压缩，减少传输体积，加快页面加载
app.use(require('compression')());
const server = http.createServer(app);
// serveClient:false：关闭 socket.io 自带的客户端脚本服务（其响应为 max-age=0，每次打开都重新校验/下载）。
// 客户端脚本已复制到 public/js/socket.io.js 由 express.static 提供（7天缓存 + br/gzip），
// 升级 socket.io 依赖后需同步复制 node_modules/socket.io/client-dist/socket.io.js（版本由 package-lock 锁定）
const io = new Server({ serveClient: false });
io.attach(server);

const PORT = process.env.PORT || 3000;
// Session 密钥：优先读环境变量 SESSION_SECRET；未配置则在 data/.session-secret 生成并持久化一份随机密钥
// 不再使用源码内的固定字符串，避免密钥随代码泄露导致会话可被伪造
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length >= 16) {
    return process.env.SESSION_SECRET.trim();
  }
  const secretPath = path.join(__dirname, 'data', '.session-secret');
  try {
    if (fs.existsSync(secretPath)) {
      const saved = fs.readFileSync(secretPath, 'utf8').trim();
      if (saved.length >= 32) return saved;
    }
  } catch (e) { /* 读取失败则重新生成 */ }
  const generated = require('crypto').randomBytes(48).toString('hex');
  try {
    fs.writeFileSync(secretPath, generated, { mode: 0o600 });
    console.log('[安全] 已在 data/.session-secret 生成随机 Session 密钥（也可通过环境变量 SESSION_SECRET 覆盖）');
  } catch (e) {
    console.warn('[安全警告] 无法写入持久化 Session 密钥，本次运行使用临时随机密钥（重启后所有登录态失效）:', e.message);
  }
  return generated;
}
const SESSION_SECRET = resolveSessionSecret();

// 密码复杂度校验：8-16位，必须同时包含字母和数字，只能含字母和数字
function validatePassword(pwd) {
  if (!pwd || typeof pwd !== 'string') return '密码不能为空';
  if (pwd.length < 8 || pwd.length > 16) return '密码长度须为8-16位';
  if (!/^[a-zA-Z0-9]+$/.test(pwd)) return '密码只能包含字母和数字';
  if (!/[a-zA-Z]/.test(pwd) || !/[0-9]/.test(pwd)) return '密码必须同时包含字母和数字';
  return null;
}

// 生成随机密码（字母+数字，8-16位）
function generateRandomPassword() {
  const letters = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  let pwd = '';
  // 至少2个字母和2个数字
  for (let i = 0; i < 5; i++) pwd += letters[Math.floor(Math.random() * letters.length)];
  for (let i = 0; i < 3; i++) pwd += digits[Math.floor(Math.random() * digits.length)];
  // 打乱
  pwd = pwd.split('').sort(() => Math.random() - 0.5).join('');
  return pwd;
}

// 中间件
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// 全局输入消毒：递归替换 req.body 中字符串的 HTML 危险字符，从存储层根治存储型 XSS。
// 采用全角等长替换（长度不变，不会干扰长度校验；视觉近似；innerHtml 渲染时无法组成标签/属性）。
// 本系统所有文本字段（球队/球员/裁判名、备注、消息、申诉、报告等）均不需要 HTML。
function sanitizeValue(v) {
  if (typeof v === 'string') {
    return v.replace(/</g, '＜').replace(/>/g, '＞').replace(/"/g, '＂').replace(/'/g, '＇');
  }
  if (Array.isArray(v)) return v.map(sanitizeValue);
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) v[k] = sanitizeValue(v[k]);
  }
  return v;
}
// 密码字段不消毒（仅允许字母数字，且立即 bcrypt，消毒无意义反而干扰）；其余字符串统一消毒
const SANITIZE_SKIP_KEYS = new Set(['password', 'old_password', 'new_password', 'confirm_password', 'oldPassword', 'newPassword', 'confirmPassword', 'current_password']);
function sanitizeBody(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    if (SANITIZE_SKIP_KEYS.has(k)) continue;
    obj[k] = sanitizeValue(obj[k]);
  }
}
app.use((req, res, next) => { if (req.body) sanitizeBody(req.body); next(); });
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // 不设置 maxAge → 会话级 Cookie，关闭浏览器即失效
  // 前端配合 sessionStorage 实现"关闭标签页即失效"
  cookie: { httpOnly: true, sameSite: 'lax' }
});
app.use(sessionMiddleware);
// ===== Socket.IO 握手加固：身份只能来自会话 Cookie，客户端无法伪造 =====
// ① Origin 必须与 Host 同源（拦截跨站直连；非浏览器工具无 Origin，且拿不到会话 Cookie，无法通过鉴权）
io.engine.use((req, res, next) => {
  const origin = req.headers && req.headers.origin;
  if (origin) {
    let same = false;
    try { same = new URL(origin).host === req.headers.host; } catch (e) { same = false; }
    if (!same) { res.writeHead(403); return res.end('Forbidden origin'); }
  }
  next();
});
// ② 握手请求复用同一套会话解析（必须在 Origin 检查之后）
io.engine.use(sessionMiddleware);
// HTML页面禁止浏览器缓存，防止关闭网页后回退仍显示登录态；
// JS/CSS/图片等静态资源不在此设置，交由下方 express.static 的 maxAge 缓存，避免每次打开重复下载
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html'))) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
  next();
});
// 基础安全响应头（不启用严格CSP，避免内联脚本/样式与socket.io受影响）
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-XSS-Protection', '1; mode=block');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});
// 敏感上传目录访问控制（必须在下面的通用 express.static 之前注册）：
// 学生证、安全责任书、消息附件含个人信息，需登录；裁判公平竞赛承诺书仅管理员。
// 球员照片/比赛照片/Logo/模板/申诉公示证据仍走下方通用静态（按设计对外可见）。
function guardSensitiveUploads() {
  const loginDirs = ['student_cards', 'safety_docs', 'messages'];
  loginDirs.forEach(sub => {
    app.use('/uploads/' + sub, requireAuth, express.static(path.join(__dirname, 'public', 'uploads', sub), {
      maxAge: '7d', etag: true, lastModified: true,
    }));
  });
  app.use('/uploads/fair_play', (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') return next();
    return res.status(403).json({ error: '无权限访问该文件' });
  }, express.static(path.join(__dirname, 'public', 'uploads', 'fair_play'), { maxAge: '7d', etag: true }));
  // 公告附件：登录用户直接放行（列表已按范围过滤，文件名随机不可枚举）；未登录游客仅能取在架且范围=全员(含游客)的公告附件
  app.use('/uploads/announcements', (req, res, next) => {
    if (req.session.user) return next();
    const fname = decodeURIComponent((req.path || '').replace(/^\//, ''));
    if (!fname) return res.status(404).json({ error: '文件不存在' });
    let publicHit = false;
    try {
      const rows = db.prepare("SELECT scope, attachments FROM announcements WHERE is_active=1 AND scope='all'").all();
      publicHit = rows.some(a => {
        try { const atts = JSON.parse(a.attachments || '[]'); return atts.some(f => f.path && f.path.endsWith('/' + fname)); }
        catch (e) { return false; }
      });
    } catch (e) { publicHit = false; }
    if (publicHit) return next();
    return res.status(401).json({ error: '请先登录' });
  }, express.static(path.join(__dirname, 'public', 'uploads', 'announcements'), { maxAge: '7d', etag: true }));
}
guardSensitiveUploads();
// 静态资源缓存：JS/CSS/图片缓存7天，HTML不缓存
// 站点图标：直接输出 logo 并缓存7天（301 跳转每次产生额外往返，弱网下放大首屏延迟）
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'uploads', 'logo.png'), {
  maxAge: '7d',
  headers: { 'Cache-Control': 'public, max-age=604800', 'Content-Type': 'image/png' }
}));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

// 文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public', 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `logo_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) cb(null, true);
    else cb(new Error('队徽只允许上传图片格式（jpg/png/gif/webp）'));
  }
});

// 学生证上传配置（2MB，仅jpg/png）
const studentCardStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public', 'uploads', 'student_cards');
    const fs = require('fs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `card_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`);
  }
});
const studentCardUpload = multer({
  storage: studentCardStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.pdf'].includes(ext)) cb(null, true);
    else cb(new Error('只允许上传 jpg/png/pdf 格式文件'));
  }
});

// 安全责任书上传配置
const safetyDocStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public', 'uploads', 'safety_docs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `safety_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`);
  }
});
const safetyDocUpload = multer({
  storage: safetyDocStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.pdf'].includes(ext)) cb(null, true);
    else cb(new Error('只允许上传 jpg/png/pdf 格式文件'));
  }
});

// 弃赛协议书上传配置（仅图片/PDF，5MB）
const withdrawalDocStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public', 'uploads', 'withdrawals');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, 'withdraw_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
  }
});
const withdrawalDocUpload = multer({
  storage: withdrawalDocStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.pdf'].includes(ext)) cb(null, true);
    else cb(new Error('只允许上传 jpg/png/pdf 格式文件'));
  }
});

// 裁判公平竞赛承诺书上传配置（仅图片，5MB）
const fairPlayStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public', 'uploads', 'fair_play');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `fairplay_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`);
  }
});
const fairPlayUpload = multer({
  storage: fairPlayStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg', '.jpeg', '.png'].includes(ext)) cb(null, true);
    else cb(new Error('公平竞赛承诺书只允许上传 jpg/png 图片'));
  }
});

// 球员证件照上传配置（必填，仅图片，5MB）
const playerPhotoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public', 'uploads', 'player_photos');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `photo_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`);
  }
});
const playerPhotoUpload = multer({
  storage: playerPhotoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) cb(null, true);
    else cb(new Error('证件照只允许上传 jpg/png/webp 图片'));
  }
});

// 消息附件上传配置（20MB，支持图片/文档/压缩包）
const messageAttachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public', 'uploads', 'messages');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `msg_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`);
  }
});
const messageUpload = multer({
  storage: messageAttachmentStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.jpg','.jpeg','.png','.gif','.pdf','.doc','.docx','.xls','.xlsx','.zip','.rar'];
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('不支持的文件格式'));
  }
});

// 全站公告附件（仅登录用户可访问，见 guardSensitiveUploads）
const announcementStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public', 'uploads', 'announcements');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `ann_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`);
  }
});
const announcementUpload = multer({
  storage: announcementStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.jpg','.jpeg','.png','.gif','.pdf','.doc','.docx','.xls','.xlsx','.zip','.rar'];
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('不支持的文件格式'));
  }
});

// 精彩镜头图片上传
const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public', 'uploads', 'photos');
    if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, 'photo_' + Date.now() + '_' + Math.random().toString(36).slice(2,8) + path.extname(file.originalname).toLowerCase())
});
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg','.jpeg','.png','.gif','.webp'].includes(ext)) cb(null, true);
    else cb(new Error('只支持图片格式'));
  }
});

// 辅助函数：检查球队是否有进行中的比赛
function teamHasLiveMatch(teamId) {
  const m = db.prepare(`SELECT id FROM matches WHERE status='live' AND (team1_id=? OR team2_id=?)`).get(teamId, teamId);
  return !!m;
}

// 比赛首次结束时记录结束时间（作为申诉24小时窗口基准，重复结束不覆盖）
function stampFinished(matchId) {
  const cur = db.prepare('SELECT finished_at, team1_id, team2_id FROM matches WHERE id=?').get(matchId);
  if (!cur || cur.finished_at) return; // 已结束则不重复通知
  db.prepare("UPDATE matches SET finished_at=? WHERE id=? AND finished_at IS NULL").run(BJ(), matchId);
  // 通知两队组织队员为裁判评分（赛后48小时内有效）
  try {
    const teamName = id => { const t = db.prepare('SELECT name FROM teams WHERE id=?').get(id); return t ? t.name : ''; };
    const m = db.prepare('SELECT match_number,gender FROM matches WHERE id=?').get(matchId);
    const num = m.gender === 'women' ? m.match_number - 100 : m.match_number;
    [cur.team1_id, cur.team2_id].filter(Boolean).forEach(tid => {
      sendMessageToTeam(tid, {
        title: `请为场序${num}比赛裁判评分`,
        content: `本场（${teamName(cur.team1_id)} vs ${teamName(cur.team2_id)}）已结束。请在赛后48小时内，在“赛程表”点击本场“裁判评分”生成队内评分链接/二维码并发到队内群，组织队员对主裁判、两位助理裁判、第四官员分别匿名打分。`,
        type: 'rating_reminder', relatedType: 'match', relatedId: matchId
      });
    });
  } catch (e) { console.error('rating reminder error', e); }
  // 完赛后自动核减对阵两队球员的停赛场次（当场产生的停赛不在当场核减）
  try { serveSuspensionsForMatch(matchId); } catch (e) { console.error('serveSuspensions error', e); }
}
// 比赛被管理员解锁回退时清空结束时间，重新结束后重新计时
function clearFinished(matchId) {
  db.prepare("UPDATE matches SET finished_at=NULL WHERE id=?").run(matchId);
}

// B7 同步一场比赛的执法确认记录：在岗裁判补 pending，撤岗裁判删除
function syncMatchConfirm(matchId, assignedRefIds) {
  const have = db.prepare('SELECT referee_id FROM match_ref_confirm WHERE match_id=?').all(matchId).map(r => +r.referee_id);
  const ins = db.prepare('INSERT OR IGNORE INTO match_ref_confirm (match_id,referee_id,status,updated_at) VALUES (?,?,?,?)');
  for (const rid of assignedRefIds) {
    if (!have.includes(+rid)) ins.run(matchId, rid, 'pending', null);
  }
  const del = db.prepare('DELETE FROM match_ref_confirm WHERE match_id=? AND referee_id=?');
  for (const rid of have) {
    if (!assignedRefIds.includes(+rid)) del.run(matchId, rid);
  }
}

// A4 按进球事件重算比分：统计两队 goal 事件数（乌龙球 event_type='own_goal' 计给对方）
// 比分胜负一致性校验（淘汰赛每场必须分出胜负；点球仅在平局时进行且点球比分必须不同）
function validateScoreOutcome({ team1_score, team2_score, has_penalty, penalty_team1, penalty_team2 }) {
  if (has_penalty) {
    if (team1_score !== team2_score) return '点球大战仅在常规/加时时间战平时进行，请先让双方比分相同';
    if (penalty_team1 === penalty_team2) return '点球大战比分不能相同，必须分出胜负';
  } else {
    if (team1_score === team2_score) return '常规时间战平请勾选点球大战（淘汰赛不允许平局）';
  }
  return null;
}

function recalcScoreFromEvents(matchId) {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  if (!m) return null;
  const evs = db.prepare("SELECT event_type,team_id FROM match_events WHERE match_id=? AND event_type IN ('goal','own_goal')").all(matchId);
  let s1 = 0, s2 = 0;
  for (const e of evs) {
    if (e.event_type === 'goal') {
      if (e.team_id === m.team1_id) s1++;
      else if (e.team_id === m.team2_id) s2++;
    } else if (e.event_type === 'own_goal') {
      // 乌龙球计入对方
      if (e.team_id === m.team1_id) s2++;
      else if (e.team_id === m.team2_id) s1++;
    }
  }
  let winnerId = null;
  if (s1 > s2) winnerId = m.team1_id;
  else if (s2 > s1) winnerId = m.team2_id;
  else if (m.has_penalty) {
    winnerId = (m.penalty_team1 || 0) > (m.penalty_team2 || 0) ? m.team1_id : m.team2_id;
  }
  db.prepare('UPDATE matches SET team1_score=?, team2_score=?, winner_id=? WHERE id=?').run(s1, s2, winnerId, matchId);
  return { s1, s2, winnerId };
}


function logOperation(req, action, targetType, targetId, detail) {
  const u = req.session.user || {};
  db.prepare('INSERT INTO operation_logs (user_id, username, role, action, target_type, target_id, detail, ip_address, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(u.id || null, u.username || '', u.role || '', action, targetType || '', String(targetId || ''), detail ? JSON.stringify(detail) : '', req.ip, BJ());
}

// ========== 消息通知函数 ==========
// 发送消息给指定用户
function sendMessage(receiverId, { senderId = null, senderName = '系统', title, content = '', type = 'notice', relatedType = '', relatedId = null, attachments = '[]' }) {
  if (!receiverId || !title) return;
  db.prepare('INSERT INTO messages (sender_id, sender_name, receiver_id, title, content, type, related_type, related_id, attachments, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(senderId, senderName, receiverId, title, content, type, relatedType, relatedId, attachments, BJ());
  // 实时推送未读数
  const count = db.prepare('SELECT COUNT(*) as c FROM messages WHERE receiver_id=? AND is_read=0').get(receiverId).c;
  io.to('user:' + receiverId).emit('unreadCount', { userId: receiverId, count });
}

// 发送消息给某球队所有访客
function sendMessageToTeam(teamId, opts) {
  const visitors = db.prepare("SELECT id FROM users WHERE role='viewer' AND team_id=?").all(teamId);
  visitors.forEach(v => sendMessage(v.id, opts));
}

// 发送消息给所有管理员
function sendMessageToAllAdmins(opts) {
  const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all();
  admins.forEach(a => sendMessage(a.id, opts));
}

// 发送消息给所有用户（管理员+访客）
function sendMessageToAll(opts) {
  const users = db.prepare('SELECT id FROM users').all();
  users.forEach(u => sendMessage(u.id, opts));
}

// 发送消息给所有访客
function sendMessageToAllVisitors(opts) {
  const visitors = db.prepare("SELECT id FROM users WHERE role='viewer'").all();
  visitors.forEach(v => sendMessage(v.id, opts));
}

// 发送消息给所有裁判员
function sendMessageToAllReferees(opts) {
  const refs = db.prepare("SELECT id FROM users WHERE role='referee'").all();
  refs.forEach(r => sendMessage(r.id, opts));
}

// 生成不重复的裁判用户名 ref01、ref02 ...
function generateRefereeUsername() {
  let n = 1;
  while (true) {
    const username = 'ref' + String(n).padStart(2, '0');
    const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
    if (!exists) return username;
    n++;
  }
}

// 根据裁判档案id获取其登录账号id
function getRefereeUserId(refereeId) {
  const r = db.prepare('SELECT user_id FROM referees WHERE id=?').get(refereeId);
  return r && r.user_id ? r.user_id : null;
}

// 在线用户追踪：按userId去重，支持多标签页，刷新不重复计数
const onlineUserSockets = new Map(); // userId -> Set<socketId>
function getOnlineCount() { return onlineUserSockets.size; }

// 在线用户详情（谁在线）：userId -> { id, name, role, teamName, isDesigner, lastSeen }
const onlineUserInfo = new Map();
function refreshOnlineUserInfo(userId) {
  try {
    const u = db.prepare('SELECT id, username, display_name, role, team_id FROM users WHERE id=?').get(userId);
    if (!u) return null;
    let teamName = null;
    if (u.team_id) {
      const t = db.prepare('SELECT name FROM teams WHERE id=? AND deleted_at IS NULL').get(u.team_id);
      if (t) teamName = t.name;
    }
    const info = {
      id: u.id, username: u.username,
      name: u.display_name || u.username,
      role: u.role,
      team_name: teamName,
      is_designer: u.role === 'admin' && u.username === 'admin',
      last_seen: Date.now()
    };
    onlineUserInfo.set(userId, info);
    return info;
  } catch (e) { return null; }
}
function getOnlineUserList() {
  const now = Date.now();
  return [...onlineUserInfo.values()]
    .filter(x => now - x.last_seen < 3 * 60 * 1000)
    .sort((a, b) => b.last_seen - a.last_seen);
}
// 在线列表定期清理：3分钟无心跳剔除（防御异常残留连接）
const onlineCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [uid, info] of onlineUserInfo) {
    if (now - info.last_seen > 3 * 60 * 1000) onlineUserInfo.delete(uid);
  }
}, 60000);
if (onlineCleanupTimer.unref) onlineCleanupTimer.unref();

// 认证中间件
// 会话回查：账号被删除、锁定或裁判被停用后，已签发的会话立即失效
function sessionUserStillValid(req) {
  if (!req.session || !req.session.user) return false;
  const u = db.prepare('SELECT id,role,locked_until FROM users WHERE id=?').get(req.session.user.id);
  if (!u) return false;
  if (u.locked_until) {
    const lockTime = new Date(u.locked_until.replace(' ', 'T')).getTime();
    if (Date.now() < lockTime) return false;
  }
  if (u.role === 'referee') {
    const ref = db.prepare('SELECT deleted_at FROM referees WHERE user_id=?').get(u.id);
    if (ref && ref.deleted_at) return false;
  }
  // 同步可能被管理员改动的显示名/队伍/性别
  req.session.user.role = u.role;
  return true;
}
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  if (!sessionUserStillValid(req)) { req.session.destroy(() => {}); return res.status(401).json({ error: '登录状态已失效，请重新登录' }); }
  if (req.session.user.role !== 'admin' && maintenanceActive()) return maintenanceBlock(req, res);
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  if (!sessionUserStillValid(req)) { req.session.destroy(() => {}); return res.status(401).json({ error: '登录状态已失效，请重新登录' }); }
  next();
}
function requireViewer(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  if (req.session.user.role !== 'viewer') return res.status(403).json({ error: '需要访客权限' });
  if (!sessionUserStillValid(req)) { req.session.destroy(() => {}); return res.status(401).json({ error: '登录状态已失效，请重新登录' }); }
  if (maintenanceActive()) return maintenanceBlock(req, res);
  next();
}
function requireReferee(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  if (req.session.user.role !== 'referee') return res.status(403).json({ error: '需要裁判员权限' });
  if (!sessionUserStillValid(req)) { req.session.destroy(() => {}); return res.status(401).json({ error: '登录状态已失效，请重新登录' }); }
  if (maintenanceActive()) return maintenanceBlock(req, res);
  next();
}
function requireViewerOrReferee(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  if (!['viewer', 'referee'].includes(req.session.user.role)) return res.status(403).json({ error: '无权限' });
  if (!sessionUserStillValid(req)) { req.session.destroy(() => {}); return res.status(401).json({ error: '登录状态已失效，请重新登录' }); }
  if (maintenanceActive()) return maintenanceBlock(req, res);
  next();
}

// 材料上传类接口：仅管理员/球队（裁判无需上传球员材料）
function requireAdminOrViewer(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  if (!['admin', 'viewer'].includes(req.session.user.role)) return res.status(403).json({ error: '无权限上传' });
  if (!sessionUserStillValid(req)) { req.session.destroy(() => {}); return res.status(401).json({ error: '登录状态已失效，请重新登录' }); }
  if (req.session.user.role === 'viewer' && maintenanceActive()) return maintenanceBlock(req, res);
  next();
}

// 比赛锁定检查：已结束的比赛禁止修改，需先解锁
function checkMatchNotLocked(req, res, next) {
  const match = db.prepare('SELECT status FROM matches WHERE id=?').get(req.params.id);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  if (match.status === 'finished') return res.status(403).json({ error: '比赛已结束并锁定，请先解锁后再修改', locked: true });
  next();
}

// Socket.io
// Socket 身份只从服务端会话读取（engine 已挂载 sessionMiddleware），客户端 auth 字段一律不采信
io.use((socket, next) => {
  const sessUser = socket.request.session && socket.request.session.user;
  if (sessUser && sessUser.id) {
    socket.userId = sessUser.id;
    socket.username = sessUser.displayName || sessUser.username;
    socket.role = sessUser.role;
    socket.teamId = sessUser.team_id || null;
    socket.join('user:' + sessUser.id); // 定向消息房间，替代全员广播
  } else {
    socket.userId = null; // 未登录连接：可收公开广播，不产生在线记录
  }
  next();
});

io.on('connection', (socket) => {
  if (socket.userId) {
    // 按userId去重：同一用户多个标签页/刷新只算1人
    if (!onlineUserSockets.has(socket.userId)) onlineUserSockets.set(socket.userId, new Set());
    onlineUserSockets.get(socket.userId).add(socket.id);
    refreshOnlineUserInfo(socket.userId); // 记录在线详情（谁在线）
    // 给新连接发送当前在线人数（关键：新连接在中间件阶段收不到io.emit）
    socket.emit('onlineCount', getOnlineCount());
    // 广播给其他已连接用户
    socket.broadcast.emit('onlineCount', getOnlineCount());
    socket.broadcast.emit('userOnline', { username: sanitizeValue(socket.username), time: BJ() });
  }

  // 心跳：刷新最后活跃时间（在线列表展示与超时清理依据），前端每60秒上报一次
  socket.on('hb', () => {
    if (socket.userId) refreshOnlineUserInfo(socket.userId);
  });

  socket.on('disconnect', () => {
    if (socket.userId && onlineUserSockets.has(socket.userId)) {
      const sockets = onlineUserSockets.get(socket.userId);
      sockets.delete(socket.id);
      // 只有该用户的所有连接都断开时才更新计数
      if (sockets.size === 0) {
        onlineUserSockets.delete(socket.userId);
        onlineUserInfo.delete(socket.userId);
        io.emit('onlineCount', getOnlineCount());
      }
    }
  });
});

function broadcastUpdate(type, data) {
  io.emit('dataUpdate', { type, data, time: BJ() });
}

// 测试沙箱：登出时硬删除所有 test_data 球员及其上传文件
function purgeTestSandbox() {
  const rows = db.prepare("SELECT photo_path,student_card_path,safety_doc_path FROM players WHERE test_data=1").all();
  const files = new Set();
  rows.forEach(r => [r.photo_path, r.student_card_path, r.safety_doc_path].forEach(fp => {
    if (fp && typeof fp === 'string' && fp.indexOf('/uploads/') === 0) files.add(path.join(__dirname, 'public', fp));
  }));
  files.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} });
  const info = db.prepare("DELETE FROM players WHERE test_data=1").run();
  console.log('[测试沙箱] 清除测试球员 ' + info.changes + ' 名、文件 ' + files.size + ' 个');
}

// ========== 认证 / 接口限流 ==========
// 轻量内存限流（PM2 fork 单实例足够，不引入新依赖）。当前无反代，不信任可伪造的 X-Forwarded-*
function clientIp(req) {
  let ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip.indexOf('::ffff:') === 0) ip = ip.slice(7);
  return ip || 'unknown';
}
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  if (typeof timer.unref === 'function') timer.unref();
  return (req, res, next) => {
    const now = Date.now();
    const ip = clientIp(req);
    let rec = hits.get(ip);
    if (!rec || rec.reset <= now) { rec = { count: 0, reset: now + windowMs }; hits.set(ip, rec); }
    rec.count++;
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - rec.count));
    if (rec.count > max) {
      const retry = Math.ceil((rec.reset - now) / 1000);
      res.setHeader('Retry-After', retry);
      return res.status(429).json({ error: `操作过于频繁，请 ${retry} 秒后再试`, retryAfter: retry });
    }
    next();
  };
}
// 测试模式（TEST_MODE=1，仅测试环境）放宽限流，避免测试套件自身被拦截；生产阈值不变
const captchaLimiter = createRateLimiter({ windowMs: 60000, max: process.env.TEST_MODE === '1' ? 300 : 30 });
// 裁判申请免登录接口限流（上传/提交/查询/撤回共用，防刷）
const refereeAppLimiter = createRateLimiter({ windowMs: 60000, max: process.env.TEST_MODE === '1' ? 300 : 20 });
const loginLimiter = createRateLimiter({ windowMs: 60000, max: process.env.TEST_MODE === '1' ? 500 : 20 });

// ========== 验证码（加固：干扰字形 + 旋转 + 干扰线，不可被简单脚本机读）==========
app.get('/api/auth/captcha', captchaLimiter, (req, res) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  // 测试模式（仅 TEST_MODE=1，生产不设置）：登录验证码固定 TEST1234；渲染答案经专用响应头回传供抗识别测试
  if (process.env.TEST_MODE === '1') {
    req.session.captcha = 'TEST1234';
    res.setHeader('X-Test-Captcha-Answers', code);
  } else req.session.captcha = code;
  // 简单可读版：仅 4 个大号真字符 + 少量浅色细线/噪点，不设干扰字形（用户反馈复杂验证码难以辨认）
  const w = 180, h = 56;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const darkPool = ['#0f172a', '#1A4D3A', '#14532d', '#1e293b'];
  const slots = [20, 65, 110, 155];
  let text = '';
  for (let i = 0; i < 4; i++) {
    const x = slots[i] + rnd(-2, 2), y = rnd(37, 41);
    const rot = rnd(-10, 10), size = Math.round(rnd(32, 36));
    text += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" font-weight="bold" fill="${pick(darkPool)}" font-family="Arial" transform="rotate(${rot.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})">${code[i]}</text>`;
  }
  let lines = '';
  for (let i = 0; i < 2; i++) {
    lines += `<line x1="${rnd(0,w).toFixed(1)}" y1="${rnd(8,48).toFixed(1)}" x2="${rnd(0,w).toFixed(1)}" y2="${rnd(8,48).toFixed(1)}" stroke="${pick(['#94a3b8', '#cbd5e1', '#c8d8d0'])}" stroke-width="1" opacity="0.6"/>`;
  }
  let dots = '';
  for (let i = 0; i < 8; i++) {
    dots += `<circle cx="${rnd(0,w).toFixed(1)}" cy="${rnd(0,h).toFixed(1)}" r="${rnd(0.7,1.3).toFixed(1)}" fill="${pick(['#94a3b8', '#1A4D3A', '#c8d8d0'])}" opacity="0.5"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#f0f7f4" rx="6"/>${dots}${lines}${text}</svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-store');
  res.send(svg);
});

// ========== 认证 ==========
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password, captcha } = req.body;
  // 类型兜底：防止非字符串（undefined/对象/数组）导致验证码比较或SQLite绑定抛内部错误
  if (typeof captcha !== 'string' || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: '登录参数不完整', captchaRequired: true });
  }
  // 验证码校验
  if (!req.session.captcha || !captcha || captcha.toUpperCase() !== req.session.captcha) {
    return res.status(400).json({ error: '验证码错误', captchaRequired: true });
  }
  req.session.captcha = null; // 验证码用后即焚

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // 先检查锁定状态：锁定期间直接拦截，不再累计失败次数
  if (user && user.locked_until) {
    const lockTime = new Date(user.locked_until.replace(' ', 'T')).getTime();
    if (Date.now() < lockTime) {
      const mins = Math.ceil((lockTime - Date.now()) / 60000);
      return res.status(403).json({ error: `账号已锁定，请${mins}分钟后再试或联系管理员`, locked: true });
    }
  }
  // 测试沙箱未启用（生产默认）时，优先拒绝 is_test 账号登录（先于维护提示）
  if (user && user.is_test === 1 && process.env.ENABLE_TEST_SANDBOX !== '1') {
    return res.status(403).json({ error: '测试沙箱在当前环境未启用' });
  }
  // 停服维护拦截：维护窗口内球队/裁判收到维护提示，不校验密码、不累计失败次数（管理员不受限）
  if (user && user.role !== 'admin' && maintenanceActive()) {
    return maintenanceBlock(req, res);
  }
  if (!user || !bcrypt.compareSync(password, user.password)) {
    // 记录失败次数
    if (user) {
      const attempts = (user.failed_attempts || 0) + 1;
      if (attempts >= 5) {
        db.prepare('UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?').run(attempts, BJ(30), user.id);
        return res.status(403).json({ error: '密码错误次数过多，账号已锁定30分钟，请联系管理员解锁', locked: true });
      }
      db.prepare('UPDATE users SET failed_attempts=? WHERE id=?').run(attempts, user.id);
      return res.status(401).json({ error: `用户名或密码错误，剩余尝试次数 ${5 - attempts} 次` });
    }
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  // D14 已被软删除（进回收站）的裁判账号禁止登录
  if (user.role === 'referee') {
    const ref = db.prepare('SELECT deleted_at FROM referees WHERE user_id=?').get(user.id);
    if (ref && ref.deleted_at) return res.status(403).json({ error: '该裁判账号已停用，请联系管理员' });
  }
  // 登录成功，清除失败记录
  db.prepare('UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?').run(user.id);
  const sessionUser = { id: user.id, username: user.username, role: user.role, displayName: user.display_name, team_id: user.team_id, gender: user.gender || 'men', isTest: user.is_test === 1 };
  // 防会话固定（Session Fixation）：登录提权点重新生成会话ID，废弃登录前的匿名SID
  req.session.regenerate((genErr) => {
    if (genErr) return res.status(500).json({ error: '登录会话异常，请重试' });
    req.session.user = sessionUser;
    db.prepare('INSERT INTO login_logs (user_id, username, role, ip_address, login_time) VALUES (?,?,?,?,?)')
      .run(user.id, user.username, user.role, req.ip, BJ());
    broadcastUpdate('login', { username: user.username, role: user.role });
    res.json({
      id: user.id, username: user.username, role: user.role,
      displayName: user.display_name, team_id: user.team_id, gender: user.gender || 'men',
      isTest: user.is_test === 1,
      mustChangePassword: !!user.must_change_password
    });
  });
});

app.post('/api/auth/logout', (req, res) => {
  try { if (req.session.user && req.session.user.isTest) purgeTestSandbox(); } catch (e) {}
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '未登录' });
  res.json(req.session.user);
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    if (!user) return res.status(404).json({ error: '账号不存在' });
    if (!oldPassword || !bcrypt.compareSync(oldPassword, user.password)) return res.status(400).json({ error: '原密码错误' });
    const pwdErr = validatePassword(newPassword);
    if (pwdErr) return res.status(400).json({ error: pwdErr });
    db.prepare('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), user.id);
    logOperation(req, 'change_password', 'user', user.id, {});
    res.json({ ok: true });
  } catch (e) {
    console.error('[change-password]', e);
    res.status(500).json({ error: '密码修改失败（服务器写入异常）：' + e.message });
  }
});

app.post('/api/auth/reset-visitor-password', requireAdmin, (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    if (userId == null || isNaN(Number(userId))) return res.status(400).json({ error: '请先选择要重置的账号' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
    if (!user || !['viewer', 'referee'].includes(user.role)) return res.status(400).json({ error: '无效的账号' });
    let pwd = newPassword;
    let randomGenerated = false;
    if (!pwd) {
      pwd = generateRandomPassword();
      randomGenerated = true;
    } else {
      const pwdErr = validatePassword(pwd);
      if (pwdErr) return res.status(400).json({ error: pwdErr });
    }
    db.prepare('UPDATE users SET password = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL WHERE id = ?')
      .run(bcrypt.hashSync(pwd, 10), user.id);
    logOperation(req, 'reset_visitor_password', 'user', user.id, { username: user.username });
    res.json({ ok: true, password: randomGenerated ? pwd : undefined });
  } catch (e) {
    console.error('[reset-visitor-password]', e);
    res.status(500).json({ error: '重置失败（服务器写入异常）：' + e.message });
  }
});

// 管理员解锁账号
app.post('/api/auth/unlock-user', requireAdmin, (req, res) => {
  try {
    const { userId } = req.body;
    if (userId == null || isNaN(Number(userId))) return res.status(400).json({ error: '缺少账号标识' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
    if (!user) return res.status(404).json({ error: '用户不存在' });
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(Number(userId));
    logOperation(req, 'unlock_user', 'user', Number(userId), { username: user.username });
    res.json({ ok: true });
  } catch (e) {
    console.error('[unlock-user]', e);
    res.status(500).json({ error: '解锁失败（服务器写入异常）：' + e.message });
  }
});

app.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, role, display_name, team_id, gender, failed_attempts, locked_until, must_change_password, created_at FROM users ORDER BY role DESC, id').all();
  res.json(users);
});

app.post('/api/users/admin', requireAdmin, (req, res) => {
  const { username, password, display_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  const pwdErr = validatePassword(password);
  if (pwdErr) return res.status(400).json({ error: pwdErr });
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(400).json({ error: '用户名已存在' });
  db.prepare('INSERT INTO users (username, password, role, display_name, created_at) VALUES (?,?,?,?,?)')
    .run(username, bcrypt.hashSync(password, 10), 'admin', display_name || username, BJ());
  logOperation(req, 'add_admin', 'user', null, { username, display_name: display_name || username });
  res.json({ ok: true });
});

app.get('/api/login-logs', requireAdmin, (req, res) => {
  const logs = db.prepare('SELECT * FROM login_logs ORDER BY login_time DESC LIMIT 100').all();
  res.json(logs);
});

// ========== 输入长度校验工具 ==========
const MAX_LEN = {
  team_name: 20, college: 30, leader: 10, leader_phone: 20, coach: 10, jersey_color: 20,
  student_id: 20, player_name: 10, class_name: 30, position: 10,
  health: 50, phone: 11, official_role: 20,
  referee_name: 10, referee_college: 30, referee_level: 10,
  match_location: 30, notes: 200,
  msg_title: 50, msg_content: 1000,
  username: 20, display_name: 20,
};
function checkLen(val, max, fieldName) {
  if (val && typeof val === 'string' && val.length > max) {
    return `${fieldName}长度不能超过${max}个字符`;
  }
  return null;
}

// "HH:MM" → 当日分钟数；无法解析返回 null
function timeToMin(t) {
  if (!t || typeof t !== 'string') return null;
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseInt(m[2]);
}

// D16 统一字段格式校验：手机号11位数字、学号6-20位、年龄15-35、身高150-210cm、体重40-150kg
function validatePersonFields(p) {
  const phone = String(p.phone || '').trim();
  if (phone && !/^\d{11}$/.test(phone)) return '联系电话必须为11位数字';
  const isOfficial = p.is_official ? true : false;
  if (!isOfficial) {
    const sid = String(p.student_id || '').trim();
    if (sid && (sid.length < 6 || sid.length > 20)) return '学号/工号长度须为6-20位';
  }
  // 球队官员可为教职工，不受运动员年龄/身高/体重区间限制
  const numChecks = isOfficial ? [] : [
    ['age', '年龄', 15, 35], ['height', '身高(cm)', 150, 210], ['weight', '体重(kg)', 40, 150]
  ];
  for (const [key, label, lo, hi] of numChecks) {
    const v = p[key];
    if (v === '' || v === null || v === undefined) continue;
    const n = Number(v);
    if (Number.isNaN(n)) return `${label}必须为数字`;
    if (n !== 0 && (n < lo || n > hi)) return `${label}须在${lo}-${hi}之间`;
  }
  return null;
}

// ========== 安全责任书模板下载 ==========
app.get('/api/players/safety-template', (req, res) => {
  const tplPath = path.join(__dirname, 'public', 'uploads', 'templates', 'safety_agreement_template.docx');
  if (!fs.existsSync(tplPath)) return res.status(404).json({ error: '模板文件不存在' });
  res.download(tplPath, '校园足球赛事参赛安全责任书.docx');
});

// ========== 球队 ==========
app.get('/api/teams', (req, res) => {
  // 设计者（管理员）传 include_hidden=1 时返回隐藏测试队；其余用户一律过滤
  const isDesigner = req.session.user && req.session.user.role === 'admin' && req.session.user.username === 'admin';
  let sql = 'SELECT * FROM teams WHERE deleted_at IS NULL';
  if (!(isDesigner && req.query.include_hidden === '1')) sql += ' AND COALESCE(is_hidden,0)=0';
  const params = [];
  if (req.query.gender === 'men' || req.query.gender === 'women') { sql += ' AND gender=?'; params.push(req.query.gender); }
  sql += ' ORDER BY id';
  const teams = db.prepare(sql).all(...params);
  res.json(teams);
});

app.put('/api/teams/:id', requireAdmin, (req, res) => {
  const { name, leader, leader_phone, coach, jersey_color } = req.body;
  // 队即学院：不再单独维护“所属学院”，college 列统一置空（球员学院/裁判同学院提醒改由球队名推导）
  // 输入长度校验
  const lenErr = checkLen(name, MAX_LEN.team_name, '球队名')
    || checkLen(leader, MAX_LEN.leader, '领队')
    || checkLen(leader_phone, MAX_LEN.leader_phone, '领队电话')
    || checkLen(coach, MAX_LEN.coach, '主教练')
    || checkLen(jersey_color, MAX_LEN.jersey_color, '队服颜色');
  if (lenErr) return res.status(400).json({ error: lenErr });
  const phoneStr = (leader_phone || '').trim();
  if (phoneStr && !/^[0-9+\-\s]{5,20}$/.test(phoneStr)) return res.status(400).json({ error: '领队电话格式不正确（仅支持数字、+、-、空格，5-20位）' });
  const beforeTeam = db.prepare('SELECT name,leader,leader_phone,coach,jersey_color FROM teams WHERE id=?').get(req.params.id);
  const existing = db.prepare('SELECT id FROM teams WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '球队不存在' });
  db.prepare('UPDATE teams SET name=?, college=NULL, leader=?, leader_phone=?, coach=?, jersey_color=? WHERE id=?')
    .run(name, leader||'', phoneStr, coach||'', jersey_color||'', req.params.id);
  logOperation(req, 'update_team', 'team', req.params.id, { before: beforeTeam, after: { name, leader, leader_phone: phoneStr, coach, jersey_color } });
  broadcastUpdate('teams', {});
  res.json({ ok: true });
});

app.post('/api/teams/:id/logo', requireAdmin, upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  const logoPath = '/uploads/' + req.file.filename;
  db.prepare('UPDATE teams SET logo_path=? WHERE id=?').run(logoPath, req.params.id);
  logOperation(req, 'upload_team_logo', 'team', req.params.id, {});
  broadcastUpdate('teams', {});
  res.json({ logoPath });
});

// ========== 球员 ==========
app.get('/api/players', (req, res) => {
  const { team_id } = req.query;
  const isLoggedIn = !!req.session.user;
  const isAdmin = isLoggedIn && req.session.user.role === 'admin';
  const isViewer = isLoggedIn && req.session.user.role === 'viewer';
  const isSandbox = isViewer && req.session.user.isTest === true;
  let sql = 'SELECT p.*, t.name as team_name FROM players p JOIN teams t ON p.team_id = t.id';
  let params = [];
  let conditions = ['p.deleted_at IS NULL', 't.deleted_at IS NULL'];
  if (isSandbox) {
    // 测试账号：只看自己的沙箱数据，可跨队、可按队/组别筛选
    conditions.push('p.test_data = 1');
    if (team_id) { conditions.push('p.team_id = ?'); params.push(team_id); }
    if (req.query.gender === 'men' || req.query.gender === 'women') { conditions.push('p.gender = ?'); params.push(req.query.gender); }
  } else if (!isLoggedIn) {
    // 游客（未登录）只看已审批球员，且排除沙箱；可按队/组别筛选
    conditions.push("p.status = 'approved'");
    conditions.push('COALESCE(p.test_data,0) = 0');
    conditions.push('t.is_hidden = 0');
    conditions.push('p.withdrawn_at IS NULL');
    if (team_id) { conditions.push('p.team_id = ?'); params.push(team_id); }
  } else if (isViewer) {
    // 登录的球队访客只能看本队，排除沙箱
    conditions.push('p.team_id = ?');
    params.push(req.session.user.team_id);
    conditions.push('COALESCE(p.test_data,0) = 0');
  } else {
    // 管理员：可按队筛选，排除沙箱与隐藏队
    if (team_id) { conditions.push('p.team_id = ?'); params.push(team_id); }
    conditions.push('COALESCE(p.test_data,0) = 0');
    // 设计者（管理员）传 include_hidden=1 时查看隐藏测试队
    const isDesigner = req.session.user.username === 'admin';
    if (!(isDesigner && req.query.include_hidden === '1')) conditions.push('t.is_hidden = 0');
  }
  if ((isAdmin || !isLoggedIn) && (req.query.gender === 'men' || req.query.gender === 'women')) {
    conditions.push('p.gender = ?');
    params.push(req.query.gender);
  }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY p.team_id, p.jersey_number';
  let players = db.prepare(sql).all(...params);
  // 游客不返回敏感字段
  if (!isLoggedIn) {
    players = players.map(p => {
      const { student_id, phone, pending_data, student_card_path, ...rest } = p;
      return rest;
    });
  }
  res.json(players);
});

app.post('/api/players', requireAdmin, (req, res) => {
  const p = req.body;
  // 输入长度校验
  const lenErr = checkLen(p.student_id, MAX_LEN.student_id, '学号/工号')
    || checkLen(p.name, MAX_LEN.player_name, '球员姓名')
    || checkLen(p.class_name, MAX_LEN.class_name, '班级')
    || checkLen(p.position, MAX_LEN.position, '场上位置')
    || checkLen(p.health, MAX_LEN.health, '健康状况')
    || checkLen(p.phone, MAX_LEN.phone, '联系电话')
    || checkLen(p.official_role, MAX_LEN.official_role, '官员职务');
  if (lenErr) return res.status(400).json({ error: lenErr });
  const fmtErr = validatePersonFields(p);
  if (fmtErr) return res.status(400).json({ error: fmtErr });
  // 验证：学号/工号全局唯一（非空时检查）
  if (p.student_id && p.student_id.trim()) {
    const dup = db.prepare('SELECT id FROM players WHERE student_id = ? AND deleted_at IS NULL').get(p.student_id.trim());
    if (dup) return res.status(400).json({ error: '学号/工号已存在，不能重复录入' });
  }
  // 验证：同队球衣号码唯一（号码非0时检查）
  if (p.jersey_number && p.jersey_number > 0) {
    const dupNum = db.prepare('SELECT id FROM players WHERE team_id = ? AND jersey_number = ? AND deleted_at IS NULL').get(p.team_id, p.jersey_number);
    if (dupNum) return res.status(400).json({ error: '该球队已存在相同球衣号码' });
  }
  // 非官员（上场球员）必须上传证件照
  if (!p.is_official && !p.photo_path) {
    return res.status(400).json({ error: '请上传球员证件照' });
  }
  // 每队只能有一名领队，更换须先删除原领队
  if (isLeaderRecord(p.is_official, p.official_role)) {
    const other = findOtherLeader(p.team_id, null);
    if (other) return res.status(400).json({ error: `该队已有领队「${other.name}」，每队只能设一名领队；如需更换，请先删除原领队` });
  }
  // 每队只能有一名队长：如果设为队长，先取消同队其他队长
  if (p.is_captain) {
    db.prepare('UPDATE players SET is_captain = 0 WHERE team_id = ?').run(p.team_id);
  }
  const pTeam = db.prepare('SELECT gender FROM teams WHERE id=?').get(p.team_id);
  const pGender = pTeam ? pTeam.gender : 'men';
  const result = db.prepare(`INSERT INTO players (team_id,student_id,name,age,class_name,height,weight,jersey_number,position,health,phone,is_official,official_role,is_captain,student_card_path,safety_doc_path,photo_path,status,gender,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'approved',?,?)`).run(
    p.team_id, p.student_id||'', p.name, p.age||0, p.class_name||'', p.height||0, p.weight||0,
    p.jersey_number||0, p.position||'', p.health||'', p.phone||'', p.is_official?1:0, p.official_role||'', p.is_captain?1:0,
    p.student_card_path||'', p.safety_doc_path||'', p.photo_path||'', pGender, BJ()
  );
  broadcastUpdate('players', {});
  logOperation(req, 'add_player', 'player', result.lastInsertRowid, { name: p.name, team_id: p.team_id });
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/players/:id', requireAdmin, (req, res) => {
  const p = req.body || {};
  const pid = req.params.id;
  const playerId = Number(pid);
  if (!Number.isInteger(playerId) || playerId <= 0) return res.status(400).json({ error: '球员标识无效' });
  const beforePlayer = db.prepare('SELECT name,jersey_number,position,team_id,phone,student_id,class_name,is_captain FROM players WHERE id=?').get(playerId);
  if (!beforePlayer) return res.status(404).json({ error: '球员不存在' });
  if (!p.name || !String(p.name).trim()) return res.status(400).json({ error: '球员姓名不能为空' });
  // 输入长度校验
  const lenErr = checkLen(p.student_id, MAX_LEN.student_id, '学号/工号')
    || checkLen(p.name, MAX_LEN.player_name, '球员姓名')
    || checkLen(p.class_name, MAX_LEN.class_name, '班级')
    || checkLen(p.position, MAX_LEN.position, '场上位置')
    || checkLen(p.health, MAX_LEN.health, '健康状况')
    || checkLen(p.phone, MAX_LEN.phone, '联系电话')
    || checkLen(p.official_role, MAX_LEN.official_role, '官员职务');
  if (lenErr) return res.status(400).json({ error: lenErr });
  const fmtErrP = validatePersonFields(p);
  if (fmtErrP) return res.status(400).json({ error: fmtErrP });
  // 验证：学号/工号全局唯一（排除自己）
  if (p.student_id && p.student_id.trim()) {
    const dup = db.prepare('SELECT id FROM players WHERE student_id = ? AND deleted_at IS NULL AND id != ?').get(p.student_id.trim(), pid);
    if (dup) return res.status(400).json({ error: '学号/工号已存在，不能重复录入' });
  }
  // 验证：同队球衣号码唯一（排除自己，号码非0时检查）
  if (p.jersey_number && p.jersey_number > 0) {
    const dupNum = db.prepare('SELECT id FROM players WHERE team_id = ? AND jersey_number = ? AND deleted_at IS NULL AND id != ?').get(p.team_id, p.jersey_number, pid);
    if (dupNum) return res.status(400).json({ error: '该球队已存在相同球衣号码' });
  }
  // 每队只能有一名领队，更换须先删除原领队（排除自己）
  if (isLeaderRecord(p.is_official, p.official_role)) {
    const other = findOtherLeader(p.team_id, pid);
    if (other) return res.status(400).json({ error: `该队已有领队「${other.name}」，每队只能设一名领队；如需更换，请先删除原领队` });
  }
  // 每队只能有一名队长：如果设为队长，先取消同队其他队长
  if (p.is_captain) {
    db.prepare('UPDATE players SET is_captain = 0 WHERE team_id = ? AND id != ?').run(p.team_id, pid);
  }
  db.prepare(`UPDATE players SET team_id=?,student_id=?,name=?,age=?,class_name=?,height=?,weight=?,jersey_number=?,position=?,health=?,phone=?,is_official=?,official_role=?,is_captain=?,student_card_path=COALESCE(?,student_card_path),safety_doc_path=COALESCE(?,safety_doc_path),photo_path=COALESCE(?,photo_path) WHERE id=?`).run(
    p.team_id, p.student_id||'', p.name, p.age||0, p.class_name||'', p.height||0, p.weight||0,
    p.jersey_number||0, p.position||'', p.health||'', p.phone||'', p.is_official?1:0, p.official_role||'', p.is_captain?1:0,
    p.student_card_path||null, p.safety_doc_path||null, p.photo_path||null, pid
  );
  broadcastUpdate('players', {});
  logOperation(req, 'update_player', 'player', pid, { before: beforePlayer, after: { name: p.name, jersey_number: p.jersey_number, position: p.position, team_id: p.team_id, phone: p.phone, is_captain: p.is_captain ? 1 : 0 } });
  res.json({ ok: true });
});

app.delete('/api/players/:id', requireAuth, (req, res) => {
  const pid = req.params.id;
  const player = db.prepare('SELECT * FROM players WHERE id=?').get(pid);
  if (!player) return res.status(404).json({ error: '球员不存在' });
  // 测试账号：只能硬删除沙箱数据，不进回收站
  if (req.session.user.role === 'viewer' && req.session.user.isTest === true) {
    if (player.test_data !== 1) return res.status(403).json({ error: '测试账号只能删除沙箱数据' });
    [player.photo_path, player.student_card_path, player.safety_doc_path].forEach(fp => {
      if (fp && typeof fp === 'string' && fp.indexOf('/uploads/') === 0) {
        try { const ff = path.join(__dirname, 'public', fp); if (fs.existsSync(ff)) fs.unlinkSync(ff); } catch (e) {}
      }
    });
    db.prepare('DELETE FROM players WHERE id=?').run(req.params.id);
    broadcastUpdate('players', {});
    return res.json({ ok: true });
  }
  // 访客只能删除本队球员
  if (req.session.user.role === 'viewer') {
    // 名单冻结后运动员不可删改，但球队官员（领队/主教练/队医）仍可维护
    if (isRegistrationFrozen(genderOfTeam(player.team_id)) && !player.is_official) return res.status(403).json({ error: '报名注册已冻结，运动员名单不能再变更（球队官员仍可维护）', frozen: true });
    if (player.team_id !== req.session.user.team_id) return res.status(403).json({ error: '只能删除本队球员' });
    if (teamHasLiveMatch(player.team_id)) return res.status(400).json({ error: '本队有进行中的比赛，暂不能修改名单' });
  }
  // D14 软删除：移入回收站而非物理删除，可在回收站恢复
  db.prepare('UPDATE players SET deleted_at=? WHERE id=?').run(BJ(), pid);
  broadcastUpdate('players', {});
  logOperation(req, 'delete_player', 'player', pid, { name: player.name, team_id: player.team_id, soft: true });
  res.json({ ok: true });
});

// 访客提交球员（新增或编辑，进入待审批状态）
app.post('/api/players/submit', requireAuth, (req, res) => {
  if (req.session.user.role !== 'viewer') return res.status(403).json({ error: '仅访客可使用此接口' });
  const isTest = req.session.user.isTest === true;
  const p = req.body;
  const teamId = isTest ? Number(p.team_id) : req.session.user.team_id;
  if (!teamId) return res.status(400).json({ error: isTest ? '请先在沙箱条选择球队' : '账号未绑定球队' });
  const tRow = db.prepare('SELECT id,gender FROM teams WHERE id=? AND deleted_at IS NULL').get(teamId);
  if (!tRow) return res.status(400).json({ error: '所选球队不存在' });
  if (!isTest && teamHasLiveMatch(teamId)) return res.status(400).json({ error: '本队有进行中的比赛，暂不能修改名单' });
  const isEdit = p.id ? true : false;
  const isOfficial = p.is_official ? true : false;
  const isReplacement = p.is_replacement ? true : false;
  let replacementTarget = null;
  if (isReplacement) {
    // 补录必须指明被替代的已弃赛本队球员（弃赛须已审批通过），一换一
    const rof = Number(p.replacement_of || 0);
    if (!Number.isInteger(rof) || rof <= 0) return res.status(400).json({ error: '补录须选择被替代的已弃赛球员' });
    const tgt = db.prepare('SELECT id,team_id,withdrawn_at FROM players WHERE id=? AND deleted_at IS NULL').get(rof);
    if (!tgt || tgt.withdrawn_at == null) return res.status(400).json({ error: '被替代球员不存在或尚未完成弃赛审批' });
    if (tgt.team_id !== teamId) return res.status(403).json({ error: '只能替代本队已弃赛球员' });
    // 一换一：同一弃赛球员只能被一名补录球员替代（含待审批的补录）
    const taken = db.prepare('SELECT id FROM players WHERE replacement_of=? AND deleted_at IS NULL').get(rof);
    if (taken) return res.status(400).json({ error: '该弃赛球员已有补录球员替代，一换一不可重复替代' });
    replacementTarget = tgt;
  }
  // 名单冻结拦截优先于字段校验：先告知冻结，避免用户填完表单才被拒（测试沙箱不受冻结限制）
  if (!isTest && isRegistrationFrozen(genderOfTeam(teamId))) {
    const exRow = isEdit ? db.prepare('SELECT is_official FROM players WHERE id=?').get(p.id) : null;
    const officialCtx = (exRow && exRow.is_official === 1) || (!isEdit && isOfficial);
    // 补录（替代已弃赛球员）属于冻结期受控例外
    if (!officialCtx && !isReplacement) {
      return res.status(403).json({ error: '报名注册已冻结，运动员名单不能再变更；冻结期间仅可维护球队官员（领队/主教练/队医）或申请弃赛补录', frozen: true });
    }
  }
  // 输入长度校验
  const lenErr = checkLen(p.student_id, MAX_LEN.student_id, '学号/工号')
    || checkLen(p.name, MAX_LEN.player_name, '球员姓名')
    || checkLen(p.class_name, MAX_LEN.class_name, '班级')
    || checkLen(p.position, MAX_LEN.position, '场上位置')
    || checkLen(p.health, MAX_LEN.health, '健康状况')
    || checkLen(p.phone, MAX_LEN.phone, '联系电话')
    || checkLen(p.official_role, MAX_LEN.official_role, '官员职务');
  if (lenErr) return res.status(400).json({ error: lenErr });
  const fmtErrS = validatePersonFields(p);
  if (fmtErrS) return res.status(400).json({ error: fmtErrS });
  // 每队始终只能有一名领队，更换领队须先删除原领队
  if (isLeaderRecord(isOfficial, p.official_role)) {
    const otherLeader = findOtherLeader(teamId, isEdit ? p.id : null);
    if (otherLeader) return res.status(400).json({ error: `本队已有领队「${otherLeader.name}」，每队只能设一名领队；如需更换，请先删除原领队` });
  }

  if (isEdit) {
    // 编辑已有球员：检查是否属于本队
    const existing = db.prepare('SELECT * FROM players WHERE id=?').get(p.id);
    if (!existing) return res.status(404).json({ error: '球员不存在' });
    if (existing.team_id !== teamId) return res.status(403).json({ error: '只能编辑本队球员' });
    if (existing.withdrawn_at) return res.status(403).json({ error: '该球员已放弃参赛，名单锁定；如需调整请联系组委会' });
    if (isTest && existing.test_data !== 1) return res.status(403).json({ error: '测试账号只能操作沙箱数据' });
    // 如果已经是待审批状态，不允许重复提交
    if (existing.status === 'pending') return res.status(400).json({ error: '该球员已有待审批修改，请等待管理员审核' });
    // 如果是草稿状态：直接更新，保持draft状态，不强制校验材料
    if (existing.status === 'draft') {
      // 非官员草稿保存时不强制安全责任书，提交审批时才校验
      db.prepare(`UPDATE players SET
        student_id=?,name=?,age=?,class_name=?,height=?,weight=?,jersey_number=?,position=?,health=?,phone=?,
        is_official=?,official_role=?,is_captain=?,student_card_path=COALESCE(?,student_card_path),safety_doc_path=COALESCE(?,safety_doc_path),photo_path=COALESCE(?,photo_path),reject_reason='',reject_at=NULL
        WHERE id=?`).run(
        p.student_id||'', p.name, p.age||0, p.class_name||'', p.height||0, p.weight||0,
        p.jersey_number||0, p.position||'', p.health||'', p.phone||'',
        p.is_official?1:0, p.official_role||'', p.is_captain?1:0,
        p.student_card_path||null, p.safety_doc_path||null, p.photo_path||null, p.id
      );
      broadcastUpdate('players', {});
      logOperation(req, 'update_draft_player', 'player', p.id, { name: p.name });
      return res.json({ ok: true, message: '草稿已保存，请补齐材料后点击"提交审批"' });
    }
    // 非官员球员必须上传安全责任书（审批中的编辑）
    if (!isOfficial && !p.safety_doc_path && !existing.safety_doc_path) {
      return res.status(400).json({ error: '请上传参赛安全责任书' });
    }
    // 非官员球员必须有证件照
    if (!isOfficial && !p.photo_path && !existing.photo_path) {
      return res.status(400).json({ error: '请上传球员证件照' });
    }
    // 编辑已审批球员：把新数据存入pending_data，status改为pending
    const pendingData = JSON.stringify({
      student_id: p.student_id || '',
      name: p.name,
      age: p.age || 0,
      class_name: p.class_name || '',
      height: p.height || 0,
      weight: p.weight || 0,
      jersey_number: p.jersey_number || 0,
      position: p.position || '',
      health: p.health || '',
      phone: p.phone || '',
      is_official: p.is_official ? 1 : 0,
      official_role: p.official_role || '',
      is_captain: p.is_captain ? 1 : 0,
      student_card_path: p.student_card_path || existing.student_card_path || '',
      safety_doc_path: p.safety_doc_path || existing.safety_doc_path || '',
      photo_path: p.photo_path || existing.photo_path || ''
    });
    db.prepare('UPDATE players SET status=?, pending_data=?, submitted_by=?, reject_reason=\'\', reject_at=NULL WHERE id=?')
      .run('pending', pendingData, req.session.user.id, p.id);
    broadcastUpdate('players', {});
    logOperation(req, 'submit_player_edit', 'player', p.id, { name: p.name });
    // 通知所有管理员（测试沙箱与隐藏测试队不打扰管理员）
    if (!isTest && !teamIsHidden(teamId)) sendMessageToAllAdmins({
      title: '球员修改待审批',
      content: `${req.session.user.username} 提交了球员「${p.name}」的修改申请，等待审批。`,
      type: 'player_submit', relatedType: 'player', relatedId: p.id
    });
    res.json({ ok: true, message: '修改已提交，等待管理员审批' });
  } else {
    // 新增球员
    // 验证学号唯一（包括待审批的）
    if (p.student_id && p.student_id.trim()) {
      const dup = db.prepare('SELECT id FROM players WHERE student_id = ? AND deleted_at IS NULL AND withdrawn_at IS NULL').get(p.student_id.trim());
      if (dup) return res.status(400).json({ error: '学号/工号已存在，不能重复录入' });
    }
    // 验证同队球衣号码唯一（包括待审批的）
    if (p.jersey_number && p.jersey_number > 0) {
      const dupNum = db.prepare('SELECT id FROM players WHERE team_id = ? AND jersey_number = ? AND deleted_at IS NULL AND withdrawn_at IS NULL').get(teamId, p.jersey_number);
      if (dupNum) return res.status(400).json({ error: '该球队已存在相同球衣号码' });
    }
    // 非官员新增球员必须上传证件照与安全责任书
    if (!isOfficial && !p.photo_path) {
      return res.status(400).json({ error: '请上传球员证件照' });
    }
    if (!isOfficial && !p.safety_doc_path) {
      return res.status(400).json({ error: '请上传参赛安全责任书' });
    }
    const _tg = db.prepare('SELECT gender FROM teams WHERE id=?').get(teamId);
    const _gender = _tg ? _tg.gender : 'men';
    const result = db.prepare(`INSERT INTO players
      (team_id,student_id,name,age,class_name,height,weight,jersey_number,position,health,phone,is_official,official_role,is_captain,status,student_card_path,safety_doc_path,photo_path,submitted_by,gender,is_replacement,replacement_of)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      teamId, p.student_id||'', p.name, p.age||0, p.class_name||'', p.height||0, p.weight||0,
      p.jersey_number||0, p.position||'', p.health||'', p.phone||'', p.is_official?1:0, p.official_role||'', p.is_captain?1:0,
      'pending', p.student_card_path||'', p.safety_doc_path||'', p.photo_path||'', req.session.user.id, _gender,
      isReplacement ? 1 : 0, replacementTarget ? replacementTarget.id : null
    );
    db.prepare('UPDATE players SET test_data=? WHERE id=?').run(isTest ? 1 : 0, result.lastInsertRowid);
    broadcastUpdate('players', {});
    logOperation(req, 'submit_player_add', 'player', result.lastInsertRowid, { name: p.name });
    // 通知所有管理员（测试沙箱与隐藏测试队不打扰管理员）
    if (!isTest && !teamIsHidden(teamId)) sendMessageToAllAdmins({
      title: isReplacement ? '补录球员待审批' : '新球员待审批',
      content: `${req.session.user.username} 提交了${isReplacement ? '补录球员' : '新球员'}「${p.name}」的${isReplacement ? '补录（替代弃赛球员）' : '添加'}申请，等待审批。`,
      type: 'player_submit', relatedType: 'player', relatedId: result.lastInsertRowid
    });
    res.json({ id: result.lastInsertRowid, message: '球员已提交，等待管理员审批' });
  }
});

// 学生证图片上传
app.post('/api/players/student-card', requireAdminOrViewer, studentCardUpload.single('card'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  const cardPath = '/uploads/student_cards/' + req.file.filename;
  res.json({ cardPath });
});

// 球员证件照上传（必填材料，仅图片）
app.post('/api/players/photo', requireAdminOrViewer, playerPhotoUpload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  const photoPath = '/uploads/player_photos/' + req.file.filename;
  res.json({ photoPath });
});

// 电子参赛证：返回球员信息+二维码（dataURL）。仅管理员或本队可查
app.get('/api/players/:id/credential', requireAuth, async (req, res) => {
  try {
    const p = db.prepare(`SELECT p.*, t.name as team_name, COALESCE(NULLIF(t.college,''), t.name) as team_college FROM players p JOIN teams t ON p.team_id=t.id WHERE p.id=? AND p.deleted_at IS NULL`).get(req.params.id);
    if (!p) return res.status(404).json({ error: '球员不存在' });
    if (req.session.user.role === 'viewer' && req.session.user.team_id !== p.team_id) {
      return res.status(403).json({ error: '只能查看本队球员参赛证' });
    }
    if (p.status !== 'approved') return res.status(400).json({ error: '该球员尚未通过审批，暂不能生成参赛证' });
    if (!p.is_official && !p.photo_path) return res.status(400).json({ error: '该球员缺少证件照，无法生成参赛证' });
    const code = makeCredentialCode(p.id);
    // 二维码只编码裸凭证码，保证现场扫码枪/页内扫码得到的内容可直接通过校验
    const qrDataUrl = await QRCode.toDataURL(code, { width: 320, margin: 1 });
    const susp = playerActiveSuspension(p.id);
    res.json({
      player: {
        id: p.id, name: p.name, jersey_number: p.jersey_number, position: p.position,
        student_id: p.student_id, class_name: p.class_name, college: p.team_college || '',
        photo_path: p.photo_path, is_captain: p.is_captain, is_official: p.is_official
      },
      team: { id: p.team_id, name: p.team_name },
      code, qrText: code, qrDataUrl,
      eligible: !susp,
      suspension: susp ? { reason: susp.reason, remaining: susp.remaining_count ?? susp.match_count } : null
    });
  } catch (e) {
    console.error('credential error', e);
    res.status(500).json({ error: '生成参赛证失败' });
  }
});

// 扫码核验：管理员凭凭证码查询球员资格（可带 matchId 返回当场检录状态）
app.get('/api/checkin/lookup', requireAdmin, (req, res) => {
  const pid = verifyCredentialCode(req.query.code || '');
  if (!pid) return res.status(400).json({ error: '无效的参赛证二维码' });
  const p = db.prepare(`SELECT p.id,p.name,p.jersey_number,p.position,p.student_id,p.class_name,p.photo_path,p.is_official,p.status,p.team_id,p.withdrawn_at,t.name as team_name,COALESCE(NULLIF(t.college,''),t.name) as team_college FROM players p JOIN teams t ON p.team_id=t.id WHERE p.id=? AND p.deleted_at IS NULL`).get(pid);
  if (!p) return res.status(404).json({ error: '查无此球员' });
  if (p.withdrawn_at) return res.status(400).json({ error: '该球员已放弃本届赛事参赛资格，不可检录' });
  const susp = playerActiveSuspension(p.id);
  let checkin = null;
  if (req.query.matchId) {
    checkin = db.prepare('SELECT status, check_in_time FROM match_checkins WHERE match_id=? AND player_id=?').get(req.query.matchId, pid) || null;
  }
  res.json({
    player: { id: p.id, name: p.name, jersey_number: p.jersey_number, position: p.position, student_id: p.student_id, class_name: p.class_name, photo_path: p.photo_path, is_official: p.is_official, status: p.status },
    team: { id: p.team_id, name: p.team_name, college: p.team_college || '' },
    approved: p.status === 'approved',
    suspended: !!susp,
    suspension: susp ? { reason: susp.reason, remaining: susp.remaining_count ?? susp.match_count } : null,
    checkin
  });
});

// ========== 赛事裁判员申请（学生自主申请 → 管理员审批）==========
// 免登录上传：证件照
app.post('/api/referee-applications/photo', refereeAppLimiter, playerPhotoUpload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  res.json({ photoPath: '/uploads/player_photos/' + req.file.filename });
});
// 免登录上传：学生证或学信网学籍信息截图
app.post('/api/referee-applications/proof', refereeAppLimiter, studentCardUpload.single('card'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  res.json({ proofPath: '/uploads/student_cards/' + req.file.filename });
});
// 免登录上传：公平竞赛承诺书
app.post('/api/referee-applications/fair-play', refereeAppLimiter, fairPlayUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  res.json({ path: '/uploads/fair_play/' + req.file.filename });
});

// 提交裁判申请（免登录，需验证码；同一学号每日最多3次，提交即计数含被拒/撤回）
app.post('/api/referee-applications', refereeAppLimiter, (req, res) => {
  const b = req.body || {};
  if (!req.session.captcha || !b.captcha || String(b.captcha).toUpperCase() !== req.session.captcha) {
    return res.status(400).json({ error: '验证码错误', captchaRequired: true });
  }
  req.session.captcha = null; // 用后即焚
  const name = String(b.name || '').trim();
  const college = String(b.college || '').trim();
  const student_id = String(b.student_id || '').trim();
  const phone = String(b.phone || '').trim();
  const gender = ['men', 'women'].includes(b.gender) ? b.gender : 'men';
  const photo_path = String(b.photo_path || '').trim();
  const proof_path = String(b.proof_path || '').trim();
  const fair_play_path = String(b.fair_play_path || '').trim();
  if (!name) return res.status(400).json({ error: '请填写姓名' });
  if (!student_id) return res.status(400).json({ error: '请填写学号' });
  if (!/^\d{11}$/.test(phone)) return res.status(400).json({ error: '联系电话必须为11位数字' });
  if (!photo_path) return res.status(400).json({ error: '请上传证件照' });
  if (!proof_path) return res.status(400).json({ error: '请上传学生证或学信网学籍信息截图' });
  if (!fair_play_path) return res.status(400).json({ error: '请上传已签署的公平竞赛承诺书' });
  const lenErr = checkLen(name, MAX_LEN.player_name, '姓名')
    || checkLen(college, MAX_LEN.referee_college, '所在学院')
    || checkLen(student_id, MAX_LEN.student_id, '学号');
  if (lenErr) return res.status(400).json({ error: lenErr });
  // 同一学号当日提交次数（北京时间，提交即计数，含被拒/撤回）
  const bjDate = BJ().slice(0, 10);
  const cnt = db.prepare("SELECT COUNT(*) c FROM referee_applications WHERE student_id=? AND date(created_at)=?").get(student_id, bjDate).c;
  if (cnt >= 3) return res.status(400).json({ error: '同一学号每天最多提交 3 次裁判申请（提交即计数），请明日再试' });
  const r = db.prepare(`INSERT INTO referee_applications (name,gender,college,student_id,phone,photo_path,proof_path,fair_play_path,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,'pending',?)`)
    .run(name, gender, college, student_id, phone, photo_path, proof_path, fair_play_path, BJ());
  logOperation(req, 'submit_referee_application', 'referee_application', r.lastInsertRowid, { name, student_id });
  sendMessageToAllAdmins({
    title: '裁判员申请待审批',
    content: `${name}（学号 ${student_id}）提交了赛事裁判员申请，等待审批。`,
    type: 'referee_apply', relatedType: 'referee_application', relatedId: r.lastInsertRowid
  });
  res.json({ id: r.lastInsertRowid, message: '申请已提交，等待管理员审批', remaining: 2 - cnt });
});

// 免登录查询：本人申请记录（学号+姓名匹配）
app.get('/api/referee-applications/lookup', refereeAppLimiter, (req, res) => {
  const sid = String(req.query.student_id || '').trim();
  const name = String(req.query.name || '').trim();
  if (!sid || !name) return res.status(400).json({ error: '请提供学号与姓名' });
  const list = db.prepare(`SELECT id,name,gender,college,student_id,phone,status,level,ref_type,serial_number,admin_note,created_at
    FROM referee_applications WHERE student_id=? AND name=? ORDER BY id DESC LIMIT 10`).all(sid, name);
  res.json({ list });
});

// 免登录撤回申请（仅待审批可撤回，学号+姓名匹配；计入当日次数）
app.post('/api/referee-applications/:id/withdraw', refereeAppLimiter, (req, res) => {
  const b = req.body || {};
  const app = db.prepare('SELECT * FROM referee_applications WHERE id=?').get(req.params.id);
  if (!app) return res.status(404).json({ error: '申请不存在' });
  if (String(app.student_id || '').trim() !== String(b.student_id || '').trim() || app.name !== String(b.name || '').trim()) {
    return res.status(403).json({ error: '学号或姓名不匹配，无法撤回' });
  }
  if (app.status !== 'pending') return res.status(400).json({ error: '仅待审批的申请可以撤回' });
  db.prepare(`UPDATE referee_applications SET status='withdrawn', withdrawn_at=? WHERE id=?`).run(BJ(), app.id);
  logOperation(req, 'withdraw_referee_application', 'referee_application', app.id, { name: app.name });
  res.json({ ok: true, message: '申请已撤回（计入当日申请次数）' });
});

// 管理员：待审批裁判申请列表
app.get('/api/referee-applications/pending', requireAdmin, (req, res) => {
  const list = db.prepare(`SELECT id,name,gender,college,student_id,phone,photo_path,proof_path,fair_play_path,status,admin_note,created_at
    FROM referee_applications WHERE status='pending' ORDER BY created_at DESC`).all();
  res.json({ list });
});

// 管理员：审批通过（评定等级、可选专职岗位；自动建号+加入裁判队伍）
app.post('/api/referee-applications/:id/approve', requireAdmin, (req, res) => {
  const app = db.prepare('SELECT * FROM referee_applications WHERE id=?').get(req.params.id);
  if (!app) return res.status(404).json({ error: '申请不存在' });
  if (app.status !== 'pending') return res.status(400).json({ error: '该申请已处理，请勿重复操作' });
  const level = String(req.body.level || '').trim();
  if (!['一级', '二级', '三级', '四级'].includes(level)) return res.status(400).json({ error: '请选择裁判等级（一级~四级）' });
  const refType = String(req.body.ref_type || '').trim();
  if (refType && !['main', 'assistant', 'fourth'].includes(refType)) return res.status(400).json({ error: '专职岗位无效' });
  // 自动生成裁判编号 + 专属登录账号（与手动添加裁判一致）
  const serial = generateRefereeSerial();
  const username = generateRefereeUsername();
  const password = generateRandomPassword();
  const userResult = db.prepare('INSERT INTO users (username,password,role,display_name,must_change_password,created_at) VALUES (?,?,?,?,1,?)')
    .run(username, bcrypt.hashSync(password, 10), 'referee', app.name, BJ());
  const userId = userResult.lastInsertRowid;
  const isMain = refType === 'main' ? 1 : 0;
  const isAssistant = refType === 'assistant' ? 1 : 0;
  const refResult = db.prepare(`INSERT INTO referees (serial_number,name,college,student_id,phone,level,is_main_ref,is_assistant_ref,ref_type,fair_play_path,photo_path,user_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(serial, app.name, app.college || '', app.student_id || '', app.phone || '', level,
      isMain, isAssistant, refType, app.fair_play_path || '', app.photo_path || '', userId, BJ());
  db.prepare(`UPDATE referee_applications SET status='approved',level=?,ref_type=?,serial_number=?,username=?,password=?,reviewed_by=?,reviewed_at=? WHERE id=?`)
    .run(level, refType, serial, username, password, req.session.user.id, BJ(), app.id);
  broadcastUpdate('referees', {});
  logOperation(req, 'approve_referee_application', 'referee_application', app.id, { name: app.name, username, serial });
  res.json({ id: refResult.lastInsertRowid, username, password, serial, message: '已通过并自动创建裁判账号' });
});

// 管理员：审批拒绝
app.post('/api/referee-applications/:id/reject', requireAdmin, (req, res) => {
  const app = db.prepare('SELECT * FROM referee_applications WHERE id=?').get(req.params.id);
  if (!app) return res.status(404).json({ error: '申请不存在' });
  if (app.status !== 'pending') return res.status(400).json({ error: '该申请已处理' });
  const note = String(req.body.note || '').trim().slice(0, 200);
  db.prepare(`UPDATE referee_applications SET status='rejected',admin_note=?,reviewed_by=?,reviewed_at=? WHERE id=?`)
    .run(note, req.session.user.id, BJ(), app.id);
  logOperation(req, 'reject_referee_application', 'referee_application', app.id, { name: app.name, note });
  res.json({ ok: true, message: '已拒绝该申请' });
});

// 安全责任书上传（报名时）
app.post('/api/players/safety-doc', requireAdminOrViewer, safetyDocUpload.single('doc'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  const docPath = '/uploads/safety_docs/' + req.file.filename;
  res.json({ docPath });
});

// 给已有球员补传/替换安全责任书
app.post('/api/players/:id/safety-doc', requireAdminOrViewer, safetyDocUpload.single('doc'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  const player = db.prepare('SELECT * FROM players WHERE id=?').get(req.params.id);
  if (!player) return res.status(404).json({ error: '球员不存在' });
  // 权限：管理员可操作所有；访客只能操作本队
  if (req.session.user.role === 'viewer' && player.team_id !== req.session.user.team_id) {
    return res.status(403).json({ error: '只能操作本队球员' });
  }
  const docPath = '/uploads/safety_docs/' + req.file.filename;
  db.prepare('UPDATE players SET safety_doc_path=? WHERE id=?').run(docPath, req.params.id);
  broadcastUpdate('players', {});
  logOperation(req, 'upload_safety_doc', 'player', req.params.id, { name: player.name });
  res.json({ ok: true, docPath });
});

// 管理员获取待审批球员列表
app.get('/api/players/pending', requireAdmin, (req, res) => {
  const showHidden = req.session.user.username === 'admin' && req.query.include_hidden === '1';
  const players = db.prepare(`
    SELECT p.*, t.name as team_name, u.username as submitter_name
    FROM players p
    JOIN teams t ON p.team_id = t.id
    LEFT JOIN users u ON p.submitted_by = u.id
    WHERE p.status = 'pending' AND p.deleted_at IS NULL AND COALESCE(p.test_data,0) = 0 ${showHidden ? '' : 'AND COALESCE(t.is_hidden,0) = 0'}
    ORDER BY p.created_at DESC
  `).all();
  res.json(players);
});

// 管理员审批通过（可修改信息）
app.post('/api/players/:id/approve', requireAdmin, (req, res) => {
  const pid = req.params.id;
  const player = db.prepare('SELECT * FROM players WHERE id=?').get(pid);
  if (!player) return res.status(404).json({ error: '球员不存在' });
  if (player.status !== 'pending') return res.status(400).json({ error: '该球员不是待审批状态' });

  const hasPendingData = player.pending_data && player.pending_data.length > 0;
  // 以库中已存数据（编辑待审批时取 pending_data）为底，再用请求体覆盖，避免缺字段时绑定 undefined
  let stored = player;
  if (hasPendingData) { try { stored = Object.assign({}, player, JSON.parse(player.pending_data)); } catch (e) { stored = player; } }
  const p = Object.assign({}, stored, req.body || {});
  const fmtErrA = validatePersonFields(p);
  if (fmtErrA) return res.status(400).json({ error: fmtErrA });

  // 验证学号唯一（排除自己）
  if (p.student_id && p.student_id.trim()) {
    const dup = db.prepare('SELECT id FROM players WHERE student_id = ? AND deleted_at IS NULL AND id != ?').get(p.student_id.trim(), pid);
    if (dup) return res.status(400).json({ error: '学号/工号已存在，不能重复录入' });
  }
  // 验证同队球衣号码唯一（排除自己）
  if (p.jersey_number && p.jersey_number > 0) {
    const dupNum = db.prepare('SELECT id FROM players WHERE team_id = ? AND jersey_number = ? AND deleted_at IS NULL AND id != ?').get(player.team_id, p.jersey_number, pid);
    if (dupNum) return res.status(400).json({ error: '该球队已存在相同球衣号码' });
  }
  // 队长处理
  if (p.is_captain) {
    db.prepare('UPDATE players SET is_captain = 0 WHERE team_id = ? AND id != ?').run(player.team_id, pid);
  }

  if (hasPendingData) {
    // 是编辑待审批：应用修改到主字段
    db.prepare(`UPDATE players SET
      student_id=?,name=?,age=?,class_name=?,height=?,weight=?,jersey_number=?,position=?,health=?,phone=?,
      is_official=?,official_role=?,is_captain=?,student_card_path=?,safety_doc_path=?,photo_path=?,status='approved',pending_data='',submitted_by=NULL,reject_reason='',reject_at=NULL
      WHERE id=?`).run(
      p.student_id||'', p.name, p.age||0, p.class_name||'', p.height||0, p.weight||0,
      p.jersey_number||0, p.position||'', p.health||'', p.phone||'',
      p.is_official?1:0, p.official_role||'', p.is_captain?1:0, p.student_card_path||player.student_card_path||'',
      p.safety_doc_path||player.safety_doc_path||'',
      p.photo_path||player.photo_path||'',
      pid
    );
  } else {
    // 是新增待审批：直接更新字段并标记approved
    db.prepare(`UPDATE players SET
      student_id=?,name=?,age=?,class_name=?,height=?,weight=?,jersey_number=?,position=?,health=?,phone=?,
      is_official=?,official_role=?,is_captain=?,student_card_path=?,safety_doc_path=?,photo_path=?,status='approved',pending_data='',submitted_by=NULL,reject_reason='',reject_at=NULL
      WHERE id=?`).run(
      p.student_id||'', p.name, p.age||0, p.class_name||'', p.height||0, p.weight||0,
      p.jersey_number||0, p.position||'', p.health||'', p.phone||'',
      p.is_official?1:0, p.official_role||'', p.is_captain?1:0, p.student_card_path||player.student_card_path||'',
      p.safety_doc_path||player.safety_doc_path||'',
      p.photo_path||player.photo_path||'',
      pid
    );
  }
  // 补录审批通过：将被替代球员的未执行完禁赛转移给补录球员（禁赛继承）
  if (player.is_replacement === 1 && player.replacement_of) {
    const transferred = transferSuspensions(player.replacement_of, pid, req.session.user.id);
    if (transferred > 0) {
      logOperation(req, 'transfer_suspension', 'player', pid, { from: player.replacement_of, count: transferred });
    }
  }
  broadcastUpdate('players', {});
  logOperation(req, 'approve_player', 'player', pid, { name: p.name, type: hasPendingData ? 'edit' : 'add' });
  // 通知提交申请的访客
  if (player.submitted_by) {
    sendMessage(player.submitted_by, {
      senderId: req.session.user.id,
      senderName: req.session.user.displayName || req.session.user.username,
      title: '球员审批通过',
      content: `您提交的球员「${p.name}」${hasPendingData ? '修改' : '添加'}申请已通过审批。`,
      type: 'player_approved', relatedType: 'player', relatedId: pid
    });
  }
  res.json({ ok: true });
});

// 管理员审批拒绝（打回）：必填理由；新增待审批退回草稿保留数据可改后重交，已通过球员的修改被拒则恢复原状
app.post('/api/players/:id/reject', requireAdmin, (req, res) => {
  const pid = req.params.id;
  const reason = String((req.body && req.body.reason) || '').trim();
  if (!reason) return res.status(400).json({ error: '请填写打回理由' });
  if (reason.length > 200) return res.status(400).json({ error: '打回理由不能超过200字' });
  const player = db.prepare('SELECT * FROM players WHERE id=?').get(pid);
  if (!player) return res.status(404).json({ error: '球员不存在' });
  if (player.status !== 'pending') return res.status(400).json({ error: '该球员不是待审批状态' });

  const hasPendingData = player.pending_data && player.pending_data.length > 0;
  if (hasPendingData) {
    // 已通过球员提交修改被打回：取消本次修改，恢复原approved状态与资格，记录理由
    db.prepare("UPDATE players SET status='approved', pending_data='', submitted_by=NULL, reject_reason=?, reject_at=? WHERE id=?")
      .run(reason, BJ(), pid);
  } else {
    // 新增待审批被打回：退回草稿（不删除），保留已填数据供球队修改后重新提交
    db.prepare("UPDATE players SET status='draft', submitted_by=NULL, reject_reason=?, reject_at=? WHERE id=?")
      .run(reason, BJ(), pid);
  }
  broadcastUpdate('players', {});
  logOperation(req, 'reject_player', 'player', pid, { name: player.name, type: hasPendingData ? 'edit' : 'add', reason });
  // 通知该队球队管理员：哪名球员、为何打回
  if (player.team_id) {
    const action = hasPendingData ? '修改申请' : '报名申请';
    sendMessageToTeam(player.team_id, {
      title: '球员申请被打回',
      content: `球员「${player.name}」的${action}被拒绝，打回理由：${reason}。请登录球队端查看该球员并修改后重新提交。`,
      type: 'player_rejected', relatedType: 'player', relatedId: pid
    });
  }
  res.json({ ok: true });
});

// 单个草稿球员提交审批（批量导入后逐人提交；球队端/管理员端通用，校验规则与整体提交一致）
app.post('/api/players/:id/submit-draft', requireAuth, (req, res) => {
  const pid = +req.params.id;
  const p = db.prepare('SELECT * FROM players WHERE id=?').get(pid);
  if (!p) return res.status(404).json({ error: '球员不存在' });
  if (p.status !== 'draft') return res.status(400).json({ error: '该球员不是草稿状态' });
  const isAdmin = req.session.user.role === 'admin';
  if (!isAdmin && req.session.user.team_id !== p.team_id) return res.status(403).json({ error: '无权操作其他球队球员' });
  if (!isAdmin && teamHasLiveMatch(p.team_id)) return res.status(400).json({ error: '本队有进行中的比赛，不能修改名单' });
  // 材料校验（与整体提交一致）：非官员球员须有学生证和安全责任书
  if (!p.is_official) {
    const miss = [];
    if (!p.student_card_path) miss.push('学生证');
    if (!p.safety_doc_path) miss.push('安全责任书');
    if (miss.length) return res.status(400).json({ error: `球员材料未补齐（${miss.join('、')}），请先编辑补齐后再提交` });
  }
  db.prepare("UPDATE players SET status='pending', submitted_by=?, reject_reason='', reject_at=NULL WHERE id=?")
    .run(isAdmin ? null : req.session.user.id, pid);
  broadcastUpdate('players', {});
  logOperation(req, 'submit_player_add', 'player', pid, { name: p.name, single: true });
  // 通知管理员审批（隐藏测试队不打扰）
  if (!teamIsHidden(p.team_id)) {
    sendMessageToAllAdmins({
      title: '球员待审批',
      content: `${isAdmin ? '管理员' : (req.session.user.username || '球队')} 提交了球员「${p.name}」的报名申请，等待审批。`,
      type: 'player_submit', relatedType: 'player', relatedId: pid
    });
  }
  res.json({ ok: true, message: '已提交，等待管理员审批' });
});

// ========== 弃赛申请与审批（赛事期间） ==========
// 弃赛协议书模板下载（仿安全责任书模板下载）
app.get('/api/players/withdraw-template', (req, res) => {
  const tplPath = path.join(__dirname, 'public', 'uploads', 'templates', 'withdrawal_agreement_template.docx');
  if (!fs.existsSync(tplPath)) return res.status(404).json({ error: '模板文件不存在' });
  res.download(tplPath, '校园足球赛事球员放弃本届赛事协议书.docx');
});

// 在校学生身份证明（替代学生证）模板下载：学生证丢失或暂时无法提供时使用
app.get('/api/players/identity-template', (req, res) => {
  const tplPath = path.join(__dirname, 'public', 'uploads', 'templates', 'identity_student_card_template.docx');
  if (!fs.existsSync(tplPath)) return res.status(404).json({ error: '模板文件不存在' });
  res.download(tplPath, '校园足球赛事在校学生身份证明（替代学生证）.docx');
});

// 上传弃赛协议书
app.post('/api/players/withdraw-doc', requireAdminOrViewer, withdrawalDocUpload.single('doc'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  res.json({ docPath: '/uploads/withdrawals/' + req.file.filename });
});

// 球队端/管理员：提交弃赛申请（须上传协议书）
app.post('/api/players/:id/withdraw', requireAuth, (req, res) => {
  const pid = Number(req.params.id);
  const isAdmin = req.session.user.role === 'admin';
  const isViewer = req.session.user.role === 'viewer';
  if (!isAdmin && !isViewer) return res.status(403).json({ error: '无权限' });
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: '球员标识无效' });
  const player = db.prepare('SELECT * FROM players WHERE id=? AND deleted_at IS NULL').get(pid);
  if (!player) return res.status(404).json({ error: '球员不存在' });
  if (isViewer) {
    if (player.team_id !== req.session.user.team_id) return res.status(403).json({ error: '只能为本队球员申请弃赛' });
    if (teamHasLiveMatch(player.team_id)) return res.status(400).json({ error: '本队有进行中的比赛，暂不能操作名单' });
  }
  if (player.status !== 'approved') return res.status(400).json({ error: '仅已审批通过的在册球员可申请弃赛' });
  if (player.withdrawn_at) return res.status(400).json({ error: '该球员已放弃参赛' });
  if (player.withdraw_pending === 1) return res.status(400).json({ error: '该球员已有待审批的弃赛申请' });
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: '请填写弃赛原因' });
  const docPath = String(req.body.doc_path || '').trim();
  if (!docPath) return res.status(400).json({ error: '请上传弃赛协议书' });
  const r = db.prepare('INSERT INTO player_withdrawals (player_id,team_id,reason,doc_path,status,created_at) VALUES (?,?,?,?,?,?)').run(pid, player.team_id, reason, docPath, 'pending', BJ());
  db.prepare('UPDATE players SET withdraw_pending=1 WHERE id=?').run(pid);
  broadcastUpdate('players', {});
  logOperation(req, 'submit_withdrawal', 'player', pid, { name: player.name, reason });
  if (!(req.session.user.isTest === true) && !teamIsHidden(player.team_id)) {
    sendMessageToAllAdmins({
      title: '球员弃赛申请待审批',
      content: `${req.session.user.username} 为球员「${player.name}」提交了弃赛申请，等待审批。`,
      type: 'withdrawal_submit', relatedType: 'player', relatedId: pid
    });
  }
  res.json({ ok: true, id: r.lastInsertRowid, message: '弃赛申请已提交，等待管理员审批' });
});

// 管理员：弃赛申请列表
app.get('/api/admin/withdrawals', requireAdmin, (req, res) => {
  const showHidden = req.session.user.username === 'admin' && req.query.include_hidden === '1';
  const rows = db.prepare(`
    SELECT w.*, p.name as player_name, p.jersey_number, p.student_id, p.position, t.name as team_name, t.gender
    FROM player_withdrawals w
    JOIN players p ON w.player_id=p.id
    JOIN teams t ON w.team_id=t.id
    WHERE w.status='pending' AND p.deleted_at IS NULL ${showHidden ? '' : 'AND COALESCE(t.is_hidden,0)=0'}
    ORDER BY w.created_at DESC
  `).all();
  res.json(rows);
});

// 管理员：同意弃赛
app.post('/api/admin/withdrawals/:id/approve', requireAdmin, (req, res) => {
  const w = db.prepare('SELECT * FROM player_withdrawals WHERE id=?').get(req.params.id);
  if (!w || w.status !== 'pending') return res.status(400).json({ error: '弃赛申请不存在或已处理' });
  const player = db.prepare('SELECT * FROM players WHERE id=?').get(w.player_id);
  if (!player) return res.status(404).json({ error: '球员不存在' });
  const now = BJ();
  db.prepare("UPDATE player_withdrawals SET status='approved', decided_by=?, decided_at=? WHERE id=?").run(req.session.user.id, now, w.id);
  db.prepare('UPDATE players SET withdrawn_at=?, withdrawn_reason=?, withdrawn_doc_path=?, withdrawn_approved_by=?, withdrawn_approved_at=?, withdraw_pending=0 WHERE id=?')
    .run(now, w.reason || '', w.doc_path || '', req.session.user.id, now, w.player_id);
  broadcastUpdate('players', {});
  logOperation(req, 'approve_withdrawal', 'player', w.player_id, { name: player.name, reason: w.reason });
  sendMessageToTeam(player.team_id, {
    title: '弃赛申请已通过',
    content: `球员「${player.name}」的弃赛申请已通过审批，该球员不再参加后续比赛；本队可依规程补录队员（一换一，补录队员将继承其未执行完的禁赛处罚，解禁后方可上场）。`,
    type: 'withdrawal_approved', relatedType: 'player', relatedId: w.player_id
  });
  res.json({ ok: true });
});

// 管理员：驳回弃赛
app.post('/api/admin/withdrawals/:id/reject', requireAdmin, (req, res) => {
  const w = db.prepare('SELECT * FROM player_withdrawals WHERE id=?').get(req.params.id);
  if (!w || w.status !== 'pending') return res.status(400).json({ error: '弃赛申请不存在或已处理' });
  db.prepare("UPDATE player_withdrawals SET status='rejected', decided_by=?, decided_at=? WHERE id=?").run(req.session.user.id, BJ(), w.id);
  db.prepare('UPDATE players SET withdraw_pending=0 WHERE id=?').run(w.player_id);
  broadcastUpdate('players', {});
  logOperation(req, 'reject_withdrawal', 'player', w.player_id, { name: w.player_name || w.player_id });
  res.json({ ok: true });
});

// 管理员：特殊情况手动恢复弃赛球员（留痕；禁赛仍在原球员身上，无需处理）
app.post('/api/admin/players/:id/restore-withdraw', requireAdmin, (req, res) => {
  const player = db.prepare('SELECT * FROM players WHERE id=?').get(req.params.id);
  if (!player) return res.status(404).json({ error: '球员不存在' });
  if (!player.withdrawn_at) return res.status(400).json({ error: '该球员未处于弃赛状态' });
  db.prepare("UPDATE players SET withdrawn_at=NULL, withdrawn_reason='', withdrawn_doc_path='', withdrawn_approved_by=NULL, withdrawn_approved_at=NULL, withdraw_pending=0 WHERE id=?").run(player.id);
  broadcastUpdate('players', {});
  logOperation(req, 'restore_withdraw', 'player', player.id, { name: player.name });
  res.json({ ok: true, message: '已恢复该球员参赛资格（特殊情况处理，已留痕）' });
});

// Excel模板下载
app.get('/api/players/template', requireAuth, async (req, res) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('球员名单');
  ws.columns = [
    { header: '学号/工号', key: 'student_id', width: 15 },
    { header: '姓名', key: 'name', width: 12 },
    { header: '年龄', key: 'age', width: 8 },
    { header: '班级', key: 'class_name', width: 15 },
    { header: '身高(cm)', key: 'height', width: 10 },
    { header: '体重(kg)', key: 'weight', width: 10 },
    { header: '球衣号码', key: 'jersey_number', width: 10 },
    { header: '场上位置', key: 'position', width: 10 },
    { header: '健康状况', key: 'health', width: 12 },
    { header: '联系电话', key: 'phone', width: 15 },
    { header: '是否队长(是/否)', key: 'is_captain', width: 14 },
    { header: '身份(球员/官员)', key: 'is_official', width: 14 },
    { header: '官员职务', key: 'official_role', width: 12 },
  ];
  // 表头样式
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A4D3A' } };
  ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
  // 冻结表头
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  // 添加数据验证提示
  ws.getCell('H2').note = '场上位置请填写：门将、后卫、中场、前锋';
  ws.getCell('K2').note = '是否队长请填写：是或否，每队只能有一名队长';
  ws.getCell('L2').note = '身份请填写：球员或官员';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=player_template.xlsx');
  await wb.xlsx.write(res);
  res.end();
});

// Excel批量导入
const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls'].includes(ext)) cb(null, true);
    else cb(new Error('只允许上传 Excel 文件（.xlsx/.xls）'));
  }
});
app.post('/api/players/import', requireAuth, excelUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传Excel文件' });
  const isAdmin = req.session.user.role === 'admin';
  const teamId = isAdmin ? +req.body.team_id : req.session.user.team_id;
  if (!teamId) return res.status(400).json({ error: '请选择球队' });
  if (!isAdmin && isRegistrationFrozen(genderOfTeam(teamId))) return res.status(403).json({ error: '报名注册已冻结，名单不能再变更', frozen: true });

  if (!isAdmin && teamHasLiveMatch(teamId)) {
    return res.status(400).json({ error: '本队有进行中的比赛，不能修改名单' });
  }

  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    const results = { success: 0, errors: [] };
    const validPositions = ['门将', '后卫', '中场', '前锋'];
    const existingPlayers = db.prepare('SELECT id, student_id, jersey_number FROM players WHERE team_id=? AND deleted_at IS NULL').all(teamId);
    const usedNumbers = new Set(existingPlayers.filter(p => p.jersey_number > 0).map(p => p.jersey_number));
    const usedSids = new Set(existingPlayers.filter(p => p.student_id).map(p => p.student_id));
    // 学号全局唯一检查（回收站已删除球员不计入，允许同学号重新录入）
    const allSids = new Set(db.prepare("SELECT student_id FROM players WHERE student_id != '' AND status != 'rejected' AND deleted_at IS NULL").all().map(r => r.student_id));
    let captainSet = false;

    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // 跳过表头
      const values = row.values;
      // ExcelJS row.values 从索引1开始（Excel走multipart不经过JSON消毒中间件，此处手动消毒防XSS）
      const student_id = sanitizeValue(String(values[1] || '').trim());
      const name = sanitizeValue(String(values[2] || '').trim());
      if (!name) return; // 空行跳过
      // 兼容旧模板：跳过示例行（张三/2024001）
      if (name === '张三' && student_id === '2024001') return;
      const age = parseInt(values[3]) || 0;
      const class_name = sanitizeValue(String(values[4] || '').trim());
      const height = parseFloat(values[5]) || 0;
      const weight = parseFloat(values[6]) || 0;
      const jersey_number = parseInt(values[7]) || 0;
      const position = sanitizeValue(String(values[8] || '').trim());
      const health = sanitizeValue(String(values[9] || '').trim());
      const phone = sanitizeValue(String(values[10] || '').trim());
      const isCaptain = String(values[11] || '').trim() === '是';
      const officialStr = String(values[12] || '').trim();
      const isOfficial = officialStr === '官员' ? 1 : 0;
      const official_role = sanitizeValue(String(values[13] || '').trim());

      // 验证
      if (student_id && allSids.has(student_id)) {
        results.errors.push(`第${rowNumber}行：学号"${student_id}"已存在`);
        return;
      }
      if (jersey_number > 0 && usedNumbers.has(jersey_number)) {
        results.errors.push(`第${rowNumber}行：球衣号码${jersey_number}在本队已存在`);
        return;
      }
      if (position && !validPositions.includes(position)) {
        results.errors.push(`第${rowNumber}行：场上位置"${position}"无效（应为门将/后卫/中场/前锋）`);
        return;
      }
      if (isCaptain && captainSet) {
        results.errors.push(`第${rowNumber}行：每队只能有一名队长`);
        return;
      }

      if (isCaptain) captainSet = true;
      if (jersey_number > 0) usedNumbers.add(jersey_number);
      if (student_id) { usedSids.add(student_id); allSids.add(student_id); }

      // 导入的球员统一为draft状态，需补齐学生证+安全责任书后手动提交审批
      if (isCaptain) {
        db.prepare('UPDATE players SET is_captain=0 WHERE team_id=?').run(teamId);
      }
      const _itg = db.prepare('SELECT gender FROM teams WHERE id=?').get(teamId);
      const _igender = _itg ? _itg.gender : 'men';
      db.prepare(`INSERT INTO players (team_id,student_id,name,age,class_name,height,weight,jersey_number,position,health,phone,is_official,official_role,is_captain,status,submitted_by,gender,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(teamId, student_id, name, age, class_name, height, weight, jersey_number, position, health, phone, isOfficial, official_role, isCaptain ? 1 : 0, 'draft', isAdmin ? null : req.session.user.id, _igender, BJ());
      results.success++;
    });

    logOperation(req, 'import_players', 'team', teamId, { count: results.success, errors: results.errors.length, via: isAdmin ? 'admin' : 'visitor' });
    broadcastUpdate('players', {});
    res.json({ ok: true, ...results });
  } catch (e) {
    res.status(400).json({ error: 'Excel解析失败：' + e.message });
  }
});

// 全队提交审批：将draft状态球员批量提交为pending
app.post('/api/teams/:teamId/submit-roster', requireAuth, (req, res) => {
  const teamId = +req.params.teamId;
  const isAdmin = req.session.user.role === 'admin';
  if (!isAdmin && req.session.user.team_id !== teamId) {
    return res.status(403).json({ error: '无权操作其他球队' });
  }
  if (!isAdmin && teamHasLiveMatch(teamId)) {
    return res.status(400).json({ error: '本队有进行中的比赛，不能修改名单' });
  }
  // 查询该队所有draft球员
  const draftPlayers = db.prepare("SELECT * FROM players WHERE team_id=? AND status='draft'").all(teamId);
  if (draftPlayers.length === 0) {
    return res.status(400).json({ error: '没有待提交的球员' });
  }
  // 校验：非官员球员必须有学生证和安全责任书
  const missing = [];
  for (const p of draftPlayers) {
    const problems = [];
    if (!p.is_official) {
      if (!p.student_card_path) problems.push('学生证');
      if (!p.safety_doc_path) problems.push('安全责任书');
    }
    if (problems.length > 0) {
      missing.push(`${p.name}（缺${problems.join('、')}）`);
    }
  }
  if (missing.length > 0) {
    return res.status(400).json({ error: '以下球员材料未补齐：\n' + missing.join('\n') });
  }
  // 批量更新为pending
  const stmt = db.prepare("UPDATE players SET status='pending', submitted_by=?, reject_reason='', reject_at=NULL WHERE team_id=? AND status='draft'");
  const result = stmt.run(isAdmin ? null : req.session.user.id, teamId);
  logOperation(req, 'submit_roster', 'team', teamId, { count: result.changes });
  broadcastUpdate('players', {});
  res.json({ ok: true, submitted: result.changes, message: `已提交${result.changes}名球员，等待管理员审批` });
});

// ========== 裁判 ==========
app.get('/api/referees', (req, res) => {
  const list = db.prepare(`SELECT r.*, u.username as account, u.locked_until, u.must_change_password
    FROM referees r LEFT JOIN users u ON r.user_id=u.id WHERE r.deleted_at IS NULL ORDER BY r.serial_number`).all();
  res.json(list);
});

// 公平竞赛承诺书模板下载
app.get('/api/referees/fair-play-template', (req, res) => {
  const tplPath = path.join(__dirname, 'public', 'uploads', 'templates', 'fair_play_commitment_template.docx');
  if (!fs.existsSync(tplPath)) return res.status(404).json({ error: '模板文件不存在' });
  res.download(tplPath, '校园足球赛事裁判及工作人员公平竞赛承诺书.docx');
});

// 公平竞赛承诺书图片上传（管理员添加/编辑裁判时）
app.post('/api/referees/fair-play', requireAdmin, fairPlayUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  res.json({ path: '/uploads/fair_play/' + req.file.filename });
});

app.post('/api/referees', requireAdmin, (req, res) => {
  const r = req.body;
  const lenErr = checkLen(r.name, MAX_LEN.referee_name, '裁判姓名')
    || checkLen(r.college, MAX_LEN.referee_college, '所在学院')
    || checkLen(r.level, MAX_LEN.referee_level, '裁判等级')
    || checkLen(r.phone, MAX_LEN.phone, '联系电话');
  if (lenErr) return res.status(400).json({ error: lenErr });
  if (r.phone && !/^\d{11}$/.test(String(r.phone).trim())) return res.status(400).json({ error: '联系电话必须为11位数字' });
  if (!r.name) return res.status(400).json({ error: '裁判姓名不能为空' });
  const serial = String(r.serial_number || '').trim();
  if (!serial) return res.status(400).json({ error: '裁判编号不能为空' });
  const dupSerial = db.prepare('SELECT id FROM referees WHERE serial_number=? AND deleted_at IS NULL').get(serial);
  if (dupSerial) return res.status(400).json({ error: `裁判编号“${serial}”已存在，编号不能重复` });
  // 专职岗位（可选；空=通用裁判，可担任所有位置）
  const refType = String(r.ref_type || '').trim();
  if (refType && !['main', 'assistant', 'fourth'].includes(refType)) {
    return res.status(400).json({ error: '专职岗位只能是：专职主裁判/专职助理裁判/专职第四官员，或留空表示通用' });
  }
  // 公平竞赛承诺书（必传，图片路径）
  const fairPlayPath = String(r.fair_play_path || '').trim();
  if (!fairPlayPath) return res.status(400).json({ error: '请上传已签署的公平竞赛承诺书图片' });
  const isMain = refType === 'main' ? 1 : 0;
  const isAssistant = refType === 'assistant' ? 1 : 0;

  // 自动生成专属登录账号
  const username = generateRefereeUsername();
  const password = generateRandomPassword();
  const userResult = db.prepare('INSERT INTO users (username, password, role, display_name, must_change_password, created_at) VALUES (?,?,?,?,1,?)')
    .run(username, bcrypt.hashSync(password, 10), 'referee', r.name, BJ());
  const userId = userResult.lastInsertRowid;

  const result = db.prepare(`INSERT INTO referees (serial_number,name,college,student_id,phone,level,is_main_ref,is_assistant_ref,ref_type,fair_play_path,user_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    serial, r.name, r.college||'', r.student_id||'', r.phone||'', r.level||'',
    isMain, isAssistant, refType, fairPlayPath, userId, BJ()
  );
  broadcastUpdate('referees', {});
  logOperation(req, 'add_referee', 'referee', result.lastInsertRowid, { name: r.name, username, ref_type: refType });
  res.json({ id: result.lastInsertRowid, username, password });
});

// 裁判证：管理员或裁判本人可查看（同款参赛证样式，字段换成裁判信息）
// ========== 裁判评分 ==========
const RATING_WINDOW_HOURS = 48;
const RATING_DIMS = [
  { key: 'score_accuracy', label: '判罚准确性' },
  { key: 'score_control', label: '控场能力' },
  { key: 'score_position', label: '选位跑动' },
  { key: 'score_communication', label: '沟通态度' },
  { key: 'score_rules', label: '规则掌握' }
];
const RATING_SLOTS = [
  { field: 'main_referee_id', label: '主裁判' },
  { field: 'assistant_ref1_id', label: '第一助理裁判' },
  { field: 'assistant_ref2_id', label: '第二助理裁判' },
  { field: 'fourth_official_id', label: '第四官员' }
];
function matchRefereeSlots(match) {
  return RATING_SLOTS.map(s => ({ field: s.field, label: s.label, referee_id: match[s.field] })).filter(s => s.referee_id);
}
// 评分窗口（finished_at 为北京时间字符串）
function ratingWindow(match) {
  if (!match.finished_at) return { open: false, closesAt: null };
  const closes = new Date(match.finished_at.replace(' ', 'T') + '+08:00').getTime() + RATING_WINDOW_HOURS * 3600 * 1000;
  return { open: Date.now() <= closes, closesAt: closes };
}
function teamRosterCount(teamId) {
  return db.prepare("SELECT COUNT(*) c FROM players WHERE team_id=? AND deleted_at IS NULL AND withdrawn_at IS NULL AND COALESCE(is_official,0)=0 AND status='approved'").get(teamId).c;
}
function teamRatedCount(matchId, teamId) {
  return db.prepare("SELECT COUNT(DISTINCT rater_player_id) c FROM referee_ratings WHERE match_id=? AND rater_team_id=? AND rater_player_id IS NOT NULL").get(matchId, teamId).c;
}

// 球队：本队已完赛比赛的评分状态
app.get('/api/ratings/team-list', requireAuth, (req, res) => {
  const u = req.session.user;
  if (u.role !== 'viewer' || !u.team_id) return res.json([]);
  const matches = db.prepare("SELECT * FROM matches WHERE status='finished' AND (team1_id=? OR team2_id=?) ORDER BY finished_at DESC").all(u.team_id, u.team_id);
  const out = matches.map(m => {
    const w = ratingWindow(m);
    const token = db.prepare("SELECT token FROM rating_tokens WHERE match_id=? AND team_id=? AND revoked=0 ORDER BY created_at DESC LIMIT 1").get(m.id, u.team_id);
    return {
      match_id: m.id, match_number: m.match_number, gender: m.gender,
      team1_id: m.team1_id, team2_id: m.team2_id, finished_at: m.finished_at,
      window_open: w.open, closes_at: w.closesAt,
      token: token ? token.token : null,
      rated_count: teamRatedCount(m.id, u.team_id),
      roster_count: teamRosterCount(u.team_id)
    };
  });
  res.json(out);
});

// 球队：生成/获取评分链接 token
app.post('/api/matches/:id/ratings/token', requireAuth, async (req, res) => {
  const u = req.session.user;
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '比赛不存在' });
  if (u.role !== 'viewer' || !u.team_id || (m.team1_id !== u.team_id && m.team2_id !== u.team_id))
    return res.status(403).json({ error: '仅参赛球队可生成评分链接' });
  if (m.status !== 'finished' || !m.finished_at) return res.status(400).json({ error: '比赛结束后才可生成评分链接' });
  const w = ratingWindow(m);
  if (!w.open) return res.status(400).json({ error: '评分窗口已关闭（赛后48小时）' });
  let existing = db.prepare("SELECT * FROM rating_tokens WHERE match_id=? AND team_id=? AND revoked=0 ORDER BY created_at DESC LIMIT 1").get(m.id, u.team_id);
  if (!existing) {
    const token = require('crypto').randomUUID().replace(/-/g, '');
    const closesStr = new Date(w.closesAt + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare('INSERT INTO rating_tokens (token,match_id,team_id,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?)')
      .run(token, m.id, u.team_id, u.id, BJ(), closesStr);
    existing = { token };
    logOperation(req, 'create_rating_token', 'match', m.id, {});
  }
  const fullUrl = `${req.protocol}://${req.get('host')}/rate.html?token=${existing.token}`;
  let qr = '';
  try { qr = await QRCode.toDataURL(fullUrl, { width: 340, margin: 1 }); } catch (e) {}
  res.json({ ok: true, token: existing.token, url: `/rate.html?token=${existing.token}`, full_url: fullUrl, qr, closes_at: w.closesAt,
    rated_count: teamRatedCount(m.id, u.team_id), roster_count: teamRosterCount(u.team_id) });
});

// 管理员：全部评分明细
app.get('/api/admin/referee-ratings', requireAdmin, (req, res) => {
  const { referee_id, match_id } = req.query;
  let sql = `SELECT r.*, rf.name referee_name, t.name team_name, p.name rater_name, p.jersey_number,
    m.match_number, m.gender, m.team1_id, m.team2_id
    FROM referee_ratings r
    JOIN referees rf ON r.referee_id=rf.id
    JOIN teams t ON r.rater_team_id=t.id
    LEFT JOIN players p ON r.rater_player_id=p.id
    JOIN matches m ON r.match_id=m.id WHERE 1=1`;
  const args = [];
  if (referee_id) { sql += ' AND r.referee_id=?'; args.push(referee_id); }
  if (match_id) { sql += ' AND r.match_id=?'; args.push(match_id); }
  sql += ' ORDER BY r.created_at DESC';
  res.json(db.prepare(sql).all(...args));
});

// 管理员：各裁判汇总
app.get('/api/admin/referee-ratings/summary', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT r.referee_id, rf.name referee_name, rf.level referee_level,
    COUNT(*) rating_count,
    COUNT(DISTINCT r.match_id) match_count,
    ROUND(AVG(r.total_score),2) avg_total,
    ROUND(AVG(r.score_accuracy),2) avg_accuracy,
    ROUND(AVG(r.score_control),2) avg_control,
    ROUND(AVG(r.score_position),2) avg_position,
    ROUND(AVG(r.score_communication),2) avg_communication,
    ROUND(AVG(r.score_rules),2) avg_rules
    FROM referee_ratings r JOIN referees rf ON r.referee_id=rf.id
    GROUP BY r.referee_id ORDER BY avg_total DESC`).all();
  res.json(rows);
});

// 管理员：导出评分明细 CSV
app.get('/api/admin/referee-ratings/export', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT r.*, rf.name referee_name, t.name team_name, p.name rater_name,
      m.match_number, m.gender,
      (CASE WHEN m.main_referee_id=r.referee_id THEN '主裁判' WHEN m.assistant_ref1_id=r.referee_id THEN '第一助理裁判' WHEN m.assistant_ref2_id=r.referee_id THEN '第二助理裁判' ELSE '第四官员' END) slot_label
    FROM referee_ratings r
    JOIN referees rf ON r.referee_id=rf.id
    JOIN teams t ON r.rater_team_id=t.id
    LEFT JOIN players p ON r.rater_player_id=p.id
    JOIN matches m ON r.match_id=m.id
    ORDER BY m.match_number, rf.name`).all();
  const cell = v => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const head = ['场序','裁判姓名','岗位','评分球队','评分球员','判罚准确性','控场能力','选位跑动','沟通态度','规则掌握','综合分','评语','评分时间'];
  const lines = [head.join(',')];
  rows.forEach(r => {
    const num = r.gender === 'women' ? r.match_number - 100 : r.match_number;
    lines.push([num, r.referee_name, r.slot_label, r.team_name, r.rater_name || '',
      r.score_accuracy, r.score_control, r.score_position, r.score_communication, r.score_rules,
      r.total_score, r.comment, r.created_at].map(cell).join(','));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''referee_ratings.csv");
  res.send('\uFEFF' + lines.join('\r\n'));
});

// 裁判：本人评分（评语匿名，不显示评分球队/球员）
app.get('/api/referee/ratings/me', requireAuth, (req, res) => {
  const u = req.session.user;
  if (u.role !== 'referee') return res.status(403).json({ error: '仅裁判可查看' });
  const rf = db.prepare('SELECT * FROM referees WHERE user_id=?').get(u.id);
  if (!rf) return res.status(404).json({ error: '裁判信息不存在' });
  const ratings = db.prepare('SELECT * FROM referee_ratings WHERE referee_id=?').all(rf.id);
  const avg = (field) => ratings.length ? +(ratings.reduce((s, r) => s + r[field], 0) / ratings.length).toFixed(2) : null;
  const comments = db.prepare(`SELECT r.comment, r.total_score, r.created_at, m.match_date,
      (CASE WHEN m.main_referee_id=? THEN '主裁判' WHEN m.assistant_ref1_id=? THEN '第一助理裁判' WHEN m.assistant_ref2_id=? THEN '第二助理裁判' ELSE '第四官员' END) slot_label
    FROM referee_ratings r JOIN matches m ON r.match_id=m.id
    WHERE r.referee_id=? AND COALESCE(r.comment,'')!='' ORDER BY r.created_at DESC`).all(rf.id, rf.id, rf.id, rf.id);
  res.json({
    referee_name: rf.name,
    rating_count: ratings.length,
    match_count: db.prepare('SELECT COUNT(DISTINCT match_id) c FROM referee_ratings WHERE referee_id=?').get(rf.id).c,
    avg_total: avg('total_score'),
    dims: RATING_DIMS.map(d => ({ label: d.label, avg: avg(d.key) })),
    comments
  });
});

// 免登录：评分页信息
app.get('/api/rating/:token/info', (req, res) => {
  const t = db.prepare('SELECT * FROM rating_tokens WHERE token=? AND revoked=0').get(req.params.token);
  if (!t) return res.status(404).json({ error: '链接无效或已撤销' });
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(t.match_id);
  if (!m) return res.status(404).json({ error: '比赛不存在' });
  const w = ratingWindow(m);
  if (!w.open) return res.status(403).json({ error: '评分已结束（赛后48小时）', closed: true });
  const gicTeamName = id => { const x = db.prepare('SELECT name FROM teams WHERE id=?').get(id); return x ? x.name : ''; };
  const slots = matchRefereeSlots(m).map(s => {
    const rf = db.prepare('SELECT id,name,level FROM referees WHERE id=?').get(s.referee_id);
    return { field: s.field, label: s.label, referee_id: s.referee_id, referee: rf };
  });
  const players = db.prepare(`SELECT id,name,student_id,jersey_number,position FROM players
    WHERE team_id=? AND deleted_at IS NULL AND withdrawn_at IS NULL AND COALESCE(is_official,0)=0 AND status='approved'
    ORDER BY COALESCE(jersey_number,999)`).all(t.team_id);
  const ratedRows = db.prepare('SELECT rater_player_id, referee_id FROM referee_ratings WHERE match_id=? AND rater_team_id=?').all(m.id, t.team_id);
  const rated_map = {};
  ratedRows.forEach(r => { (rated_map[r.rater_player_id] = rated_map[r.rater_player_id] || []).push(r.referee_id); });
  res.json({
    match: { id: m.id, match_number: m.match_number, gender: m.gender, match_date: m.match_date,
      team1_id: m.team1_id, team2_id: m.team2_id,
      team1_name: gicTeamName(m.team1_id), team2_name: gicTeamName(m.team2_id) },
    team: { id: t.team_id, name: gicTeamName(t.team_id) },
    slots, players, dims: RATING_DIMS, rated_map,
    closes_at: w.closesAt
  });
});

// 免登录：提交评分
app.post('/api/rating/:token/submit', (req, res) => {
  const t = db.prepare('SELECT * FROM rating_tokens WHERE token=? AND revoked=0').get(req.params.token);
  if (!t) return res.status(404).json({ error: '链接无效或已撤销' });
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(t.match_id);
  if (!m) return res.status(404).json({ error: '比赛不存在' });
  const w = ratingWindow(m);
  if (!w.open) return res.status(403).json({ error: '评分已结束（赛后48小时）' });
  const { player_id, ratings } = req.body || {};
  if (!player_id) return res.status(400).json({ error: '请先选择本人姓名' });
  const player = db.prepare("SELECT id FROM players WHERE id=? AND team_id=? AND deleted_at IS NULL AND withdrawn_at IS NULL AND status='approved' AND COALESCE(is_official,0)=0").get(player_id, t.team_id);
  if (!player) return res.status(400).json({ error: '评分人不在本队已注册球员名单中' });
  if (!Array.isArray(ratings) || !ratings.length) return res.status(400).json({ error: '未提交任何评分' });
  const validSlots = matchRefereeSlots(m);
  const inserted = [], dup = [], invalid = [];
  for (const r of ratings) {
    const slot = validSlots.find(s => s.referee_id === Number(r.referee_id));
    if (!slot) continue;
    const exist = db.prepare('SELECT id FROM referee_ratings WHERE match_id=? AND referee_id=? AND rater_team_id=? AND rater_player_id=?')
      .get(m.id, r.referee_id, t.team_id, player_id);
    if (exist) { dup.push(slot.label); continue; }
    const vals = [];
    let bad = false;
    for (const d of RATING_DIMS) {
      const v = Number(r[d.key]);
      if (!Number.isInteger(v) || v < 1 || v > 5) { bad = true; break; }
      vals.push(v);
    }
    if (bad) { invalid.push(slot.label); continue; }
    const total = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
    const comment = String(r.comment || '').slice(0, 500);
    db.prepare(`INSERT INTO referee_ratings (match_id,referee_id,rater_team_id,rater_player_id,
      score_accuracy,score_control,score_position,score_communication,score_rules,total_score,comment,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(m.id, r.referee_id, t.team_id, player_id, ...vals, total, comment, BJ());
    inserted.push(slot.label);
  }
  res.json({ ok: true, inserted, dup, invalid });
});

app.get('/api/referees/:id/credential', requireAuth, async (req, res) => {
  try {
    const r = db.prepare('SELECT * FROM referees WHERE id=? AND deleted_at IS NULL').get(req.params.id);
    if (!r) return res.status(404).json({ error: '裁判不存在' });
    const isAdminUser = req.session.user.role === 'admin';
    const isSelf = req.session.user.role === 'referee' && r.user_id === req.session.user.id;
    if (!isAdminUser && !isSelf) return res.status(403).json({ error: '无权查看该裁判证' });
    if (!r.photo_path) return res.status(400).json({ error: '该裁判缺少证件照，无法生成裁判证' });
    const code = makeRefereeCode(r.id);
    const qrDataUrl = await QRCode.toDataURL(code, { width: 320, margin: 1 });
    const refTypeLabel = r.ref_type === 'main' ? '专职主裁判' : r.ref_type === 'assistant' ? '专职助理裁判' : r.ref_type === 'fourth' ? '专职第四官员' : '通用裁判';
    res.json({
      referee: {
        id: r.id, name: r.name, college: r.college || '', student_id: r.student_id || '',
        phone: r.phone || '', level: r.level || '', ref_type: r.ref_type || '',
        ref_type_label: refTypeLabel, serial_number: r.serial_number, photo_path: r.photo_path || ''
      },
      code, qrText: code, qrDataUrl
    });
  } catch (e) {
    console.error('referee credential error', e);
    res.status(500).json({ error: '生成裁判证失败' });
  }
});

app.put('/api/referees/:id', requireAdmin, (req, res) => {
  const r = req.body;
  const existing = db.prepare('SELECT * FROM referees WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '裁判不存在' });
  const serial = String(r.serial_number || '').trim();
  if (!serial) return res.status(400).json({ error: '裁判编号不能为空' });
  const dupSerial = db.prepare('SELECT id FROM referees WHERE serial_number=? AND deleted_at IS NULL AND id<>?').get(serial, req.params.id);
  if (dupSerial) return res.status(400).json({ error: `裁判编号“${serial}”已被其他裁判占用` });
  if (r.phone && !/^\d{11}$/.test(String(r.phone).trim())) return res.status(400).json({ error: '联系电话必须为11位数字' });
  const refType = String(r.ref_type || '').trim();
  if (refType && !['main', 'assistant', 'fourth'].includes(refType)) {
    return res.status(400).json({ error: '专职岗位只能是：专职主裁判/专职助理裁判/专职第四官员，或留空表示通用' });
  }
  const isMain = refType === 'main' ? 1 : 0;
  const isAssistant = refType === 'assistant' ? 1 : 0;
  // 编辑时若新上传了承诺书则覆盖，否则保留原文件
  const fairPlayPath = String(r.fair_play_path || '').trim() || existing.fair_play_path || '';
  if (!fairPlayPath) return res.status(400).json({ error: '公平竞赛承诺书缺失，请上传已签署的图片' });
  db.prepare(`UPDATE referees SET serial_number=?,name=?,college=?,student_id=?,phone=?,level=?,is_main_ref=?,is_assistant_ref=?,ref_type=?,fair_play_path=? WHERE id=?`).run(
    serial, r.name, r.college||'', r.student_id||'', r.phone||'', r.level||'',
    isMain, isAssistant, refType, fairPlayPath, req.params.id
  );
  // 同步账号显示名称
  if (existing.user_id) {
    db.prepare('UPDATE users SET display_name=? WHERE id=?').run(r.name, existing.user_id);
  }
  broadcastUpdate('referees', {});
  logOperation(req, 'update_referee', 'referee', req.params.id, {
    before: { name: existing.name, serial_number: existing.serial_number, ref_type: existing.ref_type || '' },
    after: { name: r.name, serial_number: serial, ref_type: refType }
  });
  res.json({ ok: true });
});

app.delete('/api/referees/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM referees WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '裁判不存在' });
  // D14 软删除：移入回收站，保留账号与历史执法记录，登录时将被拦截；彻底删除在回收站执行
  db.prepare('UPDATE referees SET deleted_at=? WHERE id=?').run(BJ(), req.params.id);
  broadcastUpdate('referees', {});
  logOperation(req, 'delete_referee', 'referee', req.params.id, { name: existing.name, soft: true });
  res.json({ ok: true });
});

// ========== D14 回收站 ==========
// 回收站列表（仅管理员）：type=team/player/referee
// 物理删除球员前清理带外键/运营性子表（match_checkins.player_id 有外键 RESTRICT，不先删会导致整笔删除500）
// 历史性质的 match_events/suspensions 不删（其 player_id 无外键，保留完赛记录，前端LEFT JOIN容错）
function purgePlayerOperational(playerId) {
  db.prepare('DELETE FROM match_checkins WHERE player_id=?').run(playerId);
  db.prepare('DELETE FROM match_lineups WHERE player_id=?').run(playerId);
}

app.get('/api/recycle-bin', requireAdmin, (req, res) => {
  const teams = db.prepare(`SELECT id, name, college, deleted_at FROM teams WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`).all();
  const players = db.prepare(`SELECT p.id, p.name, p.jersey_number, p.team_id, t.name as team_name, p.deleted_at
    FROM players p LEFT JOIN teams t ON p.team_id=t.id WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC`).all();
  const referees = db.prepare(`SELECT id, name, serial_number, level, deleted_at FROM referees WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`).all();
  res.json({ teams, players, referees });
});

// 恢复
app.post('/api/recycle-bin/:type/:id/restore', requireAdmin, (req, res) => {
  const { type, id } = req.params;
  const table = { team: 'teams', player: 'players', referee: 'referees' }[type];
  if (!table) return res.status(400).json({ error: '类型无效' });
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  if (row.deleted_at === null) return res.status(400).json({ error: '该记录不在回收站' });
  // 恢复球员：若所属球队仍在回收站，需先恢复球队
  if (type === 'player') {
    const t = db.prepare('SELECT deleted_at FROM teams WHERE id=?').get(row.team_id);
    if (t && t.deleted_at) return res.status(400).json({ error: '该球员所属球队也在回收站，请先恢复球队' });
  }
  db.prepare(`UPDATE ${table} SET deleted_at=NULL WHERE id=?`).run(id);
  broadcastUpdate(type === 'team' ? 'teams' : type === 'player' ? 'players' : 'referees', {});
  logOperation(req, 'restore_' + type, table, id, {});
  res.json({ ok: true });
});

// 彻底删除（不可恢复）
app.delete('/api/recycle-bin/:type/:id', requireAdmin, (req, res) => {
  const { type, id } = req.params;
  if (type === 'team') {
    const row = db.prepare('SELECT * FROM teams WHERE id=? AND deleted_at IS NOT NULL').get(id);
    if (!row) return res.status(404).json({ error: '回收站中无此球队' });
    // 队下还有未删除球员则拒绝
    const left = db.prepare('SELECT COUNT(*) c FROM players WHERE team_id=? AND deleted_at IS NULL').get(id).c;
    if (left) return res.status(400).json({ error: `该队下还有${left}名球员，请先处理` });
    // 连带物理删除已软删球员（先清带外键的运营子表，避免 FOREIGN KEY 约束失败）
    const softPlayers = db.prepare('SELECT id FROM players WHERE team_id=?').all(id);
    softPlayers.forEach(sp => purgePlayerOperational(sp.id));
    db.prepare('DELETE FROM players WHERE team_id=?').run(id);
    db.prepare('DELETE FROM teams WHERE id=?').run(id);
  } else if (type === 'player') {
    const row = db.prepare('SELECT * FROM players WHERE id=? AND deleted_at IS NOT NULL').get(id);
    if (!row) return res.status(404).json({ error: '回收站中无此球员' });
    purgePlayerOperational(id);
    db.prepare('DELETE FROM players WHERE id=?').run(id);
  } else if (type === 'referee') {
    const row = db.prepare('SELECT * FROM referees WHERE id=? AND deleted_at IS NOT NULL').get(id);
    if (!row) return res.status(404).json({ error: '回收站中无此裁判' });
    if (row.user_id) {
      db.prepare('DELETE FROM messages WHERE receiver_id=?').run(row.user_id);
      db.prepare('DELETE FROM users WHERE id=?').run(row.user_id);
    }
    db.prepare('DELETE FROM referees WHERE id=?').run(id);
  } else return res.status(400).json({ error: '类型无效' });
  broadcastUpdate(type === 'team' ? 'teams' : type === 'player' ? 'players' : 'referees', {});
  logOperation(req, 'purge_' + type, type, id, {});
  res.json({ ok: true });
});

// D14 管理员软删除球队（有未结束比赛时拒绝）
app.delete('/api/teams/:id', requireAdmin, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id=?').get(req.params.id);
  if (!team) return res.status(404).json({ error: '球队不存在' });
  const live = db.prepare("SELECT COUNT(*) c FROM matches WHERE (team1_id=? OR team2_id=?) AND status!='finished'").get(req.params.id, req.params.id).c;
  if (live) return res.status(400).json({ error: '该球队还有未结束的比赛，不能删除' });
  db.prepare('UPDATE teams SET deleted_at=? WHERE id=?').run(BJ(), req.params.id);
  broadcastUpdate('teams', {});
  logOperation(req, 'delete_team', 'team', req.params.id, { name: team.name, soft: true });
  res.json({ ok: true });
});

// ========== 比赛 ==========
function getMatchWithDetails(id) {
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(id);
  if (!match) return null;
  if (match.team1_id != null) match.team1 = db.prepare('SELECT * FROM teams WHERE id=?').get(match.team1_id);
  if (match.team2_id != null) match.team2 = db.prepare('SELECT * FROM teams WHERE id=?').get(match.team2_id);
  if (match.main_referee_id) match.main_referee = db.prepare('SELECT * FROM referees WHERE id=?').get(match.main_referee_id);
  if (match.assistant_ref1_id) match.assistant_ref1 = db.prepare('SELECT * FROM referees WHERE id=?').get(match.assistant_ref1_id);
  if (match.assistant_ref2_id) match.assistant_ref2 = db.prepare('SELECT * FROM referees WHERE id=?').get(match.assistant_ref2_id);
  if (match.fourth_official_id) match.fourth_official = db.prepare('SELECT * FROM referees WHERE id=?').get(match.fourth_official_id);

  match.events = db.prepare(`SELECT e.*, t.name as team_name, p.name as player_name, p.jersey_number,
    p2.name as sub_in_name, p2.jersey_number as sub_in_number FROM match_events e
    LEFT JOIN teams t ON e.team_id=t.id LEFT JOIN players p ON e.player_id=p.id
    LEFT JOIN players p2 ON e.sub_in_player_id=p2.id
    WHERE e.match_id=? ORDER BY e.minute, e.id`).all(id);
  match.penalties = db.prepare(`SELECT ps.*, t.name as team_name, p.name as player_name, p.jersey_number
    FROM penalty_shootout ps LEFT JOIN teams t ON ps.team_id=t.id LEFT JOIN players p ON ps.player_id=p.id
    WHERE ps.match_id=? ORDER BY ps.round_number, ps.id`).all(id);
  match.lineups = db.prepare(`SELECT ml.*, p.name, p.jersey_number, p.position FROM match_lineups ml
    JOIN players p ON ml.player_id=p.id WHERE ml.match_id=? ORDER BY ml.team_id, ml.is_starter DESC, p.jersey_number`).all(id);
  if (match.mvp_player_id) match.mvp_player = db.prepare('SELECT id, name, jersey_number, team_id FROM players WHERE id=?').get(match.mvp_player_id);
  // B7 执法确认状态（裁判id→状态）
  match.ref_confirms = db.prepare('SELECT referee_id,status,note,updated_at FROM match_ref_confirm WHERE match_id=?').all(id);

  return match;
}

app.get('/api/matches', (req, res) => {
  let sql = 'SELECT * FROM matches';
  const params = [];
  if (req.query.gender === 'men' || req.query.gender === 'women') { sql += ' WHERE gender=?'; params.push(req.query.gender); }
  sql += ' ORDER BY match_number';
  const matches = db.prepare(sql).all(...params);
  matches.forEach(m => {
    if (m.team1_id != null) m.team1 = db.prepare('SELECT id,name,logo_path FROM teams WHERE id=?').get(m.team1_id);
    if (m.team2_id != null) m.team2 = db.prepare('SELECT id,name,logo_path FROM teams WHERE id=?').get(m.team2_id);
  });
  res.json(matches);
});

// 精彩镜头：获取所有照片（首页展示）- 必须在 /api/matches/:id 之前
app.get('/api/matches/photos', (req, res) => {
  const photos = db.prepare(`
    SELECT mp.*, m.match_number, m.gender, m.round_name, t1.name as team1_name, t2.name as team2_name
    FROM match_photos mp
    LEFT JOIN matches m ON mp.match_id = m.id
    LEFT JOIN teams t1 ON m.team1_id = t1.id
    LEFT JOIN teams t2 ON m.team2_id = t2.id
    ORDER BY mp.created_at DESC
    LIMIT 50
  `).all();
  res.json(photos);
});

app.get('/api/matches/:id', (req, res) => {
  const match = getMatchWithDetails(req.params.id);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  res.json(match);
});

app.put('/api/matches/:id/basic', requireAdmin, checkMatchNotLocked, (req, res) => {
  let { match_date, match_time, match_location, main_referee_id, assistant_ref1_id, assistant_ref2_id, fourth_official_id, status, notes } = req.body;

  // 女子组只设 主裁判+助理裁判1+助理裁判2，不设第四官员
  const _gm = db.prepare('SELECT gender FROM matches WHERE id=?').get(req.params.id);
  if (_gm && _gm.gender === 'women') {
    if (req.body.fourth_official_id) {
      return res.status(400).json({ error: '女子组比赛不设第四官员' });
    }
    fourth_official_id = null;
  }

// 验证裁判专职岗位规则（专职主裁只能当主裁、专职助理只能当助理、专职第四官员只能当第四官员）
  const specOf = (r) => {
    if (!r) return '';
    if (r.ref_type) return r.ref_type;
    if (r.is_main_ref) return 'main';
    if (r.is_assistant_ref) return 'assistant';
    return '';
  };
  if (main_referee_id) {
    const s = specOf(db.prepare('SELECT * FROM referees WHERE id=?').get(main_referee_id));
    if (s && s !== 'main') return res.status(400).json({ error: '只有“专职主裁判”可以担任主裁判' });
  }
  if (assistant_ref1_id) {
    const s = specOf(db.prepare('SELECT * FROM referees WHERE id=?').get(assistant_ref1_id));
    if (s && s !== 'assistant') return res.status(400).json({ error: '只有“专职助理裁判”可以担任助理裁判' });
  }
  if (assistant_ref2_id) {
    const s = specOf(db.prepare('SELECT * FROM referees WHERE id=?').get(assistant_ref2_id));
    if (s && s !== 'assistant') return res.status(400).json({ error: '只有“专职助理裁判”可以担任助理裁判' });
  }
  if (fourth_official_id) {
    const s = specOf(db.prepare('SELECT * FROM referees WHERE id=?').get(fourth_official_id));
    if (s && s !== 'fourth') return res.status(400).json({ error: '只有“专职第四官员”可以担任第四官员' });
  }

  // 验证裁判不重复（含第四官员）
  const refIds = [main_referee_id, assistant_ref1_id, assistant_ref2_id, fourth_official_id].filter(Boolean).map(Number);
  if (new Set(refIds).size !== refIds.length) {
    return res.status(400).json({ error: '同一名裁判不能在同一场比赛中担任多个职位' });
  }

  // A1 同一裁判跨场时间冲突：同一天开球间隔不足120分钟视为无法兼顾
  if (match_date && match_time && refIds.length) {
    const curMin = timeToMin(match_time);
    if (curMin !== null) {
      const roleCols = ['main_referee_id', 'assistant_ref1_id', 'assistant_ref2_id', 'fourth_official_id'];
      const others = db.prepare(`SELECT id,match_number,match_time,${roleCols.join(',')} FROM matches WHERE match_date=? AND id!=? AND match_time IS NOT NULL AND match_time!=''`).all(match_date, req.params.id);
      for (const rid of refIds) {
        for (const om of others) {
          if (!roleCols.some(c => Number(om[c]) === rid)) continue;
          const omMin = timeToMin(om.match_time);
          if (omMin !== null && Math.abs(curMin - omMin) < 120) {
            const ref = db.prepare('SELECT name FROM referees WHERE id=?').get(rid);
            return res.status(400).json({ error: `裁判时间冲突：${ref?.name || '该裁判'} 在 ${match_date} ${om.match_time} 已被指派执法场序${om.match_number}，两场间隔不足2小时，无法兼顾` });
          }
        }
      }
    }
  }

  // 场地与时间冲突检测
  const curMatch = db.prepare('SELECT team1_id, team2_id FROM matches WHERE id=?').get(req.params.id);
  if (match_date && match_time && match_location) {
    // 1. 同一场地同一时间段冲突（时间差<15分钟视为冲突）
    const venueConflicts = db.prepare(`
      SELECT id, match_number, match_time FROM matches 
      WHERE match_date=? AND match_location=? AND id!=? AND match_time IS NOT NULL AND match_time!=''
    `).all(match_date, match_location, req.params.id);
    const curMin = parseInt(match_time.split(':')[0]) * 60 + parseInt(match_time.split(':')[1] || 0);
    for (const m of venueConflicts) {
      const mMin = parseInt(m.match_time.split(':')[0]) * 60 + parseInt(m.match_time.split(':')[1] || 0);
      if (Math.abs(curMin - mMin) < 15) {
        return res.status(400).json({ error: `场地冲突：场序${m.match_number} 也在 ${match_date} ${m.match_time} 使用 ${match_location}，两场时间间隔不足15分钟` });
      }
    }
    // 2. 同一球队同一天多场比赛冲突
    if (curMatch) {
      const teamIds = [curMatch.team1_id, curMatch.team2_id].filter(Boolean);
      for (const tid of teamIds) {
        const teamConflict = db.prepare(`
          SELECT m.id, m.match_number, m.match_time, t.name as team_name
          FROM matches m JOIN teams t ON (t.id=m.team1_id OR t.id=m.team2_id)
          WHERE m.match_date=? AND m.id!=? AND (m.team1_id=? OR m.team2_id=?) AND m.match_time IS NOT NULL AND m.match_time!=''
          LIMIT 1
        `).get(match_date, req.params.id, tid, tid);
        if (teamConflict) {
          return res.status(400).json({ error: `球队冲突：${teamConflict.team_name} 在 ${match_date} 已有比赛（场序${teamConflict.match_number} ${teamConflict.match_time}），同一天不能安排多场比赛` });
        }
      }
    }
  }

  // 更新前记录原裁判指派，用于比对新增指派并发送通知
  const oldAssign = db.prepare('SELECT main_referee_id,assistant_ref1_id,assistant_ref2_id,fourth_official_id,match_date,match_time,match_location,status FROM matches WHERE id=?').get(req.params.id);

  db.prepare(`UPDATE matches SET match_date=?, match_time=?, match_location=?, main_referee_id=?, assistant_ref1_id=?, assistant_ref2_id=?, fourth_official_id=?, status=?, notes=? WHERE id=?`)
    .run(match_date||'', match_time||'', match_location||'三期操场', main_referee_id||null, assistant_ref1_id||null, assistant_ref2_id||null, fourth_official_id||null, status||'pending', notes||'', req.params.id);
  // B7 同步执法确认记录：为在岗裁判建 pending，移除已撤岗裁判
  syncMatchConfirm(req.params.id, [main_referee_id, assistant_ref1_id, assistant_ref2_id, fourth_official_id].map(Number).filter(Boolean));
  broadcastUpdate('matches', {});
  logOperation(req, 'update_match_basic', 'match', req.params.id, {
    before: oldAssign,
    after: { main_referee_id: main_referee_id || null, assistant_ref1_id: assistant_ref1_id || null, assistant_ref2_id: assistant_ref2_id || null, fourth_official_id: fourth_official_id || null, match_date: match_date || '', match_time: match_time || '', match_location: match_location || '', status: status || 'pending' }
  });

// 向"新被指派"的裁判发送执法通知（主裁/助理/第四官员）
  const newAssign = { main_referee_id: main_referee_id?+main_referee_id:null, assistant_ref1_id: assistant_ref1_id?+assistant_ref1_id:null, assistant_ref2_id: assistant_ref2_id?+assistant_ref2_id:null, fourth_official_id: fourth_official_id?+fourth_official_id:null };
  const roleNameMap = { main_referee_id: '主裁判', assistant_ref1_id: '助理裁判1', assistant_ref2_id: '助理裁判2', fourth_official_id: '第四官员' };
  const oldIds = oldAssign ? [oldAssign.main_referee_id, oldAssign.assistant_ref1_id, oldAssign.assistant_ref2_id, oldAssign.fourth_official_id].filter(Boolean) : [];
  const notifyMatch = db.prepare('SELECT * FROM matches WHERE id=?').get(req.params.id);
  const nt1 = notifyMatch.team1_id ? db.prepare('SELECT name FROM teams WHERE id=?').get(notifyMatch.team1_id)?.name : '';
  const nt2 = notifyMatch.team2_id ? db.prepare('SELECT name FROM teams WHERE id=?').get(notifyMatch.team2_id)?.name : '';
  Object.keys(roleNameMap).forEach(key => {
    const rid = newAssign[key];
    if (rid && !oldIds.includes(rid)) {
      const uid = getRefereeUserId(rid);
      if (uid) {
        sendMessage(uid, {
          title: '您有新的执法任务',
          content: `您被指派为 场序${notifyMatch.match_number}（${notifyMatch.round_name||''}）${nt1||'待定'} vs ${nt2||'待定'} 的${roleNameMap[key]}。比赛时间：${notifyMatch.match_date||'待定'} ${notifyMatch.match_time||''}，地点：${notifyMatch.match_location||'三期操场'}。开赛前系统将再次提醒您。`,
          type: 'referee_assign', relatedType: 'match', relatedId: notifyMatch.id
        });
      }
    }
  });
  // 发送消息给对阵双方球队的访客
  const updatedMatch = db.prepare('SELECT * FROM matches WHERE id=?').get(req.params.id);
  if (updatedMatch && updatedMatch.team1_id && updatedMatch.team2_id) {
    const t1 = db.prepare('SELECT name FROM teams WHERE id=?').get(updatedMatch.team1_id);
    const t2 = db.prepare('SELECT name FROM teams WHERE id=?').get(updatedMatch.team2_id);
    const timeStr = updatedMatch.match_date && updatedMatch.match_time ? `${updatedMatch.match_date} ${updatedMatch.match_time}` : '待定';
    const title = `比赛信息已更新`;
    const content = `场序${updatedMatch.match_number} ${t1?.name || ''} vs ${t2?.name || ''} 的比赛信息已更新：时间：${timeStr}，地点：${updatedMatch.match_location || '三期操场'}，状态：${updatedMatch.status === 'live' ? '进行中' : updatedMatch.status === 'finished' ? '已结束' : '未开始'}。`;
    sendMessageToTeam(updatedMatch.team1_id, { title, content, type: 'match_update', relatedType: 'match', relatedId: updatedMatch.id });
    sendMessageToTeam(updatedMatch.team2_id, { title, content, type: 'match_update', relatedType: 'match', relatedId: updatedMatch.id });
  }
  // 软提醒（不拦截）：同学院回避等，回传给前端提示
  const warnings = [];
  try {
    const rec = buildRefRecommend(updatedMatch);
    const slotOf = { main: 'main_referee_id', assistant1: 'assistant_ref1_id', assistant2: 'assistant_ref2_id', fourth: 'fourth_official_id' };
    for (const slot of Object.keys(slotOf)) {
      const rid = updatedMatch[slotOf[slot]];
      if (!rid) continue;
      const cand = (rec.slots[slot] || []).find(c => c.id === +rid);
      if (cand && cand.warns && cand.warns.length) {
        warnings.push(`${SLOT_LABEL[slot]} ${cand.name}：${cand.warns.join('；')}`);
      }
    }
  } catch (e) { /* 提醒失败不影响保存 */ }
  res.json({ ok: true, warnings });
});

// 获取比赛签到列表
app.get('/api/matches/:id/checkins', requireAuth, (req, res) => {
  const checkins = db.prepare(`
    SELECT c.id, c.match_id, c.player_id, c.status, c.check_in_time,
           p.name, p.jersey_number, p.team_id, t.name as team_name
    FROM match_checkins c
    JOIN players p ON p.id = c.player_id
    JOIN teams t ON t.id = p.team_id
    WHERE c.match_id = ?
    ORDER BY p.team_id, p.jersey_number
  `).all(req.params.id);
  res.json(checkins);
});

// 球员签到/取消签到
app.post('/api/matches/:id/checkin', requireAuth, checkMatchNotLocked, (req, res) => {
  const { player_id, status } = req.body;
  if (!player_id) return res.status(400).json({ error: '缺少球员ID' });
  const match = db.prepare('SELECT id, status, team1_id, team2_id FROM matches WHERE id=?').get(req.params.id);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  if (match.status === 'finished') return res.status(400).json({ error: '比赛已结束，无法签到' });
  const s = status === 'absent' ? 'absent' : 'checked_in';
  const player = db.prepare('SELECT id, team_id, status, is_official FROM players WHERE id=? AND deleted_at IS NULL').get(player_id);
  if (!player) return res.status(404).json({ error: '球员不存在' });
  // 仅本场对阵双方的球员可检录，防止误扫/误选到其他比赛
  if (player.team_id !== match.team1_id && player.team_id !== match.team2_id) {
    return res.status(400).json({ error: '该球员不属于本场比赛的参赛队，无法检录' });
  }
  // 未通过审批的球员不能检录
  if (player.status !== 'approved') return res.status(400).json({ error: '该球员尚未通过审批，不能检录' });
  // 停赛球员（剩余停赛场次>0）不允许检录（仍可标记缺阵）
  const susp = playerActiveSuspension(player.id);
  if (susp && s !== 'absent') {
    return res.status(400).json({ error: `该球员处于停赛期（剩余${susp.remaining_count ?? susp.match_count}场：${susp.reason||'纪律停赛'}），不能检录` });
  }
  // 权限：管理员可操作所有球员；访客只能操作本队球员
  if (req.session.user.role !== 'admin') {
    if (req.session.user.team_id !== player.team_id) return res.status(403).json({ error: '只能为本队球员签到' });
  }
  const existing = db.prepare('SELECT id FROM match_checkins WHERE match_id=? AND player_id=?').get(req.params.id, player_id);
  if (existing) {
    db.prepare('UPDATE match_checkins SET status=?, check_in_time=?, operator_id=? WHERE id=?')
      .run(s, BJ(), req.session.user.id, existing.id);
  } else {
    db.prepare('INSERT INTO match_checkins (match_id, player_id, status, operator_id, check_in_time) VALUES (?,?,?,?,?)')
      .run(req.params.id, player_id, s, req.session.user.id, BJ());
  }
  broadcastUpdate('matches', {});
  logOperation(req, 'checkin', 'match', req.params.id, { player_id, status: s });
  res.json({ ok: true, status: s });
});

// 阵容
app.post('/api/matches/:id/lineup', requireAuth, checkMatchNotLocked, (req, res) => {
  const { team_id, player_ids } = req.body;
  // 权限：管理员可操作所有球队；访客只能操作本队阵容
  if (req.session.user.role === 'viewer' && req.session.user.team_id !== team_id) {
    return res.status(403).json({ error: '只能提交本队阵容' });
  }
  // 校验球员属于该球队
  for (const p of player_ids) {
    const player = db.prepare('SELECT team_id FROM players WHERE id=?').get(p.player_id);
    if (!player || player.team_id !== team_id) {
      return res.status(400).json({ error: '球员不属于该球队' });
    }
  }
  db.prepare('DELETE FROM match_lineups WHERE match_id=? AND team_id=?').run(req.params.id, team_id);
  const insert = db.prepare('INSERT INTO match_lineups (match_id, team_id, player_id, is_starter, created_at) VALUES (?,?,?,?,?)');
  player_ids.forEach(pid => insert.run(req.params.id, team_id, pid.player_id, pid.is_starter?1:0, BJ()));
  broadcastUpdate('matches', {});
  logOperation(req, 'save_lineup', 'match', req.params.id, { team_id, count: player_ids.length });
  res.json({ ok: true });
});

// ========== 访客提交比赛首发阵容 ==========
// 获取某场比赛两队的阵容提交状态
app.get('/api/matches/:id/lineup-status', requireAuth, (req, res) => {
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(req.params.id);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  const teams = [match.team1_id, match.team2_id].filter(Boolean);
  const status = {};
  teams.forEach(tid => {
    const lineup = db.prepare('SELECT * FROM match_lineups WHERE match_id=? AND team_id=? ORDER BY is_starter DESC').all(req.params.id, tid);
    const sub = db.prepare('SELECT submitted_at FROM match_lineups WHERE match_id=? AND team_id=? AND status=? ORDER BY submitted_at DESC LIMIT 1').get(req.params.id, tid, 'submitted');
    status[tid] = {
      submitted: lineup.length > 0 && lineup[0].status === 'submitted',
      count: lineup.length,
      starters: lineup.filter(l => l.is_starter).length,
      submitted_at: sub ? sub.submitted_at : null
    };
  });
  res.json({ match_id: match.id, teams: status });
});

// 访客提交本队首发阵容（男11/女8 首发 + 替补，提交后状态为submitted）
app.post('/api/matches/:id/lineup/submit', requireViewer, checkMatchNotLocked, (req, res) => {
  const matchId = req.params.id;
  const teamId = req.session.user.team_id;
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  if (match.team1_id !== teamId && match.team2_id !== teamId) {
    return res.status(403).json({ error: '本队不参与这场比赛' });
  }
  const { player_ids } = req.body;
  if (!Array.isArray(player_ids) || player_ids.length === 0) {
    return res.status(400).json({ error: '请选择球员' });
  }
  // 男子11人制：首发11、大名单≤23；女子8人制：首发8、大名单≤20；替补均≤12
  const REQ_STARTERS = match.gender === 'women' ? 8 : 11;
  const MAX_SQUAD = match.gender === 'women' ? 20 : 23;
  const starters = player_ids.filter(p => p.is_starter);
  if (starters.length !== REQ_STARTERS) {
    return res.status(400).json({ error: `首发必须是${REQ_STARTERS}人，当前选择了${starters.length}人` });
  }
  const subs = player_ids.length - starters.length;
  if (player_ids.length > MAX_SQUAD || subs > 12) {
    return res.status(400).json({ error: `单场大名单最多${MAX_SQUAD}人（${REQ_STARTERS}名首发+最多12名替补），当前共${player_ids.length}人（替补${subs}人）` });
  }
  // 去重校验
  const pidList = player_ids.map(p => +p.player_id);
  if (new Set(pidList).size !== pidList.length) {
    return res.status(400).json({ error: '同一名球员不能在阵容中重复出现' });
  }
  // 校验球员属于该球队且已审批通过；同时收集位置用于门将校验、收集停赛
  const chosen = [];
  for (const p of player_ids) {
    const player = db.prepare('SELECT id, team_id, status, name, position FROM players WHERE id=?').get(p.player_id);
    if (!player || player.team_id !== teamId) {
      return res.status(400).json({ error: '球员不属于本队' });
    }
    if (player.status !== 'approved') {
      return res.status(400).json({ error: `球员${player.name}尚未审批通过，不能进入阵容` });
    }
    chosen.push(player);
  }
  // A3 首发必须包含至少1名门将
  const starterObjs = chosen.filter((_, i) => player_ids[i].is_starter);
  const hasGK = chosen.some(c => c.position === '门将' && player_ids.find(p => +p.player_id === c.id)?.is_starter);
  if (!hasGK) {
    return res.status(400).json({ error: `首发${REQ_STARTERS}人中必须包含至少1名门将` });
  }
  // A2 停赛拦截：处于停赛期（剩余停赛场次>0）的球员不得进入阵容（警告不拦截）
  const suspended = chosen.filter(c => !!playerActiveSuspension(c.id));
  if (suspended.length) {
    return res.status(400).json({ error: `以下球员处于停赛期，不能进入本场阵容：${suspended.map(s => s.name).join('、')}` });
  }
  // 服务端兜底：首发球员必须已签到（缺阵/未签到不得首发），与前端规则一致，防止绕过页面直接调接口
  for (const item of player_ids.filter(x => x.is_starter)) {
    const ci = db.prepare('SELECT status FROM match_checkins WHERE match_id=? AND player_id=?').get(matchId, +item.player_id);
    if (!ci || ci.status !== 'checked_in') {
      const pl = chosen.find(c => c.id === +item.player_id);
      const reason = ci && ci.status === 'absent' ? '已标记缺阵' : '未签到';
      return res.status(400).json({ error: `${pl ? pl.name : '球员'} ${reason}，不能进入首发，请先在“签到”中完成签到` });
    }
  }
  // 替换该队该场的阵容
  db.prepare('DELETE FROM match_lineups WHERE match_id=? AND team_id=?').run(matchId, teamId);
  const now = BJ();
  const insert = db.prepare('INSERT INTO match_lineups (match_id, team_id, player_id, is_starter, submitted_by, submitted_at, status) VALUES (?,?,?,?,?,?,?)');
  player_ids.forEach(p => insert.run(matchId, teamId, p.player_id, p.is_starter?1:0, req.session.user.id, now, 'submitted'));
  broadcastUpdate('matches', {});
  logOperation(req, 'submit_match_lineup', 'match', matchId, { team_id: teamId, count: player_ids.length, starters: starters.length });
  // 通知管理员
  const team = db.prepare('SELECT name FROM teams WHERE id=?').get(teamId);
  sendMessageToAllAdmins({
    title: '首发阵容已提交',
    content: `${team?.name || '某队'} 已提交场序${match.match_number}的首发阵容（${starters.length}首发+${player_ids.length - starters.length}替补），请查看。`,
    type: 'lineup_submit', relatedType: 'match', relatedId: matchId
  });
  res.json({ ok: true, message: '首发阵容提交成功' });
});

// 添加单个比赛事件
app.post('/api/matches/:id/events', requireAdmin, checkMatchNotLocked, (req, res) => {
  const matchId = req.params.id;
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  if (!match) return res.status(404).json({ error: '比赛不存在' });

  const { event_type, team_id, player_id, minute, is_penalty_kick, sub_in_player_id, notes, sub_window } = req.body;
  const ALLOWED_EVENTS = ['goal', 'own_goal', 'assist', 'yellow', 'red', 'sub'];
  if (!ALLOWED_EVENTS.includes(event_type)) return res.status(400).json({ error: '不支持的事件类型' });

  // 数据完整性校验：球队/球员必须真实且属于本场对阵；分钟合法
  const matchTeamIds = [match.team1_id, match.team2_id];
  if (team_id !== undefined && team_id !== null && team_id !== '' && !matchTeamIds.includes(Number(team_id))) {
    return res.status(400).json({ error: '事件所属球队不是本场对阵双方' });
  }
  const _checkEventPlayer = (pid, label) => {
    if (pid === undefined || pid === null || pid === '') return null;
    const pr = db.prepare('SELECT id, team_id FROM players WHERE id=? AND deleted_at IS NULL').get(Number(pid));
    if (!pr) return `${label}不存在或已删除`;
    if (!matchTeamIds.includes(pr.team_id)) return `${label}不属于本场对阵球队`;
    return null;
  };
  let _pe = _checkEventPlayer(player_id, '事件球员');
  if (!_pe && event_type === 'sub') _pe = _checkEventPlayer(sub_in_player_id, '换上球员');
  if (_pe) return res.status(400).json({ error: _pe });
  if (minute !== undefined && minute !== null && minute !== '') {
    const mn = Number(minute);
    if (!Number.isFinite(mn) || !Number.isInteger(mn) || mn < 0 || mn > 130) {
      return res.status(400).json({ error: '比赛分钟须为0-130的整数' });
    }
  }

  // 换人规则软校验（不拦截，仅回传提示）：全场3个换人窗口、累计换上≤12人、被换下者不得再上
  const subWarnings = [];
  if (event_type === 'sub' && team_id) {
    const stat = teamSubStats(matchId, team_id);
    const win = sub_window ? +sub_window : 0;
    if (win >= 1 && win <= 3 && !stat.list.some(s => +s.sub_window === win) && stat.windows >= SUB_WINDOWS_MAX) {
      subWarnings.push(`该队已用满 ${SUB_WINDOWS_MAX} 个换人窗口（中场休息不计），如确属同一窗口请选择已有窗口编号`);
    }
    if (stat.onCount + 1 > SUB_PLAYERS_MAX) {
      subWarnings.push(`该队累计换上将达到 ${stat.onCount + 1} 人，超过单场 ${SUB_PLAYERS_MAX} 个替补名额上限，请核对`);
    }
    if (sub_in_player_id && stat.offIds.has(+sub_in_player_id)) {
      subWarnings.push('被换下的球员不得再次换上，请核对换人对象');
    }
  }

  // 红牌罚下的球员不能再参与后续事件（进球、助攻等）
  if (player_id && (event_type === 'goal' || event_type === 'assist')) {
    const redCard = db.prepare(`SELECT id FROM match_events WHERE match_id=? AND player_id=? AND event_type='red'`).get(matchId, player_id);
    if (redCard) return res.status(400).json({ error: '该球员已被红牌罚下，不能再参与进球/助攻' });
  }

  // 检查两黄变红
  let actualType = event_type;
  let autoRed = false;
  if (event_type === 'yellow' && player_id) {
    const yellowCount = db.prepare(`SELECT COUNT(*) as c FROM match_events WHERE match_id=? AND player_id=? AND event_type='yellow'`).get(matchId, player_id).c;
    if (yellowCount >= 1) {
      // 第二张黄牌，自动变红牌
      actualType = 'red';
      autoRed = true;
    }
  }

  const result = db.prepare(`INSERT INTO match_events (match_id,event_type,team_id,player_id,minute,is_penalty_kick,sub_in_player_id,notes,sub_window,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(matchId, actualType, team_id||null, player_id||null, minute||0, is_penalty_kick?1:0, sub_in_player_id||null, notes||'', (event_type==='sub'&&sub_window)?+sub_window:0, BJ());

  // 如果是红牌（包括两黄变红），自动添加停赛记录
  if (actualType === 'red' && player_id) {
    const reason = autoRed ? '两黄变一红停赛' : '红牌停赛';
    addAutoSuspension(player_id, reason, matchId);
    // 发送禁赛通知给球员所在球队
    const player = db.prepare('SELECT * FROM players WHERE id=?').get(player_id);
    if (player && player.team_id) {
      const title = `球员禁赛通知`;
      const content = `${player.name}（${player.jersey_number || '-'}号）因${reason}，将停赛1场。`;
      sendMessageToTeam(player.team_id, { title, content, type: 'suspension', relatedType: 'player', relatedId: player_id });
    }
  }

  // 如果是黄牌，检查累计3张（半决赛清零/手动清零后，只统计边界之后的黄牌）
  if (actualType === 'yellow' && player_id) {
    const yp = db.prepare('SELECT team_id FROM players WHERE id=?').get(player_id);
    const totalYellows = yp ? countEffectiveFinishedYellows(player_id, yp.team_id) : 0;
    // 加上当前比赛的黄牌
    const currentYellows = db.prepare(`SELECT COUNT(*) as c FROM match_events WHERE match_id=? AND player_id=? AND event_type='yellow'`).get(matchId, player_id).c;
    if ((totalYellows + currentYellows) % 3 === 0 && (totalYellows + currentYellows) > 0) {
      addAutoSuspension(player_id, '累计3张黄牌停赛', matchId);
      // 发送禁赛通知
      const yPlayer = db.prepare('SELECT * FROM players WHERE id=?').get(player_id);
      if (yPlayer && yPlayer.team_id) {
        sendMessageToTeam(yPlayer.team_id, {
          title: '球员禁赛通知',
          content: `${yPlayer.name}（${yPlayer.jersey_number || '-'}号）因累计3张黄牌，将停赛1场。`,
          type: 'suspension', relatedType: 'player', relatedId: player_id
        });
      }
    }
  }

  broadcastUpdate('matches', {});
  broadcastUpdate('scorers', {});
  broadcastUpdate('suspensions', {});
  logOperation(req, 'add_match_event', 'match', matchId, { event_type: actualType, player_id, minute, auto_red: autoRed });
  res.json({ ok: true, event_id: result.lastInsertRowid, auto_red: autoRed, event_type: actualType, warnings: subWarnings });
});

// 删除单个比赛事件
app.delete('/api/matches/:id/events/:eventId', requireAdmin, checkMatchNotLocked, (req, res) => {
  const { id, eventId } = req.params;
  const evt = db.prepare('SELECT * FROM match_events WHERE id=? AND match_id=?').get(eventId, id);
  if (!evt) return res.status(404).json({ error: '事件不存在' });

  db.prepare('DELETE FROM match_events WHERE id=?').run(eventId);

  // 如果删除的是红牌，删除该球员最近一条自动红牌停赛记录
  if (evt.event_type === 'red' && evt.player_id) {
    db.prepare(`DELETE FROM suspensions WHERE id = (
      SELECT id FROM suspensions WHERE player_id=? AND is_manual=0 AND active=1
      AND reason IN ('红牌停赛','两黄变一红停赛') ORDER BY id DESC LIMIT 1
    )`).run(evt.player_id);
  }

  // 如果删除的是黄牌，重新检查累计黄牌停赛
  if (evt.event_type === 'yellow' && evt.player_id) {
    const match = db.prepare('SELECT * FROM matches WHERE id=?').get(id);
    if (match && match.status === 'finished') {
      const totalYellows = countEffectiveFinishedYellows(evt.player_id, evt.team_id);
      // 如果删除后不再满足3张黄牌条件，删除最近一条自动黄牌停赛
      if (totalYellows % 3 !== 0) {
        db.prepare(`DELETE FROM suspensions WHERE id = (
          SELECT id FROM suspensions WHERE player_id=? AND is_manual=0 AND active=1
          AND reason='累计3张黄牌停赛' ORDER BY id DESC LIMIT 1
        )`).run(evt.player_id);
      }
    }
  }

  broadcastUpdate('matches', {});
  broadcastUpdate('scorers', {});
  broadcastUpdate('suspensions', {});
  logOperation(req, 'delete_match_event', 'match', id, { event_id: eventId, event_type: evt.event_type });
  res.json({ ok: true });
});

// A4 编辑单个比赛事件（校正分钟/球员/类型/点球/换人/备注）
// A4 编辑比赛事件（管理员人工校正通道，不受赛后锁定限制）
app.put('/api/matches/:id/events/:eventId', requireAdmin, (req, res) => {
  const { id, eventId } = req.params;
  const evt = db.prepare('SELECT * FROM match_events WHERE id=? AND match_id=?').get(eventId, id);
  if (!evt) return res.status(404).json({ error: '事件不存在' });
  const { event_type, team_id, player_id, minute, is_penalty_kick, sub_in_player_id, notes } = req.body;
  const allowed = ['goal', 'own_goal', 'assist', 'yellow', 'red', 'sub'];
  if (event_type && !allowed.includes(event_type)) return res.status(400).json({ error: '事件类型无效' });

  // 与 POST 一致的完整性校验（仅校验本次提交中出现的字段）
  const _m = db.prepare('SELECT team1_id, team2_id FROM matches WHERE id=?').get(id);
  if (!_m) return res.status(404).json({ error: '比赛不存在' });
  const _putTeamIds = [_m.team1_id, _m.team2_id];
  if (team_id !== undefined && team_id !== null && team_id !== '' && !_putTeamIds.includes(Number(team_id))) {
    return res.status(400).json({ error: '事件所属球队不是本场对阵双方' });
  }
  const _checkPutPlayer = (pid, label) => {
    if (pid === undefined || pid === null || pid === '') return null;
    const pr = db.prepare('SELECT id, team_id FROM players WHERE id=? AND deleted_at IS NULL').get(Number(pid));
    if (!pr) return `${label}不存在或已删除`;
    if (!_putTeamIds.includes(pr.team_id)) return `${label}不属于本场对阵球队`;
    return null;
  };
  let _ppe = _checkPutPlayer(player_id, '事件球员');
  if (!_ppe && sub_in_player_id !== undefined) _ppe = _checkPutPlayer(sub_in_player_id, '换上球员');
  if (_ppe) return res.status(400).json({ error: _ppe });
  if (minute !== undefined && minute !== null && minute !== '') {
    const mn = Number(minute);
    if (!Number.isFinite(mn) || !Number.isInteger(mn) || mn < 0 || mn > 130) {
      return res.status(400).json({ error: '比赛分钟须为0-130的整数' });
    }
  }
  const before = { event_type: evt.event_type, team_id: evt.team_id, player_id: evt.player_id, minute: evt.minute };
  db.prepare(`UPDATE match_events SET event_type=?, team_id=?, player_id=?, minute=?, is_penalty_kick=?, sub_in_player_id=?, notes=? WHERE id=?`)
    .run(
      event_type || evt.event_type,
      team_id !== undefined ? (team_id || null) : evt.team_id,
      player_id !== undefined ? (player_id || null) : evt.player_id,
      minute !== undefined && minute !== '' ? minute : evt.minute,
      is_penalty_kick ? 1 : 0,
      sub_in_player_id !== undefined ? (sub_in_player_id || null) : evt.sub_in_player_id,
      notes !== undefined ? notes : evt.notes,
      eventId
    );
  // 类型变更联动停赛记录：改为红牌补建、红牌改走撤销
  const _finalType = event_type || evt.event_type;
  const _finalPlayer = player_id !== undefined ? (player_id || null) : evt.player_id;
  if (before.event_type !== 'red' && _finalType === 'red' && _finalPlayer) {
    const _has = db.prepare(`SELECT id FROM suspensions WHERE player_id=? AND is_manual=0 AND active=1 AND reason IN ('红牌停赛','两黄变一红停赛')`).get(_finalPlayer);
    if (!_has) addAutoSuspension(Number(_finalPlayer), '红牌停赛', id);
  }
  if (before.event_type === 'red' && _finalType !== 'red' && evt.player_id) {
    db.prepare(`DELETE FROM suspensions WHERE id = (SELECT id FROM suspensions WHERE player_id=? AND is_manual=0 AND active=1 AND reason IN ('红牌停赛','两黄变一红停赛') ORDER BY id DESC LIMIT 1)`).run(evt.player_id);
  }
  // 若涉及进球/乌龙变化且比赛已结束，按事件重算比分，保证比分与射手一致
  const match = db.prepare('SELECT status FROM matches WHERE id=?').get(id);
  let recalced = null;
  if (match && match.status === 'finished' &&
    (before.event_type !== (event_type || evt.event_type) || before.team_id !== (team_id !== undefined ? (team_id || null) : evt.team_id)
      || ['goal', 'own_goal'].includes(before.event_type) || ['goal', 'own_goal'].includes(event_type))) {
    recalced = recalcScoreFromEvents(id);
  }
  broadcastUpdate('matches', {});
  broadcastUpdate('scorers', {});
  broadcastUpdate('standings', {});
  logOperation(req, 'edit_match_event', 'match', id, { event_id: +eventId, before, after: { event_type: event_type || evt.event_type, minute } });
  res.json({ ok: true, recalced });
});

// A4 按进球事件一键重算比分（人工校正入口）
app.post('/api/matches/:id/recalc-score', requireAdmin, (req, res) => {
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(req.params.id);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  const r = recalcScoreFromEvents(req.params.id);
  broadcastUpdate('matches', {});
  broadcastUpdate('scorers', {});
  broadcastUpdate('standings', {});
  logOperation(req, 'recalc_score', 'match', req.params.id, { before: [match.team1_score, match.team2_score], after: [r.s1, r.s2] });
  res.json({ ok: true, ...r });
});

// 精彩镜头：通用上传（比赛图片 / 其他活动图片，如倒计时海报等）
app.post('/api/photos', requireAdmin, photoUpload.array('photos', 20), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: '请选择要上传的图片' });
  const photoType = req.body.photo_type === 'activity' ? 'activity' : 'match';
  const caption = req.body.caption || '';
  const activityName = (req.body.activity_name || '').trim();
  let matchId = null;
  if (photoType === 'match') {
    matchId = parseInt(req.body.match_id);
    if (!matchId) return res.status(400).json({ error: '请选择关联比赛' });
    const match = db.prepare('SELECT status FROM matches WHERE id=?').get(matchId);
    if (!match) return res.status(404).json({ error: '比赛不存在' });
    if (match.status === 'finished') return res.status(403).json({ error: '比赛已结束并锁定，请先解锁后再上传照片', locked: true });
  }
  const insert = db.prepare('INSERT INTO match_photos (match_id, photo_path, caption, uploaded_by, created_at, photo_type, activity_name) VALUES (?,?,?,?,?,?,?)');
  const results = [];
  req.files.forEach(f => {
    const photoPath = '/uploads/photos/' + f.filename;
    const r = insert.run(matchId, photoPath, caption, req.session.user.id, BJ(), photoType, activityName);
    results.push({ id: r.lastInsertRowid, path: photoPath });
  });
  broadcastUpdate('match_photos', {});
  logOperation(req, 'upload_photos', photoType, matchId, { count: req.files.length, activity_name: activityName });
  res.json({ ok: true, photos: results });
});

// 精彩镜头：上传照片（旧接口，仅比赛图片，保留兼容）
app.post('/api/matches/:id/photos', requireAdmin, checkMatchNotLocked, photoUpload.array('photos', 20), (req, res) => {
  const matchId = req.params.id;
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: '请选择要上传的图片' });

  const caption = req.body.caption || '';
  const insert = db.prepare('INSERT INTO match_photos (match_id, photo_path, caption, uploaded_by, created_at) VALUES (?,?,?,?,?)');
  const results = [];
  req.files.forEach(f => {
    const photoPath = '/uploads/photos/' + f.filename;
    const r = insert.run(matchId, photoPath, caption, req.session.user.id, BJ());
    results.push({ id: r.lastInsertRowid, path: photoPath });
  });
  broadcastUpdate('match_photos', {});
  logOperation(req, 'upload_match_photos', 'match', matchId, { count: req.files.length });
  res.json({ ok: true, photos: results });
});

// 精彩镜头：获取某场比赛的照片
app.get('/api/matches/:id/photos', (req, res) => {
  const photos = db.prepare('SELECT * FROM match_photos WHERE match_id=? ORDER BY created_at DESC').all(req.params.id);
  res.json(photos);
});

// 精彩镜头：删除照片
app.delete('/api/matches/photos/:photoId', requireAdmin, (req, res) => {
  const photo = db.prepare('SELECT * FROM match_photos WHERE id=?').get(req.params.photoId);
  if (!photo) return res.status(404).json({ error: '照片不存在' });
  const photoMatch = db.prepare('SELECT status FROM matches WHERE id=?').get(photo.match_id);
  if (photoMatch && photoMatch.status === 'finished') return res.status(403).json({ error: '比赛已结束并锁定，请先解锁后再删除照片', locked: true });
  db.prepare('DELETE FROM match_photos WHERE id=?').run(req.params.photoId);
  const fs = require('fs');
  const filePath = path.join(__dirname, 'public', photo.photo_path);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  broadcastUpdate('match_photos', {});
  logOperation(req, 'delete_match_photo', 'match_photo', req.params.photoId, {});
  res.json({ ok: true });
});

// 录入比分（核心）
app.post('/api/matches/:id/score', requireAdmin, checkMatchNotLocked, (req, res) => {
  const { team1_score, team2_score, has_penalty, penalty_team1, penalty_team2, penalties, auto_advance, mvp_player_id, has_extra_time, team1_reg_score, team2_reg_score, ht_team1_score, ht_team2_score } = req.body;
  const matchId = req.params.id;
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  // 比分校验：必须为非负整数，上限99
  const isNNI = v => Number.isInteger(v) && v >= 0 && v <= 99;
  if (!isNNI(team1_score) || !isNNI(team2_score)) return res.status(400).json({ error: '比分必须为0-99的非负整数' });
  if (has_penalty && (!isNNI(penalty_team1) || !isNNI(penalty_team2))) return res.status(400).json({ error: '点球比分必须为0-99的非负整数' });
  if (ht_team1_score !== undefined && ht_team1_score !== null && !isNNI(ht_team1_score)) return res.status(400).json({ error: '半场比分必须为0-99的非负整数' });
  if (ht_team2_score !== undefined && ht_team2_score !== null && !isNNI(ht_team2_score)) return res.status(400).json({ error: '半场比分必须为0-99的非负整数' });
  if (has_extra_time) return res.status(400).json({ error: '本届赛事不设加时赛' });
  // v51 分阶段结果校验
  const isWomen = match.gender === 'women';
  const num = match.match_number;
  let outcomeErr = null;
  if (isWomen) {
    // 女子单循环：允许平局，不踢点球
    if (has_penalty) outcomeErr = '女子组比赛允许平局，无需点球大战';
  } else {
    // 男子所有场次（小组赛/附加赛/半决赛/季军赛/决赛）：不允许平局，战平即点球
    outcomeErr = validateScoreOutcome({ team1_score, team2_score, has_penalty, penalty_team1, penalty_team2 });
  }
  if (outcomeErr) return res.status(400).json({ error: outcomeErr });

  db.exec('BEGIN');
  try {
    // 更新比分
    let winnerId = null;
    if (team1_score > team2_score) winnerId = match.team1_id;
    else if (team2_score > team1_score) winnerId = match.team2_id;
    else if (has_penalty) winnerId = penalty_team1 > penalty_team2 ? match.team1_id : match.team2_id;


    db.prepare(`UPDATE matches SET team1_score=?, team2_score=?, has_penalty=?, penalty_team1=?, penalty_team2=?, winner_id=?, mvp_player_id=?, team1_reg_score=NULL, team2_reg_score=NULL, ht_team1_score=COALESCE(?,ht_team1_score), ht_team2_score=COALESCE(?,ht_team2_score), status='finished' WHERE id=?`)
      .run(team1_score, team2_score, has_penalty?1:0, penalty_team1||null, penalty_team2||null, winnerId, mvp_player_id||null, (ht_team1_score===0||ht_team1_score)?ht_team1_score:null, (ht_team2_score===0||ht_team2_score)?ht_team2_score:null, matchId);
    stampFinished(matchId);

    // 更新点球大战
    db.prepare('DELETE FROM penalty_shootout WHERE match_id=?').run(matchId);
    if (penalties && penalties.length) {
      const insert = db.prepare(`INSERT INTO penalty_shootout (match_id,round_number,team_id,player_id,scored) VALUES (?,?,?,?,?)`);
      penalties.forEach(p => insert.run(matchId, p.round_number, p.team_id, p.player_id||null, p.scored?1:0));
    }

    // 比赛结束时计算累计黄牌停赛（事件已即时保存；半决赛/手动清零后只统计边界之后）
    const yellowPlayers = db.prepare(`SELECT DISTINCT player_id FROM match_events WHERE match_id=? AND event_type='yellow' AND player_id IS NOT NULL`).all(matchId);
    yellowPlayers.forEach(row => {
      const yp = db.prepare('SELECT team_id FROM players WHERE id=?').get(row.player_id);
      const totalYellows = yp ? countEffectiveFinishedYellows(row.player_id, yp.team_id) : 0;
      if (totalYellows > 0 && totalYellows % 3 === 0) {
        // 检查是否已有自动停赛记录
        const existing = db.prepare(`SELECT id FROM suspensions WHERE player_id=? AND reason='累计3张黄牌停赛' AND is_manual=0 AND active=1`).get(row.player_id);
        if (!existing) {
          addAutoSuspension(row.player_id, '累计3张黄牌停赛', matchId);
          // 发送禁赛通知
          const sPlayer = db.prepare('SELECT * FROM players WHERE id=?').get(row.player_id);
          if (sPlayer && sPlayer.team_id) {
            sendMessageToTeam(sPlayer.team_id, {
              title: '球员禁赛通知',
              content: `${sPlayer.name}（${sPlayer.jersey_number || '-'}号）因累计3张黄牌，将停赛1场。`,
              type: 'suspension', relatedType: 'player', relatedId: row.player_id
            });
          }
        }
      }
    });

    // 自动推进后续比赛（男子小组出线+附加赛+单场半决赛；女子单循环无需落位）
    if (auto_advance !== false && !isWomen) advanceMenMatches();

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  broadcastUpdate('matches', {});
  broadcastUpdate('standings', {});
  broadcastUpdate('scorers', {});
  broadcastUpdate('suspensions', {});

  // 发送比分结果通知给对阵双方球队访客
  const finishedMatch = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  if (finishedMatch && finishedMatch.team1_id && finishedMatch.team2_id) {
    const ft1 = db.prepare('SELECT name FROM teams WHERE id=?').get(finishedMatch.team1_id);
    const ft2 = db.prepare('SELECT name FROM teams WHERE id=?').get(finishedMatch.team2_id);
    const winnerName = finishedMatch.winner_id === finishedMatch.team1_id ? ft1?.name : (finishedMatch.winner_id === finishedMatch.team2_id ? ft2?.name : null);
    const scoreStr = `${finishedMatch.team1_score}:${finishedMatch.team2_score}`;
    const penStr = finishedMatch.has_penalty ? `（点球 ${finishedMatch.penalty_team1}:${finishedMatch.penalty_team2}）` : '';
    const fTitle = `比赛结果已公布`;
    const isDraw = finishedMatch.winner_id == null && finishedMatch.team1_score === finishedMatch.team2_score;
    const fContent = `场序${finishedMatch.gender === 'women' ? (finishedMatch.match_number - 100) : finishedMatch.match_number} ${ft1?.name || ''} vs ${ft2?.name || ''} 比赛已结束，最终比分 ${scoreStr}${penStr}，${isDraw ? '双方战平' : winnerName + ' 获胜'}。点击查看比赛详情。`;
    sendMessageToTeam(finishedMatch.team1_id, { title: fTitle, content: fContent, type: 'match_update', relatedType: 'match', relatedId: finishedMatch.id });
    sendMessageToTeam(finishedMatch.team2_id, { title: fTitle, content: fContent, type: 'match_update', relatedType: 'match', relatedId: finishedMatch.id });
  }

  logOperation(req, 'submit_score', 'match', matchId, { score: `${team1_score}:${team2_score}`, has_penalty, penalty: `${penalty_team1||0}:${penalty_team2||0}` });
  res.json({ ok: true });
});



// 修改比赛结果（比分录入后更正；v51 阶段校验同录入）
app.put('/api/matches/:id/score', requireAdmin, checkMatchNotLocked, (req, res) => {
  const matchId = req.params.id;
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  const { team1_score, team2_score, has_penalty, penalty_team1, penalty_team2, penalties, mvp_player_id, has_extra_time, ht_team1_score, ht_team2_score } = req.body;

  const isNNI = v => Number.isInteger(v) && v >= 0 && v <= 99;
  if (!isNNI(team1_score) || !isNNI(team2_score)) return res.status(400).json({ error: '比分必须为0-99的非负整数' });
  if (has_penalty && (!isNNI(penalty_team1) || !isNNI(penalty_team2))) return res.status(400).json({ error: '点球比分必须为0-99的非负整数' });
  if (ht_team1_score !== undefined && ht_team1_score !== null && !isNNI(ht_team1_score)) return res.status(400).json({ error: '半场比分必须为0-99的非负整数' });
  if (ht_team2_score !== undefined && ht_team2_score !== null && !isNNI(ht_team2_score)) return res.status(400).json({ error: '半场比分必须为0-99的非负整数' });
  if (has_extra_time) return res.status(400).json({ error: '本届赛事不设加时赛' });
  const isWomen = match.gender === 'women';
  const num = match.match_number;
  let outcomeErr = null;
  if (isWomen) {
    if (has_penalty) outcomeErr = '女子组比赛允许平局，无需点球大战';
  } else {
    outcomeErr = validateScoreOutcome({ team1_score, team2_score, has_penalty, penalty_team1, penalty_team2 });
  }
  if (outcomeErr) return res.status(400).json({ error: outcomeErr });

  db.exec('BEGIN');
  try {
    let winnerId = null;
    if (team1_score > team2_score) winnerId = match.team1_id;
    else if (team2_score > team1_score) winnerId = match.team2_id;
    else if (has_penalty) winnerId = penalty_team1 > penalty_team2 ? match.team1_id : match.team2_id;

    db.prepare(`UPDATE matches SET team1_score=?, team2_score=?, has_penalty=?, penalty_team1=?, penalty_team2=?, winner_id=?, mvp_player_id=?, team1_reg_score=NULL, team2_reg_score=NULL, ht_team1_score=COALESCE(?,ht_team1_score), ht_team2_score=COALESCE(?,ht_team2_score), status='finished' WHERE id=?`)
      .run(team1_score, team2_score, has_penalty?1:0, penalty_team1||null, penalty_team2||null, winnerId, mvp_player_id||null, (ht_team1_score===0||ht_team1_score)?ht_team1_score:null, (ht_team2_score===0||ht_team2_score)?ht_team2_score:null, matchId);
    stampFinished(matchId);

    db.prepare('DELETE FROM penalty_shootout WHERE match_id=?').run(matchId);
    if (penalties && penalties.length) {
      const insert = db.prepare(`INSERT INTO penalty_shootout (match_id,round_number,team_id,player_id,scored) VALUES (?,?,?,?,?)`);
      penalties.forEach(p => insert.run(matchId, p.round_number, p.team_id, p.player_id||null, p.scored?1:0));
    }

    // 重算后续（男子小组出线+附加赛+单场半决赛；女子单循环无需落位）
    if (!isWomen) recalculateMenAdvances();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  broadcastUpdate('matches', {});
  broadcastUpdate('standings', {});
  broadcastUpdate('scorers', {});
  broadcastUpdate('suspensions', {});

  const updatedMatch2 = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  if (updatedMatch2 && updatedMatch2.team1_id && updatedMatch2.team2_id) {
    const ut1 = db.prepare('SELECT name FROM teams WHERE id=?').get(updatedMatch2.team1_id);
    const ut2 = db.prepare('SELECT name FROM teams WHERE id=?').get(updatedMatch2.team2_id);
    const uWinner = updatedMatch2.winner_id === updatedMatch2.team1_id ? ut1?.name : (updatedMatch2.winner_id === updatedMatch2.team2_id ? ut2?.name : null);
    const uScore = `${updatedMatch2.team1_score}:${updatedMatch2.team2_score}`;
    const uPen = updatedMatch2.has_penalty ? `（点球 ${updatedMatch2.penalty_team1}:${updatedMatch2.penalty_team2}）` : '';
    const uTitle = `比赛结果已更新`;
    const uDraw = updatedMatch2.winner_id == null && updatedMatch2.team1_score === updatedMatch2.team2_score;
    const dispNum = updatedMatch2.gender === 'women' ? updatedMatch2.match_number - 100 : updatedMatch2.match_number;
    const uContent = `场序${dispNum} ${ut1?.name || ''} vs ${ut2?.name || ''} 的比赛结果已修改，最终比分 ${uScore}${uPen}，${uDraw ? '双方战平' : uWinner + ' 获胜'}。点击查看比赛详情。`;
    sendMessageToTeam(updatedMatch2.team1_id, { title: uTitle, content: uContent, type: 'match_update', relatedType: 'match', relatedId: updatedMatch2.id });
    sendMessageToTeam(updatedMatch2.team2_id, { title: uTitle, content: uContent, type: 'match_update', relatedType: 'match', relatedId: updatedMatch2.id });
  }

  logOperation(req, 'update_score', 'match', matchId, { score: `${team1_score}:${team2_score}`, has_penalty, penalty: `${penalty_team1||0}:${penalty_team2||0}` });
  res.json({ ok: true });
});


// ========== C11 手动覆盖晋级 / 恢复自动晋级 ==========
// 管理员手动指定一场未结束比赛的对阵双方并锁定自动晋级
app.post('/api/matches/:id/advance-override', requireAdmin, (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '比赛不存在' });
  if (m.status === 'finished') return res.status(400).json({ error: '已结束比赛无需覆盖' });
  const { team1_id, team2_id } = req.body;
  if (!team1_id || !team2_id) return res.status(400).json({ error: '请选择双方球队' });
  if (+team1_id === +team2_id) return res.status(400).json({ error: '双方不能是同一支球队' });
  db.prepare('UPDATE matches SET team1_id=?, team2_id=?, advance_locked=1 WHERE id=?').run(team1_id, team2_id, m.id);
  logOperation(req, 'advance_override', 'match', m.id, { team1_id, team2_id });
  broadcastUpdate('matches', {});
  res.json({ ok: true });
});

// 恢复自动晋级：解除锁定并按已结束比赛重新推导
app.post('/api/matches/:id/advance-auto', requireAdmin, (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '比赛不存在' });
  db.prepare('UPDATE matches SET advance_locked=0 WHERE id=?').run(m.id);
  recalculateMenAdvances();
  logOperation(req, 'advance_restore_auto', 'match', m.id, {});
  broadcastUpdate('matches', {});
  res.json({ ok: true });
});

// ========== 半决赛累计黄牌清零：管理员手动兜底 ==========
app.get('/api/discipline/yellow-resets', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT y.*, t.name as team_name FROM yellow_resets y JOIN teams t ON t.id=y.team_id ORDER BY y.boundary_match_number`).all();
  const structural = db.prepare(`SELECT id,name FROM teams WHERE id IN (SELECT team1_id FROM matches WHERE match_number IN (15,16) UNION SELECT team2_id FROM matches WHERE match_number IN (15,16))`).all();
  res.json({ manual: rows, semifinal_teams: structural, semifinal_boundary: MEN_SF_BOUNDARY });
});
app.post('/api/discipline/yellow-reset', requireAdmin, (req, res) => {
  const { team_id, boundary_match_number, note } = req.body || {};
  const teamId = Number(team_id);
  if (!Number.isInteger(teamId) || teamId <= 0) return res.status(400).json({ error: '请选择要清零黄牌的球队' });
  const team = db.prepare('SELECT id,name FROM teams WHERE id=? AND deleted_at IS NULL').get(teamId);
  if (!team) return res.status(404).json({ error: '球队不存在' });
  // 男子合法边界 18/19（上限21），女子小组赛后边界 107（展示场序7）
  const raw = parseInt(boundary_match_number) || 0;
  const allowed = [18, 19, 107];
  const boundary = allowed.includes(raw) ? raw : Math.max(0, Math.min(21, raw));
  db.prepare(`INSERT INTO yellow_resets (team_id,boundary_match_number,note,created_by,created_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(team_id) DO UPDATE SET boundary_match_number=excluded.boundary_match_number,note=excluded.note,created_by=excluded.created_by,created_at=excluded.created_at`)
    .run(team.id, boundary, String(note||'').slice(0,200), req.session.user.id, BJ());
  logOperation(req, 'yellow_reset', 'team', team.id, { boundary });
  broadcastUpdate('suspensions', {});
  res.json({ ok: true });
});
app.delete('/api/discipline/yellow-reset/:teamId', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM yellow_resets WHERE team_id=?').run(req.params.teamId);
  logOperation(req, 'yellow_reset_restore', 'team', req.params.teamId, {});
  broadcastUpdate('suspensions', {});
  res.json({ ok: true });
});

// ========== 改期 / 中断补赛 ==========
// mode: postpone=未开赛改期；replay_full=上半场结束前中断、改日全场重赛（纪律保留）；finish_current=进入下半场后中断、以当前比分结束
app.post('/api/matches/:id/reschedule', requireAdmin, (req, res) => {
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(req.params.id);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  if (match.status === 'finished') return res.status(400).json({ error: '已结束比赛请先解锁再处理' });
  const { mode, match_date, match_time, match_location, team1_score, team2_score, has_penalty, penalty_team1, penalty_team2 } = req.body;
  const mid = match.id;
  const note = String(req.body.note || '').slice(0, 200);

  const notifyParties = (title, content) => {
    if (match.team1_id) sendMessageToTeam(match.team1_id, { title, content, type: 'match_update', relatedType: 'match', relatedId: mid });
    if (match.team2_id) sendMessageToTeam(match.team2_id, { title, content, type: 'match_update', relatedType: 'match', relatedId: mid });
    [match.main_referee_id, match.assistant_ref1_id, match.assistant_ref2_id, match.fourth_official_id]
      .filter(Boolean).forEach(rid => { const uid = getRefereeUserId(rid); if (uid) sendMessage(uid, { title, content, type: 'match_update', relatedType: 'match', relatedId: mid }); });
  };

  if (mode === 'postpone') {
    if (!match_date || !match_time) return res.status(400).json({ error: '请填写改期后的比赛日期与时间' });
    db.exec('BEGIN');
    try {
      db.prepare(`UPDATE matches SET match_date=?,match_time=?,match_location=?,status='pending',team1_score=NULL,team2_score=NULL,
        has_penalty=0,penalty_team1=NULL,penalty_team2=NULL,winner_id=NULL,finished_at=NULL,is_walkover=0,walkover_team_id=NULL,schedule_note=? WHERE id=?`)
        .run(match_date, match_time, match_location||match.match_location||'三期操场', `未开赛改期：${note}`, mid);
      db.prepare('DELETE FROM match_lineups WHERE match_id=?').run(mid);
      db.prepare('DELETE FROM match_checkins WHERE match_id=?').run(mid);

      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    notifyParties('比赛改期通知', `场序${match.match_number} 未开赛改期至 ${match_date} ${match_time}（${match_location||match.match_location||'三期操场'}），原提交阵容/检录已清空，请重新准备。${note?'原因：'+note:''}`);
    logOperation(req, 'match_postpone', 'match', mid, { match_date, match_time });
  } else if (mode === 'replay_full') {
    if (!match_date || !match_time) return res.status(400).json({ error: '请填写重赛日期与时间' });
    db.exec('BEGIN');
    try {
      // 纪律（黄/红牌）事件保留并继续计入累计；只清进球/助攻/换人等运营事件与比分、阵容、检录、挑战
      db.prepare("DELETE FROM match_events WHERE match_id=? AND event_type IN ('goal','own_goal','assist','sub')").run(mid);
      db.prepare('DELETE FROM penalty_shootout WHERE match_id=?').run(mid);
      db.prepare('DELETE FROM match_lineups WHERE match_id=?').run(mid);
      db.prepare('DELETE FROM match_checkins WHERE match_id=?').run(mid);

      db.prepare(`UPDATE matches SET match_date=?,match_time=?,match_location=?,status='pending',team1_score=NULL,team2_score=NULL,
        has_penalty=0,penalty_team1=NULL,penalty_team2=NULL,winner_id=NULL,finished_at=NULL,is_walkover=0,walkover_team_id=NULL,schedule_note=? WHERE id=?`)
        .run(match_date, match_time, match_location||match.match_location||'三期操场', `上半场结束前中断，改日全场重赛（纪律记录保留）：${note}`, mid);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    notifyParties('比赛中断、改日全场重赛', `场序${match.match_number} 在上半场结束前中断，改于 ${match_date} ${match_time} 全场重赛，已出示的黄/红牌继续计入累计，比分与阵容重置。${note?'原因：'+note:''}`);
    logOperation(req, 'match_replay_full', 'match', mid, { match_date, match_time });
  } else if (mode === 'finish_current') {
    const s1 = +team1_score, s2 = +team2_score;
    if (!Number.isInteger(s1) || !Number.isInteger(s2) || s1 < 0 || s2 < 0 || s1 === s2) {
      return res.status(400).json({ error: '以当前比分结束需填写分出胜负的非负整数比分（淘汰赛不允许平局）' });
    }
    const winnerId = s1 > s2 ? match.team1_id : match.team2_id;
    db.exec('BEGIN');
    try {
      db.prepare(`UPDATE matches SET team1_score=?,team2_score=?,has_penalty=0,penalty_team1=NULL,penalty_team2=NULL,
        winner_id=?,status='finished',is_walkover=0,schedule_note=? WHERE id=?`).run(s1, s2, winnerId, `进入下半场后中断，以当前比分结束：${note}`, mid);
      stampFinished(mid);
      advanceMenMatches();
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    notifyParties('比赛中断、以当前比分结束', `场序${match.match_number} 进入下半场后中断，经裁定以当前比分 ${s1}:${s2} 结束。${note?'说明：'+note:''}`);
    logOperation(req, 'match_finish_current', 'match', mid, { score: `${s1}:${s2}` });
  } else {
    return res.status(400).json({ error: '改期模式无效' });
  }
  broadcastUpdate('matches', {});
  broadcastUpdate('standings', {});
  broadcastUpdate('scorers', {});
  res.json({ ok: true });
});

// ========== 弃权判负（固定0:3，计积分净胜球，不产生个人进球） ==========
app.post('/api/matches/:id/walkover', requireAdmin, (req, res) => {
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(req.params.id);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  if (!match.team1_id || !match.team2_id) return res.status(400).json({ error: '双方球队尚未确定，无法判弃权' });
  if (match.status === 'finished') return res.status(400).json({ error: '比赛已结束，如需改判请先解锁' });
  const forfeitId = +req.body.walkover_team_id;
  if (forfeitId !== +match.team1_id && forfeitId !== +match.team2_id) return res.status(400).json({ error: '弃权方必须是对阵双方之一' });
  const winnerId = forfeitId === +match.team1_id ? match.team2_id : match.team1_id;
  const t1s = winnerId === +match.team1_id ? 3 : 0;
  const t2s = winnerId === +match.team2_id ? 3 : 0;
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE matches SET team1_score=?,team2_score=?,has_penalty=0,penalty_team1=NULL,penalty_team2=NULL,
      winner_id=?,status='finished',is_walkover=1,walkover_team_id=?,schedule_note=? WHERE id=?`)
      .run(t1s, t2s, winnerId, forfeitId, `一方弃权，判0:3：${String(req.body.note||'').slice(0,200)}`, match.id);
    stampFinished(match.id);
      advanceMenMatches();
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const fn = db.prepare('SELECT name FROM teams WHERE id=?').get(forfeitId)?.name || '';
  const wn = db.prepare('SELECT name FROM teams WHERE id=?').get(winnerId)?.name || '';
  sendMessageToTeam(match.team1_id, { title: '比赛弃权判定结果', content: `场序${match.match_number} 因 ${fn} 弃权，判 ${wn} 3:0 获胜。`, type: 'match_update', relatedType: 'match', relatedId: match.id });
  sendMessageToTeam(match.team2_id, { title: '比赛弃权判定结果', content: `场序${match.match_number} 因 ${fn} 弃权，判 ${wn} 3:0 获胜。`, type: 'match_update', relatedType: 'match', relatedId: match.id });
  logOperation(req, 'match_walkover', 'match', match.id, { forfeit: fn, winner: wn });
  broadcastUpdate('matches', {});
  broadcastUpdate('standings', {});
  res.json({ ok: true });
});

// ========== 男子组排名：A/B 两组积分榜 + 出线/清黄状态 ==========
app.get('/api/standings', (req, res) => {
  const decorate = (rows) => rows.map((r, i) => {
    const t = db.prepare('SELECT id,name,logo_path FROM teams WHERE id=?').get(r.team_id);
    return { slot: i + 1, ...r, team_name: t?.name || '', logo_path: t?.logo_path || '' };
  });
  const groupA = decorate(menGroupTable('A'));
  const groupB = decorate(menGroupTable('B'));
  res.json({
    groupA, groupB,
    groupComplete: menGroupStageComplete(),
    yellowResetDone: !!db.prepare("SELECT value FROM settings WHERE key='men_sf_yellow_reset'").get(),
  });
});

// ========== 女子组排名：5队单循环积分榜（最终名次即排名） ==========
app.get('/api/standings/women', (req, res) => {
  const decorate = (rows) => rows.map((r, i) => {
    const t = db.prepare('SELECT id,name,logo_path FROM teams WHERE id=?').get(r.team_id);
    return { slot: i + 1, ...r, team_name: t?.name || '', logo_path: t?.logo_path || '' };
  });
  const table = decorate(womenTable());
  const total = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='women'").get().c;
  const fin = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='women' AND status='finished'").get().c;
  res.json({ table, groupComplete: total === 10 && fin === 10 });
});
// ========== 射手榜 ==========
app.get('/api/scorers', (req, res) => {
  const gender = req.query.gender === 'women' ? 'women' : 'men';
  const scorers = db.prepare(`
    SELECT p.id, p.name, p.jersey_number, t.name as team_name, t.id as team_id,
      COALESCE(g.goals, 0) as goals,
      COALESCE(g.penalties, 0) as penalties,
      COALESCE(a.assists, 0) as assists,
      COALESCE(o.own_goals, 0) as own_goals,
      COALESCE(m.mvp_count, 0) as mvp_count
    FROM players p
    JOIN teams t ON p.team_id = t.id
    LEFT JOIN (
      SELECT e.player_id,
        COUNT(CASE WHEN e.event_type='goal' THEN 1 END) as goals,
        COUNT(CASE WHEN e.event_type='goal' AND e.is_penalty_kick=1 THEN 1 END) as penalties
      FROM match_events e
      JOIN matches m ON e.match_id = m.id
      WHERE e.event_type='goal' AND m.status='finished'
      GROUP BY e.player_id
    ) g ON g.player_id = p.id
    LEFT JOIN (
      SELECT e.player_id, COUNT(*) as assists FROM match_events e
      JOIN matches m ON e.match_id=m.id
      WHERE e.event_type='assist' AND m.status='finished'
      GROUP BY e.player_id
    ) a ON a.player_id = p.id
    LEFT JOIN (
      SELECT e.player_id, COUNT(*) as own_goals FROM match_events e
      JOIN matches m ON e.match_id=m.id
      WHERE e.event_type='own_goal' AND m.status='finished'
      GROUP BY e.player_id
    ) o ON o.player_id = p.id
    LEFT JOIN (
      SELECT mvp_player_id, COUNT(*) as mvp_count
      FROM matches
      WHERE status='finished' AND mvp_player_id IS NOT NULL
      GROUP BY mvp_player_id
    ) m ON m.mvp_player_id = p.id
    WHERE t.gender=? AND (COALESCE(g.goals, 0) > 0 OR COALESCE(a.assists,0) > 0 OR COALESCE(o.own_goals,0) > 0 OR COALESCE(m.mvp_count, 0) > 0)
    ORDER BY goals DESC, assists DESC, penalties ASC, mvp_count DESC
  `).all(gender);
  res.json(scorers);
});

// ========== 最佳球员榜（每场MVP累计，并列看进球→助攻） ==========
app.get('/api/mvp-board', (req, res) => {
  const gender = req.query.gender === 'women' ? 'women' : 'men';
  const rows = db.prepare(`
    SELECT p.id, p.name, p.jersey_number, t.name as team_name, t.id as team_id,
      COUNT(m.id) as mvp_count,
      COALESCE(g.goals,0) as goals,
      COALESCE(a.assists,0) as assists
    FROM matches m
    JOIN players p ON p.id = m.mvp_player_id
    JOIN teams t ON t.id = p.team_id
    LEFT JOIN (
      SELECT e.player_id, COUNT(*) goals FROM match_events e JOIN matches mm ON e.match_id=mm.id
      WHERE e.event_type='goal' AND mm.status='finished' GROUP BY e.player_id
    ) g ON g.player_id=p.id
    LEFT JOIN (
      SELECT e.player_id, COUNT(*) assists FROM match_events e JOIN matches mm ON e.match_id=mm.id
      WHERE e.event_type='assist' AND mm.status='finished' GROUP BY e.player_id
    ) a ON a.player_id=p.id
    WHERE m.status='finished' AND m.mvp_player_id IS NOT NULL AND t.gender=?
    GROUP BY p.id
    ORDER BY mvp_count DESC, goals DESC, assists DESC, p.id
  `).all(gender);
  res.json(rows);
});

// ========== 停赛（仅进行中，兼容原停赛信息页） ==========
app.get('/api/suspensions', (req, res) => {
  const list = db.prepare(`SELECT s.*, p.name as player_name, p.jersey_number, t.name as team_name
    FROM suspensions s JOIN players p ON s.player_id=p.id JOIN teams t ON p.team_id=t.id
    WHERE s.active=1 AND COALESCE(s.discipline_type,'suspension')='suspension' AND COALESCE(s.remaining_count,s.match_count)>0
    ORDER BY s.created_at DESC`).all();
  res.json(list);
});

// ========== 纪律与停赛（警告+停赛，全员可见） ==========
app.get('/api/discipline', (req, res) => {
  const list = db.prepare(`SELECT s.*, p.name as player_name, p.jersey_number, t.name as team_name, t.id as team_id
    FROM suspensions s JOIN players p ON s.player_id=p.id JOIN teams t ON p.team_id=t.id
    ORDER BY s.created_at DESC`).all();
  res.json(list);
});

// 管理员手动新增纪律处罚（警告 / 追加停赛N场）
app.post('/api/discipline', requireAdmin, (req, res) => {
  const { player_id, discipline_type, reason, match_count, notes } = req.body || {};
  const discPlayerId = Number(player_id);
  if (!Number.isInteger(discPlayerId) || discPlayerId <= 0) return res.status(400).json({ error: '请选择受处罚的球员' });
  const player = db.prepare('SELECT * FROM players WHERE id=? AND deleted_at IS NULL').get(discPlayerId);
  if (!player) return res.status(404).json({ error: '球员不存在' });
  const dtype = discipline_type === 'warning' ? 'warning' : 'suspension';
  const cnt = Math.max(0, Math.min(20, parseInt(match_count, 10) || 0));
  if (dtype === 'suspension' && cnt < 1) return res.status(400).json({ error: '停赛场次至少为1场' });
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: '请填写处罚事由' });
  const r = db.prepare(`INSERT INTO suspensions (player_id,reason,match_count,remaining_count,is_manual,active,discipline_type,decided_by,decided_at,notes)
    VALUES (?,?,?,?,1,?,?,?,?,?)`)
    .run(player.id, String(reason).trim(), dtype==='warning'?0:cnt, dtype==='warning'?0:cnt, 1, dtype, req.session.user.id, BJ(), notes||'');
  broadcastUpdate('suspensions', {});
  logOperation(req, 'add_discipline', 'player', player.id, { type: dtype, reason, match_count: cnt });
  // 通知该球员所在球队
  const label = dtype === 'warning' ? '纪律警告' : `追加停赛${cnt}场`;
  sendMessageToTeam(player.team_id, {
    title: '纪律处罚通知',
    content: `球员「${player.name}（${player.jersey_number||'-'}号）」被${label}。事由：${String(reason).trim()}。`,
    type: 'suspension', relatedType: 'player', relatedId: player.id
  });
  res.json({ ok: true, id: r.lastInsertRowid });
});

// 管理员撤销/解除一条纪律处罚
app.post('/api/discipline/:id/revoke', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM suspensions WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  db.prepare('UPDATE suspensions SET active=0, revoked_at=? WHERE id=?').run(BJ(), row.id);
  broadcastUpdate('suspensions', {});
  logOperation(req, 'revoke_discipline', 'suspension', row.id, { player_id: row.player_id });
  res.json({ ok: true });
});

// ========== 赛事荣誉（金靴/公平竞赛自动；最佳球员/最佳门将管理员指定） ==========
// 金靴候选：进球→助攻→点球少排序，完全并列则并列获奖
function computeGoldenBoot(gender = 'men') {
  const rows = db.prepare(`
    SELECT p.id,p.name,p.jersey_number,t.id as team_id,t.name as team_name,
      SUM(CASE WHEN e.event_type='goal' THEN 1 ELSE 0 END) as goals,
      SUM(CASE WHEN e.event_type='assist' THEN 1 ELSE 0 END) as assists,
      SUM(CASE WHEN e.event_type='goal' AND e.is_penalty_kick=1 THEN 1 ELSE 0 END) as penalties
    FROM match_events e JOIN matches m ON e.match_id=m.id
    JOIN players p ON e.player_id=p.id JOIN teams t ON p.team_id=t.id
    WHERE m.status='finished' AND e.event_type IN ('goal','assist') AND m.gender=?
    GROUP BY p.id HAVING goals>0
    ORDER BY goals DESC, assists DESC, penalties ASC`).all(gender);
  if (!rows.length) return [];
  const top = rows[0];
  return rows.filter(r => r.goals === top.goals && r.assists === top.assists && r.penalties === top.penalties);
}
// 公平竞赛积分：黄牌1分、红牌3分（越少越好），并列则并列
function computeFairPlay(gender = 'men') {
  const teams = db.prepare('SELECT id,name FROM teams WHERE deleted_at IS NULL AND COALESCE(is_hidden,0)=0 AND gender=? ORDER BY id').all(gender);
  const table = teams.map(t => {
    const ev = db.prepare(`SELECT e.event_type, COUNT(*) as c FROM match_events e JOIN matches m ON e.match_id=m.id
      JOIN players p ON e.player_id=p.id WHERE m.status='finished' AND p.team_id=? AND e.event_type IN ('yellow','red')
      GROUP BY e.event_type`).all(t.id);
    let yellow = 0, red = 0;
    ev.forEach(x => { if (x.event_type === 'yellow') yellow = x.c; else red = x.c; });
    const played = db.prepare("SELECT COUNT(*) as c FROM matches WHERE status='finished' AND (team1_id=? OR team2_id=?)").get(t.id, t.id).c;
    return { team_id: t.id, team_name: t.name, yellow, red, points: yellow * 1 + red * 3, played };
  }).sort((a, b) => a.points - b.points || b.played - a.played);
  const winners = table.length && table[0].played > 0 ? table.filter(x => x.points === table[0].points && x.played > 0) : [];
  return { winners, table };
}
// 荣誉榜（公开）：自动奖项实时计算 + 管理员指定项
app.get('/api/awards/honors', (req, res) => {
  const gender = req.query.gender === 'women' ? 'women' : 'men';
  const golden = computeGoldenBoot(gender);
  const fp = computeFairPlay(gender);
  const designated = db.prepare(`SELECT a.*, p.name as player_name, p.jersey_number, t.name as team_name
    FROM awards a LEFT JOIN players p ON a.player_id=p.id LEFT JOIN teams t ON a.team_id=t.id
    WHERE a.award_type IN ('best_player','best_goalkeeper') AND a.gender=? ORDER BY a.award_type`).all(gender);
  res.json({ gender, golden_boot: golden, fair_play: fp.winners, fair_play_table: fp.table, designated });
});
// 管理员指定最佳球员/最佳门将（决赛后从候选中选）
app.post('/api/awards/designate', requireAdmin, (req, res) => {
  const { award_type, player_id } = req.body;
  if (!['best_player', 'best_goalkeeper'].includes(award_type)) return res.status(400).json({ error: '奖项类型无效' });
  if (!player_id) {
    const gClear = req.body.gender === 'women' ? 'women' : 'men';
    db.prepare('DELETE FROM awards WHERE award_type=? AND gender=?').run(award_type, gClear);
    logOperation(req, 'award_clear', 'award', null, { award_type, gender: gClear });
    return res.json({ ok: true });
  }
  const p = db.prepare(`SELECT p.*, t.name as team_name, t.gender as gender FROM players p JOIN teams t ON p.team_id=t.id WHERE p.id=? AND p.deleted_at IS NULL`).get(player_id);
  if (!p) return res.status(404).json({ error: '球员不存在' });
  const title = award_type === 'best_player' ? '金球奖' : '金手套奖';
  const exist = db.prepare('SELECT id FROM awards WHERE award_type=? AND gender=?').get(award_type, p.gender);
  if (exist) db.prepare('UPDATE awards SET player_id=?,team_id=?,title=?,detail=?,updated_at=? WHERE id=?')
    .run(player_id, p.team_id, title, `${p.name}（${p.team_name}）`, BJ(), exist.id);
  else db.prepare('INSERT INTO awards (award_type,player_id,team_id,title,detail,is_auto,gender,updated_at) VALUES (?,?,?,?,?,0,?,?)')
    .run(award_type, player_id, p.team_id, title, `${p.name}（${p.team_name}）`, p.gender, BJ());
  logOperation(req, 'award_designate', 'award', player_id, { award_type, gender: p.gender });
  broadcastUpdate('awards', {});
  res.json({ ok: true });
});

// ========== 报名注册冻结（男子/女子相互独立） ==========
app.get('/api/settings/public', (req, res) => {
  res.json({
    registration_frozen: isRegistrationFrozen() ? 1 : 0,
    registration_frozen_men: isRegistrationFrozen('men') ? 1 : 0,
    registration_frozen_women: isRegistrationFrozen('women') ? 1 : 0,
    maintenance_active: maintenanceActive() ? 1 : 0,
    maintenance_reason: maintenanceReason(),
    maintenance_enabled: getSetting('maintenance_enabled', '1') === '1' ? 1 : 0,
    maintenance_manual: getSetting('maintenance_manual', '0') === '1' ? 1 : 0,
    maintenance_window: '每日 01:00–07:00（北京时间）',
    maintenance_message: maintenanceMessage()
  });
});

// 管理员：维护设置详情
app.get('/api/settings/maintenance', requireAdmin, (req, res) => {
  res.json({
    enabled: getSetting('maintenance_enabled', '1') === '1',
    manual: getSetting('maintenance_manual', '0') === '1',
    activeNow: maintenanceActive(),
    reason: maintenanceReason(),
    beijingHour: beijingHourNow(),
    window: '每日 01:00–07:00（北京时间）'
  });
});
// 管理员：更新维护开关（body: {enabled?:0|1, manual?:0|1}）
app.post('/api/settings/maintenance', requireAdmin, (req, res) => {
  const out = {};
  if (req.body.enabled !== undefined) { const v = req.body.enabled ? '1' : '0'; setSetting('maintenance_enabled', v); out.enabled = v === '1'; logOperation(req, 'maintenance_schedule', 'settings', null, { enabled: out.enabled }); }
  if (req.body.manual !== undefined) { const v = req.body.manual ? '1' : '0'; setSetting('maintenance_manual', v); out.manual = v === '1'; logOperation(req, 'maintenance_manual', 'settings', null, { manual: out.manual }); }
  broadcastUpdate('settings', {});
  res.json({ ok: true, ...out, activeNow: maintenanceActive() });
});
// 各队报名人数（冻结前体检用；可按 ?gender=men/women 过滤）
app.get('/api/roster-counts', requireAuth, (req, res) => {
  const g = req.query.gender === 'women' ? 'women' : (req.query.gender === 'men' ? 'men' : null);
  const rows = db.prepare(`SELECT t.id, t.name, t.gender,
    COUNT(CASE WHEN p.is_official=0 AND p.status='approved' THEN 1 END) as player_count,
    COUNT(CASE WHEN p.is_official=1 THEN 1 END) as official_count,
    COUNT(CASE WHEN p.status='pending' THEN 1 END) as pending_count
    FROM teams t LEFT JOIN players p ON p.team_id=t.id AND p.deleted_at IS NULL AND p.withdrawn_at IS NULL
    WHERE t.deleted_at IS NULL AND COALESCE(t.is_hidden,0)=0 ${g ? 'AND t.gender=?' : ''} GROUP BY t.id ORDER BY t.id`).all(...(g ? [g] : []));
  res.json(rows);
});
// 冻结/解冻某一组别报名注册（管理员；body.gender=men/women，默认 men）
app.post('/api/settings/registration-freeze', requireAdmin, (req, res) => {
  const gender = req.body.gender === 'women' ? 'women' : 'men';
  const settingKey = `registration_frozen_${gender}`;
  const genderLabel = gender === 'women' ? '女子组' : '男子组';
  const frozen = req.body.frozen ? 1 : 0;
  if (frozen) {
    // 冻结前校验：该组别每队上场球员 11-23，且无待审批
    const counts = db.prepare(`SELECT t.name,
      SUM(CASE WHEN p.is_official=0 AND p.status='approved' THEN 1 ELSE 0 END) as pc,
      SUM(CASE WHEN p.status='pending' THEN 1 ELSE 0 END) as pend
      FROM teams t LEFT JOIN players p ON p.team_id=t.id AND p.deleted_at IS NULL AND p.withdrawn_at IS NULL
      WHERE t.deleted_at IS NULL AND COALESCE(t.is_hidden,0)=0 AND t.gender=? GROUP BY t.id`).all(gender);
    const [minPlayers, maxPlayers] = gender === 'women' ? [8, 20] : [11, 23];
    const bad = counts.filter(c => c.pc < minPlayers || c.pc > maxPlayers || c.pend > 0);
    if (bad.length && !req.body.force) {
      return res.status(400).json({
        error: `${genderLabel}以下球队不满足冻结条件（上场球员需${minPlayers}-${maxPlayers}人、无待审批）：` + bad.map(b => `${b.name}(${b.pc}人${b.pend?`/待审批${b.pend}`:''})`).join('、'),
        need_confirm: true, roster: counts
      });
    }
  }
  setSetting(settingKey, frozen);
  broadcastUpdate('settings', {});
  logOperation(req, frozen ? 'freeze_registration' : 'unfreeze_registration', 'settings', null, { frozen, gender });
  // 仅通知该组别各队
  const teams = db.prepare('SELECT id,name FROM teams WHERE deleted_at IS NULL AND COALESCE(is_hidden,0)=0 AND gender=?').all(gender);
  teams.forEach(t => sendMessageToTeam(t.id, {
    title: `${genderLabel}报名注册已${frozen ? '冻结' : '解冻'}`,
    content: frozen ? `${genderLabel}报名注册已冻结，此后各队运动员名单不能再增删改；球队官员（领队/主教练/队医）仍可维护，每场首发阵容仍可在开赛前从现有名单中提交。` : `${genderLabel}报名注册已重新开放，球队可调整名单后再次提交。`,
    type: 'notice'
  }));
  res.json({ ok: true, gender, registration_frozen: frozen });
});

app.post('/api/suspensions', requireAdmin, (req, res) => {
  const { player_id, reason, match_count, notes } = req.body || {};
  const suspPlayerId = Number(player_id);
  if (!Number.isInteger(suspPlayerId) || suspPlayerId <= 0) return res.status(400).json({ error: '请选择受停赛的球员' });
  const mPlayer0 = db.prepare('SELECT * FROM players WHERE id=? AND deleted_at IS NULL').get(suspPlayerId);
  if (!mPlayer0) return res.status(404).json({ error: '球员不存在' });
  const cnt = Math.max(1, Math.min(20, parseInt(match_count, 10) || 1));
  db.prepare('INSERT INTO suspensions (player_id, reason, match_count, remaining_count, is_manual, active, discipline_type, decided_by, decided_at, notes) VALUES (?,?,?,?,1,1,?,?,?,?)')
    .run(suspPlayerId, reason||'手动停赛', cnt, cnt, 'suspension', req.session.user.id, BJ(), notes||'');
  broadcastUpdate('suspensions', {});
  logOperation(req, 'add_suspension', 'player', suspPlayerId, { reason, match_count: cnt, notes });
  // 发送禁赛通知
  if (mPlayer0.team_id) {
    sendMessageToTeam(mPlayer0.team_id, {
      title: '球员禁赛通知',
      content: `${mPlayer0.name}（${mPlayer0.jersey_number || '-'}号）被手动禁赛${cnt}场，原因：${reason || '手动禁赛'}。`,
      type: 'suspension', relatedType: 'player', relatedId: suspPlayerId
    });
  }
  res.json({ ok: true });
});

app.put('/api/suspensions/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE suspensions SET active=0 WHERE id=?').run(req.params.id);
  broadcastUpdate('suspensions', {});
  logOperation(req, 'cancel_suspension', 'suspension', req.params.id, {});
  res.json({ ok: true });
});

// ========== 抽签系统 ==========

// 获取男子组抽签状态（席位 A1/A2/A3、B1/B2/B3）
app.get('/api/draw/status', requireAuth, (req, res) => {
  const teams = db.prepare("SELECT id,name,logo_path FROM teams WHERE gender='men' AND COALESCE(is_hidden,0)=0 ORDER BY id").all();
  const started = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='men' AND status!='pending'").get().c;
  const slotOrder = ['A1','A2','A3','B1','B2','B3'];
  const slots = {};
  const gms = db.prepare("SELECT team1_id,team2_id,team1_source,team2_source FROM matches WHERE gender='men' AND round_group IN ('A','B')").all();
  gms.forEach(m => { slots[m.team1_source] = m.team1_id; slots[m.team2_source] = m.team2_id; });
  const drawn = gms.some(m => m.team1_id != null);
  res.json({ canDraw: !started && !drawn, drawn, hasLiveMatch: started > 0, teams, slots, slotOrder });
});

// 执行男子组抽签（6队抽入 A/B 两组共6席位）
app.post('/api/draw/execute', requireAdmin, (req, res) => {
  const { slots } = req.body;
  const slotOrder = ['A1','A2','A3','B1','B2','B3'];
  const menIds = db.prepare("SELECT id FROM teams WHERE gender='men' AND COALESCE(is_hidden,0)=0").all().map(t => t.id);
  if (menIds.length !== 6) return res.status(400).json({ error: '男子组应为6支球队' });
  const started = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='men' AND status!='pending'").get().c;
  if (started > 0) return res.status(400).json({ error: '比赛已开始，不能抽签' });
  const filled = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='men' AND round_group IN ('A','B') AND team1_id IS NOT NULL").get().c;
  if (filled > 0) return res.status(400).json({ error: '已经抽过签，如需重抽请先重置' });
  if (!slots) return res.status(400).json({ error: '抽签结果无效' });
  const vals = slotOrder.map(k => (slots[k] == null ? null : +slots[k]));
  if (vals.some(v => v == null)) return res.status(400).json({ error: '六个席位都必须抽出球队' });
  if (new Set(vals).size !== 6) return res.status(400).json({ error: '每支球队只能落入一个席位' });
  if (vals.some(v => !menIds.includes(v))) return res.status(400).json({ error: '存在非男子组球队' });
  const s = {}; slotOrder.forEach((k, i) => s[k] = vals[i]);
  // 回避规则：球队E、球队F必须分在不同小组
  const pairTeams = db.prepare("SELECT id,name FROM teams WHERE gender='men' AND COALESCE(is_hidden,0)=0").all()
    .filter(t => t.name === '球队E' || t.name === '球队F').map(t => t.id);
  if (pairTeams.length === 2) {
    const groupOf = id => slotOrder.find(k => s[k] === id).charAt(0);
    if (groupOf(pairTeams[0]) === groupOf(pairTeams[1]))
      return res.status(400).json({ error: '球队E、球队F不得分在同一小组，请重抽' });
  }
  const upd = db.prepare('UPDATE matches SET team1_id=?,team2_id=? WHERE id=?');
  const gms = db.prepare("SELECT id,team1_source,team2_source FROM matches WHERE gender='men' AND round_group IN ('A','B')").all();
  db.exec('BEGIN');
  try {
    gms.forEach(m => upd.run(s[m.team1_source], s[m.team2_source], m.id));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: '抽签失败: ' + e.message }); }
  try { advanceMenMatches(); } catch (e) { console.error('draw advance error', e.message); }
  broadcastUpdate('matches', {}); broadcastUpdate('standings', {});
  const nm = {}; db.prepare("SELECT id,name FROM teams WHERE gender='men' AND COALESCE(is_hidden,0)=0").all().forEach(t => nm[t.id] = t.name);
  logOperation(req, 'draw_lots', 'matches', null, { slots: slotOrder.map(k => `${k}:${nm[s[k]]}`).join(', ') });
  res.json({ ok: true, message: '男子组抽签完成' });
});

// ========== 女子组抽签：5队抽入 1-5 号席位（单循环） ==========
app.get('/api/draw/women/status', requireAuth, (req, res) => {
  const teams = db.prepare("SELECT id,name,logo_path FROM teams WHERE gender='women' AND COALESCE(is_hidden,0)=0 ORDER BY id").all();
  const started = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='women' AND status!='pending'").get().c;
  const slotOrder = ['1','2','3','4','5'];
  const slots = {};
  const wms = db.prepare("SELECT team1_id,team2_id,team1_source,team2_source FROM matches WHERE gender='women'").all();
  wms.forEach(m => { slots[m.team1_source] = m.team1_id; slots[m.team2_source] = m.team2_id; });
  const drawn = wms.some(m => m.team1_id != null);
  res.json({ canDraw: !started && !drawn, drawn, hasLiveMatch: started > 0, teams, slots, slotOrder });
});

app.post('/api/draw/women/execute', requireAdmin, (req, res) => {
  const { slots } = req.body;
  const slotOrder = ['1','2','3','4','5'];
  const wIds = db.prepare("SELECT id FROM teams WHERE gender='women' AND COALESCE(is_hidden,0)=0").all().map(t => t.id);
  if (wIds.length !== 5) return res.status(400).json({ error: '女子组应为5支球队' });
  const started = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='women' AND status!='pending'").get().c;
  if (started > 0) return res.status(400).json({ error: '女子组比赛已开始，不能抽签' });
  const filled = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='women' AND team1_id IS NOT NULL").get().c;
  if (filled > 0) return res.status(400).json({ error: '女子组已经抽过签，如需重抽请先重置女子组' });
  if (!slots) return res.status(400).json({ error: '抽签结果无效' });
  const vals = slotOrder.map(k => (slots[k] == null ? null : +slots[k]));
  if (vals.some(v => v == null)) return res.status(400).json({ error: '五个席位都必须抽出球队' });
  if (new Set(vals).size !== 5) return res.status(400).json({ error: '每支球队只能落入一个席位' });
  if (vals.some(v => !wIds.includes(v))) return res.status(400).json({ error: '存在非女子组球队' });
  const s = {}; slotOrder.forEach((k, i) => s[k] = vals[i]);
  const upd = db.prepare('UPDATE matches SET team1_id=?,team2_id=? WHERE id=?');
  const wms = db.prepare("SELECT id,team1_source,team2_source FROM matches WHERE gender='women'").all();
  db.exec('BEGIN');
  try {
    wms.forEach(m => upd.run(s[m.team1_source], s[m.team2_source], m.id));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: '抽签失败: ' + e.message }); }
  broadcastUpdate('matches', {}); broadcastUpdate('standings', {});
  const nm = {}; db.prepare("SELECT id,name FROM teams WHERE gender='women' AND COALESCE(is_hidden,0)=0").all().forEach(t => nm[t.id] = t.name);
  logOperation(req, 'draw_lots_women', 'matches', null, { slots: slotOrder.map(k => `${k}:${nm[s[k]]}`).join(', ') });
  res.json({ ok: true, message: '女子组抽签完成' });
});
// ========== 解锁已结束比赛 ==========
app.post('/api/matches/:id/unlock', requireAdmin, (req, res) => {
  const { password } = req.body;
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(req.params.id);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  if (match.status !== 'finished') return res.status(400).json({ error: '该比赛未锁定' });

  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id);
  if (!user || !bcrypt.compareSync(password || '', user.password)) {
    return res.status(403).json({ error: '管理员密码错误' });
  }

  db.prepare("UPDATE matches SET status='live', is_walkover=0, walkover_team_id=NULL WHERE id=?").run(req.params.id);
  clearFinished(req.params.id);
  broadcastUpdate('matches', {});
  logOperation(req, 'unlock_match', 'match', req.params.id, { match_number: match.match_number });
  res.json({ ok: true, message: '比赛已解锁，状态改为进行中' });
});

// ========== 一键重置（账号密码保留；all 回到待抽签全新态） ==========
app.post('/api/admin/reset', requireAdmin, async (req, res) => {
  const { password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id);
  if (!user || !bcrypt.compareSync(password || '', user.password)) {
    return res.status(403).json({ error: '管理员密码错误' });
  }

  const scope = req.body.gender === 'women' ? 'women' : 'all';
  const womenMatchIds = () => db.prepare("SELECT id FROM matches WHERE gender='women'").all().map(m => m.id);
  const womenTeamIds = () => db.prepare("SELECT id FROM teams WHERE gender='women' AND COALESCE(is_hidden,0)=0").all().map(t => t.id);

  db.exec('BEGIN');
  try {
    if (scope === 'women') {
      // 仅重置女子组，男子数据原封不动
      const mids = womenMatchIds();
      const tids = womenTeamIds();
      const inPh = mids.length ? mids.map(() => '?').join(',') : '';
      const inPt = tids.length ? tids.map(() => '?').join(',') : '';
      const delIn = (tbl, col) => { if (mids.length) db.prepare(`DELETE FROM ${tbl} WHERE ${col} IN (${inPh})`).run(...mids); };
      delIn('match_events', 'match_id');
      delIn('penalty_shootout', 'match_id');
      delIn('match_lineups', 'match_id');
      delIn('match_checkins', 'match_id');
      delIn('match_photos', 'match_id');
      delIn('match_ref_confirm', 'match_id');
      delIn('match_reminders', 'match_id');
      if (mids.length) {
        db.prepare(`DELETE FROM referee_report_events WHERE report_id IN (SELECT id FROM referee_reports WHERE match_id IN (${inPh}))`).run(...mids);
      }
      delIn('referee_reports', 'match_id');
      db.prepare("DELETE FROM awards WHERE gender='women'").run();
      db.prepare("DELETE FROM messages WHERE receiver_id IN (SELECT id FROM users WHERE role='visitor' AND gender='women')").run();
      if (tids.length) {
        db.prepare(`DELETE FROM suspensions WHERE player_id IN (SELECT id FROM players WHERE team_id IN (${inPt}))`).run(...tids);
        db.prepare(`DELETE FROM players WHERE team_id IN (${inPt})`).run(...tids);
        db.prepare(`DELETE FROM yellow_resets WHERE team_id IN (${inPt})`).run(...tids);
      }
      db.prepare(`UPDATE matches SET team1_score=NULL,team2_score=NULL,ht_team1_score=NULL,ht_team2_score=NULL,
        team1_reg_score=NULL,team2_reg_score=NULL,has_penalty=0,penalty_team1=NULL,penalty_team2=NULL,
        winner_id=NULL,status='pending',main_referee_id=NULL,assistant_ref1_id=NULL,assistant_ref2_id=NULL,
        fourth_official_id=NULL,mvp_player_id=NULL,finished_at=NULL,advance_locked=0,
        is_walkover=0,walkover_team_id=NULL,schedule_note='',team1_id=NULL,team2_id=NULL
        WHERE gender='women'`).run();
    } else {
      // 全量清空（保留 users 账号密码）
      db.prepare('DELETE FROM match_events').run();
      db.prepare('DELETE FROM penalty_shootout').run();
      db.prepare('DELETE FROM match_lineups').run();
      db.prepare('DELETE FROM match_checkins').run();
      db.prepare('DELETE FROM match_photos').run();
      db.prepare('DELETE FROM suspensions').run();
      db.prepare('DELETE FROM login_logs').run();
      db.prepare('DELETE FROM players').run();
      db.prepare('DELETE FROM messages').run();
      db.prepare('DELETE FROM match_reminders').run();
      db.prepare('DELETE FROM awards').run();
      db.prepare('DELETE FROM referee_report_events').run();
      db.prepare('DELETE FROM referee_reports').run();
      db.prepare('DELETE FROM match_ref_confirm').run();
      db.prepare('DELETE FROM yellow_resets').run();
      // 表演赛数据一并清空
      db.prepare('DELETE FROM exhibition_events').run();
      db.prepare('DELETE FROM exhibition_penalties').run();
      db.prepare('DELETE FROM exhibition_players').run();
      db.prepare('DELETE FROM exhibition_matches').run();
      // 重置比赛数据（无 fsv/is_bye/has_extra_time 列）
      db.prepare(`UPDATE matches SET team1_score=NULL, team2_score=NULL,
        ht_team1_score=NULL, ht_team2_score=NULL,
        team1_reg_score=NULL, team2_reg_score=NULL,
        has_penalty=0, penalty_team1=NULL, penalty_team2=NULL, winner_id=NULL, status='pending',
        match_date='', match_time='', main_referee_id=NULL, assistant_ref1_id=NULL, assistant_ref2_id=NULL,
        fourth_official_id=NULL, mvp_player_id=NULL,
        finished_at=NULL, advance_locked=0, is_walkover=0, walkover_team_id=NULL, schedule_note='',
        team1_id=NULL, team2_id=NULL`).run();
      // 清报名冻结与男子清黄标志
      db.prepare("DELETE FROM settings WHERE key IN ('registration_frozen','registration_frozen_men','registration_frozen_women','men_sf_yellow_reset')").run();
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: '重置失败: ' + e.message });
  }

  broadcastUpdate('matches', {});
  broadcastUpdate('standings', {});
  broadcastUpdate('scorers', {});
  broadcastUpdate('suspensions', {});
  if (scope === 'all') broadcastUpdate('exhibition', {});
  if (scope === 'all') {
    const allUsers = db.prepare('SELECT id FROM users').all();
    allUsers.forEach(u => io.emit('unreadCount', { userId: u.id, count: 0 }));
  }
  logOperation(req, 'reset_data', 'system', null, { scope });
  res.json({ ok: true, message: scope === 'women' ? '女子组比赛数据已重置' : '所有比赛数据已重置，回到待抽签状态' });
});

// ========== 数据库备份 ==========
// 立即备份
// 数据库备份辅助函数：先checkpoint WAL再复制，确保备份完整
function performBackup() {
  const backupDir = path.join(__dirname, 'data', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  // 关键：将WAL数据写回主数据库文件，否则备份的cup.db是空的
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run();
  const ts = BJ().replace(/[ :.]/g, '-').slice(0, 19);
  const backupFile = path.join(backupDir, `cup_${ts}.db`);
  fs.copyFileSync(path.join(__dirname, 'data', 'cup.db'), backupFile);
  // 只保留最近10个备份
  const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).sort();
  if (files.length > 10) {
    files.slice(0, files.length - 10).forEach(f => fs.unlinkSync(path.join(backupDir, f)));
  }
  return `cup_${ts}.db`;
}

app.post('/api/admin/backup', requireAdmin, (req, res) => {
  try {
    const fileName = performBackup();
    logOperation(req, 'backup_db', 'system', null, { file: fileName });
    res.json({ ok: true, file: fileName });
  } catch (e) {
    res.status(500).json({ error: '备份失败: ' + e.message });
  }
});

// 获取备份列表
app.get('/api/admin/backups', requireAdmin, (req, res) => {
  const backupDir = path.join(__dirname, 'data', 'backups');
  if (!fs.existsSync(backupDir)) return res.json([]);
  const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).sort().reverse();
  res.json(files.map(f => {
    const stat = fs.statSync(path.join(backupDir, f));
    return { file: f, size: stat.size, time: stat.mtime };
  }));
});

// 下载备份
app.get('/api/admin/backups/:file', requireAdmin, (req, res) => {
  const file = path.basename(req.params.file);
  const filePath = path.join(__dirname, 'data', 'backups', file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '备份文件不存在' });
  res.download(filePath);
});

// 定时自动备份（每6小时）
setInterval(() => {
  try {
    const fileName = performBackup();
    console.log(`[自动备份] ${fileName}`);
  } catch (e) { console.error('自动备份失败:', e.message); }
}, 6 * 60 * 60 * 1000);

// ========== 导出Excel ==========
app.get('/api/export/:type', requireAuth, async (req, res) => {
  const { type } = req.params;
  const gender = req.query.gender === 'women' ? 'women' : 'men';
  const genderSuffix = gender === 'women' ? '_women' : '_men';
  const teamNameById = (id) => {
    if (id == null) return '';
    const t = db.prepare('SELECT name FROM teams WHERE id=?').get(id);
    return t ? t.name : '';
  };
  const head = (ws) => {
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A4D3A' } };
  };
  const wb = new ExcelJS.Workbook();

  if (type === 'schedule') {
    const ws = wb.addWorksheet('赛程表');
    ws.columns = [
      { header: '场序', key: 'num', width: 8 }, { header: '轮次', key: 'round', width: 14 },
      { header: '小组/阶段', key: 'group', width: 10 }, { header: '主队', key: 't1', width: 16 },
      { header: '比分', key: 'score', width: 12 }, { header: '客队', key: 't2', width: 16 },
      { header: '点球', key: 'pen', width: 10 }, { header: '日期', key: 'date', width: 14 },
      { header: '时间', key: 'time', width: 8 }, { header: '地点', key: 'loc', width: 12 },
      { header: '状态', key: 'status', width: 9 },
    ];
    const matches = db.prepare('SELECT * FROM matches WHERE gender=? ORDER BY match_number').all(gender);
    matches.forEach(m => {
      const t1 = m.team1_id != null ? teamNameById(m.team1_id) : (m.team1_source || '待定');
      const t2 = m.team2_id != null ? teamNameById(m.team2_id) : (m.team2_source || '待定');
      ws.addRow({
        num: gender === 'women' ? m.match_number - 100 : m.match_number,
        round: m.round_name, group: m.round_group || '', t1,
        score: m.status === 'finished' ? `${m.team1_score} : ${m.team2_score}` : '-', t2,
        pen: m.has_penalty ? `${m.penalty_team1} : ${m.penalty_team2}` : '',
        date: m.match_date, time: m.match_time, loc: m.match_location,
        status: m.status === 'finished' ? '已结束' : m.status === 'live' ? '进行中' : '未开始'
      });
    });
    head(ws);

    // 表演赛单独 sheet
    const ews = wb.addWorksheet('表演赛');
    ews.columns = [
      { header: '日期', key: 'date', width: 14 }, { header: '时间', key: 'time', width: 8 },
      { header: '地点', key: 'loc', width: 12 }, { header: '一方', key: 't1', width: 18 },
      { header: '比分', key: 'score', width: 9 }, { header: '点球', key: 'pen', width: 9 },
      { header: '另一方', key: 't2', width: 18 },
      { header: '主裁判', key: 'main', width: 12 }, { header: '助理1', key: 'a1', width: 12 },
      { header: '助理2', key: 'a2', width: 12 }, { header: '状态', key: 'st', width: 10 }];
    const eRefName = id => id ? (db.prepare('SELECT name FROM referees WHERE id=?').get(id)?.name || '') : '';
    db.prepare("SELECT * FROM exhibition_matches ORDER BY (match_date=''),match_date,(match_time=''),match_time,id").all().forEach(x => {
      const en = side => side === 1
        ? (x.team1_id ? teamNameById(x.team1_id) : (x.team1_custom || '待定'))
        : (x.team2_id ? teamNameById(x.team2_id) : (x.team2_custom || '待定'));
      ews.addRow({ date: x.match_date, time: x.match_time, loc: x.match_location, t1: en(1),
        score: x.status === 'finished' ? `${x.team1_score}:${x.team2_score}` : '',
        pen: x.status === 'finished' ? `${x.penalty_team1}:${x.penalty_team2}` : '', t2: en(2),
        main: eRefName(x.main_referee_id), a1: eRefName(x.assistant_ref1_id), a2: eRefName(x.assistant_ref2_id),
        st: { finished: '已结束', live: '进行中', pending: '未开始' }[x.status] || x.status });
    });
    head(ews);
  } else if (type === 'standings') {
    if (gender === 'women') {
      const ws = wb.addWorksheet('女子积分排名');
      ws.columns = [
        { header: '名次', key: 'slot', width: 8 }, { header: '球队', key: 'name', width: 18 },
        { header: '赛', key: 'played', width: 6 }, { header: '胜', key: 'win', width: 6 },
        { header: '平', key: 'draw', width: 6 }, { header: '负', key: 'loss', width: 6 },
        { header: '进球', key: 'gf', width: 8 }, { header: '失球', key: 'ga', width: 8 },
        { header: '净胜球', key: 'gd', width: 9 }, { header: '积分', key: 'points', width: 8 }];
      womenTable().forEach((r) => {
        const t = db.prepare('SELECT name FROM teams WHERE id=?').get(r.team_id);
        ws.addRow({ slot: r.slot ?? '', name: t ? t.name : '', played: r.played, win: r.win, draw: r.draw,
          loss: r.loss, gf: r.gf, ga: r.ga, gd: r.gd, points: r.points });
      });
      head(ws);
    } else {
      const ws = wb.addWorksheet('男子小组积分');
      ws.columns = [
        { header: '小组', key: 'grp', width: 7 }, { header: '组内名次', key: 'slot', width: 9 },
        { header: '球队', key: 'name', width: 18 }, { header: '赛', key: 'played', width: 6 },
        { header: '常规胜', key: 'win', width: 8 }, { header: '点胜', key: 'psw', width: 7 },
        { header: '点负', key: 'psl', width: 7 }, { header: '负', key: 'loss', width: 6 },
        { header: '进球', key: 'gf', width: 7 }, { header: '失球', key: 'ga', width: 7 },
        { header: '净胜球', key: 'gd', width: 9 }, { header: '积分', key: 'points', width: 7 },
        { header: '公平竞赛分', key: 'fair', width: 11 }];
      [['A', menGroupTable('A')], ['B', menGroupTable('B')]].forEach(([letter, rows]) => {
        rows.forEach((r, i) => {
          const t = db.prepare('SELECT name FROM teams WHERE id=?').get(r.team_id);
          ws.addRow({ grp: letter, slot: i + 1, name: t ? t.name : '', played: r.played, win: r.win,
            psw: r.ps_win, psl: r.ps_loss, loss: r.loss, gf: r.gf, ga: r.ga, gd: r.gd,
            points: r.points, fair: r.fair });
        });
      });
      head(ws);
    }
  } else if (type === 'scorers') {
    const ws = wb.addWorksheet('射手榜');
    ws.columns = [
      { header: '排名', key: 'rank', width: 8 }, { header: '球员', key: 'name', width: 14 },
      { header: '号码', key: 'num', width: 7 }, { header: '球队', key: 'team', width: 16 },
      { header: '进球', key: 'goals', width: 7 }, { header: '点球', key: 'pen', width: 7 }];
    const scorers = db.prepare(`
      SELECT p.name, p.jersey_number, t.name as team_name,
        COUNT(CASE WHEN e.event_type='goal' THEN 1 END) as goals,
        COUNT(CASE WHEN e.event_type='goal' AND e.is_penalty_kick=1 THEN 1 END) as penalties
      FROM match_events e JOIN players p ON e.player_id=p.id JOIN teams t ON p.team_id=t.id
      JOIN matches m ON e.match_id=m.id
      WHERE e.event_type='goal' AND m.status='finished' AND m.gender=?
      GROUP BY p.id ORDER BY goals DESC`).all(gender);
    scorers.forEach((s, i) => ws.addRow({ rank: i + 1, name: s.name, num: s.jersey_number,
      team: s.team_name, goals: s.goals, pen: s.penalties }));
    head(ws);
  } else if (type === 'mvp') {
    const ws = wb.addWorksheet('最佳球员榜');
    ws.columns = [
      { header: '排名', key: 'rank', width: 8 }, { header: '球员', key: 'name', width: 14 },
      { header: '号码', key: 'num', width: 7 }, { header: '球队', key: 'team', width: 15 },
      { header: '当选MVP', key: 'mvp', width: 9 }, { header: '进球', key: 'goals', width: 7 },
      { header: '助攻', key: 'assists', width: 7 }];
    const rows = db.prepare(`
      SELECT p.name,p.jersey_number,t.name AS team_name, COUNT(m.id) AS mvp_count,
        COALESCE(g.goals,0) AS goals, COALESCE(a.assists,0) AS assists
      FROM matches m JOIN players p ON m.mvp_player_id=p.id JOIN teams t ON p.team_id=t.id
      LEFT JOIN (SELECT e.player_id, COUNT(*) goals FROM match_events e JOIN matches mm ON e.match_id=mm.id WHERE e.event_type='goal' AND mm.status='finished' GROUP BY e.player_id) g ON g.player_id=p.id
      LEFT JOIN (SELECT e.player_id, COUNT(*) assists FROM match_events e JOIN matches mm ON e.match_id=mm.id WHERE e.event_type='assist' AND mm.status='finished' GROUP BY e.player_id) a ON a.player_id=p.id
      WHERE m.status='finished' AND m.mvp_player_id IS NOT NULL AND m.gender=?
      GROUP BY p.id ORDER BY mvp_count DESC, goals DESC, assists DESC, p.id`).all(gender);
    rows.forEach((s, i) => ws.addRow({ rank: i + 1, name: s.name, num: s.jersey_number, team: s.team_name,
      mvp: s.mvp_count, goals: s.goals, assists: s.assists }));
    head(ws);
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=${type}${genderSuffix}_${Date.now()}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

// D12 赛后多Sheet归档导出
app.get('/api/export/archive/full', requireAdmin, async (req, res) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = '校园足球赛事管理系统';
  const head = (ws) => {
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A4D3A' } };
  };
  const teamName = (id) => { const t = id && db.prepare('SELECT name FROM teams WHERE id=?').get(id); return t ? t.name : ''; };

  // 1 赛事概览
  let ws = wb.addWorksheet('赛事概览');
  ws.columns = [{ header: '项目', key: 'k', width: 22 }, { header: '内容', key: 'v', width: 40 }];
  const finished = db.prepare("SELECT * FROM matches WHERE status='finished'").all();
  const goals = finished.reduce((s, m) => s + (m.team1_score || 0) + (m.team2_score || 0), 0);
  [['赛事名称', '校园足球赛事'], ['导出时间', new Date().toLocaleString('zh-CN')],
   ['比赛总数', db.prepare('SELECT COUNT(*) c FROM matches').get().c], ['已赛场次', finished.length],
   ['参赛球队', db.prepare('SELECT COUNT(*) c FROM teams WHERE COALESCE(is_hidden,0)=0').get().c],
   ['报名球员', db.prepare('SELECT COUNT(*) c FROM players WHERE deleted_at IS NULL').get().c],
   ['裁判人数', db.prepare('SELECT COUNT(*) c FROM referees WHERE deleted_at IS NULL').get().c],
   ['总进球数', goals]].forEach(([k, v]) => ws.addRow({ k, v }));
  head(ws);

  // 2 赛程与比分
  ws = wb.addWorksheet('赛程比分');
  ws.columns = [
    { header: '场序', key: 'num', width: 8 }, { header: '轮次', key: 'round', width: 13 }, { header: '组别', key: 'group', width: 9 },
    { header: '一方', key: 't1', width: 17 }, { header: '全场比分', key: 'score', width: 11 }, { header: '另一方', key: 't2', width: 17 },
    { header: '点球', key: 'pen', width: 10 }, { header: '日期', key: 'date', width: 13 },
    { header: '时间', key: 'time', width: 8 }, { header: '地点', key: 'loc', width: 11 },
    { header: '主裁判', key: 'ref', width: 11 }, { header: '状态', key: 'st', width: 9 }];
  db.prepare('SELECT * FROM matches ORDER BY match_number').all().forEach(m => {
    const main = m.main_referee_id ? (db.prepare('SELECT name FROM referees WHERE id=?').get(m.main_referee_id)?.name || '') : '';
    ws.addRow({ num: m.gender === 'women' ? m.match_number - 100 : m.match_number, round: m.round_name,
      group: m.round_group, t1: teamName(m.team1_id) || m.team1_source,
      score: m.status === 'finished' ? `${m.team1_score}:${m.team2_score}` : '',
      t2: teamName(m.team2_id) || m.team2_source,
      pen: m.has_penalty ? `${m.penalty_team1}:${m.penalty_team2}` : '',
      date: m.match_date, time: m.match_time, loc: m.match_location, ref: main,
      st: m.status === 'finished' ? '已结束' : m.status === 'live' ? '进行中' : '未开始' });
  });
  head(ws);

  // 2.5 表演赛
  ws = wb.addWorksheet('表演赛');
  ws.columns = [
    { header: '序号', key: 'idx', width: 6 }, { header: '日期', key: 'date', width: 13 }, { header: '时间', key: 'time', width: 8 },
    { header: '地点', key: 'loc', width: 11 }, { header: '一方', key: 't1', width: 18 },
    { header: '比分', key: 'score', width: 8 }, { header: '点球', key: 'pen', width: 8 },
    { header: '另一方', key: 't2', width: 18 }, { header: '主裁判', key: 'main', width: 11 },
    { header: '助理1', key: 'a1', width: 11 }, { header: '助理2', key: 'a2', width: 11 },
    { header: '状态', key: 'st', width: 9 }];
  const ename = id => id ? (db.prepare('SELECT name FROM referees WHERE id=?').get(id)?.name || '') : '';
  db.prepare("SELECT * FROM exhibition_matches ORDER BY (match_date=''),match_date,(match_time=''),match_time,id").all().forEach((x, i) => {
    const en = side => side === 1
      ? (x.team1_id ? teamName(x.team1_id) : (x.team1_custom || '待定'))
      : (x.team2_id ? teamName(x.team2_id) : (x.team2_custom || '待定'));
    ws.addRow({ idx: i + 1, date: x.match_date, time: x.match_time, loc: x.match_location, t1: en(1),
      score: x.status === 'finished' ? `${x.team1_score}:${x.team2_score}` : '',
      pen: x.status === 'finished' ? `${x.penalty_team1}:${x.penalty_team2}` : '', t2: en(2),
      main: ename(x.main_referee_id), a1: ename(x.assistant_ref1_id), a2: ename(x.assistant_ref2_id),
      st: { finished: '已结束', live: '进行中', pending: '未开始' }[x.status] || x.status });
  });
  head(ws);

  // 3 球队名单
  ws = wb.addWorksheet('球队名单');
  ws.columns = [
    { header: '球队', key: 'team', width: 16 }, { header: '号码', key: 'num', width: 7 }, { header: '姓名', key: 'name', width: 12 },
    { header: '学号', key: 'sid', width: 15 }, { header: '位置', key: 'pos', width: 9 }, { header: '是否官员', key: 'off', width: 9 },
    { header: '官员职务', key: 'role', width: 12 }, { header: '班级', key: 'cls', width: 13 },
    { header: '状态', key: 'st', width: 9 }];
  db.prepare(`SELECT p.*, t.name tname FROM players p JOIN teams t ON p.team_id=t.id WHERE p.deleted_at IS NULL AND COALESCE(t.is_hidden,0)=0 ORDER BY t.id, p.jersey_number`).all()
    .forEach(p => ws.addRow({ team: p.tname, num: p.jersey_number, name: p.name, sid: p.student_id, pos: p.position,
      off: p.is_official ? '是' : '否', role: p.official_role || '', cls: p.class_name || '',
      st: { approved: '已通过', pending: '待审批', draft: '草稿', rejected: '已驳回' }[p.status] || p.status }));
  head(ws);

  // 4 射手榜
  ws = wb.addWorksheet('射手榜');
  ws.columns = [{ header: '排名', key: 'rank', width: 8 }, { header: '球员', key: 'name', width: 13 }, { header: '号码', key: 'num', width: 7 },
    { header: '球队', key: 'team', width: 16 }, { header: '进球', key: 'g', width: 7 }, { header: '其中点球', key: 'pen', width: 9 }];
  db.prepare(`SELECT p.name,p.jersey_number,t.name tn,
      SUM(CASE WHEN e.event_type='goal' THEN 1 ELSE 0 END) goals,
      SUM(CASE WHEN e.event_type='goal' AND e.is_penalty_kick=1 THEN 1 ELSE 0 END) pens
    FROM match_events e JOIN players p ON e.player_id=p.id JOIN teams t ON p.team_id=t.id JOIN matches m ON e.match_id=m.id
    WHERE e.event_type='goal' AND m.status='finished' GROUP BY p.id ORDER BY goals DESC`).all()
    .forEach((s, i) => ws.addRow({ rank: i + 1, name: s.name, num: s.jersey_number, team: s.tn, g: s.goals, pen: s.pens }));
  head(ws);

  // 5 纪律记录
  ws = wb.addWorksheet('纪律记录');
  ws.columns = [{ header: '场序', key: 'num', width: 8 }, { header: '日期', key: 'date', width: 12 }, { header: '球队', key: 'team', width: 16 },
    { header: '号码', key: 'jnum', width: 7 }, { header: '球员', key: 'name', width: 12 }, { header: '类型', key: 'card', width: 7 },
    { header: '分钟', key: 'min', width: 7 }, { header: '备注', key: 'note', width: 22 }];
  db.prepare(`SELECT e.*, m.match_number, m.match_date, t.name tn, p.jersey_number, p.name pn
    FROM match_events e JOIN matches m ON e.match_id=m.id LEFT JOIN teams t ON e.team_id=t.id LEFT JOIN players p ON e.player_id=p.id
    WHERE e.event_type IN ('yellow','red') ORDER BY m.match_number, e.minute`).all()
    .forEach(e => ws.addRow({ num: e.gender === 'women' ? e.match_number - 100 : e.match_number, date: e.match_date,
      team: e.tn, jnum: e.jersey_number, name: e.pn,
      card: e.event_type === 'yellow' ? '黄牌' : '红牌', min: e.minute, note: e.notes || '' }));
  head(ws);

  // 6 比赛事件流水
  ws = wb.addWorksheet('比赛事件流水');
  ws.columns = [{ header: '场序', key: 'num', width: 8 }, { header: '分钟', key: 'min', width: 7 }, { header: '事件', key: 'type', width: 9 },
    { header: '球队', key: 'team', width: 16 }, { header: '球员', key: 'name', width: 12 },
    { header: '换上', key: 'sub', width: 11 }, { header: '备注', key: 'note', width: 22 }];
  const TYPE_CN = { goal: '进球', own_goal: '乌龙', yellow: '黄牌', red: '红牌', sub: '换人' };
  db.prepare(`SELECT e.*, m.match_number, m.gender, t.name tn, p.name pn, p2.name subn FROM match_events e
    JOIN matches m ON e.match_id=m.id LEFT JOIN teams t ON e.team_id=t.id LEFT JOIN players p ON e.player_id=p.id
    LEFT JOIN players p2 ON e.sub_in_player_id=p2.id ORDER BY m.match_number, e.minute, e.id`).all()
    .forEach(e => ws.addRow({ num: e.gender === 'women' ? e.match_number - 100 : e.match_number, min: e.minute,
      type: TYPE_CN[e.event_type] || e.event_type, team: e.tn, name: e.pn, sub: e.subn || '', note: e.notes || '' }));
  head(ws);

  // 7 裁判执法
  ws = wb.addWorksheet('裁判执法');
  ws.columns = [{ header: '场序', key: 'num', width: 8 }, { header: '日期', key: 'date', width: 12 },
    { header: '一方', key: 't1', width: 16 }, { header: '另一方', key: 't2', width: 16 },
    { header: '主裁判', key: 'main', width: 11 }, { header: '助理1', key: 'a1', width: 11 },
    { header: '助理2', key: 'a2', width: 11 }, { header: '第四官员', key: 'fourth', width: 10 }];
  const rname = id => id ? (db.prepare('SELECT name FROM referees WHERE id=?').get(id)?.name || '') : '';
  db.prepare('SELECT * FROM matches ORDER BY match_number').all().forEach(m => ws.addRow({
    num: m.gender === 'women' ? m.match_number - 100 : m.match_number, date: m.match_date,
    t1: teamName(m.team1_id), t2: teamName(m.team2_id), main: rname(m.main_referee_id),
    a1: rname(m.assistant_ref1_id), a2: rname(m.assistant_ref2_id), fourth: rname(m.fourth_official_id) }));
  head(ws);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('校园足球赛事归档')}_${BJ().slice(0,10)}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});
// ========== 表演赛（正赛前；管理员填报双方人员；只统计基本信息/比分/点球/事件，不计正赛积分/排名/射手/停赛）==========
function exhTeamNameById(id) {
  const t = id && db.prepare('SELECT name FROM teams WHERE id=?').get(id);
  return t ? t.name : '';
}
function exhibitionSideName(x, side) {
  if (side === 1) return x.team1_id ? exhTeamNameById(x.team1_id) : (x.team1_custom || '待定');
  return x.team2_id ? exhTeamNameById(x.team2_id) : (x.team2_custom || '待定');
}
function exhibitionRefName(id) {
  return id ? (db.prepare('SELECT name FROM referees WHERE id=?').get(id)?.name || '') : '';
}
function serializeExhibition(x) {
  const out = { ...x };
  out.team1_name = exhibitionSideName(x, 1);
  out.team2_name = exhibitionSideName(x, 2);
  out.main_referee_name = exhibitionRefName(x.main_referee_id);
  out.assistant_ref1_name = exhibitionRefName(x.assistant_ref1_id);
  out.assistant_ref2_name = exhibitionRefName(x.assistant_ref2_id);
  out.players = db.prepare('SELECT * FROM exhibition_players WHERE match_id=? ORDER BY side,jersey_number,id').all(x.id);
  out.events = db.prepare('SELECT * FROM exhibition_events WHERE match_id=? ORDER BY minute,id').all(x.id);
  out.penalties = db.prepare('SELECT * FROM exhibition_penalties WHERE match_id=? ORDER BY side,kick_order,id').all(x.id);
  return out;
}

// 表演赛列表（公开）
app.get('/api/exhibition', (req, res) => {
  const rows = db.prepare("SELECT * FROM exhibition_matches ORDER BY (match_date=''),match_date,(match_time=''),match_time,id").all();
  res.json(rows.map(serializeExhibition));
});

// 表演赛详情（公开）
app.get('/api/exhibition/:id', (req, res) => {
  const x = db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(req.params.id);
  if (!x) return res.status(404).json({ error: '表演赛不存在' });
  res.json(serializeExhibition(x));
});

// 表单校验
function parseExhibitionBody(body) {
  const gender = body.gender === 'women' ? 'women' : 'men';
  const team1_id = body.team1_id ? +body.team1_id : null;
  const team2_id = body.team2_id ? +body.team2_id : null;
  const team1_custom = (body.team1_custom || '').toString().trim().slice(0, 30);
  const team2_custom = (body.team2_custom || '').toString().trim().slice(0, 30);
  const match_date = (body.match_date || '').toString().trim();
  const match_time = (body.match_time || '').toString().trim();
  const match_location = (body.match_location || '三期操场').toString().trim().slice(0, 30) || '三期操场';
  const main_referee_id = body.main_referee_id ? +body.main_referee_id : null;
  const assistant_ref1_id = body.assistant_ref1_id ? +body.assistant_ref1_id : null;
  const assistant_ref2_id = body.assistant_ref2_id ? +body.assistant_ref2_id : null;
  const notes = (body.notes || '').toString().trim().slice(0, 500);
  if (!team1_id && !team1_custom) return { error: '请选择一方球队或填写队名' };
  if (!team2_id && !team2_custom) return { error: '请选择另一方球队或填写队名' };
  if (match_date && !/^\d{4}-\d{2}-\d{2}$/.test(match_date)) return { error: '比赛日期格式不正确' };
  if (match_time && !/^\d{2}:\d{2}$/.test(match_time)) return { error: '比赛时间格式不正确' };
  const refIds = [main_referee_id, assistant_ref1_id, assistant_ref2_id].filter(Boolean);
  if (new Set(refIds).size !== refIds.length) return { error: '同一名裁判不能在同一场表演赛中担任多个职位' };
  return { data: { gender, team1_id, team1_custom, team2_id, team2_custom, match_date, match_time, match_location, main_referee_id, assistant_ref1_id, assistant_ref2_id, notes } };
}

// 新增（管理员）
app.post('/api/exhibition', requireAdmin, (req, res) => {
  const r = parseExhibitionBody(req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  const d = r.data;
  const info = db.prepare(`INSERT INTO exhibition_matches
    (gender,team1_id,team1_custom,team2_id,team2_custom,match_date,match_time,match_location,
     main_referee_id,assistant_ref1_id,assistant_ref2_id,notes,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(d.gender,d.team1_id,d.team1_custom,d.team2_id,d.team2_custom,d.match_date,d.match_time,d.match_location,
         d.main_referee_id,d.assistant_ref1_id,d.assistant_ref2_id,d.notes,BJ());
  const x = db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(info.lastInsertRowid);
  logOperation(req,'create_exhibition','exhibition',x.id,{vs:`${exhibitionSideName(x,1)} vs ${exhibitionSideName(x,2)}`});
  broadcastUpdate('exhibition',{});
  res.status(201).json(serializeExhibition(x));
});

// 编辑基本信息（管理员；已结束需先重置）
app.put('/api/exhibition/:id', requireAdmin, (req, res) => {
  const x0 = db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(req.params.id);
  if (!x0) return res.status(404).json({ error: '表演赛不存在' });
  if (x0.status === 'finished') return res.status(400).json({ error: '已结束的表演赛不能直接编辑，请先重置为未开始' });
  const r = parseExhibitionBody(req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  const d = r.data;
  db.prepare(`UPDATE exhibition_matches SET gender=?,team1_id=?,team1_custom=?,team2_id=?,team2_custom=?,
    match_date=?,match_time=?,match_location=?,main_referee_id=?,assistant_ref1_id=?,assistant_ref2_id=?,notes=?,updated_at=? WHERE id=?`)
    .run(d.gender,d.team1_id,d.team1_custom,d.team2_id,d.team2_custom,d.match_date,d.match_time,d.match_location,
         d.main_referee_id,d.assistant_ref1_id,d.assistant_ref2_id,d.notes,BJ(),x0.id);
  const x = db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(x0.id);
  logOperation(req,'update_exhibition','exhibition',x.id,{});
  broadcastUpdate('exhibition',{});
  res.json(serializeExhibition(x));
});

// 删除（管理员）
app.delete('/api/exhibition/:id', requireAdmin, (req, res) => {
  const x = db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(req.params.id);
  if (!x) return res.status(404).json({ error: '表演赛不存在' });
  db.prepare('DELETE FROM exhibition_events WHERE match_id=?').run(x.id);
  db.prepare('DELETE FROM exhibition_penalties WHERE match_id=?').run(x.id);
  db.prepare('DELETE FROM exhibition_players WHERE match_id=?').run(x.id);
  db.prepare('DELETE FROM exhibition_matches WHERE id=?').run(x.id);
  logOperation(req,'delete_exhibition','exhibition',x.id,{});
  broadcastUpdate('exhibition',{});
  res.json({ ok: true });
});

// 保存某一方人员名单（管理员；先校验再事务替换，校验失败不影响原名单）
app.put('/api/exhibition/:id/roster', requireAdmin, (req, res) => {
  const x = db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(req.params.id);
  if (!x) return res.status(404).json({ error: '表演赛不存在' });
  const side = +req.body.side === 2 ? 2 : 1;
  const list = Array.isArray(req.body.players) ? req.body.players : [];
  if (list.length > 30) return res.status(400).json({ error: '每方参赛人员不超过30人' });
  const teamId = side === 1 ? x.team1_id : x.team2_id;
  // 1) 先校验并构建记录（不写库）
  const rows = [];
  for (const p of list) {
    let playerId = null, name = '', num = 0;
    if (teamId && p.player_id) {
      const pl = db.prepare('SELECT id,name,jersey_number FROM players WHERE id=? AND team_id=? AND deleted_at IS NULL').get(+p.player_id, teamId);
      if (!pl) return res.status(400).json({ error: '所选球员不属于该球队' });
      playerId = pl.id; name = pl.name; num = pl.jersey_number || 0;
    } else {
      name = (p.name || '').toString().trim().slice(0, 20);
      num = Number.isFinite(+p.jersey_number) ? Math.min(99, Math.max(0, +p.jersey_number)) : 0;
      if (!name) return res.status(400).json({ error: '请填写每位参赛人员姓名' });
    }
    rows.push({ playerId, name, num });
  }
  // 2) 校验通过，事务内原子替换
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM exhibition_players WHERE match_id=? AND side=?').run(x.id, side);
    const ins = db.prepare('INSERT INTO exhibition_players (match_id,side,team_id,player_id,name,jersey_number) VALUES (?,?,?,?,?,?)');
    for (const r0 of rows) ins.run(x.id, side, teamId, r0.playerId, r0.name, r0.num);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ error: '名单保存失败' });
  }
  broadcastUpdate('exhibition',{});
  res.json(serializeExhibition(db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(x.id)));
});

// 录入全场比分（管理员；进入可录点球阶段）
app.post('/api/exhibition/:id/score', requireAdmin, (req, res) => {
  const x = db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(req.params.id);
  if (!x) return res.status(404).json({ error: '表演赛不存在' });
  const s1 = parseInt(req.body.team1_score, 10), s2 = parseInt(req.body.team2_score, 10);
  if (!Number.isFinite(s1) || !Number.isFinite(s2) || s1 < 0 || s2 < 0 || s1 > 99 || s2 > 99)
    return res.status(400).json({ error: '比分需为 0-99 的整数' });
  db.prepare("UPDATE exhibition_matches SET team1_score=?,team2_score=?,status='live',updated_at=? WHERE id=?")
    .run(s1,s2,BJ(),x.id);
  broadcastUpdate('exhibition',{});
  res.json(serializeExhibition(db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(x.id)));
});

// 添加事件（管理员）
const EXH_EVENT_TYPES = ['goal','own_goal','yellow','red','sub','other'];
app.post('/api/exhibition/:id/events', requireAdmin, (req, res) => {
  const x = db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(req.params.id);
  if (!x) return res.status(404).json({ error: '表演赛不存在' });
  const event_type = EXH_EVENT_TYPES.includes(req.body.event_type) ? req.body.event_type : 'other';
  const side = +req.body.side === 2 ? 2 : 1;
  const minute = Number.isFinite(+req.body.minute) ? Math.min(130,Math.max(0,+req.body.minute)) : 0;
  const description = (req.body.description||'').toString().trim().slice(0,200);
  let rosterId = null, subRosterId = null;
  if (req.body.roster_id) {
    const rp = db.prepare('SELECT id FROM exhibition_players WHERE id=? AND match_id=? AND side=?').get(+req.body.roster_id,x.id,side);
    if (!rp) return res.status(400).json({error:'事件球员不在该方名单内'});
    rosterId = rp.id;
  }
  if (event_type === 'sub' && req.body.sub_roster_id) {
    const rp = db.prepare('SELECT id FROM exhibition_players WHERE id=? AND match_id=? AND side=?').get(+req.body.sub_roster_id,x.id,side);
    if (!rp) return res.status(400).json({error:'换上球员不在该方名单内'});
    subRosterId = rp.id;
  }
  db.prepare('INSERT INTO exhibition_events (match_id,event_type,side,roster_id,sub_roster_id,minute,description) VALUES (?,?,?,?,?,?,?)')
    .run(x.id,event_type,side,rosterId,subRosterId,minute,description);
  broadcastUpdate('exhibition',{});
  res.status(201).json(serializeExhibition(db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(x.id)));
});

// 删除事件（管理员）
app.delete('/api/exhibition/:id/events/:eid', requireAdmin, (req, res) => {
  const x = db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(req.params.id);
  if (!x) return res.status(404).json({ error: '表演赛不存在' });
  db.prepare('DELETE FROM exhibition_events WHERE id=? AND match_id=?').run(req.params.eid,x.id);
  broadcastUpdate('exhibition',{});
  res.json({ok:true});
});

// 添加点球（管理员；无论比分如何都踢点球）
app.post('/api/exhibition/:id/penalties', requireAdmin, (req, res) => {
  const x = db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(req.params.id);
  if (!x) return res.status(404).json({ error: '表演赛不存在' });
  const side = +req.body.side === 2 ? 2 : 1;
  const scored = req.body.scored ? 1 : 0;
  let rosterId = null;
  if (req.body.roster_id) {
    const rp = db.prepare('SELECT id FROM exhibition_players WHERE id=? AND match_id=? AND side=?').get(+req.body.roster_id,x.id,side);
    if (!rp) return res.status(400).json({error:'点球球员不在该方名单内'});
    rosterId = rp.id;
  }
  const order = db.prepare('SELECT COUNT(*) c FROM exhibition_penalties WHERE match_id=? AND side=?').get(x.id,side).c + 1;
  db.prepare('INSERT INTO exhibition_penalties (match_id,side,roster_id,scored,kick_order) VALUES (?,?,?,?,?)')
    .run(x.id,side,rosterId,scored,order);
  broadcastUpdate('exhibition',{});
  res.status(201).json(serializeExhibition(db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(x.id)));
});

// 删除点球（管理员）
app.delete('/api/exhibition/:id/penalties/:pid', requireAdmin, (req, res) => {
  const x = db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(req.params.id);
  if (!x) return res.status(404).json({ error: '表演赛不存在' });
  db.prepare('DELETE FROM exhibition_penalties WHERE id=? AND match_id=?').run(req.params.pid,x.id);
  broadcastUpdate('exhibition',{});
  res.json({ok:true});
});

// 结束并统计（管理员；汇总点球比分、判定点球胜方）
app.post('/api/exhibition/:id/finish', requireAdmin, (req, res) => {
  const x = db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(req.params.id);
  if (!x) return res.status(404).json({ error: '表演赛不存在' });
  if (x.team1_score == null || x.team2_score == null) return res.status(400).json({ error: '请先录入全场比分' });
  const pens = db.prepare('SELECT side,scored FROM exhibition_penalties WHERE match_id=?').all(x.id);
  const p1 = pens.filter(p=>p.side===1 && p.scored).length;
  const p2 = pens.filter(p=>p.side===2 && p.scored).length;
  if (p1 === p2) return res.status(400).json({ error: '点球比分相同，请继续补罚直至分出胜负' });
  const winnerSide = p1 > p2 ? 1 : 2;
  db.prepare("UPDATE exhibition_matches SET penalty_team1=?,penalty_team2=?,penalty_winner_side=?,status='finished',finished_at=COALESCE(finished_at,?),updated_at=? WHERE id=?")
    .run(p1,p2,winnerSide,BJ(),BJ(),x.id);
  logOperation(req,'finish_exhibition','exhibition',x.id,{score:`${x.team1_score}:${x.team2_score}`,pen:`${p1}:${p2}`});
  broadcastUpdate('exhibition',{});
  res.json(serializeExhibition(db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(x.id)));
});

// 重置为未开始（管理员；保留人员名单，清比分/点球/事件）
app.post('/api/exhibition/:id/reopen', requireAdmin, (req, res) => {
  const x = db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(req.params.id);
  if (!x) return res.status(404).json({ error: '表演赛不存在' });
  db.prepare("UPDATE exhibition_matches SET status='pending',team1_score=NULL,team2_score=NULL,penalty_team1=0,penalty_team2=0,penalty_winner_side=NULL,finished_at=NULL,updated_at=? WHERE id=?")
    .run(BJ(),x.id);
  db.prepare('DELETE FROM exhibition_events WHERE match_id=?').run(x.id);
  db.prepare('DELETE FROM exhibition_penalties WHERE match_id=?').run(x.id);
  broadcastUpdate('exhibition',{});
  res.json(serializeExhibition(db.prepare('SELECT * FROM exhibition_matches WHERE id=?').get(x.id)));
});


// ========== 裁判员端 ==========
const REPORT_EDIT_WINDOW_MS = 60 * 60 * 1000; // 提交后1小时内可自行修改

// 当前登录裁判档案
function getSessionReferee(req) {
  return db.prepare('SELECT * FROM referees WHERE user_id=?').get(req.session.user.id);
}
// 裁判在某场比赛中的角色
function roleInMatch(match, refereeId) {
  if (!match || !refereeId) return null;
  if (+match.main_referee_id === +refereeId) return 'main';
  if (+match.assistant_ref1_id === +refereeId) return 'assistant1';
  if (+match.assistant_ref2_id === +refereeId) return 'assistant2';
  if (+match.fourth_official_id === +refereeId) return 'fourth';
  return null;
}
const ROLE_LABEL = { main: '主裁判', assistant1: '助理裁判1', assistant2: '助理裁判2', fourth: '第四官员' };

// ========== 裁判辅助选派：专职类型 / 可担任位置 / 执法评估 / 智能推荐 ==========
function refSpecType(r) {
  if (!r) return '';
  if (r.ref_type) return r.ref_type;
  if (r.is_main_ref) return 'main';
  if (r.is_assistant_ref) return 'assistant';
  return '';
}
function refCanFill(r, slot) {
  const s = refSpecType(r);
  if (!s) return true; // 通用裁判可担任任意位置
  if (slot === 'main') return s === 'main';
  if (slot === 'assistant1' || slot === 'assistant2') return s === 'assistant';
  if (slot === 'fourth') return s === 'fourth';
  return false;
}
const SLOT_LABEL = { main: '主裁判', assistant1: '助理裁判1', assistant2: '助理裁判2', fourth: '第四官员' };
// 裁判执法评估（客观统计 + 参考综合分，不做自动升降级/处罚）
function refEvaluation(refId) {
  const finished = db.prepare(`SELECT * FROM matches WHERE status='finished' AND
    (main_referee_id=? OR assistant_ref1_id=? OR assistant_ref2_id=? OR fourth_official_id=?)`).all(refId, refId, refId, refId);
  let mainTotal = 0, mainSubmitted = 0, mainOnTime = 0;
  for (const m of finished) {
    if (roleInMatch(m, refId) === 'main') {
      mainTotal++;
      const rep = db.prepare("SELECT status,submitted_at FROM referee_reports WHERE match_id=?").get(m.id);
      if (rep && rep.status === 'submitted' && rep.submitted_at) {
        mainSubmitted++;
        if (m.finished_at && (new Date(rep.submitted_at) - new Date(m.finished_at)) <= 24 * 3600 * 1000) mainOnTime++;
      }
    }
  }
  // 赛前请假次数
  const leaves = db.prepare("SELECT COUNT(*) as c FROM match_ref_confirm WHERE referee_id=? AND status='leave'").get(refId).c;
  const onTimeRate = mainSubmitted ? Math.round(mainOnTime / mainSubmitted * 100) : null;
  // 参考综合分（0-100）：基础80，报告及时率加分，请假减分
  let score = 80;
  if (onTimeRate !== null) score += (onTimeRate - 80) * 0.1;
  score -= leaves * 2;
  score = Math.max(40, Math.min(100, Math.round(score)));
  return { total_finished: finished.length, main_total: mainTotal, report_submitted: mainSubmitted,
    report_on_time: mainOnTime, on_time_rate: onTimeRate, leaves, eval_score: score };
}
// 等级加分
function levelBonus(level) {
  const s = String(level || '');
  if (/国家|国际/.test(s)) return 4;
  if (/一级|1级/.test(s)) return 3;
  if (/二级|2级/.test(s)) return 2;
  if (/三级|3级/.test(s)) return 1;
  return 0;
}
function buildRefRecommend(match) {
  const refs = db.prepare('SELECT * FROM referees WHERE deleted_at IS NULL ORDER BY serial_number').all();
  const t1 = match.team1_id ? db.prepare('SELECT name FROM teams WHERE id=?').get(match.team1_id) : null;
  const t2 = match.team2_id ? db.prepare('SELECT name FROM teams WHERE id=?').get(match.team2_id) : null;
  const colleges = [t1?.name, t2?.name].filter(Boolean);
  const slots = ['main', 'assistant1', 'assistant2', 'fourth'];
  const occupied = [match.main_referee_id, match.assistant_ref1_id, match.assistant_ref2_id, match.fourth_official_id].filter(Boolean).map(Number);
  const sameDay = match.match_date ? db.prepare('SELECT * FROM matches WHERE match_date=? AND id!=?').all(match.match_date, match.id) : [];
  const out = {};
  const auto = {};
  for (const slot of slots) {
    const arr = [];
    for (const r of refs) {
      if (!refCanFill(r, slot)) continue;
      const tags = [], warns = [];
      const sameCollege = r.college && colleges.includes(r.college);
      if (sameCollege) warns.push(`与对阵球队同学院（${r.college}），建议回避`);
      let dayLoad = 0, conflict = null;
      for (const om of sameDay) {
        const orole = roleInMatch(om, r.id);
        if (!orole) continue;
        dayLoad++;
        if (match.match_time && om.match_time) {
          const a = timeToMin(match.match_time), b = timeToMin(om.match_time);
          if (a !== null && b !== null && Math.abs(a - b) < 120) conflict = `与场序${om.match_number}间隔不足2小时`;
        }
      }
      if (conflict) warns.push(conflict);
      const ev = refEvaluation(r.id);
      let score = 50 + levelBonus(r.level) * 2;
      if (ev.on_time_rate !== null) score += (ev.on_time_rate - 80) * 0.08;
      score -= dayLoad * 6;
      score -= ev.leaves * 1.5;
      if (sameCollege) score -= 3;
      if (conflict) score -= 20;
      score += Math.min(ev.total_finished, 10) * 0.6;
      score = Math.round(score * 10) / 10;
      if (dayLoad > 0) tags.push(`当日已排${dayLoad}场`);
      if (ev.total_finished > 0) tags.push(`执法${ev.total_finished}场`);
      if (ev.on_time_rate === 100) tags.push('报告全及时');
      arr.push({ id: r.id, name: r.name, serial_number: r.serial_number, college: r.college, level: r.level,
        spec: refSpecType(r), score, tags, warns, conflict: !!conflict, eval: ev, occupied_here: occupied.includes(r.id) });
    }
    arr.sort((a, b) => b.score - a.score);
    out[slot] = arr;
    const best = arr.find(x => !x.conflict && !x.occupied_here);
    if (best) auto[slot] = best.id;
  }
  return { slots: out, auto, slotLabels: SLOT_LABEL };
}
app.get('/api/referees/recommend', requireAdmin, (req, res) => {
  const matchId = Number(req.query.match_id);
  if (!Number.isInteger(matchId) || matchId <= 0) return res.status(400).json({ error: '缺少比赛标识（match_id）' });
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  res.json(buildRefRecommend(match));
});

// 组装报告（含事件、球员/球队名称）
function loadFullReport(matchId) {
  const report = db.prepare('SELECT * FROM referee_reports WHERE match_id=?').get(matchId);
  if (!report) return null;
  report.events = db.prepare(`SELECT re.*, t.name as team_name, p.name as player_name, p.jersey_number,
    p2.name as sub_in_name, p2.jersey_number as sub_in_number
    FROM referee_report_events re
    LEFT JOIN teams t ON re.team_id=t.id
    LEFT JOIN players p ON re.player_id=p.id
    LEFT JOIN players p2 ON re.sub_in_player_id=p2.id
    WHERE re.report_id=? ORDER BY re.minute, re.id`).all(report.id);
  const ref = db.prepare('SELECT name FROM referees WHERE user_id=?').get(report.referee_id);
  report.referee_name = ref ? ref.name : '';
  return report;
}

// 裁判个人信息
app.get('/api/referee/me', requireReferee, (req, res) => {
  const referee = getSessionReferee(req);
  if (!referee) return res.status(404).json({ error: '裁判档案不存在，请联系管理员' });
  res.json(referee);
});

// 我的执法：只返回指派给当前裁判的比赛
app.get('/api/referee/my-matches', requireReferee, (req, res) => {
  const referee = getSessionReferee(req);
  if (!referee) return res.json([]);
  const list = db.prepare(`SELECT * FROM matches
    WHERE main_referee_id=? OR assistant_ref1_id=? OR assistant_ref2_id=? OR fourth_official_id=?
    ORDER BY match_date, match_time`).all(referee.id, referee.id, referee.id, referee.id);

  list.forEach(m => {
    m.role = roleInMatch(m, referee.id);
    m.role_label = ROLE_LABEL[m.role] || '';
    if (m.team1_id) m.team1 = db.prepare('SELECT id,name,logo_path FROM teams WHERE id=?').get(m.team1_id);
    if (m.team2_id) m.team2 = db.prepare('SELECT id,name,logo_path FROM teams WHERE id=?').get(m.team2_id);
    const rep = db.prepare('SELECT status,submitted_at FROM referee_reports WHERE match_id=?').get(m.id);
    m.report_status = rep ? rep.status : 'none';
    m.report_submitted_at = rep ? rep.submitted_at : null;
    const cf = db.prepare('SELECT status,note FROM match_ref_confirm WHERE match_id=? AND referee_id=?').get(m.id, referee.id);
    m.confirm_status = cf ? cf.status : 'pending';
    m.confirm_note = cf ? cf.note : '';
  });
  list.sort((a, b) => {
    const ka = (a.match_date || '9999') + ' ' + (a.match_time || '99:99');
    const kb = (b.match_date || '9999') + ' ' + (b.match_time || '99:99');
    return ka === kb ? 0 : (ka < kb ? -1 : 1);
  });
  res.json(list);
});

// B7 裁判提交赛前执法确认（confirmed确认执法 / leave请假）
app.post('/api/matches/:id/confirm', requireReferee, (req, res) => {
  const referee = getSessionReferee(req);
  if (!referee) return res.status(404).json({ error: '裁判档案不存在' });
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(req.params.id);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  if (!roleInMatch(match, referee.id)) return res.status(403).json({ error: '您未被指派执法本场比赛' });
  const { status, note } = req.body;
  if (!['confirmed', 'leave', 'pending'].includes(status)) return res.status(400).json({ error: '确认状态无效' });
  db.prepare(`INSERT INTO match_ref_confirm (match_id,referee_id,status,note,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(match_id,referee_id) DO UPDATE SET status=excluded.status,note=excluded.note,updated_at=excluded.updated_at`)
    .run(match.id, referee.id, status, note || '', BJ());
  logOperation(req, 'ref_confirm_' + status, 'match', match.id, { referee: referee.name });
  // 请假时通知所有管理员，便于改派
  if (status === 'leave') {
    sendMessageToAllAdmins({
      title: '裁判请假提醒',
      content: `裁判 ${referee.name}（${ROLE_LABEL[roleInMatch(match, referee.id)] || ''}）对场序${match.match_number}（${match.match_date||''} ${match.match_time||''}）选择请假${note ? '，原因：' + note : ''}，请及时改派。`,
      type: 'referee_leave', relatedType: 'match', relatedId: match.id
    });
  }
  broadcastUpdate('matches', {});
  res.json({ ok: true });
});

// B8 裁判执法档案：场次/角色分布/出示红黄牌/主裁报告24h及时率/执法记录
app.get('/api/referees/:id/profile', requireAuth, (req, res) => {
  const ref = db.prepare('SELECT * FROM referees WHERE id=?').get(req.params.id);
  if (!ref) return res.status(404).json({ error: '裁判不存在' });
  const finished = db.prepare(`SELECT * FROM matches WHERE status='finished' AND
    (main_referee_id=? OR assistant_ref1_id=? OR assistant_ref2_id=? OR fourth_official_id=?)
    ORDER BY match_date`).all(ref.id, ref.id, ref.id, ref.id);
  const roleCount = { main: 0, assistant: 0, fourth: 0 };
  let yellow = 0, red = 0, goals = 0;
  const records = [];
  for (const m of finished) {
    const role = roleInMatch(m, ref.id);
    if (role === 'main') roleCount.main++;

    else if (role === 'fourth') roleCount.fourth++;
    else roleCount.assistant++;
    const evs = db.prepare("SELECT event_type FROM match_events WHERE match_id=?").all(m.id);
    const y = evs.filter(e => e.event_type === 'yellow').length;
    const r = evs.filter(e => e.event_type === 'red').length;
    const g = evs.filter(e => e.event_type === 'goal').length;
    yellow += y; red += r; goals += g;
    const t1 = m.team1_id ? db.prepare('SELECT name FROM teams WHERE id=?').get(m.team1_id)?.name : '待定';
    const t2 = m.team2_id ? db.prepare('SELECT name FROM teams WHERE id=?').get(m.team2_id)?.name : '待定';
    const rep = db.prepare('SELECT status,submitted_at FROM referee_reports WHERE match_id=?').get(m.id);
    records.push({ match_number: m.match_number, round_name: m.round_name, t1, t2, role, role_label: ROLE_LABEL[role], y, r,
      report_status: rep ? rep.status : 'none', submitted_at: rep ? rep.submitted_at : null, finished_at: m.finished_at,
      match_date: m.match_date });
  }
  // 主裁报告24h及时率
  const mainRecords = records.filter(x => x.role === 'main');
  let onTime = 0, submitted = 0;
  mainRecords.forEach(x => {
    if (x.report_status === 'submitted' && x.submitted_at) {
      submitted++;
      const fin = x.finished_at ? new Date(x.finished_at).getTime() : null;
      if (fin && (new Date(x.submitted_at).getTime() - fin) <= 24 * 3600 * 1000) onTime++;
    }
  });
  const evalExtra = refEvaluation(ref.id);
  res.json({
    referee: { id: ref.id, name: ref.name, serial_number: ref.serial_number, level: ref.level, college: ref.college, ref_type: ref.ref_type, fair_play_path: ref.fair_play_path || '' },
    total_finished: finished.length, role_count: roleCount, yellow, red, goals,
    main_total: mainRecords.length, report_submitted: submitted, report_on_time: onTime,
    leaves: evalExtra.leaves, eval_score: evalExtra.eval_score,

    records
  });
});

// 获取报告：主裁返回完整内容，助理/第四官员仅返回状态
app.get('/api/referee/reports/:matchId', requireReferee, (req, res) => {
  const referee = getSessionReferee(req);
  if (!referee) return res.status(404).json({ error: '裁判档案不存在' });
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(req.params.matchId);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  const role = roleInMatch(match, referee.id);
  if (!role) return res.status(403).json({ error: '您未被指派执法本场比赛' });
  const report = loadFullReport(match.id);
  if (role !== 'main') {
    // 助理/第四官员只能看到主裁提交状态
    return res.json({ role, is_main: false, status: report ? report.status : 'none', submitted_at: report ? report.submitted_at : null });
  }
  // 判断是否仍在可修改窗口
  let withinEditWindow = false;
  if (report && report.status === 'submitted' && report.submitted_at) {
    withinEditWindow = (Date.now() - new Date(report.submitted_at).getTime()) <= REPORT_EDIT_WINDOW_MS;
  }
  res.json({ role, is_main: true, report, withinEditWindow });
});

// 保存草稿 / 提交报告
app.post('/api/referee/reports/:matchId', requireReferee, (req, res) => {
  const referee = getSessionReferee(req);
  if (!referee) return res.status(404).json({ error: '裁判档案不存在' });
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(req.params.matchId);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  if (roleInMatch(match, referee.id) !== 'main') return res.status(403).json({ error: '只有本场主裁判可以填写裁判报告' });

  const { action, team1_score, team2_score, has_penalty, penalty_team1, penalty_team2,
    discipline, incidents, confirmed, events } = req.body;
  const isSubmit = action === 'submit';

  if (isSubmit) {
    if (match.status !== 'finished') return res.status(400).json({ error: '只有比赛结束后才能提交裁判报告，可先保存草稿' });
    if (!confirmed) return res.status(400).json({ error: '请勾选“本人确认以上记录属实”后再提交' });
    if (team1_score === null || team1_score === undefined || team2_score === null || team2_score === undefined) {
      return res.status(400).json({ error: '请填写双方最终比分' });
    }
    // 比分非负整数校验（与正式比分接口一致，防止采纳时脏比分同步到比赛）
    const isNNI = v => Number.isInteger(+v) && +v >= 0 && +v <= 99 && String(v).trim() !== '';
    if (!isNNI(team1_score) || !isNNI(team2_score)) return res.status(400).json({ error: '比分必须为0-99的非负整数' });
    if (has_penalty && (penalty_team1 !== null && penalty_team1 !== undefined && penalty_team1 !== '') &&
        (!isNNI(penalty_team1) || !isNNI(penalty_team2))) return res.status(400).json({ error: '点球比分必须为0-99的非负整数' });
    // 胜负一致性：淘汰赛不允许平局；点球仅在平局时进行且点球比分必须不同
    const repOutcomeErr = validateScoreOutcome({
      team1_score: +team1_score, team2_score: +team2_score,
      has_penalty,
      penalty_team1: (penalty_team1 === null || penalty_team1 === undefined || penalty_team1 === '') ? null : +penalty_team1,
      penalty_team2: (penalty_team2 === null || penalty_team2 === undefined || penalty_team2 === '') ? null : +penalty_team2,
    });
    if (repOutcomeErr) return res.status(400).json({ error: repOutcomeErr });
  }

  const existing = db.prepare('SELECT * FROM referee_reports WHERE match_id=?').get(match.id);
  // 已提交且超过1小时、且未被管理员退回 → 禁止修改
  if (existing && existing.status === 'submitted' && existing.submitted_at) {
    const elapsed = Date.now() - new Date(existing.submitted_at).getTime();
    if (elapsed > REPORT_EDIT_WINDOW_MS) {
      return res.status(403).json({ error: '报告提交已超过1小时并锁定，如需修改请联系管理员退回' });
    }
  }

  // 清洗事件
  const cleanEvents = [];
  if (Array.isArray(events)) {
    for (const e of events) {
      if (!['goal', 'own_goal', 'assist', 'yellow', 'red', 'sub'].includes(e.event_type)) continue;
      cleanEvents.push({
        event_type: e.event_type,
        team_id: e.team_id ? +e.team_id : null,
        player_id: e.player_id ? +e.player_id : null,
        minute: Math.max(0, Math.min(130, +e.minute || 0)),
        detail: String(e.detail || '').slice(0, 60),
        sub_in_player_id: e.sub_in_player_id ? +e.sub_in_player_id : null,
        notes: String(e.notes || '').slice(0, 100),
      });
    }
  }
  const disc = String(discipline || '').slice(0, 3000);
  const inci = String(incidents || '').slice(0, 3000);

  let reportId;
  let newStatus = isSubmit ? 'submitted' : 'draft';
  let submittedAt = existing && existing.submitted_at ? existing.submitted_at : null;
  if (isSubmit) {
    // 管理员退回后重新提交，刷新1小时窗口
    if (!existing || existing.status === 'returned' || !existing.submitted_at) {
      submittedAt = BJ();
    }
  }
  const nowStr = BJ();

  try {
    db.exec('BEGIN');
    if (existing) {
      // 退回后再存草稿回到 draft；提交则 submitted
      if (!isSubmit && existing.status === 'returned') newStatus = 'draft';
      db.prepare(`UPDATE referee_reports SET team1_score=?,team2_score=?,has_penalty=?,penalty_team1=?,penalty_team2=?,
        discipline=?,incidents=?,status=?,confirmed=?,submitted_at=?,returned_at=NULL,updated_at=? WHERE id=?`)
        .run(
          team1_score===''||team1_score==null?null:+team1_score,
          team2_score===''||team2_score==null?null:+team2_score,
          has_penalty?1:0,
          penalty_team1===''||penalty_team1==null?null:+penalty_team1,
          penalty_team2===''||penalty_team2==null?null:+penalty_team2,
          disc, inci, newStatus, isSubmit?1:0, submittedAt, nowStr, existing.id);
      reportId = existing.id;
      db.prepare('DELETE FROM referee_report_events WHERE report_id=?').run(reportId);
    } else {
      const r = db.prepare(`INSERT INTO referee_reports
        (match_id,referee_id,team1_score,team2_score,has_penalty,penalty_team1,penalty_team2,discipline,incidents,status,confirmed,submitted_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        match.id, referee.user_id,
        team1_score===''||team1_score==null?null:+team1_score,
        team2_score===''||team2_score==null?null:+team2_score,
        has_penalty?1:0,
        penalty_team1===''||penalty_team1==null?null:+penalty_team1,
        penalty_team2===''||penalty_team2==null?null:+penalty_team2,
        disc, inci, newStatus, isSubmit?1:0, submittedAt, nowStr);
      reportId = r.lastInsertRowid;
    }
    const insEv = db.prepare(`INSERT INTO referee_report_events
      (report_id,event_type,team_id,player_id,minute,detail,sub_in_player_id,notes) VALUES (?,?,?,?,?,?,?,?)`);
    cleanEvents.forEach(e => insEv.run(reportId, e.event_type, e.team_id, e.player_id, e.minute, e.detail, e.sub_in_player_id, e.notes));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: '保存失败：' + e.message });
  }

  if (isSubmit) {
    logOperation(req, 'submit_referee_report', 'match', match.id, { match_number: match.match_number, events: cleanEvents.length });
    // 通知全体管理员：主裁已提交报告
    const t1n = match.team1_id ? db.prepare('SELECT name FROM teams WHERE id=?').get(match.team1_id)?.name : '';
    const t2n = match.team2_id ? db.prepare('SELECT name FROM teams WHERE id=?').get(match.team2_id)?.name : '';
    sendMessageToAllAdmins({
      title: '裁判报告已提交',
      content: `场序${match.match_number} ${t1n||''} vs ${t2n||''} 的主裁判 ${referee.name} 已提交裁判报告，请在比赛详情中查看，可一键采纳为正式数据。`,
      type: 'referee_report', relatedType: 'match', relatedId: match.id
    });
  } else {
    logOperation(req, 'save_referee_report_draft', 'match', match.id, {});
  }
  broadcastUpdate('refereeReport', { matchId: match.id });
  res.json({ ok: true, status: newStatus });
});

// 管理员查看某场裁判报告
app.get('/api/admin/matches/:id/referee-report', requireAdmin, (req, res) => {
  const report = loadFullReport(req.params.id);
  if (!report) return res.json({ exists: false });
  let withinEditWindow = false;
  if (report.status === 'submitted' && report.submitted_at) {
    withinEditWindow = (Date.now() - new Date(report.submitted_at).getTime()) <= REPORT_EDIT_WINDOW_MS;
  }
  report.within_edit_window = withinEditWindow;

  res.json({ exists: true, report });
});

// 管理员退回报告（允许主裁在1小时锁定后重新编辑）
app.post('/api/admin/referee-report/:id/return', requireAdmin, (req, res) => {
  const matchId = req.params.id;
  const report = db.prepare('SELECT * FROM referee_reports WHERE match_id=?').get(matchId);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  const retMatch = db.prepare('SELECT match_number FROM matches WHERE id=?').get(matchId);
  db.prepare("UPDATE referee_reports SET status='returned', returned_at=? WHERE id=?")
    .run(BJ(), report.id);
  // 通知主裁
  sendMessage(report.referee_id, {
    title: '裁判报告已退回，请修改后重新提交',
    content: `场序${retMatch?retMatch.match_number:''}的裁判报告已被管理员退回，现在可以重新编辑并提交。`,
    type: 'referee_report', relatedType: 'match', relatedId: +matchId
  });
  logOperation(req, 'return_referee_report', 'match', matchId, {});
  broadcastUpdate('refereeReport', { matchId: +matchId });
  res.json({ ok: true });
});

// 管理员采纳报告：同步为正式比分与比赛事件
app.post('/api/admin/referee-report/:id/adopt', requireAdmin, (req, res) => {
  const matchId = +req.params.id;
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  const report = loadFullReport(matchId);
  if (!report || report.status !== 'submitted') return res.status(400).json({ error: '报告尚未提交，无法采纳' });
  if (report.adopted) return res.status(400).json({ error: '该报告已采纳，请勿重复操作' });

  try {
    db.exec('BEGIN');
    // 1) 用报告事件覆盖正式比赛事件
    db.prepare('DELETE FROM match_events WHERE match_id=?').run(matchId);
    // 以报告为准重算纪律：先清除本场此前自动生成的停赛（手动停赛保留），避免与赛中临时记录重复
    db.prepare('DELETE FROM suspensions WHERE is_manual=0 AND source_match_id=?').run(matchId);
    const ins = db.prepare(`INSERT INTO match_events (match_id,event_type,team_id,player_id,minute,is_penalty_kick,sub_in_player_id,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    (report.events || []).forEach(e => {
      let notes = e.notes || '';
      let isPen = 0;
      if (e.event_type === 'goal') {
        if (e.detail === 'penalty') isPen = 1;
        if (e.detail === 'own') notes = '乌龙球';
      } else if (e.event_type === 'yellow' || e.event_type === 'red') {
        notes = e.detail || notes;
      }
      ins.run(matchId, e.event_type, e.team_id, e.player_id, e.minute, isPen, e.sub_in_player_id, notes, BJ());
    });

    // 2) 同步比分与结果
    let winnerId = match.winner_id;
    const s1 = report.team1_score, s2 = report.team2_score;
    if (s1 !== null && s2 !== null) {
      if (s1 > s2) winnerId = match.team1_id;
      else if (s2 > s1) winnerId = match.team2_id;
      else if (report.has_penalty) {
        if ((report.penalty_team1||0) > (report.penalty_team2||0)) winnerId = match.team1_id;
        else winnerId = match.team2_id;
      }
      db.prepare(`UPDATE matches SET team1_score=?,team2_score=?,has_penalty=?,penalty_team1=?,penalty_team2=?,winner_id=?,status='finished' WHERE id=?`)
        .run(s1, s2, report.has_penalty?1:0, report.penalty_team1, report.penalty_team2, winnerId, matchId);
      stampFinished(matchId);
    }

    // 3) 纪律停赛：红牌停赛 + 累计3黄停赛
    const reds = db.prepare("SELECT DISTINCT player_id FROM match_events WHERE match_id=? AND event_type='red' AND player_id IS NOT NULL").all(matchId);
    reds.forEach(row => {
      const ex = db.prepare("SELECT id FROM suspensions WHERE player_id=? AND reason='红牌停赛' AND is_manual=0 AND active=1").get(row.player_id);
      if (!ex) addAutoSuspension(row.player_id, '红牌停赛', matchId);
    });
    const yellows = db.prepare("SELECT DISTINCT player_id, team_id FROM match_events WHERE match_id=? AND event_type='yellow' AND player_id IS NOT NULL").all(matchId);
    yellows.forEach(row => {
      const total = countEffectiveFinishedYellows(row.player_id, row.team_id);
      if (total > 0 && total % 3 === 0) {
        const ex = db.prepare("SELECT id FROM suspensions WHERE player_id=? AND reason='累计3张黄牌停赛' AND is_manual=0 AND active=1").get(row.player_id);
        if (!ex) addAutoSuspension(row.player_id, '累计3张黄牌停赛', matchId);
      }
    });

    // 4) 自动推进后续对阵
  advanceMenMatches();


    db.prepare('UPDATE referee_reports SET adopted=1 WHERE id=?').run(report.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: '采纳失败：' + e.message });
  }

  broadcastUpdate('matches', {});
  broadcastUpdate('standings', {});
  broadcastUpdate('scorers', {});
  broadcastUpdate('suspensions', {});
  logOperation(req, 'adopt_referee_report', 'match', matchId, { score: `${report.team1_score}:${report.team2_score}` });
  res.json({ ok: true });
});


// ========== B6 首页待办聚合 ==========
app.get('/api/home/todos', requireAuth, (req, res) => {
  const role = req.session.user.role;
  const todos = [];
  const unread = db.prepare('SELECT COUNT(*) c FROM messages WHERE receiver_id=? AND is_read=0').get(req.session.user.id).c;
  if (unread) todos.push({ key: 'msg', level: 'info', text: `有 ${unread} 条未读消息`, page: 'messages' });

  if (role === 'admin') {
    // 待办同样遵循隐藏队规则：非设计者不计隐藏队，设计者开关打开时计入
    const showHidden = req.session.user.username === 'admin' && req.query.include_hidden === '1';
    const pp = db.prepare(`SELECT COUNT(*) c FROM players p JOIN teams t ON p.team_id=t.id WHERE p.status='pending' AND p.deleted_at IS NULL ${showHidden ? '' : 'AND COALESCE(t.is_hidden,0)=0'}`).get().c;
    if (pp) todos.push({ key: 'pending_player', level: 'warning', text: `${pp} 名球员待审批`, page: 'players' });

    const noRef = db.prepare("SELECT COUNT(*) c FROM matches WHERE status!='finished' AND (main_referee_id IS NULL) AND team1_id IS NOT NULL").get().c;
    if (noRef) todos.push({ key: 'no_ref', level: 'info', text: `${noRef} 场已排对阵未指派主裁判`, page: 'schedule' });
    const leave = db.prepare(`SELECT COUNT(*) c FROM match_ref_confirm c JOIN matches m ON c.match_id=m.id
      WHERE c.status='leave' AND m.status!='finished'`).get().c;
    if (leave) todos.push({ key: 'ref_leave', level: 'danger', text: `${leave} 位裁判赛前请假，需改派`, page: 'schedule' });
    const recycle = db.prepare(`SELECT (SELECT COUNT(*) FROM teams WHERE deleted_at IS NOT NULL)+(SELECT COUNT(*) FROM players WHERE deleted_at IS NOT NULL)+(SELECT COUNT(*) FROM referees WHERE deleted_at IS NOT NULL) c`).get().c;
    if (recycle) todos.push({ key: 'recycle', level: 'info', text: `回收站有 ${recycle} 项待处理`, page: 'recycle' });
  } else if (role === 'viewer') {
    const tid = req.session.user.team_id;
    if (tid) {
      const draft = db.prepare("SELECT COUNT(*) c FROM players WHERE team_id=? AND status IN ('draft','pending') AND deleted_at IS NULL").get(tid).c;
      if (draft) todos.push({ key: 'my_players', level: 'warning', text: `本队有 ${draft} 名球员为草稿/待审批`, page: 'players' });
      // 本队未开始且尚未提交阵容的比赛
      const upcoming = db.prepare(`SELECT m.id,m.match_number FROM matches m WHERE m.status!='finished' AND (m.team1_id=? OR m.team2_id=?) AND m.team1_id IS NOT NULL`).all(tid, tid);
      let needLineup = 0;
      for (const m of upcoming) {
        const sub = db.prepare("SELECT COUNT(*) c FROM match_lineups WHERE match_id=? AND team_id=? AND status='submitted'").get(m.id, tid).c;
        if (!sub) needLineup++;
      }
      if (needLineup) todos.push({ key: 'lineup', level: 'warning', text: `${needLineup} 场比赛尚未提交首发阵容`, page: 'schedule' });
      // 已完赛、评分窗口内、尚未生成评分链接
      const needRating = db.prepare(`SELECT COUNT(*) c FROM matches m
        WHERE m.status='finished' AND m.finished_at IS NOT NULL
        AND (m.team1_id=? OR m.team2_id=?)
        AND NOT EXISTS (SELECT 1 FROM rating_tokens t WHERE t.match_id=m.id AND t.team_id=? AND t.revoked=0)
        AND datetime(m.finished_at,'+48 hours') >= datetime(?)`).get(tid, tid, tid, BJ()).c;
      if (needRating) todos.push({ key: 'rating', level: 'info', text: `${needRating} 场已完赛，待生成裁判评分链接`, page: 'schedule' });

    }
  } else if (role === 'referee') {
    const ref = getSessionReferee(req);
    if (ref) {
      const mine = db.prepare(`SELECT * FROM matches WHERE status!='finished' AND
        (main_referee_id=? OR assistant_ref1_id=? OR assistant_ref2_id=? OR fourth_official_id=?)`).all(ref.id,ref.id,ref.id,ref.id);
      let unconfirmed = 0;
      for (const m of mine) {
        const c = db.prepare('SELECT status FROM match_ref_confirm WHERE match_id=? AND referee_id=?').get(m.id, ref.id);
        if (!c || c.status === 'pending') unconfirmed++;
      }
      if (unconfirmed) todos.push({ key: 'confirm', level: 'warning', text: `${unconfirmed} 场执法尚未确认（确认/请假）`, page: 'my-matches' });
      // 主裁待提交报告（已结束）
      const due = db.prepare(`SELECT COUNT(*) c FROM matches m WHERE m.status='finished' AND m.main_referee_id=?
        AND NOT EXISTS (SELECT 1 FROM referee_reports r WHERE r.match_id=m.id AND r.status='submitted')`).get(ref.id).c;
      if (due) todos.push({ key: 'report_due', level: 'danger', text: `${due} 场主裁报告待提交`, page: 'my-matches' });
    }
  }
  res.json({ todos });
});

// ========== 操作日志 ==========
app.get('/api/operation-logs', requireAdmin, (req, res) => {
  const { action, limit } = req.query;
  let sql = 'SELECT * FROM operation_logs';
  const params = [];
  if (action) { sql += ' WHERE action = ?'; params.push(action); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(+limit || 200, 500));
  const logs = db.prepare(sql).all(...params);
  logs.forEach(l => { try { l.detail = l.detail ? JSON.parse(l.detail) : null; } catch(e) {} });
  res.json(logs);
});

// ========== 消息通知 API ==========
// 获取当前用户的消息列表
app.get('/api/messages', requireAuth, (req, res) => {
  const { type, limit } = req.query;
  let sql = 'SELECT * FROM messages WHERE receiver_id = ?';
  const params = [req.session.user.id];
  if (type && type !== 'all') { sql += ' AND type = ?'; params.push(type); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(+limit || 100, 500));
  const messages = db.prepare(sql).all(...params);
  res.json(messages);
});

// 获取未读消息数
app.get('/api/messages/unread-count', requireAuth, (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as c FROM messages WHERE receiver_id=? AND is_read=0').get(req.session.user.id).c;
  res.json({ count });
});

// 标记单条消息已读
app.post('/api/messages/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE messages SET is_read=1 WHERE id=? AND receiver_id=?').run(req.params.id, req.session.user.id);
  const count = db.prepare('SELECT COUNT(*) as c FROM messages WHERE receiver_id=? AND is_read=0').get(req.session.user.id).c;
  io.emit('unreadCount', { userId: req.session.user.id, count });
  res.json({ ok: true, count });
});

// 全部标记为已读
app.post('/api/messages/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE messages SET is_read=1 WHERE receiver_id=? AND is_read=0').run(req.session.user.id);
  io.emit('unreadCount', { userId: req.session.user.id, count: 0 });
  res.json({ ok: true });
});

// 删除消息（管理员可删所有，访客只能删自己的）
app.delete('/api/messages/:id', requireAuth, (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: '消息不存在' });
  if (req.session.user.role !== 'admin' && msg.receiver_id !== req.session.user.id) {
    return res.status(403).json({ error: '无权删除此消息' });
  }
  db.prepare('DELETE FROM messages WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// 管理员查看所有发送的消息（备份）
app.get('/api/messages/all', requireAdmin, (req, res) => {
  const { type, limit } = req.query;
  let sql = 'SELECT m.*, u.username as receiver_name, u.team_id as receiver_team_id FROM messages m LEFT JOIN users u ON m.receiver_id=u.id';
  const params = [];
  if (type && type !== 'all') { sql += ' WHERE m.type = ?'; params.push(type); }
  sql += ' ORDER BY m.created_at DESC LIMIT ?';
  params.push(Math.min(+limit || 200, 500));
  const messages = db.prepare(sql).all(...params);
  res.json(messages);
});

// 管理员发布通知
// 辅助：从上传文件构建附件JSON
// multer/busboy 默认以 latin1 解码 multipart 文件名，中文会乱码；含 0x80-0xFF 高位字节时转回 UTF-8
function decodeOriginalName(name) {
  if (!name) return name;
  if (/[\u0080-\u00ff]/.test(name)) {
    try { return Buffer.from(name, 'latin1').toString('utf8'); } catch (e) {}
  }
  return name;
}
function buildAttachmentsJson(files, urlPrefix) {
  if (!files || !files.length) return '[]';
  const prefix = urlPrefix || '/uploads/messages/';
  return JSON.stringify(files.map(f => ({
    filename: decodeOriginalName(f.originalname),
    path: prefix + f.filename,
    size: f.size,
    mimetype: f.mimetype
  })));
}

// 管理员发布通知（支持附件）
app.post('/api/messages/send', requireAdmin, messageUpload.array('attachments', 20), (req, res) => {
  const { title, content, receiver_type, receiver_id } = req.body;
  if (!title) return res.status(400).json({ error: '标题不能为空' });
  const attachments = buildAttachmentsJson(req.files);
  const opts = {
    senderId: req.session.user.id,
    senderName: req.session.user.displayName || req.session.user.username,
    title, content: content || '',
    type: 'admin_notice',
    relatedType: '', relatedId: null,
    attachments
  };
  if (receiver_type === 'user' && receiver_id) {
    sendMessage(+receiver_id, opts);
  } else if (receiver_type === 'all_visitors') {
    sendMessageToAllVisitors(opts);
  } else if (receiver_type === 'all_referees') {
    sendMessageToAllReferees(opts);
  } else if (receiver_type === 'all_admins') {
    sendMessageToAllAdmins(opts);
  } else if (receiver_type === 'all') {
    sendMessageToAll(opts);
  } else {
    return res.status(400).json({ error: '无效的接收对象' });
  }
  logOperation(req, 'send_notice', 'message', null, { title, receiver_type, receiver_id });
  res.json({ ok: true });
});

// ========== 全站公告 ==========
// 登录后拉取（系统无游客端）；按角色与发布范围过滤，仅返回在架公告
app.get('/api/announcements', (req, res) => {
  const role = req.session.user ? req.session.user.role : 'guest';
  let rows = db.prepare("SELECT * FROM announcements WHERE is_active=1 ORDER BY CASE level WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, created_at DESC").all();
  rows = rows.filter(a => {
    if (role === 'admin') return true;
    if (a.scope === 'all') return true;
    if (a.scope === 'referees') return role === 'referee';
    if (a.scope === 'visitors') return role === 'viewer';
    return false;
  }).map(a => ({ ...a, attachments: a.attachments || '[]' }));
  res.json(rows);
});

// 管理员：全部公告（含已下架）
app.get('/api/admin/announcements', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM announcements ORDER BY created_at DESC').all());
});

// 管理员：发布公告（标题/正文/级别/范围/附件）
app.post('/api/admin/announcements', requireAdmin, announcementUpload.array('attachments', 6), (req, res) => {
  let { title, content, level, scope } = req.body;
  title = (title || '').trim();
  content = content || '';
  if (!title) return res.status(400).json({ error: '公告标题不能为空' });
  if (title.length > 60) return res.status(400).json({ error: '标题最长 60 字' });
  if (content.length > 2000) return res.status(400).json({ error: '正文最长 2000 字' });
  if (!['info', 'important', 'urgent'].includes(level)) level = 'info';
  if (!['all', 'visitors', 'referees'].includes(scope)) scope = 'all';
  const attachments = buildAttachmentsJson(req.files, '/uploads/announcements/');
  const info = db.prepare(`INSERT INTO announcements (title,content,level,scope,attachments,is_active,created_by,created_by_name,created_at)
    VALUES (?,?,?,?,?,1,?,?,?)`).run(title, content, level, scope, attachments,
      req.session.user.id, req.session.user.displayName || req.session.user.username, BJ());
  broadcastUpdate('announcements', {});
  logOperation(req, 'publish_announcement', 'announcement', info.lastInsertRowid, { title, level, scope });
  res.json({ ok: true, id: info.lastInsertRowid });
});

// 管理员：下架 / 重新上架
app.post('/api/admin/announcements/:id/offline', requireAdmin, (req, res) => {
  const r = db.prepare("UPDATE announcements SET is_active=0, offline_at=? WHERE id=?").run(BJ(), req.params.id);
  if (!r.changes) return res.status(404).json({ error: '公告不存在' });
  broadcastUpdate('announcements', {});
  logOperation(req, 'offline_announcement', 'announcement', req.params.id, {});
  res.json({ ok: true });
});
// 当前在线用户列表（仅管理员）：姓名/角色/球队/最后活跃时间
app.get('/api/admin/online-users', requireAdmin, (req, res) => {
  const users = getOnlineUserList().map(x => ({
    id: x.id, name: x.name, role: x.role, team_name: x.team_name, is_designer: x.is_designer, last_seen: x.last_seen
  }));
  res.json({ users, count: users.length });
});

app.post('/api/admin/announcements/:id/online', requireAdmin, (req, res) => {
  const r = db.prepare("UPDATE announcements SET is_active=1, offline_at=NULL WHERE id=?").run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: '公告不存在' });
  broadcastUpdate('announcements', {});
  logOperation(req, 'online_announcement', 'announcement', req.params.id, {});
  res.json({ ok: true });
});

// 管理员：删除公告（同时尽力删除附件文件）
app.delete('/api/admin/announcements/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM announcements WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '公告不存在' });
  try {
    const atts = JSON.parse(row.attachments || '[]');
    atts.forEach(f => { if (f.path) { const fp = path.join(__dirname, 'public', f.path); if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch (e) {} } });
  } catch (e) {}
  db.prepare('DELETE FROM announcements WHERE id=?').run(req.params.id);
  broadcastUpdate('announcements', {});
  logOperation(req, 'delete_announcement', 'announcement', req.params.id, { title: row.title });
  res.json({ ok: true });
});

// 访客/裁判发送消息给全体管理员（支持附件）
app.post('/api/messages/visitor-send', requireViewerOrReferee, messageUpload.array('attachments', 20), (req, res) => {
  const { title, content } = req.body;
  if (!title) return res.status(400).json({ error: '标题不能为空' });
  const attachments = buildAttachmentsJson(req.files);
  const isRef = req.session.user.role === 'referee';
  const opts = {
    senderId: req.session.user.id,
    senderName: (isRef ? '【裁判】' : '') + (req.session.user.displayName || req.session.user.username),
    title, content: content || '',
    type: isRef ? 'referee_message' : 'visitor_message',
    relatedType: '', relatedId: null,
    attachments
  };
  sendMessageToAllAdmins(opts);
  logOperation(req, isRef ? 'referee_send_message' : 'visitor_send_message', 'message', null, { title });
  res.json({ ok: true });
});

// 管理员回复访客消息（支持附件）
app.post('/api/messages/:id/reply', requireAdmin, messageUpload.array('attachments', 20), (req, res) => {
  const origMsg = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);
  if (!origMsg) return res.status(404).json({ error: '原消息不存在' });
  const { title, content } = req.body;
  if (!title) return res.status(400).json({ error: '标题不能为空' });
  const attachments = buildAttachmentsJson(req.files);
  // 回复给原消息发送者
  sendMessage(origMsg.sender_id, {
    senderId: req.session.user.id,
    senderName: req.session.user.displayName || req.session.user.username,
    title: title || '回复：' + origMsg.title,
    content: content || '',
    type: 'admin_reply',
    relatedType: 'message', relatedId: origMsg.id,
    attachments
  });
  logOperation(req, 'reply_message', 'message', origMsg.id, { title, receiver_id: origMsg.sender_id });
  res.json({ ok: true });
});

// 管理员查看所有访客来信
app.get('/api/messages/visitor-inbox', requireAdmin, (req, res) => {
  const messages = db.prepare(`
    SELECT m.*, u.team_id as sender_team_id
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.type IN ('visitor_message','referee_message')
    ORDER BY m.created_at DESC
    LIMIT 200
  `).all();
  res.json(messages);
});

// ========== 比赛提醒定时任务 ==========
// 给一场比赛的全部临场裁判发送提醒
function sendReminderToMatchReferees(m, title, content, reminderType) {
  const refIds = [m.main_referee_id, m.assistant_ref1_id, m.assistant_ref2_id, m.fourth_official_id].filter(Boolean);
  refIds.forEach(rid => {
    const uid = getRefereeUserId(rid);
    if (uid) sendMessage(uid, { title, content, type: 'referee_reminder', relatedType: 'match', relatedId: m.id });
  });
  db.prepare('INSERT INTO match_reminders (match_id, reminder_type, sent_at) VALUES (?,?,?)').run(m.id, reminderType, BJ());
}

function checkMatchReminders() {
  try {
    const now = new Date();
    const matches = db.prepare("SELECT * FROM matches WHERE status='pending' AND match_date != '' AND match_time != ''").all();
    matches.forEach(m => {
      if (!m.team1_id || !m.team2_id) return;
      // 解析比赛时间
      const matchDateTime = new Date(`${m.match_date}T${m.match_time}:00`);
      if (isNaN(matchDateTime.getTime())) return;
      const diffMs = matchDateTime - now;
      const diffHours = diffMs / (1000 * 60 * 60);
      const t1 = db.prepare('SELECT name FROM teams WHERE id=?').get(m.team1_id);
      const t2 = db.prepare('SELECT name FROM teams WHERE id=?').get(m.team2_id);
      const vsStr = `${t1?.name || 'A队'} vs ${t2?.name || 'B队'}`;
      const baseInfo = `场序${m.match_number} ${vsStr} 将于 ${m.match_date} ${m.match_time} 在 ${m.match_location || '三期操场'}`;

      // ===== 裁判员：24小时提醒（23.5-24.5小时窗口）=====
      if (diffHours <= 24.5 && diffHours > 23.5) {
        const sent = db.prepare("SELECT id FROM match_reminders WHERE match_id=? AND reminder_type='ref24h'").get(m.id);
        if (!sent) {
          sendReminderToMatchReferees(m, '执法提醒（赛前24小时）',
            `${baseInfo} 开始，请提前安排时间、熟悉规程。`, 'ref24h');
        }
      }

      // 2小时提醒（1.5-2.5小时窗口内）
      if (diffHours <= 2 && diffHours > 1 && m.status === 'pending') {
        const sent = db.prepare("SELECT id FROM match_reminders WHERE match_id=? AND reminder_type='2h'").get(m.id);
        if (!sent) {
          const title = `比赛即将开始（2小时后）`;
          const content = `${baseInfo} 开始，请做好准备。`;
          sendMessageToTeam(m.team1_id, { title, content, type: 'match_reminder', relatedType: 'match', relatedId: m.id });
          sendMessageToTeam(m.team2_id, { title, content, type: 'match_reminder', relatedType: 'match', relatedId: m.id });
          db.prepare('INSERT INTO match_reminders (match_id, reminder_type, sent_at) VALUES (?,?,?)').run(m.id, '2h', BJ());
        }
      }
      // 1小时提醒（0.5-1.5小时窗口内）
      if (diffHours <= 1 && diffHours > 0 && m.status === 'pending') {
        const sentTeam = db.prepare("SELECT id FROM match_reminders WHERE match_id=? AND reminder_type='1h'").get(m.id);
        if (!sentTeam) {
          const title = `比赛即将开始（1小时后）`;
          const content = `场序${m.match_number} ${vsStr} 将于1小时后（${m.match_time}）在 ${m.match_location || '三期操场'} 开始，请尽快到场。`;
          sendMessageToTeam(m.team1_id, { title, content, type: 'match_reminder', relatedType: 'match', relatedId: m.id });
          sendMessageToTeam(m.team2_id, { title, content, type: 'match_reminder', relatedType: 'match', relatedId: m.id });
          db.prepare('INSERT INTO match_reminders (match_id, reminder_type, sent_at) VALUES (?,?,?)').run(m.id, '1h', BJ());
        }
        // ===== 裁判员：1小时提醒 =====
        const sentRef = db.prepare("SELECT id FROM match_reminders WHERE match_id=? AND reminder_type='ref1h'").get(m.id);
        if (!sentRef) {
          sendReminderToMatchReferees(m, '执法提醒（赛前1小时）',
            `${baseInfo} 开始，请尽快到场并做好执法准备。`, 'ref1h');
        }
      }
    });

  } catch (e) {
    console.error('比赛提醒检查失败:', e.message);
  }
}
// 每分钟检查一次
setInterval(checkMatchReminders, 60 * 1000);
// 启动后10秒先检查一次
setTimeout(checkMatchReminders, 10000);

// 统一错误处理：上传类错误返回干净的400 JSON，避免默认500页
app.use((err, req, res, next) => {
  if (err) {
    let msg = err.message || '请求处理失败';
    // 请求体超限：保留 413 语义，不吞成 400
    if (err.type === 'entity.too.large' || err.code === 'entity.too.large' || err.statusCode === 413) {
      if (req.path.startsWith('/api/')) return res.status(413).json({ error: '请求体超过大小上限（10MB）' });
    }
    if (err.code === 'LIMIT_FILE_SIZE') msg = '附件超过大小上限（图片≤10MB，视频≤50MB）';
    if (err.code === 'LIMIT_FILE_COUNT') msg = '单次最多上传6个附件';
    if (req.path.startsWith('/api/')) return res.status(400).json({ error: msg });
  }
  next(err);
});

// ========== 系统自检 / 健康探针 / 进程健壮性 ==========
const APP_VERSION = 'v62';
const STARTED_AT = Date.now();
// 期望的基线数据（v51：男6女5）
const EXPECT_MEN_TEAMS = ['球队A','球队B','球队C','球队D','球队E','球队F'];
const EXPECT_WOMEN_TEAMS = ['球队A','球队B','球队C','球队D','球队E'];
const REQUIRED_TABLES = ['users','teams','players','referees','matches','match_events','match_photos','penalty_shootout','match_lineups','match_checkins','suspensions','login_logs','settings','operation_logs','messages','announcements','match_reminders','referee_reports','referee_report_events','match_ref_confirm','awards','yellow_resets','exhibition_matches','exhibition_players','exhibition_events','exhibition_penalties'];
function _check(name, ok, detail) { return { name, ok: !!ok, detail: String(detail == null ? '' : detail) }; }
// 综合自检：只做只读检查 + 目录可写性探针，不改动任何业务数据
function runSelfCheck() {
  const checks = [];
  // 1. 数据库完整性
  try {
    const integ = db.prepare('PRAGMA integrity_check').get();
    checks.push(_check('数据库完整性 integrity_check', integ && Object.values(integ)[0] === 'ok', JSON.stringify(integ)));
  } catch (e) { checks.push(_check('数据库完整性 integrity_check', false, e.message)); }
  // 1.1 数据库可写探针（事务级，立即回滚，不改动任何业务数据）
  try {
    db.prepare('BEGIN IMMEDIATE').run();
    db.prepare('ROLLBACK').run();
    checks.push(_check('数据库可写（事务探针）', true, 'BEGIN IMMEDIATE / ROLLBACK 正常'));
  } catch (e) { checks.push(_check('数据库可写（事务探针）', false, e.message)); }
  // 2. 必备数据表
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  const missT = REQUIRED_TABLES.filter(t => !tables.has(t));
  checks.push(_check('必备数据表齐全', missT.length === 0, missT.length ? '缺失: ' + missT.join(',') : `${REQUIRED_TABLES.length} 张表均在`));
  // 3. 球队数量与名称
  try {
    const men = db.prepare("SELECT name FROM teams WHERE gender='men' AND deleted_at IS NULL AND COALESCE(is_hidden,0)=0 ORDER BY id").all().map(r => r.name);
    const women = db.prepare("SELECT name FROM teams WHERE gender='women' AND deleted_at IS NULL AND COALESCE(is_hidden,0)=0 ORDER BY id").all().map(r => r.name);
    checks.push(_check('男子组6支球队与命名', men.length === 6 && EXPECT_MEN_TEAMS.every((n, i) => men[i] === n), `实际: ${men.join('、')}`));
    checks.push(_check('女子组5支球队与命名', women.length === 5 && EXPECT_WOMEN_TEAMS.every((n, i) => women[i] === n), `实际: ${women.join('、')}`));
  } catch (e) { checks.push(_check('球队基线', false, e.message)); }
  // 4. 比赛数量
  try {
    const mc = g => db.prepare('SELECT COUNT(*) c FROM matches WHERE gender=?').get(g).c;
    const mMen = mc('men'), mWomen = mc('women');
    checks.push(_check('比赛场次（男18/女10）', mMen === 18 && mWomen === 10, `男${mMen}场 / 女${mWomen}场`));
  } catch (e) { checks.push(_check('比赛场次', false, e.message)); }
  // 4.1 场次号与性别一致性（男 1-18、女 101-110；测试夹具 match_number≥9000 豁免）
  try {
    const badMen = db.prepare("SELECT match_number FROM matches WHERE gender='men' AND match_number < 9000 AND match_number NOT BETWEEN 1 AND 18").all();
    const badWomen = db.prepare("SELECT match_number FROM matches WHERE gender='women' AND match_number < 9000 AND match_number NOT BETWEEN 101 AND 110").all();
    const badGender = db.prepare("SELECT match_number,gender FROM matches WHERE match_number < 9000 AND ((gender='men' AND match_number >= 100) OR (gender='women' AND match_number < 100))").all();
    let detail = '全部一致';
    if (badMen.length) detail = '男子异常场次号: ' + badMen.map(r => r.match_number).join(',');
    else if (badWomen.length) detail = '女子异常场次号: ' + badWomen.map(r => r.match_number).join(',');
    else if (badGender.length) detail = '性别与场次号不符: ' + badGender.map(r => r.match_number + '(' + r.gender + ')').join(',');
    checks.push(_check('场次号与性别一致（男1-18/女101-110）', badMen.length === 0 && badWomen.length === 0 && badGender.length === 0, detail));
  } catch (e) { checks.push(_check('场次号与性别一致', false, e.message)); }
  // 5. 账号体系
  try {
    const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
    const viewers = db.prepare("SELECT COUNT(*) c FROM users u WHERE u.role='viewer' AND COALESCE(u.is_test,0)=0 AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id=u.team_id AND COALESCE(t.is_hidden,0)=1)").get().c;
    const testN = db.prepare("SELECT COUNT(*) c FROM users u WHERE u.role='viewer' AND (COALESCE(u.is_test,0)=1 OR EXISTS (SELECT 1 FROM teams t WHERE t.id=u.team_id AND COALESCE(t.is_hidden,0)=1))").get().c;
    const orphanViewer = db.prepare("SELECT COUNT(*) c FROM users u WHERE u.role='viewer' AND COALESCE(u.is_test,0)=0 AND (u.team_id IS NULL OR NOT EXISTS (SELECT 1 FROM teams t WHERE t.id=u.team_id))").get().c;
    checks.push(_check('账号体系（管理员2/球队11/无悬空绑定）', admins === 2 && viewers === 11 && testN === 1 && orphanViewer === 0, `管理员${admins}、球队${viewers}、悬空绑定${orphanViewer}`));
  } catch (e) { checks.push(_check('账号体系', false, e.message)); }
  // 6. 孤儿数据
  try {
    const orphanPlayers = db.prepare("SELECT COUNT(*) c FROM players p WHERE COALESCE(p.test_data,0)=0 AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id=p.team_id)").get().c;
    const orphanEvents = db.prepare("SELECT COUNT(*) c FROM match_events me WHERE NOT EXISTS (SELECT 1 FROM matches m WHERE m.id=me.match_id)").get().c;
    checks.push(_check('无孤儿球员/事件记录', orphanPlayers === 0 && orphanEvents === 0, `孤儿球员${orphanPlayers}、孤儿事件${orphanEvents}`));
  } catch (e) { checks.push(_check('孤儿数据', false, e.message)); }
  // 7. 目录可写性
  ['data', path.join('public', 'uploads')].forEach(rel => {
    try {
      const dir = path.join(__dirname, rel);
      if (!fs.existsSync(dir)) { checks.push(_check(`目录存在: ${rel}`, false, '不存在')); return; }
      const probe = path.join(dir, '.write_probe');
      fs.writeFileSync(probe, '1'); fs.unlinkSync(probe);
      checks.push(_check(`目录可写: ${rel}`, true, '正常'));
    } catch (e) { checks.push(_check(`目录可写: ${rel}`, false, e.message)); }
  });
  // 8. 磁盘剩余空间（Node 22 支持 statfs）
  try {
    if (fs.statfsSync) {
      const st = fs.statfsSync(path.join(__dirname, 'data'));
      const freeMB = Math.round(st.bavail * st.bsize / 1024 / 1024);
      checks.push(_check('数据盘剩余空间充足（>500MB）', freeMB > 500, `剩余约 ${freeMB} MB`));
    }
  } catch (e) { /* 平台不支持则跳过 */ }
  // 9. 最近备份
  try {
    const bdir = path.join(__dirname, 'data', 'backups');
    const bks = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter(f => f.endsWith('.db')).sort() : [];
    checks.push(_check('数据库备份目录', true, bks.length ? `已有${bks.length}份，最近: ${bks[bks.length - 1]}` : '暂无备份（系统每6小时自动备份，也可手动备份）'));
  } catch (e) { checks.push(_check('数据库备份目录', false, e.message)); }
  // 10. 维护状态与北京时间
  try {
    checks.push(_check('运行状态', true, `北京时间${beijingHourNow()}时；维护开关 定时=${getSetting('maintenance_enabled', '1')} 手动=${getSetting('maintenance_manual', '0')}；当前${maintenanceActive() ? '处于停服' : '正常开放'}`));
  } catch (e) { checks.push(_check('运行状态', false, e.message)); }
  const problems = checks.filter(c => !c.ok);
  return { ok: problems.length === 0, version: APP_VERSION, checkedAt: BJ(), uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000), checks, problems };
}
// 公开健康探针（不泄露敏感信息，供 PM2/监控/内网探活）
app.get('/api/health', (req, res) => {
  let dbOk = true;
  try { db.prepare('SELECT 1').get(); } catch (e) { dbOk = false; }
  res.status(dbOk ? 200 : 503).json({ ok: dbOk, version: APP_VERSION, uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000), beijingHour: beijingHourNow(), maintenance: maintenanceActive() });
});
// 管理员综合自检
app.get('/api/admin/self-check', requireAdmin, (req, res) => res.json(runSelfCheck()));

// 进程级兜底：单个请求/异步异常不能拖垮整个服务
process.on('unhandledRejection', (reason) => { try { console.error('[unhandledRejection]', reason && reason.stack || reason); } catch (e) {} });
process.on('uncaughtException', (err) => {
  try { console.error('[uncaughtException]', err && err.stack || err); } catch (e) {}
  // 致命错误（数据库损坏/打不开、磁盘满、IO 错误）主动退出，由 PM2 立即拉起
  const msg = (err && (err.code || err.message) || '').toString();
  if (/SQLITE_(NOTOPEN|CORRUPT|CANTOPEN|IOERR|FULL)|ENOSPC|\bEIO\b/.test(msg)) { try { process.exit(1); } catch (e) {} }
});
// 套接字超时，避免异常连接长期占用
server.requestTimeout = 30 * 1000;
server.headersTimeout = 31 * 1000;
server.setTimeout(120 * 1000);
// 优雅退出：PM2 restart / 系统关机时先 checkpoint 再退出
function gracefulShutdown(sig) {
  console.log(`[${sig}] 正在优雅退出……`);
  try { server.close(() => { try { db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run(); } catch (e) {} process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); }
  catch (e) { process.exit(0); }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
// 启动 5 分钟后先做一次自动备份（之后每 6 小时一次），保证部署后很快有一份基线备份
setTimeout(() => { try { console.log('[启动基线备份]', performBackup()); } catch (e) { console.error('启动基线备份失败:', e.message); } }, 5 * 60 * 1000).unref?.();

// 启动
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n校园足球赛事一体化协同管理平台已启动`);
  console.log(`本机访问: http://localhost:${PORT}`);
  const nets = require('os').networkInterfaces();
  Object.values(nets).forEach(iface => {
    iface.forEach(addr => {
      if (addr.family === 'IPv4' && !addr.internal) {
        console.log(`局域网访问: http://${addr.address}:${PORT}`);
      }
    });
  });
  console.log(`\n管理员账号: admin / admin2`);
console.log('球队账号: 男子 visitor1~visitor6 / 女子 wvisitor1~wvisitor5（初始密码见 data 目录账号清单，首登强制修改，重启不重置）');
});

// HTTPS支持
const sslDir = path.join(__dirname, 'ssl');
const keyPath = path.join(sslDir, 'key.pem');
const certPath = path.join(sslDir, 'cert.pem');
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  try {
    const httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
    const httpsServer = https.createServer(httpsOptions, app);
    // 注意：Socket.IO只attach到HTTP服务器，避免双服务器导致在线人数计数混乱
    // HTTPS页面仍可访问，但实时推送走HTTP
    const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`HTTPS已启动: https://localhost:${HTTPS_PORT}`);
    });
  } catch (e) {
    console.error('HTTPS启动失败:', e.message);
  }
} else {
  console.log('提示: 将SSL证书放在 ssl/key.pem 和 ssl/cert.pem 可启用HTTPS');
  console.log('生成自签名证书: openssl req -x509 -newkey rsa:2048 -keyout ssl/key.pem -out ssl/cert.pem -days 365 -nodes\n');
}
