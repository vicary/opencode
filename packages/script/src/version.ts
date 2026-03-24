import semver from "semver"

export function preview(base: string, stamp: string) {
  const next = semver.inc(base, "patch")
  if (!next) {
    throw new Error(`failed to increment version: ${base}`)
  }
  return `${next}-preview.${stamp}`
}
