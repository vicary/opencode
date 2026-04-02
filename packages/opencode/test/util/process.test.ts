import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Process } from "@/util/process"
import { tmpdir } from "../fixture/fixture"

function node(script: string) {
  return [process.execPath, "-e", script]
}

const wrapper = path.join(import.meta.dir, "../fixture/process-wrapper.js")

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function wait(file: string, timeout = 3_000) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    const text = await fs.readFile(file, "utf8").catch(() => "")
    const pid = Number(text.trim())
    if (pid > 0) return pid
    await Bun.sleep(20)
  }

  throw new Error(`Timed out waiting for pid file: ${file}`)
}

async function gone(pid: number, timeout = 3_000) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    if (!alive(pid)) return
    await Bun.sleep(20)
  }

  throw new Error(`Timed out waiting for process exit: ${pid}`)
}

async function waitMany(file: string, count: number, timeout = 3_000) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    const text = await fs.readFile(file, "utf8").catch(() => "")
    const pids = text
      .trim()
      .split(/\s+/)
      .map((x) => Number(x))
      .filter((x) => x > 0)
    if (pids.length >= count) return pids
    await Bun.sleep(20)
  }

  throw new Error(`Timed out waiting for pid file: ${file}`)
}

async function wrap(file: string, mode: string) {
  const proc = Process.spawn([process.execPath, wrapper, file, mode], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })

  return {
    proc,
    stop: async (...pids: number[]) => {
      await Process.stop(proc).catch(() => undefined)
      for (const pid of pids) {
        if (alive(pid)) process.kill(pid, "SIGKILL")
      }
    },
  }
}

describe("util.process", () => {
  test("captures stdout and stderr", async () => {
    const out = await Process.run(node('process.stdout.write("out");process.stderr.write("err")'))
    expect(out.code).toBe(0)
    expect(out.stdout.toString()).toBe("out")
    expect(out.stderr.toString()).toBe("err")
  })

  test("returns code when nothrow is enabled", async () => {
    const out = await Process.run(node("process.exit(7)"), { nothrow: true })
    expect(out.code).toBe(7)
  })

  test("throws RunFailedError on non-zero exit", async () => {
    const err = await Process.run(node('process.stderr.write("bad");process.exit(3)')).catch((error) => error)
    expect(err).toBeInstanceOf(Process.RunFailedError)
    if (!(err instanceof Process.RunFailedError)) throw err
    expect(err.code).toBe(3)
    expect(err.stderr.toString()).toBe("bad")
  })

  test("aborts a running process", async () => {
    const abort = new AbortController()
    const started = Date.now()
    setTimeout(() => abort.abort(), 25)

    const out = await Process.run(node("setInterval(() => {}, 1000)"), {
      abort: abort.signal,
      nothrow: true,
    })

    expect(out.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(1000)
  }, 3000)

  test("kills after timeout when process ignores terminate signal", async () => {
    if (process.platform === "win32") return

    const abort = new AbortController()
    const started = Date.now()
    setTimeout(() => abort.abort(), 25)

    const out = await Process.run(node('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'), {
      abort: abort.signal,
      nothrow: true,
      timeout: 25,
    })

    expect(out.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(1000)
  }, 3000)

  test("uses cwd when spawning commands", async () => {
    await using tmp = await tmpdir()
    const out = await Process.run(node("process.stdout.write(process.cwd())"), {
      cwd: tmp.path,
    })
    expect(out.stdout.toString()).toBe(tmp.path)
  })

  test("merges environment overrides", async () => {
    const out = await Process.run(node('process.stdout.write(process.env.OPENCODE_TEST ?? "")'), {
      env: {
        OPENCODE_TEST: "set",
      },
    })
    expect(out.stdout.toString()).toBe("set")
  })

  test("uses shell in run on Windows", async () => {
    if (process.platform !== "win32") return

    const out = await Process.run(["set", "OPENCODE_TEST_SHELL"], {
      shell: true,
      env: {
        OPENCODE_TEST_SHELL: "ok",
      },
    })

    expect(out.code).toBe(0)
    expect(out.stdout.toString()).toContain("OPENCODE_TEST_SHELL=ok")
  })

  test("runs cmd scripts with spaces on Windows without shell", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "with space")
    const file = path.join(dir, "echo cmd.cmd")

    await fs.mkdir(dir, { recursive: true })
    await Bun.write(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n")

    const proc = Process.spawn([file, "--stdio"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await proc.exited).toBe(0)
  })

  test("rejects missing commands without leaking unhandled errors", async () => {
    await using tmp = await tmpdir()
    const cmd = path.join(tmp.path, "missing" + (process.platform === "win32" ? ".cmd" : ""))
    const err = await Process.spawn([cmd], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }).exited.catch((err) => err)

    expect(err).toBeInstanceOf(Error)
    if (!(err instanceof Error)) throw err
    expect(err).toMatchObject({
      code: "ENOENT",
    })
  })

  test("stops descendant processes on non-Windows", async () => {
    if (process.platform === "win32") return

    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "child.pid")
    const run = await wrap(file, "single")

    const pid = await wait(file)

    try {
      expect(alive(pid)).toBe(true)
      await Process.stop(run.proc)
      await run.proc.exited.catch(() => undefined)
      await gone(pid)
    } finally {
      await run.stop(pid)
    }
  }, 10_000)

  test("stopPid kills descendants without a ChildProcess handle", async () => {
    if (process.platform === "win32") return

    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "child.pid")
    const run = await wrap(file, "single")

    const pid = await wait(file)

    try {
      expect(alive(pid)).toBe(true)
      await Process.stopPid(run.proc.pid!)
      await gone(pid)
    } finally {
      await run.stop(pid)
    }
  }, 10_000)

  test("stopPid continues after one child exits before kill", async () => {
    if (process.platform === "win32") return

    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "children.pid")
    const run = await wrap(file, "race")

    const [slow, fast] = await waitMany(file, 2)

    try {
      expect(alive(slow)).toBe(true)
      await Process.stopPid(run.proc.pid!)
      await gone(fast)
      await gone(slow)
    } finally {
      await run.stop(fast, slow)
    }
  }, 10_000)
})
