/**
 * 维护脚本：重置账号密码（手动运行，重启/部署不会自动执行）
 * 用法：node scripts/reset_all_passwords.cjs
 *   可选环境变量：ADMIN_RESET_PASSWORD=xxxx  同时重置管理员密码（不设置则管理员保持不变，避免误锁定）
 * 规则：
 *   - 全部使用 crypto 安全随机生成（不再有任何硬编码密码）；仅字母+数字、10位、必含字母与数字
 *   - 球队账号重置后首次登录强制改密；裁判账号随机重置但不强制；同时解除所有锁定
 *   - 清单仅写入 data/account_passwords_reset_<时间戳>.txt（权限 600），并在控制台打印
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'data', 'cup.db');
if (!fs.existsSync(DB_FILE)) { console.error('数据库不存在:', DB_FILE); process.exit(1); }
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

function genPassword(len = 10) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = letters + digits;
  let pwd;
  do {
    pwd = '';
    for (let i = 0; i < len; i++) pwd += all[crypto.randomInt(all.length)];
  } while (!/[a-zA-Z]/.test(pwd) || !/\d/.test(pwd));
  return pwd;
}

const users = db.prepare('SELECT id, username, role, display_name, team_id, gender, COALESCE(is_test,0) is_test FROM users ORDER BY role DESC, id').all();
const upd = db.prepare('UPDATE users SET password=?, must_change_password=?, failed_attempts=0, locked_until=NULL WHERE id=?');
const lines = [`绿岛杯账号密码【全量随机重置】清单（重置时间：${new Date().toLocaleString('zh-CN')}）`, '='.repeat(64)];
const recs = [];
for (const u of users) {
  let pwd, mustChange;
  if (u.role === 'admin') {
    pwd = process.env.ADMIN_RESET_PASSWORD;
    if (!pwd) { recs.push({ ...u, pwd: '（未重置）', mustChange: 0, tag: '管理员' }); continue; }
    mustChange = 0;
  } else if (u.role === 'viewer') {
    pwd = genPassword(10); mustChange = 1;
  } else { // referee 等
    pwd = genPassword(10); mustChange = 0;
  }
  upd.run(bcrypt.hashSync(pwd, 10), mustChange, u.id);
  const tag = u.role === 'admin' ? '管理员' : (u.role === 'referee' ? '裁判员' : (u.is_test === 1 ? '测试账号' : (u.gender === 'women' ? '女队' : '男队')));
  recs.push({ ...u, pwd, mustChange, tag });
}

for (const tag of ['管理员', '裁判员', '男队', '女队', '测试账号']) {
  const group = recs.filter(r => r.tag === tag);
  if (!group.length) continue;
  lines.push(`【${tag}】`);
  group.forEach(r => lines.push(`  ${r.display_name || r.username}  账号: ${r.username}  新密码: ${r.pwd}${r.mustChange ? '（首登强制改密）' : ''}`));
  lines.push('');
}
lines.push('='.repeat(64), '说明：密码均为本次安全随机生成、无硬编码；球队账号首登强制改密；本脚本仅手动运行。');
const out = lines.join('\n');
const file = path.join(ROOT, 'data', `account_passwords_reset_${Date.now()}.txt`);
fs.writeFileSync(file, out, { mode: 0o600 });
try { fs.chmodSync(file, 0o600); } catch (e) { /* Windows 上 chmod 支持有限，ACL 已默认仅当前用户 */ }
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
console.log(out);
console.log('\n已保存到:', file);
