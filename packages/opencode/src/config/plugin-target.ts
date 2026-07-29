export * as ConfigPluginTarget from "./plugin-target"

import { InstallationLocal, InstallationVersion } from "@opencode-ai/core/installation/version"
import semver from "semver"

export function installVersion() {
  if (InstallationLocal) return "*"
  if (!InstallationVersion.includes("preview")) return InstallationVersion

  const parsed = semver.parse(InstallationVersion)
  if (!parsed?.prerelease.length) return "latest"
  if (parsed.prerelease[0] !== "preview") return "latest"
  if (parsed.patch < 1) return "latest"
  return `${parsed.major}.${parsed.minor}.${parsed.patch - 1}`
}
