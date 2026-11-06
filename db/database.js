const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'cup.db');
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// ============================================================
// v51 赛制基线
// 男子组（6队）：分A/B两组各3队，组内双循环（12场）。小组第一直接出线，
//   积分较高的小组第二直接出线；两个小组第三打附加赛，胜者与另一个小组第二打附加赛，
//   决出第四支晋级队，共四强；半决赛单场定胜负（2场），胜者进决赛、负者打季军赛。共18场。
// 女子组（5队）：单循环10场，按积分定冠亚季军。
// ============================================================
const MEN_TEAM_NAMES = [
  '商学院',
  '文化与传播学院',
  '智能与工程学院',
  '生命与健康管理学院',
  '体育与艺术学院A队',
  '体育与艺术学院B队',
];
const WOMEN_TEAM_NAMES = [
  '商学院',
  '文化与传播学院',
  '智能与工程学院',
  '生命与健康管理学院',
  '体育与艺术学院',
];

// 男子小组赛种子（双循环，A/B组同轮并行）
// [match_number, round(1-6), group, slotHome, slotAway]
const MEN_GROUP_SEED = [
  [1, 1, 'A', 'A2', 'A3'],
  [2, 1, 'B', 'B2', 'B3'],
  [3, 2, 'A', 'A1', 'A3'],
  [4, 2, 'B', 'B1', 'B3'],
  [5, 3, 'A', 'A1', 'A2'],
  [6, 3, 'B', 'B1', 'B2'],
  [7, 4, 'A', 'A3', 'A2'],
  [8, 4, 'B', 'B3', 'B2'],
  [9, 5, 'A', 'A3', 'A1'],
  [10, 5, 'B', 'B3', 'B1'],
  [11, 6, 'A', 'A2', 'A1'],
  [12, 6, 'B', 'B2', 'B1'],
];
// 男子附加赛 / 半决赛 / 决赛种子（场13-18；除13外多由 advanceMenMatches 按名次动态填入）
// [num, round_name, round_group, source1, source2]
//  13 附加赛①：A组第3 vs B组第3（战绩优者主场）
//  14 附加赛②：较低小组第二（主场） vs 附加赛①胜者
//  15/16 半决赛（单场定胜负，小组第一主场），17季军赛、18决赛
const MEN_KO_SEED = [
  [13, '附加赛', 'PO1', 'GA3', 'GB3'],
  [14, '附加赛', 'PO2', 'LR2', 'PO1W'],
  [15, '半决赛', 'SFX', 'WX', 'CX'],
  [16, '半决赛', 'SFY', 'WY', 'CY'],
  [17, '季军赛', 'TP', 'SXL', 'SYL'],
  [18, '决赛', 'F', 'SXW', 'SYW'],
];
// 女子单循环种子（Berger编排，5轮，每轮2场、1队轮空）
// [num, round, slot1, slot2, byeSlot]
const WOMEN_SEED = [
  [101, 1, '2', '5', '1'],
  [102, 1, '3', '4', '1'],
  [103, 2, '1', '5', '4'],
  [104, 2, '2', '3', '4'],
  [105, 3, '1', '4', '2'],
  [106, 3, '3', '5', '2'],
  [107, 4, '1', '3', '5'],
  [108, 4, '2', '4', '5'],
  [109, 5, '1', '2', '3'],
  [110, 5, '4', '5', '3'],
];

function genPassword(len = 8) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = letters + digits;
  let pwd;
  do {
    pwd = '';
    for (let i = 0; i < len; i++) pwd += all[Math.floor(Math.random() * all.length)];
  } while (!/[a-zA-Z]/.test(pwd) || !/\d/.test(pwd));
  return pwd;
}

