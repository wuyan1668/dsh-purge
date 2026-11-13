/**
 * 提示词变体：出厂提示词按模型族 / 语言分成多份，运行时按当前模型自动选一份。
 *
 * 纯逻辑模块 —— 不读盘、不 import 宿主任何东西，方便单测。
 * 读盘（变体配置、用户稿、加密槽）由 lib/core.js 负责。
 */

/** 默认变体名。永远存在，出厂稿与用户主稿都归它。 */
export const DEFAULT_VARIANT = "default";

/** 变体名只允许小写字母数字和 - _。 */
export function normalizeVariantName(name) {
  const n = String(name ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(n) ? n : "";
}

/**
 * 变体对应的磁盘文件名。
 * default 用主稿 prompt-inject.md（用户文件，语义不变）；
 * 其余变体用 prompt-inject.<name>.md，存在即用户为该变体写的稿。
 */
export function variantFileName(name) {
  const n = normalizeVariantName(name);
  if (!n || n === DEFAULT_VARIANT) return "prompt-inject.md";
  return `prompt-inject.${n}.md`;
}

/**
 * 内置规则：provider / model 按正则匹配（不区分大小写），先匹配先生效。
 *
 * 只写了出厂确实存在的变体 —— 对应的变体不在可用列表里就跳过，回落 default。
 * 用户可以在 $DSH_HOME/dsh-purge/variants.json 里追加或覆盖。
 *
 * Qwen 走**型号**匹配而不是 provider 匹配：
 * 宿主的 qwen-token-plan* 是百炼 Token Plan 的**聚合**通道，同一个 provider 下
 * 同时挂着 deepseek-v4-* / glm-5.* / kimi-k2.* / MiniMax-M2.5 / qwen3.*。
 * 按 provider 匹配会把这些非 Qwen 型号一起带到 qwen 变体上去。
 * 型号前缀 ^qwen 同时覆盖百炼直供（qwen4-max-preview、qwen-plus）、
 * OpenRouter（qwen/qwen4-72b）与自建 vLLM（Qwen/Qwen4-72B），不区分大小写。
 */
export const BUILTIN_RULES = [
  { provider: "anthropic", variant: "claude" },
  { provider: "claude", variant: "claude" },
  { model: "^claude", variant: "claude" },
  { model: "^qwen", variant: "qwen" },
  { model: "^qwq", variant: "qwen" },
];

/**
 * 规则匹配。返回命中的变体名，没命中返回空串。
 *
 * 一条规则里 provider 与 model 都写时，**两个都要中**（AND）；
 * 只写一个就只按那个匹配。
 *
 * model 匹配的是宿主给的 `model` 字段本身（如 `qwen3.8-max`、`qwen/qwen4-72b`），
 * **不是** `provider/model` 拼起来的整串 —— 写成 `^claude` 匹配的是型号前缀，
 * 拼上 provider 反而匹配不上。
 */
export function matchVariant(modelSelection, rules) {
  const sel = modelSelection || {};
  const provider = String(sel.provider ?? "").trim();
  const model = String(sel.model ?? "").trim();
  if (!provider && !model) return "";
  const list = Array.isArray(rules) ? rules : [];
  for (const rule of list) {
    if (!rule || typeof rule !== "object") continue;
    const variant = normalizeVariantName(rule.variant);
    if (!variant) continue;
    const p = String(rule.provider ?? "").trim();
    const m = String(rule.model ?? "").trim();
    if (!p && !m) continue;
    if (p && !matchOne(p, provider)) continue;
    if (m && !matchOne(m, model)) continue;
    return variant;
  }
  return "";
}

function matchOne(pattern, value) {
  if (!value) return false;
  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    // 非法正则就当字面量比一次，配置写错不至于把整个选择流程带崩。
    return value.toLowerCase() === pattern.toLowerCase();
  }
}

/**
 * 选变体。
 *
 * @param {object} options
 * @param {object} [options.modelSelection] 宿主给的 { provider, model }
 * @param {string[]} [options.available] 可用变体（槽里有的 + 用户写过的）
 * @param {object} [options.config] 变体配置 { active, rules }
 * @returns {{ variant: string, source: "pinned"|"rule"|"default" }}
 */
export function resolveVariant(options = {}) {
  const available = new Set(
    (Array.isArray(options.available) ? options.available : []).map(normalizeVariantName).filter(Boolean),
  );
  available.add(DEFAULT_VARIANT);
  const config = options.config && typeof options.config === "object" ? options.config : {};

  // 手动锁定优先：active 写死了某个变体就直接用它。
  const pinned = normalizeVariantName(config.active);
  if (pinned && pinned !== "auto" && available.has(pinned)) {
    return { variant: pinned, source: "pinned" };
  }

  const rules = [...(Array.isArray(config.rules) ? config.rules : []), ...BUILTIN_RULES];
  const hit = matchVariant(options.modelSelection, rules);
  if (hit && available.has(hit)) {
    return { variant: hit, source: "rule" };
  }
  return { variant: DEFAULT_VARIANT, source: "default" };
}

/**
 * 用户为某个变体写的稿存在与否（决定 UI 上显示「已改」还是「默认」）。
 * 这里只管文件名，判存在由调用方做。
 */
export function isUserVariant(name) {
  const n = normalizeVariantName(name);
  return Boolean(n) && n !== DEFAULT_VARIANT;
}
