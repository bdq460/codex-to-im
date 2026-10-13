# Codex to IM fork 维护入口

用户 fork：git@github.com:bdq460/codex-to-im.git（origin）。原项目 https://github.com/zhangle1987/codex-to-im.git（upstream）。本地源码：/Users/klein/workspace/dev_tool/codex-to-im-fork；开发分支 codex/feishu-session-navigation；基线 a791d8d689635cac3a05e8b8afbe40e261a38704（1.0.67）。先读 AGENTS.md。

2026-10-14：从原本地源码迁入飞书会话导航、无绑定提示、桌面会话发现、系统代理继承、匹配桌面 CLI 及错误归因修复。运行入口 main → bridge-manager → command-dispatch / interactive-message-runner → provider → Feishu adapter。最近三条可点击选择、全部会话分页；未绑定不执行原消息。权限、归档过滤及任务运行中的切换保护保留。

配置与实时数据继续使用 ~/.codex-to-im；已复制配置到权限受限且 Git 忽略的 .local-runtime/，部署前备份路径见其中 backup-path。配置、凭据、聊天回执及本机诊断记录不提交；docs/local-changes/ 仅供本机交接。后续增强以此 fork 源码为准，测试和构建后再部署。测试与部署证据记录在 docs/local-changes/2026-10-14-fork-deployment.md。

2026-10-14 消息驱动会话第一版：引用结果回复自动进入其会话；流式结果、普通结果及原请求持久化消息归属；结果卡片增加继续/切换入口。未绑定消息保留文字与附件，选择或新建后自动继续；重复选择由持久化领取状态防重。列表合并桌面和正式IM会话，按活动倒序；不会因mirror投递改变绑定。新实现 session-interactions.ts、session-interaction-store.ts，入口接入 adapter、manager、反馈投递与store。说明、演示及验证见 docs/local-changes/2026-10-14-message-sessions.md；源码第一版等待运行验收，不能宣称已经在飞书生效。
