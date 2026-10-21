/**
 * 给打包用的 DSH 运行时补 ACP 方法。
 *
 * 目前补两个：
 *   - `session/steer`：把消息插到当前回合的下一步边界（不打断）；
 *   - `session/compact`：手动压缩，走 DSH 的 compaction 服务。
 *
 * 每条补丁各自检查标记、各自幂等；缺哪条补哪条。修改的是 vendor 副本，
 * `npm run pack:release` 之前跑一次；重装依赖后也要重跑。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const pnpmRoot = path.resolve(__dirname, '..', 'reference', 'dsh-runtime', 'node_modules', '.pnpm')

function findAcpIndex() {
  if (!fs.existsSync(pnpmRoot)) return null
  for (const name of fs.readdirSync(pnpmRoot)) {
    if (!name.startsWith('@deepseek-ai+dsh-acp@')) continue
    const file = path.join(pnpmRoot, name, 'node_modules', '@deepseek-ai', 'dsh-acp', 'lib', 'index.js')
    if (fs.existsSync(file)) return file
  }
  return null
}

const file = findAcpIndex()
if (!file) {
  console.error('找不到 dsh-acp 的 index.js；确认 reference/dsh-runtime 已安装。')
  process.exit(1)
}

/** 补丁清单：给构建记录和文档用，`--list` 直接打印。 */
const PATCH_INDEX = [
  { id: 'session/steer', marker: 'async steer(params, imageEnabled)', description: '把消息插到当前回合的下一步（原生插队）' },
  { id: 'session/compact', marker: 'async compact(params, signal)', description: '手动压缩，走 compaction.compactNow' },
  { id: 'session/answer', marker: 'this.ctx.get("userQuestions")', description: '提问作答，把答案批次交给 user-questions 服务' },
  { id: 'session/plan', marker: 'async setPlan(params)', description: '计划模式开关，交给 DSH 的 planMode 服务' },
  { id: 'user-questions-answerer', marker: 'async askHost(request)', description: '服务级提问转给宿主面板（退出计划模式等）' },
  { id: 'subagent-bridge', marker: 'subagentCalls', description: '把子会话的工具事件转发给父会话，带 parentCallId' }
]

if (process.argv.includes('--list')) {
  console.log(JSON.stringify(PATCH_INDEX, null, 2))
  process.exit(0)
}

let source = fs.readFileSync(file, 'utf8')
const changes = []

function apply(label, marker, from, to) {
  if (source.includes(marker)) {
    changes.push(`${label}: 已存在`)
    return
  }
  if (!source.includes(from)) {
    console.error(`补丁锚点不存在（${label}），DSH 版本可能变了。`)
    process.exit(1)
  }
  source = source.replace(from, to)
  changes.push(`${label}: 已应用`)
}

// ---- session/steer ----
const steerMethod = `\t/**
\t* Admit a mid-turn steer message and splice it into the running loop's next
\t* step, the same boundary Claude's priority-'next' messages use.
\t*/
\tasync steer(params, imageEnabled) {
\t\tthis.assertActive();
\t\tconst admissionController = new AbortController();
\t\tlet content;
\t\ttry {
\t\t\tcontent = await admitAcpPrompt(this.ctx, this.modelControl.snapshot(), params.prompt, imageEnabled, admissionController.signal);
\t\t} catch (error) {
\t\t\tif (error instanceof AcpContentError) throw error.kind === "invalid" ? invalidParams$1(error.message) : internalError$1(error.message);
\t\t\tthrow error;
\t\t}
\t\tconst message = createUserMessage({
\t\t\tcontent,
\t\t\tsource: { kind: "user" }
\t\t});
\t\tconst selection = this.modelControl.snapshot();
\t\tif (selection !== void 0) this.pendingSelections.set(message.id, selection);
\t\ttry {
\t\t\tthis.agent.steer(message);
\t\t} catch (error) {
\t\t\tthis.pendingSelections.delete(message.id);
\t\t\tthrow internalError$1(\`steer was not queued: \${errorChain(error)}\`);
\t\t}
\t\treturn { queued: true, messageId: message.id };
\t}
`

