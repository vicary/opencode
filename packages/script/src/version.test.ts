import { expect, test } from "bun:test"
import semver from "semver"
import { preview } from "./version"

test("preview bumps to next patch before adding preview suffix", () => {
  expect(preview("1.3.0", "202603241230")).toBe("1.3.1-preview.202603241230")
})

test("preview stays below the final next patch release", () => {
  expect(semver.lt(preview("1.3.0", "202603241230"), "1.3.1")).toBe(true)
})

test("preview stays above the rebased base release", () => {
  expect(semver.gt(preview("1.3.0", "202603241230"), "1.3.0")).toBe(true)
})
