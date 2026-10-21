# 小鲸可爱人设与 Live2D 角色资产规范

> 日期：2026-10-20  
> 适用范围：小鲸正式形象、后续原创人设、仅限本机使用的同人角色包  
> 当前运行时基线：v0.0.88 的 `pixi-live2d-display` 渲染链路与 `Idle / Acknowledge / Thinking / Working / Success / Failure` 六动作契约

## 1. 目标与边界

这份规范约束角色从设定、分层原画、Cubism 绑定到程序运行资产的完整交付。目标是让角色在桌面实际显示尺寸下仍然可爱、可辨认，并让动作准确表达小鲸当前的工作状态。

正式角色必须走以下路径：

**固定角色母版 → 可编辑分层原画 → Cubism 绑定 → 表情与状态动作 → 运行资产 → 桌面真机验收。**

禁止把现有扁平 PNG 简单切成几层后做整体平移、旋转或缩放，并把这种效果当作正式 Live2D。单图自动拆层只可用于验证动作方向；被遮挡区域、面部结构、手部和衣物连接处必须由原画师检查并补全。

当前 Arch Chan 模型仅是 **技术夹具**：

- 用于回归验证 Cubism Core、本地资源加载、动作优先级、循环、销毁和打包；
- 不进入人设选择器，不作为小鲸皮肤，不代表最终画风；
- 它的六组项目内动作只证明运行时契约可用，不能直接成为小鲸的正式动作；
- 小鲸正式模型接入时复用动作组名称与运行逻辑，不复制 Arch Chan 的角色设计或动作幅度。

## 2. 小鲸不可变识别点

所有小鲸立绘、头像、表情、Live2D 纹理和宣传图必须同时保留以下识别点。任何一项需要更改，都应先形成新的设计版本并进行并排审查，不能在单张素材中临时漂移。

| 类别 | 不可变识别点 | 不允许的漂移 |
| --- | --- | --- |
| 物种特征 | 头部两侧的灰蓝鲸耳，外缘浅色，耳形左右对应 | 画成猫耳、羊角、鱼鳍或普通长耳；左右结构无理由不同 |
| 发型 | 蓝色长发、厚刘海、两侧与后发层次明确 | 发长、刘海分缝和侧发轮廓在不同表情中大幅改变 |
| 呆毛 | 头顶一根向上弯曲的鲸尾形呆毛 | 变成细直天线、双呆毛或在部分状态中无故消失 |
| 头饰 | 白色女仆帽，轮廓围绕头顶，不遮住呆毛根部 | 帽型、褶数和位置在动作中跳变 |
| 侧饰 | 右侧青蓝色小蝴蝶结 | 左右互换、颜色漂移或尺寸突然变大 |
| 服装 | 深海军蓝与白色女仆装，白围裙、荷叶边、深色袖子 | 随表情更换服装结构；裙摆、袖口或围裙层级互相穿插 |
| 胸前标志 | 深色大蝴蝶结与中央浅蓝宝石 | 宝石变成纯白、绿色或不明图案；蝴蝶结形状每张不同 |
| 面部 | 大号蓝灰眼睛、浅肤色、柔和腮红、短小鼻口 | 瞳色、眼距、脸宽、下巴形状因状态而改变 |
| 整体气质 | 可爱、忠诚、活泼，工作时专注，失败时委屈但不失能动性 | 过度幼化、情色化、阴郁恐怖化或夸张崩坏表情 |

角色母版至少包含：正面、左右 3/4、侧面、背面结构说明；中性、微笑、专注、惊讶、困倦、害羞、失败七张脸部表；服装和配件的遮挡关系；颜色样本；不可变识别点标注。

## 3. 统一可爱 Q 版画风

### 3.1 比例与轮廓

- 统一采用约 **2.0–2.3 头身**的坐姿 Q 版比例；头部是第一视觉主体，身体不得细长写实。
- 头部可见高度约占整个人物可见高度的 48%–55%；眼睛位于脸部中线稍下方。
- 手、脚和关节采用圆润简化结构，但必须保留明确的手指连接和左右手关系，不允许缺块、融合或出现无意义物体。
- 每套人设必须有可一眼分辨的头部剪影和至少一个独有标志。仅靠换发色或衣服颜色不算独立人设。
- 默认姿态的视觉重心稳定在画布中心下方；动作只改变模型内部参数，不移动 Electron 窗口或角色命中框。