// ---- session/compact ----
const compactMethod = `\t/** Manual compaction through the backend-independent compaction seam. */
\tasync compact(params, signal) {
\t\tthis.assertActive();
\t\tconst compaction = this.ctx.get("compaction");
\t\tif (compaction === void 0) throw internalError$1("compaction service is unavailable");
\t\ttry {
\t\t\tconst result = await compaction.compactNow(this.agent, signal, randomUUID());
\t\t\treturn { shadowed: result.shadowedSeqs.length, tokens: result.shadowedTokenCount };
\t\t} catch (error) {
\t\t\tthrow internalError$1(\`manual compaction failed: \${errorChain(error)}\`);
\t\t}
\t}
`

// ---- session/answer ----
const answerMethod = `\t/** Deliver one answer batch to the user-questions service. */
\tasync answer(params) {
\t\tthis.assertActive();
\t\tconst service = this.ctx.get("userQuestions");
\t\tif (service === void 0) throw internalError$1("user-questions service is unavailable");
\t\ttry {
\t\t\treturn { accepted: service.answer(this.agent, params.callId, { answers: params.answers }) };
\t\t} catch (error) {
\t\t\tthrow internalError$1(\`answer was not accepted: \${errorChain(error)}\`);
\t\t}
\t}
`

apply(
  'AcpSession.steer',
  'async steer(params, imageEnabled) {',
  '\tasync prompt(params, imageEnabled, requestSignal) {',
  `${steerMethod}\tasync prompt(params, imageEnabled, requestSignal) {`
)
apply(
  'AcpSession.compact',
  'async compact(params, signal) {',
  '\tasync steer(params, imageEnabled) {',
  `${compactMethod}\tasync steer(params, imageEnabled) {`
)
apply(
  'AcpSession.answer',
  'this.ctx.get("userQuestions")',
  '\tasync compact(params, signal) {',
  `${answerMethod}\tasync compact(params, signal) {`
)

const implementationFrom = `\t\tasync prompt(params, requestSignal) {
\t\t\tassertOpen();
\t\t\treturn requireSession(brandString(params.sessionId)).prompt(params, imagePromptEnabled, requestSignal);
\t\t},`

if (!source.includes('return requireSession(brandString(params.sessionId)).steer(params, imagePromptEnabled);')) {
  if (!source.includes(implementationFrom)) {
    console.error('补丁锚点不存在（implementation），DSH 版本可能变了。')
    process.exit(1)
  }
  source = source.replace(implementationFrom, `${implementationFrom}
\t\tasync steer(params) {
\t\t\tassertOpen();
\t\t\treturn requireSession(brandString(params.sessionId)).steer(params, imagePromptEnabled);
\t\t},`)
  changes.push('implementation.steer: 已应用')
} else {
  changes.push('implementation.steer: 已存在')
}

const steerImplAnchor = `\t\tasync steer(params) {
\t\t\tassertOpen();
\t\t\treturn requireSession(brandString(params.sessionId)).steer(params, imagePromptEnabled);
\t\t},`
if (!source.includes('return requireSession(brandString(params.sessionId)).compact(params, signal);')) {
  if (!source.includes(steerImplAnchor)) {
    console.error('补丁锚点不存在（implementation.compact），DSH 版本可能变了。')
    process.exit(1)
  }
  source = source.replace(steerImplAnchor, `${steerImplAnchor}
\t\tasync compact(params, signal) {
\t\t\tassertOpen();
\t\t\treturn requireSession(brandString(params.sessionId)).compact(params, signal);
\t\t},`)
  changes.push('implementation.compact: 已应用')
} else {
  changes.push('implementation.compact: 已存在')
}

const compactImplAnchor = `\t\tasync compact(params, signal) {
\t\t\tassertOpen();
\t\t\treturn requireSession(brandString(params.sessionId)).compact(params, signal);
\t\t},`
if (!source.includes('return requireSession(brandString(params.sessionId)).answer(params);')) {
  if (!source.includes(compactImplAnchor)) {
    console.error('补丁锚点不存在（implementation.answer），DSH 版本可能变了。')
    process.exit(1)
  }
  source = source.replace(compactImplAnchor, `${compactImplAnchor}
\t\tasync answer(params) {
\t\t\tassertOpen();
\t\t\treturn requireSession(brandString(params.sessionId)).answer(params);
\t\t},`)
  changes.push('implementation.answer: 已应用')
} else {
  changes.push('implementation.answer: 已存在')
}

