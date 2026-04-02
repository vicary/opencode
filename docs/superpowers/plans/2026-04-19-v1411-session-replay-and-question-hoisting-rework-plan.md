# v1.4.11 Session Replay and Question Hoisting Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the branch-carried fixes from `70ac2649b3bc97e5bf83f35cd7d817ee9a741657`, `65fbbf3e3e673d25487e4a42374787aff66a8927`, and `3199383eef4cc2ac4ca086f9485b071061dcff70` so they follow the `v1.4.11` architecture while preserving only their intended behavior.

**Architecture:** Use `v1.4.11` as the structural reference for replay serialization, question service behavior, and interrupted-session cleanup. Re-apply only the intended semantic deltas: omit pending tool stubs while preserving interrupted running tool recovery, hoist nested questions to the root session with valid Effect v4 error handling, and finalize interrupted tool-call turns through the canonical tool-result path so stale loading state clears after later turns.

**Tech Stack:** Bun, TypeScript, Effect v4, existing session/question services, embedded web UI build pipeline.

---

## File Map

- Modify: `packages/opencode/src/session/message-v2.ts`
  - Restore `v1.4.11` replay control flow and re-apply only the valid replay semantic delta from `70ac2649b3bc97e5bf83f35cd7d817ee9a741657`.
- Modify: `packages/opencode/test/session/message-v2.test.ts`
  - Keep replay regression tests focused on pending-vs-running behavior and the `v1.4.11` structure.
- Modify: `packages/opencode/src/question/index.ts`
  - Keep root-session hoisting in the question service while replacing broken Effect usage from `65fbbf3e3e673d25487e4a42374787aff66a8927` with valid Effect v4 composition.
- Modify: `packages/opencode/test/question/question.test.ts`
  - Add or update contract-level tests for child-session hoisting.
- Modify: `packages/opencode/src/session/prompt.ts`
  - Reintroduce the interrupted-tool finalization contract from `3199383eef4cc2ac4ca086f9485b071061dcff70` in the current `v1.4.11`-style loop/session lifecycle.
- Modify: `packages/opencode/src/session/processor.ts`
  - Only if required to preserve the canonical interrupted tool-result path used by the prompt cleanup logic.
- Modify: `packages/opencode/test/session/prompt-effect.test.ts`
  - Add or tighten interrupted-session cleanup coverage so later user turns clear stale loading state.
- Optional modify: `packages/opencode/test/session/processor-effect.test.ts`
  - Only if the canonical interrupted-tool path needs direct regression coverage here.

### Task 1: Rework Replay Serialization To v1.4.11 Shape

**Files:**
- Modify: `packages/opencode/test/session/message-v2.test.ts`
- Modify: `packages/opencode/src/session/message-v2.ts`

- [ ] **Step 1: Write the failing replay regression test around pending and running tool states**

Add or keep these assertions in `packages/opencode/test/session/message-v2.test.ts` near the existing replay tests:

```ts
test("omits pending tool-input stubs from replay context", async () => {
  const userID = "m-user"
  const assistantID = "m-assistant"

  const input: MessageV2.WithParts[] = [
    {
      info: userInfo(userID),
      parts: [{ ...basePart(userID, "u1"), type: "text", text: "run tool" }] as MessageV2.Part[],
    },
    {
      info: assistantInfo(assistantID, userID),
      parts: [
        {
          ...basePart(assistantID, "a1"),
          type: "tool",
          callID: "call-pending",
          tool: "write",
          state: { status: "pending", input: {}, raw: "" },
        },
      ] as MessageV2.Part[],
    },
  ]

  expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
    { role: "user", content: [{ type: "text", text: "run tool" }] },
  ])
})

test("converts interrupted running tool calls to error results", async () => {
  const userID = "m-user"
  const assistantID = "m-assistant"

  const input: MessageV2.WithParts[] = [
    {
      info: userInfo(userID),
      parts: [{ ...basePart(userID, "u1"), type: "text", text: "run tool" }] as MessageV2.Part[],
    },
    {
      info: assistantInfo(assistantID, userID),
      parts: [
        {
          ...basePart(assistantID, "a2"),
          type: "tool",
          callID: "call-running",
          tool: "read",
          state: { status: "running", input: { path: "/tmp" }, time: { start: 0 } },
        },
      ] as MessageV2.Part[],
    },
  ]

  expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
    { role: "user", content: [{ type: "text", text: "run tool" }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-running",
          toolName: "read",
          input: { path: "/tmp" },
          providerExecuted: undefined,
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-running",
          toolName: "read",
          output: { type: "error-text", value: "[Tool execution was interrupted]" },
        },
      ],
    },
  ])
})
```

