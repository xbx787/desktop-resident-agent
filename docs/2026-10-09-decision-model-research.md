# 小鲸本地决策模型调研

日期：2026-10-09。范围：中文/英文输入的任务意图、回复语气线索与模型路由。只调研，不表示模型已安装或功能已接入。

## 结论

- 用户提到的「jev」确认为 TypeSafe AI 的 **Jev**。它接受 `state` 和有界问题，返回 `choice`、`score` 或 `noul` 等结构化判断；官方公开入口是托管 API，未提供可核实的本地权重。[TypeSafe 官方介绍](https://docs.typesafe.ai/introduction)、[发布说明](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- **Laya** 是形式最接近、可本地运行的开权重候选；代码和权重标注 Apache-2.0，提供多语言检查点。但“Laya 性能比 Jev 更好”不成立为通用结论：不同任务、检查点和测试协议下胜负相反。[Laya 仓库](https://github.com/NandhaKishorM/laya)、[权重许可](https://huggingface.co/convaiinnovations/laya)、[独立配对评测](https://arxiv.org/abs/2610.02267)
- 当前应先用**确定性规则与现有主模型**形成基线，再比较 Laya 与一个在本项目标注样本上训练的小分类器。无论选哪个模型，任务运行状态直接来自事件，权限和高代价操作由程序控制。

## 候选与本机开销

| 候选 | 可用性与许可 | 适合小鲸的部分 | Windows 本地成本与局限 |
| --- | --- | --- | --- |
| Jev | TypeSafe 托管 API；没有公开可下载的 Jev 权重。[官方文档](https://docs.typesafe.ai/introduction) | 作为结构化判断接口和远程对照对象 | 不能满足离线、本地处理私人桌面文本；调用成本和延迟随服务与网络变化。官方发布时标价输入 $0.042/百万 token，并称端到端 70–500 ms；均非本机数据。[发布说明](https://typesafe.ai/blog/introducing-system-one-models-and-jev) |
| Laya `multilingual` | 约 322M 参数，Apache-2.0；[模型目录](https://huggingface.co/convaiinnovations/laya/tree/main/multilingual)约 678 MB，其中权重约 644 MB；支持 Windows PowerShell 安装、PyTorch CPU/CUDA，也有 ONNX 路线。[仓库安装说明](https://github.com/NandhaKishorM/laya) | 试验少量固定类别的中文意图、语气线索、是否需要澄清；保留本地推理 | 322M 参数仅按 fp32 权重估算约 1.2 GiB 内存，实际还需运行时、缓存和进程开销；CUDA 用量、冷启动与 CPU 延迟必须本机测。默认长输入截断，选项多时挤占输入预算。[仓库限制](https://github.com/NandhaKishorM/laya#honest-limits) |
| SetFit + 多语言 MiniLM | [SetFit](https://github.com/huggingface/setfit) 与 [MiniLM 权重](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2)均标 Apache-2.0；MiniLM 约 0.1B 参数，单个 safetensors 文件约 471 MB。[文件目录](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/tree/main) | 用少量**本项目人工标注**的中文任务/语气样本训练专用分类器，作为可复现的本地对照 | 需要维护标签数据和再训练；原模型是句向量模型，不是现成的 Jev 式决策器。模型卡默认最大 128 token，长对话应先抽取当前请求。[SetFit 文档](https://huggingface.co/docs/setfit/index)、[模型卡](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2) |

本机只读盘点：i7-13650HX、约 15.7 GiB RAM、RTX 4060 Laptop 8 GiB VRAM。单个 Laya 多语言检查点值得做隔离试验，但不能据参数量宣称它已能与现有服务、游戏或创作软件长期共存。没有安装模型、下载权重或跑本机基准。

## 质量证据如何读

1. Laya 作者报告：AG News 四分类 `0.950`（英文基础版）、DAIR Emotion 六分类 `0.595`（英文基础版），而其引用的 Jev 已发表数字为 `0.910`、`0.480`；样本/提示词没有统一配对，不能直接判定普遍优势。`typed-decisions` 的 `0.766` 使用在该任务训练集微调的专用检查点；未微调基础版 `0.362`，多语言版 `0.352`，且 Jev 在该任务概率分布拟合更好。[Laya 基准、方法和限制](https://github.com/NandhaKishorM/laya/blob/main/BENCHMARKS.md)
2. 一篇 **2026-10-01 arXiv 预印本**用相同输入配对比较 Laya 0.3.21 与 Jev 1.13.0：11 类 agent 决策中 Jev 9 类准确率显著更高；零样本模型路由 Laya `48.5%`、Jev `50.0%`，均接近随机；逆转选项顺序后 Laya `30.3%` 的答案改变。作者公开案例、原始输出和分析代码。这比跨来源排行榜更能提示本项目的路由风险，但也不是小鲸语料上的实测。[论文](https://arxiv.org/abs/2610.02267)、[复现仓库](https://github.com/David-DL-Space/sys1-eval)
3. Laya 仓库收录的中文飞书任务小样本中，四分类首轮 Laya 多语言版 `20/64`、Jev `64/64`。该页明确称样本仅 64 条相关合成案例，标签策略和提示词可能改变结果，不能当作普遍中文性能排名。[中文场景实验](https://github.com/NandhaKishorM/laya/blob/main/research/benchmarks/feishu_zh/README.md)

## 对小鲸的可执行试验

| 决策点 | 数据来源与输出 | 推荐路径 |
| --- | --- | --- |
| 任务状态 | `TaskStatus` 和工具事件已经由运行时产生。[本地契约](../src/shared/contracts.ts) | 直接读取事件；不让模型猜“正在执行/完成/失败”。 |
| 意图 | 当前用户请求，可结合显式附件/任务上下文；输出问答、代码/文件、桌面操作、创作、闲聊、需要澄清等少量类别 | 先规则；再用当前主模型处理模糊请求；本地 Laya 与训练后的 SetFit 只作为对照。多意图请求允许多标签或交主模型分解。 |
| 情绪/语气线索 | 只用用户明确文本；输出“需要简短、放松、严肃”等可撤销的表达建议 | 不推断心理诊断，不把短期推断写入长期记忆。对含反讽、否定、混合情绪及中文网络用语专门评估。 |
| 模型路由 | 可用模型/工具、任务类别、用户覆盖、隐私和成本约束 | 能力与授权先由代码过滤；候选模型只建议低风险路径。独立评测未支持直接采用 Jev/Laya 做零样本主路由。 |

最小评估：固定标签定义，收集去标识化的真实中文请求，另加英文、否定句、选项顺序变化、长短输入和多意图案例；分开训练/校准/留出测试集。对规则、现有主模型、Laya 多语言版、SetFit+MiniLM 测宏平均 F1、关键类漏判、校准、冷/热延迟、峰值内存/显存和离线稳定性。出现低置信度或互相矛盾时退回主模型或询问用户；上线门槛以**本域误路由代价**为准，不能用公开单项精度代替。

搜索核验：先查 TypeSafe 官方文档与发布说明，再查 Laya 作者仓库/权重/基准，随后查独立论文及其原始结果，最后查 SetFit 和 MiniLM 官方资料；没有使用非官方 Jev 镜像站作为事实来源。
