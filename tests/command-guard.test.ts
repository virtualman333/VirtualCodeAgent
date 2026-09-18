/**
 * `bash` 工具的安全护栏 —— 「危险命令会被拦截」这句话到底成不成立。
 *
 * 被测对象是 `src/tools/command_guard.ts`（纯函数、零 LangChain 依赖）。
 *
 * 为什么要有这个文件：这段判断原来写死在 `src/tools/bash.ts` 里 —— 一个 8 条的字符串
 * 数组加一句 `command.includes(模式)`，而 `bash.ts` 顶层 `import { tool } from
 * "@langchain/core/tools"`，任何测试都 import 不进它。于是工具描述里那句
 * 「危险命令会被拦截」底下**一条断言都没有**，全靠读代码看着像。
 *
 * 实测出来的漏洞（本轮从 `git show HEAD:src/tools/bash.ts` 现读那 8 条模式跑出来的，
 * 38 条危险命令里旧实现放行 24 条）：参数顺序、多一个空格、包一层 `sh -c`、
 * `format.com`、`mkfs -t`、`dd of=` 写在前面、`sudo` 前缀……每一条下面都有对应回归用例。
 *
 * 这个文件里有两类断言，缺一不可：
 *   - **正向**：危险写法必须被拦，而且要说得出是**哪一族**拦的；
 *   - **反向**：`rm -rf node_modules` 这类正常清理一条都不许误拦 ——
 *     一个乱杀命令的护栏会被用户（和模型）直接绕开，比没有护栏更坏。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  FAMILY_NAMES,
  checkCommand,
  hasRecursiveForce,
  isRootishPath,
  normalize,
  splitSegments,
  stripElevation,
  tokenize,
  unwrap,
} from "../src/tools/command_guard.js";
import { REPO_ROOT, stripComments } from "./source-utils.js";

const ROOT = REPO_ROOT;

/** [命令, 期望家族] —— 期望家族刻意写死，改家族名就必须回来改这里 */
const DANGEROUS: Array<[string, string]> = [
  // ---- 递归强删根 / 盘符 / 家目录 ----
  ["rm -rf /", "recursive-force-delete"],
  ["rm  -rf  /", "recursive-force-delete"],              // 旧版漏：多一个空格
  ["rm -fr /", "recursive-force-delete"],                // 旧版漏：参数顺序
  ["rm -rf --no-preserve-root /", "recursive-force-delete"], // 旧版漏
  ["rm -rf ~", "recursive-force-delete"],                // 旧版漏：家目录从来没在名单里
  ['rm -rf "$HOME"', "recursive-force-delete"],
  ["rm -rf ${HOME}", "recursive-force-delete"],
  ["rm -rf /*", "recursive-force-delete"],
  ["rm -rf ./", "recursive-force-delete"],
  ["rm -rf C:\\", "recursive-force-delete"],
  ["sudo rm -rf /", "recursive-force-delete"],           // 旧版能拦，不许修丢
  ["\\rm -rf /", "recursive-force-delete"],
  ["rm -r -f /etc", "recursive-force-delete"],
  ["del /f /s c:\\", "recursive-force-delete"],
  ["del /q /s C:\\", "recursive-force-delete"],          // 旧版漏：只有一种参数排列在名单里
  ["del /s /f C:\\", "recursive-force-delete"],
  ["rd /s /q C:\\", "recursive-force-delete"],           // 旧版漏：名单里压根没有 rd
  ["rmdir /s C:\\", "recursive-force-delete"],
  // ---- 抹盘 ----
  ["format c:", "format-disk"],
  ["FORMAT C:", "format-disk"],
  ["format.com c:", "format-disk"],                      // 旧版漏：`.com` 把 `format ` 挡掉了
  ["mkfs.ext4 /dev/sda", "mkfs"],
  ["mkfs -t ext4 /dev/sda", "mkfs"],                     // 旧版漏：名单里是 `mkfs.`（要求带点）
  ["mkfs /dev/sda", "mkfs"],
  // ---- 裸设备写入 ----
  ["dd if=/dev/zero of=/dev/sda", "raw-device-write"],
  ["dd of=/dev/sda if=/dev/zero", "raw-device-write"],   // 旧版漏：名单里是 `dd if=`，顺序敏感
  ["sudo dd of=/dev/sda if=/dev/zero", "raw-device-write"],
  // ---- 改根目录权限 ----
  ["chmod 777 /", "chmod-chown-root"],
  ["chmod -R 777 /", "chmod-chown-root"],                // 旧版漏
  ["sudo chmod 777 /", "chmod-chown-root"],
  ["chown -R root /", "chmod-chown-root"],
  // ---- fork 炸弹 ----
  [":(){ :|:& };:", "fork-bomb"],
  // ---- 包一层 shell 就不认了？（旧版全部放行）----
  ['sh -c "rm -rf ~"', "recursive-force-delete"],
  ["bash -c 'rm -rf /'", "recursive-force-delete"],
  ['bash -c \'bash -c "rm -rf /"\'', "recursive-force-delete"],
  ["cmd /c del /q /s C:\\", "recursive-force-delete"],
  ['powershell -Command "Remove-Item -Recurse -Force C:\\"', "powershell-destructive"],
  ['powershell -Command "Format-Volume -DriveLetter C"', "powershell-destructive"],
  // ---- 命令链：真正危险的那一段在里面 ----
  ["cd /tmp && rm -rf /", "recursive-force-delete"],
  ["echo hi; rm -rf /", "recursive-force-delete"],
  ["true | rm -rf /", "recursive-force-delete"],
];

