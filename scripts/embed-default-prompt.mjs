/**
 * 把出厂提示词封进加密槽。
 *
 * 一份变体一个槽：
 *   lib/default-prompt-inject.md        → default（必需）
 *   lib/default-prompt-inject.<name>.md → <name>（有就封，没有就跳过）
 *
 * 明文原文只在本机维护，仓库里只留加密后的 lib/asset-table.js。
 *
 * 用法：node scripts/embed-default-prompt.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sealSlot } from "../lib/table-key.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const libDir = path.join(root, "lib");
const dest = path.join(libDir, "asset-table.js");

/** 变体名只允许小写字母数字和 - _，免得拼出路径穿越。 */
function validVariantName(name) {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name);
}

function readSource(file) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.trim()) throw new Error(`empty source: ${file}`);
  return text;
}

const sources = new Map();

// default 必需
const defaultFile = path.join(libDir, "default-prompt-inject.md");
if (!fs.existsSync(defaultFile)) {
  throw new Error(`missing local source: ${defaultFile}`);
}
sources.set("default", readSource(defaultFile));

// 变体：lib/default-prompt-inject.<name>.md
for (const entry of fs.readdirSync(libDir)) {
  const m = /^default-prompt-inject\.([a-z0-9][a-z0-9_-]{0,31})\.md$/i.exec(entry);
  if (!m) continue;
  const name = m[1].toLowerCase();
  if (name === "md") continue;
  if (!validVariantName(name)) {
    throw new Error(`invalid variant name: ${entry}`);
  }
  if (sources.has(name)) continue;
  sources.set(name, readSource(path.join(libDir, entry)));
}

const rows = {};
const meta = {};
for (const [name, text] of sources) {
  const packed = sealSlot(text);
  const chunk = (s, n = 96) => {
    const out = [];
    for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
    return out;
  };
  rows[name] = chunk(packed.SLOT);
  meta[name] = { MASK: packed.MASK, TAG: packed.TAG, IV: packed.IV };
  process.stdout.write(`sealed ${name}: ${text.length} chars\n`);
}

const out = `const SLOT_ROWS = ${JSON.stringify(rows, null, 2)};

const SLOT_META = ${JSON.stringify(meta, null, 2)};

/**
 * 提示词变体的加密槽：一个变体一个槽。
 * default 是出厂默认稿，其余按模型族或语言分（见 lib/prompt-variant.js）。
 */
export const SLOTS = Object.fromEntries(
  Object.entries(SLOT_ROWS).map(([name, chunks]) => [
    name,
    { SLOT: chunks.join(""), ...SLOT_META[name] },
  ]),
);

// 兼容旧导出：默认槽。老代码只认平铺的四个常量。
export const SLOT = SLOTS.default.SLOT;
export const MASK = SLOTS.default.MASK;
export const TAG = SLOTS.default.TAG;
export const IV = SLOTS.default.IV;
`;

fs.writeFileSync(dest, out, "utf8");
process.stdout.write(
  `wrote ${path.relative(root, dest)} variants=${[...sources.keys()].join(",")}\n`,
);