### 3.2 小鲸基准色板

以下颜色是制作目标，不要求每个像素完全一致；最终以批准后的母版取色并固化为色板。不同表情和动作不得重新采样出另一套主色。

| Token | 建议色值 | 用途 |
| --- | --- | --- |
| `outline-deep` | `#101A43` | 外轮廓、眼线、深色结构线 |
| `hair-base` | `#5578C3` | 主发色 |
| `hair-shadow` | `#344A82` | 头发暗面 |
| `hair-highlight` | `#8CCAF4` | 头发高光 |
| `maid-navy` | `#25305C` | 女仆装、胸前蝴蝶结 |
| `maid-white` | `#F5F7FC` | 帽子、围裙、荷叶边 |
| `accent-cyan` | `#52C7DB` | 侧蝴蝶结、界面联动强调色 |
| `gem-blue` | `#72D9F6` | 胸前宝石 |
| `skin-base` | `#FFE1D1` | 肤色 |
| `blush` | `#F49799` | 腮红与情绪强调 |

### 3.3 线条、阴影与高光

- 外轮廓线宽约为头部宽度的 0.7%–0.9%，内部结构线约为 0.35%–0.55%；同一模型中最多保留两档主线宽。
- 线条使用深蓝黑，不用纯黑粗边；发丝、衣褶和五官的线条端点应圆润。
- 阴影只使用一档主阴影，必要时在衣物重叠处增加小面积接触阴影；禁止写实多级光照和大面积灰脏渐变。
- 每种材质的高光形状固定：头发使用少量块状高光，眼睛使用固定位置的主高光与次高光，宝石单独定义高光。
- 角色素材必须为透明背景，不包含白底、棋盘格、地面阴影、矩形蒙版、发光底板或贴纸式白边。
- 禁止把阴影、光晕或状态提示烘焙进角色纹理；状态点和特效由程序独立渲染。

### 3.4 多人设统一规则

- 五套角色使用相同头身区间、线宽档位、阴影档位、眼睛高光语言和透明边缘质量。
- 每套角色允许有自己的动作节奏和主色，但不得改变状态的含义。
- 不同角色之间不得共享面部贴图、表情 PNG、头发部件或服装部件。
- 每次只修改一个设计变量，并与上一版母版叠加比较；发现脸型、眼距、发际线或标志物漂移时，只返修出错部位。

## 4. 分层 PSD 最低清单

制作源分为“可编辑母版 PSD”和“Cubism 导入 PSD”。母版保留组、蒙版和绘制历史；导入稿将同一视觉部件的线稿、色块和剪贴效果合并成独立图层。所有图层名唯一，RGB、8-bit、sRGB，透明背景。

### 4.1 图层结构

```text
00_reference                  # 导入时隐藏，仅作比例参考
10_back
  hair_back_L
  hair_back_R
  hair_back_center
  whale_ear_L
  whale_ear_R
20_body_back
  skirt_back
  ribbon_back_L
  ribbon_back_R
30_body
  neck
  torso
  dress_base
  apron
  collar
  chest_ribbon_L
  chest_ribbon_R
  chest_gem
  sleeve_L
  sleeve_R
  forearm_L
  forearm_R
  hand_L
  hand_R
  skirt_front_L
  skirt_front_R
  frills
40_head
  face_base
  face_shadow
  nose
  blush_L
  blush_R
  brow_L
  brow_R
  eye_L_white
  eye_L_iris
  eye_L_pupil
  eye_L_highlight_main
  eye_L_highlight_sub
  eye_L_upper_lid
  eye_L_lower_lid
  eye_L_lashes
  eye_R_white
  eye_R_iris
  eye_R_pupil
  eye_R_highlight_main
  eye_R_highlight_sub
  eye_R_upper_lid
  eye_R_lower_lid
  eye_R_lashes
  mouth_line
  mouth_inside
  teeth
  tongue
50_hair_front
  bang_L
  bang_center
  bang_R
  side_hair_L
  side_hair_R
  ahoge
60_accessories_front
  maid_cap
  side_bow
70_guides                      # 参数与旋转中心说明，不导入运行纹理
```

### 4.2 补画和几何要求

