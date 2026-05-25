import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { Config, OpencodeClient, Project, SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@opencode-ai/ui/context"
import { bootstrapDirectory } from "./bootstrap"
import type { State, VcsCache } from "./types"

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse

function state(input?: Partial<State>) {
  return {
    status: "loading",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider,
    config: {},
    path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_working(id: string) {
      return (this.session_status[id]?.type ?? "idle") !== "idle"
    },
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: true,
    mcp: {},
    lsp_ready: true,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    part: {},
    part_text_accum_delta: {},
    ...input,
  } satisfies State
}

const sdk = (input?: { sessionStatus?: Record<string, SessionStatus> }) =>
  ({
    app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
    config: { get: async () => ({ data: {} }) },
    session: { status: async () => ({ data: input?.sessionStatus ?? {} }) },
    vcs: { get: async () => ({ data: undefined }) },
    command: { list: async () => ({ data: [] }) },
    permission: { list: async () => ({ data: [] }) },
    question: { list: async () => ({ data: [] }) },
    mcp: { status: async () => ({ data: {} }) },
    provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
  }) as unknown as OpencodeClient

const bootstrapInput = (input: {
  store: State
  setStore: ReturnType<typeof createStore<State>>[1]
  sdk?: OpencodeClient
}) => ({
  directory: "/project",
  global: {
    config: {} satisfies Config,
    path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
    project: [{ id: "project", worktree: "/project" } as Project],
    provider,
  },
  sdk: input.sdk ?? sdk(),
  store: input.store,
  setStore: input.setStore,
  vcsCache: { setStore() {} } as unknown as VcsCache,
  loadSessions() {},
  translate: (key: string) => key,
  queryClient: new QueryClient(),
})

describe("bootstrapDirectory", () => {
  test("marks a loading directory partial during bootstrap and complete after success", async () => {
    const [store, setStore] = createStore<State>(state())

    await bootstrapDirectory(bootstrapInput({ store, setStore }))

    expect(store.status).toBe("partial")

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
  })

  test("replaces stale running session statuses with the bootstrap payload", async () => {
    const [store, setStore] = createStore<State>(
      state({
        session_status: {
          ses_stale: { type: "busy" },
        },
      }),
    )

    await bootstrapDirectory(bootstrapInput({ store, setStore, sdk: sdk() }))
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.session_status).toEqual({})
    expect(store.session_working("ses_stale")).toBe(false)
  })
})