function init() {
  // ===== 一次性破坏性迁移（v51：旧赛制/FVS/挑战/申诉 → 新赛制全新态）=====
  migrateToV51();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      display_name TEXT,
      team_id INTEGER,
      gender TEXT DEFAULT 'men',
      failed_attempts INTEGER DEFAULT 0,
      locked_until DATETIME,
      must_change_password INTEGER DEFAULT 0,
      is_test INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      gender TEXT DEFAULT 'men',
      college TEXT DEFAULT '',
      leader TEXT DEFAULT '',
      leader_phone TEXT DEFAULT '',
      coach TEXT DEFAULT '',
      jersey_color TEXT DEFAULT '',
      logo_path TEXT DEFAULT '',
      deleted_at DATETIME,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL,
      gender TEXT DEFAULT 'men',
      student_id TEXT DEFAULT '',
      name TEXT NOT NULL,
      age INTEGER DEFAULT 0,
      class_name TEXT DEFAULT '',
      height REAL DEFAULT 0,
      weight REAL DEFAULT 0,
      jersey_number INTEGER DEFAULT 0,
      position TEXT DEFAULT '',
      health TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      is_official INTEGER DEFAULT 0,
      official_role TEXT DEFAULT '',
      is_captain INTEGER DEFAULT 0,
      status TEXT DEFAULT 'approved',
      pending_data TEXT DEFAULT '',
      student_card_path TEXT DEFAULT '',
      photo_path TEXT DEFAULT '',
      safety_doc_path TEXT DEFAULT '',
      submitted_by INTEGER,
      test_data INTEGER DEFAULT 0,
      deleted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      withdrawn_at DATETIME,
      withdrawn_reason TEXT DEFAULT '',
      withdrawn_doc_path TEXT DEFAULT '',
      withdrawn_approved_by INTEGER,
      withdrawn_approved_at DATETIME,
      withdraw_pending INTEGER DEFAULT 0,
      reject_reason TEXT DEFAULT '',
      reject_at DATETIME,
      is_replacement INTEGER DEFAULT 0,
      replacement_of INTEGER,
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );
    CREATE TABLE IF NOT EXISTS player_withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL,
      team_id INTEGER NOT NULL,
      reason TEXT DEFAULT '',
      doc_path TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      decided_by INTEGER,
      decided_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS referees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      serial_number TEXT NOT NULL,
      name TEXT NOT NULL,
      college TEXT DEFAULT '',
      student_id TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      level TEXT DEFAULT '',
      is_main_ref INTEGER DEFAULT 0,
      is_assistant_ref INTEGER DEFAULT 0,
      ref_type TEXT DEFAULT '',
      fair_play_path TEXT DEFAULT '',
      photo_path TEXT DEFAULT '',
      user_id INTEGER,
      deleted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS referee_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      gender TEXT DEFAULT 'men',
      college TEXT DEFAULT '',
      student_id TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      photo_path TEXT DEFAULT '',
      proof_path TEXT DEFAULT '',
      fair_play_path TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      level TEXT DEFAULT '',
      ref_type TEXT DEFAULT '',
      serial_number TEXT DEFAULT '',
      username TEXT DEFAULT '',
      password TEXT DEFAULT '',
      admin_note TEXT DEFAULT '',
      reviewed_by INTEGER,
      reviewed_at DATETIME,
      withdrawn_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_number INTEGER UNIQUE NOT NULL,
      gender TEXT DEFAULT 'men',
      round_name TEXT DEFAULT '',
      round_group TEXT DEFAULT '',
      round_order INTEGER DEFAULT 0,
      team1_id INTEGER,
      team2_id INTEGER,
      team1_source TEXT DEFAULT '',
      team2_source TEXT DEFAULT '',
      match_date TEXT DEFAULT '',
      match_time TEXT DEFAULT '',
      match_location TEXT DEFAULT '三期操场',
      status TEXT DEFAULT 'pending',
      team1_score INTEGER,
      team2_score INTEGER,
      ht_team1_score INTEGER,
      ht_team2_score INTEGER,
      has_penalty INTEGER DEFAULT 0,
      penalty_team1 INTEGER,
      penalty_team2 INTEGER,
      main_referee_id INTEGER,
      assistant_ref1_id INTEGER,
      assistant_ref2_id INTEGER,
      fourth_official_id INTEGER,
      winner_id INTEGER,
      mvp_player_id INTEGER,
      notes TEXT DEFAULT '',
      finished_at DATETIME,
      team1_reg_score INTEGER,
      team2_reg_score INTEGER,
      advance_locked INTEGER DEFAULT 0,
      is_walkover INTEGER DEFAULT 0,
      walkover_team_id INTEGER,
      schedule_note TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS match_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      team_id INTEGER,
      player_id INTEGER,
      minute INTEGER DEFAULT 0,
      is_penalty_kick INTEGER DEFAULT 0,
      sub_in_player_id INTEGER,
      sub_window INTEGER DEFAULT 0,
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );
    CREATE TABLE IF NOT EXISTS match_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER,
      photo_path TEXT NOT NULL,
      caption TEXT DEFAULT '',
      uploaded_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      photo_type TEXT NOT NULL DEFAULT 'match',
      activity_name TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );
    CREATE TABLE IF NOT EXISTS referee_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      referee_id INTEGER NOT NULL,
      rater_team_id INTEGER NOT NULL,
      rater_player_id INTEGER,
      rater_user_id INTEGER,
      score_accuracy INTEGER NOT NULL,
      score_control INTEGER NOT NULL,
      score_position INTEGER NOT NULL,
      score_communication INTEGER NOT NULL,
      score_rules INTEGER NOT NULL,
      total_score REAL NOT NULL,
      comment TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ref_ratings_referee ON referee_ratings(referee_id);
    CREATE INDEX IF NOT EXISTS idx_ref_ratings_match ON referee_ratings(match_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ref_ratings_unique ON referee_ratings(match_id,referee_id,rater_team_id,rater_player_id);
    CREATE TABLE IF NOT EXISTS rating_tokens (
      token TEXT PRIMARY KEY,
      match_id INTEGER NOT NULL,
      team_id INTEGER NOT NULL,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS penalty_shootout (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      round_number INTEGER NOT NULL,
      team_id INTEGER NOT NULL,
      player_id INTEGER,
      scored INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );
    CREATE TABLE IF NOT EXISTS match_lineups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      team_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      is_starter INTEGER DEFAULT 0,
      submitted_by INTEGER,
      submitted_at DATETIME,
      status TEXT DEFAULT 'draft',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );
    CREATE TABLE IF NOT EXISTS match_checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      status TEXT DEFAULT 'checked_in',
      check_in_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      operator_id INTEGER,
      UNIQUE(match_id, player_id),
      FOREIGN KEY (match_id) REFERENCES matches(id),
      FOREIGN KEY (player_id) REFERENCES players(id)
    );
    CREATE TABLE IF NOT EXISTS suspensions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL,
      reason TEXT DEFAULT '',
      match_count INTEGER DEFAULT 1,
      remaining_count INTEGER,
      discipline_type TEXT DEFAULT 'suspension',
      is_manual INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      source_match_id INTEGER,
      served_matches TEXT DEFAULT '',
      decided_by INTEGER,
      decided_at DATETIME,
      revoked_at DATETIME,
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS login_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT NOT NULL,
      role TEXT DEFAULT '',
      login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT DEFAULT '',
      role TEXT DEFAULT '',
      action TEXT NOT NULL,
      target_type TEXT DEFAULT '',
      target_id TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      ip_address TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER,
      sender_name TEXT DEFAULT '',
      receiver_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT DEFAULT '',
      type TEXT DEFAULT 'notice',
      related_type TEXT DEFAULT '',
      related_id INTEGER,
      is_read INTEGER DEFAULT 0,
      attachments TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT DEFAULT '',
      level TEXT DEFAULT 'info',
      scope TEXT DEFAULT 'all',
      attachments TEXT DEFAULT '[]',
      is_active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_by_name TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      offline_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS match_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      reminder_type TEXT NOT NULL,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS referee_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL UNIQUE,
      referee_id INTEGER NOT NULL,
      team1_score INTEGER,
      team2_score INTEGER,
      has_penalty INTEGER DEFAULT 0,
      penalty_team1 INTEGER,
      penalty_team2 INTEGER,
      discipline TEXT DEFAULT '',
      incidents TEXT DEFAULT '',
      status TEXT DEFAULT 'draft',
      confirmed INTEGER DEFAULT 0,
      adopted INTEGER DEFAULT 0,
      submitted_at DATETIME,
      returned_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS referee_report_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      team_id INTEGER,
      player_id INTEGER,
      minute INTEGER DEFAULT 0,
      detail TEXT DEFAULT '',
      sub_in_player_id INTEGER,
      notes TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS match_ref_confirm (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      referee_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      note TEXT DEFAULT '',
      updated_at DATETIME,
      UNIQUE(match_id, referee_id)
    );
    CREATE TABLE IF NOT EXISTS awards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      award_type TEXT NOT NULL,
      player_id INTEGER,
      team_id INTEGER,
      title TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      is_auto INTEGER DEFAULT 0,
      gender TEXT DEFAULT 'men',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS yellow_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL UNIQUE,
      boundary_match_number INTEGER NOT NULL,
      note TEXT DEFAULT '',
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- ===== v61：删除热身赛/友谊赛（表为空，安全移除）=====
    DROP TABLE IF EXISTS friendly_events;
    DROP TABLE IF EXISTS friendly_ref_confirm;
    DROP TABLE IF EXISTS friendly_referee_reports;
    DROP TABLE IF EXISTS friendly_reminders;
    DROP TABLE IF EXISTS friendly_matches;

    -- ===== v61：表演赛（正赛前，管理员填报双方人员；只统计基本信息/比分/点球/事件，不计正赛积分与停赛）=====
    CREATE TABLE IF NOT EXISTS exhibition_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gender TEXT DEFAULT 'men',
      team1_id INTEGER,
      team1_custom TEXT DEFAULT '',
      team2_id INTEGER,
      team2_custom TEXT DEFAULT '',
      match_date TEXT DEFAULT '',
      match_time TEXT DEFAULT '',
      match_location TEXT DEFAULT '三期操场',
      status TEXT DEFAULT 'pending',
      team1_score INTEGER,
      team2_score INTEGER,
      penalty_team1 INTEGER DEFAULT 0,
      penalty_team2 INTEGER DEFAULT 0,
      penalty_winner_side INTEGER,
      main_referee_id INTEGER,
      assistant_ref1_id INTEGER,
      assistant_ref2_id INTEGER,
      notes TEXT DEFAULT '',
      finished_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS exhibition_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      side INTEGER NOT NULL,
      team_id INTEGER,
      player_id INTEGER,
      name TEXT NOT NULL,
      jersey_number INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS exhibition_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      side INTEGER NOT NULL,
      roster_id INTEGER,
      sub_roster_id INTEGER,
      minute INTEGER DEFAULT 0,
      description TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS exhibition_penalties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      side INTEGER NOT NULL,
      roster_id INTEGER,
      scored INTEGER DEFAULT 0,
      kick_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ===== 高频索引（幂等）=====
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_players_team_status ON players(team_id, status);
    CREATE INDEX IF NOT EXISTS idx_players_status ON players(status);
    CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
    CREATE INDEX IF NOT EXISTS idx_matches_round ON matches(round_order, match_number);
    CREATE INDEX IF NOT EXISTS idx_events_match ON match_events(match_id);
    CREATE INDEX IF NOT EXISTS idx_checkins_match ON match_checkins(match_id);
    CREATE INDEX IF NOT EXISTS idx_lineups_match_team ON match_lineups(match_id, team_id);
