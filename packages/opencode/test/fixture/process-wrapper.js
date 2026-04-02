const { spawn } = require("child_process")
const fs = require("fs")

const file = process.argv[2]
const mode = process.argv[3] || "single"

if (!file) process.exit(1)

if (mode === "single") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  fs.writeFileSync(file, String(child.pid))
  setInterval(() => {}, 1000)
}

if (mode === "race") {
  const slow = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {
    stdio: "ignore",
  })
  const fast = spawn(
    process.execPath,
    ["-e", 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)'],
    { stdio: "ignore" },
  )
  fs.writeFileSync(file, [slow.pid, fast.pid].join(" "))
  setInterval(() => {}, 1000)
}
