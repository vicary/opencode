import { describe, expect, test } from "bun:test"
import { shouldEnsureTodo } from "./session-todo-dock"

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
