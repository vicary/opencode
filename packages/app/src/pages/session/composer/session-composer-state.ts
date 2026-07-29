import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionRequest, QuestionRequest, Todo } from "@opencode-ai/sdk/v2"
import { useParams } from "@solidjs/router"
import { showToast } from "@/utils/toast"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { sessionPermissionRequest, sessionQuestionRequest } from "./session-request-tree"

export const todoState = (input: {
  count: number
  done: boolean
  live: boolean
}): "hide" | "clear" | "open" | "close" => {
  if (input.count === 0) return "hide"
  if (!input.live) return "clear"
  if (!input.done) return "open"
  return "close"
}

export const todoDockAtBoundary = (state: ReturnType<typeof todoState>) => state === "open"

const idle = { type: "idle" as const }

export function createSessionComposerController(options?: { closeMs?: number | (() => number) }) {
  const params = useParams()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const language = useLanguage()
  const permission = usePermission()

  const questionRequest = createMemo((): QuestionRequest | undefined => {
    return sessionQuestionRequest(sync().data.session, sync().data.question, params.id)
  })

  const permissionRequest = createMemo((): PermissionRequest | undefined => {
    return sessionPermissionRequest(sync().data.session, sync().data.permission, params.id, (item) => {
      return !permission.autoResponds(item, sdk().directory)
    })
  })

  const blocked = createMemo(() => {
    const id = params.id
    if (!id) return false
    return !!permissionRequest() || !!questionRequest()
  })

  const todos = createMemo((): Todo[] => {
    const id = params.id
    if (!id) return []
    return serverSync().session.data.todo[id] ?? []
  })

  const live = createMemo(() => sync().data.session_working(params.id ?? "") || blocked())

  const summary = createMemo((previous: { count: number; done: boolean } | undefined) => {
    const list = todos()
    const count = list.length
    const done = count > 0 && list.every((todo) => todo.status === "completed" || todo.status === "cancelled")
    if (previous && previous.count === count && previous.done === done) return previous
    return { count, done }
  })

  const [store, setStore] = createStore({
    responding: undefined as string | undefined,
  })

  const permissionResponding = createMemo(() => {
    const perm = permissionRequest()
    if (!perm) return false
    return store.responding === perm.id
  })

  const decide = (response: "once" | "always" | "reject") => {
    const perm = permissionRequest()
    if (!perm) return
    if (store.responding === perm.id) return

    setStore("responding", perm.id)
    sdk()
      .api.permission.reply({ sessionID: perm.sessionID, requestID: perm.id, reply: response })
      .catch((err: unknown) => {
        const description = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description })
      })
      .finally(() => {
        setStore("responding", (id) => (id === perm.id ? undefined : id))
      })
  }

  const closeMs = () => {
    const value = options?.closeMs
    if (typeof value === "function") return Math.max(0, value())
    if (typeof value === "number") return Math.max(0, value)
    return 400
  }

  // Keep stale turn todos from reopening if the model never clears them.
  const clear = () => {
    const id = params.id
    if (!id) return
    sync().set("todo", id, [])
  }

  const dock = createDock({
    sessionID: () => params.id,
    live,
    summary,
    closeMs,
    clear,
  })

  return {
    blocked,
    questionRequest,
    permissionRequest,
    permissionResponding,
    decide,
    todos,
    dock: () => {
      if (dock.sessionID() === params.id) return dock.dock()
      return todoDockAtBoundary(todoState({ ...summary(), live: live() }))
    },
    closing: () => dock.sessionID() === params.id && dock.closing(),
    opening: () => dock.sessionID() === params.id && dock.opening(),
  }
}

function createDock(input: {
  sessionID: () => string | undefined
  live: () => boolean
  summary: () => { count: number; done: boolean }
  closeMs: () => number
  clear: () => void
}) {
  const [store, setStore] = createStore({
    sessionID: input.sessionID(),
    dock: todoDockAtBoundary(todoState({ ...input.summary(), live: input.live() })),
    closing: false,
    opening: false,
  })
  let timer: number | undefined
  let raf: number | undefined

  const scheduleClose = () => {
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      setStore({ dock: false, closing: false })
      timer = undefined
    }, input.closeMs())
  }

  createEffect(
    on(
      () => [input.sessionID(), input.summary(), input.live()] as const,
      ([id, summary, active], previous) => {
        if (raf) cancelAnimationFrame(raf)
        raf = undefined

        const next = todoState({
          count: summary.count,
          done: summary.done,
          live: active,
        })

        if (!previous || previous[0] !== id) {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          setStore({ sessionID: id, dock: todoDockAtBoundary(next), closing: false, opening: false })
          if (next === "clear") input.clear()
          return
        }

        if (next === "hide") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          setStore({ dock: false, closing: false, opening: false })
          return
        }

        if (next === "clear") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          input.clear()
          return
        }

        if (next === "open") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          const hidden = !store.dock || store.closing
          setStore({ dock: true, closing: false })
          if (hidden) {
            setStore("opening", true)
            raf = requestAnimationFrame(() => {
              setStore("opening", false)
              raf = undefined
            })
            return
          }
          setStore("opening", false)
          return
        }

        setStore({ dock: true, opening: false, closing: true })
        if (!timer) scheduleClose()
      },
    ),
  )

  onCleanup(() => {
    if (!timer) return
    window.clearTimeout(timer)
  })

  onCleanup(() => {
    if (!raf) return
    cancelAnimationFrame(raf)
  })

  return {
    sessionID: () => store.sessionID,
    dock: () => store.dock,
    closing: () => store.closing,
    opening: () => store.opening,
  }
}

export type SessionComposerController = ReturnType<typeof createSessionComposerController>
