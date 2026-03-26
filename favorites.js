'use strict';

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'favorites.json');

function _load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return {}; }
}

function _save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

/**
 * @param {string} userId
 * @returns {Array<{ uri: string, title: string, savedAt: string }>}
 */
function getFavorites(userId) {
  const entry = _load()[userId];
  if (!entry) return [];
  // 相容舊格式（單一物件 → 陣列）
  return Array.isArray(entry) ? entry : [entry];
}

/**
 * Add a track to user's favorites. Returns false if already exists.
 * @param {string} userId
 * @param {{ uri: string, title: string }} track
 * @returns {boolean}
 */
function addFavorite(userId, track) {
  const data = _load();
  const list = Array.isArray(data[userId]) ? data[userId]
             : data[userId] ? [data[userId]]
             : [];

  if (list.some(t => t.uri === track.uri)) return false;

  list.push({ uri: track.uri, title: track.title, savedAt: new Date().toISOString() });
  data[userId] = list;
  _save(data);
  return true;
}

module.exports = { getFavorites, addFavorite };