CREATE INDEX IF NOT EXISTS idx_exh_gender ON exhibition_matches(gender);
CREATE INDEX IF NOT EXISTS idx_exh_players ON exhibition_players(match_id, side);
CREATE INDEX IF NOT EXISTS idx_exh_events ON exhibition_events(match_id);
CREATE INDEX IF NOT EXISTS idx_exh_pen ON exhibition_penalties(match_id, side);
    CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_ann_active ON announcements(is_active, created_at);
    CREATE INDEX IF NOT EXISTS idx_suspensions_player ON suspensions(player_id, active);
    CREATE INDEX IF NOT EXISTS idx_refreports_referee ON referee_reports(referee_id);
    CREATE INDEX IF NOT EXISTS idx_refreport_events_report ON referee_report_events(report_id);
    CREATE INDEX IF NOT EXISTS idx_loginlogs_user ON login_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_oplogs_time ON operation_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_mrc_match ON match_ref_confirm(match_id);
    CREATE INDEX IF NOT EXISTS idx_mrc_ref ON match_ref_confirm(referee_id);
    CREATE INDEX IF NOT EXISTS idx_susp_active ON suspensions(active, discipline_type);
    CREATE INDEX IF NOT EXISTS idx_awards_type ON awards(award_type);
    CREATE INDEX IF NOT EXISTS idx_events_type ON match_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_yellow_resets_team ON yellow_resets(team_id);
  `);
  const dupSerial = db.prepare("SELECT serial_number FROM referees GROUP BY serial_number HAVING COUNT(*)>1").all();
  if (dupSerial.length === 0) {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_referees_serial ON referees(serial_number)');
  }

  migrateMenToV56();
  ensureTestSandbox();
  migrateMatchPhotos();
  seed();
  // 仅在显式启用测试沙箱（ENABLE_TEST_SANDBOX=1）时创建测试账号；生产默认关闭
  if (process.env.ENABLE_TEST_SANDBOX === '1') seedTestUser();
}

// ============================================================
// 旧库检测与一次性重建
// ====================================================
// v56：男子框架（旧18场双回合半决赛，或 v55 的20场）且未抽签/无赛果 → 重建为18场（半决赛单场），账号密码不动
function migrateMenToV56() {
  const menCount = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='men'").get().c;
  if (menCount !== 18 && menCount !== 20) return;
  const placed = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='men' AND round_group IN ('A','B') AND team1_id IS NOT NULL").get().c;
  const played = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='men' AND status IN ('finished','live')").get().c;
  if (placed !== 0 || played !== 0) {
    console.log('男子组已有抽签/赛果，跳过自动框架重建（如需新赛制请管理员手动重置）。');
    return;
  }
  // 已是目标18场且含单场半决赛(SFX/SFY)、无次回合 → 无需重建
  const hasLeg2 = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='men' AND round_group IN ('SFXL2','SFYL2')").get().c;
  const sfSingle = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='men' AND round_group IN ('SFX','SFY')").get().c;
  if (menCount === 18 && hasLeg2 === 0 && sfSingle === 2) return;
  db.prepare("DELETE FROM matches WHERE gender='men'").run();
  db.prepare("DELETE FROM settings WHERE key='men_sf_yellow_reset'").run();
  console.log('已清除旧男子框架，将重建为18场（半决赛单场定胜负），账号密码保持不变。');
}
function migrateToV51() {
  // 测试模式：夹具会创建额外球队，禁止触发破坏性重建（生产不设置 TEST_MODE，安全不变）
  if (process.env.TEST_MODE === '1') return;
  const master = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  // 旧库判定需要按 is_hidden 过滤（隐藏测试队不参与 6/5 数量基线），老库可能尚无该列，先补列
  if (master.includes('teams')) ensureColumn('teams', 'is_hidden', 'is_hidden INTEGER NOT NULL DEFAULT 0');
  let legacy = false;
  if (master.includes('appeals') || master.includes('match_challenges')) legacy = true;
  if (master.includes('matches')) {
    const cols = db.prepare('PRAGMA table_info(matches)').all().map(c => c.name);
    if (cols.includes('fsv_official_id') || cols.includes('is_bye')) legacy = true;
  }
  if (master.includes('teams')) {
    const menN = db.prepare("SELECT COUNT(*) c FROM teams WHERE gender='men' AND deleted_at IS NULL AND COALESCE(is_hidden,0)=0").get().c;
    const womenN = db.prepare("SELECT COUNT(*) c FROM teams WHERE gender='women' AND deleted_at IS NULL AND COALESCE(is_hidden,0)=0").get().c;
    // 空库（刚建、尚未seed）不算旧库
    const anyTeam = menN + womenN;
    if (anyTeam > 0 && (menN !== 6 || womenN !== 5)) legacy = true;
  }
  // 注：比赛场次数不再作为 v51 旧库判据（各版本框架场次数不同，由专属迁移负责）；
  // 旧库仅以“是否含 appeals/挑战/FVS 等旧表旧列、球队数是否为6/5”判定。
  if (!legacy) return;

  console.log('\n========== 检测到旧赛制数据库，执行一次性重建（v51）==========');
  // DROP TABLE 受外键约束可能失败（表间依赖顺序不保证），重建期间临时关闭，完成后恢复
  db.exec('PRAGMA foreign_keys=OFF');
  // 保留会话密钥文件（文件系统，不在库中）；删除全部表/索引/视图
  db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().forEach(t => db.exec(`DROP TRIGGER IF EXISTS ${t.name}`));
  db.prepare("SELECT name FROM sqlite_master WHERE type='view'").all().forEach(t => db.exec(`DROP VIEW IF EXISTS ${t.name}`));
  db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all().forEach(t => { try { db.exec(`DROP INDEX IF EXISTS ${t.name}`); } catch { /* ignore */ } });
  db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().forEach(t => {
  if (t.name !== 'sqlite_sequence') {
    db.exec(`DROP TABLE IF EXISTS ${t.name};`);
  }
});
  db.exec('PRAGMA foreign_keys=ON');
  console.log('旧表已全部删除，将按新赛制全新建库。\n');
}

// ============================================================
// ========== 测试沙箱：列迁移 + 模拟测试球队账号 ==========
function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`);
}
function ensureTestSandbox() {
  ensureColumn('users', 'is_test', 'is_test INTEGER DEFAULT 0');
  ensureColumn('referees', 'photo_path', "photo_path TEXT DEFAULT ''");
  ensureColumn('players', 'test_data', 'test_data INTEGER DEFAULT 0');
  ensureColumn('teams', 'is_hidden', 'is_hidden INTEGER NOT NULL DEFAULT 0');
  ensureColumn('teams', 'leader_phone', "leader_phone TEXT DEFAULT ''");
  ensureColumn('players', 'withdrawn_at', 'withdrawn_at DATETIME');
  ensureColumn('players', 'withdrawn_reason', "withdrawn_reason TEXT DEFAULT ''");
  ensureColumn('players', 'withdrawn_doc_path', "withdrawn_doc_path TEXT DEFAULT ''");
  ensureColumn('players', 'withdrawn_approved_by', 'withdrawn_approved_by INTEGER');
  ensureColumn('players', 'withdrawn_approved_at', 'withdrawn_approved_at DATETIME');
  ensureColumn('players', 'withdraw_pending', 'withdraw_pending INTEGER DEFAULT 0');
  ensureColumn('players', 'is_replacement', 'is_replacement INTEGER DEFAULT 0');
  ensureColumn('players', 'replacement_of', 'replacement_of INTEGER');
  ensureColumn('players', 'reject_reason', "reject_reason TEXT DEFAULT ''");
  ensureColumn('players', 'reject_at', 'reject_at DATETIME');
}
// match_photos 支持“其他活动”图片：match_id 改为可空，新增 photo_type / activity_name
// SQLite 无法直接改 NOT NULL 约束，需重建表并迁移存量照片（存量一律标记为 match）
function migrateMatchPhotos() {
  const master = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='match_photos'").get();
  if (!master) return;
  const cols = db.prepare('PRAGMA table_info(match_photos)').all().map(c => c.name);
  if (cols.includes('photo_type') && cols.includes('activity_name')) return;
  console.log('迁移：match_photos 重建，支持“其他活动”图片');
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec(`
    CREATE TABLE match_photos_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER,
      photo_path TEXT NOT NULL,
      caption TEXT DEFAULT '',
      uploaded_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      photo_type TEXT NOT NULL DEFAULT 'match',
      activity_name TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );
    INSERT INTO match_photos_new (id,match_id,photo_path,caption,uploaded_by,created_at,photo_type,activity_name)
      SELECT id,match_id,photo_path,COALESCE(caption,''),uploaded_by,created_at,'match','' FROM match_photos;
    DROP TABLE match_photos;
    ALTER TABLE match_photos_new RENAME TO match_photos;
  `);
  db.exec('PRAGMA foreign_keys=ON');
}
function seedTestUser() {
  const ex = db.prepare("SELECT id FROM users WHERE username='testteam'").get();
  if (ex) return;
  const pwd = genPassword();
  db.prepare('INSERT INTO users (username,password,role,display_name,team_id,must_change_password,gender,is_test) VALUES (?,?,?,?,?,?,?,1)')
    .run('testteam', bcrypt.hashSync(pwd, 10), 'viewer', '模拟测试球队', null, 0, 'men');
  const f = path.join(dataDir, 'test_account_password.txt');
  fs.writeFileSync(f, [
    '绿岛杯 模拟测试球队账号（沙箱，退出自动清空）',
    '='.repeat(48),
    '账号: testteam',
    '密码: ' + pwd,
    '='.repeat(48),
    '说明：可切换任意组别/球队添加球员；数据仅为测试，对其他端不可见，登出后自动清除。'
  ].join('\n'), 'utf8');
  console.log('\n[测试沙箱] 已创建模拟测试球队账号 testteam，密码见 data/test_account_password.txt');
}

