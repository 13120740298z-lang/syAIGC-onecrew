# 提示词总集（Prompts）

> OneCrew 的提示词分两层，均为文件化资产（可审计、可复用）：

## 1. 技能层提示词（每技能一份，引擎运行时真实加载）

位于 `skills/<skill_id>.json` 的 `prompt_template` 字段，`{{变量}}` 由运行时注入：

| 文件 | 技能 | 提示词设计要点 |
|---|---|---|
| `skills/market-scan.json` | 市场快研 | 强制"桌面调研估算口径"防编造数据；输出市场排序/平台矩阵/竞品/定价/风险五段结构 |
| `skills/brand-voice.json` | 品牌声音官 | 严格 JSON 输出（禁 markdown 包裹）；用词红绿灯（use/avoid）+ 正反例文案 |
| `skills/copy-studio.json` | 文案流水线 | 五平台各自原生约束（X≤280 字符/IG hook≤125/TikTok 秒级分镜/PH 首评模板）；正文代码块包裹便于复制 |
| `skills/visual-prompt.json` | 提示词工坊 | 三工具各一套（MJ 带 --ar --v 参数/即梦中文直出/SD tag 风格 + Negative 单列）；明确"只产提示词不产成片" |
| `skills/content-calendar.json` | 内容日历 | 只输出 CSV（无解释文字）；表头冻结 date,platform,theme,hook,tags；Day7 强制 Product Hunt 发布日 |
| `skills/local-check.json` | 合规体检 | 逐条可勾选清单格式；强制免责声明；未来 6 个月营销节点 |

## 2. 系统层提示词（Agent 人设，`server/skills.js` buildMessages）

```
你是 OneCrew —— 服务一人公司（OPC）出海的 AIGC 内容官智能体。
你的用户通常是一个人身兼产品、市场、文案数职，预算极少、时间极紧。
输出要求：结构化 Markdown 或 JSON（按技能规定），直接可用、可直接复制发布或导入工具，
不要输出任何与任务无关的寒暄。所有海外平台内容默认英文（用户指定其他语言除外）。
涉及数据时注明为桌面调研估算，不得编造精确统计。
```

## 3. 路由层提示词（意图分类，`server/router.js` routeSmart）

自由聊天未命中关键词时，让 LLM 在 `workflow / 六技能ID / chat` 中单选，仅真实模式启用，失败回落聊天。

> 变更提示词无需改代码：改 `skills/*.json` 后重启服务即生效（技能文件是唯一事实源）。
