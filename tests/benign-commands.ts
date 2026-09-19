/**
 * 正常工作里会跑的命令 —— 一条都不许被护栏拦。
 *
 * 为什么单独成一个模块（而不是留在 `command-guard.test.ts` 里）
 * --------------------------------------------------------------
 * 现在有**两个**消费者：
 *   1. `command-guard.test.ts` —— 逐条喂给 `checkCommand`，一条都不许拦；
 *   2. `readme.test.ts` —— README 里写死的那两处事实都要对上它：
 *      · 「一份 N 条的良性回归集」里的 **N**；
 *      · README 承诺「都照常放行」的那几条具体命令，必须**真的在这份清单里**
 *        （否则文档在替护栏许一个它没验过的诺）。
 *
 * 留在测试文件里的话，第 2 个消费者只能去正则解析源码 —— 那是拿一份解析出来的
 * 期望去测另一份数据，本仓库已经栽过（`tests/source-utils.ts` 同名三份拷贝一起漂移）。
 *
 * 实测背景：README 里那句「40 条」在清单长到 73 条之后还写着 40，
 * 而唯一的守护断言是 `BENIGN.length >= 20`（那是一条**空跑哨兵**，防的是这一节被削空，
 * 它本来就不该、也不可能盯住 README 里的具体数字）。数字与清单从此接上现算对账。
 */

/** 正常工作里会跑的命令 —— 一条都不许拦 */
export const BENIGN: string[] = [
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

  // ---- 第二轮：启动器本身是日常写法，一条都不许因为「挂了启动器」而误拦 ----
  "nohup npm run server &",
  "nohup node dist/server.js > nohup.out 2>&1 &",
  "env NODE_ENV=production npm run build",
  "env -i PATH=/usr/bin:/bin sh -c 'echo hi'",
  "time npm test",
  "time -p npm test",
  "nice -n 10 npm run build",
  "timeout 60 npm test",
  "timeout -k 5 300 npm run build",
  "chroot /mnt/sysimage ls",
  "sudo -u www-data ls -la",
  "sudo -u postgres pg_dump mydb > backup.sql",
  "doas pkg_add vim",
  "command -v node",
  "exec node dist/main.js",
  "setsid npm run server",
  "stdbuf -o0 npm run build",
  "strace -o trace.log ls",
  "xargs rm -f",
  "watch -n 2 git status",
  "su -c 'whoami'",
  "runuser -u node -c 'npm test'",
  // 剥掉启动器之后剩下的仍然是**正常清理**，不许因为「多了个 nohup」就升级成危险
  "nohup rm -rf node_modules &",
  "timeout 300 rm -rf ./dist",
  "sudo -u www-data rm -rf /tmp/vca-build-1234",
  // PowerShell 那一侧的正常命令（短别名与长别名都要能正常放行）
  'powershell -c "Get-ChildItem"',
  'powershell -c Get-Date',
  "powershell -NoProfile -Command Get-Date",
  'pwsh -c "npm run build"',
  "powershell -ExecutionPolicy Bypass -c Get-Date",   // `-ex` 不是 `-e`：编码家族不许误伤
];
