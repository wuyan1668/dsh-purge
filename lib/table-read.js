import { createDecipheriv } from "node:crypto";
import { inflateSync } from "node:zlib";
import { SLOTS } from "./asset-table.js";
import { mixKey } from "./table-key.js";

/**
 * 解一个提示词槽。
 *
 * 槽是出厂提示词的加密副本，一个变体一个槽（default / claude / …）。
 * 名字不认识就回落到 default；解不开（密钥对不上 / 槽被截断）就返回空串，
 * 调用方按「没有出厂稿」处理。
 */
export function openSlot(name = "default") {
  try {
    const slot = (SLOTS && SLOTS[name]) || (SLOTS && SLOTS.default);
    if (!slot) return "";
    const decipher = createDecipheriv("aes-256-gcm", mixKey(slot.MASK), Buffer.from(slot.IV, "base64"));
    decipher.setAuthTag(Buffer.from(slot.TAG, "base64"));
    const raw = Buffer.concat([
      decipher.update(Buffer.from(slot.SLOT, "base64")),
      decipher.final(),
    ]);
    return inflateSync(raw).toString("utf8");
  } catch {
    return "";
  }
}

/** 槽里都有哪些变体（default 一定在里面）。 */
export function slotNames() {
  const names = Object.keys(SLOTS || {});
  return names.includes("default") ? names : ["default", ...names];
}
