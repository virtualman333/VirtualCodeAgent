/**
 * VSIX 打包链：README 写的那两条路，必须真有一条走得通。
 *
 * 本轮踩到的：`## C. VS Code 扩展` 一节写着
 *
 *     build-vsix.bat        # 完整构建并打包 VSIX（Windows）
 *   或在 `vscode/` 目录执行 `npx vsce package`。
 *
 * 第一行是**唯一**的实现（连 `publish.mjs` 都要 `cmd /c` 去调它），所以整条链
 * 在 Windows 之外走不通；第二行在干净 clone 上**必然失败**，实测：
 *
 *     ERROR  Extension entrypoint(s) missing. Make sure these files exist and aren't
 *            ignored by '.vscodeignore': extension/dist/extension.js
 *
 * 因为扩展入口 `vscode/dist/extension.js` 是构建产物、不随源码入库。两个写法都
 * 不可用时，用户手上没有任何一条能照着走的命令 —— 而这种「文档承诺的路走不通」
 * 不会让任何一条现有检查变红（类型、测试、产物都对得上）。
 *
 * 现在这条路是 `npm run vsix`（`scripts/build-vsix.mjs`），本文件钉住四件事：
 *   1. `.vscodeignore` 的匹配语义 —— 入口不能被排掉，且匹配器不能「见谁都排」；
 *   2. **入口路径只有一个来源**：扩展清单的 `main` 与 `build-extension.mjs` 的写盘路径；
 *   3. 「空转的 watch 脚本」总闸：`tsc --watch` 配 `noEmit: true` 会一行都不产出（本仓库真有过）；
 *   4. `scripts/` 下的脚本与 npm script 的**两向**对账。
 *
 * 其中第 1、3、4 条都带**自证**（先喂一份合成输入，确认判据认得出坏形态），
 * 第 1 条还带反控 —— 一个「见谁都排」的匹配器必须过不了。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VSCODE_DIR = path.join(ROOT, "vscode");

interface Problem {
  code: string;
  message: string;
}
interface Preflight {
  ok: boolean;
  problems: Problem[];
  name: string | null;
  version: string | null;
  main: string | null;
  entry: string | null;
  relEntry: string | null;
}
interface VsixModule {
  matchIgnore(pattern: string, relPath: string): boolean;
  readVscodeignore(vscodeDir: string): string[];
  preflightVscode(rootDir?: string): Preflight;
}

// specifier 用表达式拼出来：TS 不去解析它，也就不会为这个纯 JS 脚本要一份 .d.ts
const VSIX_SCRIPT = path.join(ROOT, "scripts", "build-vsix.mjs");
const vsix = (await import(pathToFileURL(VSIX_SCRIPT).href)) as unknown as VsixModule;

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
}

/** 每个 npm script 的命令行（根 + vscode 两份 package.json 里的都算） */
function npmCommandLines(): string[] {
  const out: string[] = [];
  for (const p of [path.join(ROOT, "package.json"), path.join(VSCODE_DIR, "package.json")]) {
    if (!fs.existsSync(p)) continue;
    const scripts = readJson<{ scripts?: Record<string, string> }>(p).scripts ?? {};
    out.push(...Object.values(scripts));
  }
  return out;
}

// ---------------------------------------------------------------- 1
test(".vscodeignore：该排的排得掉，不该排的一个都不许排", () => {
  const patterns = vsix.readVscodeignore(VSCODE_DIR);
  // 解析面不许为空 —— 空的 pattern 列表会让「入口没被排除」变成恒真
  assert.ok(patterns.length >= 4, `在 vscode/.vscodeignore 里只解析出 ${patterns.length} 条 pattern`);

  const isIgnored = (rel: string): boolean => patterns.some((p) => vsix.matchIgnore(p, rel));

  // 正控：这些确实该（也一直）被打包排除
  for (const f of [
    "src/extension.ts",
    "src/panel.ts",
    "tsconfig.json",
    "tsconfig.tsbuildinfo",
    "dist/extension.js.map",
    ".gitignore",
  ]) {
    assert.ok(isIgnored(f), `${f} 按 .vscodeignore 应当被排除，可匹配器说它是进包的`);
  }

  // 反控：少了这一半，一个「见谁都排」的实现照样能过上面那圈
  for (const f of [
    "package.json",
    "README.md",
    "LICENSE",
    "media/logo.png",
    "dist/extension.js",
    "dist/web/index.html",
  ]) {
    assert.ok(!isIgnored(f), `${f} 必须进包，可它被 .vscodeignore 排除了`);
  }
});

