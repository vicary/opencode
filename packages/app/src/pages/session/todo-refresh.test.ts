import { describe, expect, test } from "bun:test"
import { shouldRefresh } from "./todo-refresh"

describe("shouldRefresh", () => {
  test("refreshes when activity starts with the blocked path unchanged", () => {
    expect(shouldRefresh({ active: true, blocked: false }, { active: false, blocked: false })).toBe(true)
  })

  test("status-only churn does not force unrelated blocked-path refresh work", () => {
    expect(shouldRefresh({ active: true, blocked: false }, { active: true, blocked: false })).toBe(false)
  })

  test("refreshes when the blocked path activates with status unchanged", () => {
    expect(shouldRefresh({ active: false, blocked: true }, { active: false, blocked: false })).toBe(true)
  })

  test("blocked refresh decisions ignore later status-only churn", () => {
    expect(shouldRefresh({ active: true, blocked: true }, { active: false, blocked: true })).toBe(false)
  })

  test("refreshes when blocked clears while activity stays true", () => {
    expect(shouldRefresh({ active: true, blocked: false }, { active: true, blocked: true })).toBe(true)
  })

  test("refreshes when blocked clears as activity starts", () => {
    expect(shouldRefresh({ active: true, blocked: false }, { active: false, blocked: true })).toBe(true)
  })

  test("still refreshes on the first eligible state", () => {
    expect(shouldRefresh({ active: false, blocked: true })).toBe(true)
  })
})