// 种子数据
// ============================================================
function seed() {
  seedUsersAndTeams();
  seedMatches();
  seedSettings();
}

function seedUsersAndTeams() {
  // ===== 账号（仅 users 为空时创建；首次即生成，之后不改动）=====
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const accountList = [];
  if (userCount === 0) {
    // 初始管理员密码：通过环境变量 ADMIN_INIT_PASSWORD 注入；未配置时使用占位值，部署后请立即修改
    const ADMIN_PWD = process.env.ADMIN_INIT_PASSWORD || 'ChangeMe-2026';
    const ins = db.prepare('INSERT INTO users (username,password,role,display_name,team_id,must_change_password,gender) VALUES (?,?,?,?,?,?,?)');
    ins.run('admin', bcrypt.hashSync(ADMIN_PWD, 10), 'admin', '管理员', null, 0, 'men');
    ins.run('admin2', bcrypt.hashSync(ADMIN_PWD, 10), 'admin', '管理员2', null, 0, 'men');
    accountList.push(['管理员', 'admin', ADMIN_PWD, '管理员']);
    accountList.push(['管理员', 'admin2', ADMIN_PWD, '管理员2']);

    MEN_TEAM_NAMES.forEach((name, i) => {
      const pwd = genPassword();
      db.prepare('INSERT INTO users (username,password,role,display_name,team_id,must_change_password,gender) VALUES (?,?,?,?,?,1,?)')
        .run(`visitor${i + 1}`, bcrypt.hashSync(pwd, 10), 'viewer', name, i + 1, 'men');
      accountList.push(['男子球队', `visitor${i + 1}`, pwd, name]);
    });
    WOMEN_TEAM_NAMES.forEach((name, i) => {
      const pwd = genPassword();
      db.prepare('INSERT INTO users (username,password,role,display_name,team_id,must_change_password,gender) VALUES (?,?,?,?,?,1,?)')
        .run(`wvisitor${i + 1}`, bcrypt.hashSync(pwd, 10), 'viewer', name, MEN_TEAM_NAMES.length + i + 1, 'women');
      accountList.push(['女子球队', `wvisitor${i + 1}`, pwd, name]);
    });
  }

  // ===== 球队（缺失才建，保持ID）=====
  const insTeam = db.prepare('INSERT INTO teams (name,gender) VALUES (?,?)');
  MEN_TEAM_NAMES.forEach(n => {
    const ex = db.prepare("SELECT id FROM teams WHERE gender='men' AND name=?").get(n);
    if (!ex) insTeam.run(n, 'men');
  });
  WOMEN_TEAM_NAMES.forEach(n => {
    const ex = db.prepare("SELECT id FROM teams WHERE gender='women' AND name=?").get(n);
    if (!ex) insTeam.run(n, 'women');
  });

  if (accountList.length) {
    const ts = Date.now();
    const pwdFile = path.join(dataDir, `account_passwords_reset_${ts}.txt`);
    const lines = [
      `绿岛杯账号密码清单（v51 全新生成，时间：${new Date().toLocaleString('zh-CN')}）`,
      '='.repeat(64),
      ...accountList.map(([type, u, p, disp]) => `[${type}] ${disp}  账号: ${u}  密码: ${p}`),
      '='.repeat(64),
      '球队账号首次登录须修改密码；管理员账号密码固定。请妥善保管。',
    ];
    fs.writeFileSync(pwdFile, lines.join('\n'), 'utf8');
    console.log('\n========== v51 账号密码已生成 ==========');
    console.log(lines.slice(0, lines.length - 2).join('\n'));
    console.log(`清单文件：${pwdFile}\n`);
  }
}

