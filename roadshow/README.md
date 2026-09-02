# OneCrew 对比视频（95.7s · 1920×1080）

决赛路演用的对比宣传视频。全部素材来自仓库内真实运行留痕：

- 底图：`screenshots/`（v2 E2E 验收截图）+ `exports/`（AI 产品图、15 秒带货成片）
- 旁白：Edge TTS `zh-CN-XiaoxiaoNeural`（与产品内 TTS 同引擎，+8% 语速）
- 字幕：ASS 硬字幕（微软雅黑，大字 110px / 小字 44px，错峰入场）
- 运镜：Ken Burns 缓推 / 横移滑镜；BGM 全程自动压低（sidechaincompress ducking）

## 重新生成

```bash
node tools/roadshow_nodespk.js   # 1) 生成 10 段旁白 → roadshow/work/nar_*.mp3
node roadshow/build_video.js     # 2) 逐幕合成 → concat → BGM ducking → 成片
```

分镜唯一事实源是 [storyboard.yml](storyboard.yml)：改文案 / 换底图 / 调时长都只改这一个文件再重跑。

## 分镜表

| 幕 | 大字/标题 | 副标 | 底图 | 运镜 |
|---|---|---|---|---|
| 1 | OneCrew | 一人出海 AIGC 内容官 | 产品图集·1 | Ken Burns |
| 2 | 日更 ≥1 条 | TikTok Shop 官方要求 · 60% 卖家每周 6-10 小时 | 00-welcome | 横移 |
| 3 | 8 家竞品 · 0 家做合规 | Predis / Simplified / Canva / InVideo / Fliki / CapCut / HeyGen / KreadoAI | 07-market-report | 横移 |
| 4 | 我们的位置 | 全链路 × 合规体检 · 行业唯一 | 00-welcome | Ken Burns |
| 5 | 八位 AI 队友接力 | 调研 → 品牌 → 文案 → 出图 → 成片 → 日历 → 合规 | 04-running-confirm | Ken Burns |
| 6 | 183秒 · 13工件 · 9/9步 | 真实运行留痕 · data/runs 可复核 | 06-run-timeline-done | 数字弹出 |
| 7 | 真·成片 | TTS 配音 · Ken Burns 运镜 · ASS 字幕 | **15秒带货短视频.mp4** | 视频底 |
| 8 | ≈ ¥1.2 / 次 | LLM+生图+TTS 真实记账 · UGC 外包 $45-212/条 | 02-artifact-csv | Ken Burns |
| 9 | 78% · ≈40% · 0→1 | 卖家搞不定合规 · 首年被封号 · OneCrew 每单都体检 | 05-done-artifacts | 数字弹出 |
| 10 | 一个人 = 一支内容小队 | SynNovator Wave 3 · OneCrew | 产品图集·4 | Ken Burns |

旁白全文见 `tools/roadshow_nodespk.js` 内的 `SCRIPTS`（生成时同步写入 `work/narration_scripts.json`）。

## 产物规格

| 项 | 值 |
|---|---|
| 分辨率 | 1920×1080 · 30fps |
| 时长 | 95.7s（含 2s 尾板） |
| 编码 | h264 High ~1.0Mbps + AAC 160k 立体声 |
| 体积 | ~13.9MB |

`work/` 目录为中间产物（旁白/字幕/单幕片段），已 gitignore，删除后可由脚本完整重建。