- [ ] **Step 2: Run the replay tests to confirm the current file fails for the right reason**

Run:

```bash
bun test test/session/message-v2.test.ts
```

Expected: failure in replay serialization, likely due to duplicated assistant entries and/or dropped reasoning caused by the current control-flow nesting in `packages/opencode/src/session/message-v2.ts`.

- [ ] **Step 3: Restore the `v1.4.11` replay control-flow layout and re-apply only the intended semantic delta**

Update `packages/opencode/src/session/message-v2.ts` so the assistant replay block follows this shape:

```ts
for (const part of msg.parts) {
  if (part.type === "text")
    assistantMessage.parts.push({
      type: "text",
      text: part.text,
      ...(differentModel ? {} : { providerMetadata: part.metadata }),
    })

  if (part.type === "step-start")
    assistantMessage.parts.push({
      type: "step-start",
    })

  if (part.type === "tool") {
    toolNames.add(part.tool)

    if (part.state.status === "completed") {
      const outputText = part.state.time.compacted ? "[Old tool result content cleared]" : part.state.output
      const attachments = part.state.time.compacted || options?.stripMedia ? [] : (part.state.attachments ?? [])
      const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
      const nonMediaAttachments = attachments.filter((a) => !isMedia(a.mime))
      if (!supportsMediaInToolResults && mediaAttachments.length > 0) media.push(...mediaAttachments)
      const finalAttachments = supportsMediaInToolResults ? attachments : nonMediaAttachments
      const output = finalAttachments.length > 0 ? { text: outputText, attachments: finalAttachments } : outputText

      assistantMessage.parts.push({
        type: ("tool-" + part.tool) as `tool-${string}`,
        state: "output-available",
        toolCallId: part.callID,
        input: part.state.input,
        output,
        ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
        ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
      })
    }

    if (part.state.status === "error") {
      const output = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
      if (typeof output === "string") {
        assistantMessage.parts.push({
          type: ("tool-" + part.tool) as `tool-${string}`,
          state: "output-available",
          toolCallId: part.callID,
          input: part.state.input,
          output,
          ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
          ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
        })
      } else {
        assistantMessage.parts.push({
          type: ("tool-" + part.tool) as `tool-${string}`,
          state: "output-error",
          toolCallId: part.callID,
          input: part.state.input,
          errorText: part.state.error,
          ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
          ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
        })
      }
    }

    if (part.state.status === "running")
      assistantMessage.parts.push({
        type: ("tool-" + part.tool) as `tool-${string}`,
        state: "output-error",
        toolCallId: part.callID,
        input: part.state.input,
        errorText: "[Tool execution was interrupted]",
        ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
        ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
      })
  }

  if (part.type === "reasoning") {
    assistantMessage.parts.push({
      type: "reasoning",
      text: part.text,
      ...(differentModel ? {} : { providerMetadata: part.metadata }),
    })
  }
}

if (assistantMessage.parts.length > 0) {
  result.push(assistantMessage)
  if (media.length > 0) {
    result.push({
      id: MessageID.ascending(),
      role: "user",
      parts: [
        { type: "text" as const, text: SYNTHETIC_ATTACHMENT_PROMPT },
        ...media.map((attachment) => ({
          type: "file" as const,
          url: attachment.url,
          mediaType: attachment.mime,
        })),
      ],
    })
  }
}
```

