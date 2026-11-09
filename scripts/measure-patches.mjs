#!/usr/bin/env node
/**
 * 补丁命中测量 / patch hit measurement
 *
 * --status 只报 applied / pending / na / missing_file，看不见「命中几次」。
 * 命中次数才是判断补丁有没有漂移、会不会自匹配叠层的硬指标。
 *
 * 本工具按 pattern 逐个量：
 *   0 次     → 这条 pattern 在本机宿主里不存在（上游改了原文 / 属于另一种上游布局）
 *   1 次     → 正常
 *   2 次以上 → 同一段原文在文件里出现多份，一次 Apply 会写多份（自匹配 / 叠层）
 *
 * 补丁级结论不按「某条 pattern 没命中」算 —— 一条补丁的多个 replacement 是
 * 「同一件事在不同上游布局下的几套写法」，命中任意一条就说明这条补丁可用。
 * 所以补丁级的漂移判据是 core.js 自己的 filePatchOutcome：
 * 把干净原文喂给它，得到的就是「全新装好的宿主上这条补丁会是什么状态」。
 *
 * 测量口径：针对「干净宿主原文」。
 * 本机宿主已经被本插件打过补丁，每个改过的文件旁都有 <file>.dshpurge.bak（改动前的官方原件），
 * 所以优先拿 .bak 当原文（等价于全新安装的宿主）；没有 .bak 才用当前文件。
 *
 * 纯只读：不写宿主、不改宿主、不跑 apply / revert / uninstall。
 * 唯一写出去的是 --json 指定的测量报告。
 *
 * 用法：
 *   node scripts/measure-patches.mjs                测全部补丁
 *   node scripts/measure-patches.mjs --id 95,96     只测指定 id
 *   node scripts/measure-patches.mjs --risk         只输出有风险的
 *   node scripts/measure-patches.mjs --json <路径>  指定 JSON 输出路径
 */
import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ALL_PATCHES,
  applyReplacementsToText,
  filePatchOutcome,
  findAiBase,
  findDshHome,
  isSelfMarkedPatch,
  isUserProfilePatchFile,
  patchReplacements,
  patchStatus,
  readHostVersion,
  targetFiles,
} from "../lib/core.js";

// 默认报告落点。--json 可以改。
const DEFAULT_JSON = "D:\\deepseek\\work\\audit\\patch-measurement.json";

const args = process.argv.slice(2);

function argValue(name) {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= args.length) return "";
  return args[i + 1];
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`补丁命中测量 / patch hit measurement
  --id <95,96>      只测指定补丁 id（默认全部）
  --risk            只输出有风险的（漂移 / 自匹配 / 命中数不符 / 目标缺失 / 链断 / 会叠层）
  --json <路径>     JSON 报告输出路径（默认 ${DEFAULT_JSON}）
  --help            本帮助

纯只读：只读宿主文件与 .dshpurge.bak，不写宿主、不跑 apply。`);
  process.exit(0);
}

const idArg = argValue("id");
const onlyIds = idArg
  ? new Set(
    idArg
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n)),
  )
  : null;
const riskOnly = args.includes("--risk");
const jsonOut = path.resolve(argValue("json") || DEFAULT_JSON);

/** 与 core.js 的 asLf 保持一致：所有比对都在 LF 上做。 */
const asLf = (t) => (typeof t === "string" ? t.replace(/\r\n/g, "\n") : t);

/**
 * 数一个 pattern 在一段文本里的命中次数。
 * 字符串走 split（core.js applyReplacementsToText 同一口径）；
 * 正则走 cloneRegExp(pattern, true) 的全局匹配，零宽匹配手动推进 lastIndex 防死循环。
 */
function countHits(hay, pattern) {
  if (pattern instanceof RegExp) {
    const flags = String(pattern.flags || "").replace("g", "") + "g";
    const re = new RegExp(pattern.source, flags);
    let n = 0;
    let m;
    while ((m = re.exec(hay)) !== null) {
      n += 1;
      if (m[0] === "") re.lastIndex += 1;
      if (n > 100000) break;
    }
    return n;
  }
  const needle = asLf(pattern);
  if (!needle) return 0;
  return hay.split(needle).length - 1;
}

