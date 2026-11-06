/**
 * 【已废弃 · v59 起停用】
 * 原 migrate_rename_teams.cjs 是 v45 赛制（男7女6、双回合半决赛）的一次性迁移脚本，
 * 其改名映射与引用的列（has_extra_time / fsv_official_id / is_bye）在当前赛制下已不存在，
 * 运行会失败甚至可能改乱队名，因此替换为本桩，拒绝执行。
 *
 * 当前如需"回到待抽签全新态"，请使用管理员后台【数据重置】功能（口径与系统一致、带备份）；
 * 如需重置密码，请运行 scripts/reset_all_passwords.cjs（已改为全随机密码）。
 */
console.error('[已废弃] 该迁移脚本适用于 v45 旧赛制，已不可用，请勿运行。');
console.error('        全新态请用管理员后台"数据重置"；重置密码请用 scripts/reset_all_passwords.cjs。');
process.exit(1);
