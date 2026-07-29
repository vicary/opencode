import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode, Node } from "@opencode-ai/core/effect/app-node"
import { GlobalBus } from "@/bus/global"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Context, Deferred, Duration, Effect, Exit, Layer, Schedule, Scope } from "effect"
import { type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import * as Project from "./project"

const INSTANCE_IDLE_MS = 300_000
const INSTANCE_SWEEP_MS = 30_000

export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeDirectory: (directory: string) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  readonly hold: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

export const use = serviceUse(Service)

interface Entry {
  readonly deferred: Deferred.Deferred<InstanceContext>
  used: number
  active: number
  hold: number
  disposing?: Deferred.Deferred<void>
}

const layer: Layer.Layer<Service, never, Project.Service | InstanceBootstrap.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const scope = yield* Scope.Scope
    const cache = new Map<string, Entry>()

    const now = () => Date.now()
    const touch = (entry: Entry) => {
      entry.used = now()
    }

    const boot = (input: LoadInput & { directory: string }) =>
      Effect.gen(function* () {
        const ctx: InstanceContext =
          input.project && input.worktree
            ? {
                directory: input.directory,
                worktree: input.worktree,
                project: input.project,
              }
            : yield* project.fromDirectory(input.directory).pipe(
                Effect.map((result) => ({
                  directory: input.directory,
                  worktree: result.sandbox,
                  project: result.project,
                })),
              )
        yield* bootstrap.run.pipe(Effect.provideService(InstanceRef, ctx))
        return ctx
      }).pipe(Effect.withSpan("InstanceStore.boot"))

    const removeEntry = (directory: string, entry: Entry) =>
      Effect.sync(() => {
        if (cache.get(directory) !== entry) return false
        cache.delete(directory)
        return true
      })

    const createEntry = () => ({
      deferred: Deferred.makeUnsafe<InstanceContext>(),
      used: now(),
      active: 0,
      hold: 0,
    })

    const stale = (directory: string, entry: Entry, used = now()) => {
      if (cache.get(directory) !== entry) return false
      if (entry.disposing) return false
      if (entry.active > 0) return false
      if (entry.hold > 0) return false
      return used - entry.used >= INSTANCE_IDLE_MS
    }

    const withCounter = <A, E, R>(
      entry: Entry,
      key: "active" | "hold",
      restore: <A2, E2, R2>(effect: Effect.Effect<A2, E2, R2>) => Effect.Effect<A2, E2, R2>,
      effect: Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        touch(entry)
        entry[key] += 1
        return yield* restore(effect).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              touch(entry)
              entry[key] -= 1
            }),
          ),
        )
      })

    const completeLoad = (directory: string, input: LoadInput, entry: Entry) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(boot({ ...input, directory }))
        if (Exit.isFailure(exit)) yield* removeEntry(directory, entry)
        yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
      })

    const emitDisposed = (input: { directory: string; project?: string }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: input.directory,
          project: input.project,
          workspace: WorkspaceContext.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: input.directory,
            },
          },
        }),
      )

    const disposeContext = Effect.fn("InstanceStore.disposeContext")(function* (ctx: InstanceContext) {
      yield* Effect.logInfo("disposing instance", { directory: ctx.directory })
      yield* Effect.promise(() => runDisposers(ctx.directory))
      yield* emitDisposed({ directory: ctx.directory, project: ctx.project.id })
    })

    const disposeEntry = Effect.fnUntraced(function* (directory: string, entry: Entry, ctx: InstanceContext) {
      if (cache.get(directory) !== entry) return false
      yield* disposeContext(ctx)
      if (cache.get(directory) !== entry) return false
      cache.delete(directory)
      return true
    })

    const closeEntry = Effect.fnUntraced(function* (
      directory: string,
      entry: Entry,
      options?: { idle?: boolean; replaced?: boolean },
    ) {
      if (entry.disposing) return yield* Deferred.await(entry.disposing)
      if (options?.idle && !stale(directory, entry)) return

      const disposing = Deferred.makeUnsafe<void>()
      entry.disposing = disposing
      const exit = yield* Effect.gen(function* () {
        const ctx = yield* Deferred.await(entry.deferred)
        if (options?.idle && !stale(directory, entry)) return
        if (options?.replaced) {
          yield* disposeContext(ctx)
          return
        }
        yield* disposeEntry(directory, entry, ctx).pipe(Effect.asVoid)
      }).pipe(Effect.exit)

      if (cache.get(directory) === entry) entry.disposing = undefined
      yield* Deferred.done(disposing, exit).pipe(Effect.asVoid)
      if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
    })

    const ensureEntry = Effect.fnUntraced(function* (
      directory: string,
      input: LoadInput,
      restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
    ) {
      const existing = cache.get(directory)
      if (existing?.disposing) {
        yield* restore(Deferred.await(existing.disposing))
        return yield* ensureEntry(directory, input, restore)
      }
      if (existing) {
        touch(existing)
        return existing
      }

      const entry = createEntry()
      cache.set(directory, entry)
      yield* Effect.gen(function* () {
        yield* Effect.logInfo("creating instance", { directory })
        yield* completeLoad(directory, input, entry)
      }).pipe(Effect.forkIn(scope, { startImmediately: true }))
      return entry
    })

    const useEntry = <A, E, R>(
      input: LoadInput,
      key: "active" | "hold",
      effect: (ctx: InstanceContext) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const entry = yield* ensureEntry(directory, input, restore)
          return yield* withCounter(
            entry,
            key,
            restore,
            Deferred.await(entry.deferred).pipe(Effect.flatMap((ctx) => effect(ctx))),
          )
        }),
      )
    }

    const sweepIdle = Effect.fnUntraced(function* () {
      const used = now()
      yield* Effect.forEach(
        [...cache.entries()].filter(([directory, entry]) => stale(directory, entry, used)),
        ([directory, entry]) =>
          closeEntry(directory, entry, { idle: true }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("idle instance dispose failed", { directory, cause }),
            ),
          ),
        { discard: true },
      )
    })

    yield* sweepIdle().pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(INSTANCE_SWEEP_MS))),
      Effect.catchCause((cause) => Effect.logWarning("instance idle sweep failed", { cause })),
      Effect.forkIn(scope, { startImmediately: true }),
    )

    const load = (input: LoadInput): Effect.Effect<InstanceContext> => {
      return useEntry(input, "active", (ctx) => Effect.succeed(ctx)).pipe(Effect.withSpan("InstanceStore.load"))
    }

    const reload = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const previous = cache.get(directory)
          if (previous?.disposing) yield* restore(Deferred.await(previous.disposing))
          const entry = createEntry()
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("reloading instance", { directory })
            if (previous) yield* closeEntry(directory, previous, { replaced: true }).pipe(Effect.ignore)
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* withCounter(entry, "active", restore, Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload"))
    }

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      const entry = cache.get(ctx.directory)
      if (!entry) return yield* disposeContext(ctx)

      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(ctx.directory, entry).pipe(Effect.asVoid)
      if (exit.value !== ctx) return
      yield* closeEntry(ctx.directory, entry).pipe(Effect.asVoid)
    })

    const disposeDirectory = Effect.fn("InstanceStore.disposeDirectory")(function* (input: string) {
      const directory = FSUtil.resolve(input)
      const entry = cache.get(directory)
      if (!entry) return
      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry).pipe(Effect.asVoid)
      yield* closeEntry(directory, entry).pipe(Effect.asVoid)
    })

    const disposeAllOnce = Effect.fnUntraced(function* () {
      yield* Effect.logInfo("disposing all instances")
      yield* Effect.forEach(
        [...cache.entries()],
        ([directory, entry]) =>
          Effect.gen(function* () {
            const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
            if (Exit.isFailure(exit)) {
              yield* Effect.logWarning("instance dispose failed", { key: directory, cause: exit.cause })
              yield* removeEntry(directory, entry)
              return
            }
            yield* closeEntry(directory, entry)
          }),
        { discard: true },
      )
    })

    const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      return yield* cachedDisposeAll
    })

    const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      useEntry(input, "active", (ctx) => effect.pipe(Effect.provideService(InstanceRef, ctx))).pipe(
        Effect.withSpan("InstanceStore.provide"),
      )

    const hold = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      useEntry(input, "hold", (ctx) => effect.pipe(Effect.provideService(InstanceRef, ctx))).pipe(
        Effect.withSpan("InstanceStore.hold"),
      )

    yield* Effect.addFinalizer(() => disposeAll().pipe(Effect.ignore))

    return Service.of({
      load,
      reload,
      dispose,
      disposeDirectory,
      disposeAll,
      hold,
      provide,
    })
  }),
)

export const bootstrapNode = LayerNode.unbound(InstanceBootstrap.Service, Node.tags.values.global)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Project.node, bootstrapNode],
})

export * as InstanceStore from "./instance-store"