/** 正常工作里会跑的命令 —— 一条都不许拦 */
const BENIGN: string[] = [
  "rm -rf node_modules",
  "rm -rf ./dist",
  "rm -fr build",
  "rm -f package-lock.json",
  "rm -i file.txt",
  "rm -rf coverage .cache",
  "rm -rf /tmp/vca-build-1234",
  "npm run test",
  "npm install",
  "npm ci",
  "git status",
  "git commit -m 'chore: 清理'",
  "pnpm build",
  "tsc --noEmit",
  "node --import tsx --test tests/*.test.ts",
  "cat formatter.config.js",
  "npx prettier --write src/",
  "npx eslint . --fix",
  "grep -rn 'rm -rf /' docs/",           // 旧版误拦：在文档里搜这句话
  "echo 'rm -rf /'",                     // 旧版误拦：把这句话原样打印出来
  "rg --files-with-matches 'rm -rf /'",
  "chmod 644 README.md",
  "chmod 755 scripts/run.sh",
  "chmod -R 755 ./scripts",
  "chmod 777 ./tmp-output",              // 权限拉满但目标是自己的目录，不拦
  "chown -R node:node ./dist",
  "del /q build.log",
  "rd /s /q .\\temp",
  "rmdir /s /q node_modules",
  "dd if=./disk.img of=./copy.img",      // 旧版误拦：本地镜像互拷
  "dd if=/dev/zero of=./scratch.bin bs=1M count=10",
  'powershell -Command "Remove-Item -Recurse -Force .\\dist"',
  "mkfs_helper.ts",                      // 旧版：名单里是 `mkfs.`，这个正好不匹配
  "node scripts/mkfs-helper.mjs",
  "format-json --in-place package.json",
  "npx format-package-json",
  "fd -e ts . src/",
  "docker compose up -d",
  "curl -I https://example.com",
  "git push origin main",
  "ls -la",
  "",
  "   ",
];

test("★ 危险命令必须被拦，且说得清是哪一族拦的", () => {
  const missed: string[] = [];
  const wrongFamily: string[] = [];
  for (const [cmd, family] of DANGEROUS) {
    const v = checkCommand(cmd);
    if (!v.blocked) missed.push(cmd);
    else if (v.family !== family) wrongFamily.push(`${cmd} → 期望 ${family}，实际 ${v.family}`);
  }
  assert.deepEqual(missed, [], `这些危险命令被放行了：\n  ${missed.join("\n  ")}`);
  assert.deepEqual(wrongFamily, [], `家族归错（文案会指错方向）：\n  ${wrongFamily.join("\n  ")}`);
  assert.ok(DANGEROUS.length >= 30, `危险矩阵只剩 ${DANGEROUS.length} 条，解析面大概被削了`);
});

test("★ 正常清理与只读命令一条都不许拦（护栏乱杀会被直接绕开）", () => {
  const wrong: string[] = [];
  for (const cmd of BENIGN) {
    const v = checkCommand(cmd);
    if (v.blocked) wrong.push(`${cmd} → 被 ${v.family} 拦了（${v.reason}）`);
  }
  assert.deepEqual(wrong, [], `这些良性命令被误拦：\n  ${wrong.join("\n  ")}`);
  assert.ok(BENIGN.length >= 20, `良性回归集只剩 ${BENIGN.length} 条，这一节等于空跑`);
});

test("★ 每个家族都要有正例 —— 「不会响的规则」比没有规则更坏", () => {
  const hitFamilies = new Set(DANGEROUS.map(([, f]) => f));
  const silent = FAMILY_NAMES.filter((f) => !hitFamilies.has(f));
  assert.deepEqual(silent, [], `这些家族没有任何正例，等于死代码：${silent.join(", ")}`);
  // 反方向：矩阵里写的家族名必须真实存在，不然上面那条会「因为名字写错而全绿」
  const ghost = [...hitFamilies].filter((f) => !FAMILY_NAMES.includes(f));
  assert.deepEqual(ghost, [], `矩阵里出现了不存在的家族名：${ghost.join(", ")}`);
  assert.ok(FAMILY_NAMES.length >= 5, `家族只剩 ${FAMILY_NAMES.length} 个，表被削了？`);
});

test("★ 拦截文案要带上理由（模型才知道为什么不行、该怎么换）", () => {
  for (const [cmd, family] of DANGEROUS) {
    const v = checkCommand(cmd);
    assert.equal(v.family, family);
    assert.ok(v.reason.length > 4, `${cmd} 的拦截理由太短：「${v.reason}」`);
  }
});

