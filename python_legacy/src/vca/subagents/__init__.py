"""SubAgent 子代理包 - 多 Agent 编排

通过 AgentTool 创建若干独立的 Agent Loop (SubAgent) 来处理子任务，
每个 SubAgent 拥有独立的对话历史、工具池和隔离环境。

模块结构:
- types.py     SubAgent 数据模型
- mailbox.py   文件系统信箱 (多 Agent 通信, "文件系统即上下文")
- manager.py   SubAgent 生命周期管理 (同步/后台/并行)
- tools.py     AgentTool 工具集 (create_agent / get_agent_result / ...)
"""
