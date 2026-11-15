# 同类记忆方案与取舍（2026-11-15）

| 项目 | 已有做法 | 本项目借鉴的原则 |
| --- | --- | --- |
| [Mem0](https://docs.mem0.ai/core-concepts/how-it-works) | 从消息提取事实，去重，再按查询召回 | 不把完整聊天记录每轮重放；长期目标和边界先成为可修订条目 |
| [LlamaIndex Memory](https://developers.llamaindex.ai/python/framework/module_guides/deploying/agents/memory/) | 近期消息队列有预算；旧信息进入事实或向量记忆块 | 海马体与长期层分离，并为每次读取设上限 |
| [Letta](https://docs.letta.com/v1-sdk/concepts/stateful-agents) | 核心记忆块常驻，历史消息保存在窗口外 | 人名和简短人设可常用，具体共同经历另存 |
| [Open WebUI](https://docs.openwebui.com/troubleshooting/context-window/) | 可选摘要压缩；提供上下文用量与阈值 | 防止聊天历史与记忆内容一起无界增长 |
| [dsh-companion](https://github.com/yyh-001/dsh-companion) | 人设、用户与长期记忆分文件，并支持更新条目和字符预算 | 事实可修订，核心描述保持短小 |
| [dsh-silicon](https://github.com/vvxer/dsh-silicon) | 相关原文检索设上限，习惯卡与周/月/年概况分层 | 细节按需查，长期概况逐步变短 |
| [feiyuos-memory-graph](https://github.com/YeStarOne/feiyuos-memory-graph) | 重要性、相关性、新近性混合检索，记忆衰减与钉住 | 遗忘曲线可强化，固定核心不随时间掉出 |
| [dsh-xingxi](https://github.com/Yuuyuko-uu/dsh-xingxi) | 把记忆卡、日记、原始对话做成可见档案并按需查 | 日记和笔记本分工，避免整本档案常驻提示词 |

这些是设计参考，没有复制各项目代码。需要实际验证的差异是：高流量群聊里的玩笑与传闻识别、离线消息的短暂候选区、人物关系圈容量，以及遗忘文件不被 AI 召回。

## 接入限制

[腾讯官方 dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)在会话访问控制中使用 OpenID，并非普通 QQ 号；[NapCat 的 OneBot 接口](https://naplink.github.io/api/onebot.html)提供群历史读取。选定通道之前，离线补读只能保持为适配器接口，不能承诺所有 DSH QQ 通道都能读取关机期间的群消息。
