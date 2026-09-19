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
  LAUNCHERS,
  checkCommand,
  hasRecursiveForce,
  isRootishPath,
  normalize,
  splitSegments,
  stripLaunchers,
  stripLaunchersText,
  tokenize,
  unwrap,
} from "../src/tools/command_guard.js";
import { BENIGN } from "./benign-commands.js";
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

  // ================= 第二轮：命令词前面挂东西 =================
  // 上一版所有判据都默认「命令词在 tokens[0]」，为了挡 `sudo rm -rf /` 只特判了 `sudo`。
  // 于是「`sudo` 后面跟个选项」就把它自己那一格也弄丢了 —— 下面这组是把「挂一个词就失效」
  // 这件事按启动器逐条钉住（不是又列了一批危险命令的拼法）。
  ["sudo -u root rm -rf /", "recursive-force-delete"],
  ["sudo -E rm -rf /", "recursive-force-delete"],
  ["sudo --user=root rm -rf /", "recursive-force-delete"],
  ["sudo -u root nohup rm -rf /", "recursive-force-delete"],
  ["doas rm -rf /", "recursive-force-delete"],
  ["nohup rm -rf /", "recursive-force-delete"],
  ["env rm -rf /", "recursive-force-delete"],
  ["env FOO=1 rm -rf /", "recursive-force-delete"],
  ["FOO=1 rm -rf /", "recursive-force-delete"],
  ["time rm -rf /", "recursive-force-delete"],
  ["time -p rm -rf /", "recursive-force-delete"],
  ["nice rm -rf /", "recursive-force-delete"],
  ["nice -n 5 rm -rf /", "recursive-force-delete"],
  ["timeout 30 rm -rf /", "recursive-force-delete"],
  ["timeout -k 5 30 rm -rf /", "recursive-force-delete"],
  ["chroot /mnt rm -rf /", "recursive-force-delete"],
  ["command rm -rf /", "recursive-force-delete"],
  ["exec rm -rf /", "recursive-force-delete"],
  ["setsid rm -rf /", "recursive-force-delete"],
  ["stdbuf -o0 rm -rf /", "recursive-force-delete"],
  ["strace -o log rm -rf /", "recursive-force-delete"],
  ["xargs rm -rf /", "recursive-force-delete"],
  ["watch -n 1 chmod 777 /", "chmod-chown-root"],
  ["nohup timeout 30 dd of=/dev/sda if=/dev/zero", "raw-device-write"],
  ["nohup mkfs.ext4 /dev/sda", "mkfs"],
  ["timeout 30 chmod -R 777 /", "chmod-chown-root"],
  ["env FOO=1 rm -rf C:\\", "recursive-force-delete"],
  ['sudo -u root powershell -c "Format-Volume -DriveLetter C"', "powershell-destructive"],
  // 两层：先挂启动器、再套 shell —— 两个剥法必须能叠加，各剥一层是不够的
  ["nohup bash -c 'rm -rf /'", "recursive-force-delete"],
  ["nohup sh -c 'rm -rf ~'", "recursive-force-delete"],
  ["sudo nohup bash -c 'rm -rf /'", "recursive-force-delete"],
  ["env FOO=1 timeout 5 rm -rf /", "recursive-force-delete"],
  // `su -c "…"`：`-c` 的值本身就是命令，不是「跳过它」
  ['su -c "rm -rf /"', "recursive-force-delete"],
  ['su root -c "rm -rf /"', "recursive-force-delete"],
  ["runuser -u root -c 'rm -rf /'", "recursive-force-delete"],
  // ---- 第二个错误前提：命令必须是明文 ----
  // PowerShell 的参数可以只写无歧义前缀，`-c` 与 `-command` 是同一个参数；
  // 上一版只认全称，于是最常见的那种写法正好放行。
  ['powershell -c "Remove-Item -Recurse -Force C:\\"', "powershell-destructive"],
  ['pwsh -c "Remove-Item -Recurse -Force C:\\"', "powershell-destructive"],
  ['powershell -com "Remove-Item -Recurse -Force C:\\"', "powershell-destructive"],
  ["powershell -c Format-Volume -DriveLetter C", "powershell-destructive"],
  ['pwsh -NoProfile -c "Clear-Disk -Number 0"', "powershell-destructive"],
  // 命令被编码，护栏读不出内容 —— 读不出来就只能拦，不能猜
  ["powershell -EncodedCommand UwB0AG8AcABQAHIAbwBjAGUAcwBz", "powershell-encoded-command"],
  ["pwsh -e UwB0AG8AcABQAHIAbwBjAGUAcwBz", "powershell-encoded-command"],
  ['powershell -NoProfile -EncodedCommand QQBiAGMA', "powershell-encoded-command"],
];

