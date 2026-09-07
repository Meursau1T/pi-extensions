# pi-extensions

这个仓库提供 Pi 的统一能力管理器。`capability-manager/` 负责管理界面，`pi-mcp-adapter/` 是基于 `pi-mcp-adapter 2.10.0` 的本地分支，提供 MCP Server 的完整禁用能力和事件桥接。

## 安装

不要和官方 `npm:pi-mcp-adapter` 同时启用。安装整个仓库即可同时加载管理器和配套 MCP adapter。

```bash
pi install git:github.com/Meursau1T/pi-extensions
```

私有仓库也可通过 SSH 安装。

```bash
pi install git:git@github.com:Meursau1T/pi-extensions.git
```

安装后重启 Pi，或执行 `/reload`。

## 使用

执行 `/caps` 打开面板。Tab 切换 Skills 和 MCP，Ctrl+G 切换全局与项目作用域，空格或 Enter 切换状态，Ctrl+S 保存，Esc 放弃。

项目状态支持继承、显式启用和显式禁用。Skill 状态写入 Pi 原生资源过滤配置。MCP 状态写入 Pi 专属 `settings.serverStates`，不会改动共享 MCP 定义。禁用 MCP Server 后，它不会启动、参与工具搜索、接受代理调用或注册 direct tool；原配置、缓存和 OAuth 信息会保留。

临时注入的 Skill 与失去配置来源的 MCP 缓存只读展示。

## 目录

`capability-manager/` 是统一管理插件源码。

`pi-mcp-adapter/` 保留上游 MIT License，并包含能力管理所需的服务器级禁用与桥接修改。