- 被刘海遮住的额头、眉、眼和脸必须完整绘制；闭眼、转头和头发物理时不能露空洞。
- 被袖子遮住的手臂、被围裙遮住的裙身、被头发遮住的耳与颈部必须补到动作所需范围。
- 左右眼、左右眉、左右手分别成层；不得用镜像后的单层长期代替另一侧。
- 手指相接处必须有清楚的前后关系；中间不得出现透明缺块、额外红色物体或无法解释的几何形状。
- 长发至少拆成后发中心、左右后发、左右侧发、前发和呆毛；物理摆动只作用于对应发束。
- 纹理边缘保留足够的透明扩展与邻近颜色，极限形变下不得出现白边或黑缝。
- 图层命名只用稳定的 ASCII ID；中文说明写入对照表，不直接作为运行参数 ID。

## 5. 参数、表情与动作语法

### 5.1 基础参数

正式模型至少提供以下参数，并优先使用 Cubism 标准 ID：

- `ParamAngleX`、`ParamAngleY`、`ParamAngleZ`；
- `ParamBodyAngleX`、`ParamBodyAngleY`、`ParamBodyAngleZ`；
- `ParamEyeLOpen`、`ParamEyeROpen`、`ParamEyeLSmile`、`ParamEyeRSmile`；
- `ParamEyeBallX`、`ParamEyeBallY`；
- 左右眉高度与形状参数；
- `ParamMouthOpenY`、`ParamMouthForm`、`ParamCheek`；
- `ParamBreath`；
- 前发、侧发、后发、呆毛、耳、蝴蝶结、袖口与裙摆的物理输入和输出参数。

参数零位必须对应批准后的中性母版。动作结束后，除当前表情明确控制的参数外，所有参数都要回到零位；不能让上一动作的歪头、闭眼或嘴形残留到下一状态。

### 5.2 表情集合

| 表情 ID | 视觉语义 | 最低变化 |
| --- | --- | --- |
| `neutral` | 待机、正常交流 | 中性眉眼、轻微微笑或闭口 |
| `smile` | 完成、回应、被表扬 | 眼睛柔和、嘴角上扬、少量腮红 |
| `focus` | 规划、执行、验证 | 眉略收紧、视线集中、嘴形收敛 |
| `surprise` | 收到任务、被点击 | 眼睛稍大、眉抬高、短暂小圆嘴 |
| `sleepy` | 长时间待机、休息 | 上眼皮下降、眉放松、轻微哈欠 |
| `shy` | 亲密互动、被夸奖 | 视线轻偏、腮红增加、克制微笑 |
| `failed` | 失败、取消 | 眉内收、嘴角下降，可有泪光但不持续哭泣 |

一个 `.exp3.json` 表示一个可复用的完整表情组合。不要依赖同时叠加多个互相争抢同一参数的表情文件；需要组合时制作经过验收的命名组合，或由运行时显式驱动单一参数。

### 5.3 六状态动作语法

| 动作组 | 状态语义 | 建议表情 | 动作结构 | 播放规则 |
| --- | --- | --- | --- | --- |
| `Idle` | 无任务、安静陪伴 | `neutral`，稀疏切换 `sleepy` | 呼吸、眨眼、轻微视线和小幅发梢物理；身体重心不漂移 | `idle` 优先级，4–7 秒无缝循环 |
| `Acknowledge` | 收到任务、倾听、开始响应 | `surprise` → `smile` 或 `focus` | 眼神对准、轻点头或短促抬身，再回到基线 | `normal`，0.6–1.0 秒，一次性 |
| `Thinking` | 规划、等待、压缩上下文 | `focus` | 视线略偏上、头部小幅侧倾、呆毛缓慢摆动；保持可读性 | `normal`，2.4–4.0 秒循环 |
| `Working` | 执行工具、读取、写入、验证 | `focus` | 视线在屏幕方向小幅扫描，身体有稳定工作节奏；幅度高于思考、低于庆祝 | `normal`，1.6–2.8 秒循环 |
| `Success` | 回合成功完成 | `smile` | 轻抬身、眼笑、短促挥手或双手收紧表达高兴，随后回到基线 | `force`，0.9–1.5 秒，一次性 |
| `Failure` | 失败、取消、触限停止 | `failed` | 耳与呆毛轻垂、身体小幅下沉后恢复；不能长时间趴伏或遮挡错误提示 | `force`，1.1–1.8 秒，一次性 |

