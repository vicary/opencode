import { describe, expect, test } from "bun:test"
import type { OpencodeClient, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import { bootstrapDirectory } from "./bootstrap"
import type { State, VcsCache } from "./types"

const baseState = (input?: Partial<State>): State => ({
  status: "loading",
  agent: [],
  command: [],
  project: "",
  projectMeta: undefined,
  icon: undefined,
  provider_ready: true,
  provider: { all: [], connected: [], default: {} },
  config: {},
  path: { state: "", config: "", worktree: "", directory: "", home: "" },
  session: [],
  sessionTotal: 0,
  session_status: {},
  session_working(id: string) {
    const type = this.session_status[id]?.type
    return (type ?? "idle") !== "idle"
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
})

const queryClient = {
  ensureQueryData: async (input: { queryFn: () => Promise<unknown> }) => input.queryFn(),
  fetchQuery: async (input: { queryFn: () => Promise<unknown> }) => input.queryFn(),
} as any

const vcsCache: VcsCache = {
  store: [{ value: undefined }, {} as any] as any,
  setStore: (() => undefined) as any,
  ready: () => true,
}

describe("bootstrapDirectory", () => {
  test("replaces stale session_status entries with fresh bootstrap payload", async () => {
    const [store, setStore] = createStore(
      baseState({
        session_status: {
          ses_stale: { type: "busy" } as SessionStatus,
        },
      }),
    )

    const sdk = {
      config: { get: async () => ({ data: {} }) },
      session: { status: async () => ({ data: {} }) },
      project: { current: async () => ({ data: { id: "proj_1" } }) },
      vcs: { get: async () => ({ data: undefined }) },
      command: { list: async () => ({ data: [] }) },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
      provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      app: { agents: async () => ({ data: [] }) },
      path: { get: async () => ({ data: { state: "", config: "", worktree: "/tmp", directory: "/tmp", home: "" } }) },
      mcp: { status: async () => ({ data: {} }) },
    } as unknown as OpencodeClient

    bootstrapDirectory({
      directory: "/tmp",
      sdk,
      store,
      setStore,
      vcsCache,
      loadSessions: async () => undefined,
      translate: (key) => key,
      global: {
        config: {},
        path: { state: "", config: "", worktree: "", directory: "", home: "" },
        project: [],
        provider: { all: [], connected: [], default: {} },
      },
      queryClient,
    })

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.session_status).toEqual({})
    expect(store.session_working("ses_stale")).toBe(false)
  })
})
