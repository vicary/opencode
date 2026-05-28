import { GlobalBus } from "@/bus/global"
import { serviceUse } from "@/effect/service-use"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Schedule, Scope } from "effect"
import { type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import * as Project from "./project"

export const INSTANCE_IDLE_MS = 300_000
export const INSTANCE_SWEEP_MS = 30_000

export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
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

export const layer: Layer.Layer<Service, never, Project.Service | InstanceBootstrap.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const scope = yield* Scope.Scope
    const cache = new Map<string, Entry>()

    const now = () => Date.now()

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

    const stale = (directory: string, entry: Entry, time = now()) =>
      cache.get(directory) === entry && entry.active === 0 && entry.hold === 0 && time - entry.used >= INSTANCE_IDLE_MS

    const awaitEntry = (entry: Entry, restore: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        entry.used = now()
        entry.active += 1
        return yield* restore(Deferred.await(entry.deferred)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.used = now()
              entry.active -= 1
            }),
          ),
        )
      })

    const holdEntry = <A, E, R>(entry: Entry, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        entry.used = now()
        entry.hold += 1
        return yield* effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.used = now()
              entry.hold -= 1
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

    const closeEntry = Effect.fnUntraced(function* (directory: string, entry: Entry, idle = false) {
      if (entry.disposing) return yield* Deferred.await(entry.disposing)
      if (idle && !stale(directory, entry)) return

      const disposing = Deferred.makeUnsafe<void>()
      entry.disposing = disposing
      const exit = yield* Effect.gen(function* () {
        const ctx = yield* Deferred.await(entry.deferred)
        if (idle && !stale(directory, entry)) return
        yield* disposeEntry(directory, entry, ctx).pipe(Effect.asVoid)
      }).pipe(Effect.exit)

      if (cache.get(directory) === entry) entry.disposing = undefined
      yield* Deferred.done(disposing, exit).pipe(Effect.asVoid)
      if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
    })

    const sweepIdle = Effect.fnUntraced(function* () {
      const time = now()
      yield* Effect.forEach(
        [...cache.entries()].filter(([directory, entry]) => stale(directory, entry, time)),
        ([directory, entry]) =>
          closeEntry(directory, entry, true).pipe(
            Effect.catchCause((cause) => Effect.logWarning("idle instance dispose failed", { directory, cause })),
          ),
        { discard: true },
      )
    })

    const idleFiber = yield* sweepIdle().pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(INSTANCE_SWEEP_MS))),
      Effect.forkScoped,
    )
    yield* Effect.addFinalizer(() => Fiber.interrupt(idleFiber).pipe(Effect.ignore))

    const load = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = AppFileSystem.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const existing = cache.get(directory)
          if (existing?.disposing) {
            yield* Deferred.await(existing.disposing)
            return yield* load(input)
          }
          if (existing) return yield* awaitEntry(existing, restore)

          const entry: Entry = createEntry()
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("creating instance", { directory })
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* awaitEntry(entry, restore)
        }),
      ).pipe(Effect.withSpan("InstanceStore.load"))
    }

    const reload = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = AppFileSystem.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const previous = cache.get(directory)
          if (previous) yield* closeEntry(directory, previous).pipe(Effect.ignore)
          const entry: Entry = createEntry()
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("reloading instance", { directory })
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload"))
    }

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      const entry = cache.get(ctx.directory)
      if (!entry) return yield* disposeContext(ctx)

      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(ctx.directory, entry).pipe(Effect.asVoid)
      if (exit.value !== ctx) return
      yield* closeEntry(ctx.directory, entry)
    })

    const disposeAllOnce = Effect.fnUntraced(function* () {
      yield* Effect.logInfo("disposing all instances")
      yield* Effect.forEach(
        [...cache.entries()],
        (item) =>
          Effect.gen(function* () {
            const exit = yield* Deferred.await(item[1].deferred).pipe(Effect.exit)
            if (Exit.isFailure(exit)) {
              yield* Effect.logWarning("instance dispose failed", { key: item[0], cause: exit.cause })
              yield* removeEntry(item[0], item[1])
              return
            }
            yield* closeEntry(item[0], item[1])
          }),
        { discard: true },
      )
    })

    const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      return yield* cachedDisposeAll
    })

    const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      load(input).pipe(Effect.flatMap((ctx) => effect.pipe(Effect.provideService(InstanceRef, ctx))))

    const hold = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
      const directory = AppFileSystem.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const entry = cache.get(directory)
          if (!entry) {
            return yield* load(input).pipe(
              Effect.flatMap((ctx) =>
                hold({ ...input, directory }, effect).pipe(Effect.provideService(InstanceRef, ctx)),
              ),
            )
          }
          if (entry.disposing) {
            yield* Deferred.await(entry.disposing)
            return yield* hold(input, effect)
          }
          const ctx = yield* restore(Deferred.await(entry.deferred))
          return yield* holdEntry(entry, effect.pipe(Effect.provideService(InstanceRef, ctx)))
        }),
      ).pipe(Effect.withSpan("InstanceStore.hold"))
    }

    yield* Effect.addFinalizer(() => disposeAll().pipe(Effect.ignore))

    return Service.of({
      load,
      reload,
      dispose,
      disposeAll,
      hold,
      provide,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Project.defaultLayer))

export * as InstanceStore from "./instance-store"