动作文件还必须满足：

- 循环动作的每条曲线首尾数值一致，循环接缝不可见；
- 一次性动作首帧和末帧均回到基线；
- `Success` 和 `Failure` 可以抢占普通状态，但不能无限循环；
- 流式文字、token 更新或时间线刷新不能让同一持续动作反复从头开始；
- 动作不改变整个 canvas 的位置、缩放或窗口边界；人物不能因切换状态左右或上下闪动；
- 眨眼、口型、物理和状态动作各自有明确参数所有权，避免多个系统同时覆盖同一参数；
- 语音口型只驱动 `ParamMouthOpenY` 与必要的嘴形参数，音量归零后平滑闭口；
- Windows“减少动态效果”开启时，停止循环和物理更新，显示稳定的 `neutral` 静态姿态。

### 5.4 人设动作差异

状态含义固定，个性只通过幅度、节奏和次要动作表达：

- **小鲸**：活泼但专注；回应清楚，完成时略有雀跃，工作动作稳定。
- **远坂凛，本机包**：节奏干脆、点头短、完成动作自信，幅度中等。
- **雷姆，本机包**：动作柔和、停顿平稳、眼神跟随明显，幅度偏小。
- **平泽唯，本机包**：回弹和挥手更活泼，节奏稍快，但工作态不能持续蹦跳。
- **雪之下雪乃，本机包**：姿态克制、视线变化细微、完成动作简短，幅度最小。

## 6. 聊天头像同源规则

- 聊天头像必须由同一角色母版或同一 Cubism 模型的批准姿态导出，不能另用一次独立生成的头像。
- 使用 1:1 透明画布，同时导出 512×512 母版和 256×256 运行图；不在头像里加入底色、阴影、文字或状态点。
- 脸部与头饰占头像高度的 72%–84%，下边可见少量胸前蝴蝶结或角色标志；头像缩到 24–32px 时仍能认出发型、瞳色和一个独有标志。
- 默认使用 `neutral`；当前状态通过旁边的状态点表达，不频繁更换聊天头像。
- 头像的脸宽、眼距、刘海、耳朵和配饰位置必须与桌面模型一致。导出后与桌面模型中性帧做叠加检查。

## 7. 许可与分发边界

### 7.1 `public` 资产

公开仓库、GitHub Release、安装包和宣传素材只允许包含：

- 小鲸及其他已取得完整权利的原创角色；
- 明确允许该用途和再分发的第三方资产；
- 许可文本、来源、固定版本和哈希均已记录的技术依赖；
- 经 Live2D 发布许可复核后允许分发的 Cubism Runtime 资产。

每个公开角色包必须记录原画、绑定、动作、声音和字体的权利来源。无法证明许可的文件不得因为“已经能运行”而进入发布包。

### 7.2 `local-only` 资产

远坂凛、雷姆、平泽唯、雪之下雪乃及其他动漫 IP 人设当前统一视为 `local-only`：

- 只保留在用户本人设备上的私有资产目录；
- 不提交公开仓库，不进入 Release ZIP、安装包、截图宣传、商店页面或默认下载；
- 不复制官方图片、动画帧、logo、语音、音乐或游戏素材；
- 自绘或 AI 重绘也不自动取得原角色的软件分发权；
- 若未来取得权利方明确书面许可，再单独修改 `distributionScope` 并记录许可范围。

公开版本若需要多套人设，应重新设计名称、发型、服装、配饰、色板、人格和背景均独立的原创角色。只改名、换色或删除作品名仍不足以成为原创设计。

### 7.3 Live2D 许可

小鲸属于 AI/chatbot interface，并且未来支持导入角色包，可能落入 Live2D 所称的 Expandable Application。公开发布前必须按当时有效的官方条款确认 Publication License 和特别审查要求，不能仅以个人或小规模项目豁免作结论。

## 8. 目录与资产清单约定

### 8.1 私有制作源

私有源文件放在项目内但永不提交、永不打包的目录，或放在有访问控制的独立素材仓库：