// ---------------------------------------------------------------- 2
test("扩展入口路径只有一个来源：清单里的 main 必须就是构建脚本写的那份", () => {
  const builder = fs.readFileSync(path.join(ROOT, "scripts", "build-extension.mjs"), "utf-8");
  const distM = /const\s+extDist\s*=\s*path\.join\(root,\s*"([^"]+)",\s*"([^"]+)"\)/.exec(builder);
  const outM = /const\s+outfile\s*=\s*path\.join\(extDist,\s*"([^"]+)"\)/.exec(builder);
  // 锚点没了就抛 —— 别让这条锁在解析不到东西时静默变成恒真
  assert.ok(distM, "解析不出 build-extension.mjs 里的 extDist 定义，锚点变了就要回来改这条锁");
  assert.ok(outM, "解析不出 build-extension.mjs 里的 outfile 定义，锚点变了就要回来改这条锁");

  const built = path.resolve(ROOT, distM![1], distM![2], outM![1]);
  const manifest = readJson<{ main?: string }>(path.join(VSCODE_DIR, "package.json"));
  assert.ok(manifest.main, "vscode/package.json 里必须有 main");
  const declared = path.resolve(VSCODE_DIR, manifest.main!);

  assert.equal(
    declared,
    built,
    `清单声明的入口与构建脚本的产物不是同一个文件：\n  清单: ${declared}\n  产物: ${built}\n` +
      "两者不一致时，vsce 会在打包时报 Extension entrypoint(s) missing，或者打进一个没人加载的入口"
  );
});

// ---------------------------------------------------------------- 3
/**
 * 「空转的 watch 脚本」：`tsc --watch` 去跑一个 `noEmit: true` 的配置，
 * 会正常启动、正常打印、**一个字节都不产出** —— 用户等到的是一动不动的 dist。
 * （本仓库 `vscode/package.json` 原先是 `tsc -watch -p ./`，而 `vscode/tsconfig.json`
 * 是 `noEmit: true`；真正的构建走的是 esbuild，那个 watch 从来没产出过东西。）
 */
function deadWatchScripts(pkgDir: string): string[] {
  const pkgPath = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pkgPath)) return [];
  const scripts = readJson<{ scripts?: Record<string, string> }>(pkgPath).scripts ?? {};
  const dead: string[] = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    if (!/\btsc\b/.test(cmd)) continue;
    if (!/(?:^|\s)-{1,2}w(?:atch)?\b/.test(cmd)) continue;
    const p = /(?:^|\s)-p\s+(\S+)/.exec(cmd);
    const cfg = path.resolve(pkgDir, p ? p[1] : "tsconfig.json");
    const cfgPath = fs.existsSync(path.join(cfg, "tsconfig.json")) ? path.join(cfg, "tsconfig.json") : cfg;
    if (!fs.existsSync(cfgPath)) continue; // 解析不到配置就不硬判，免得误红
    const ts = readJson<{ compilerOptions?: { noEmit?: boolean } }>(cfgPath);
    if (ts.compilerOptions?.noEmit === true) dead.push(name);
  }
  return dead;
}

