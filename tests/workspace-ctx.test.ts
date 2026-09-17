/**
 * 工作目录上下文的两层语义。
 *
 * 主代理用模块级变量（TS 单线程，够用），子代理用 `AsyncLocalStorage` 挂在自己的异步链上。
 * 这一层最容易出的错是**看不出错**：子代理跑完不复原模块级变量，主代理接下来所有相对路径
 * 都解析到子代理的目录里去，文件写到别处，全程不报任何错 —— 而主代理与子代理常常共用
 * 同一个目录，所以连「路径变短了/变长了」这种可疑迹象都不会有（只有显式给了 workspace
 * 的子代理才会露出来，而那时人已经在别处找 bug 了）。
 *
 * 所以这里把**还原**当作一号被测对象，四条出口逐条钉住：同步返回、同步抛、
 * 异步 resolve、异步 reject。「在 ALS 里跑」反而只是手段。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  getWorkspace,
  resetWorkspace,
  resolvePath,
  runWithWorkspace,
  setWorkspace,
} from "../src/workspace_ctx.js";

const BASE = path.resolve("vca-ws-test");
const A = path.join(BASE, "a");
const B = path.join(BASE, "b");
const C = path.join(BASE, "c");

/** 每个用例自己起手：模块级变量是共享的，用例之间不许互相继承状态 */
function fresh(): void {
  resetWorkspace();
  setWorkspace(A);
}

test("什么都没设时回落到进程 cwd（不是空串）", () => {
  resetWorkspace();
  assert.equal(getWorkspace(), process.cwd());
});

test("setWorkspace 会解析成绝对路径，resetWorkspace 能清掉", () => {
  fresh();
  assert.equal(getWorkspace(), path.resolve(A));
  setWorkspace("relative-dir");
  assert.equal(getWorkspace(), path.resolve("relative-dir"));
  resetWorkspace();
  assert.equal(getWorkspace(), process.cwd());
});

test("同步：runWithWorkspace 内部看到的是新目录，跑完还原成原来的", () => {
  fresh();
  // fn 里必须真的调一次 setWorkspace —— 真实的 `CodingAgent` agent 节点每轮都会调，
  // 而那正是「不还原就会泄漏」的唯一途径。不调的话这条断言恒真（实测：把还原整段删掉
  // 仍然是绿的），锁就成了摆设。
  const inside = runWithWorkspace(B, () => {
    setWorkspace(C);
    return getWorkspace();
  });
  assert.equal(inside, path.resolve(B));
  assert.equal(getWorkspace(), path.resolve(A), "跑完之后模块级变量没有被还原");
});

test("异步 resolve：内部的 setWorkspace 不许泄漏到外面", async () => {
  fresh();
  const seen: string[] = [];

  // 子代理内部的 CodingAgent 每轮都会调 setWorkspace(自己的目录) —— 这里如实模拟
  await runWithWorkspace(B, async () => {
    await new Promise((r) => setTimeout(r, 1));
    setWorkspace(C);
    seen.push(getWorkspace());
    await new Promise((r) => setTimeout(r, 1));
    seen.push(getWorkspace());
  });

  // ALS 优先：即使模块级变量已经被改成 C，子代理内部看到的一直是 B
  assert.deepEqual(seen, [path.resolve(B), path.resolve(B)]);
  assert.equal(getWorkspace(), path.resolve(A), "异步跑完后模块级变量没有被还原");
});

test("异步 reject：错误照常抛出，且仍然还原", async () => {
  fresh();
  await assert.rejects(
    runWithWorkspace(B, async () => {
      setWorkspace(C);
      throw new Error("子代理炸了");
    }),
    /子代理炸了/
  );
  assert.equal(getWorkspace(), path.resolve(A), "抛出去的路上没有还原");
});

test("同步 throw：错误照常抛出，且仍然还原", () => {
  fresh();
  assert.throws(
    () =>
      runWithWorkspace(B, () => {
        setWorkspace(C);
        throw new Error("同步炸了");
      }),
    /同步炸了/
  );
  assert.equal(getWorkspace(), path.resolve(A), "抛出去的路上没有还原");
});

test("嵌套：内层优先，出来一层退一层", () => {
  fresh();
  runWithWorkspace(B, () => {
    setWorkspace(B); // 外层「节点」
    assert.equal(getWorkspace(), path.resolve(B));
    runWithWorkspace(C, () => {
      setWorkspace(C); // 内层「节点」
      assert.equal(getWorkspace(), path.resolve(C));
    });
    // 这一层能过是因为 ALS 优先（模块级变量此刻是 C）—— 单看它证明不了还原
    assert.equal(getWorkspace(), path.resolve(B), "内层结束后应当退回外层目录");
  });
  // 这一层才真的在验还原：两层都调过 setWorkspace，谁少还原一次这里就红
  assert.equal(getWorkspace(), path.resolve(A));
});

test("resolvePath：相对路径按当前逻辑目录解析，绝对路径原样", () => {
  fresh();
  assert.equal(resolvePath("x.ts"), path.join(path.resolve(A), "x.ts"));
  runWithWorkspace(B, () => {
    assert.equal(resolvePath("x.ts"), path.join(path.resolve(B), "x.ts"));
  });
  const abs = path.join(BASE, "abs.ts");
  assert.equal(resolvePath(abs), abs);
});

test("★ 反向对照：没有 runWithWorkspace 包裹时，setWorkspace 就是会留在外面", () => {
  // 上面几条「还原」断言只有在「不包裹时确实不还原」的前提下才有意义 ——
  // 否则它们可能只是被一个恒真的实现哄住的。这条就是那个前提。
  fresh();
  setWorkspace(C);
  assert.equal(getWorkspace(), path.resolve(C));
  assert.notEqual(getWorkspace(), path.resolve(A));
});