test("归一化：空白折叠 / 剥包装 / 剥引号，让换个写法落在同一个形状上", () => {
  // 每条都带 message —— 失败时输出里要能直接看出是哪一条塌了（不然只能靠行号猜）
  assert.equal(normalize("  rm   -rf    /  "), "rm -rf /", "空白必须折叠并去首尾");
  assert.equal(normalize("rm\t-rf\n/"), "rm -rf /", "制表符与换行也算空白");
  assert.equal(unwrap('sh -c "rm -rf /"'), "rm -rf /", "sh -c 要剥掉");
  assert.equal(unwrap("bash -c 'rm -rf /'"), "rm -rf /", "bash -c 要剥掉");
  assert.equal(unwrap("cmd /c del /q /s C:\\"), "del /q /s C:\\", "cmd /c 要剥掉");
  assert.equal(unwrap("sh -c 'sh -c \"rm -rf /\"'"), "rm -rf /", "多层包装要剥到底");
  assert.equal(unwrap("rm -rf /"), "rm -rf /", "本来就没有包装层的不要动它");
  // 引号里带空格的东西不许被切碎 —— 否则 `"C:\Program Files"` 会变成两个 token
  assert.deepEqual(tokenize('rm -rf "C:\\Program Files"'), ["rm", "-rf", "C:\\Program Files"], "引号内算一个 token");
  assert.deepEqual(splitSegments("a && b; c | d || e"), ["a", "b", "c", "d", "e"], "分隔符要切开");
  assert.deepEqual(stripElevation(["sudo", "doas", "rm", "-rf", "/"]), ["rm", "-rf", "/"], "连续提权词要剥干净");
  assert.deepEqual(stripElevation(["\\rm", "-rf", "/"]), ["rm", "-rf", "/"], "\\rm 归一成 rm");
  assert.deepEqual(stripElevation(["sudo"]), ["sudo"], "只有提权词、没有命令时不许切成空数组");
});

test("isRootishPath：只认「一删就不可逆」的目标", () => {
  for (const p of ["/", "/*", "C:", "C:/", "C:\\", "C:/*", "~", "~/", "$HOME", "${HOME}", "%USERPROFILE%", "/etc", "/usr", "..", "./", "/dev/sda", "/dev/nvme0n1"]) {
    assert.equal(isRootishPath(p), true, `${p} 应当算根级目标`);
  }
  for (const p of ["./dist", "node_modules", "build", "/tmp/vca-build", "C:\\Users\\me\\proj", "src/index.ts", "-rf", "/dev/null", "/dev/sda1x", ""]) {
    assert.equal(isRootishPath(p), false, `${p} 不该算根级目标`);
  }
});

test("hasRecursiveForce：组合写法 / 分开写 / 长选项都要认出来", () => {
  assert.equal(hasRecursiveForce(["-rf"]), true);
  assert.equal(hasRecursiveForce(["-fr"]), true);
  assert.equal(hasRecursiveForce(["-Rf"]), true, "大写 R 也要认（macOS 的 rm 就是 -R）");
  assert.equal(hasRecursiveForce(["-r", "-f"]), true);
  assert.equal(hasRecursiveForce(["--recursive", "--force"]), true);
  assert.equal(hasRecursiveForce(["-r"]), false, "只有 -r 没有强制，不算");
  assert.equal(hasRecursiveForce(["-f"]), false);
  assert.equal(hasRecursiveForce([]), false);
});

test("★ bash.ts 走的是同一份判据（不许再长回本地名单）", () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, "src", "tools", "bash.ts"), "utf-8"));
  assert.ok(src.includes("checkCommand("), "bash.ts 没有调用 checkCommand —— 护栏被绕过去了");
  assert.equal(src.includes("RISKY_COMMANDS"), false, "本地名单又长回来了，它必然与 guard 漂移");
  assert.equal(/\.includes\(/.test(src.split("checkCommand(")[0]), false, "判定之前先用裸 includes 过滤了一遍？");
  assert.ok(src.includes("verdict.reason") && src.includes("verdict.family"),
    "[BLOCKED] 文案里没有带 family/reason —— 模型拿不到「为什么被拦」");
  assert.ok(/import[\s\S]*command_guard/.test(src), "没有从 command_guard 引判据");
});

test("★ 工具描述里的承诺与实际能力对齐（描述是写给模型看的合同）", () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, "src", "tools", "bash.ts"), "utf-8"));
  const desc = /description:\s*([\s\S]*?),?\s*\n\s*schema:/.exec(src);
  assert.ok(desc, "没能切出 bash 的 description —— 切片失效的话下面两条会恒真");
  assert.ok(desc[1].includes("会被拦截"), "描述里不再提拦截，模型不会预期这里会被拦");
  assert.ok(/换|套一层|顺序/.test(desc[1]), "描述没提醒「换个写法照样会被拦」，模型会去试绕");
  // README 的「内置工具集」一栏也要能对得上
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf-8");
  const row = readme.split("\n").find((l) => l.includes("内置工具集"));
  assert.ok(row, "README 里找不到「内置工具集」那一行");
});