test("没有「空转的 watch 脚本」：tsc --watch 配 noEmit 一行都不产出", () => {
  // 自证：喂一份合成出来的坏形态，判据必须当场认出来（否则这条锁永远绿）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vca-deadwatch-"));
  fs.writeFileSync(
    path.join(tmp, "package.json"),
    JSON.stringify({ scripts: { watch: "tsc -watch -p ./" } })
  );
  fs.writeFileSync(path.join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true } }));
  assert.deepEqual(
    deadWatchScripts(tmp),
    ["watch"],
    "自证失败：判据连合成出来的空转脚本都认不出，那它对真仓库也就没有意义"
  );
  // 反向自证：noEmit 关掉之后不该再报
  fs.writeFileSync(path.join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: false } }));
  assert.deepEqual(deadWatchScripts(tmp), [], "自证失败：noEmit 关掉了还报空转，说明判据在乱杀");

  // 真仓库：根 / vscode 两处（web 没有 tsconfig，也没有 tsc 脚本）
  for (const dir of [ROOT, VSCODE_DIR]) {
    const rel = path.relative(ROOT, dir) || ".";
    assert.deepEqual(
      deadWatchScripts(dir),
      [],
      `${rel}/package.json 里这些 watch 脚本是空转的（tsc --watch + noEmit）`
    );
  }
});

// ---------------------------------------------------------------- 4
/**
 * `scripts/` 与 npm script 的**两向**对账。
 * 单向（「写了就必须有」）挡不住「有文件但没有任何入口指向它」，
 * 而 `publish.mjs` 正好长期处于这个状态 —— 只能靠 README 里的散文发现。
 */
const UNREFERENCED_OK = new Map<string, string>([
  // 例：["foo.mjs", "只在 CI 里跑，见 .github/workflows/x.yml"],
]);

test("scripts/ 下的脚本与 npm script 两向对账", () => {
  const scriptsDir = path.join(ROOT, "scripts");
  const files = fs.readdirSync(scriptsDir).filter((f) => f.endsWith(".mjs"));
  assert.ok(files.length >= 3, `scripts/ 下只找到 ${files.length} 个 .mjs，扫描面多半不对`);

  const commands = npmCommandLines();
  const referenced = new Set<string>();
  for (const m of commands.join("\n").matchAll(/scripts[\\/]([\w.-]+\.mjs)/g)) referenced.add(m[1]);
  assert.ok(
    referenced.size >= 3,
    `只在 npm script 里解析出 ${referenced.size} 个 scripts/*.mjs 引用，正则多半没匹配上`
  );

  // 方向一：npm script 里写了就必须真的有
  for (const f of referenced) {
    assert.ok(files.includes(f), `npm script 里引用了 scripts/${f}，可这个文件不存在`);
  }

  // 方向二：有文件就必须有人调（或在登记表里写明为什么没有）
  const orphans = files.filter((f) => !referenced.has(f) && !UNREFERENCED_OK.has(f));
  assert.deepEqual(
    orphans,
    [],
    `这些脚本没有任何 npm script 指向它们（要么接进 package.json，要么进 UNREFERENCED_OK 写明理由）：${orphans.join(", ")}`
  );

  // 登记表自己也要两向：登记成「没人调」的就不许真的有人调，否则登记表在腐烂
  for (const [f, reason] of UNREFERENCED_OK) {
    assert.ok(files.includes(f), `UNREFERENCED_OK 里登记了 scripts/${f}，可这个文件不存在`);
    assert.ok(!referenced.has(f), `scripts/${f} 已被 npm script 引用，却还留在 UNREFERENCED_OK 里（${reason}）`);
  }
});

// ---------------------------------------------------------------- 5
/**
 * 预检本身要能回答「干净 clone 上到底缺什么」—— 这是本轮那个缺陷的正身。
 * 三条用例逐条真跑，不依赖本仓库当前是否构建过（所以 `vscode/dist` 在不在都不影响）。
 */