const anchorSteerRequest = '.onRequest("session/steer", (value) => value, ({ params }) => implementation.steer(params))'
apply(
  'session/compact 注册',
  'session/compact',
  anchorSteerRequest,
  `${anchorSteerRequest}.onRequest("session/compact", (value) => value, ({ params, signal }) => implementation.compact(params, signal))`
)

const anchorCompactRequest = '.onRequest("session/compact", (value) => value, ({ params, signal }) => implementation.compact(params, signal))'
const anchorAnswerRequest = `${anchorCompactRequest}.onRequest("session/answer", (value) => value, ({ params }) => implementation.answer(params))`
const answerImplAnchor = `\t\tasync answer(params) {
\t\t\tassertOpen();
\t\t\treturn requireSession(brandString(params.sessionId)).answer(params);
\t\t},`
if (!source.includes('return requireSession(brandString(params.sessionId)).setPlan(params);')) {
  if (!source.includes(answerImplAnchor)) {
    console.error('补丁锚点不存在（implementation.setPlan），DSH 版本可能变了。')
    process.exit(1)
  }
  source = source.replace(answerImplAnchor, `${answerImplAnchor}
\t\tasync setPlan(params) {
\t\t\tassertOpen();
\t\t\treturn requireSession(brandString(params.sessionId)).setPlan(params);
\t\t},`)
  changes.push('implementation.setPlan: 已应用')
} else {
  changes.push('implementation.setPlan: 已存在')
}

apply(
  'session/plan 注册',
  'session/plan',
  anchorAnswerRequest,
  `${anchorAnswerRequest}.onRequest("session/plan", (value) => value, ({ params }) => implementation.setPlan(params))`
)

// ---- session/question：user-questions 的宿主应答通道 ----
const hostAskMethod = `\t/** 把 user-questions 的提问交给 ACP 客户端并等待答案。 */
\tasync askHost(request) {
\t\tif (typeof this.requestHost !== "function") throw internalError$1("no ACP question channel");
\t\tconst questions = request.questions.map((question) => ({
\t\t\tid: question.id,
\t\t\tquestion: question.question,
\t\t\t...question.header === void 0 ? {} : { header: question.header },
\t\t\t...question.options === void 0 ? {} : { options: question.options },
\t\t\t...question.multiSelect === void 0 ? {} : { multiSelect: question.multiSelect }
\t\t}));
\t\tconst result = await this.requestHost({ method: "session/question", params: { sessionId: this.agent.session.id, questions } });
\t\treturn { answers: result.answers };
\t}
`

apply(
  'AcpSession.askHost',
  'async askHost(request)',
  '\tasync answer(params) {',
  `${hostAskMethod}\tasync answer(params) {`
)

// ---- session/plan：把宿主的计划模式开关交给 DSH 的 planMode 服务 ----
const planMethod = `\t/** 宿主的计划模式开关：交给 DSH 的 planMode 服务，下一步生效。 */
\tasync setPlan(params) {
\t\tthis.assertActive();
\t\tconst plan = this.ctx.get("planMode");
\t\tif (plan === void 0) throw internalError$1("plan mode service is unavailable");
\t\tplan.set(this.agent, params.active === true);
\t\treturn { active: params.active === true };
\t}
`

apply(
  'AcpSession.setPlan',
  'async setPlan(params)',
  '\tasync askHost(request) {',
  `${planMethod}\tasync askHost(request) {`
)

// 全局应答者：只接本 ACP 会话自己的 agent，其余交给下一个。
const answerer = `\tctx.on("user-questions/request", (request, next) => {
\t\tconst agent = request.agent;
\t\tconst record = agent === void 0 ? void 0 : ownedRecord(agent);
\t\tif (record === void 0) return next();
\t\treturn record.askHost(request);
\t});
`
apply(
  'user-questions 应答者',
  'user-questions/request',
  '\tctx.on("session/event", (session, event) => {',
  `${answerer}\tctx.on("session/event", (session, event) => {`
)