// BENIGN 挪到 ./benign-commands.ts —— 现在有两个消费者（本文件的逐条放行断言，
// 以及 readme.test.ts 里「README 写死的条数 / 承诺放行的命令」那两处现算对账），
// 留在测试文件里的话第二个消费者只能去正则解析源码。


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
  assert.deepEqual(stripLaunchers(["sudo", "doas", "rm", "-rf", "/"]), ["rm", "-rf", "/"], "连续提权词要剥干净");
  assert.deepEqual(stripLaunchers(["\\rm", "-rf", "/"]), ["rm", "-rf", "/"], "\\rm 归一成 rm");
  assert.deepEqual(stripLaunchers(["sudo"]), ["sudo"], "只有提权词、没有命令时不许切成空数组");
  // 命令头定位：剥掉启动器**以及它自己的选项/参数**，剩下的第一个词才是命令
  assert.deepEqual(stripLaunchers(["sudo", "-u", "root", "rm", "-rf", "/"]), ["rm", "-rf", "/"], "`-u` 的值要一起跳");
  assert.deepEqual(stripLaunchers(["sudo", "--user=root", "rm", "-rf", "/"]), ["rm", "-rf", "/"], "`--user=root` 的值在同一个 token 里");
  assert.deepEqual(stripLaunchers(["npm", "run", "build"]), ["npm", "run", "build"], "不是启动器的词不许动");
  assert.deepEqual(stripLaunchers(["timeout", "30", "rm", "-rf", "/"]), ["rm", "-rf", "/"], "timeout 自己的位置参数要吃掉");
  assert.deepEqual(stripLaunchers(["nice", "-n", "5", "rm", "-rf", "/"]), ["rm", "-rf", "/"], "带值的选项要连值一起跳");
  assert.deepEqual(stripLaunchers(["FOO=1", "rm", "-rf", "/"]), ["rm", "-rf", "/"], "前置赋值不算命令");
  assert.deepEqual(stripLaunchers(["su", "-c", "rm -rf /"]), ["rm", "-rf", "/"], "`-c` 的值就是命令 —— 剥出来接着判，不是跳过");
  assert.deepEqual(stripLaunchers(["env", "FOO=1", "rm", "-rf", "/"]), ["rm", "-rf", "/"], "env 的赋值要跳掉");
  assert.deepEqual(stripLaunchers(["sudo", "-i"]), ["sudo", "-i"], "只剩启动器时同样不许切空");
  // 文本版：头词没变就返回 null（免得候选集里塞一堆等价的串）
  assert.equal(stripLaunchersText("nohup rm -rf /"), "rm -rf /", "剥掉了头词就要给出内层串");
  assert.equal(stripLaunchersText("rm -rf /"), null, "头词没变就返回 null");
  assert.equal(stripLaunchersText("nohup bash -c 'rm -rf /'"), "bash -c rm -rf /", "只剥一层启动器 —— 剩下那层 shell 交给 unwrap");
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

// ============================ 第二轮：命令头定位 ============================

/**
 * 每个启动器的**真实写法**探针 —— 手写，这就是规格。
 *
 * 刻意不从 `LAUNCHERS` 现算探针：那样「表里少一条启动器」只会少跑一圈、静默通过
 * （本仓在 `source-utils` 的关键字表上栽过同一个坑，那里是靠「宇宙 − 表」的减法补上的）。
 * 这里没有可现算的「启动器宇宙」，所以规格就明写在这张表上，再与实现两向对账。
 */
const LAUNCHER_PROBES: Record<string, string> = {
  sudo: "sudo -u root rm -rf /",
  doas: "doas rm -rf /",
  env: "env FOO=1 rm -rf /",
  nohup: "nohup rm -rf /",
  time: "time -p rm -rf /",
  nice: "nice -n 5 rm -rf /",
  ionice: "ionice -c 3 rm -rf /",
  timeout: "timeout -k 5 30 rm -rf /",
  chroot: "chroot /mnt rm -rf /",
  su: 'su root -c "rm -rf /"',
  runuser: "runuser -u root -c 'rm -rf /'",
  command: "command rm -rf /",
  builtin: "builtin rm -rf /",
  exec: "exec rm -rf /",
  setsid: "setsid rm -rf /",
  stdbuf: "stdbuf -o0 rm -rf /",
  strace: "strace -o log rm -rf /",
  ltrace: "ltrace -o log rm -rf /",
  xargs: "xargs rm -rf /",
  watch: "watch -n 1 rm -rf /",
  caffeinate: "caffeinate rm -rf /",
};

/**
 * 故意**不**认的启动器 + 理由（棘轮：只许减少；已经认了却还挂在这里也要报）。
 *
 * 「没覆盖」是可以接受的（README 已写明这不是沙箱），「没说为什么」不行 ——
 * 不写下来的话，下一个人分不清这是漏了还是想过。
 */
const LAUNCHER_EXCEPTIONS: Record<string, string> = {
  at: "把命令交给 atd 定时执行，命令串不在本进程的命令行上 —— 判据看不到它",
  batch: "at 的别名：同样是把命令交出去排队，命令行上只剩任务名，看不到真正的命令",
  qsub: "提交给 PBS/SGE 集群执行，真正的命令写在作业脚本里，不在这一层命令行上",
  "systemd-run": "选项面太大（-p/--property/--unit/--setenv…），少列一个就会把命令词当值吞掉；宁可漏也不误判",
};