```text
private-assets/personas/xiaojing/v1/
  references/
    identity-sheet.png
    expression-sheet.png
    color-palette.ase
  art/
    xiaojing-v1-master.psd
    xiaojing-v1-cubism-import.psd
  cubism/
    xiaojing-v1.cmo3
    xiaojing-v1.can3
  rights/
    ownership.md
    source-log.md
  review/
    p0-checklist.md
    p1-checklist.md
```

`private-assets/` 必须进入 Git 忽略和打包排除规则。原画、Cubism 工程、授权证据和评审截图均不进入应用安装包。

### 8.2 程序运行资产

```text
resources/live2d/xiaojing/
  asset-manifest.json
  xiaojing.model3.json
  xiaojing.moc3
  xiaojing.physics3.json
  xiaojing.cdi3.json
  textures/
    texture_00.png
  expressions/
    neutral.exp3.json
    smile.exp3.json
    focus.exp3.json
    surprise.exp3.json
    sleepy.exp3.json
    shy.exp3.json
    failed.exp3.json
  motions/
    idle_00.motion3.json
    acknowledge_00.motion3.json
    thinking_00.motion3.json
    working_00.motion3.json
    success_00.motion3.json
    failure_00.motion3.json
  preview/
    avatar-256.png
```

本机角色包使用相同结构，放在 `data/personas/<pack-id>/`。宿主读取前必须验证相对路径、文件后缀、引用完整性、文件大小、哈希和 `distributionScope`，不得接受网络 URL、绝对路径或父目录逃逸。

`asset-manifest.json` 至少包含：

```json
{
  "schemaVersion": 1,
  "personaId": "xiaojing",
  "designVersion": "1.0.0",
  "displayName": "小鲸",
  "renderer": "live2d-cubism4",
  "distributionScope": "public",
  "model": "xiaojing.model3.json",
  "portrait": "preview/avatar-256.png",
  "fallbackSprite": "src-managed",
  "requiredActions": [
    "Idle",
    "Acknowledge",
    "Thinking",
    "Working",
    "Success",
    "Failure"
  ],
  "requiredExpressions": [
    "neutral",
    "smile",
    "focus",
    "surprise",
    "sleepy",
    "shy",
    "failed"
  ],
  "license": {
    "kind": "original",
    "notice": "原创角色，权利记录见私有素材档案"
  }
}
```

运行资产中不写入私有仓库路径、原画师个人联系方式或授权合同正文。

## 9. P0、P1、P2 验收门禁

### P0：角色母版与垂直切片

**交付物**

- 批准的小鲸 identity sheet、expression sheet、色板和分层清单；
- 可编辑母版 PSD 与 Cubism 导入 PSD；
- 中性、微笑、专注三个表情；
- 基础转头、眨眼、呼吸、头发物理；
- `Idle`、`Acknowledge`、`Working` 三个代表动作；
- 同源聊天头像。

**自动门禁**

- PSD 为 RGB、8-bit、sRGB，图层名唯一；
- 必需图层均存在，左右部件没有错误复用；
- model3 引用全部存在且只使用相对路径；
- motion3 曲线只引用模型已声明参数；
- 循环曲线首尾一致，一次性动作末帧回到基线；
- 没有白底、矩形阴影、外部 URL 和缺失纹理。

**人工门禁**

- 不看名称仍能辨认是小鲸；不可变识别点全部存在；
- 眼、嘴、手、鲸耳、帽子、宝石和呆毛无缺块或未知物体；
- 头转极限、闭眼、张嘴和长发摆动时不露空洞、不穿帮；
- 在桌面 128px 左右的实际显示尺寸下，表情和状态仍可辨认；
- 切换三个动作时角色本体和窗口不发生位置闪动。

任何一项人工门禁失败，都不得进入 P1；不能用缩小动作幅度掩盖分层或绑定问题。

### P1：小鲸正式模型

**交付物**

- 完整身体绑定和物理；
- 七个表情与六个动作组；
- `EyeBlink`、`LipSync`、`HitAreaHead`、`HitAreaBody`；
- PNG fallback、运行头像、许可清单和 asset manifest；
- Cubism Viewer 与 Electron 的验收记录。

**自动门禁**

- 六动作组和七表情全部可从 model3 解析；
- 连续播放每个动作 20 次后参数回到预期状态；
- 资源打包清单完整，源码构建输出与包内哈希一致；
- `distributionScope`、许可说明、模型版本与 Core 兼容版本齐全；
- 模型加载失败可立即回退 PNG，重试不会遗留重复实例。

