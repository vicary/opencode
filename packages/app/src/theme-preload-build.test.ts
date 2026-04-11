import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build, mergeConfig } from "vite"
import cfg from "../vite.config"

const root = fileURLToPath(new URL("..", import.meta.url))
const dirs: string[] = []

describe("theme preload build", () => {
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("keeps external preload script in built html", async () => {
    const dir = join(root, ".tmp", `theme-preload-build-${process.pid}-${Date.now()}`)
    dirs.push(dir)
    await mkdir(dir, { recursive: true })

    await build(
      mergeConfig(cfg, {
        configFile: false,
        logLevel: "silent",
        root,
        build: {
          outDir: dir,
          emptyOutDir: true,
        },
      }),
    )

    const html = await Bun.file(join(dir, "index.html")).text()

    expect(html).toMatch(
      /<script\b[^>]*\bid="oc-theme-preload-script"[^>]*\bsrc="\/oc-theme-preload\.js"[^>]*><\/script>/,
    )
    expect(html).not.toMatch(/<script\b(?![^>]*\bsrc=)[^>]*\bid="oc-theme-preload-script"[^>]*>/)
  }, 20000)
})
