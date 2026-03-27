'use strict';

const fs   = require('fs');
const path = require('path');

// 最愛歌單的持久化存放路徑（與專案同目錄）
const FILE = path.join(__dirname, 'favorites.json');

/**
 * 從磁碟讀取最愛資料，讀取失敗（檔案不存在或格式錯誤）時回傳空物件。
 * @returns {{ [userId: string]: Array<{ uri: string, title: string, savedAt: string }> | object }}
 */
function _load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return {}; }
}

/**
 * 將最愛資料寫入磁碟（同步，格式化 JSON 方便手動編輯）。
 * @param {object} data
 */
function _save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

/**
 * 取得指定使用者的最愛歌曲清單。
 * 相容舊版單一物件格式（自動轉為陣列）。
 * @param {string} userId  Discord 使用者 ID
 * @returns {Array<{ uri: string, title: string, savedAt: string }>}
 */
function getFavorites(userId) {
  const entry = _load()[userId];
  if (!entry) return [];
  // 舊格式為單一物件，新格式為陣列；統一回傳陣列
  return Array.isArray(entry) ? entry : [entry];
}

/**
 * 將曲目加入使用者的最愛歌單。
 * 若同一 URI 已存在則不重複新增，回傳 false。
 * @param {string} userId                        Discord 使用者 ID
 * @param {{ uri: string, title: string }} track  要新增的曲目資訊
 * @returns {boolean} true = 成功新增；false = 已存在
 */
function addFavorite(userId, track) {
  const data = _load();
  // 相容舊格式：若現有值為單一物件，先轉為陣列
  const list = Array.isArray(data[userId]) ? data[userId]
             : data[userId] ? [data[userId]]
             : [];

  // 以 URI 判斷是否已有相同歌曲
  if (list.some(t => t.uri === track.uri)) return false;

  // 加入新曲目並記錄儲存時間
  list.push({ uri: track.uri, title: track.title, savedAt: new Date().toISOString() });
  data[userId] = list;
  _save(data);
  return true;
}

module.exports = { getFavorites, addFavorite };