**人工门禁**

- 六种状态只看动作即可区分，且不会喧宾夺主；
- 125%、150% DPI 与三档人物大小下边缘清晰、位置稳定；
- 左键、右键、中键、拖动与命中区域不被 canvas 拦截；
- 语音口型与文字工作状态可同时运行，不出现嘴形卡住；
- “减少动态效果”下人物静止且仍可交互；
- 连续运行 30 分钟无明显动作加速、内存持续增长或闪烁。

### P2：多人设角色包

**交付物**

- 每套人设独立的母版、分层 PSD、Cubism 工程、头像、表情、动作和 manifest；
- 公共原创人设与本机同人包严格分目录；
- 本地导入、卸载、版本升级和回退方案；
- 每套人设的身份对照与许可记录。

**自动门禁**

- 每个 pack 自包含，不引用其他人设的纹理、表情或动作；
- 必需动作与表情语义一致，文件路径和哈希全部通过；
- `local-only` 包不会被构建、ZIP 或 Release 收集；
- 删除一个本地包后程序自动回退小鲸，不留下失效设置；
- 不同 pack 切换时旧模型只销毁一次，状态会在新模型上继续表达。

**人工门禁**

- 隐去标签后能辨认每个角色，不依赖发色猜测；
- 五套画风在头身、线宽、阴影和眼睛高光上属于同一产品；
- 个性动作有差异，但 `Working` 不会看成庆祝，`Failure` 不会看成休眠；
- 切人设时聊天头像、桌面模型、名字和人格同时更新，无跨角色残留；
- 公开构建只显示拥有公开分发权的人设。

## 10. 与 v0.0.88 的合并原则

- 保留现有 `avatar-lanes`、状态仲裁、动作优先级、循环控制和失败回退；资产制作不重写这些逻辑。
- `avatar-rig.ts` 继续作为人物素材与个性参数的唯一来源；正式模型通过明确的 `modelId` 与人设绑定。
- `live2d-manifest.ts` 继续是内置模型白名单；新模型只增加清单项和实际资源映射。
- Arch Chan 和它的测试继续保留，确保运行时回归；产品界面始终标注其技术预览性质。
- 小鲸 P0 未通过前，不批量制作另外四套模型；先解决母版、分层和桌面显示质量，再复用成熟管线。
- 自动拆层与自动绑定工具只运行在制作阶段，不能成为应用启动依赖，也不能绕过人工美术验收。

## 11. 参考依据

- [Live2D：About Material Separation](https://docs.live2d.com/en/cubism-editor-manual/divide-the-material/)
- [Live2D：Import PSDs](https://docs.live2d.com/en/cubism-editor-manual/psd-import/)
- [Live2D：Notes on PSD Creation](https://docs.live2d.com/en/cubism-editor-manual/precautions-for-psd-data/)
- [Live2D CubismSpecs：model3.json](https://github.com/Live2D/CubismSpecs/blob/master/FileFormats/model3.json.md)
- [Live2D CubismSpecs：motion3.json](https://github.com/Live2D/CubismSpecs/blob/master/FileFormats/motion3.json.md)
- [Live2D CubismWebSamples：Mao 模型结构](https://github.com/Live2D/CubismWebSamples/blob/develop/Samples/Resources/Mao/Mao.model3.json)
- [pixi-live2d-display：motion、priority 与 expression](https://github.com/guansss/pixi-live2d-display/wiki/Complete-Guide)
- [PSD2Live：分层 PSD 自动绑定与 Cubism 导出](https://github.com/tsunehimatoi/psd2live)
- [See-through：单图动漫角色语义分层](https://github.com/shitagaki-lab/see-through)
- [Live2D SDK Release License](https://www.live2d.com/en/sdk/license/)
- [TYPE-MOON 二次创作与素材使用规则](https://typemoon.com/copyright)
- [芳文社图片使用与版权规则](https://houbunsha.co.jp/copyright.html)
- [小学馆著作权与角色使用规则](https://www.shogakukan.co.jp/copyright)
- [KADOKAWA 作品利用说明](https://www.kadokawa.co.jp/copyrightpolicy/)