// 每个会话拿到的 server→client 请求通道。
if (!source.includes('record.requestHost = (payload)')) {
  const setAnchor = '\t\t\tsessions.set(sessionId, record);'
  if (!source.includes(setAnchor)) {
    console.error('补丁锚点不存在（requestHost），DSH 版本可能变了。')
    process.exit(1)
  }
  source = source.replaceAll(setAnchor, `${setAnchor}
\t\t\trecord.requestHost = (payload) => conn.request(payload.method, payload.params);`)
  changes.push('requestHost: 已应用')
} else {
  changes.push('requestHost: 已存在')
}

// ---- 子代理事件桥：把子会话里的工具调用转发给父会话，带 parentCallId ----
const subagentBridge = `\tconst subagentCalls = /* @__PURE__ */ new Map();
\tconst acpRecordFor = (sessionId) => {
\t\tfor (const record of sessions.values()) if (record.agent.session.id === sessionId) return record;
\t\treturn void 0;
\t};
\tctx.on("session/event", (session, event) => {
\t\tconst owner = acpRecordFor(session.header.id);
\t\tif (owner !== void 0) {
\t\t\tif (event.type === "user/message") {\n\t\t\t\tconst echoed = event.data.message?.id;\n\t\t\t\tif (echoed !== void 0) void notify({\n\t\t\t\t\tsessionId: session.header.id,\n\t\t\t\t\tupdate: { sessionUpdate: "user_message", messageId: echoed }\n\t\t\t\t});\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tif (event.type === "tool/call" && /^subagent/u.test(String(event.data.name ?? ""))) {
\t\t\t\tconst list = subagentCalls.get(session.header.id) ?? [];
\t\t\t\tlist.push(event.data.callId);
\t\t\t\tsubagentCalls.set(session.header.id, list);
\t\t\t} else if (event.type === "tool/result") {
\t\t\t\tconst list = subagentCalls.get(session.header.id);
\t\t\t\tconst id = event.data.message?.toolCallId ?? event.data.callId;
\t\t\t\tif (list !== void 0) {
\t\t\t\t\tconst index = list.indexOf(id);
\t\t\t\t\tif (index >= 0) list.splice(index, 1);
\t\t\t\t}
\t\t\t}
\t\t\treturn;
\t\t}
\t\tconst parentId = session.header.parentSession;
\t\tif (parentId === void 0 || acpRecordFor(parentId) === void 0) return;
\t\tif (event.type !== "tool/call" && event.type !== "tool/result") return;
\t\tconst list = subagentCalls.get(parentId) ?? [];
\t\tconst data = event.data;
\t\tvoid notify({
\t\t\tsessionId: parentId,
\t\t\tupdate: {
\t\t\t\tsessionUpdate: "subagent_event",
\t\t\t\tchildId: session.header.id,
\t\t\t\tparentCallId: list[list.length - 1],
\t\t\t\tphase: event.type === "tool/call" ? "start" : "result",
\t\t\t\tcallId: event.type === "tool/call" ? data.callId : data.message?.toolCallId ?? data.callId,
\t\t\t\ttoolName: event.type === "tool/call" ? String(data.name ?? "工具") : void 0,
\t\t\t\tinput: event.type === "tool/call" ? data.arguments : void 0,
\t\t\t\toutput: event.type === "tool/result" ? data.message?.content : void 0,
\t\t\t\tisError: event.type === "tool/result" ? data.message?.isError === true : false
\t\t\t}
\t\t});
\t});
`
apply(
  '子代理事件桥',
  'subagentCalls',
  '\tctx.on("session/event", (session, event) => {',
  `${subagentBridge}\tctx.on("session/event", (session, event) => {`
)

