/**
 * 本地存档（业务文件 3/3）
 * 浏览器 localStorage 读写、JSON 导入导出、清空。
 * 不包含任何业务规则，只负责档案对象的持久化。
 */

import { createInitialState, normalizeState, STATE_VERSION } from './archive.js';

const STORAGE_KEY = 'pump-station-ledger-v1';

/** 读取本地档案；无存档时返回初始档案（不写盘，首次操作时再保存）。 */
export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialState();
    return normalizeState(JSON.parse(raw));
  } catch (err) {
    throw new Error(`读取本地存档失败：${err.message}`);
  }
}

/** 保存档案到本机浏览器。 */
export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `存档失败：${err.message}` };
  }
}

/** 清空本机存档并恢复初始档案。 */
export function clearSaved() {
  localStorage.removeItem(STORAGE_KEY);
  return createInitialState();
}

/** 导出为 JSON 文件。 */
export function exportToFile(state) {
  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `泵站台账存档_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}.json`;
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** 解析导入的 JSON 文件文本，返回规范化档案。 */
export function parseImport(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的 JSON');
  }
  if (!raw || raw.version !== STATE_VERSION || !Array.isArray(raw.pumps) || raw.pumps.length !== 4) {
    throw new Error('存档内容与四泵组档案结构不符');
  }
  return normalizeState(raw);
}
