/**
 * 运行时回执（receipt）—— 「这一轮到底注入了谁」。
 *
 * 为什么单独一个文件而不是塞进 chains.jsonl：
 *   chains 是**记忆事件的账本**（该记多久的东西），
 *   回执是**运行时的观测**（只回答"这一轮发生了什么"，TTL 很短）。
 *   两者混在一起，夜巡会把回执当成待分类碎片，注入预算也会被它挤占。
 *
 * 形态：`receipts.jsonl`，一行一条，只保留最近 KEEP 条。
 * 写失败**绝不影响注入** —— 调用方包在 try/catch 里，这里也从不抛。
 */

import fs from 'node:fs';
import path from 'node:path';
import { storeDir } from './config.js';

/** 只留最近这么多条；再多就滚动截断。 */
const KEEP = 200;

/** 单条回执里的条目 id 最多记这么多（防一条回执撑爆文件）。 */
const MAX_IDS = 80;

/**
 * 回执文件路径 —— 与 chains.jsonl 同目录。
 * @returns 绝对路径。
 */
export function receiptFile() {
  return path.join(storeDir(), 'receipts.jsonl');
}

/**
 * 记一条回执。**永不抛**。
 *
 * @param record - `{ scopeId, userTextLen, candidateCount, emittedChars, byPool, ids, hits }`
 * @returns 写入成功 true；失败 false。
 */
export function recordReceipt(record) {
  try {
    const file = receiptFile();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      scope: String(record.scopeId || '').slice(0, 80),
      textLen: Number(record.userTextLen) || 0,
      candidates: Number(record.candidateCount) || 0,
      emitted: Number(record.emittedCount) || 0,
      chars: Number(record.emittedChars) || 0,
      byPool: record.byPool || {},
      ids: (Array.isArray(record.ids) ? record.ids : []).slice(0, MAX_IDS).map(String),
      hits: (Array.isArray(record.hits) ? record.hits : []).slice(0, MAX_IDS).map(String),
    });
    fs.appendFileSync(file, line + '\n', 'utf8');
    prune(file);
    return true;
  } catch {
    return false;   // 记账失败不是故障，注入照常
  }
}

/** 行数超了 KEEP 就重写一次（低频，写时顺手做）。 */
function prune(file) {
  try {
    if (fs.statSync(file).size < 256 * 1024) return;   // 小于 256KB 先不折腾
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
    if (lines.length <= KEEP) return;
    fs.writeFileSync(file, lines.slice(-KEEP).join('\n') + '\n', 'utf8');
  } catch {
    /* 截断失败不影响主流程 */
  }
}

/**
 * 读最近的回执（新的在前）。
 *
 * @param limit - 要几条，默认 20。
 * @returns `{ count, receipts }`；读失败给空。
 */
export function readReceipts(limit = 20) {
  try {
    const file = receiptFile();
    if (!fs.existsSync(file)) return { count: 0, receipts: [] };
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        /* 单行坏掉就跳过，别让整个观测挂掉 */
      }
    }
    return { count: lines.length, receipts: out };
  } catch {
    return { count: 0, receipts: [] };
  }
}