// ---- 思考流式：把 DSH 的 reasoning-delta 直接转发，而不是等消息提交后发整段 ----
const streamListener = `	ctx.on("agent/assistant-stream", (payload) => {
		const record = payload.agent === void 0 ? void 0 : ownedRecord(payload.agent);
		if (record === void 0) return;
		const frame = payload.frame;
		if (frame === void 0 || frame.type !== "chunk") return;
		const chunk = frame.chunk;
		if (chunk === void 0 || typeof chunk.text !== "string" || chunk.text.length === 0) return;
		const update = chunk.type === "reasoning-delta"
			? { sessionUpdate: "agent_thought_chunk", messageId: frame.attemptId, content: { type: "text", text: chunk.text } }
			: chunk.type === "text-delta"
				? { sessionUpdate: "agent_message_chunk", messageId: frame.attemptId, content: { type: "text", text: chunk.text } }
				: void 0;
		if (update === void 0) return;
		void notify({ sessionId: record.agent.session.id, update });
	});
`
apply(
  'ACP.assistant-stream',
  '"agent/assistant-stream"',
  '\tctx.on("session/event", (session, event) => {',
  `${streamListener}\tctx.on("session/event", (session, event) => {`
)

// 提交后的整段 reasoning 不再重复发：流式已经逐段送过了。
if (!source.includes('if (block.type === "reasoning") continue;')) {
  const reasoningStart = source.indexOf('if (block.type === "reasoning") {')
  const reasoningEnd = reasoningStart < 0 ? -1 : source.indexOf('\t\t\tcontinue;\n\t\t}', reasoningStart)
  if (reasoningStart < 0 || reasoningEnd < 0) {
    console.error('补丁锚点不存在（reasoning 去重），DSH 版本可能变了。')
    process.exit(1)
  }
  const tail = '\t\t\tcontinue;\n\t\t}'
  source = `${source.slice(0, reasoningStart)}if (block.type === "reasoning") continue;${source.slice(reasoningEnd + tail.length)}`
  changes.push('reasoning 去重: 已应用')
} else {
  changes.push('reasoning 去重: 已存在')
}

if (!source.includes('if (block.type === "text") continue;')) {
  const textAnchor = '\t\tconst content = await assistantBlockToAcp(ctx, block);'
  if (!source.includes(textAnchor)) {
    console.error('补丁锚点不存在（正文去重），DSH 版本可能变了。')
    process.exit(1)
  }
  source = source.replace(textAnchor, `\t\tif (block.type === "text") continue;\n${textAnchor}`)
  changes.push('正文去重: 已应用')
} else {
  changes.push('正文去重: 已存在')
}

// agent-loop 的流事件要带上是哪个 agent，ACP 才能路由到会话。
{
  const loopDir = fs.readdirSync(pnpmRoot).find((name) => name.startsWith('@deepseek-ai+dsh-agent-loop'))
  if (!loopDir) {
    console.error('找不到 dsh-agent-loop，思考流式补丁无法应用。')
    process.exit(1)
  }
  const loopFile = path.join(pnpmRoot, loopDir, 'node_modules', '@deepseek-ai', 'dsh-agent-loop', 'lib', 'index.js')
  let loopSource = fs.readFileSync(loopFile, 'utf8')
  const emitAnchor = 'this.dispatch.emit("agent/assistant-stream", { frame });'
  if (!loopSource.includes('{ agent: this, frame }')) {
    if (!loopSource.includes(emitAnchor)) {
      console.error('补丁锚点不存在（agent-loop assistant-stream），DSH 版本可能变了。')
      process.exit(1)
    }
    loopSource = loopSource.replace(emitAnchor, 'this.dispatch.emit("agent/assistant-stream", { agent: this, frame });')
    fs.writeFileSync(loopFile, loopSource, 'utf8')
    changes.push('agent-loop 流事件带 agent: 已应用')
  } else {
    changes.push('agent-loop 流事件带 agent: 已存在')
  }
}