function readText(fp) {
  try {
    return asLf(readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 干净原文的来源。
 * 用户 profile 层（profiles/<name>/cordis.patch.yml）是用户自己写的 insert，
 * core.js 明确不认它的 .bak（isUserProfilePatchFile），这里跟着同一口径走。
 */
function cleanSourceOf(fp) {
  if (isUserProfilePatchFile(fp)) return { path: fp, source: "current" };
  const bak = `${fp}.dshpurge.bak`;
  try {
    const st = statSync(bak);
    if (st.isFile() && st.size > 0) return { path: bak, source: "bak" };
  } catch {
    /* 没有 bak 就用当前文件 */
  }
  return { path: fp, source: "current" };
}

/** targetFiles 的值可能是字符串、可能是数组；core.js 的 pathsOf 不导出，这里照抄一份。 */
function pathsOfKey(files, key) {
  const v = files[key];
  if (v == null || v === "") return [];
  const list = Array.isArray(v) ? v : [v];
  return list.filter((p) => p && existsSync(p));
}

/** 补丁的 file 字段：字符串 / 数组 / 逗号分隔串都见过（core.js 两处口径不同，这里取并集）。 */
function fileKeysOf(p) {
  const raw = Array.isArray(p.file) ? p.file : String(p.file || "").split(",");
  return raw.map((k) => String(k || "").trim()).filter(Boolean);
}

/** 终端表格要按显示宽度对齐：中文是双宽字符。 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0);
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(s, n) {
  const t = String(s ?? "");
  const w = dispWidth(t);
  return w >= n ? t : t + " ".repeat(n - w);
}

/** pattern 预览：只留第一行，多行 pattern 标注行数，截断到 58 字符。 */
function previewOf(pattern) {
  const raw = pattern instanceof RegExp ? pattern.source : String(pattern ?? "");
  const lines = raw.split("\n");
  const one = lines[0].replace(/\t/g, " ").trim();
  const head = one.length > 58 ? one.slice(0, 57) + "…" : one;
  return lines.length > 1 ? `${head} ⏎${lines.length}行` : head;
}

/** 命中分布：12 个 pattern 各中 1 次 → "12×1"；混着来 → "9×1, 3×0"。 */
function hitsSummary(counts) {
  if (!counts.length) return "—";
  const bucket = new Map();
  for (const n of counts) bucket.set(n, (bucket.get(n) || 0) + 1);
  return [...bucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, c]) => `${c}×${n}`)
    .join(", ");
}

const RISK_TAG = {
  drift: "整体漂移",
  "self-match": "自匹配",
  "expect-mismatch": "命中数不符",
  "no-target": "目标缺失",
  "chain-broken": "链断了",
  "stack-risk": "会叠层",
  "marker-guarded": "自指但有 marker 兜底",
  chained: "链式",
  "self-marked": "自标记",
  optional: "可选",
  satisfied: "原文已满足",
  miss: "未命中",
};

/** 补丁级判定里，哪些算「风险」（会进 --risk 列表 / 风险清单）。 */
const RISK_VERDICTS = new Set(["drift", "self-match", "expect-mismatch", "no-target", "chain-broken", "stack-risk"]);

async function main() {
  const aiBase = findAiBase();
  const dshHome = findDshHome();
  if (!aiBase) {
    console.error("[ERROR] 没定位到宿主插件根（@deepseek-ai），无法测量。");
    process.exit(1);
  }
  const files = targetFiles(aiBase, dshHome);
  const hostVersion = readHostVersion(aiBase) || {};
  const surface = (await import("../lib/surface.js")).detectSurface();

  // --status 的口径就是 patchStatus()（core.js gatherState 用的同一个函数），只读。
  let status = {};
  try {
    status = await patchStatus(aiBase);
  } catch (e) {
    console.error(`[WARN] 取 --status 口径失败：${e && e.message ? e.message : e}`);
  }

  const patches = onlyIds ? ALL_PATCHES.filter((p) => onlyIds.has(p.id)) : ALL_PATCHES;
  const results = [];

  for (const p of patches) {
    const keys = fileKeysOf(p);
    const targets = [];
    for (const key of keys) {
      const fps = pathsOfKey(files, key);
      if (!fps.length) {
        targets.push({ key, path: "", exists: false, cleanPath: "", cleanSource: "missing", cleanText: null, currentText: null });
        continue;
      }
      for (const fp of fps) {
        const clean = cleanSourceOf(fp);
        const currentText = readText(fp);
        targets.push({
          key,
          path: fp,
          exists: true,
          cleanPath: clean.path,
          cleanSource: clean.source,
          cleanText: readText(clean.path),
          currentText,
          // 当前文件（已打过补丁）上的判定：applied = marker 在（skipIfMarked 生效，不会重复写）
          // pending = marker 不在且还有 pattern 留着 → 再 Apply 一次会再写一遍（叠层）。
          currentOutcome: currentText == null ? "missing" : filePatchOutcome(currentText, p, fp),
        });
      }
    }
    const liveTargets = targets.filter((t) => t.exists);
    const missingKeys = targets.filter((t) => !t.exists).map((t) => t.key);
    const reps = patchReplacements(p) || [];
    const selfMarked = isSelfMarkedPatch(p);
    const chainedAfter = Array.isArray(p.after) ? p.after.filter((id) => Number.isInteger(id)) : [];

    // 链式补丁（after: [上游 id]）的 pattern 是上游补丁写进宿主的产物，
    // 干净原文里本来就不该有。要判它漂不漂，得先把上游补丁在内存里跑一遍
    // （applyReplacementsToText 是纯函数，不碰文件），再看产物里 pattern 命中几次。
    const producers = chainedAfter.map((id) => ALL_PATCHES.find((x) => x.id === id)).filter(Boolean);
    const chainText = new Map(); // path → 跑完上游补丁之后的文本
    if (producers.length && liveTargets.length) {
      for (const t of liveTargets) {
        if (t.cleanText == null) continue;
        let text = t.cleanText;
        for (const producer of producers) {
          try {
            text = applyReplacementsToText(text, producer, t.path).text;
          } catch {
            /* 上游补丁跑不起来就按原样继续 */
          }
        }
        chainText.set(t.path, text);
      }
    }

    // 「打完补丁之后 pattern 还在不在」——真叠层的唯一判据。
    // 只看当前文件是不准的：还没 Apply 的补丁当然还留着 pattern，那不是风险；
    // 真正的风险是替换后的文本仍然能被自己的 pattern 命中（自指），Apply 一次就长一层。
    const afterText = new Map();
    const afterOutcome = new Map();
    for (const t of liveTargets) {
      if (t.cleanText == null) continue;
      try {
        const after = applyReplacementsToText(t.cleanText, p, t.path).text;
        afterText.set(t.path, after);
        // 打完之后的判定：marker 在 → skipIfMarked 会挡住下一次 Apply（不会真叠层）。
        afterOutcome.set(t.path, filePatchOutcome(after, p, t.path));
      } catch {
        afterText.set(t.path, null);
        afterOutcome.set(t.path, "missing");
      }
    }

    const patterns = [];
    reps.forEach((rep, index) => {
      const pattern = rep && rep.pattern;
      if (!pattern) return;
      const files2 = [];
      let hitsTotal = 0;
      let hitsMax = 0;
      let currentTotal = 0;
      let currentMax = 0;
      let chainTotal = 0;
      let chainMax = 0;
      let afterTotal = 0;
      let afterGuarded = 0;
      for (const t of liveTargets) {
        const clean = t.cleanText == null ? 0 : countHits(t.cleanText, pattern);
        const cur = t.currentText == null ? 0 : countHits(t.currentText, pattern);
        const chain = chainText.has(t.path) ? countHits(chainText.get(t.path), pattern) : null;
        const afterSrc = afterText.get(t.path);
        const after = afterSrc == null ? null : countHits(afterSrc, pattern);
        hitsTotal += clean;
        hitsMax = Math.max(hitsMax, clean);
        currentTotal += cur;
        currentMax = Math.max(currentMax, cur);
        if (after != null) {
          afterTotal += after;
          // 打完就带 marker → skipIfMarked 挡住下一次 Apply，pattern 还在也不会长。
          if (after > 0 && afterOutcome.get(t.path) === "applied") afterGuarded += after;
        }
        if (chain != null) {
          chainTotal += chain;
          chainMax = Math.max(chainMax, chain);
        }
        files2.push({
          key: t.key,
          path: t.path,
          cleanSource: t.cleanSource,
          cleanPath: t.cleanPath,
          hits: clean,
          hitsCurrent: cur,
          hitsAfterApply: after,
          hitsAfterUpstream: chain,
          currentOutcome: t.currentOutcome,
        });
      }

      // 单个 pattern 的判定（任务口径：0 次=漂移风险，1 次=正常，2 次以上=自匹配风险）。
      let verdict = "ok";
      let note = "";
      if (!liveTargets.length) {
        verdict = "no-target";
        note = "本机没有这条补丁的目标文件";
      } else if (hitsTotal === 0) {
        verdict = "miss";
        note = missingKeys.length
          ? `干净原文 0 命中；本机缺少目标文件（${missingKeys.join(", ")}），pattern 可能属于缺失的那个`
          : "干净原文 0 命中：这条 pattern 在本机宿主里不存在";
      } else if (hitsMax >= 2) {
        verdict = "self-match";
        note = `同一份文件里 pattern 命中 ${hitsMax} 次：一次 Apply 会写多份（叠层）`;
      } else if (typeof rep.expect === "number" && hitsTotal !== rep.expect) {
        verdict = "expect-mismatch";
        note = `声明 expect=${rep.expect}，实测 ${hitsTotal} 次`;
      }
      // expect 逐文件核对：core.js 的命中数契约是在「被写的那份文件」上比对的。
      if (verdict === "ok" && typeof rep.expect === "number") {
        for (const f of files2) {
          if (f.hits > 0 && f.hits !== rep.expect) {
            verdict = "expect-mismatch";
            note = `声明 expect=${rep.expect}，${f.path} 实测 ${f.hits} 次`;
            break;
          }
        }
      }
      // 链式补丁：干净原文 0 命中是正常的，关键看「跑完上游补丁之后」命中几次。
      let chainBroken = false;
      if (chainedAfter.length && liveTargets.length) {
        if (chainTotal === 0) {
          chainBroken = true;
          if (verdict === "ok") verdict = "chained";
          note = `链式补丁：上游 #${chainedAfter.join(",#")} 跑完之后 pattern 仍然 0 命中 → 链断了`;
        } else {
          if (verdict === "miss") verdict = "chained";
          note = `链式补丁：pattern 由上游 #${chainedAfter.join(",#")} 产出（干净原文 0 命中正常，上游跑完后 ${chainTotal} 次）`;
        }
      }
      patterns.push({
        index,
        kind: pattern instanceof RegExp ? "regexp" : "string",
        expect: typeof rep.expect === "number" ? rep.expect : null,
        preview: previewOf(pattern),
        hits: hitsTotal,
        hitsMax,
        hitsCurrent: currentTotal,
        hitsCurrentMax: currentMax,
        hitsAfterUpstream: chainTotal || null,
        verdict,
        note,
        chainBroken,
        // 真叠层：替换后的文本仍然命中自己的 pattern（自指），且打完没有 marker 兜底
        // → 下一次 Apply 挡不住，会再长一层。有 marker 的（skipIfMarked）只是「盯住」。
        stacks: afterTotal - afterGuarded > 0 ? afterTotal - afterGuarded : 0,
        stackRisk: afterTotal - afterGuarded > 0,
        markerGuarded: afterGuarded > 0,
        // 仅供参考：这条补丁在本机当前文件上还没动手（marker 不在、pattern 还在）。
        notAppliedYet: currentTotal > 0 && files2.some((f) => f.currentOutcome === "pending"),
        files: files2,
      });
    });

    // 补丁级结论。
    //
    // 一条补丁的多个 replacement 是「同一件事在不同上游布局下的几套写法」，
    // 命中任意一条就说明这条补丁在本机宿主上可用。所以「漂移」不能按「某条 pattern 没命中」算，
    // 必须用 core.js 自己的口径：把干净原文交给 filePatchOutcome —— 它算出来的就是
    // 「全新装好的宿主上，这条补丁会是什么状态」：
    //   pending  → 还有 pattern 留着，这条补丁在新装宿主上会动手（正常）
    //   applied  → marker 已经在原文里，宿主本身就满足这条（补丁是空操作）
    //   drifted  → 既没 marker 也没 pattern：上游把原文改了，Apply 写不进去（真漂移）
    //   skipped  → pattern 是本插件自己的痕迹，本来就没加过
    const outcomes = liveTargets.map((t) => (t.cleanText == null ? "missing" : filePatchOutcome(t.cleanText, p, t.path)));
    let cleanOutcome = "missing";
    for (const o of ["pending", "applied", "drifted", "skipped"]) {
      if (outcomes.includes(o)) {
        cleanOutcome = o;
        break;
      }
    }
    const anyHit = patterns.some((x) => x.hits > 0);
    const anyChainHit = patterns.some((x) => x.hitsAfterUpstream > 0);
    // 链式补丁的 pattern 是上游补丁写出来的，干净原文里当然没有 → cleanOutcome 会误判成 drifted。
    // 链式补丁改用「上游跑完之后」的判定：上游跑完能命中 = 链是通的（pending）。
    if (chainedAfter.length && liveTargets.length) {
      cleanOutcome = anyChainHit ? "pending" : "drifted";
    }
    const selfMatched = patterns.some((x) => x.verdict === "self-match");
    const expectBad = patterns.some((x) => x.verdict === "expect-mismatch");
    // 真叠层：替换后的文本仍然命中自己的 pattern（自指），且没有 marker 兜底 → 下次 Apply 挡不住。
    const stackRisk = patterns.some((x) => x.stackRisk);
    // 自指但有 marker：skipIfMarked 挡得住，不会长，但 marker 一旦被上游改掉就会退化 → 盯住。
    const markerGuarded = patterns.some((x) => x.markerGuarded);
    // 链断：上游跑完之后，这条补丁的所有 pattern 一条都不中。
    const chainDead = chainedAfter.length > 0 && !anyHit && !anyChainHit;
    let verdict = "ok";
    if (!liveTargets.length) verdict = "no-target";
    else if (cleanOutcome === "drifted" && !selfMarked) verdict = "drift";
    else if (chainDead) verdict = "chain-broken";
    else if (stackRisk) verdict = "stack-risk";
    else if (selfMatched) verdict = "self-match";
    else if (expectBad) verdict = "expect-mismatch";
    else if (cleanOutcome === "applied") verdict = "satisfied";

    const tags = [];
    if (verdict !== "ok" && verdict !== "satisfied") tags.push(RISK_TAG[verdict]);
    if (verdict === "satisfied") tags.push(RISK_TAG.satisfied);
    if (chainedAfter.length && verdict === "ok") tags.push(RISK_TAG.chained);
    if (selfMarked && verdict === "ok") tags.push(RISK_TAG["self-marked"]);
    if (markerGuarded && verdict !== "stack-risk") tags.push(RISK_TAG["marker-guarded"]);
    if (p.optional) tags.push(RISK_TAG.optional);
    // 部分 pattern 未命中：多半是上游另一种布局（本机没有），不是风险，只是记账。
    const missedPatterns = patterns.filter((x) => x.hits === 0).length;
    if (missedPatterns > 0 && anyHit) tags.push(`${missedPatterns}条未命中`);

    results.push({
      id: p.id,
      name: p.name,
      layer: p.layer || "",
      layer_en: p.layer_en || "",
      desc: p.desc || "",
      optional: p.optional === true,
      strictFiles: p.strictFiles === true,
      selfMarked,
      chainedAfter,
      status: status[p.id] || "",
      keys,
      missingKeys,
      verdict,
      tags,
      // 干净原文（= 全新安装的宿主）上的判定：pending=会动手 applied=原文自带 marker drifted=写不进去
      cleanOutcome,
      cleanOutcomes: outcomes,
      // 汇总：这条补丁在干净原文里一共命中多少次 / 多少个 pattern 一条都不中。
      hitsTotal: patterns.reduce((n, x) => n + x.hits, 0),
      hitsMax: patterns.reduce((n, x) => Math.max(n, x.hitsMax), 0),
      patternsHit: patterns.filter((x) => x.hits > 0).length,
      patternsMissed: patterns.filter((x) => x.hits === 0).length,
      patterns,
    });
  }

  // ---------- 终端表格 ----------
  const risky = results.filter((r) => RISK_VERDICTS.has(r.verdict));
  const shown = riskOnly ? risky : results;

  const idCol = 5;
  const nameCol = 34;
  const layerCol = 10;
  const fileCol = 30;
  const hitCol = 16;
  const freshCol = 10;
  const head = [
    pad("ID", idCol),
    pad("名称", nameCol),
    pad("层", layerCol),
    pad("目标文件", fileCol),
    pad("命中分布", hitCol),
    pad("新装口径", freshCol),
    "风险",
  ].join(" ");

  console.log("dsh-purge 补丁命中测量 / patch hit measurement");
  console.log(`  宿主 / host     ${aiBase}`);
  console.log(`  宿主版本        ${hostVersion.version || "?"}  (surface ${surface})`);
  console.log(`  DSH_HOME        ${dshHome}`);
  console.log(`  干净原文口径    优先 <file>.dshpurge.bak（打补丁前的官方原件），没有就用当前文件`);
  console.log(`  命中分布        每个 pattern 在干净原文里命中几次（链式补丁 → 上游跑完后的命中）`);
  console.log(`  新装口径        干净原文交给 core.js filePatchOutcome 的判定：`);
  console.log(`                  pending=会动手 applied=原文自带 marker drifted=写不进去 skipped=本插件自己的痕迹`);
  console.log(`  测量补丁        ${results.length} 条（${onlyIds ? `--id ${[...onlyIds].join(",")}` : "全部"}）`);
  const stCount = new Map();
  for (const r of results) stCount.set(r.status || "?", (stCount.get(r.status || "?") || 0) + 1);
  console.log(`  --status 对照   ${[...stCount.entries()].map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  console.log("");

  if (!shown.length) {
    console.log(riskOnly ? "没有测到任何风险补丁。" : "没有补丁可测。");
  } else {
    console.log(head);
    console.log("-".repeat([idCol, nameCol, layerCol, fileCol, hitCol, freshCol, 6].reduce((a, b) => a + b + 1, 0)));
    for (const r of shown) {
      const live = r.patterns.length ? r.patterns.flatMap((x) => x.files) : [];
      const existsCount = new Set(live.map((f) => f.path)).size;
      const keyCell = r.keys.length ? (r.keys.length <= 2 ? r.keys.join(",") : `${r.keys.slice(0, 2).join(",")}…+${r.keys.length - 2}`) : "—";
      const fileCell = r.keys.length
        ? `${keyCell}${r.missingKeys.length ? ` (缺${r.missingKeys.length})` : ""}${existsCount ? ` [${existsCount}份]` : ""}`
        : "—";
      // 命中分布：干净原文里每个 pattern 命中几次。链式补丁额外标出上游跑完后的命中。
      const counts = r.patterns.map((x) => x.hits);
      const chainCounts = r.chainedAfter.length ? r.patterns.map((x) => x.hitsAfterUpstream || 0) : null;
      const hitCell = chainCounts
        ? `${hitsSummary(counts)} →${hitsSummary(chainCounts)}`
        : hitsSummary(counts);
      const riskCell = r.tags.length ? r.tags.join("/") : "正常";
      console.log(
        [
          pad(`#${r.id}`, idCol),
          pad(r.name, nameCol),
          pad(r.layer, layerCol),
          pad(fileCell, fileCol),
          pad(hitCell, hitCol),
          pad(r.cleanOutcome === "missing" ? "—" : r.cleanOutcome, freshCol),
          riskCell,
        ].join(" "),
      );
    }
  }

  // ---------- 风险清单 ----------
  console.log("");
  if (!risky.length) {
    console.log("风险清单：空。全部补丁的 pattern 在干净原文里都是 1 次命中。");
  } else {
    console.log(`风险清单 / risks（${risky.length} 条）`);
    for (const r of risky) {
      console.log(`  #${r.id} ${r.name}  [${r.layer}]  --status=${r.status || "?"}  风险=${r.tags.join("/")}`);
      for (const x of r.patterns) {
        if (x.verdict === "ok" && !x.stackRisk) continue;
        if (x.verdict === "miss" && r.verdict !== "drift" && !x.chainBroken && !x.stackRisk) continue;
        console.log(`      pattern#${x.index} 命中 ${x.hits} 次  ${x.preview}`);
        console.log(`        ${x.note || ""}${x.stackRisk ? "【叠层】替换后的文本仍然能被自己的 pattern 命中（自指），且没有 marker 兜底 → 再 Apply 一次会再长一层" : ""}${x.markerGuarded ? "；自指但有 marker 兜底（skipIfMarked 挡得住，盯住 marker 是否会被上游改掉）" : ""}${x.notAppliedYet ? "；本机当前文件上这条还没动手（marker 不在）" : ""}`);
        for (const f of x.files) {
          const chain = f.hitsAfterUpstream == null ? "" : `，上游跑完后 ${f.hitsAfterUpstream} 次`;
          console.log(`        · ${f.key} → ${f.path}  干净原文命中 ${f.hits} 次（当前文件 ${f.hitsCurrent} 次${chain}，来源 ${f.cleanSource}）`);
        }
      }
    }
  }

  // ---------- 口径不一致 ----------
  // 任务要求的口径核对：--status 报 applied，但这条补丁的所有 pattern 在干净原文里 0 命中。
  // 链式补丁要排除 —— 它们的 pattern 本来就是上游补丁写出来的，干净原文里没有是正常的
  // （判据是「上游跑完之后命中几次」，见 hitsAfterUpstream）。
  const allMiss = (r) => r.patterns.length > 0 && r.patterns.every((x) => x.hits === 0);
  const chainProvides = (r) => r.chainedAfter.length > 0 && r.patterns.some((x) => (x.hitsAfterUpstream || 0) > 0);
  const mismatch = results.filter(
    (r) => (r.status === "applied" || r.status === "already") && allMiss(r) && !chainProvides(r),
  );
  console.log("");
  if (!mismatch.length) {
    console.log("口径核对：没有「--status 报 applied，但干净原文里 pattern 一条都不中」的补丁。");
  } else {
    console.log(`口径不一致 / status-vs-measurement（${mismatch.length} 条）`);
    console.log("  判据：--status 报 applied（或 already），但这条补丁的所有 pattern 在干净原文（全新安装的宿主）里 0 命中。");
    console.log("  两种成因，含义完全不同：");
    console.log("    A. marker 就在宿主原文里 → 这条补丁是空操作：状态是绿的，但它从来没做过任何事，");
    console.log("       全新安装的宿主上 Apply 也不会改一个字节。marker 选得太泛（撞上了官方原文）就会这样。");
    console.log("    B. marker 只在当前文件里（上一轮 apply 留下的） → 这次是上一轮补丁版本写进去的，");
    console.log("       全新安装的宿主上再 Apply 一次会静默不生效（pattern 已经对不上上游），状态页却还是绿的。");
    for (const r of mismatch) {
      const why = r.cleanOutcome === "applied" ? "A（marker 是宿主原文自带的 → 空操作）" : "B（marker 只在当前文件里 → 上一轮 apply 的遗留）";
      console.log(`  #${r.id} ${r.name}  [${r.layer}]  --status=${r.status}  测量=全部 pattern 0 命中  成因=${why}`);
      console.log(`      marker 在干净原文里：${r.cleanOutcome === "applied" ? "在" : "不在"}；pattern 命中数：`);
      for (const x of r.patterns) {
        console.log(`      pattern#${x.index} 命中 ${x.hits} 次  ${x.preview}`);
      }
      for (const f of r.patterns[0] ? r.patterns[0].files : []) {
        console.log(`        · ${f.path}  干净原文命中 ${f.hits} 次（当前文件 ${f.hitsCurrent} 次，来源 ${f.cleanSource}）`);
      }
    }
  }

  // ---------- JSON ----------
  const report = {
    generatedAt: new Date().toISOString(),
    tool: "scripts/measure-patches.mjs",
    readOnly: true,
    host: {
      aiBase,
      dshHome,
      surface,
      version: hostVersion.version || "",
      packageName: hostVersion.name || "",
    },
    options: {
      ids: onlyIds ? [...onlyIds] : null,
      riskOnly,
      json: jsonOut,
    },
    legend: {
      drift: "全新安装口径判 drifted：干净原文里既没 marker 也没 pattern，Apply 写不进去",
      "self-match": "同一份文件里命中 ≥2 次：一次 Apply 写多份（叠层）",
      "expect-mismatch": "命中数与补丁自己声明的 expect 不符",
      "no-target": "本机没有这条补丁的目标文件",
      "chain-broken": "链式补丁：上游补丁跑完之后 pattern 仍然 0 命中",
      "stack-risk": "替换后的文本仍能被自己的 pattern 命中（自指）：再 Apply 一次会叠一层",
      chained: "链式补丁：pattern 由上游补丁产出，干净原文 0 次正常",
      "self-marked": "pattern 是本插件自己的痕迹，0 次正常",
      satisfied: "宿主原文自带 marker，这条补丁在本机上是空操作",
      miss: "单个 pattern 在干净原文里 0 命中（多半是上游另一种布局）",
      stacks: "打完补丁后 pattern 仍在文件里：再 Apply 一次会叠层",
      cleanOutcome: "干净原文交给 core.js filePatchOutcome 的判定：pending=会动手 applied=原文自带 marker drifted=写不进去 skipped=本插件自己的痕迹",
    },
    summary: {
      patches: results.length,
      patterns: results.reduce((n, r) => n + r.patterns.length, 0),
      risky: risky.length,
      drift: results.filter((r) => r.verdict === "drift").map((r) => r.id),
      selfMatch: results.filter((r) => r.verdict === "self-match").map((r) => r.id),
      expectMismatch: results.filter((r) => r.verdict === "expect-mismatch").map((r) => r.id),
      noTarget: results.filter((r) => r.verdict === "no-target").map((r) => r.id),
      chainBroken: results.filter((r) => r.verdict === "chain-broken").map((r) => r.id),
      stackRisk: results.filter((r) => r.verdict === "stack-risk").map((r) => r.id),
      satisfied: results.filter((r) => r.verdict === "satisfied").map((r) => r.id),
      noop: results.filter((r) => r.cleanOutcome === "applied").map((r) => r.id),
      stacks: results.filter((r) => r.patterns.some((x) => x.stacks > 0)).map((r) => r.id),
      statusMismatch: mismatch.map((r) => r.id),
    },
    patches: results,
  };

  try {
    mkdirSync(path.dirname(jsonOut), { recursive: true });
    writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log("");
    console.log(`JSON 报告：${jsonOut}`);
  } catch (e) {
    console.error(`[ERROR] 写 JSON 报告失败：${e && e.message ? e.message : e}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[dsh-purge] error:", e);
  process.exit(1);
});