Key constraints for this step:

- keep `pending` out of replay
- keep `running` as interrupted tool results
- keep `reasoning` outside the tool branch
- push the assistant message once per assistant turn, not once per part

- [ ] **Step 4: Run the replay tests again and confirm they pass**

Run:

```bash
bun test test/session/message-v2.test.ts
```

Expected: PASS with the pending/running replay tests green.

### Task 2: Rework Question Hoisting To Valid Effect v4 Composition

**Files:**
- Modify: `packages/opencode/test/question/question.test.ts`
- Modify: `packages/opencode/src/question/index.ts`

- [ ] **Step 1: Write the failing child-session hoisting test**

Add a root-session hoisting test to `packages/opencode/test/question/question.test.ts`:

```ts
test("ask - hoists nested session questions to the root session", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({ title: "root" })))
      const child = await AppRuntime.runPromise(
        Session.Service.use((svc) =>
          svc.create({
            title: "child",
            parentID: root.id,
          }),
        ),
      )

      const promise = ask({
        sessionID: child.id,
        questions: [
          {
            question: "Choose",
            header: "Choice",
            options: [{ label: "A", description: "Option A" }],
          },
        ],
      })

      const pending = await waitForPending(1)
      expect(pending[0].sessionID).toBe(root.id)

      await rejectAll()
      await promise.catch(() => {})
    },
  })
})
```

- [ ] **Step 2: Run the question tests to verify the current failure shape**

Run:

```bash
bun test test/question/question.test.ts
```

Expected: failure or runtime error caused by invalid Effect method-style error handling in `rootSessionID`.

- [ ] **Step 3: Replace the broken `rootSessionID` error handling with valid Effect v4 composition**

Update `packages/opencode/src/question/index.ts` so `rootSessionID` keeps the same contract but uses valid Effect operators:

```ts
const rootSessionID = Effect.fn("Question.rootSessionID")(function* (sessionID: SessionID): Effect.Effect<SessionID> {
  const sessions = yield* Session.Service
  const current = yield* Effect.catchAll(sessions.get(sessionID), () => Effect.succeed(undefined))
  if (!current?.parentID) return current?.id ?? sessionID
  return yield* rootSessionID(current.parentID)
})
```

Do not move hoisting out of the question service. Keep `ask()` storing and publishing the root-resolved `sessionID` exactly as it already does.

- [ ] **Step 4: Run the question tests and confirm the hoisting contract passes**

Run:

```bash
bun test test/question/question.test.ts
```

Expected: PASS with the new child-session hoisting coverage.

### Task 3: Rework Interrupted-Session Cleanup Through Canonical Tool Result Path

**Files:**
- Modify: `packages/opencode/test/session/prompt-effect.test.ts`
- Modify: `packages/opencode/src/session/prompt.ts`
- Modify if needed: `packages/opencode/src/session/processor.ts`
- Modify if needed: `packages/opencode/test/session/processor-effect.test.ts`

- [ ] **Step 1: Add the failing stale-loading regression test based on the canonical interrupted-tool cleanup contract**

Add a prompt-level regression in `packages/opencode/test/session/prompt-effect.test.ts` near the existing interrupted bash tests. The test should follow this shape:

```ts
unix(
  "later user turn finalizes prior interrupted tool-call turn so loading clears",
  () =>
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({
            title: "Interrupted session recovery",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "run bash" }],
          })

          yield* llm.tool("bash", {
            command: "trap '' TERM; sleep 30",
            description: "Block until interrupted",
            timeout: 30_000,
          })

          const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* llm.wait(1)
          yield* Effect.sleep(150)
          yield* prompt.cancel(chat.id)
          yield* Fiber.await(first)

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "continue" }],
          })

          yield* llm.text("done")
          const second = yield* prompt.loop({ sessionID: chat.id })
          expect(second.info.finish).toBe("stop")

          const last = yield* Session.lastAssistant(chat.id)
          expect(last?.info.finish).toBe("stop")
        }),
      { git: true, config: providerCfg },
    ),
  30_000,
)
```

