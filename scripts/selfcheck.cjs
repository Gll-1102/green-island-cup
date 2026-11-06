/**
 * 校园足球赛事系统离线自检脚本（不依赖服务是否运行）
 * 用法：node scripts/selfcheck.cjs            只做数据库/文件检查
 *       node scripts/selfcheck.cjs --http     额外探测 http://localhost:3000/api/health
 * 退出码：0 全部通过；1 存在问题（可接入 crontab / 巡检）
 * 基线：v51+ 赛制 —— 男子6队18场 / 女子5队10场 / 管理员2 / 球队账号11
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'cup.db');
const EXPECT_MEN = ['球队A','球队B','球队C','球队D','球队E','球队F'];
const EXPECT_WOMEN = ['球队A','球队B','球队C','球队D','球队E'];
const N_MEN_MATCHES = 18;
const N_WOMEN_MATCHES = 10;
const N_ADMINS = 2;
const N_VIEWERS = 11;
const REQUIRED_TABLES = ['users','teams','players','referees','matches','match_events','match_photos',
  'penalty_shootout','match_lineups','match_checkins','suspensions','login_logs','settings','operation_logs',
  'messages','announcements','match_reminders','referee_reports','referee_report_events','match_ref_confirm',
  'awards','yellow_resets','exhibition_matches','exhibition_players','exhibition_events','exhibition_penalties'];

const results = [];
const rec = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail || '') });

function main() {
  if (!fs.existsSync(DB_PATH)) { console.error('数据库不存在:', DB_PATH); process.exit(1); }
  const db = new DatabaseSync(DB_PATH);

  const integ = db.prepare('PRAGMA integrity_check').get();
  rec('数据库完整性', Object.values(integ)[0] === 'ok', JSON.stringify(integ));

  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  const miss = REQUIRED_TABLES.filter(t => !tables.has(t));
  rec('必备数据表', miss.length === 0, miss.length ? '缺失: ' + miss.join(',') : `${REQUIRED_TABLES.length} 张核心表齐全`);

  const men = db.prepare("SELECT name FROM teams WHERE gender='men' AND deleted_at IS NULL ORDER BY id").all().map(r => r.name);
  const women = db.prepare("SELECT name FROM teams WHERE gender='women' AND deleted_at IS NULL ORDER BY id").all().map(r => r.name);
  rec('男子6队命名', men.length === EXPECT_MEN.length && EXPECT_MEN.every((n, i) => men[i] === n), men.join('、'));
  rec('女子5队命名', women.length === EXPECT_WOMEN.length && EXPECT_WOMEN.every((n, i) => women[i] === n), women.join('、'));

  const mMen = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='men'").get().c;
  const mWomen = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='women'").get().c;
  rec('比赛场次（男18/女10）', mMen === N_MEN_MATCHES && mWomen === N_WOMEN_MATCHES, `男${mMen}/女${mWomen}`);

  const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
  const viewers = db.prepare("SELECT COUNT(*) c FROM users WHERE role='viewer' AND COALESCE(is_test,0)=0").get().c;
  const testN = db.prepare("SELECT COUNT(*) c FROM users WHERE role='viewer' AND is_test=1").get().c;
  const orphanV = db.prepare("SELECT COUNT(*) c FROM users u WHERE u.role='viewer' AND COALESCE(u.is_test,0)=0 AND (u.team_id IS NULL OR NOT EXISTS (SELECT 1 FROM teams t WHERE t.id=u.team_id))").get().c;
  rec('账号体系（管理员2/球队11/测试1/无悬空）', admins === N_ADMINS && viewers === N_VIEWERS && testN === 1 && orphanV === 0, `管理员${admins}/球队${viewers}/测试${testN}/悬空${orphanV}`);

  const orphanP = db.prepare("SELECT COUNT(*) c FROM players p WHERE p.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id=p.team_id)").get().c;
  rec('无孤儿球员', orphanP === 0, `孤儿球员${orphanP}`);

  const orphanE = db.prepare("SELECT COUNT(*) c FROM match_events e WHERE NOT EXISTS (SELECT 1 FROM matches m WHERE m.id=e.match_id)").get().c;
  rec('无孤儿比赛事件', orphanE === 0, `孤儿事件${orphanE}`);

  const wal = path.join(ROOT, 'data', 'cup.db-wal');
  rec('WAL 文件体积可控', !fs.existsSync(wal) || fs.statSync(wal).size < 50 * 1024 * 1024, fs.existsSync(wal) ? `${(fs.statSync(wal).size / 1024).toFixed(0)}KB（过大时执行 PRAGMA wal_checkpoint(TRUNCATE)）` : '无WAL');

  for (const rel of ['data', path.join('public', 'uploads')]) {
    try {
      const dir = path.join(ROOT, rel);
      const probe = path.join(dir, '.write_probe');
      fs.writeFileSync(probe, '1'); fs.unlinkSync(probe);
      rec(`目录可写 ${rel}`, true, '正常');
    } catch (e) { rec(`目录可写 ${rel}`, false, e.message); }
  }
  try {
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run();
    rec('WAL 检查点回写', true, 'TRUNCATE 完成');
  } catch (e) { rec('WAL 检查点回写', false, e.message); }
  db.close();

  if (process.argv.includes('--http')) {
    const port = process.env.PORT || 3000;
    return fetch(`http://localhost:${port}/api/health`).then(r => r.json()).then(j => {
      rec('HTTP 健康探针', !!j.ok, `version=${j.version} uptime=${j.uptimeSec}s maintenance=${j.maintenance}`);
      finish();
    }).catch(e => { rec('HTTP 健康探针', false, e.message); finish(); });
  }
  finish();
}

function finish() {
  console.log('\n========== 校园足球赛事系统自检报告', new Date().toLocaleString('zh-CN'), '==========');
  let bad = 0;
  for (const r of results) {
    console.log(`${r.ok ? '[PASS]' : '[FAIL]'} ${r.name} — ${r.detail}`);
    if (!r.ok) bad++;
  }
  console.log(bad ? `\n结论：${bad} 项异常，请按上述 FAIL 项排查。` : '\n结论：全部通过，系统状态正常。');
  process.exit(bad ? 1 : 0);
}
main();