test("预检：干净 clone 必须报「入口不存在」，补上入口才转绿", () => {
  const manifest = readJson<{ version: string }>(path.join(VSCODE_DIR, "package.json"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vca-clean-"));
  const vdir = path.join(tmp, "vscode");
  fs.mkdirSync(path.join(vdir, "src"), { recursive: true });
  // 只搬干净 clone 里真正会被 checkout 出来的那两个文件
  fs.copyFileSync(path.join(VSCODE_DIR, "package.json"), path.join(vdir, "package.json"));
  fs.copyFileSync(path.join(VSCODE_DIR, ".vscodeignore"), path.join(vdir, ".vscodeignore"));

  const missing = vsix.preflightVscode(tmp);
  assert.equal(missing.ok, false, "干净 clone 上预检必须失败");
  assert.ok(
    missing.problems.some((p) => p.code === "vscode-entry-missing"),
    `必须报出 vscode-entry-missing，实际是：${JSON.stringify(missing.problems.map((p) => p.code))}`
  );
  // 报错要说清缺的是哪个文件、怎么补 —— 只说「预检失败」等于没说
  const entryMsg = missing.problems.find((p) => p.code === "vscode-entry-missing")!.message;
  assert.ok(entryMsg.includes("dist/extension.js"), `报错里应当点名那个文件：${entryMsg}`);
  assert.ok(entryMsg.includes("npm run vsix"), `报错里应当给出可照做的命令：${entryMsg}`);

  // 补上入口（模拟构建完成）→ 必须转绿，否则「预检」就成了永远拦人的关卡
  fs.mkdirSync(path.join(vdir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(vdir, "dist", "extension.js"), "// stub\n");
  const ok = vsix.preflightVscode(tmp);
  assert.deepEqual(ok.problems, [], "入口补齐后预检不该还有问题");
  assert.equal(ok.ok, true);
  assert.equal(ok.version, manifest.version, "预检要把扩展版本带出来（日志里要显示打的是哪一版）");

  // 第三条：入口在、但被 .vscodeignore 排除 —— 这条锁必须真的会红，否则它是摆设
  fs.writeFileSync(path.join(vdir, ".vscodeignore"), "dist/**\n");
  const hidden = vsix.preflightVscode(tmp);
  assert.ok(
    hidden.problems.some((p) => p.code === "vscode-entry-ignored"),
    "入口被 .vscodeignore 排除时预检必须报出来（否则打出来的包是空的）"
  );
});

// ---------------------------------------------------------------- 6
test("README 承诺的 VSIX 入口存在，且不再推荐那条走不通的路", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf-8");
  const forms = /### C\. VS Code 扩展[\s\S]*?(?=\n### )/.exec(readme);
  assert.ok(forms, "README 里应当有「### C. VS Code 扩展」一节");
  const body = forms![0];

  // 只看**命令块**：散文里提到一句「要么就用 `npm run vsix` 本身」不算给出了入口 ——
  // 这一条被负向验证当场抓出来（把命令块换回 build-vsix.bat 之后，原先「全文 includes」
  // 的写法照样绿）。要钉的是「用户照着敲的那一行」，不是「文档里出现过这几个字」。
  const block = /```(?:bash|sh)?\n([\s\S]*?)```/.exec(body);
  assert.ok(block, "§C 应当有一个命令行代码块");
  const cmdLines = block![1].trim();
  assert.ok(cmdLines.length > 0, "§C 的命令块是空的，下面这条断言就变成恒真");
  assert.ok(
    /^npm run vsix\b/m.test(block![1]),
    `§C 的命令块里必须给出 \`npm run vsix\`（散文里提到不算），实际是：${cmdLines}`
  );

  const pkg = readJson<{ scripts?: Record<string, string> }>(path.join(ROOT, "package.json"));
  assert.ok(pkg.scripts?.vsix, "package.json 里必须有 vsix 脚本（README 写的就是它）");
  assert.ok(
    pkg.scripts!.vsix.includes("build-vsix.mjs"),
    `vsix 脚本应当指向 scripts/build-vsix.mjs，实际是：${pkg.scripts!.vsix}`
  );

  // 那条被证伪的替代写法，必须带上它的前置条件一起出现（不能只留一句裸命令）
  const naked = /在 `vscode\/` 目录执行 `npx vsce package`/.test(body);
  assert.ok(
    !naked || body.includes("extension.js"),
    "§C 里的 `npx vsce package` 必须写明前置条件（先构建出 vscode/dist/extension.js），" +
      "否则用户照着做只会拿到 Extension entrypoint(s) missing"
  );
});
