#!/usr/bin/env node
/**
 * #15 版本号自动化
 *
 * 单一真源：package.json 的 "version"。
 * 本脚本把它同步写入：
 *   1. src-tauri/tauri.conf.json  的 "version"
 *   2. src-tauri/Cargo.toml       的 [package] version
 *   3. src-tauri/Cargo.toml       [dependencies] 段里 muhai 自身的 version（若存在）
 *
 * 用法：
 *   node scripts/sync-version.mjs        # 按 package.json 同步各处
 *   node scripts/sync-version.mjs 3.6.0  # 先改 package.json 再同步
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const pkgPath = resolve(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

// 允许命令行直接指定新版本
const argVer = process.argv[2];
if (argVer) {
  if (!/^\d+\.\d+\.\d+([-+].+)?$/.test(argVer)) {
    console.error(`✗ 非法版本号：${argVer}（应为 x.y.z）`);
    process.exit(1);
  }
  pkg.version = argVer;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  console.log(`✓ package.json → ${argVer}`);
}

const ver = pkg.version;
if (!ver) {
  console.error('✗ package.json 缺少 version 字段');
  process.exit(1);
}

let changed = 0;

// 1) tauri.conf.json
{
  const f = resolve(root, 'src-tauri/tauri.conf.json');
  const raw = readFileSync(f, 'utf-8');
  const next = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${ver}$2`);
  if (next !== raw) {
    writeFileSync(f, next, 'utf-8');
    console.log(`✓ src-tauri/tauri.conf.json → ${ver}`);
    changed++;
  } else {
    console.log(`= src-tauri/tauri.conf.json 已是 ${ver}`);
  }
}

// 2) Cargo.toml —— [package] 段的 version（只改第一处 package 版本）
{
  const f = resolve(root, 'src-tauri/Cargo.toml');
  const raw = readFileSync(f, 'utf-8');
  let done = false;
  const next = raw.replace(/^(version\s*=\s*")[^"]*(")/m, (m, a, b) => {
    if (done) return m;
    done = true;
    return `${a}${ver}${b}`;
  });
  if (next !== raw) {
    writeFileSync(f, next, 'utf-8');
    console.log(`✓ src-tauri/Cargo.toml → ${ver}`);
    changed++;
  } else {
    console.log(`= src-tauri/Cargo.toml 已是 ${ver}`);
  }
}

console.log(`\n完成：package.json = ${ver}，共同步 ${changed} 个文件。`);