function seedMatches() {
  // ===== 男子小组赛（12场）=====
  const have = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='men'").get().c;
  if (have === 0) {
    const ins = db.prepare(`INSERT INTO matches
      (match_number,gender,round_name,round_group,round_order,team1_source,team2_source,match_location)
      VALUES (?,?,?,?,?,?,?,?)`);
    MEN_GROUP_SEED.forEach(([num, rnd, grp, h, a]) => {
      ins.run(num, 'men', `小组赛第${rnd}轮`, grp, rnd, h, a, '三期操场');
    });
    MEN_KO_SEED.forEach(([num, rn, rg, s1, s2]) => {
      ins.run(num, 'men', rn, rg, 0, s1, s2, '三期操场');
    });
  }
  // ===== 女子单循环（10场）=====
  const haveW = db.prepare("SELECT COUNT(*) c FROM matches WHERE gender='women'").get().c;
  if (haveW === 0) {
    const ins = db.prepare(`INSERT INTO matches
      (match_number,gender,round_name,round_group,round_order,team1_source,team2_source,match_location,notes)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    WOMEN_SEED.forEach(([num, rnd, s1, s2, bye]) => {
      ins.run(num, 'women', `第${rnd}轮`, 'RR', rnd, s1, s2, '三期操场', `本轮 ${bye} 号队轮空`);
    });
  }
}

function seedSettings() {
  const s = db.prepare('SELECT COUNT(*) as c FROM settings').get().c;
  if (s === 0) {
    db.prepare("INSERT INTO settings (key,value) VALUES ('tournament_status','pending')").run();
    db.prepare("INSERT INTO settings (key,value) VALUES ('maintenance_enabled','1')").run();
    db.prepare("INSERT INTO settings (key,value) VALUES ('maintenance_manual','0')").run();
  }
}

module.exports = {
  db,
  init,
  MEN_TEAM_NAMES,
  WOMEN_TEAM_NAMES,
  MEN_GROUP_SEED,
  MEN_KO_SEED,
  WOMEN_SEED,
  genPassword,
};