test("★ 启动器：规格 ⇄ 实现两向对账（少一条 / 多一条 / 例外表腐烂都要报）", () => {
  const keys = Object.keys(LAUNCHERS);
  const spec = Object.keys(LAUNCHER_PROBES);

  const missing = spec.filter((l) => !keys.includes(l));
  assert.deepEqual(missing, [], `规格里有、实现里没有的启动器（挂上它就绕过去了）：${missing.join(", ")}`);

  const unregistered = keys.filter((l) => !spec.includes(l) && !(l in LAUNCHER_EXCEPTIONS));
  assert.deepEqual(unregistered, [],
    `实现里新加了启动器，却没在探针表或例外表里登记 —— 后人分不清是漏了还是想过：${unregistered.join(", ")}`);

  const resurrected = Object.keys(LAUNCHER_EXCEPTIONS).filter((l) => keys.includes(l));
  assert.deepEqual(resurrected, [], `这些已经认了，还挂在「故意不认」的表里：${resurrected.join(", ")}`);

  assert.ok(spec.length >= 20, `启动器规格只剩 ${spec.length} 条，这一节等于空跑`);
  for (const [name, why] of Object.entries(LAUNCHER_EXCEPTIONS)) {
    assert.ok(why.length >= 12, `${name} 的例外理由太短，看不清为什么：「${why}」`);
  }
});

test("★ 每个启动器的真实写法都必须被剥掉（表里的每一行都不是死数据）", () => {
  const missed: string[] = [];
  for (const [launcher, cmd] of Object.entries(LAUNCHER_PROBES)) {
    const v = checkCommand(cmd);
    if (!v.blocked) missed.push(`${launcher}: ${cmd} → 放行`);
    else if (v.family !== "recursive-force-delete") missed.push(`${launcher}: ${cmd} → 归到了 ${v.family}`);
  }
  assert.deepEqual(missed, [], `挂上启动器之后判据就失守了（命令词被挪开了位置）：\n  ${missed.join("\n  ")}`);
});

test("★ 剥启动器与剥 shell 包装要能叠加，不是各剥一层就完事", () => {
  // `nohup bash -c 'rm -rf /'`：token 级剥一层（nohup），字符串级还要再剥一层（bash -c）。
  // 只在其中一侧做，就是一条通道。
  const cases: Array<[string, string]> = [
    ["nohup bash -c 'rm -rf /'", "启动器在外层"],
    ["bash -c 'nohup rm -rf /'", "启动器在内层"],
    ["sudo nohup bash -c 'rm -rf /'", "三层叠起来"],
    ["env FOO=1 timeout 5 sh -c 'rm -rf /'", "启动器 + 带值 + 超时 + shell"],
  ];
  for (const [cmd, why] of cases) {
    const v = checkCommand(cmd);
    assert.equal(v.blocked, true, `${why}：${cmd} 被放行了`);
  }
  // 反向：剥完之后不是危险命令的，不许因为「叠了两层」就升级
  for (const cmd of ["nohup bash -c 'npm test'", "sudo timeout 30 sh -c 'git status'"]) {
    assert.equal(checkCommand(cmd).blocked, false, `${cmd} 被误拦了`);
  }
});

test("★ README 那张「包里带哪些」必须覆盖每一个家族（两向，现算）", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf-8");
  const start = readme.indexOf("## 命令安全护栏");
  assert.ok(start >= 0, "README 里找不到「命令安全护栏」一节 —— 切片失效的话下面两条会恒真");
  const rest = readme.slice(start);
  const next = rest.slice(3).search(/^## /m);
  const body = next >= 0 ? rest.slice(0, next + 3) : rest;

  // 表格第一列写的家族名；一格写多个（`` `format-disk` / `mkfs` ``）要全都收进来 ——
  // 所以取的是整列再抽反引号，而不是「第一个反引号后面的东西」
  const listed = new Set<string>();
  for (const line of body.split("\n")) {
    const m = /^\|([^|]*)\|/.exec(line);
    if (!m) continue;
    for (const t of m[1].matchAll(/`([^`]+)`/g)) {
      const name = t[1].trim();
      if (name) listed.add(name);
    }
  }
  assert.ok(listed.size >= 5, `只从表格里切出 ${listed.size} 个家族名，切片大概失效了`);

  const missing = FAMILY_NAMES.filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `README 的表里没有这些家族 —— 表是给用户看的承诺，漏了就没人知道它拦什么：${missing.join(", ")}`);
  const ghost = [...listed].filter((f) => !FAMILY_NAMES.includes(f));
  assert.deepEqual(ghost, [], `README 表里出现了不存在的家族名（文案会指错方向）：${ghost.join(", ")}`);
});

test("★ 旧名 stripElevation 不许复活（名字只描述特判，后人会以为别的词不用管）", () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, "src", "tools", "command_guard.ts"), "utf-8"));
  assert.equal(src.includes("stripElevation"), false,
    "旧名又回来了 —— 它是「只剥 sudo」那一版的遗留；洞口正是「名字只描述特判」");
  assert.ok(src.includes("stripLaunchers(tokenize("), "checkCommand 没有走命令头定位？剥注释后再看");
  assert.ok(src.includes("stripLaunchersText("), "候选集没有让「剥启动器」和「剥包装」叠加");
});