The exact final assertions can use the package’s existing helpers, but the test must prove this contract: after an interrupted tool-call turn and a later user turn, the newer completed turn is no longer blocked by stale open tool-call state.

- [ ] **Step 2: Run the prompt effect tests to confirm the stale-loading regression fails**

Run:

```bash
bun test test/session/prompt-effect.test.ts
```

Expected: failure showing the earlier interrupted turn still strands the session in an effectively open `tool-calls` state.

- [ ] **Step 3: Rework the interrupted-session cleanup in the canonical prompt/processor path**

Update `packages/opencode/src/session/prompt.ts` and, only if needed, `packages/opencode/src/session/processor.ts` to preserve the contract from `3199383eef4cc2ac4ca086f9485b071061dcff70` on top of the current `v1.4.11` architecture.

Implementation constraints for this step:

- do not add a UI-only loading workaround
- do not mutate database state out-of-band
- keep interrupted-tool normalization on the canonical session/tool-result path
- preserve any interrupted output already captured under the upstream contract
- ensure a later user turn does not remain blocked by a prior interrupted `tool-calls` turn

Use the existing prompt loop boundary in `packages/opencode/src/session/prompt.ts` as the integration point, specifically the logic around:

```ts
const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
if (result === "stop") return "break" as const
```

The rework should make prior interrupted tool-call turns resolve into a canonical finalized state before later completion is evaluated as still loading.

- [ ] **Step 4: Run the prompt tests again and confirm interrupted-session cleanup passes**

Run:

```bash
bun test test/session/prompt-effect.test.ts
```

Expected: PASS, including the existing interrupted bash tests and the new later-user-turn stale-loading regression.

### Task 4: Package Verification And Embedded Web UI Build

**Files:**
- Modify if verification exposes required build fixes: contract-adjacent files from Tasks 1-3 only

- [ ] **Step 1: Run targeted package verification before the binary build**

Run:

```bash
bun test test/session/message-v2.test.ts && bun test test/question/question.test.ts && bun test test/session/prompt-effect.test.ts
```

Expected: all targeted tests PASS.

- [ ] **Step 2: Run package typecheck**

Run:

```bash
bun typecheck
```

Workdir: `packages/opencode`

Expected: PASS. If unrelated existing failures remain, stop and isolate whether the rework introduced any new ones before proceeding.

- [ ] **Step 3: Build the CLI binary with embedded web UI enabled**

Run:

```bash
OPENCODE_CHANNEL=latest OPENCODE_VERSION=1.4.12-preview.202604191200 bun run build --single
```

Workdir: `packages/opencode`

Expected: PASS. Do not use `--skip-embed-web-ui`.

- [ ] **Step 4: Verify the installed binary version**

Run:

```bash
~/.opencode/bin/opencode --version
```

Expected: `1.4.12-preview.202604191200`

- [ ] **Step 5: Verify the shared DB path contract**

Run:

```bash
~/.opencode/bin/opencode --print-logs stats
```

Expected: log output contains `service=db path=.../opencode.db opening database` and does not use a channel-specific DB filename.

## Self-Review

- Spec coverage:
  - replay rework is covered by Task 1
  - question hoisting rework is covered by Task 2
  - interrupted-session cleanup rework is covered by Task 3
  - embedded-web-ui build and binary verification are covered by Task 4
- Placeholder scan: no `TBD`, `TODO`, or deferred implementation placeholders remain.
- Type consistency:
  - replay uses existing `MessageV2` test helpers and tool state types
  - question hoisting uses the existing `Question.Service` and `Session.Service` contracts
  - prompt cleanup work stays at the current session/prompt lifecycle boundary rather than inventing new public APIs

Plan complete and saved to `docs/superpowers/plans/2026-04-19-v1411-session-replay-and-question-hoisting-rework-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
