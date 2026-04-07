import { describe, expect, test } from "bun:test"
import { shouldAllowDockPointer, shouldBlockPointer, shouldEnsureTodo } from "./session-todo-dock"

describe("shouldBlockPointer", () => {
  test("does not block pointer events while the list is partially visible", () => {
    // hide = 0.11 means the list is animating in — must remain interactive on mobile
    expect(shouldBlockPointer(0.11)).toBe(false)
  })

  test("does not block pointer events when fully visible", () => {
    expect(shouldBlockPointer(0)).toBe(false)
  })

  test("blocks pointer events only when fully hidden (>= 0.98)", () => {
    expect(shouldBlockPointer(0.99)).toBe(true)
    expect(shouldBlockPointer(1)).toBe(true)
  })

  test("does not block at the boundary just below off threshold", () => {
    expect(shouldBlockPointer(0.97)).toBe(false)
  })
})

describe("shouldAllowDockPointer", () => {
  test("allows pointer events while the dock is partially visible", () => {
    expect(shouldAllowDockPointer(0.11)).toBe(true)
  })

  test("allows pointer events when fully visible", () => {
    expect(shouldAllowDockPointer(1)).toBe(true)
  })

  test("keeps pointer events disabled only while nearly closed", () => {
    expect(shouldAllowDockPointer(0.05)).toBe(false)
  })

  test("keeps pointer events enabled once the dock is meaningfully open", () => {
    expect(shouldAllowDockPointer(0.97)).toBe(true)
  })
})

describe("shouldEnsureTodo", () => {
  test("keeps initial reveal when the list opens", () => {
    expect(
      shouldEnsureTodo({
        prev: { open: false, inProgress: 0 },
        next: { open: true, inProgress: 0 },
      }),
    ).toBe(true)
  })

  test("keeps follow-along when the active todo changes", () => {
    expect(
      shouldEnsureTodo({
        prev: { open: true, inProgress: 0 },
        next: { open: true, inProgress: 1 },
      }),
    ).toBe(true)
  })

  test("does not re-center just because the user stopped scrolling", () => {
    expect(
      shouldEnsureTodo({
        prev: { open: true, inProgress: 0 },
        next: { open: true, inProgress: 0 },
      }),
    ).toBe(false)
  })

  test("stays idle when there is no active todo", () => {
    expect(
      shouldEnsureTodo({
        prev: { open: true, inProgress: -1 },
        next: { open: true, inProgress: -1 },
      }),
    ).toBe(false)
  })
})