// ---- 编辑守卫放宽：没读过也能改（编辑时仍会读当前内容），读过的仍做版本校验 ----
{
  const policyFile = (() => {
    const dir = fs.readdirSync(pnpmRoot).find((name) => name.startsWith('@deepseek-ai+dsh-fs-observa'))
    if (!dir) return null
    return path.join(pnpmRoot, dir, 'node_modules', '@deepseek-ai', 'dsh-fs-observation-policy', 'lib', 'index.js')
  })()
  if (!policyFile) {
    console.error('找不到 dsh-fs-observation-policy，编辑守卫补丁无法应用。')
    process.exit(1)
  }
  let policy = fs.readFileSync(policyFile, 'utf8')
  const guard = 'if (!owner || prior === void 0) throw new FsError(`edit requires reading "${target.displayPath}" first`, "FS_NOT_OBSERVED");'
  if (policy.includes(guard)) {
    policy = policy.replace(guard, 'if (!owner || prior === void 0) return;')
    fs.writeFileSync(policyFile, policy, 'utf8')
    changes.push('编辑未读放行: 已应用')
  } else if (policy.includes('if (!owner || prior === void 0) return;')) {
    changes.push('编辑未读放行: 已存在')
  } else {
    console.error('补丁锚点不存在（fs-observation-policy），DSH 版本可能变了。')
    process.exit(1)
  }
}

// ---- 图片能力防回归校验 ----
// 历史上这里有两个“放行”补丁：把 dsh-llm 的图片投影和 dsh-tool-fs 的 read_image 能力判断
// 改成 `if (false)`。结果图片原样进入 DeepSeek 适配器，模型目录里又没有实际请求的
// `deepseek-v4-flash`，prepareImages() 每轮都抛 UNSUPPORTED_CONTENT，整个会话无法回复。
// 这两道防护是文本模型的唯一安全网，运行时必须保持原样；这里不再改代码，只在打包前校验。
{
  const llmDir = fs.readdirSync(pnpmRoot).find((name) => name.startsWith('@deepseek-ai+dsh-llm@'))
  if (!llmDir) {
    console.error('找不到 dsh-llm，图片投影防护无法校验。')
    process.exit(1)
  }
  const llmFile = path.join(pnpmRoot, llmDir, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')
  const llm = fs.readFileSync(llmFile, 'utf8')
  const llmGuard = 'if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image") && projectedMessages.some((message) => contentHasImage(message.content))) projectedMessages = projectImagesForTextModel(projectedMessages);'
  if (llm.includes('if (false && projectedMessages')) {
    console.error('dsh-llm 图片投影防护被放行补丁改坏（if (false ...)）；请恢复原始判断后再打包。')
    process.exit(1)
  }
  if (!llm.includes(llmGuard)) {
    console.error('dsh-llm 图片投影防护不是预期原文，DSH 版本可能变了；请人工核对后再打包。')
    process.exit(1)
  }
  changes.push('dsh-llm 图片投影防护: 完好')
}

{
  const toolFsDir = fs.readdirSync(pnpmRoot).find((name) => name.startsWith('@deepseek-ai+dsh-tool-fs@'))
  if (!toolFsDir) {
    console.error('找不到 dsh-tool-fs，读图能力防护无法校验。')
    process.exit(1)
  }
  const toolFsFile = path.join(pnpmRoot, toolFsDir, 'node_modules', '@deepseek-ai', 'dsh-tool-fs', 'lib', 'index.js')
  const toolFs = fs.readFileSync(toolFsFile, 'utf8')
  const fsGuard = 'if (active.inputModalities === void 0 || !active.inputModalities.includes("image")) throw new Error(`cannot read'
  if (toolFs.includes('if (false) throw new Error(`cannot read')) {
    console.error('dsh-tool-fs 读图能力防护被放行补丁改坏（if (false) throw ...）；请恢复原始判断后再打包。')
    process.exit(1)
  }
  if (!toolFs.includes(fsGuard)) {
    console.error('dsh-tool-fs 读图能力防护不是预期原文，DSH 版本可能变了；请人工核对后再打包。')
    process.exit(1)
  }
  changes.push('dsh-tool-fs 读图能力防护: 完好')
}

fs.writeFileSync(file, source, 'utf8')
console.log(`补丁结果（${file}）：`)
for (const line of changes) console.log(`  - ${line}`)
