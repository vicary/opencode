import { describe, expect, mock, test } from "bun:test"
import type { PermissionRequest, QuestionRequest, Session, Todo } from "@opencode-ai/sdk/v2/client"
import { sessionPermissionRequest, sessionQuestionRequest } from "./session-request-tree"

const solid = (await import("solid-js/dist/solid.cjs" as string)) as typeof import("solid-js")

mock.module("solid-js", () => solid)
mock.module("@solidjs/router", () => ({
  useParams: () => ({}),
}))

const mod = (await import("./session-composer-state?client-test" as string)) as typeof import("./session-composer-state")
const createDock = mod.createDock
const todoState = mod.todoState
const createRoot = solid.createRoot
const createSignal = solid.createSignal

const session = (input: { id: string; parentID?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
  }) as Session

const permission = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
  }) as PermissionRequest

const question = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    questions: [],
  }) as QuestionRequest

const todo = (status: Todo["status"]): Todo => ({ status } as Todo)

describe("sessionPermissionRequest", () => {
  test("prefers the current session permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")?.id).toBe("perm-root")
  })

  test("returns a nested child permission", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
      session({ id: "other" }),
    ]
    const permissions = {
      grand: [permission("perm-grand", "grand")],
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")?.id).toBe("perm-grand")
  })

  test("returns undefined without a matching tree permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")).toBeUndefined()
  })

  test("skips filtered permissions in the current tree", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", (item) => item.id !== "perm-root"))?.toMatchObject({
      id: "perm-child",
    })
  })

  test("returns undefined when all tree permissions are filtered out", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", () => false)).toBeUndefined()
  })
})

describe("sessionQuestionRequest", () => {
  test("prefers the current session question", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const questions = {
      root: [question("q-root", "root")],
      child: [question("q-child", "child")],
    }

    expect(sessionQuestionRequest(sessions, questions, "root")?.id).toBe("q-root")
  })

  test("returns a nested child question", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
    ]
    const questions = {
      grand: [question("q-grand", "grand")],
    }

    expect(sessionQuestionRequest(sessions, questions, "root")?.id).toBe("q-grand")
  })
})

describe("todoState", () => {
  test("hides when there are no todos", () => {
    expect(todoState({ count: 0, done: false, live: true })).toBe("hide")
  })

  test("opens while the session is still working", () => {
    expect(todoState({ count: 2, done: false, live: true })).toBe("open")
  })

  test("closes completed todos after a running turn", () => {
    expect(todoState({ count: 2, done: true, live: true })).toBe("close")
  })

  test("clears stale todos when the turn ends", () => {
    expect(todoState({ count: 2, done: false, live: false })).toBe("clear")
  })

  test("clears completed todos when the session is no longer live", () => {
    expect(todoState({ count: 2, done: true, live: false })).toBe("clear")
  })
})

describe("createDock", () => {
  test("status-only updates do not dirty todo-focused memo state", () => {
    createRoot((dispose: () => void) => {
      const [todos] = createSignal<Todo[]>([todo("pending")])
      const [active, setActive] = createSignal(false)
      const [blocked] = createSignal(false)

      const dock = createDock({
        todos,
        active,
        blocked,
        closeMs: () => 0,
        clear: () => {},
      })

      const first = dock.todo()

      expect(first.count).toBe(1)
      expect(first.done).toBe(false)

      setActive(true)

      expect(dock.todo()).toBe(first)
      expect(dock.todo().count).toBe(1)
      expect(dock.todo().done).toBe(false)

      dispose()
    })
  })

  test("status-driven state remains available through the streaming branch", () => {
    createRoot((dispose: () => void) => {
      const [todos] = createSignal<Todo[]>([todo("pending")])
      const [active] = createSignal(true)
      const [blocked] = createSignal(false)

      const dock = createDock({
        todos,
        active,
        blocked,
        closeMs: () => 0,
        clear: () => {},
      })

      expect(dock.live()).toBe(true)

      dispose()
    })
  })
})
